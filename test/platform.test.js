import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("configPath uses explicit YOUTRACK_CONFIG override", async () => {
  const previous = process.env.YOUTRACK_CONFIG;
  process.env.YOUTRACK_CONFIG = join("custom", "config.yaml");
  const { configPath } = await import(`../src/config.js?override=${Date.now()}`);

  assert.equal(configPath(), join("custom", "config.yaml"));

  if (previous === undefined) delete process.env.YOUTRACK_CONFIG;
  else process.env.YOUTRACK_CONFIG = previous;
});

test("configHome uses APPDATA on Windows", async () => {
  const { configHome } = await import("../src/config.js");
  assert.equal(
    configHome("win32", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "C:\\Users\\me"),
    "C:\\Users\\me\\AppData\\Roaming",
  );
});

test("configHome uses XDG config on Linux and macOS", async () => {
  const { configHome } = await import("../src/config.js");
  assert.equal(configHome("linux", { XDG_CONFIG_HOME: "/tmp/xdg-config" }, "/home/me"), "/tmp/xdg-config");
  assert.equal(configHome("darwin", {}, "/Users/me"), join("/Users/me", ".config"));
});

test("sanitizeFilename avoids Windows-invalid characters and reserved names", async () => {
  const { sanitizeFilename } = await import("../src/cli.js");

  assert.equal(sanitizeFilename("ABC:1/2*3?. "), "ABC_1_2_3");
  assert.equal(sanitizeFilename("CON"), "_CON");
  assert.equal(sanitizeFilename("   "), "youtrack-export");
});

test("cli entrypoint works through a symlinked bin", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "youtrack-cli-"));
  const binPath = join(tempDir, "yt");
  const sourcePath = join(process.cwd(), "src/cli.js");
  const { isEntrypointPath } = await import("../src/cli.js");

  try {
    await symlink(sourcePath, binPath);
    assert.equal(isEntrypointPath(binPath, pathToFileURL(sourcePath).href), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("install hook skips global installs", async () => {
  const { shouldLinkInstall } = await import("../scripts/link-install.js");

  assert.equal(shouldLinkInstall({ npm_config_global: "true", INIT_CWD: "/tmp/work" }, "/tmp/work"), false);
  assert.equal(shouldLinkInstall({ INIT_CWD: "/tmp/work" }, "/tmp/work"), true);
  assert.equal(shouldLinkInstall({ INIT_CWD: "/tmp/other" }, "/tmp/work"), false);
});
