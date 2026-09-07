import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPaths, createStderrLogger, exportProject, handlers } from "../src/project-export.js";
import { openQueue } from "../src/queue.js";

const CONFIG = { url: "https://yt.example.com", token: "tok" };

async function withTempDir(run) {
  const directory = await mkdtemp(join(tmpdir(), "youtrack-export-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Logger that records every line instead of writing to stderr. */
function recordingLogger() {
  const lines = [];
  return {
    lines,
    status: (line) => lines.push(`status:${line}`),
    log: (line) => lines.push(`log:${line}`),
    done: () => {},
  };
}

/** Builds a handler context bound to a real queue and a temporary output tree. */
async function createContext(directory, { client, options = {}, backend = "jsonl" } = {}) {
  const paths = createPaths(join(directory, "out"));
  const queue = await openQueue(join(paths.root, ".yt-export"), { backend });
  return {
    queue,
    client,
    paths,
    config: CONFIG,
    logger: recordingLogger(),
    counters: { issues: 0, comments: 0, activities: 0, assets: 0, assetsSkipped: 0, bytes: 0, articles: 0 },
    options: { project: "PRJ", ...options },
  };
}

/**
 * Claims and runs every pending job of one type, returning the number of runs.
 * Jobs of other types are held aside and returned to "pending" at the end so
 * the assertions can inspect them.
 */
async function drain(context, type) {
  let runs = 0;
  for (;;) {
    const [job] = await context.queue.claim(1);
    if (!job) break;
    if (job.type !== type) continue; // Stays "running" until recoverRunning below.
    await handlers[job.type]({ ...context, job });
    await context.queue.complete(job);
    runs += 1;
  }
  await context.queue.recoverRunning();
  return runs;
}

function readJson(path) {
  return readFile(path, "utf8").then(JSON.parse);
}

test("project:index pages through every issue exactly once and stops", async () => {
  await withTempDir(async (directory) => {
    const all = ["PRJ-1", "PRJ-2", "PRJ-3", "PRJ-4", "PRJ-5"].map((id) => ({ id, idReadable: id }));
    const calls = [];
    const client = {
      async listProjectIssues({ skip, top, query }) {
        calls.push({ skip, top, query });
        return all.slice(skip, skip + top);
      },
    };

    const context = await createContext(directory, { client, options: { pageSize: 2 } });
    await context.queue.enqueue({ type: "project:index", key: "project:index:0", payload: { skip: 0 } });
    const runs = await drain(context, "project:index");

    assert.equal(runs, 3);
    assert.deepEqual(calls.map((call) => call.skip), [0, 2, 4]);

    const stats = await context.queue.stats();
    assert.equal(stats.pending, 5);

    const claimed = await context.queue.claim(10);
    assert.deepEqual(
      claimed.map((job) => job.payload.id).sort(),
      ["PRJ-1", "PRJ-2", "PRJ-3", "PRJ-4", "PRJ-5"],
    );
    assert.ok(claimed.every((job) => job.type === "issue:fetch"));
    await context.queue.close();
  });
});

test("project:index honours options.limit and options.since", async () => {
  await withTempDir(async (directory) => {
    const calls = [];
    const client = {
      async listProjectIssues({ skip, top, query }) {
        calls.push({ skip, top, query });
        return Array.from({ length: top }, (_, index) => ({ idReadable: `PRJ-${skip + index + 1}` }));
      },
    };

    const context = await createContext(directory, {
      client,
      options: { pageSize: 2, limit: 3, since: "2024-01-01" },
    });
    await context.queue.enqueue({ type: "project:index", key: "project:index:0", payload: { skip: 0 } });
    await drain(context, "project:index");

    assert.deepEqual(calls, [
      { skip: 0, top: 2, query: "updated: 2024-01-01 .. Today" },
      { skip: 2, top: 1, query: "updated: 2024-01-01 .. Today" },
    ]);
    assert.equal((await context.queue.stats()).pending, 3);
    await context.queue.close();
  });
});

test("issue:fetch writes the issue files and enqueues the follow-up jobs", async () => {
  await withTempDir(async (directory) => {
    const client = {
      async getIssue(id) {
        return { id: "2-1", idReadable: id, summary: "Broken login", description: "It fails" };
      },
      async getIssueComments() {
        return [{ id: "4-1", text: "Reproduced", author: { login: "ana" } }];
      },
    };

    const context = await createContext(directory, { client });
    const job = { id: 1, type: "issue:fetch", payload: { id: "PRJ-1" } };
    await handlers["issue:fetch"]({ ...context, job });

    const issueDir = context.paths.issueDir("PRJ-1");
    assert.deepEqual((await readdir(issueDir)).sort(), ["comments.json", "issue.json", "issue.md"]);

    const issue = await readJson(join(issueDir, "issue.json"));
    assert.equal(issue.summary, "Broken login");
    const comments = await readJson(join(issueDir, "comments.json"));
    assert.equal(comments.length, 1);

    const markdown = await readFile(join(issueDir, "issue.md"), "utf8");
    assert.match(markdown, /# PRJ-1 Broken login/);
    assert.match(markdown, /Reproduced/);
    assert.match(markdown, /sourceUrl: "https:\/\/yt\.example\.com\/issue\/PRJ-1"/);

    assert.equal(context.counters.issues, 1);
    assert.equal(context.counters.comments, 1);

    const claimed = await context.queue.claim(10);
    assert.deepEqual(claimed.map((entry) => entry.type).sort(), ["issue:activities", "issue:attachments"]);
    await context.queue.close();
  });
});

test("issue:fetch skips the follow-ups that are disabled", async () => {
  await withTempDir(async (directory) => {
    const client = {
      async getIssue(id) {
        return { idReadable: id, summary: "S" };
      },
      async getIssueComments() {
        return [];
      },
    };

    const context = await createContext(directory, { client, options: { attachments: false, activities: false } });
    await handlers["issue:fetch"]({ ...context, job: { id: 1, type: "issue:fetch", payload: { id: "PRJ-9" } } });
    assert.equal((await context.queue.stats()).total, 0);
    await context.queue.close();
  });
});

test("issue:activities follows afterCursor until hasAfter is false", async () => {
  await withTempDir(async (directory) => {
    const pages = {
      start: { activities: [{ id: "a1" }, { id: "a2" }], afterCursor: "c1", hasAfter: true },
      c1: { activities: [{ id: "a3" }], afterCursor: "c2", hasAfter: true },
      c2: { activities: [{ id: "a4" }], afterCursor: "c3", hasAfter: false },
    };
    const cursors = [];
    const client = {
      async getIssueActivitiesPage(id, { cursor }) {
        cursors.push(cursor ?? null);
        return pages[cursor ?? "start"];
      },
    };

    const context = await createContext(directory, { client });
    await mkdir(context.paths.issueDir("PRJ-1"), { recursive: true });
    await context.queue.enqueue({
      type: "issue:activities",
      key: "issue:activities:PRJ-1:0",
      payload: { id: "PRJ-1", readable: "PRJ-1", cursor: null },
    });

    const runs = await drain(context, "issue:activities");
    assert.equal(runs, 3);
    assert.deepEqual(cursors, [null, "c1", "c2"]);

    const activities = await readJson(join(context.paths.issueDir("PRJ-1"), "activities.json"));
    assert.deepEqual(activities.map((entry) => entry.id), ["a1", "a2", "a3", "a4"]);
    assert.equal(context.counters.activities, 4);
    await context.queue.close();
  });
});

test("issue:attachments enqueues one download per attachment", async () => {
  await withTempDir(async (directory) => {
    const client = {
      async getIssueAttachments() {
        return [
          { id: "1-1", name: "a.png", size: 3, url: "/attachments/1-1" },
          { id: "1-2", name: "b.png", size: 4, url: "/attachments/1-2" },
          { id: "1-3", name: "no-url.png", size: 4 },
        ];
      },
    };

    const context = await createContext(directory, { client });
    await handlers["issue:attachments"]({
      ...context,
      job: { id: 1, type: "issue:attachments", payload: { id: "PRJ-1", readable: "PRJ-1" } },
    });

    const claimed = await context.queue.claim(10);
    assert.equal(claimed.length, 2);
    assert.ok(claimed.every((job) => job.type === "asset:download"));
    assert.deepEqual(claimed.map((job) => job.payload.attachment.id), ["1-1", "1-2"]);
    await context.queue.close();
  });
});

test("asset:download skips a complete file and downloads a missing one", async () => {
  await withTempDir(async (directory) => {
    const downloads = [];
    const client = {
      async downloadAttachment(attachment, destination) {
        downloads.push(destination);
        await writeFile(destination, "abcd", "utf8");
        return { path: destination, bytes: 4 };
      },
    };

    const context = await createContext(directory, { client });
    const assets = join(context.paths.issueDir("PRJ-1"), "assets");
    await mkdir(assets, { recursive: true });
    await writeFile(join(assets, "1-1__done.png"), "abcd", "utf8");

    const run = (attachment) => handlers["asset:download"]({
      ...context,
      job: { id: 1, type: "asset:download", payload: { kind: "issue", owner: "PRJ-1", attachment } },
    });

    await run({ id: "1-1", name: "done.png", size: 4, url: "/attachments/1-1" });
    assert.deepEqual(downloads, []);
    assert.equal(context.counters.assetsSkipped, 1);

    await run({ id: "1-2", name: "missing.png", size: 4, url: "/attachments/1-2" });
    assert.deepEqual(downloads, [join(assets, "1-2__missing.png")]);
    assert.equal(context.counters.assets, 1);
    assert.equal(context.counters.bytes, 4);

    // A truncated file is downloaded again.
    await writeFile(join(assets, "1-3__partial.png"), "ab", "utf8");
    await run({ id: "1-3", name: "partial.png", size: 4, url: "/attachments/1-3" });
    assert.equal(downloads.length, 2);
    await context.queue.close();
  });
});

/* -------------------------------------------------------------------------- */
/* Full runs                                                                  */
/* -------------------------------------------------------------------------- */

function fakeClient({ issues = ["PRJ-1", "PRJ-2", "PRJ-3"], attachments = {} } = {}) {
  return {
    calls: { issues: 0 },
    async listProjectIssues({ skip, top }) {
      return issues.slice(skip, skip + top).map((id) => ({ id, idReadable: id }));
    },
    async getIssue(id) {
      this.calls.issues += 1;
      return { id, idReadable: id, summary: `Summary of ${id}`, description: `Body of ${id}` };
    },
    async getIssueComments(id) {
      return [{ id: `c-${id}`, text: `comment on ${id}` }];
    },
    async getIssueActivitiesPage(id, { cursor }) {
      if (cursor) return { activities: [{ id: `${id}-a2` }], afterCursor: null, hasAfter: false };
      return { activities: [{ id: `${id}-a1` }], afterCursor: `${id}-cursor`, hasAfter: true };
    },
    async getIssueAttachments(id) {
      return attachments[id] ?? [];
    },
    async downloadAttachment(attachment, destination) {
      await writeFile(destination, "x".repeat(attachment.size), "utf8");
      return { path: destination, bytes: attachment.size };
    },
  };
}

test("exportProject writes the full tree and a manifest", async () => {
  await withTempDir(async (directory) => {
    const out = join(directory, "PRJ");
    const client = fakeClient({
      attachments: { "PRJ-1": [{ id: "1-1", name: "logo.png", size: 5, url: "/attachments/1-1" }] },
    });
    const logger = recordingLogger();

    const summary = await exportProject({
      client,
      config: CONFIG,
      project: "PRJ",
      out,
      logger,
      // Default backend on purpose: exercises SQLite where the runtime provides it.
      options: { pageSize: 2, concurrency: 3, backoffMs: 1 },
    });

    assert.equal(summary.failed, 0);
    assert.equal(summary.project, "PRJ");
    assert.equal(summary.counts.issues, 3);
    assert.equal(summary.counts.comments, 3);
    assert.equal(summary.counts.activities, 6);
    assert.equal(summary.counts.assets, 1);
    assert.equal(summary.stats.pending, 0);
    assert.equal(summary.stats.running, 0);
    assert.equal(summary.stats.failed, 0);
    assert.equal(client.calls.issues, 3);

    assert.deepEqual((await readdir(out)).sort(), [".yt-export", "export.json", "issues"]);
    assert.deepEqual((await readdir(join(out, "issues"))).sort(), ["PRJ-1", "PRJ-2", "PRJ-3"]);
    assert.deepEqual(
      (await readdir(join(out, "issues", "PRJ-1"))).sort(),
      ["activities.json", "assets", "comments.json", "issue.json", "issue.md"],
    );
    assert.deepEqual(await readdir(join(out, "issues", "PRJ-1", "assets")), ["1-1__logo.png"]);
    assert.equal(await readFile(join(out, "issues", "PRJ-1", "assets", "1-1__logo.png"), "utf8"), "xxxxx");

    const activities = await readJson(join(out, "issues", "PRJ-2", "activities.json"));
    assert.deepEqual(activities.map((entry) => entry.id), ["PRJ-2-a1", "PRJ-2-a2"]);

    const manifest = await readJson(join(out, "export.json"));
    assert.equal(manifest.project, "PRJ");
    assert.equal(manifest.counts.issues, 3);
    assert.ok(manifest.startedAt <= manifest.finishedAt);
    assert.ok(logger.lines.length >= 1);
  });
});

test("exportProject exports articles when options.articles is set", async () => {
  await withTempDir(async (directory) => {
    const client = fakeClient({ issues: [] });
    client.listProjectArticles = async ({ skip, top }) => (
      skip === 0 ? [{ id: "42-1", idReadable: "PRJ-A-1" }].slice(0, top) : []
    );
    client.getArticle = async (id) => ({ id: "42-1", idReadable: id, summary: "Handbook", content: "Hello" });
    client.getArticleAttachments = async () => [];

    const out = join(directory, "PRJ");
    const summary = await exportProject({
      client,
      config: CONFIG,
      project: "PRJ",
      out,
      logger: recordingLogger(),
      options: { pageSize: 5, concurrency: 2, articles: true, backend: "jsonl", backoffMs: 1 },
    });

    assert.equal(summary.failed, 0);
    assert.equal(summary.counts.articles, 1);
    assert.deepEqual(
      (await readdir(join(out, "articles", "PRJ-A-1"))).sort(),
      ["article.json", "article.md"],
    );
    const markdown = await readFile(join(out, "articles", "PRJ-A-1", "article.md"), "utf8");
    assert.match(markdown, /# Handbook/);
  });
});

test("exportProject reports failed jobs instead of hanging", async () => {
  await withTempDir(async (directory) => {
    const client = fakeClient({ issues: ["PRJ-1"] });
    client.getIssue = async () => {
      throw new Error("boom");
    };

    const summary = await exportProject({
      client,
      config: CONFIG,
      project: "PRJ",
      out: join(directory, "PRJ"),
      logger: recordingLogger(),
      options: { pageSize: 5, concurrency: 2, backend: "jsonl", maxAttempts: 2, backoffMs: 1 },
    });

    assert.equal(summary.failed, 1);
    assert.equal(summary.stats.failed, 1);
    assert.equal(summary.failedJobs[0].type, "issue:fetch");
    assert.match(summary.failedJobs[0].error, /boom/);

    const manifest = await readJson(join(directory, "PRJ", "export.json"));
    assert.equal(manifest.failed, 1);
  });
});

test("exportProject resumes a queue that already holds pending work", async () => {
  await withTempDir(async (directory) => {
    const out = join(directory, "PRJ");
    const client = fakeClient({ issues: ["PRJ-1", "PRJ-2"] });

    // Pre-seed the queue with a single issue job: the index job must not be added.
    const queue = await openQueue(join(out, ".yt-export"), { backend: "jsonl" });
    await queue.enqueue({ type: "issue:fetch", key: "issue:fetch:PRJ-2", payload: { id: "PRJ-2" } });
    await queue.close();

    const summary = await exportProject({
      client,
      config: CONFIG,
      project: "PRJ",
      out,
      logger: recordingLogger(),
      options: { concurrency: 1, backend: "jsonl", backoffMs: 1 },
    });

    assert.equal(summary.failed, 0);
    assert.equal(summary.counts.issues, 1);
    assert.deepEqual(await readdir(join(out, "issues")), ["PRJ-2"]);
  });
});

test("exportProject removes its signal listeners", async () => {
  await withTempDir(async (directory) => {
    const before = process.listenerCount("SIGINT");
    await exportProject({
      client: fakeClient({ issues: [] }),
      config: CONFIG,
      project: "PRJ",
      out: join(directory, "PRJ"),
      logger: recordingLogger(),
      options: { backend: "jsonl", backoffMs: 1 },
    });
    assert.equal(process.listenerCount("SIGINT"), before);
  });
});

test("createPaths and createStderrLogger behave as documented", async () => {
  const paths = createPaths("/tmp/example");
  assert.equal(paths.meta, "/tmp/example/.yt-export");
  assert.equal(paths.issueDir("PRJ-1"), "/tmp/example/issues/PRJ-1");
  assert.equal(paths.articleDir("A/B"), "/tmp/example/articles/A_B");

  const written = [];
  const logger = createStderrLogger({ stream: { write: (text) => written.push(text) } });
  logger.status("working");
  logger.done();
  assert.deepEqual(written, ["\rworking", "\n"]);

  const silent = createStderrLogger({ silent: true, stream: { write: () => written.push("nope") } });
  silent.status("hidden");
  silent.log("hidden");
  assert.equal(written.length, 2);
});

test("a second exportProject run re-indexes the project under a new run number", async () => {
  await withTempDir(async (directory) => {
    const out = join(directory, "PRJ");
    const client = fakeClient({
      issues: ["PRJ-1", "PRJ-2"],
      attachments: { "PRJ-1": [{ id: "1-1", name: "logo.png", size: 5, url: "/attachments/1-1" }] },
    });
    const options = { concurrency: 1, backend: "jsonl", backoffMs: 1 };

    const first = await exportProject({ client, config: CONFIG, project: "PRJ", out, logger: recordingLogger(), options });
    assert.equal(first.run, 1);
    assert.equal(first.counts.issues, 2);
    assert.equal(first.counts.assets, 1);

    // Running again must pick up remote changes rather than deduplicate against
    // the finished run, while assets already on disk are skipped.
    const second = await exportProject({ client, config: CONFIG, project: "PRJ", out, logger: recordingLogger(), options });
    assert.equal(second.run, 2);
    assert.equal(second.counts.issues, 2);
    assert.equal(second.counts.assets, 0);
    assert.equal(second.counts.assetsSkipped, 1);
    assert.equal(second.failed, 0);
  });
});

test("an interrupted run resumes under the same run number", async () => {
  await withTempDir(async (directory) => {
    const out = join(directory, "PRJ");
    const meta = join(out, ".yt-export");
    const client = fakeClient({ issues: ["PRJ-1", "PRJ-2"] });

    // Simulate a run that stopped with work still pending under run 1.
    await mkdir(meta, { recursive: true });
    await writeFile(join(meta, "run.json"), JSON.stringify({ run: 1 }), "utf8");
    const queue = await openQueue(meta, { backend: "jsonl" });
    await queue.enqueue({ type: "issue:fetch", key: "r1:issue:fetch:PRJ-2", payload: { id: "PRJ-2" } });
    await queue.close();

    const summary = await exportProject({
      client,
      config: CONFIG,
      project: "PRJ",
      out,
      logger: recordingLogger(),
      options: { concurrency: 1, backend: "jsonl", backoffMs: 1 },
    });

    assert.equal(summary.run, 1);
    assert.equal(summary.counts.issues, 1);
    assert.deepEqual(await readdir(join(out, "issues")), ["PRJ-2"]);
  });
});

test("--fresh restarts the run numbering", async () => {
  await withTempDir(async (directory) => {
    const out = join(directory, "PRJ");
    const client = fakeClient({ issues: ["PRJ-1"] });
    const options = { concurrency: 1, backend: "jsonl", backoffMs: 1 };

    await exportProject({ client, config: CONFIG, project: "PRJ", out, logger: recordingLogger(), options });
    const fresh = await exportProject({
      client,
      config: CONFIG,
      project: "PRJ",
      out,
      logger: recordingLogger(),
      options: { ...options, fresh: true },
    });

    assert.equal(fresh.run, 1);
    assert.equal(fresh.counts.issues, 1);
  });
});
