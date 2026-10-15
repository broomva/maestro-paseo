// Host-local configuration: where work folders live, how runs start, how many
// run at once, what an approval cleans up, and how often the loop wakes. Kept
// in its own JSON file so the daemon side can read it at dispatch time. A
// setting missing from the file takes its default, so a file written before
// the setting existed still loads.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ConfigSchema, type MaestroConfig } from "../shared/contracts";
import { DEFAULT_TIER_LADDER } from "../shared/tiers";
import { writeFileAtomic } from "./atomic";
import { configPath, expandHome } from "./paths";

export { configPath, expandHome };

export function defaultConfig(): MaestroConfig {
  return {
    workRoot: join(homedir(), "maestro"),
    provider: "claude",
    modeId: null,
    isolation: "worktree",
    concurrencyCap: 3,
    archiveOnApprove: false,
    defaultGate: "human",
    loopMinutes: null,
    tierLadder: structuredClone(DEFAULT_TIER_LADDER),
  };
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
  await writeFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}
