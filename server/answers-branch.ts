// The one writer of Maestro's answers worktree and its branch, maestro/answers (BRO-2997): making the worktree and
// bringing it up to origin/main, committing an answer, merging, resetting level with main, and pushing. The answer
// itself is a ledger edit (server/control-asks.ts) and the landing step decides when to merge or push
// (server/answers-landing.ts); neither runs a git command that changes the worktree or the branch. Every change here
// runs under one lock, in this process and in a second daemon on the same worktree, where it used to be serialized
// in memory only.

import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { DecisionAsk } from "../shared/fleet";
import { LEDGER, parsed } from "./control-asks";
import { UserError } from "./engine";
import { ANSWERS_BRANCH, catFiles, git, isAnswersWorktree, MAIN_REF, uncommitted } from "./git";
import { withFileLock } from "./locks";
import { ASKS_DIR, lockRootBeside } from "./paths";

export interface AnswersBranchOptions {
  /** The control repo. */
  repo: string;
  /** The answers worktree. */
  path: string;
  log?: (message: string) => void;
}

/** A branch held up this long by another writer is a refusal, not a wait. */
const BRANCH_LOCK_WAIT_MS = 120_000;

export class AnswersBranch {
  constructor(private readonly options: AnswersBranchOptions) {}

  /** Runs `run` as the only writer of the branch: queued behind this process's own, then the worktree's file lock. */
  exclusive<T>(run: () => Promise<T>): Promise<T> {
    const { path } = this.options;
    return withFileLock(path, lockRootBeside(path), run, {
      waitMs: BRANCH_LOCK_WAIT_MS,
      what: "Maestro's answers worktree",
    });
  }

  /**
   * Maestro's answers worktree on maestro/answers, made the first time it is
   * needed (from origin/main, or from the branch when it is there already) and
   * brought up to origin/main before each answer, by a merge that never
   * rewrites what the branch holds. A worktree that is not this repo's on that
   * branch, or a merge that conflicts, is refused.
   */
  async worktree(): Promise<string> {
    const repo = this.options.repo;
    const path = this.options.path;
    const mainSha = (
      await git(repo, ["rev-parse", "--verify", "--quiet", `${MAIN_REF}^{commit}`]).catch(() => "")
    ).trim();
    if (!mainSha) throw new UserError(`${repo} has no ${MAIN_REF}, so an answer for it has nowhere to go.`);
    if (!(await lstat(path).catch(() => null))) {
      const branch = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${ANSWERS_BRANCH}`]).catch(
        () => "",
      );
      const args = branch.trim()
        ? ["worktree", "add", "--quiet", path, ANSWERS_BRANCH]
        : ["worktree", "add", "--quiet", "--no-track", "-b", ANSWERS_BRANCH, path, mainSha];
      await git(repo, args, 60_000).catch(async (error) => {
        // The branch still registered at a worktree whose folder is gone (a cleared state dir): that registration
        // is dead, so git's own prune clears it, and the worktree is made again. One checked out anywhere live is refused.
        const holder = await this.holder();
        if (holder && !(await lstat(holder).catch(() => null))) {
          await git(repo, ["worktree", "prune"]);
          await git(repo, args, 60_000).catch((again) => {
            throw new UserError(`Maestro's answers worktree could not be made at ${path}: ${(again as Error).message}`);
          });
          return;
        }
        throw new UserError(
          holder
            ? `${ANSWERS_BRANCH} is checked out at ${holder}, not at Maestro's answers worktree ${path}, so no answer was written. Remove that worktree, or point MAESTRO_PASEO_CONTROL_ANSWERS at it.`
            : `Maestro's answers worktree could not be made at ${path}: ${(error as Error).message}`,
        );
      });
    }
    if (!(await isAnswersWorktree(repo, path))) {
      throw new UserError(
        `${path} is not ${repo}'s answers worktree on ${ANSWERS_BRANCH}, so no answer was written there.`,
      );
    }
    // Anything uncommitted there (an earlier answer whose commit failed, a hand edit) is never swept into this answer's commit.
    const dirty = await uncommitted(path);
    if (dirty.length > 0) {
      throw new UserError(
        `Maestro's answers worktree has changes not committed (${dirty.join(", ")}), so no answer was written. Commit or discard them in ${path} first.`,
      );
    }
    const current = await git(path, ["merge-base", "--is-ancestor", mainSha, "HEAD"]).then(
      () => true,
      () => false,
    );
    if (!current) {
      const conflicted = await mergeInto(path, mainSha, `Merge ${MAIN_REF} into ${ANSWERS_BRANCH}`);
      if (conflicted) {
        const where = conflicted.length > 0 ? ` (it conflicts in ${conflicted.join(", ")})` : "";
        throw new UserError(
          `${ANSWERS_BRANCH} could not take ${MAIN_REF}'s latest${where}. No answer was written, and no answer whose home is ${MAIN_REF} is, until that is settled by hand in ${path}.`,
        );
      }
    }
    return path;
  }

  /** Where git has maestro/answers checked out, by its listing (a worktree whose folder is gone included), or null. */
  private async holder(): Promise<string | null> {
    const listing = await git(this.options.repo, ["worktree", "list", "--porcelain"]).catch(() => "");
    const block = listing
      .split(/\n\n+/)
      .find((entry) => entry.split("\n").includes(`branch refs/heads/${ANSWERS_BRANCH}`));
    return (
      block
        ?.split("\n")
        .find((line) => line.startsWith("worktree "))
        ?.slice("worktree ".length) ?? null
    );
  }

  /**
   * Commits this answer's ledger, and only it, on maestro/answers. A commit
   * that fails (a hook refusing it, say) is said; the answer stays in the file,
   * and the next answer is refused until the worktree is clean again.
   */
  async commit(answers: string, ledger: string, ask: DecisionAsk): Promise<string | null> {
    const file = join(ASKS_DIR, ledger);
    try {
      const message = `answer(${ledger}): ${ask.id}${ask.answerOption ? ` -> ${ask.answerOption}` : ""}\n\nAnswered-by: owner:maestro`;
      await git(answers, ["commit", "--quiet", "-m", message, "--", file], 120_000);
      return null;
    } catch (error) {
      const message = `Your answer is in the answers worktree, but its commit on ${ANSWERS_BRANCH} failed (${(error as Error).message}). Maestro writes no other answer there until ${file} is committed or discarded in ${answers}.`;
      this.options.log?.(`asks: ${message}`);
      return message;
    }
  }

  /** Merges `rev` into the worktree (mergeInto), the branch unchanged when it conflicts. */
  merge(rev: string, message: string): Promise<string[] | null> {
    return mergeInto(this.options.path, rev, message);
  }

  /** Brings the branch level with `sha`, dropping what it held: only when it holds nothing main does not. */
  async resetTo(sha: string): Promise<void> {
    await git(this.options.path, ["reset", "--quiet", "--hard", sha]);
  }

  /** Takes origin's batch into the worktree's object store, so it can be merged. */
  async fetchRemote(): Promise<void> {
    await git(this.options.path, ["fetch", "--quiet", "origin", `refs/heads/${ANSWERS_BRANCH}`], 60_000);
  }

  /** Origin's maestro/answers as it is now, or null when origin has none. */
  async remoteHead(): Promise<string | null> {
    const listed = await git(this.options.path, ["ls-remote", "origin", `refs/heads/${ANSWERS_BRANCH}`], 60_000);
    return listed.split(/\s/)[0] || null;
  }

  /**
   * The branch pushed to origin, when origin's differs. Never forced: origin's
   * batch was merged in first, so this is a fast-forward, and git refuses any
   * other (one pushed meanwhile waits for the next wake to merge it).
   */
  async push(): Promise<void> {
    const path = this.options.path;
    const [head, remote] = await Promise.all([git(path, ["rev-parse", "HEAD"]), this.remoteHead()]);
    if (remote === head.trim()) return;
    await git(path, ["push", "--quiet", "origin", `HEAD:refs/heads/${ANSWERS_BRANCH}`], 180_000);
  }
}

/**
 * Merges `rev` into the checkout at `path`, never resolving anything: a merge
 * that conflicts is aborted, and one git made cleanly whose ledgers no longer
 * read (both sides answered one entry: two `answer` keys) is undone. Either
 * way the checkout is as it was, and the files are named (repo-relative); null when merged.
 */
export async function mergeInto(path: string, rev: string, message: string): Promise<string[] | null> {
  const before = (await git(path, ["rev-parse", "HEAD"])).trim();
  const clean = await git(path, ["merge", "--quiet", "--no-edit", "-m", message, rev], 60_000).then(
    () => true,
    () => false,
  );
  if (!clean) {
    const files = (await git(path, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ""))
      .split("\n")
      .filter(Boolean);
    await git(path, ["merge", "--abort"]).catch(() => undefined);
    return files;
  }
  const merged = (await git(path, ["diff", "--name-only", before, "HEAD", "--", `${ASKS_DIR}/`]))
    .split("\n")
    .filter(Boolean);
  const blobs = await catFiles(
    path,
    merged.map((file) => `HEAD:${file}`),
  );
  const unreadable = merged.filter((file) => {
    const bytes = blobs.get(`HEAD:${file}`);
    if (!bytes || !LEDGER.test(file.split("/").pop() ?? "")) return false;
    try {
      parsed(bytes.toString("utf8"));
      return false;
    } catch {
      return true;
    }
  });
  if (unreadable.length === 0) return null;
  await git(path, ["reset", "--quiet", "--hard", before]);
  return unreadable;
}
