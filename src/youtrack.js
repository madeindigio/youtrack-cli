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

export class YouTrackClient {
  constructor({ url, token }) {
    this.url = url.replace(/\/$/, "");
    this.token = token;
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

  async request(path, { method = "GET", query = {}, body } = {}) {
    const url = new URL(`${this.url}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }

    const response = await fetch(url, {
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
