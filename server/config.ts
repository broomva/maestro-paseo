// Host-local configuration: where work folders live and how runs start.
// Kept in its own JSON file so the daemon side can read it at dispatch time.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { ConfigSchema, type MaestroConfig } from "../shared/contracts";
import { configPath } from "./paths";

export { configPath };

export function defaultConfig(): MaestroConfig {
  return { workRoot: join(homedir(), "maestro"), provider: "claude", modeId: null, isolation: "worktree" };
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function normalize(config: MaestroConfig): MaestroConfig {
  const workRoot = expandHome(config.workRoot.trim());
  if (!isAbsolute(workRoot)) {
    throw new ConfigError(`The work folder must be an absolute path, got "${config.workRoot}"`);
  }
  const modeId = config.modeId?.trim() ? config.modeId.trim() : null;
  return { ...config, workRoot, provider: config.provider.trim(), modeId };
}

/**
 * A missing file means defaults. A present but unreadable file is an error the
 * UI shows: silently falling back would point runs at the wrong folder.
 */
export async function loadConfig(path = configPath()): Promise<MaestroConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`${path} is not valid JSON`);
  }
  const result = ConfigSchema.safeParse({ ...defaultConfig(), ...(parsed as object) });
  if (!result.success) {
    throw new ConfigError(`${path} has invalid settings: ${result.error.issues[0]?.message ?? "unknown"}`);
  }
  return normalize(result.data);
}

export async function saveConfig(next: MaestroConfig, path = configPath()): Promise<MaestroConfig> {
  const config = normalize(ConfigSchema.parse(next));
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(tmp, path);
  return config;
}
