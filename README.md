# youtrack-cli

Terminal CLI for YouTrack compatible with Bun and Node.js. It can list issues, export them to Markdown with dependencies, comments, and YAML frontmatter metadata, import Markdown to create or edit issues, read or write knowledge base articles, and download the full history of a project (issues, comments, activities and attachments) through an internal file-backed job queue.

## Requirements

- Bun or Node.js 18.17 or later.
- A permanent YouTrack token.

## Installation with Bun

From a local copy of the repository:

```bash
bun install
```

The `install` script runs `bun link` when you work from a local checkout, so `bun install` registers the `youtrack-cli` and `yt` binaries globally for your user. The hook is skipped for global installs from git or registry sources. If you already have the dependencies installed and only want to relink the CLI, run:

```bash
bun run install
```

You can also install the CLI directly from the repository URL with Bun:

```bash
bun install -g git+https://github.com/madeindigio/youtrack-cli.git
```

If you prefer the short GitHub reference:

```bash
bun install -g github:madeindigio/youtrack-cli
```

For private repositories or SSH access:

```bash
bun install -g git@github.com:madeindigio/youtrack-cli.git
```

After installing, verify that the command is available:

```bash
youtrack-cli --help
```

## Alternative local installation

```bash
npm link
# or
bun link
```

## Configuration

```bash
youtrack-cli setup --url https://youtrack.example.com --token perm:...
```

The configuration is saved at:

- Linux/macOS: `~/.config/youtrack-cli/config.yaml`, or `$XDG_CONFIG_HOME/youtrack-cli/config.yaml`
- Windows: `%APPDATA%\youtrack-cli\config.yaml`

You can also use environment variables:

```bash
YOUTRACK_URL=https://youtrack.example.com YOUTRACK_TOKEN=perm:... youtrack-cli issues list
```

In PowerShell:

```powershell
$env:YOUTRACK_URL="https://youtrack.example.com"
$env:YOUTRACK_TOKEN="perm:..."
youtrack-cli issues list
```

## Main commands

```bash
youtrack-cli setup --url https://youtrack.example.com --token perm:...
youtrack-cli issues list --query "project: ABC #Unresolved" --limit 20
youtrack-cli issues get ABC-123 --dependencies --comments --json
youtrack-cli issues export ABC-123 --dependencies --comments --out ./exports
youtrack-cli issues apply ./exports/ABC-123.md

youtrack-cli kb list --query "project: ABC" --limit 20
youtrack-cli kb get 12-345 --json
youtrack-cli kb export 12-345 --out ./kb
youtrack-cli kb apply ./kb/12-345.md

youtrack-cli project export ABC --out ./ABC --concurrency 4 --rate 5
youtrack-cli project status --out ./ABC
```

## Full project export

`project export` downloads the complete history of a project into a directory:

```bash
youtrack-cli project export ABC
youtrack-cli project export ABC --out ./dumps/ABC --articles --since 2024-01-01
```

It downloads, for every issue of the project:

- the raw issue payload and a Markdown rendering of it,
- the comments,
- the full activity history (every cursor page concatenated),
- the links to other issues (part of the issue payload),
- every binary attachment.

With `--articles` it also downloads the knowledge-base articles of the project.

### Output layout

```
<out>/
  export.json                     manifest: project, options, counts, timestamps
  .yt-export/
    queue.db | queue.jsonl        persistent job queue
    queue.lock                    single-coordinator lock
  issues/
    ABC-123/
      issue.md                    Markdown export
      issue.json                  raw API payload
      comments.json
      activities.json
      assets/<attachmentId>__<name>
  articles/
    <ARTICLE-ID>/article.md, article.json, assets/...
```

### Queue and resume behaviour

Every remote call is scheduled through an embedded, file-backed job queue stored
in `<out>/.yt-export`. The queue uses SQLite when the runtime provides it
(`bun:sqlite`, or `node:sqlite` on Node 22.5+) and falls back to a pure-JS
append-only journal otherwise. There is no external broker and no extra
dependency.

- Interrupting an export and rerunning it with the same `--out` **resumes** the
  same run: jobs that already finished are not repeated.
- Rerunning a *completed* export starts a new run and re-indexes the project, so
  new and updated issues are picked up. It stays cheap because attachments
  already on disk with the expected size are skipped. The run number is recorded
  in `<out>/.yt-export/run.json` and reported in `export.json`.
- Only **one process may coordinate a given export directory**. The lock file
  `<out>/.yt-export/queue.lock` records the owning pid; a second process fails
  with a clear error. A lock left behind by a dead process is detected as stale
  and taken over automatically; use `--force` to break a lock on purpose.
- `--fresh` discards the previous queue state and starts the export over.
- Interrupting the run with Ctrl-C stops the workers cleanly, releases the lock
  and leaves the queue resumable.
- Failed jobs are retried with exponential backoff. When jobs remain failed at
  the end of the run, the CLI prints them to stderr and exits with status 1.

`project status` inspects an export directory without taking the coordinator
lock, so it is safe to run while an export is in progress:

```bash
youtrack-cli project status --out ./ABC
youtrack-cli project status ABC --json
```

### Throttling flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--rate <req/s>` | `5` | Maximum outgoing requests per second (accepts fractions, e.g. `0.5`). |
| `--concurrency <n>` | `4` | Number of in-process workers consuming the queue. |
| `--limit <n>` | none | Stop after indexing this many issues. |
| `--since <date>` | none | Only issues updated since this date. |
| `--no-attachments` | off | Skip binary attachment downloads. |
| `--no-activities` | off | Skip the activity history. |
| `--articles` | off | Also export the knowledge-base articles of the project. |
| `--fresh` | off | Discard the previous queue state. |
| `--force` | off | Take over an existing coordinator lock. |
| `--json` | off | Print only the JSON summary on stdout. |

Requests are rate limited by a token bucket and retried on `429` and `5xx`
responses, honouring the `Retry-After` header, so the YouTrack server is never
saturated.

## Issue Markdown

The export generates a file with YAML frontmatter and an editable body:

```markdown
---
kind: issue
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

`youtrack-cli issues apply` creates an issue if there is no `id`/`idReadable`, or edits the existing one if present. To create new issues from Markdown, include `project.shortName` in the frontmatter.

## API

Use YouTrack's JSON REST API (`/api/...`) with a permanent token in `Authorization: Bearer ...`.
