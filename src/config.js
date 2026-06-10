import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseYaml, stringifyYaml } from "./markdown.js";

const APP_NAME = "youtrack-cli";

export function configPath() {
  if (process.env.YOUTRACK_CONFIG) return process.env.YOUTRACK_CONFIG;
  return join(configHome(), APP_NAME, "config.yaml");
}

export function configHome(platformName = platform(), env = process.env, home = homedir()) {
  if (platformName === "win32") {
    return env.APPDATA || join(home, "AppData", "Roaming");
  }
  return env.XDG_CONFIG_HOME || join(home, ".config");
}

export async function loadConfig() {
  const envConfig = {
    url: process.env.YOUTRACK_URL,
    token: process.env.YOUTRACK_TOKEN,
  };

  let fileConfig = {};
  try {
    const text = await readFile(configPath(), "utf8");
    fileConfig = parseYaml(text);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const config = {
    ...fileConfig,
    ...Object.fromEntries(Object.entries(envConfig).filter(([, value]) => value)),
  };

  if (config.url) config.url = normalizeBaseUrl(config.url);
  return config;
}

export async function saveConfig(config) {
  const target = configPath();
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, stringifyYaml({
    url: normalizeBaseUrl(config.url),
    token: config.token,
  }), { encoding: "utf8", mode: 0o600 });
  return target;
}

export function normalizeBaseUrl(url) {
  if (!url) throw new Error("Missing YouTrack URL");
  const parsed = new URL(url);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export function requireConfig(config) {
  if (!config.url) throw new Error("Missing YouTrack URL. Run: yt setup --url https://youtrack.example.com --token <token>");
  if (!config.token) throw new Error("Missing YouTrack token. Run: yt setup --url https://youtrack.example.com --token <token>");
}
