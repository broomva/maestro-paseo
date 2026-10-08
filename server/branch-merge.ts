// A session that ended before its run finished, whose branch merged anyway
// (BRO-2923): another session took the work to the finish (an orchestrator's
// replacement in the same worktree, or a session Maestro never tracked). The
// evidence is the branch, recorded when the work was bound, while its worktree
// still existed: its PR merged after the bind. Never inferred from a sibling
// card or from the archive alone; with no branch recorded, or no merged PR,
// the work stays blocked.

import { execFile } from "node:child_process";
import type { WorkEvent } from "./events";
import { ghRun, type Run } from "./initiatives";

/** The blocked reasons that say only the session went away, not that the work failed (engine.ts). */
export const ENDED_UNFINISHED: ReadonlySet<string> = new Set([
  "The session was archived before it finished",
  "The session ended before the run finished",
]);

/** `owner/name` from a GitHub remote (https or ssh), or null for anything else. Pure. */
export function repoOf(remote: string | null | undefined): string | null {
  const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote?.trim() ?? "");
  return match ? `${match[1]}/${match[2]}` : null;
}

/** A merged PR for a branch, as gh reports it. */
export interface MergedPr {
  number: number;
  mergedAt: string;
}

/**
 * The receipt for closing a work whose session ended unfinished but whose
 * branch merged after the work was bound; null when that is not what the
 * events and the PR say. Pure.
 */
export function branchMerged(
  events: readonly WorkEvent[],
  merged: MergedPr | null,
): { branch: string; number: number } | null {
  if (!merged) return null;
  const at = events.findLastIndex((event) => event.type === "state");
  const last = events[at];
  if (last?.type !== "state" || last.to !== "blocked" || !ENDED_UNFINISHED.has(last.reason ?? "")) return null;
  // You touched it since it stopped: yours to close, not Maestro's.
  if (events.slice(at + 1).some((event) => "actor" in event && event.actor === "human")) return null;
  const bind = events.findLast((event) => event.type === "dispatched" || event.type === "adopted");
  if ((bind?.type !== "dispatched" && bind?.type !== "adopted") || !bind.branch) return null;
  // A PR merged before this work was bound is an old one on a reused branch.
  if (!(Date.parse(merged.mergedAt) > Date.parse(bind.ts))) return null;
  return { branch: bind.branch, number: merged.number };
}

/** A worktree's branch and origin remote, read with git; nulls where git cannot say. */
export async function gitOf(cwd: string | null): Promise<{ branch: string | null; remote: string | null }> {
  if (!cwd) return { branch: null, remote: null };
  const git = (args: string[]) =>
    new Promise<string | null>((resolve) => {
      execFile("git", ["-C", cwd, ...args], { timeout: 5_000 }, (error, stdout) =>
        resolve(error ? null : stdout.trim() || null),
      );
    });
  const [branch, remote] = await Promise.all([
    git(["rev-parse", "--abbrev-ref", "HEAD"]),
    git(["remote", "get-url", "origin"]),
  ]);
  return { branch: branch === "HEAD" ? null : branch, remote };
}

/** Lookups are asked again after this long. */
export const MERGED_EVERY_MS = 10 * 60_000;

/**
 * A branch's merged PR through gh, cached per repo and branch for
 * MERGED_EVERY_MS. A branch any PR targets as its base is an integration
 * branch (dev, main), not one piece of work: its merges are promotions of
 * everyone's work, so it never counts (GetStimulus/sri has 16 merged PRs
 * whose head is dev).
 */
export function mergedPrs(run: Run = ghRun, now: () => number = Date.now) {
  const cache = new Map<string, { at: number; pr: MergedPr | null }>();
  const rows = async (args: string[]) => JSON.parse((await run(["pr", "list", ...args])) || "[]") as unknown[];
  return async (repo: string, branch: string): Promise<MergedPr | null> => {
    const key = `${repo}#${branch}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < MERGED_EVERY_MS) return hit.pr;
    const [merged, based] = await Promise.all([
      rows(["--repo", repo, "--head", branch, "--state", "merged", "--json", "number,mergedAt", "--limit", "1"]),
      rows(["--repo", repo, "--base", branch, "--state", "all", "--json", "number", "--limit", "1"]),
    ]);
    const row = merged[0] as { number?: unknown; mergedAt?: unknown } | undefined;
    const pr =
      based.length === 0 && row && typeof row.number === "number" && typeof row.mergedAt === "string"
        ? { number: row.number, mergedAt: row.mergedAt }
        : null;
    cache.set(key, { at: now(), pr });
    return pr;
  };
}
