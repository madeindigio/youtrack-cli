# youtrack-cli

CLI de terminal para YouTrack compatible con Bun y Node.js. Permite leer issues, exportarlas a Markdown con dependencias, comentarios y metadatos en frontmatter YAML, importar Markdown para crear o editar issues, y leer/escribir artículos de Knowledge Base.

## Instalación local

```bash
npm link
# o
bun link
```

## Configuración

```bash
yt setup --url https://youtrack.example.com --token perm:...
```

La configuración se guarda en:

- Linux/macOS: `~/.config/youtrack-cli/config.yaml`, o `$XDG_CONFIG_HOME/youtrack-cli/config.yaml`
- Windows: `%APPDATA%\youtrack-cli\config.yaml`

También puedes usar variables de entorno:

```bash
YOUTRACK_URL=https://youtrack.example.com YOUTRACK_TOKEN=perm:... yt issues list
```

En PowerShell:

```powershell
$env:YOUTRACK_URL="https://youtrack.example.com"
$env:YOUTRACK_TOKEN="perm:..."
yt issues list
```

## Comandos principales

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

## Markdown de issues

El export genera un fichero con frontmatter YAML y cuerpo editable:

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

Descripción de la issue.
```

`yt issues apply` crea una issue si no hay `id`/`idReadable`, o edita la existente si los hay. Para crear issues nuevas desde Markdown, incluye `project.shortName` en el frontmatter.

## API

Usa la REST API JSON de YouTrack (`/api/...`) con token permanente en `Authorization: Bearer ...`.
