#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { articleWebUrl, issueWebUrl, YouTrackClient } from "./youtrack.js";

const args = process.argv.slice(2);

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

Environment:
  YOUTRACK_URL, YOUTRACK_TOKEN, YOUTRACK_CONFIG
`);
}

function isEntrypoint() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}
