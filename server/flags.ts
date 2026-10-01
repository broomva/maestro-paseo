// The loop's flags: how a wake puts work in Needs you when it is not at your
// gate or stuck. Three kinds, each raised by a wake (server/loop.ts):
//   yours   queued work the loop leaves to you (prompt-free, or a mode you chose);
//   failed  a start the loop tried that failed;
//   quiet   running work with nothing new for QUIET_MS, by Maestro's events and
//           by its session's own activity: Maestro sees only turn boundaries, so
//           a long turn that is still working is not quiet (server/loop.ts).
// A flag is one `loop.flagged` event, never a state change. It stands until
// anything else happens to the work (server/events.ts flagOf), and the loop
// writes one only when the work's current flag is not already of that kind,
// so a wake every minute adds nothing. Notifications go through Maestro and
// Paseo (Needs you, the header count, the item), never a desktop channel. Pure.

import type { Flag, FlagKind, MaestroConfig, NextRun } from "../shared/contracts";
import { isDispatchable, type OrchState } from "../shared/states";
import { flagOf, lastActivityOf, type WorkEvent } from "./events";
import { leftToYou, MODED_BY_YOU, nextRun, PROMPT_FREE } from "./runs";
import type { StoredWork } from "./store";

/** Running work with nothing new for this long is flagged as worth a look. */
export const QUIET_MS = 30 * 60_000;

export const minutesWords = (count: number) => (count === 1 ? "1 minute" : `${count} minutes`);

/** A reason as the end of a sentence: a full stop unless it already ends in one. */
export const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** Why work is yours to start, in the words that follow "Start it yourself:". */
const WHY_YOURS: Record<string, string> = {
  [PROMPT_FREE]: "it runs without permission prompts",
  [MODED_BY_YOU]: "it runs in a mode you chose",
};

/** The `yours` reason, from what leftToYou said. */
export function yoursReason(left: string): string {
  return `Start it yourself: ${sentence(WHY_YOURS[left] ?? left)}`;
}

/** The `failed` reason, from the dispatch error; dispatch's own "Could not start the run:" is not said twice. */
export function failedReason(message: string): string {
  return `Could not start: ${sentence(message.replace(/^Could not start the run:\s*/, ""))}`;
}

/** The `quiet` reason, for running work with nothing new for `ms`. */
export function quietReason(ms: number): string {
  return `Quiet for ${minutesWords(Math.floor(ms / 60_000))}, worth a look.`;
}

/** How long since something last happened to the work: the loop's own flags do not count. */
export function quietFor(events: readonly WorkEvent[], now: number, fallback: string): number {
  return now - Date.parse(lastActivityOf(events)?.ts ?? fallback);
}

/**
 * When a session last did anything, from the daemon's snapshot of it, or
 * null when it does not say. Paseo's app calls this lastActivityAt
 * (PluginAgentSnapshot); the daemon fills it from the agent's updatedAt, which
 * it moves on every timeline item, turn start and permission, and a plugin's
 * agents.ref(id).refresh() returns that as `updatedAt`. A snapshot that names
 * lastActivityAt is read first.
 */
export function sessionActiveAt(agent: { updatedAt?: unknown; lastActivityAt?: unknown }): number | null {
  for (const value of [agent.lastActivityAt, agent.updatedAt]) {
    const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(at)) return at;
  }
  return null;
}

/**
 * Whether the reason for a flag of this kind stands on the work as its files
 * are now: queued work for `yours` (still left to you) and `failed`, running
 * work quiet for QUIET_MS for `quiet`. The loop checks it under the work's
 * lock before it writes, so a flag never lands on work that moved meanwhile.
 */
export function flagStands(kind: FlagKind, item: StoredWork, now: number, config: MaestroConfig): boolean {
  const state = item.contract.state;
  switch (kind) {
    case "yours":
      return isDispatchable(state) && leftToYou(nextRun(config, item)) !== null;
    case "failed":
      return isDispatchable(state);
    case "quiet":
      return state === "running" && quietFor(item.events, now, item.mtime) >= QUIET_MS;
  }
}

/**
 * The flag as the surfaces show it, or null. The current flag (flagOf), as
 * long as the work is still in the state it was raised for. Two reasons are
 * read live: `yours` from how the next run would start now, so a Settings
 * change that hands the work back to the loop takes the flag down, and
 * `quiet` from the clock, counted from the flag's `since` (Maestro's events
 * or the session's activity, whichever was later when the loop looked).
 */
export function flagNow(
  events: readonly WorkEvent[],
  state: OrchState,
  next: NextRun,
  now: number,
  fallback: string,
): Flag | null {
  const flag = flagOf(events);
  if (!flag) return null;
  const at = flag.ts;
  switch (flag.kind) {
    case "yours": {
      const left = isDispatchable(state) ? leftToYou(next) : null;
      return left ? { kind: flag.kind, reason: yoursReason(left), at } : null;
    }
    case "failed":
      return isDispatchable(state) ? { kind: flag.kind, reason: flag.reason, at } : null;
    case "quiet": {
      if (state !== "running") return null;
      // Counted from when the run last did anything as the loop measured it, its session's activity included.
      const since = flag.since ? Date.parse(flag.since) : Number.NaN;
      const quiet = Number.isFinite(since) ? now - since : quietFor(events, now, fallback);
      return { kind: flag.kind, reason: quietReason(quiet), at };
    }
  }
}
