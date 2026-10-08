// An orchestrator's child that stopped because its session ended unfinished,
// whose branch merged anyway (BRO-2923): the orchestrator finished that work
// with another session, often one Maestro never tracked. The evidence is the
// branch, recorded when the orchestrator adopted the session, while its own
// worktree still existed: a PR from it merged after the adoption.
//
// Narrow on purpose. Only work an agent adopted closes this way, as only its
// landings are the orchestrator's to read (events.ts adopterClosed): work you
// adopted or dispatched is gated by you and stays Stuck. A branch is recorded
// only for a separate worktree, never a shared checkout whose branch belongs to
// whoever switched it last. A branch any PR targets as its base (dev, main) is
// an integration branch, never one piece of work. With no branch recorded, no
// merged PR, or a merge before the adoption, the work stays Stuck.

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import type { WorkEvent } from "./events";
import { ghRun, type Run } from "./initiatives";

/** The blocked reasons that say only the session went away, not that the work failed (engine.ts). */
export const ENDED_UNFINISHED: ReadonlySet<string> = new Set([
  "The session was archived before it finished",
  "The session ended before the run finished",
]);

/** A Stuck card is looked at this long after it stopped, and no longer. */
export const WATCH_STUCK_MS = 7 * 24 * 60 * 60_000;

/** `owner/name` from a GitHub remote (https or ssh), or null for anything else. Pure. */
export function repoOf(remote: string | null | undefined): string | null {
  const match =
    /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
      remote?.trim() ?? "",
    );
  return match ? `${match[1]}/${match[2]}` : null;
}

/** A merged PR for a branch, as gh reports it. */
export interface MergedPr {
  number: number;
  mergedAt: string;
}

/**
 * Whether to look a Stuck card's branch up at all, at `now`: an agent's
 * adoption with a branch and a GitHub repo, stopped only because its session
 * ended, untouched by you since, within WATCH_STUCK_MS. Pure.
 */
export function watchedBranch(events: readonly WorkEvent[], now: number): { repo: string; branch: string } | null {
  const at = events.findLastIndex((event) => event.type === "state");
  const last = events[at];
  if (last?.type !== "state" || last.to !== "blocked" || !ENDED_UNFINISHED.has(last.reason ?? "")) return null;
  if (!(now - Date.parse(last.ts) < WATCH_STUCK_MS)) return null;
  // You touched it since it stopped: yours to close, not Maestro's.
  if (events.slice(at + 1).some((event) => "actor" in event && event.actor === "human")) return null;
  const bind = events.findLast((event) => event.type === "dispatched" || event.type === "adopted");
  if (bind?.type !== "adopted" || bind.actor !== "agent" || !bind.branch || !bind.githubRepo) return null;
  return { repo: bind.githubRepo, branch: bind.branch };
}

/** The receipt for closing a watched card whose branch merged after its adoption; null otherwise. Pure. */
export function branchMerged(
  events: readonly WorkEvent[],
  merged: MergedPr | null,
  now: number,
): { branch: string; number: number } | null {
  const watched = watchedBranch(events, now);
  const bind = events.findLast((event) => event.type === "adopted");
  if (!watched || !merged || !bind) return null;
  // A PR merged before this work was adopted is an old one on a reused branch.
  if (!(Date.parse(merged.mergedAt) > Date.parse(bind.ts))) return null;
  return { branch: watched.branch, number: merged.number };
}

/**
 * A worktree's branch and GitHub repo (`owner/name`, never the raw remote,
 * which can carry a token), read with git. Null for a shared checkout (its
 * git dir is the common one), a detached HEAD, or a folder git cannot read.
 */
export async function gitOf(cwd: string | null): Promise<{ branch: string | null; githubRepo: string | null }> {
  const none = { branch: null, githubRepo: null };
  if (!cwd) return none;
  const git = (args: string[]) =>
    new Promise<string | null>((done) => {
      execFile("git", ["-C", cwd, ...args], { timeout: 5_000 }, (error, stdout) =>
        done(error ? null : stdout.trim() || null),
      );
    });
  const [gitDir, commonDir, branch, remote] = await Promise.all([
    git(["rev-parse", "--git-dir"]),
    git(["rev-parse", "--git-common-dir"]),
    git(["rev-parse", "--abbrev-ref", "HEAD"]),
    git(["remote", "get-url", "origin"]),
  ]);
  if (!gitDir || !commonDir || resolve(cwd, gitDir) === resolve(cwd, commonDir)) return none;
  return { branch: branch && branch !== "HEAD" ? branch : null, githubRepo: repoOf(remote) };
}

/** Lookups are asked again after this long, failures included. */
export const MERGED_EVERY_MS = 10 * 60_000;

/**
 * A branch's merged PR through gh, without ever waiting on gh: it answers
 * what it knows now (null at first) and asks gh in the background, at most
 * once per repo and branch per MERGED_EVERY_MS, failures included. A branch
 * any PR targets as its base is an integration branch (GetStimulus/sri has 16
 * merged PRs whose head is dev) and never counts.
 */
export function mergedPrs(run: Run = ghRun, now: () => number = Date.now, log?: (message: string) => void) {
  const known = new Map<string, { at: number; pr: MergedPr | null }>();
  const asking = new Map<string, Promise<void>>();
  const rows = async (args: string[]) => JSON.parse((await run(["pr", "list", ...args])) || "[]") as unknown[];
  const ask = async (key: string, repo: string, branch: string) => {
    let pr: MergedPr | null = null;
    try {
      const [merged, based] = await Promise.all([
        rows(["--repo", repo, "--head", branch, "--state", "merged", "--json", "number,mergedAt", "--limit", "1"]),
        rows(["--repo", repo, "--base", branch, "--state", "all", "--json", "number", "--limit", "1"]),
      ]);
      const row = merged[0] as { number?: unknown; mergedAt?: unknown } | undefined;
      if (based.length === 0 && row && typeof row.number === "number" && typeof row.mergedAt === "string") {
        pr = { number: row.number, mergedAt: row.mergedAt };
      }
    } catch (error) {
      log?.(`reading ${repo} for ${branch}: ${(error as Error).message}`);
    }
    known.set(key, { at: now(), pr });
  };
  const lookup = async (repo: string, branch: string): Promise<MergedPr | null> => {
    const key = `${repo}#${branch}`;
    const hit = known.get(key);
    if ((!hit || now() - hit.at >= MERGED_EVERY_MS) && !asking.has(key)) {
      asking.set(
        key,
        ask(key, repo, branch).finally(() => asking.delete(key)),
      );
    }
    return hit?.pr ?? null;
  };
  /** For a test: waits for the lookups in flight. */
  lookup.settled = async (): Promise<void> => {
    await Promise.all(asking.values());
  };
  return lookup;
}
