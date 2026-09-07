import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  ACTIVITY_CATEGORIES,
  ISSUE_ACTIVITY_CATEGORIES,
  ISSUE_EXPORT_FIELDS,
  YouTrackClient,
  attachmentUrl,
  projectQuery,
  retryAfterMs,
} from "../src/youtrack.js";

const BASE = { url: "https://yt.example.com/", token: "tok", retryBaseMs: 1 };

function jsonResponse(body, { status = 200, statusText = "OK", headers = {} } = {}) {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: { get: (name) => map.get(String(name).toLowerCase()) ?? null },
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
    async json() {
      return body;
    },
  };
}

/** Records every call and replies with the queued responses. */
function recordingFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init, at: Date.now() });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === "function") return next(String(url), init);
    if (next instanceof Error) throw next;
    return next;
  };
  impl.calls = calls;
  return impl;
}

test("constructor keeps the { url, token } contract and trims the trailing slash", () => {
  const client = new YouTrackClient({ url: "https://yt.example.com/", token: "tok" });
  assert.equal(client.url, "https://yt.example.com");
  assert.equal(client.token, "tok");
  assert.equal(client.rate, 5);
  assert.equal(client.maxRetries, 4);
});

test("ISSUE_EXPORT_FIELDS adds attachments and tags", () => {
  assert.ok(ISSUE_EXPORT_FIELDS.includes("idReadable"));
  assert.ok(ISSUE_EXPORT_FIELDS.includes("attachments(id,name,size,mimeType,extension,charset,created,url,author(login),comment(id))"));
  assert.ok(ISSUE_EXPORT_FIELDS.includes("tags(id,name)"));
});

test("ACTIVITY_CATEGORIES lists every documented category and the issue variant drops Article*", () => {
  const all = ACTIVITY_CATEGORIES.split(",");
  assert.equal(all.length, 25);
  assert.ok(all.includes("ArticleTagsCategory"));
  assert.ok(all.includes("VotersCategory"));
  assert.ok(!ISSUE_ACTIVITY_CATEGORIES.split(",").some((id) => id.startsWith("Article")));
  assert.equal(ISSUE_ACTIVITY_CATEGORIES.split(",").length, 23);
});

test("retryAfterMs understands seconds and HTTP dates", () => {
  const now = Date.parse("2024-01-01T00:00:00Z");
  assert.equal(retryAfterMs("2", now), 2000);
  assert.equal(retryAfterMs("Mon, 01 Jan 2024 00:00:03 GMT", now), 3000);
  assert.equal(retryAfterMs("Mon, 01 Jan 2023 00:00:00 GMT", now), 0);
  assert.equal(retryAfterMs(null, now), null);
  assert.equal(retryAfterMs("nonsense", now), null);
});

test("request retries a 429 honouring Retry-After and eventually succeeds", async () => {
  const fetchImpl = recordingFetch([
    jsonResponse("slow down", { status: 429, statusText: "Too Many Requests", headers: { "Retry-After": "0" } }),
    jsonResponse({ id: "1", idReadable: "PRJ-1" }),
  ]);
  const client = new YouTrackClient({ ...BASE, rate: 0, fetchImpl });

  const issue = await client.getIssue("PRJ-1");

  assert.equal(issue.idReadable, "PRJ-1");
  assert.equal(fetchImpl.calls.length, 2);
});

test("request retries network errors", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 3) throw new Error("ECONNRESET");
    return jsonResponse([{ id: "1" }]);
  };
  const client = new YouTrackClient({ ...BASE, rate: 0, fetchImpl });

  assert.deepEqual(await client.listIssues(), [{ id: "1" }]);
  assert.equal(calls, 3);
});

test("request gives up after maxRetries and throws the original YouTrack API message", async () => {
  const fetchImpl = recordingFetch([
    jsonResponse("boom", { status: 503, statusText: "Service Unavailable" }),
  ]);
  const client = new YouTrackClient({ ...BASE, rate: 0, maxRetries: 2, fetchImpl });

  await assert.rejects(
    () => client.getIssue("PRJ-1"),
    (error) => {
      assert.equal(error.message, "YouTrack API 503 Service Unavailable: boom");
      return true;
    },
  );
  assert.equal(fetchImpl.calls.length, 3);
});

test("non-retryable errors are not retried", async () => {
  const fetchImpl = recordingFetch([jsonResponse("nope", { status: 404, statusText: "Not Found" })]);
  const client = new YouTrackClient({ ...BASE, rate: 0, fetchImpl });

  await assert.rejects(() => client.getIssue("PRJ-1"), /YouTrack API 404 Not Found: nope/);
  assert.equal(fetchImpl.calls.length, 1);
});

test("the throttle spaces out outgoing requests", async () => {
  const fetchImpl = recordingFetch([jsonResponse([])]);
  const client = new YouTrackClient({ ...BASE, rate: 50, fetchImpl });

  const started = Date.now();
  await Promise.all([client.listIssues(), client.listIssues(), client.listIssues()]);
  const elapsed = Date.now() - started;

  assert.equal(fetchImpl.calls.length, 3);
  // 50 req/s means one slot every 20 ms, so three calls need at least ~40 ms.
  assert.ok(elapsed >= 35, `expected at least 35ms of spacing, got ${elapsed}ms`);
  assert.ok(fetchImpl.calls[2].at - fetchImpl.calls[0].at >= 30);
});

test("listProjectIssues builds the expected url and query", async () => {
  const fetchImpl = recordingFetch([jsonResponse([])]);
  const client = new YouTrackClient({ ...BASE, rate: 0, fetchImpl });

  await client.listProjectIssues({ project: "PRJ", skip: 100, top: 50, query: "updated: 2024-01-01 .. Today" });

  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.origin + url.pathname, "https://yt.example.com/api/issues");
  assert.equal(url.searchParams.get("query"), "project: {PRJ} updated: 2024-01-01 .. Today order by: created asc");
  assert.equal(url.searchParams.get("$skip"), "100");
  assert.equal(url.searchParams.get("$top"), "50");
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, "Bearer tok");
});

test("projectQuery appends a stable ordering", () => {
  assert.equal(projectQuery("PRJ"), "project: {PRJ} order by: created asc");
  assert.equal(projectQuery("PRJ", "  #Unresolved "), "project: {PRJ} #Unresolved order by: created asc");
});

test("getProject and the attachment listings hit the documented endpoints", async () => {
  const fetchImpl = recordingFetch([jsonResponse({ id: "0-1" })]);
  const client = new YouTrackClient({ ...BASE, rate: 0, fetchImpl });

  await client.getProject("PRJ");
  await client.getIssueAttachments("PRJ-1");
  await client.getArticleAttachments("PRJ-A-1");
  await client.listProjectArticles({ project: "PRJ", skip: 10, top: 20 });

  const paths = fetchImpl.calls.map((call) => new URL(call.url).pathname);
  assert.deepEqual(paths, [
    "/api/admin/projects/PRJ",
    "/api/issues/PRJ-1/attachments",
    "/api/articles/PRJ-A-1/attachments",
    "/api/articles",
  ]);
  const articles = new URL(fetchImpl.calls[3].url);
  assert.equal(articles.searchParams.get("query"), "project: {PRJ}");
  assert.equal(articles.searchParams.get("$skip"), "10");
  assert.equal(new URL(fetchImpl.calls[1].url).searchParams.get("fields"), "id,name,size,mimeType,extension,charset,created,url,author(login),comment(id)");
});

test("getIssueActivitiesPage maps the cursor response", async () => {
  const fetchImpl = recordingFetch([
    jsonResponse({ activities: [{ id: "a1" }], afterCursor: "cursor-2", hasAfter: true }),
    jsonResponse({ activities: [{ id: "a2" }], afterCursor: null, hasAfter: false }),
  ]);
  const client = new YouTrackClient({ ...BASE, rate: 0, fetchImpl });

  const first = await client.getIssueActivitiesPage("PRJ-1", { top: 10 });
  assert.deepEqual(first, { activities: [{ id: "a1" }], afterCursor: "cursor-2", hasAfter: true });

  const second = await client.getIssueActivitiesPage("PRJ-1", { cursor: first.afterCursor, top: 10 });
  assert.deepEqual(second, { activities: [{ id: "a2" }], afterCursor: null, hasAfter: false });

  const firstUrl = new URL(fetchImpl.calls[0].url);
  assert.equal(firstUrl.pathname, "/api/issues/PRJ-1/activitiesPage");
  assert.equal(firstUrl.searchParams.get("categories"), ISSUE_ACTIVITY_CATEGORIES);
  assert.equal(firstUrl.searchParams.get("$top"), "10");
  assert.equal(firstUrl.searchParams.get("reverse"), "false");
  assert.equal(firstUrl.searchParams.has("cursor"), false);
  assert.equal(new URL(fetchImpl.calls[1].url).searchParams.get("cursor"), "cursor-2");
});

test("getIssueActivitiesPage tolerates an empty payload", async () => {
  const client = new YouTrackClient({ ...BASE, rate: 0, fetchImpl: async () => jsonResponse(null) });
  assert.deepEqual(await client.getIssueActivitiesPage("PRJ-1"), {
    activities: [],
    afterCursor: null,
    hasAfter: false,
  });
});

test("attachmentUrl resolves relative signed paths against the base url", () => {
  assert.equal(
    attachmentUrl("https://yt.example.com/youtrack", { url: "/api/files/1-1?sign=abc" }),
    "https://yt.example.com/youtrack/api/files/1-1?sign=abc",
  );
  assert.equal(attachmentUrl("https://yt.example.com", "api/files/1-1"), "https://yt.example.com/api/files/1-1");
  assert.equal(attachmentUrl("https://yt.example.com", { url: "https://cdn.example.com/x" }), "https://cdn.example.com/x");
  assert.throws(() => attachmentUrl("https://yt.example.com", {}), /no url/);
});

test("downloadAttachment streams the body to disk and returns the byte count", async () => {
  const directory = await mkdtemp(join(tmpdir(), "youtrack-cli-download-"));
  const payload = Buffer.from("hello attachment payload", "utf8");
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => null },
      body: Readable.toWeb(Readable.from([payload])),
    };
  };
  const client = new YouTrackClient({ ...BASE, rate: 0, fetchImpl });

  try {
    const destination = join(directory, "assets", "1-1__file.txt");
    const result = await client.downloadAttachment({ url: "/api/files/1-1?sign=abc" }, destination);

    assert.equal(result.path, destination);
    assert.equal(result.bytes, payload.length);
    assert.equal(await readFile(destination, "utf8"), "hello attachment payload");
    assert.deepEqual(await readdir(join(directory, "assets")), ["1-1__file.txt"]);
    assert.equal(calls[0].url, "https://yt.example.com/api/files/1-1?sign=abc");
    assert.equal(calls[0].init.headers.Authorization, "Bearer tok");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("downloadAttachment falls back to a buffered write when the body is not a web stream", async () => {
  const directory = await mkdtemp(join(tmpdir(), "youtrack-cli-download-"));
  const payload = Buffer.from("buffered", "utf8");
  const client = new YouTrackClient({
    ...BASE,
    rate: 0,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => null },
      body: null,
      async arrayBuffer() {
        return payload;
      },
    }),
  });

  try {
    const destination = join(directory, "buffered.bin");
    assert.deepEqual(await client.downloadAttachment({ url: "/api/files/2-2" }, destination), {
      path: destination,
      bytes: payload.length,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("downloadAttachment retries and leaves no partial file when it fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "youtrack-cli-download-"));
  const client = new YouTrackClient({
    ...BASE,
    rate: 0,
    maxRetries: 1,
    fetchImpl: async () => jsonResponse("gone", { status: 502, statusText: "Bad Gateway" }),
  });

  try {
    const destination = join(directory, "missing.bin");
    await assert.rejects(
      () => client.downloadAttachment({ url: "/api/files/3-3" }, destination),
      /YouTrack API 502 Bad Gateway: gone/,
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
