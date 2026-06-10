const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseMarkdownDocument(text) {
  const match = text.match(FRONTMATTER_RE);
  if (!match) return { meta: {}, body: text };
  return {
    meta: parseYaml(match[1]),
    body: text.slice(match[0].length),
  };
}

export function stringifyMarkdownDocument(meta, body) {
  return `---\n${stringifyYaml(meta)}---\n\n${body.trimStart()}`;
}

export function issueToMarkdown(issue, options = {}) {
  const meta = compact({
    kind: "issue",
    id: issue.id,
    idReadable: issue.idReadable,
    summary: issue.summary,
    project: issue.project,
    created: issue.created,
    updated: issue.updated,
    resolved: issue.resolved,
    reporter: issue.reporter,
    assignee: firstFieldValue(issue, "Assignee"),
    customFields: customFieldMap(issue.customFields),
    links: normalizeLinks(issue.links),
    comments: options.includeComments ? issue.comments : undefined,
    exportedAt: new Date().toISOString(),
    sourceUrl: options.sourceUrl,
  });

  const title = `# ${issue.idReadable || issue.id || "New issue"} ${issue.summary || ""}`.trim();
  const description = issue.description || "";
  return stringifyMarkdownDocument(meta, `${title}\n\n${description}\n`);
}

export function articleToMarkdown(article, options = {}) {
  const meta = compact({
    kind: "article",
    id: article.id,
    idReadable: article.idReadable,
    summary: article.summary,
    project: article.project,
    parentArticle: article.parentArticle,
    ordinal: article.ordinal,
    created: article.created,
    updated: article.updated,
    reporter: article.reporter,
    exportedAt: new Date().toISOString(),
    sourceUrl: options.sourceUrl,
  });
  return stringifyMarkdownDocument(meta, `# ${article.summary || article.idReadable || "Article"}\n\n${article.content || ""}\n`);
}

export function markdownToIssuePayload(meta, body) {
  const summary = meta.summary || headingFromBody(body);
  const description = stripFirstHeading(body).trim();
  const payload = compact({
    summary,
    description,
    project: meta.project,
  });

  const customFields = customFieldsPayload(meta.customFields);
  if (customFields.length) payload.customFields = customFields;
  return payload;
}

export function markdownToArticlePayload(meta, body) {
  return compact({
    summary: meta.summary || headingFromBody(body),
    content: stripFirstHeading(body).trim(),
    project: meta.project,
    parentArticle: meta.parentArticle,
    ordinal: meta.ordinal,
  });
}

function headingFromBody(body) {
  const line = body.split(/\r?\n/).find((entry) => entry.startsWith("# "));
  return line ? line.replace(/^#\s+/, "").trim() : undefined;
}

function stripFirstHeading(body) {
  return body.replace(/^# .*(\r?\n){1,2}/, "");
}

function customFieldMap(customFields = []) {
  const out = {};
  for (const field of customFields) {
    if (!field || !field.name) continue;
    out[field.name] = renderFieldValue(field.value);
  }
  return Object.keys(out).length ? out : undefined;
}

function customFieldsPayload(customFields = {}) {
  return Object.entries(customFields).map(([name, value]) => ({
    name,
    value: fieldValuePayload(value),
  }));
}

function fieldValuePayload(value) {
  if (Array.isArray(value)) return value.map(fieldValuePayload);
  if (value && typeof value === "object") return value;
  if (typeof value === "string") return { name: value };
  return value;
}

function renderFieldValue(value) {
  if (Array.isArray(value)) return value.map(renderFieldValue);
  if (value && typeof value === "object") return value.name || value.login || value.fullName || value.localizedName || value.presentation || value.idReadable || value.id || value;
  return value;
}

function firstFieldValue(issue, fieldName) {
  const field = issue.customFields?.find((entry) => entry.name === fieldName);
  return field ? renderFieldValue(field.value) : undefined;
}

function normalizeLinks(links = []) {
  const normalized = links
    .map((link) => compact({
      type: link.linkType?.name,
      direction: link.direction,
      issues: link.issues?.map((issue) => compact({
        id: issue.id,
        idReadable: issue.idReadable,
        summary: issue.summary,
      })),
    }))
    .filter((link) => link.issues?.length);
  return normalized.length ? normalized : undefined;
}

export function parseYaml(text) {
  const lines = text.replace(/\t/g, "  ").split(/\r?\n/);
  const root = {};
  const stack = [{ indent: -1, value: root, key: undefined }];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    const indent = rawLine.match(/^ */)[0].length;
    const line = rawLine.trim();
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop();
    const parent = stack.at(-1).value;

    if (line.startsWith("- ")) {
      if (!Array.isArray(parent)) continue;
      const item = line.slice(2).trim();
      const itemKeyValue = splitKeyValue(item);
      if (!itemKeyValue) {
        parent.push(parseScalar(item));
        continue;
      }

      const [key, rest] = itemKeyValue;
      const object = {};
      parent.push(object);
      if (rest) {
        object[key] = parseScalar(rest);
      } else {
        object[key] = nextContainer(lines, lineIndex);
        stack.push({ indent: indent + 2, value: object[key], key });
      }
      stack.push({ indent, value: object, key: undefined });
      continue;
    }

    const keyValue = splitKeyValue(line);
    if (!keyValue) continue;
    const [key, rest] = keyValue;
    if (rest) {
      parent[key] = parseScalar(rest);
      continue;
    }

    parent[key] = nextContainer(lines, lineIndex);
    stack.push({ indent, value: parent[key], key });
  }

  return root;
}

export function stringifyYaml(value, indent = 0) {
  return Object.entries(value || {})
    .filter(([, entry]) => entry !== undefined)
    .map(([key, entry]) => stringifyYamlEntry(key, entry, indent))
    .join("");
}

function stringifyYamlEntry(key, value, indent) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}${key}: []\n`;
    return `${pad}${key}:\n${value.map((entry) => stringifyArrayEntry(entry, indent + 2)).join("")}`;
  }
  if (value && typeof value === "object") {
    if (!Object.keys(value).length) return `${pad}${key}: {}\n`;
    return `${pad}${key}:\n${stringifyYaml(value, indent + 2)}`;
  }
  return `${pad}${key}: ${stringifyScalar(value)}\n`;
}

function stringifyArrayEntry(value, indent) {
  const pad = " ".repeat(indent);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const [first, ...rest] = Object.entries(value);
    if (!first) return `${pad}- {}\n`;
    if (first[1] && typeof first[1] === "object") {
      const firstLine = `${pad}- ${first[0]}:\n${stringifyNestedValue(first[1], indent + 4)}`;
      return firstLine + rest.map(([key, entry]) => stringifyYamlEntry(key, entry, indent + 2)).join("");
    }
    const firstLine = `${pad}- ${first[0]}: ${stringifyScalar(first[1])}\n`;
    return firstLine + rest.map(([key, entry]) => stringifyYamlEntry(key, entry, indent + 2)).join("");
  }
  return `${pad}- ${stringifyScalar(value)}\n`;
}

function stringifyNestedValue(value, indent) {
  if (Array.isArray(value)) return value.map((entry) => stringifyArrayEntry(entry, indent)).join("");
  if (value && typeof value === "object") return stringifyYaml(value, indent);
  return `${" ".repeat(indent)}${stringifyScalar(value)}\n`;
}

function stringifyScalar(value) {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  const string = String(value);
  if (!string || /[:#\-[\]{},&*!|>'"%@`]|^\s|\s$|\n/.test(string)) return JSON.stringify(string);
  return string;
}

function parseScalar(value) {
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value === "[]") return [];
  if (value === "{}") return {};
  return value;
}

function splitKeyValue(line) {
  const index = line.indexOf(":");
  if (index === -1) return undefined;
  return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
}

function nextContainer(lines, currentIndex) {
  for (let index = currentIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    return line.trimStart().startsWith("- ") ? [] : {};
  }
  return {};
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null));
}
