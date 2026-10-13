// Maestro's git: running it, reading it, and the one fetch of an origin that every reader shares (BRO-2997).
// Reads only; what changes the answers worktree and its branch is server/answers-branch.ts.

import { execFile, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";

export const MAIN_REF = "origin/main";
export const ANSWERS_BRANCH = "maestro/answers";
/** A `git cat-file --batch` of every ledger blob takes well under a second; past this it is stuck. */
const CAT_FILE_MS = 30_000;

/** Read at each call, so a test's isolated git config holds. No prompt, no optional locks, git's own words. */
const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" });

export function git(cwd: string, args: readonly string[], timeout = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { timeout, maxBuffer: 64 * 1024 * 1024, env: gitEnv() },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`git ${args[0]}: ${gitWords(stderr || error.message)}`));
        else resolve(stdout);
      },
    );
  });
}

/**
 * What git said, in a line: the first line that names a cause (`fatal:`,
 * `error:`, a hook's `[FAIL]`), else its last line that says anything. A
 * hook's banner comes first, so the first line alone would only name the hook.
 */
export function gitWords(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^=+.*=+$/.test(line));
  // git's own cause leads (`fatal:`, `error:`); a hook's reason is often marked; else its last word.
  const cause = lines.find((line) => /^(?:fatal:|error:|\[fail\])/i.test(line));
  return cause ?? lines.at(-1) ?? "it failed with no words";
}

/** Many objects in one `git cat-file --batch`: each spec's bytes, or null when git has none. */
export function catFiles(repo: string, specs: readonly string[]): Promise<Map<string, Buffer | null>> {
  const found = new Map<string, Buffer | null>();
  if (specs.length === 0) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repo, "cat-file", "--batch"], { env: gitEnv() });
    const chunks: Buffer[] = [];
    // A git that hangs is killed, so a stalled object read never holds every later read and answer.
    const timer = setTimeout(() => child.kill("SIGKILL"), CAT_FILE_MS);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stdin.on("error", () => undefined);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) {
        reject(new Error(`git cat-file was stopped (${signal}) after ${CAT_FILE_MS / 1000} s`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`git cat-file exited ${code}`));
        return;
      }
      const out = Buffer.concat(chunks);
      let at = 0;
      for (const spec of specs) {
        const end = out.indexOf(10, at);
        if (end < 0) break;
        const header = out.subarray(at, end).toString("utf8");
        at = end + 1;
        const match = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
        if (!match) {
          found.set(spec, null);
          continue;
        }
        const size = Number(match[2]);
        found.set(spec, match[1] === "blob" ? out.subarray(at, at + size) : null);
        at += size + 1;
      }
      resolve(found);
    });
    child.stdin.end(`${specs.join("\n")}\n`);
  });
}

/** Whether `path` is a worktree of `repo`'s own (one git common dir) with maestro/answers checked out. */
export async function isAnswersWorktree(repo: string, path: string): Promise<boolean> {
  const [ours, theirs, onBranch] = await Promise.all([
    git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => ""),
    git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => ""),
    git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => ""),
  ]);
  const [oursReal, theirsReal] = await Promise.all([
    realpath(ours.trim()).catch(() => ours.trim()),
    realpath(theirs.trim()).catch(() => theirs.trim()),
  ]);
  return Boolean(oursReal) && oursReal === theirsReal && onBranch.trim() === ANSWERS_BRANCH;
}

/** A checkout's files not committed, by path. Each line is `XY path`; X may be a space, so lines are never trimmed before the cut. */
export async function uncommitted(path: string): Promise<string[]> {
  return (await git(path, ["status", "--porcelain", "--untracked-files=all"]))
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3));
}

// ── One fetch of an origin ───────────────────────────────────────────────────

/**
 * The fetch of an origin branch, once for everything that reads it. The control repo's asks and the loop ledger
 * each read origin/main and each used to fetch it on a throttle of their own, so two fetches a period fought for
 * the repo's locks. One gate holds when each (repo, branch) was last tried, when it last worked and why it last
 * failed, and joins a fetch already in flight rather than start a second.
 */
export class FetchGate {
  private readonly tried = new Map<string, number>();
  private readonly worked = new Map<string, number>();
  private readonly failed = new Map<string, string>();
  private readonly flying = new Map<string, Promise<string | null>>();

  constructor(private readonly now: () => number = Date.now) {}

  private key = (repo: string, branch: string) => `${repo}\0${branch}`;

  /** Fetches when none was tried within `everyMs`; a fetch in flight is waited on. Resolves once it settles. */
  async due(repo: string, branch: string, everyMs: number, log?: (message: string) => void): Promise<void> {
    const key = this.key(repo, branch);
    const flying = this.flying.get(key);
    if (flying) {
      await flying;
      return;
    }
    if (this.now() - (this.tried.get(key) ?? Number.NEGATIVE_INFINITY) >= everyMs) await this.run(repo, branch, log);
  }

  /** Fetches now, or joins the one in flight; resolves to why it failed, or null. */
  run(repo: string, branch: string, log?: (message: string) => void): Promise<string | null> {
    const key = this.key(repo, branch);
    const flying = this.flying.get(key);
    if (flying) return flying;
    this.tried.set(key, this.now());
    const fetching = git(repo, ["fetch", "--quiet", "origin", branch], 60_000)
      .then(() => {
        this.worked.set(key, this.now());
        this.failed.delete(key);
        return null;
      })
      .catch((error) => {
        const message = (error as Error).message;
        this.failed.set(key, message);
        log?.(`fetching origin/${branch} in ${repo}: ${message}`);
        return message;
      })
      .finally(() => {
        this.flying.delete(key);
      });
    this.flying.set(key, fetching);
    return fetching;
  }

  /** The fetch in flight, if any. */
  inFlight(repo: string, branch: string): Promise<string | null> | null {
    return this.flying.get(this.key(repo, branch)) ?? null;
  }

  /** When the last fetch worked (ms), or never. */
  lastWorked(repo: string, branch: string): number {
    return this.worked.get(this.key(repo, branch)) ?? 0;
  }

  /** When the last fetch was tried (ms), or never. */
  lastTried(repo: string, branch: string): number {
    return this.tried.get(this.key(repo, branch)) ?? 0;
  }

  /** Why the last fetch failed; null once one works. */
  lastError(repo: string, branch: string): string | null {
    return this.failed.get(this.key(repo, branch)) ?? null;
  }
}
