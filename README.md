# youtrack-cli

Terminal CLI for YouTrack compatible with Bun and Node.js. It can list issues, export them to Markdown with dependencies, comments, and YAML frontmatter metadata, import Markdown to create or edit issues, and read or write knowledge base articles.

## Requirements

- Bun or Node.js 18.17 or later.
- A permanent YouTrack token.

## Installation with Bun

From a local copy of the repository:

```bash
bun install
```

The `install` script runs `bun link`, so `bun install` registers the `yt` and `youtrack-cli` binaries globally for your user. If you already have the dependencies installed and only want to relink the CLI, run:

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
yt --help
```

## Alternative local installation

```bash
npm link
# or
bun link
```

## Configuration

```bash
yt setup --url https://youtrack.example.com --token perm:...
```

The configuration is saved at:

- Linux/macOS: `~/.config/youtrack-cli/config.yaml`, or `$XDG_CONFIG_HOME/youtrack-cli/config.yaml`
- Windows: `%APPDATA%\youtrack-cli\config.yaml`

You can also use environment variables:

```bash
YOUTRACK_URL=https://youtrack.example.com YOUTRACK_TOKEN=perm:... yt issues list
```

In PowerShell:

```powershell
$env:YOUTRACK_URL="https://youtrack.example.com"
$env:YOUTRACK_TOKEN="perm:..."
yt issues list
```

## Main commands

```bash
yt setup --url https://youtrack.example.com --token perm:...
yt issues list --query "project: ABC #Unresolved" --limit 20
yt issues get ABC-123 --dependencies --comments --json
yt issues export ABC-123 --dependencies --comments --out ./exports
yt issues apply ./exports/ABC-123.md

yt kb list --query "project: ABC" --limit 20
yt kb get 12-345 --json
yt kb export 12-345 --out ./kb
yt kb apply ./kb/12-345.md
```

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

`yt issues apply` creates an issue if there is no `id`/`idReadable`, or edits the existing one if present. To create new issues from Markdown, include `project.shortName` in the frontmatter.

## API

Use YouTrack's JSON REST API (`/api/...`) with a permanent token in `Authorization: Bearer ...`.
