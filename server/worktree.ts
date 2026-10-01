// Whether a run's worktree holds work that was never committed, asked before
// anything removes the worktree. Archiving a worktree deletes its files; only
// the branch survives, so uncommitted changes would be lost with it.
//
// Git is pinned to the run's own repository. The folder's `.git` is a file the
// session can rewrite: pointed at a decoy repository whose commit matches the
// folder, git that follows it reads the folder as clean, and the archive then
// deletes the work. So nothing here follows it.
//
// The repository's path is checked before git reads it. A path that passes
// through a symbolic link can be repointed at a forged repository whose own
// `worktrees/` entry names this folder and branch, so neither the path nor any
// of its parents may be a link. The real path must be the repository Paseo
// records the workspace as made from (its projectRootPath, the daemon's record
// and not the work's), and the common git dir git reports from it must lie
// inside it. Under that git dir's `worktrees/`, exactly one entry must name
// this folder's `.git` and have HEAD on the branch Maestro recorded, and its
// `commondir` must lead back to that
// same repository. Git then runs with that entry as `--git-dir` and the folder
// as `--work-tree`. The folder's own `.git` must point at that entry too: a
// worktree whose pointer was moved is not one this can vouch for. Any mismatch
// is "cannot check".
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
// Not closed: a forged repository moved into the repository's own path (a
// real folder, not a link) matches Paseo's record, which holds a path and not
// the folder itself. And the driver names are read by one git call and status is a second
// one. A process still running in the worktree that adds a driver between the
// two gets it run. Git has no switch that turns every filter off.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

/** What Maestro recorded when it started the run: the work's repository, the worktree Paseo made, its branch. */
export interface RunWorktree {
  /** The work's repository, as the contract names it. Its path is checked before git reads it; see above. */
  repo: string;
  /** The run's worktree folder. */
  cwd: string;
  /** The run's branch, `run/<hex>`. */
  branch: string;
  /** The repository Paseo records the workspace as made from (its projectRootPath); null when it has no record. */
  projectRoot: string | null;
}

/**
 * Clean or not, with a digest of everything status said (the branch's commit
 * included), so two reads can be compared. Or why it could not be checked.
 */
export type WorktreeStatus = { dirty: boolean; count: number; digest: string } | { error: string };

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

/** `scope` says which repository: `-C <repo>`, or an explicit git dir and work tree. */
function git(
  scope: readonly string[],
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...scope, ...HARDENING, ...args],
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

/** The path with every link resolved, or null when it is not there. */
const real = (path: string) => realpath(path).catch(() => null);

/** A small file's contents, or null when it cannot be read. */
const text = (path: string) => readFile(path, "utf8").catch(() => null);

/** A path git wrote into a file, resolved from the folder git counts it from (git may write it relative). */
const named = (from: string, contents: string) => resolve(from, contents.replace(/\r?\n$/, ""));

/** The first of the path and its parents that is a symbolic link, or null when none is. */
async function linkOn(path: string): Promise<string | null> {
  for (let at = path; ; at = dirname(at)) {
    if ((await lstat(at).catch(() => null))?.isSymbolicLink()) return at;
    if (dirname(at) === at) return null;
  }
}

/** How many paths a `git status --porcelain=v2 -z` listing names (a rename's second, original path is not counted). */
function countRecords(listing: string): number {
  let count = 0;
  const records = listing.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as string;
    if (record.length === 0 || record.startsWith("# ")) continue;
    count += 1;
    if (record.startsWith("2 ")) index += 1;
  }
  return count;
}

/**
 * The run's own entry under the repository's `worktrees/`, found from what was
 * recorded and never from the folder's `.git`; see the top of this file.
 */
async function pin(
  run: RunWorktree,
  timeoutMs: number,
): Promise<{ gitDir: string; workTree: string } | { error: string }> {
  const repoPath = resolve(run.repo);
  const link = await linkOn(repoPath);
  if (link) return { error: `the repository's path goes through a symbolic link: ${link}` };
  const repo = await real(repoPath);
  if (!repo) return { error: "the repository is not there" };
  if (!run.projectRoot) return { error: "Paseo has no record of the repository the workspace was made from" };
  if ((await real(run.projectRoot)) !== repo) {
    return { error: "Paseo records the workspace as made from another repository" };
  }
  const common = await git(
    ["-C", repo],
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    gitEnv(),
    timeoutMs,
  );
  if (!common.ok) return { error: `the repository cannot be read: ${common.message}` };
  const commonDir = await real(common.stdout.trim());
  const workTree = await real(run.cwd);
  if (!commonDir) return { error: "the repository's git folder is not there" };
  if (!commonDir.startsWith(`${repo}${sep}`)) return { error: "the repository's git folder is outside it" };
  if (!workTree) return { error: "the worktree folder is not there" };
  const entries: string[] = [];
  const root = join(commonDir, "worktrees");
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const entry = join(root, name);
    const gitdir = await text(join(entry, "gitdir"));
    if (gitdir === null) continue;
    const dotGit = named(entry, gitdir);
    if (basename(dotGit) === ".git" && (await real(dirname(dotGit))) === workTree) entries.push(entry);
  }
  if (entries.length === 0) return { error: "the repository has no worktree at this folder" };
  if (entries.length > 1) return { error: "the repository names this folder as more than one worktree" };
  const gitDir = await real(entries[0] as string);
  if (!gitDir) return { error: "the repository's entry for this worktree is not there" };
  if ((await text(join(gitDir, "HEAD"))) !== `ref: refs/heads/${run.branch}\n`) {
    return { error: `it is not on its branch ${run.branch}` };
  }
  const commondir = await text(join(gitDir, "commondir"));
  if (commondir === null || (await real(named(gitDir, commondir))) !== commonDir) {
    return { error: "its entry in the repository leads to another repository" };
  }
  // The folder's own pointer: a plain file (not a link, not a folder) naming that same entry.
  const dotGit = join(workTree, ".git");
  const pointer = (await lstat(dotGit).catch(() => null))?.isFile() ? await text(dotGit) : null;
  const target = pointer?.startsWith("gitdir: ") ? await real(named(workTree, pointer.slice("gitdir: ".length))) : null;
  if (target !== gitDir) return { error: "its .git does not point at its own entry in the repository" };
  return { gitDir, workTree };
}

/**
 * `git status` on the run's worktree, pinned and hardened as above: tracked
 * edits, staged changes and untracked files all count as uncommitted, and with
 * `ignored`, ignored files too (removing the worktree deletes them as well).
 * Each git call has `timeoutMs` to answer.
 */
export async function worktreeStatus(
  run: RunWorktree,
  timeoutMs = 10_000,
  { ignored = false }: { ignored?: boolean } = {},
): Promise<WorktreeStatus> {
  const pinned = await pin(run, timeoutMs);
  if ("error" in pinned) return pinned;
  const scope = ["-C", pinned.workTree, `--git-dir=${pinned.gitDir}`, `--work-tree=${pinned.workTree}`];
  const base = gitEnv();
  // `git config` reads the same config sources status will, and runs nothing. Exit 1: no driver defined.
  const drivers = await git(scope, ["config", "--null", "--name-only", "--get-regexp", "^filter\\."], base, timeoutMs);
  if (!drivers.ok && drivers.code !== 1) return { error: drivers.message };
  const env = { ...base, ...neutralDrivers(drivers.ok ? drivers.stdout : "") };
  const index = await git(scope, ["ls-files", "--stage", "-z"], env, timeoutMs);
  if (!index.ok) return { error: index.message };
  if (index.stdout.split("\0").some((entry) => entry.startsWith("160000 "))) {
    return { error: "it has submodules, which are not checked" };
  }
  // v2 with --branch: a header line per fact (the commit, the branch), then one record per change.
  const status = await git(
    scope,
    [
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
      "--untracked-files=normal",
      "--ignore-submodules=all",
      ...(ignored ? ["--ignored=traditional"] : []),
    ],
    env,
    timeoutMs,
  );
  if (!status.ok) return { error: status.message };
  const count = countRecords(status.stdout);
  const digest = createHash("sha256").update(`${pinned.gitDir}\0${status.stdout}`).digest("hex");
  return { dirty: count > 0, count, digest };
}
