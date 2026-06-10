import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function isTruthy(value) {
  return /^(1|true|yes)$/i.test(String(value || ""));
}

export function shouldLinkInstall(env = process.env, cwd = process.cwd()) {
  if (isTruthy(env.npm_config_global)) return false;
  if (isAlreadyLinked(env, cwd)) return false;

  const initCwd = env.INIT_CWD;
  if (!initCwd) return true;

  return resolve(initCwd) === resolve(cwd);
}

if (isMainModule() && shouldLinkInstall()) {
  const packageManager = process.env.npm_execpath?.includes("npm") ? "npm" : "bun";
  const result = spawnSync(packageManager, ["link"], { stdio: "inherit" });

  if (result.error) {
    console.error(`Error: ${result.error.message}`);
    process.exitCode = 1;
  } else if (typeof result.status === "number") {
    process.exitCode = result.status;
  }
}

function isAlreadyLinked(env, cwd) {
  const bunInstall = env.BUN_INSTALL || join(homedir(), ".bun");
  const linkedPackageDir = resolve(bunInstall, "install/global/node_modules/youtrack-cli");
  if (!existsSync(linkedPackageDir)) return false;

  try {
    return realpathSync(linkedPackageDir) === resolve(cwd);
  } catch {
    return false;
  }
}

function isMainModule() {
  if (import.meta.main) return true;
  if (!process.argv[1]) return false;

  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return import.meta.url === `file://${process.argv[1]}`;
  }
}
