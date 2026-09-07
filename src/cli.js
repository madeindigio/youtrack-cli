#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { configPath, loadConfig, requireConfig, saveConfig } from "./config.js";
import {
  articleToMarkdown,
  issueToMarkdown,
  markdownToArticlePayload,
  markdownToIssuePayload,
  parseMarkdownDocument,
} from "./markdown.js";
import { createPaths, createStderrLogger, exportProject } from "./project-export.js";
import { openQueue } from "./queue.js";
import { articleWebUrl, issueWebUrl, YouTrackClient } from "./youtrack.js";

const args = process.argv.slice(2);

const PROJECT_EXPORT_USAGE =
  "Usage: yt project export <projectKey> [--out <dir>] [--concurrency <n>] [--rate <req/s>] " +
  "[--no-attachments] [--no-activities] [--articles] [--since <date>] [--limit <n>] [--fresh] [--force] [--json]";

if (isEntrypoint()) {
  main(args).catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}

async function main(argv) {
  const { positionals, options } = parseArgs(argv);
  const [command, subcommand, ...rest] = positionals;

  if (!command || options.help || command === "help") return printHelp();
  if (command === "setup") return setup(options);
  if (command === "config") return showConfig();

  const config = await loadConfig();
  requireConfig(config);

  // The project command builds its own client because the request rate is a
  // CLI option and is only known once the subcommand has been resolved.
  if (command === "project") return project(config, subcommand, rest, options);

  const client = new YouTrackClient(config);

  if (command === "issues") return issues(client, config, subcommand, rest, options);
  if (command === "kb") return kb(client, config, subcommand, rest, options);

  throw new Error(`Unknown command: ${command}`);
}

async function setup(options) {
  if (!options.url || !options.token) throw new Error("Usage: yt setup --url <youtrack-url> --token <permanent-token>");
  const target = await saveConfig({ url: options.url, token: options.token });
  console.log(`Saved configuration to ${target}`);
}

async function showConfig() {
  const config = await loadConfig();
  console.log(JSON.stringify({ path: configPath(), url: config.url, hasToken: Boolean(config.token) }, null, 2));
}

async function issues(client, config, subcommand, rest, options) {
  if (subcommand === "list") {
    const issues = await client.listIssues({ query: options.query, limit: Number(options.limit || 20) });
    return printList(issues, options);
  }

  if (subcommand === "get") {
    const id = rest[0];
    if (!id) throw new Error("Usage: yt issues get <idReadable>");
    const issue = await client.getIssue(id, { comments: Boolean(options.comments) });
    if (options.json) return printJson(issue);
    console.log(issueToMarkdown(issue, { includeComments: Boolean(options.comments), sourceUrl: issueWebUrl(config.url, issue) }));
    return;
  }

  if (subcommand === "export") {
    const id = rest[0];
    if (!id) throw new Error("Usage: yt issues export <idReadable> --out <dir>");
    return exportIssue(client, config, id, options);
  }

  if (subcommand === "apply") {
    const file = rest[0];
    if (!file) throw new Error("Usage: yt issues apply <file.md>");
    return applyIssue(client, file, options);
  }

  throw new Error(`Unknown issues command: ${subcommand || ""}`);
}

async function kb(client, config, subcommand, rest, options) {
  if (subcommand === "list") {
    const articles = await client.listArticles({ query: options.query, limit: Number(options.limit || 20) });
    return printList(articles, options);
  }

  if (subcommand === "get") {
    const id = rest[0];
    if (!id) throw new Error("Usage: yt kb get <article-id>");
    const article = await client.getArticle(id);
    if (options.json) return printJson(article);
    console.log(articleToMarkdown(article, { sourceUrl: articleWebUrl(config.url, article) }));
    return;
  }

  if (subcommand === "export") {
    const id = rest[0];
    if (!id) throw new Error("Usage: yt kb export <article-id> --out <dir>");
    const article = await client.getArticle(id);
    const markdown = articleToMarkdown(article, { sourceUrl: articleWebUrl(config.url, article) });
    const file = await writeMarkdown(options.out || ".", article.idReadable || article.id, markdown);
    console.log(file);
    return;
  }

  if (subcommand === "apply") {
    const file = rest[0];
    if (!file) throw new Error("Usage: yt kb apply <file.md>");
    return applyArticle(client, file, options);
  }

  throw new Error(`Unknown kb command: ${subcommand || ""}`);
}

async function project(config, subcommand, rest, options) {
  if (subcommand === "export") return projectExport(config, rest[0], options);
  if (subcommand === "status") return projectStatus(rest[0], options);
  throw new Error(`Unknown project command: ${subcommand || ""}`);
}

/**
 * Normalizes the raw `parseArgs` output of `yt project export` into the option
 * object consumed by `exportProject`. Exported for testing.
 * @param {string} projectKey
 * @param {object} [options] Raw parsed CLI options.
 */
export function projectExportOptions(projectKey, options = {}) {
  if (!projectKey || projectKey === true) throw new Error(PROJECT_EXPORT_USAGE);

  const project = String(projectKey);
  return {
    project,
    out: stringOption(options.out, "out") || `./${sanitizeFilename(project)}`,
    concurrency: numberOption(options.concurrency, "concurrency", { fallback: 4, integer: true }),
    rate: numberOption(options.rate, "rate", { fallback: 5 }),
    attachments: !options.noAttachments,
    activities: !options.noActivities,
    articles: Boolean(options.articles),
    since: stringOption(options.since, "since"),
    limit: numberOption(options.limit, "limit", { integer: true }),
    fresh: Boolean(options.fresh),
    force: Boolean(options.force),
    json: Boolean(options.json),
  };
}

/**
 * Resolves the export directory inspected by `yt project status`.
 * @param {string} [projectKey] Optional project key positional.
 * @param {object} [options] Raw parsed CLI options.
 */
export function projectStatusOptions(projectKey, options = {}) {
  const out = stringOption(options.out, "out");
  if (out) return { out, json: Boolean(options.json) };
  if (projectKey && projectKey !== true) return { out: `./${sanitizeFilename(String(projectKey))}`, json: Boolean(options.json) };
  throw new Error("Usage: yt project status [<projectKey>] [--out <dir>] [--json]");
}

async function projectExport(config, projectKey, options) {
  const { project, out, ...exportOptions } = projectExportOptions(projectKey, options);
  const client = new YouTrackClient({ ...config, rate: exportOptions.rate });
  const logger = createStderrLogger({ silent: exportOptions.json });

  const summary = await exportProject({ client, config, project, out, options: exportOptions, logger });

  if (exportOptions.json) printJson(summary);
  else printExportSummary(summary);

  if (summary.failed > 0) {
    process.exitCode = 1;
    console.error(`${summary.failed} job(s) failed:`);
    for (const job of summary.failedJobs) console.error(`  ${job.type} ${job.key}: ${job.error || "unknown error"}`);
  }
}

async function projectStatus(projectKey, options) {
  const { out, json } = projectStatusOptions(projectKey, options);
  const paths = createPaths(out);
  if (!(await exists(paths.meta))) {
    throw new Error(`No export queue found at ${paths.meta}. Run "yt project export <projectKey> --out ${out}" first.`);
  }

  const queue = await openQueue(paths.meta, { backend: options.backend || "auto" });
  try {
    const stats = await queue.stats();
    const failedJobs = await queue.listFailed(50);
    if (json) {
      return printJson({ out: paths.root, backend: queue.backend, stats, failedJobs });
    }
    console.log(`Export directory: ${paths.root}`);
    console.log(`Queue backend:    ${queue.backend}`);
    console.log(`pending=${stats.pending} running=${stats.running} done=${stats.done} failed=${stats.failed} total=${stats.total}`);
    for (const job of failedJobs) console.log(`failed  ${job.type} ${job.key}: ${job.error || "unknown error"}`);
  } finally {
    await queue.close();
  }
}

function printExportSummary(summary) {
  const { counts, stats } = summary;
  console.log(summary.out);
  console.log(`issues=${counts.issues || 0} comments=${counts.comments || 0} activities=${counts.activities || 0} assets=${counts.assets || 0} articles=${counts.articles || 0}`);
  console.log(`jobs done=${stats.done} failed=${stats.failed} pending=${stats.pending}`);
  console.log(`manifest: ${summary.manifest}`);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function stringOption(value, name) {
  if (value === undefined) return undefined;
  if (value === true) throw new Error(`Option --${name} requires a value`);
  return String(value);
}

function numberOption(value, name, { fallback, integer = false } = {}) {
  if (value === undefined) return fallback;
  if (value === true) throw new Error(`Option --${name} requires a number`);
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`Option --${name} must be a positive number, got "${value}"`);
  if (integer && !Number.isInteger(number)) throw new Error(`Option --${name} must be an integer, got "${value}"`);
  return number;
}

async function exportIssue(client, config, id, options) {
  const issue = await client.getIssue(id, { comments: Boolean(options.comments) });
  const includeDependencies = Boolean(options.dependencies);
  const markdown = issueToMarkdown(issue, {
    includeComments: Boolean(options.comments),
    sourceUrl: issueWebUrl(config.url, issue),
  });
  const file = await writeMarkdown(options.out || ".", issue.idReadable || issue.id, markdown);
  console.log(file);

  if (!includeDependencies) return;
  const linkedIssues = new Map();
  for (const link of issue.links || []) {
    for (const linked of link.issues || []) {
      const linkedId = linked.idReadable || linked.id;
      if (linkedId && linkedId !== (issue.idReadable || issue.id)) linkedIssues.set(linkedId, linked);
    }
  }
  for (const linkedId of linkedIssues.keys()) {
    const linkedIssue = await client.getIssue(linkedId, { comments: Boolean(options.comments) });
    const linkedMarkdown = issueToMarkdown(linkedIssue, {
      includeComments: Boolean(options.comments),
      sourceUrl: issueWebUrl(config.url, linkedIssue),
    });
    console.log(await writeMarkdown(options.out || ".", linkedIssue.idReadable || linkedIssue.id, linkedMarkdown));
  }
}

async function applyIssue(client, file, options) {
  const { meta, body } = parseMarkdownDocument(await readFile(file, "utf8"));
  const payload = markdownToIssuePayload(meta, body);
  const id = options.id || meta.idReadable || meta.id;
  const issue = id ? await client.updateIssue(id, payload) : await client.createIssue(payload);
  printJson(issue);
}

async function applyArticle(client, file, options) {
  const { meta, body } = parseMarkdownDocument(await readFile(file, "utf8"));
  const payload = markdownToArticlePayload(meta, body);
  const id = options.id || meta.idReadable || meta.id;
  const article = id ? await client.updateArticle(id, payload) : await client.createArticle(payload);
  printJson(article);
}

async function writeMarkdown(directory, basename, markdown) {
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${sanitizeFilename(basename)}.md`);
  await writeFile(file, markdown, "utf8");
  return file;
}

function printList(items, options) {
  if (options.json) return printJson(items);
  for (const item of items) {
    console.log(`${item.idReadable || item.id}\t${item.summary || ""}`);
  }
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function parseArgs(argv) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const [key, inlineValue] = arg.slice(2).split("=", 2);
    const next = argv[index + 1];
    if (inlineValue !== undefined) {
      options[toCamel(key)] = inlineValue;
    } else if (next && !next.startsWith("--")) {
      options[toCamel(key)] = next;
      index += 1;
    } else {
      options[toCamel(key)] = true;
    }
  }
  return { positionals, options };
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

export function sanitizeFilename(value) {
  const sanitized = String(value)
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/[._ ]+$/g, "")
    .slice(0, 120);
  const fallback = sanitized || "youtrack-export";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(fallback)) return `_${fallback}`;
  return fallback;
}

function printHelp() {
  console.log(`youtrack-cli

Usage:
  yt setup --url <url> --token <token>
  yt config
  yt issues list [--query <query>] [--limit <n>] [--json]
  yt issues get <idReadable> [--comments] [--json]
  yt issues export <idReadable> [--dependencies] [--comments] [--out <dir>]
  yt issues apply <file.md> [--id <idReadable>]
  yt kb list [--query <query>] [--limit <n>] [--json]
  yt kb get <article-id> [--json]
  yt kb export <article-id> [--out <dir>]
  yt kb apply <file.md> [--id <article-id>]
  yt project export <projectKey> [--out <dir>] [--concurrency <n>] [--rate <req/s>]
                                 [--no-attachments] [--no-activities] [--articles]
                                 [--since <date>] [--limit <n>] [--fresh] [--force] [--json]
  yt project status [<projectKey>] [--out <dir>] [--json]

Project export:
  Downloads the whole project history (issues, comments, activities, links and
  binary attachments) into <dir>, defaulting to ./<projectKey>. Work is scheduled
  through a file-backed queue in <dir>/.yt-export, so rerunning the same command
  resumes where it stopped. Only one process may coordinate a given directory;
  use --force to take over a stale lock and --fresh to restart from scratch.

Environment:
  YOUTRACK_URL, YOUTRACK_TOKEN, YOUTRACK_CONFIG
`);
}

export function isEntrypointPath(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (!argv1) return false;

  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return fileURLToPath(moduleUrl) === argv1;
  }
}

function isEntrypoint() {
  return import.meta.main || isEntrypointPath();
}
