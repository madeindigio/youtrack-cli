import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { sanitizeFilename } from "./cli.js";
import { articleToMarkdown, issueToMarkdown } from "./markdown.js";
import { acquireLock, openQueue } from "./queue.js";
import { articleWebUrl, issueWebUrl } from "./youtrack.js";

/**
 * Full project export orchestrator.
 *
 * One single process owns the queue and performs every filesystem write: the
 * concurrency is provided by in-process worker loops sharing one queue
 * instance, which is what keeps the writes serialized and the export
 * resumable.
 */

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_ACTIVITY_PAGE_SIZE = 100;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_MS = 1000;
const PROGRESS_INTERVAL_MS = 500;
const IDLE_POLL_MS = 25;
const META_DIRECTORY = ".yt-export";
const MANIFEST_FILE = "export.json";
const RUN_FILE = "run.json";

/**
 * Builds every path the export writes to.
 * @param {string} out Output directory.
 * @returns {{ root: string, meta: string, issues: string, articles: string,
 *   manifest: string, issueDir: (id: string) => string, articleDir: (id: string) => string }}
 */
export function createPaths(out) {
  const root = isAbsolute(out) ? out : resolve(out);
  return {
    root,
    meta: join(root, META_DIRECTORY),
    issues: join(root, "issues"),
    articles: join(root, "articles"),
    manifest: join(root, MANIFEST_FILE),
    run: join(root, META_DIRECTORY, RUN_FILE),
    issueDir: (id) => join(root, "issues", sanitizeFilename(id)),
    articleDir: (id) => join(root, "articles", sanitizeFilename(id)),
  };
}

/**
 * Minimal stderr logger. `status` rewrites a single line, `log` prints a full line.
 * @param {{ silent?: boolean, stream?: NodeJS.WritableStream }} [options]
 */
export function createStderrLogger({ silent = false, stream = process.stderr } = {}) {
  let dirty = false;
  return {
    status(line) {
      if (silent) return;
      stream.write(`\r${line}`);
      dirty = true;
    },
    log(line) {
      if (silent) return;
      stream.write(`${dirty ? "\n" : ""}${line}\n`);
      dirty = false;
    },
    done() {
      if (silent || !dirty) return;
      stream.write("\n");
      dirty = false;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Job handlers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Job handlers keyed by job type. Every handler receives
 * `{ job, queue, client, paths, options, config, logger, counters }` and is
 * independently unit-testable with a fake client and a temporary directory.
 */
export const handlers = {
  "project:index": async (context) => {
    const { job, queue, client, options } = context;
    const skip = Number(job.payload?.skip ?? 0);
    const top = pageSize(options);
    const limit = positiveNumber(options.limit);

    const wanted = limit ? Math.min(top, Math.max(limit - skip, 0)) : top;
    if (wanted === 0) return;

    const page = asArray(await client.listProjectIssues({
      project: options.project,
      skip,
      top: wanted,
      query: sinceQuery(options.since),
    }));

    const jobs = [];
    for (const issue of page) {
      const id = issueKey(issue);
      if (!id) continue;
      jobs.push({
        type: "issue:fetch",
        key: `issue:fetch:${id}`,
        payload: { id, idReadable: issue.idReadable ?? id },
        priority: 10,
      });
    }
    if (jobs.length) await queue.enqueueMany(jobs);

    const seen = skip + page.length;
    const exhausted = page.length < wanted || (limit && seen >= limit);
    if (!exhausted) {
      await queue.enqueue({
        type: "project:index",
        key: `project:index:${seen}`,
        payload: { skip: seen },
        priority: 20,
      });
    }
  },

  "issue:fetch": async (context) => {
    const { job, queue, client, paths, options, config, counters } = context;
    const id = job.payload.id;
    const issue = await client.getIssue(id);
    const comments = asArray(await client.getIssueComments(id));
    const readable = issue?.idReadable || issue?.id || id;
    const directory = paths.issueDir(readable);

    await mkdir(directory, { recursive: true });
    await writeJson(join(directory, "issue.json"), issue);
    await writeJson(join(directory, "comments.json"), comments);
    await writeFile(
      join(directory, "issue.md"),
      issueToMarkdown({ ...issue, comments }, {
        includeComments: true,
        sourceUrl: config?.url ? issueWebUrl(config.url, issue ?? { id }) : undefined,
      }),
      "utf8",
    );

    bump(counters, "issues");
    bump(counters, "comments", comments.length);

    const followUps = [];
    if (options.activities !== false) {
      followUps.push({
        type: "issue:activities",
        key: `issue:activities:${readable}:0`,
        payload: { id, readable, cursor: null },
      });
    }
    if (options.attachments !== false) {
      followUps.push({
        type: "issue:attachments",
        key: `issue:attachments:${readable}`,
        payload: { id, readable },
      });
    }
    if (followUps.length) await queue.enqueueMany(followUps);
  },

  "issue:activities": async (context) => {
    const { job, queue, client, paths, options, counters } = context;
    const { id, cursor = null } = job.payload;
    const readable = job.payload.readable || id;
    const page = await client.getIssueActivitiesPage(id, {
      cursor: cursor ?? undefined,
      top: activityPageSize(options),
    });

    const activities = asArray(page?.activities);
    const file = join(paths.issueDir(readable), "activities.json");
    await appendJsonArray(file, activities);
    bump(counters, "activities", activities.length);

    const afterCursor = page?.afterCursor ?? null;
    if (page?.hasAfter && afterCursor && afterCursor !== cursor) {
      await queue.enqueue({
        type: "issue:activities",
        key: `issue:activities:${readable}:${afterCursor}`,
        payload: { id, readable, cursor: afterCursor },
      });
    }
  },

  "issue:attachments": async (context) => {
    const { job, queue, client } = context;
    const { id } = job.payload;
    const readable = job.payload.readable || id;
    const attachments = asArray(await client.getIssueAttachments(id));
    await enqueueDownloads(queue, "issue", readable, attachments);
  },

  "asset:download": async (context) => {
    const { job, client, paths, counters } = context;
    const { kind, owner, attachment } = job.payload;
    const directory = join(kind === "article" ? paths.articleDir(owner) : paths.issueDir(owner), "assets");
    const destination = join(directory, assetFilename(attachment));

    const expected = Number(attachment?.size);
    const current = await fileSize(destination);
    if (current !== null && (!Number.isFinite(expected) || expected <= 0 || current === expected)) {
      bump(counters, "assetsSkipped");
      return;
    }

    await mkdir(directory, { recursive: true });
    const result = await client.downloadAttachment(attachment, destination);
    bump(counters, "assets");
    bump(counters, "bytes", Number(result?.bytes) || 0);
  },

  "article:index": async (context) => {
    const { job, queue, client, options } = context;
    const skip = Number(job.payload?.skip ?? 0);
    const top = pageSize(options);
    const page = asArray(await client.listProjectArticles({ project: options.project, skip, top }));

    const jobs = [];
    for (const article of page) {
      const id = issueKey(article);
      if (!id) continue;
      jobs.push({
        type: "article:fetch",
        key: `article:fetch:${id}`,
        payload: { id, idReadable: article.idReadable ?? id },
        priority: 10,
      });
    }
    if (jobs.length) await queue.enqueueMany(jobs);

    if (page.length >= top) {
      const seen = skip + page.length;
      await queue.enqueue({
        type: "article:index",
        key: `article:index:${seen}`,
        payload: { skip: seen },
        priority: 20,
      });
    }
  },

  "article:fetch": async (context) => {
    const { job, queue, client, paths, options, config, counters } = context;
    const id = job.payload.id;
    const article = await client.getArticle(id);
    const readable = article?.idReadable || article?.id || id;
    const directory = paths.articleDir(readable);

    await mkdir(directory, { recursive: true });
    await writeJson(join(directory, "article.json"), article);
    await writeFile(
      join(directory, "article.md"),
      articleToMarkdown(article ?? { id }, {
        sourceUrl: config?.url ? articleWebUrl(config.url, article ?? { id }) : undefined,
      }),
      "utf8",
    );
    bump(counters, "articles");

    if (options.attachments !== false) {
      await queue.enqueue({
        type: "article:attachments",
        key: `article:attachments:${readable}`,
        payload: { id, readable },
      });
    }
  },

  "article:attachments": async (context) => {
    const { job, queue, client } = context;
    const { id } = job.payload;
    const readable = job.payload.readable || id;
    const attachments = asArray(await client.getArticleAttachments(id));
    await enqueueDownloads(queue, "article", readable, attachments);
  },
};

/* -------------------------------------------------------------------------- */
/* Orchestrator                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Downloads the complete history of a project into `out`.
 *
 * @param {object} params
 * @param {object} params.client YouTrack client (or any object with the same methods).
 * @param {{ url?: string }} [params.config] Loaded CLI configuration.
 * @param {string} params.project Project key, e.g. "PRJ".
 * @param {string} [params.out] Output directory, defaults to `./<project>`.
 * @param {object} [params.options] Export options (concurrency, limit, since,
 *   attachments, activities, articles, fresh, force, json, pageSize,
 *   maxAttempts, backoffMs, backend).
 * @param {object} [params.logger] Injectable logger with `status`/`log`/`done`.
 * @returns {Promise<object>} Summary with counts, queue stats and failed jobs.
 */
export async function exportProject({ client, config = {}, project, out, options = {}, logger } = {}) {
  if (!client) throw new Error("exportProject requires a client");
  if (!project) throw new Error("exportProject requires a project key");

  const paths = createPaths(out || `./${sanitizeFilename(project)}`);
  const log = logger || createStderrLogger({ silent: Boolean(options.json) });
  const startedAt = Date.now();

  await mkdir(paths.root, { recursive: true });
  await mkdir(paths.meta, { recursive: true });

  const lock = await acquireLock(paths.meta, { force: Boolean(options.force) });
  let queue;
  const control = { stopped: false, signal: null };
  const signals = ["SIGINT", "SIGTERM"];
  const onSignal = (signal) => {
    control.stopped = true;
    control.signal = signal;
  };
  for (const signal of signals) process.on(signal, onSignal);

  try {
    queue = await openQueue(paths.meta, {
      backend: options.backend || "auto",
      fresh: Boolean(options.fresh),
    });
    await queue.recoverRunning();

    const run = await resolveRun(queue, paths, options);

    const counters = createCounters();
    const context = {
      run,
      queue: scopeQueue(queue, run),
      client,
      paths,
      config,
      logger: log,
      counters,
      options: { ...options, project },
      retry: {
        maxAttempts: positiveNumber(options.maxAttempts) || DEFAULT_MAX_ATTEMPTS,
        backoffMs: options.backoffMs === undefined ? DEFAULT_BACKOFF_MS : Number(options.backoffMs),
      },
    };

    await seedQueue(context);
    await runWorkers(context, control);

    const stats = await queue.stats();
    const failedJobs = await queue.listFailed(50);
    const finishedAt = Date.now();
    const summary = {
      project,
      out: paths.root,
      backend: queue.backend,
      run,
      options: publicOptions(options),
      counts: { ...counters },
      stats,
      failed: failedJobs.length,
      failedJobs: failedJobs.map((job) => ({ id: job.id, type: job.type, key: job.key, error: job.error })),
      interrupted: Boolean(control.signal),
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - startedAt,
      manifest: paths.manifest,
    };

    await writeJson(paths.manifest, summary);
    log.done?.();
    return summary;
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
    if (queue) await queue.close().catch(() => {});
    await lock.release();
  }
}

/**
 * Resolves the run number for this invocation. Pending work means a previous run
 * was interrupted, so it is resumed under its own number; otherwise a new run
 * starts. Job keys are scoped to that number, which is what lets a finished
 * export be run again to pick up new and updated issues.
 */
async function resolveRun(queue, paths, options) {
  const previous = Boolean(options.fresh) ? 0 : await readRun(paths.run);
  const stats = await queue.stats();
  const run = stats.pending > 0 && previous > 0 ? previous : previous + 1;
  await writeJson(paths.run, { run, updatedAt: new Date().toISOString() });
  return run;
}

async function readRun(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return positiveNumber(value?.run) || 0;
  } catch {
    return 0;
  }
}

/**
 * Wraps the queue so that every job a handler enqueues is scoped to the current
 * run. Keys stay unique within a run, so the dedupe that prevents an issue from
 * being fetched twice still applies, while a later run schedules the same work
 * again instead of being deduplicated against the finished one.
 */
function scopeQueue(queue, run) {
  const scope = (job) => ({
    ...job,
    key: `r${run}:${job.key ?? `${job.type}:${JSON.stringify(job.payload ?? null)}`}`,
  });

  return {
    get backend() {
      return queue.backend;
    },
    enqueue: (job) => queue.enqueue(scope(job)),
    enqueueMany: (jobs) => queue.enqueueMany(jobs.map(scope)),
    claim: (count) => queue.claim(count),
    complete: (job) => queue.complete(job),
    fail: (job, error, retry) => queue.fail(job, error, retry),
    stats: () => queue.stats(),
    listFailed: (limit) => queue.listFailed(limit),
  };
}

/** Seeds the first index job unless the queue already holds pending work. */
async function seedQueue(context) {
  const { queue, options } = context;
  const stats = await queue.stats();
  if (stats.pending > 0) return false;

  const jobs = [{ type: "project:index", key: "project:index:0", payload: { skip: 0 }, priority: 20 }];
  if (options.articles) jobs.push({ type: "article:index", key: "article:index:0", payload: { skip: 0 }, priority: 20 });
  await queue.enqueueMany(jobs);
  return true;
}

/**
 * Runs `concurrency` worker loops against a single queue instance until the
 * queue drains: no claimable job, no job running in the queue, no worker busy
 * and no retry scheduled for the future.
 */
async function runWorkers(context, control) {
  const concurrency = Math.max(1, positiveNumber(context.options.concurrency) || DEFAULT_CONCURRENCY);
  const progress = createProgress(context);
  let busy = 0;

  const worker = async () => {
    while (!control.stopped) {
      const [job] = await context.queue.claim(1);
      if (job) {
        busy += 1;
        try {
          await runJob(context, job);
        } finally {
          busy -= 1;
        }
        await progress();
        continue;
      }

      if (busy > 0) {
        await sleep(IDLE_POLL_MS);
        continue;
      }

      // No claimable job and nothing in flight: only future retries can revive
      // the queue, so the run is over when nothing is pending nor running.
      const stats = await context.queue.stats();
      if (stats.pending === 0 && stats.running === 0) return;
      await progress();
      await sleep(IDLE_POLL_MS);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  await progress(true);
}

/** Runs one job; individual failures go back to the queue so they are retried. */
async function runJob(context, job) {
  const handler = handlers[job.type];
  if (!handler) {
    await context.queue.fail(job, new Error(`Unknown job type: ${job.type}`), { maxAttempts: 1 });
    return;
  }

  try {
    await handler({ ...context, job });
    await context.queue.complete(job);
  } catch (error) {
    await context.queue.fail(job, error, context.retry);
  }
}

/** Throttled one-line progress report on the injected logger. */
function createProgress(context) {
  let last = 0;
  return async (force = false) => {
    const now = Date.now();
    if (!force && now - last < PROGRESS_INTERVAL_MS) return;
    last = now;
    if (typeof context.logger?.status !== "function") return;
    const stats = await context.queue.stats();
    const counters = context.counters;
    context.logger.status(
      `queue pending=${stats.pending} running=${stats.running} done=${stats.done} failed=${stats.failed}`
      + ` | issues=${counters.issues} activities=${counters.activities} assets=${counters.assets}`,
    );
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function createCounters() {
  return { issues: 0, comments: 0, activities: 0, assets: 0, assetsSkipped: 0, bytes: 0, articles: 0 };
}

function bump(counters, name, amount = 1) {
  if (!counters || typeof counters[name] !== "number") return;
  counters[name] += amount;
}

function publicOptions(options) {
  const { project, ...rest } = options;
  return rest;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function pageSize(options) {
  return positiveNumber(options.pageSize) || DEFAULT_PAGE_SIZE;
}

function activityPageSize(options) {
  return positiveNumber(options.activityPageSize) || DEFAULT_ACTIVITY_PAGE_SIZE;
}

function sinceQuery(since) {
  return since ? `updated: ${since} .. Today` : "";
}

function issueKey(issue) {
  return issue?.idReadable || issue?.id || null;
}

function assetFilename(attachment) {
  const id = attachment?.id ?? "attachment";
  const name = attachment?.name ?? "file";
  return sanitizeFilename(`${id}__${name}`);
}

async function enqueueDownloads(queue, kind, owner, attachments) {
  const jobs = attachments
    .filter((attachment) => attachment && attachment.url)
    .map((attachment) => ({
      type: "asset:download",
      key: `asset:download:${kind}:${owner}:${attachment.id ?? attachment.name}`,
      payload: { kind, owner, attachment },
    }));
  if (jobs.length) await queue.enqueueMany(jobs);
  return jobs.length;
}

async function fileSize(path) {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value ?? null, null, 2)}\n`, "utf8");
}

/**
 * Appends entries to a JSON array file, keeping the file valid JSON at all
 * times: the previous content is read, merged and rewritten.
 */
async function appendJsonArray(path, entries) {
  let current = [];
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (Array.isArray(parsed)) current = parsed;
  } catch (error) {
    if (error.code && error.code !== "ENOENT") throw error;
  }
  await writeJson(path, current.concat(entries));
}

function sleep(ms) {
  if (!(ms > 0)) return Promise.resolve();
  // Not unref'd on purpose: a worker waiting here is still running a job, so the
  // runtime must stay alive until the wait resolves.
  return new Promise((resolve) => setTimeout(resolve, ms));
}
