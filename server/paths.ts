// Where Maestro keeps host-local state. Node built-ins only: the `maestro` CLI
// imports this, and it must run from a plugin install without dev packages.

import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** `~` and `~/x` name the home folder; anything else is returned as written. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MAESTRO_PASEO_CONFIG ?? join(homedir(), ".config", "maestro-paseo", "config.json");
}

/** The agent socket sits beside the config, so a second daemon with its own config gets its own socket. */
export function socketPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MAESTRO_PASEO_SOCKET ?? join(dirname(configPath(env)), "maestro.sock");
}

/** The loop's wake log sits beside the config too (server/wake-log.ts). */
export function wakeLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MAESTRO_PASEO_WAKE_LOG ?? join(dirname(configPath(env)), "wake-log.jsonl");
}
