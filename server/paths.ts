// Where Maestro keeps host-local state. Node built-ins only: the `maestro` CLI
// imports this, and it must run from a plugin install without dev packages.

import { homedir, tmpdir } from "node:os";
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

/**
 * fleet-reconcile's files, which the Fleet view reads (server/fleet.ts): its
 * config (the fleet's own FLEET_CONFIG, else ~/.config/ctx/fleet.json), where
 * its state dirs live, and the LaunchAgents that run its ticks.
 */
export function fleetPaths(env: NodeJS.ProcessEnv = process.env): {
  config: string;
  stateRoot: string;
  agents: string;
} {
  return {
    config: env.MAESTRO_PASEO_FLEET_CONFIG ?? env.FLEET_CONFIG ?? join(homedir(), ".config", "ctx", "fleet.json"),
    stateRoot: env.MAESTRO_PASEO_FLEET_STATE ?? join(homedir(), ".local", "state", "fleet-reconcile"),
    agents: env.MAESTRO_PASEO_FLEET_AGENTS ?? join(homedir(), "Library", "LaunchAgents"),
  };
}

/**
 * Under `bun test` (NODE_ENV=test), a test that names no control repo or
 * receipts gets none of the owner's: the loop lands and routes answers
 * (BRO-2827), and a test that booted the plugin once reached ~/broomva's
 * answers worktree and receipts. A test names its own, or gets these.
 */
const underTest = (env: NodeJS.ProcessEnv) => env.NODE_ENV === "test";

/**
 * Where a ledger answer takes its lock and leaves its receipt (the control
 * interface spec §5.5): the lock directory every ledger writer shares, and
 * Maestro's receipts of the answers it wrote.
 */
export function controlAskPaths(env: NodeJS.ProcessEnv = process.env): { locks: string; receipts: string } {
  if (underTest(env)) {
    const scratch = join(tmpdir(), `maestro-test-asks-${process.pid}`);
    return {
      locks: env.MAESTRO_PASEO_ASK_LOCKS ?? join(scratch, "locks"),
      receipts: env.MAESTRO_PASEO_ASK_RECEIPTS ?? join(scratch, "asks.jsonl"),
    };
  }
  return {
    locks: env.MAESTRO_PASEO_ASK_LOCKS ?? join(homedir(), ".local", "state", "control-asks", "locks"),
    receipts: env.MAESTRO_PASEO_ASK_RECEIPTS ?? join(homedir(), ".local", "state", "maestro-paseo", "asks.jsonl"),
  };
}

/**
 * The workspace's control repo, whose `.control/asks` ledgers Decisions reads
 * at their homes (server/control-home.ts; the spec's `controlRepo`, ~/broomva
 * by default), and Maestro's answers worktree, where an answer whose home is
 * origin/main is written, on maestro/answers. `off` reads no control repo.
 */
export function controlRepoPaths(env: NodeJS.ProcessEnv = process.env): { repo: string | null; answers: string } {
  const repo = env.MAESTRO_PASEO_CONTROL_REPO ?? (underTest(env) ? "off" : join(homedir(), "broomva"));
  return {
    repo: repo === "off" ? null : expandHome(repo),
    answers: expandHome(
      env.MAESTRO_PASEO_CONTROL_ANSWERS ??
        (underTest(env)
          ? join(tmpdir(), `maestro-test-asks-${process.pid}`, "control-answers")
          : join(homedir(), ".local", "state", "maestro-paseo", "control-answers")),
    ),
  };
}

/**
 * Where the Paseo daemon keeps its schedules and heartbeats, which the
 * Timeline view reads (server/timeline.ts): `schedules/` in its home, the
 * daemon's PASEO_HOME, else ~/.paseo.
 */
export function paseoSchedulesDir(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.MAESTRO_PASEO_SCHEDULES ??
    join(env.PASEO_HOME ? expandHome(env.PASEO_HOME) : join(homedir(), ".paseo"), "schedules")
  );
}

/** A launchd label prefix: it can reach a log predicate or a launchctl target only as a name. */
export const LABEL_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The launchd jobs the Timeline view reads: those whose label starts with
 * this, `com.broomva.` unless MAESTRO_PASEO_LAUNCHD names another prefix;
 * `off` reads none (null), as on a host without launchd.
 */
export function launchdPrefix(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string | null {
  const chosen = env.MAESTRO_PASEO_LAUNCHD?.trim();
  if (chosen === "off" || platform !== "darwin") return null;
  // A label prefix only: anything else could reach the log predicate, so it reads none rather than a guess.
  if (chosen && !LABEL_PREFIX.test(chosen)) return null;
  return chosen || "com.broomva.";
}
