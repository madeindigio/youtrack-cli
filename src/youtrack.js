import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const ISSUE_FIELDS = [
  "id",
  "idReadable",
  "summary",
  "description",
  "created",
  "updated",
  "resolved",
  "project(id,name,shortName)",
  "reporter(id,login,fullName,email)",
  "customFields(id,name,value(id,name,login,fullName,presentation,localizedName,idReadable))",
  "links(direction,linkType(id,name,sourceToTarget,targetToSource),issues(id,idReadable,summary))",
].join(",");

const COMMENT_FIELDS = "id,text,created,updated,author(id,login,fullName,email)";
const ARTICLE_FIELDS = [
  "id",
  "idReadable",
  "summary",
  "content",
  "ordinal",
  "created",
  "updated",
  "project(id,name,shortName)",
  "parentArticle(id,idReadable,summary)",
  "reporter(id,login,fullName,email)",
].join(",");

const ATTACHMENT_FIELDS = "id,name,size,mimeType,extension,charset,created,url,author(login),comment(id)";

/** Issue fields used by the full project export: everything plus attachments and tags. */
export const ISSUE_EXPORT_FIELDS = [
  ISSUE_FIELDS,
  `attachments(${ATTACHMENT_FIELDS})`,
  "tags(id,name)",
].join(",");

/** Activity categories shared by issues and articles. */
const ARTICLE_ACTIVITY_CATEGORIES = ["ArticleCommentAttachmentsCategory", "ArticleTagsCategory"];

const COMMON_ACTIVITY_CATEGORIES = [
  "AttachmentRecognizedTextCategory",
  "AttachmentRenameCategory",
  "AttachmentVisibilityCategory",
  "AttachmentsCategory",
  "CommentAttachmentsCategory",
  "CommentTextCategory",
  "CommentVisibilityCategory",
  "CommentsCategory",
  "CustomFieldCategory",
  "DescriptionCategory",
  "IssueCreatedCategory",
  "IssueResolvedCategory",
  "IssueVisibilityCategory",
  "LinksCategory",
  "ProjectCategory",
  "PullRequestChangeCategory",
  "SprintCategory",
  "SummaryCategory",
  "TagsCategory",
  "TotalVotesCategory",
  "VcsChangeCategory",
  "VcsChangeStateCategory",
  "VotersCategory",
];

/** Every documented activity category id, joined by ",". */
export const ACTIVITY_CATEGORIES = [...ARTICLE_ACTIVITY_CATEGORIES, ...COMMON_ACTIVITY_CATEGORIES]
  .sort()
  .join(",");

/** Activity categories accepted by the issue activities endpoint (no Article* ones). */
export const ISSUE_ACTIVITY_CATEGORIES = COMMON_ACTIVITY_CATEGORIES.join(",");

const ACTIVITY_FIELDS = [
  "id",
  "timestamp",
  "$type",
  "category(id)",
  "author(id,login,fullName)",
  "field(id,name,presentation)",
  "added(id,name,text,login,fullName,presentation,idReadable,summary)",
  "removed(id,name,text,login,fullName,presentation,idReadable,summary)",
  "target(id,idReadable,text,summary)",
].join(",");

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class YouTrackClient {
  #nextSlot = 0;

  /**
   * @param {object} config
   * @param {string} config.url Base URL of the YouTrack instance.
   * @param {string} config.token Permanent token.
   * @param {number} [config.rate] Maximum outgoing requests per second (default 5).
   * @param {number} [config.maxRetries] Retries after the first attempt (default 4).
   * @param {number} [config.retryBaseMs] Base delay of the exponential backoff, in
   *   milliseconds (default 500). Mainly useful to keep tests fast.
   * @param {Function} [config.fetchImpl] Injectable `fetch`, used by the tests.
   */
  constructor({ url, token, rate = 5, maxRetries = 4, retryBaseMs = 500, fetchImpl = fetch } = {}) {
    this.url = url.replace(/\/$/, "");
    this.token = token;
    this.rate = rate > 0 ? rate : 0;
    this.maxRetries = Math.max(0, maxRetries);
    this.retryBaseMs = Math.max(0, retryBaseMs);
    this.fetchImpl = fetchImpl;
  }

  /** Token bucket: never let more than `rate` requests leave per second. */
  async #throttle() {
    if (!this.rate) return;
    const interval = 1000 / this.rate;
    const now = Date.now();
    const slot = Math.max(now, this.#nextSlot);
    this.#nextSlot = slot + interval;
    if (slot > now) await sleep(slot - now);
  }

  /** Performs one throttled fetch and retries retryable failures with backoff. */
  async #fetchWithRetry(url, init) {
    let lastNetworkError;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      await this.#throttle();

      let response;
      try {
        response = await this.fetchImpl(url, init);
      } catch (error) {
        lastNetworkError = error;
        if (attempt === this.maxRetries) throw error;
        await sleep(this.#backoff(attempt));
        continue;
      }

      if (response.ok || !RETRYABLE_STATUS.has(response.status) || attempt === this.maxRetries) {
        return response;
      }

      const retryAfter = retryAfterMs(response.headers?.get?.("retry-after"));
      // Drain the body so the connection can be reused before retrying.
      if (typeof response.text === "function") await response.text().catch(() => {});
      await sleep(retryAfter ?? this.#backoff(attempt));
    }

    throw lastNetworkError ?? new Error("YouTrack request failed");
  }

  #backoff(attempt) {
    const base = this.retryBaseMs * 2 ** attempt;
    return base + Math.floor(Math.random() * (this.retryBaseMs || 1));
  }

  async listIssues({ query = "", limit = 20, fields = "id,idReadable,summary,project(shortName),updated,resolved" } = {}) {
    return this.request("/api/issues", { query: { query, $top: limit, fields } });
  }

  async getIssue(id, { comments = false } = {}) {
    const issue = await this.request(`/api/issues/${encodeURIComponent(id)}`, { query: { fields: ISSUE_FIELDS } });
    if (comments) issue.comments = await this.getIssueComments(id);
    return issue;
  }

  async getIssueComments(id) {
    return this.request(`/api/issues/${encodeURIComponent(id)}/comments`, { query: { fields: COMMENT_FIELDS } });
  }

  async createIssue(payload) {
    return this.request("/api/issues", {
      method: "POST",
      query: { fields: ISSUE_FIELDS },
      body: payload,
    });
  }

  async updateIssue(id, payload) {
    return this.request(`/api/issues/${encodeURIComponent(id)}`, {
      method: "POST",
      query: { fields: ISSUE_FIELDS },
      body: payload,
    });
  }

  async listArticles({ query = "", limit = 20, fields = "id,idReadable,summary,project(shortName),updated" } = {}) {
    return this.request("/api/articles", { query: { query, $top: limit, fields } });
  }

  async getArticle(id) {
    return this.request(`/api/articles/${encodeURIComponent(id)}`, { query: { fields: ARTICLE_FIELDS } });
  }

  async createArticle(payload) {
    return this.request("/api/articles", {
      method: "POST",
      query: { fields: ARTICLE_FIELDS },
      body: payload,
    });
  }

  async updateArticle(id, payload) {
    return this.request(`/api/articles/${encodeURIComponent(id)}`, {
      method: "POST",
      query: { fields: ARTICLE_FIELDS },
      body: payload,
    });
  }

  async getProject(key) {
    return this.request(`/api/admin/projects/${encodeURIComponent(key)}`, {
      query: { fields: "id,name,shortName,description" },
    });
  }

  /**
   * Lists issues of a project, page by page. `order by: created asc` is appended so that
   * `$skip`/`$top` paging stays stable while the export runs.
   */
  async listProjectIssues({
    project,
    skip = 0,
    top = 100,
    query = "",
    fields = "id,idReadable,summary,updated,resolved,project(shortName)",
  } = {}) {
    return this.request("/api/issues", {
      query: {
        query: projectQuery(project, query),
        $skip: skip,
        $top: top,
        fields,
      },
    });
  }

  async getIssueAttachments(id) {
    return this.request(`/api/issues/${encodeURIComponent(id)}/attachments`, {
      query: { fields: ATTACHMENT_FIELDS },
    });
  }

  /** Fetches one cursor page of the issue activity history. */
  async getIssueActivitiesPage(id, { cursor, top = 100, reverse = false } = {}) {
    const page = await this.request(`/api/issues/${encodeURIComponent(id)}/activitiesPage`, {
      query: {
        categories: ISSUE_ACTIVITY_CATEGORIES,
        fields: `activities(${ACTIVITY_FIELDS}),afterCursor,hasAfter`,
        $top: top,
        reverse: reverse ? "true" : "false",
        ...(cursor ? { cursor } : {}),
      },
    });

    return {
      activities: page?.activities ?? [],
      afterCursor: page?.afterCursor ?? null,
      hasAfter: Boolean(page?.hasAfter),
    };
  }

  async getArticleAttachments(id) {
    return this.request(`/api/articles/${encodeURIComponent(id)}/attachments`, {
      query: { fields: ATTACHMENT_FIELDS },
    });
  }

  async listProjectArticles({ project, skip = 0, top = 100 } = {}) {
    return this.request("/api/articles", {
      query: {
        query: `project: {${project}}`,
        $skip: skip,
        $top: top,
        fields: "id,idReadable,summary,updated,project(shortName)",
      },
    });
  }

  /**
   * Downloads an attachment to `destinationPath`. YouTrack returns a signed RELATIVE url, so it
   * is appended to the instance base url. The body is streamed to a temporary file which is then
   * renamed into place, so a partial download never looks complete.
   *
   * @returns {Promise<{ path: string, bytes: number }>}
   */
  async downloadAttachment(attachment, destinationPath) {
    const target = attachmentUrl(this.url, attachment);
    const response = await this.#fetchWithRetry(target, {
      method: "GET",
      redirect: "follow",
      headers: { Authorization: `Bearer ${this.token}` },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`YouTrack API ${response.status} ${response.statusText}: ${text}`);
    }

    await mkdir(dirname(destinationPath), { recursive: true });
    const tempPath = `${destinationPath}.${process.pid}.${Date.now().toString(36)}.part`;

    try {
      if (response.body && typeof Readable.fromWeb === "function" && typeof response.body.getReader === "function") {
        await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath));
      } else {
        // Fallback for runtimes or fakes whose response body is not a web stream.
        const buffer = Buffer.from(await response.arrayBuffer());
        await writeFile(tempPath, buffer);
      }

      const { size } = await stat(tempPath);
      await rename(tempPath, destinationPath);
      return { path: destinationPath, bytes: size };
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }

  async request(path, { method = "GET", query = {}, body } = {}) {
    const url = new URL(`${this.url}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }

    const response = await this.#fetchWithRetry(url, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`YouTrack API ${response.status} ${response.statusText}: ${text}`);
    }

    if (response.status === 204) return null;
    return response.json();
  }
}

export function issueWebUrl(baseUrl, issue) {
  return `${baseUrl}/issue/${encodeURIComponent(issue.idReadable || issue.id)}`;
}

export function articleWebUrl(baseUrl, article) {
  return `${baseUrl}/articles/${encodeURIComponent(article.idReadable || article.id)}`;
}

function sleep(ms) {
  if (!(ms > 0)) return Promise.resolve();
  // The timer is deliberately not unref'd: a pending throttle slot or retry
  // backoff is work in progress, and letting the runtime exit through it would
  // abort the awaiting request without an error.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parses a `Retry-After` header given either as seconds or as an HTTP date. */
export function retryAfterMs(value, now = Date.now()) {
  if (value === undefined || value === null || value === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(String(value));
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

/** Builds the YouTrack search query used to page through a project. */
export function projectQuery(project, extra = "") {
  const parts = [`project: {${project}}`];
  const trimmed = String(extra || "").trim();
  if (trimmed) parts.push(trimmed);
  parts.push("order by: created asc");
  return parts.join(" ");
}

/** Resolves the signed, relative attachment url against the instance base url. */
export function attachmentUrl(baseUrl, attachment) {
  const raw = typeof attachment === "string" ? attachment : attachment?.url;
  if (!raw) throw new Error("Attachment has no url");
  if (/^https?:\/\//i.test(raw)) return raw;
  return `${baseUrl}${raw.startsWith("/") ? "" : "/"}${raw}`;
}
