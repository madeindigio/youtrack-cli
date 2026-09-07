# AGENTS.md

This repository is a small terminal client for YouTrack that works in both Bun and Node.js. It exposes a single CLI entrypoint (`youtrack-cli` / `yt`) for configuring access, listing and fetching issues, exporting/importing Markdown documents, and working with knowledge-base articles. The project intentionally keeps dependencies light and relies on standard runtime APIs, a custom Markdown/YAML layer, and direct YouTrack REST calls.

## MANDATORY operating rules for AI agents

The rules below are mandatory for every task in this repository. They are not optional guidance and they take precedence over convenience, habits, or short-cuts.

### MANDATORY: gather context before starting any task

Before writing code, fixing a bug, or planning any change that builds on prior work, the agent must recover the relevant context first. Do not begin from a blank slate when existing knowledge or code history can inform the work.

1. Knowledge base first. Search the KB with `kb_search_documents` (or `hybrid_search_remembrances` when you also want indexed sessions and code in the same query). This is the primary entry point for any prior decisions, plans, and fixes. Search broadly without a `tags` filter first; only narrow with tags if you intentionally want one document class.
2. Follow the graph, do not only search. KB documents are connected through `[[wiki links]]`. Use `kb_search_documents` output, `kb_get_document`, and `kb_related_documents` to follow the most relevant links instead of guessing a second search query. If `kb_related_documents` is called without a `file_path`, it lists concepts that were referenced but not yet documented.
3. Then inspect the code index. Use `code_get_symbols_overview`, `code_find_symbol`, `code_hybrid_search`, and `code_search_pattern` before editing to understand package structure and the relevant symbols. Prefer these tools over blind reads when locating implementation points.
4. Use memory only when you already know the key. `recall` is suitable for short facts you already know roughly you need; it is not a replacement for the KB search and graph walk above.

If no relevant prior context exists after this search, say so briefly and proceed.

### MANDATORY: research external knowledge when the answer is not in the repo

When the task depends on information not present in the repository or the KB, the agent must research it instead of guessing.

- Library / framework / API usage: use the Context7 tools. Resolve the library with `c7_resolve_library_id`, then read current usage and API docs with `c7_get_library_docs`.
- General facts, current issues, release notes, or error messages: use web search and `fetch` to read the relevant sources. For any load-bearing fact, cross-check more than one source when possible.
- Frontend / browser behavior and UI verification: use the browser tools (`browser_navigate`, `browser_get_content`, `browser_evaluate`, `browser_click`, `browser_fill`, `browser_screenshot`, `browser_console_logs`, `browser_network`) to drive the page and verify the observed behavior rather than assuming the DOM or layout is correct.

If a tool is unavailable in the current environment, fall back to the closest equivalent and say so explicitly.

### MANDATORY: plan before non-trivial work

For anything larger than a trivial change, the agent must produce a written plan before implementing.

- Break the work into phases that can be tested independently.
- Save the plan to the KB with `kb_add_document` under a clear `file_path`, such as `youtrack-cli/plans/<short-slug>_plan.md`, so the plan survives the session and can be recovered later.
- If a relevant plan already exists, search for it first and confirm before diverging from it.
- Update the plan as phases are completed.

This is required even for modest multi-step fixes; it keeps the work traceable and prevents accidental drift.

### MANDATORY: implement in small, verified increments

- Write code in small, testable increments.
- After each meaningful increment, run the relevant checks or tests before moving on.
- Match the surrounding codebase conventions: naming, style, comment density, and module boundaries.
- Add or update tests for any new behavior. Put tests where the project already expects them.
- Never report work as done unless it was verified by a test, build step, or observed runtime behavior.
- If a step was skipped or a check failed, say so plainly and include the evidence.

For this project, the verification command is the existing repository check:

```bash
npm run check
```

This runs `node --check` against the project source and executes the Node test suite.

### MANDATORY: document every change in the knowledge base

After modifying, implementing, fixing, or refactoring anything, the agent must record a concise change summary with `kb_add_document`. This is mandatory, not optional, and it applies even to one-line fixes.

The summary must capture:

- What changed.
- The files and symbols touched.
- Why the change was needed.
- How it was verified.

Use a clear `file_path` such as `youtrack-cli/changes/<slug>.md`, `youtrack-cli/fixes/<slug>.md`, or `youtrack-cli/features/<slug>.md`. If a related document already exists, update it instead of creating a duplicate.

Write `[[concept]]` or `[[concept|label]]` in the change summary to link it to the plan, feature, or fix it builds on. This keeps the KB connected and makes related work discoverable with `kb_related_documents`.

### MANDATORY: choose the right memory tool

Use the tools for the right kind of information:

- `remember` / `recall`: only for short durable facts keyed by a known identifier, such as `project.test_command` or `user.preferred_lang`.
- `kb_add_document` / `kb_search_documents`: for plans, structured analysis, design notes, and long-form project documentation.

Do not use `remember` as a substitute for the KB for long or structured content.

### MANDATORY: general conduct

- Use English for code, comments, and documentation.
- Parallelize independent work when possible, but never at the expense of losing context.
- When delegating to sub-agents, provide clear, self-contained instructions and the context they need.
- For actions that are hard to reverse or outward-facing, confirm first unless you are explicitly authorized to proceed.

## Project overview

This repository implements a small terminal client for YouTrack. It is designed to work in both Bun and Node.js (Node >= 18.17) and exposes a single CLI entrypoint (`youtrack-cli` / `yt`) to:

- configure a YouTrack URL and token,
- list and fetch issues,
- export issues to Markdown with YAML frontmatter,
- apply Markdown back to create/update issues,
- list and fetch knowledge-base articles,
- export article content to Markdown,
- apply Markdown back to create/update articles.

The project is intentionally dependency-light and relies on the platform's built-in runtime and standard library APIs instead of adding heavy frameworks.

## Purpose and expected workflow

The typical workflow is:

1. Run `yt setup --url <youtrack-url> --token <perm-token>` to persist configuration.
2. Use `yt issues list`, `yt issues get`, and `yt kb list` to inspect remote data.
3. Export a resource to Markdown via `issues export` / `kb export`, or download a whole project with `yt project export <projectKey>` and inspect its progress with `yt project status`.
4. Edit the generated Markdown file in a text editor.
5. Reapply it with `issues apply` / `kb apply` to create or update the corresponding YouTrack entity.

This repo is built around the “Markdown as editable transport format” idea: exported records contain YAML metadata plus a plain-text body, and the importer reconstructs the correct API payload.

## Repository layout

- `src/cli.js`
  - Main command-line entrypoint.
  - Parses flags and dispatches to issue/article commands.
  - Implements export/apply flows, file writing, JSON output, and help text.
  - Also contains `sanitizeFilename()` used for safe file names.

- `src/config.js`
  - Handles config loading and saving.
  - Reads from environment variables (`YOUTRACK_URL`, `YOUTRACK_TOKEN`, `YOUTRACK_CONFIG`) and from the OS config path.
  - Normalizes base URLs and validates required config fields.

- `src/markdown.js`
  - Contains the custom YAML parser/stringifier used for Markdown frontmatter.
  - Converts between YouTrack issues/articles and Markdown documents.
  - Handles custom-field rendering and payload conversion for API updates.
  - Includes logic for extracting the first heading from Markdown body content.

- `src/youtrack.js`
  - HTTP client for the YouTrack API.
  - Defines the issue/article field selectors used in `GET` and `POST` calls.
  - Implements list/get/create/update operations for issues and articles.
  - Builds issue/article web URLs from the configured base URL.

- `src/queue.js`
  - Embedded, file-backed job queue used to schedule remote work without saturating the server.
  - Two interchangeable backends: SQLite (`bun:sqlite` / `node:sqlite`) and a pure-JS append-only journal.
  - Also implements `acquireLock()`, the single-coordinator lock for an export directory.

- `src/project-export.js`
  - Orchestrator for `yt project export`.
  - Owns the queue and every filesystem write; concurrency comes from in-process worker loops.
  - Exports `exportProject()`, the per-type `handlers`, `createPaths()` and `createStderrLogger()`.

- `scripts/link-install.js`
  - Runs during local installs to register the CLI binaries globally with `bun link` or `npm link` when appropriate.
  - Prevents linking in global installs or when the package is already linked.

- `test/platform.test.js`
  - Verifies config path behavior, Windows/Linux config home logic, filename sanitization, entrypoint detection via symlink, and the local install hook behavior.

- `test/cli-project.test.js`
  - Offline tests for the `yt project` option parsing (`projectExportOptions`, `projectStatusOptions`).

- `test/queue.test.js`, `test/youtrack.test.js`, `test/project-export.test.js`
  - Offline tests for the job queue and its lock, the throttled/retrying HTTP client (with an injected `fetchImpl`), and the export handlers.

## Runtime and configuration model

- The app is an ESM module project (`"type": "module"`).
- The package exposes two binaries:
  - `youtrack-cli`
  - `yt`
- Configuration can be stored at:
  - Linux/macOS: `~/.config/youtrack-cli/config.yaml` or `$XDG_CONFIG_HOME/youtrack-cli/config.yaml`
  - Windows: `%APPDATA%\youtrack-cli\config.yaml`
- Configuration can also be injected via environment variables instead of a file.

Important validation rules:

- `loadConfig()` merges file config + env config, with env values overriding file values.
- `requireConfig()` fails early when URL or token are missing.
- `normalizeBaseUrl()` strips trailing slash and removes search/hash fragments.

## Command surface

The CLI is organized around `yt <scope> <action>` and is defined in `src/cli.js`.

Main scopes:

- `setup`
  - `yt setup --url <url> --token <token>`

- `config`
  - `yt config`

- `issues`
  - `issues list [--query <query>] [--limit <n>] [--json]`
  - `issues get <idReadable> [--comments] [--json]`
  - `issues export <idReadable> [--dependencies] [--comments] [--out <dir>]`
  - `issues apply <file.md> [--id <idReadable>]`

- `kb`
  - `kb list [--query <query>] [--limit <n>] [--json]`
  - `kb get <article-id> [--json]`
  - `kb export <article-id> [--out <dir>]`
  - `kb apply <file.md> [--id <article-id>]`

- `project`
  - `project export <projectKey> [--out <dir>] [--concurrency <n>] [--rate <req/s>] [--no-attachments] [--no-activities] [--articles] [--since <date>] [--limit <n>] [--fresh] [--force] [--json]`
  - `project status [<projectKey>] [--out <dir>] [--json]`

Behavior notes:

- `issues export` can optionally export linked issues when `--dependencies` is enabled.
- `issues apply` and `kb apply` detect whether to create or update based on a present `id`/`idReadable` in the Markdown frontmatter or `--id` option.
- When output is not JSON, the CLI prints text formatted for terminal use.
- `project export` downloads the whole project history through the queue in `<out>/.yt-export`; rerunning it with the same `--out` resumes, and only one process may coordinate a given export directory.
- `project status` reads that queue without taking the coordinator lock.

## Markdown contract

Exported Markdown files follow a pattern similar to this:

```markdown
---
kind: issue
id: 123
idReadable: ABC-123
summary: Example
project:
  shortName: ABC
customFields:
  Priority: Major
---

# ABC-123 Example

Issue description.
```

This project uses a lightweight custom YAML parser instead of a dependency like `yaml` or `js-yaml`. Any changes to YAML serialization or deserialization should be careful, minimal, and compatibly tested.

## Implementation conventions for agents

- Keep the project dependency-free and runtime-native.
- Prefer small, focused changes aligned with the current module boundaries.
- Preserve the ESM style and existing `import` patterns.
- Follow the command-routing pattern already established in `src/cli.js` rather than introducing a new CLI framework.
- For API changes, keep payload shapes aligned with the field selectors defined in `src/youtrack.js`.
- If changing Markdown conversion behavior, validate both `issueToMarkdown` / `articleToMarkdown` and `markdownToIssuePayload` / `markdownToArticlePayload` flows.
- Treat `parseYaml` / `stringifyYaml` as critical compatibility layers; changes here can affect a lot of import/export behavior.

## Validation and testing

Use the project’s existing validation command:

```bash
npm run check
```

This runs:

- `node --check` for the main source files,
- plus the Node test suite.

If you are making changes to CLI command parsing, config path logic, Markdown import/export, or filename sanitization, the existing tests are the lowest-level safety net.

## Recommended approach for future work

When adding new features or fixing bugs:

1. identify whether the change belongs in `cli.js`, `config.js`, `markdown.js`, `youtrack.js`, `queue.js`, or `project-export.js`,
2. keep the change aligned with current command naming and output conventions,
3. add or update tests in `test/platform.test.js` when behavior is user-visible,
4. run `npm run check` before finishing.

## Short mental model

This project is a thin, opinionated adapter between local Markdown workflows and the YouTrack REST API. It is not a general-purpose web app; it is a CLI for exporting, editing, and re-importing structured issue/article data without any GUI.
