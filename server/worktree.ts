// Whether a run's worktree holds work that was never committed, asked before
// anything removes the worktree. Archiving a worktree deletes its files; only
// the branch survives, so uncommitted changes would be lost with it.
//
// The worktree is the session's: anything in it, the repository's own config
// and attributes included, may have been written by the agent, and git runs
// commands that config names, as the daemon's user. So git runs here with each
// of them off, and with an environment that carries nothing of the daemon's:
//   - core.fsmonitor: a command `git status` runs on every call. Measured live.
//   - filter drivers: .gitattributes names a driver, the config says what it
//     runs, and `git status` runs its clean command on any tracked file whose
//     stat changed. Measured live. The driver name is the repository's choice,
//     so every driver the config defines is emptied by name.
//   - hooks: `git status` runs post-index-change when it rewrites the index.
//     Measured live. GIT_OPTIONAL_LOCKS=0 keeps it from writing the index, and
//     core.hooksPath points at nothing; either one alone stops the hook.
//   - diff.external, core.pager: `git status --porcelain` runs neither today;
//     they are off so a git that starts to cannot.
//   - submodules are repositories of their own, with config this never reads:
//     status does not enter them, and a worktree that has any is kept.
// Any failure, timeout included, is "cannot check", and the caller keeps the worktree.
//
// Not closed: the driver names are read by one git call and status is a second
// one. A process still running in the worktree that adds a driver between the
// two gets it run. Git has no switch that turns every filter off.

import { execFile } from "node:child_process";

export type WorktreeStatus = { dirty: boolean } | { error: string };

/** Turns off each command a repository's config could make these git calls run. */
export const HARDENING: readonly string[] = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "diff.external=",
  "-c",
  "core.pager=cat",
];

/** Only what git needs: no inherited secrets or git variables, and no system or user config. */
export function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: "/nonexistent",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
  };
}

type GitResult = { ok: true; stdout: string } | { ok: false; code: number | null; message: string };

function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...HARDENING, ...args],
      { env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, stdout });
          return;
        }
        const message = error.killed
          ? `git did not answer within ${Math.round(timeoutMs / 100) / 10}s`
          : String(stderr || error.message)
              .trim()
              .split("\n")[0] || "git failed";
        resolve({ ok: false, code: typeof error.code === "number" ? error.code : null, message });
      },
    );
  });
}

/** Config that empties every filter driver the repository defines, as GIT_CONFIG_* variables (no quoting to get wrong). */
function neutralDrivers(listing: string): NodeJS.ProcessEnv {
  const names = new Set<string>();
  for (const key of listing.split("\0")) {
    const dot = key.lastIndexOf(".");
    if (key.startsWith("filter.") && dot > "filter.".length) names.add(key.slice("filter.".length, dot));
  }
  const pairs = [...names].flatMap((name) => [
    [`filter.${name}.clean`, ""],
    [`filter.${name}.smudge`, ""],
    [`filter.${name}.process`, ""],
    [`filter.${name}.required`, "false"],
  ]);
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/**
 * `git status --porcelain` in `cwd`, hardened as above: tracked edits, staged
 * changes and untracked files all count as uncommitted. Each git call has
 * `timeoutMs` to answer.
 */
export async function worktreeStatus(cwd: string, timeoutMs = 10_000): Promise<WorktreeStatus> {
  const base = gitEnv();
  // `git config` reads the same config sources status will, and runs nothing. Exit 1: no driver defined.
  const drivers = await git(cwd, ["config", "--null", "--name-only", "--get-regexp", "^filter\\."], base, timeoutMs);
  if (!drivers.ok && drivers.code !== 1) return { error: drivers.message };
  const env = { ...base, ...neutralDrivers(drivers.ok ? drivers.stdout : "") };
  const index = await git(cwd, ["ls-files", "--stage", "-z"], env, timeoutMs);
  if (!index.ok) return { error: index.message };
  if (index.stdout.split("\0").some((entry) => entry.startsWith("160000 "))) {
    return { error: "it has submodules, which are not checked" };
  }
  const status = await git(
    cwd,
    ["status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=all"],
    env,
    timeoutMs,
  );
  if (!status.ok) return { error: status.message };
  return { dirty: status.stdout.trim().length > 0 };
}
