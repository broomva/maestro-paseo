// An orchestrator's child that stopped because its session ended unfinished,
// whose branch merged anyway (BRO-2923): the work landed, by that session
// before it died or by another the orchestrator sent, often one Maestro never
// tracked. The evidence is the branch, recorded when the orchestrator adopted
// the session, while its own worktree still existed: a PR from it merged after
// the adoption. The receipt claims only that.
//
// Narrow on purpose. Only work an agent adopted closes this way: work you
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
 * ended, untouched by you since the adoption, within WATCH_STUCK_MS. Pure.
 */
export function watchedBranch(events: readonly WorkEvent[], now: number): { repo: string; branch: string } | null {
  // Untouched by you since the adoption, not only since it stopped (P20 round 2).
  const at = events.findLastIndex((event) => event.type === "state");
  const last = events[at];
  if (last?.type !== "state" || last.to !== "blocked" || !ENDED_UNFINISHED.has(last.reason ?? "")) return null;
  if (!(now - Date.parse(last.ts) < WATCH_STUCK_MS)) return null;
  const bound = events.findLastIndex((event) => event.type === "dispatched" || event.type === "adopted");
  const bind = events[bound];
  if (bind?.type !== "adopted" || bind.actor !== "agent" || !bind.branch || !bind.githubRepo) return null;
  // Anything you did since the adoption (a Send back, an Unblock, a note) makes it yours to close, not Maestro's.
  if (events.slice(bound + 1).some((event) => "actor" in event && event.actor === "human")) return null;
  return { repo: bind.githubRepo, branch: bind.branch };
}

/**
 * Why a card closes when its session was archived between turns (archivedBetweenTurns). Who archived it is not
 * on record (the hook names only the session; an owner's archive, or one cascading from its parent's, reads the
 * same), so the receipt says what is: when it was archived, and whose arc it is.
 */
export const ARCHIVED_BETWEEN_TURNS =
  "Its session was archived between turns, after a turn that reported no error: an orchestrator's arc, closed, not stuck";

/**
 * Whether an orchestrator's child was archived between turns (BRO-2928): an
 * adopted arc stays running between its turns (engine.ts endTurn), so when its
 * session is archived after a turn that reported no error, the card read "archived
 * before it finished" though no turn was cut off. Maestro records it as
 * canceled, never as done: it has no evidence the work landed, and a clean
 * turn is not a finished arc (STI-2944 was archived 3.5 h after a turn whose
 * push was still in flight). Canceled says only that the arc ended. A child
 * whose branch is watched is not closed this way at all: it stays with
 * branchMerged, which closes it Done if the branch merges (engine.ts).
 *
 * As narrow as watchedBranch: an agent's adoption, untouched by you since,
 * stuck only because the session was archived (not ended, not failed), within
 * WATCH_STUCK_MS, and the last turn before the archive a completed end with no
 * turn started after it. Pure.
 */
export function archivedBetweenTurns(events: readonly WorkEvent[], now: number): boolean {
  const at = events.findLastIndex((event) => event.type === "state");
  const last = events[at];
  if (
    last?.type !== "state" ||
    last.to !== "blocked" ||
    last.reason !== "The session was archived before it finished"
  ) {
    return false;
  }
  if (!(now - Date.parse(last.ts) < WATCH_STUCK_MS)) return false;
  const bound = events.findLastIndex((event) => event.type === "dispatched" || event.type === "adopted");
  const bind = events[bound];
  if (bind?.type !== "adopted" || bind.actor !== "agent") return false;
  if (events.slice(bound + 1).some((event) => "actor" in event && event.actor === "human")) return false;
  const turn = events
    .slice(bound + 1, at)
    .findLast((event) => event.type === "turn.started" || event.type === "turn.ended");
  return turn?.type === "turn.ended" && turn.outcome === "completed";
}

/** The receipt for closing a watched card whose branch merged after its adoption; null otherwise. Pure. */
export function branchMerged(
  events: readonly WorkEvent[],
  merged: MergedPr | null,
  now: number,
): { branch: string; repo: string; number: number } | null {
  const watched = watchedBranch(events, now);
  const bind = events.findLast((event) => event.type === "adopted");
  if (!watched || !merged || !bind) return null;
  // A PR merged before this work was adopted is an old one on a reused branch.
  if (!(Date.parse(merged.mergedAt) > Date.parse(bind.ts))) return null;
  return { branch: watched.branch, repo: watched.repo, number: merged.number };
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
  // Absolute paths from git itself: a relative one is relative to the physical cwd, so a symlinked
  // subdirectory of a shared checkout would otherwise read as a separate worktree (P20 round 2).
  const [gitDir, commonDir, branch, remote] = await Promise.all([
    git(["rev-parse", "--path-format=absolute", "--git-dir"]),
    git(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(["rev-parse", "--abbrev-ref", "HEAD"]),
    git(["remote", "get-url", "origin"]),
  ]);
  // Git before 2.31 echoes an unknown --path-format back and exits 0: only two absolute single-line paths count.
  const absolute = (path: string | null): path is string => !!path && path.startsWith("/") && !path.includes("\n");
  if (!absolute(gitDir) || !absolute(commonDir) || resolve(gitDir) === resolve(commonDir)) return none;
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
        rows([
          "--repo",
          repo,
          "--head",
          branch,
          "--state",
          "merged",
          "--json",
          "number,mergedAt,isCrossRepository",
          "--limit",
          "5",
        ]),
        rows(["--repo", repo, "--base", branch, "--state", "all", "--json", "number", "--limit", "1"]),
      ]);
      // A fork's PR with the same branch name is someone else's work.
      const row = (merged as { number?: unknown; mergedAt?: unknown; isCrossRepository?: unknown }[]).find(
        (entry) => entry.isCrossRepository === false,
      );
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
    for (const [old, entry] of known) if (now() - entry.at >= WATCH_STUCK_MS) known.delete(old);
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
