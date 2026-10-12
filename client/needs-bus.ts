// One snapshot of needs.list for every surface in this client (BRO-3001). The
// screens read it through React Query (client/hooks.ts useNeeds); the header
// button in every workspace reads it outside React (client/integrations.ts).
// Whichever reads it tells the other, so the header never says an older number
// than the screen: an answer given in Decisions moves the header at once, and a
// read the header made fills an open screen. And what about a session moves a
// count: watchSessions turns Paseo's agent events into one refetch per burst.
// No React here, so each rule is tested.

import type { PaseoAgentUpdate } from "@getpaseo/client";
import type { Needs } from "../shared/needs";

/** Who read the snapshot: a Maestro screen, or the header button's own refresh. */
export type NeedsFrom = "screen" | "header";
type Listener = (needs: Needs, from: NeedsFrom) => void;

const listeners = new Set<Listener>();
let last: { text: string; needs: Needs; ticket: number } | null = null;
let tickets = 0;
const stamped = new WeakMap<object, number>();

/**
 * A read's place in line, taken when it starts: a read that started later
 * knows more, whichever answer arrives first.
 */
export function readTicket(): number {
  tickets += 1;
  return tickets;
}

/** Marks a read's answer with the ticket it started with, so whoever hands it on later can say how old it is. */
export function stampNeeds(needs: Needs, ticket: number): Needs {
  stamped.set(needs, ticket);
  return needs;
}

/** The ticket an answer was stamped with, else a fresh one (an answer from nowhere is as new as now). */
export function ticketOf(needs: Needs): number {
  return stamped.get(needs) ?? readTicket();
}

/** The newest snapshot any reader has handed in, or null before the first. */
export function latestNeeds(): Needs | null {
  return last?.needs ?? null;
}

/**
 * Hands a read to every listener, unless it is no news: the same snapshot
 * again (`same`), or one whose read started before the snapshot already held
 * (`older`), which arrived late and must not replace what came after it. A
 * reader told `older` keeps, or takes, latestNeeds().
 */
export function publishNeeds(needs: Needs, from: NeedsFrom, ticket: number): "newer" | "same" | "older" {
  const text = JSON.stringify(needs);
  if (text === last?.text) {
    last = { text, needs: last.needs, ticket: Math.max(last.ticket, ticket) };
    return "same";
  }
  if (last && ticket < last.ticket) return "older";
  last = { text, needs, ticket };
  for (const listener of [...listeners]) listener(needs, from);
  return "newer";
}

/** Hears every fresh read; returns how to stop. */
export function onNeeds(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** For a test: forgets the last snapshot and every listener. */
export function resetNeedsBus(): void {
  listeners.clear();
  last = null;
}

/** What about a session can move a count or a pill: its status, whether it is asking, whether it is archived. */
export function sessionSignal(agent: {
  status: string;
  pendingPermissions?: readonly unknown[];
  archivedAt?: string | null;
}): string {
  return `${agent.status}:${agent.pendingPermissions?.length ?? 0}:${agent.archivedAt ? "archived" : "live"}`;
}

export interface WatchOptions {
  /** Paseo's agent subscription. */
  subscribe: (handler: (update: PaseoAgentUpdate) => void) => () => void;
  /** What a change asks for: a refetch. */
  nudge: () => void;
  /** Runs `run` once after `ms`; returns how to cancel it. */
  later: (run: () => void, ms: number) => () => void;
  /** How long a burst gathers before its one nudge. */
  ms: number;
  log: (message: string) => void;
}

/**
 * Nudges once, `ms` after the first of a burst of session changes: a status,
 * a permission asked or answered, an archive, a session that went. The first
 * sight of a session is the subscription's snapshot, not a change. A host
 * that cannot subscribe is said once and leaves the caller's own poll.
 * Returns how to stop: the subscription and any pending nudge.
 */
export function watchSessions(options: WatchOptions): () => void {
  const seen = new Map<string, string>();
  let pending: (() => void) | null = null;
  const soon = () => {
    if (pending) return;
    pending = options.later(() => {
      pending = null;
      options.nudge();
    }, options.ms);
  };
  let unsubscribe: () => void = () => undefined;
  try {
    unsubscribe = options.subscribe((update) => {
      if (update.kind === "remove") {
        if (seen.delete(update.agentId)) soon();
        return;
      }
      const signal = sessionSignal(update.agent);
      const before = seen.get(update.agent.id);
      if (before === signal) return;
      seen.set(update.agent.id, signal);
      if (before !== undefined) soon();
    });
  } catch (error) {
    options.log(
      `Could not listen for session changes; what needs you refreshes on its poll: ${(error as Error).message}`,
    );
  }
  return () => {
    unsubscribe();
    pending?.();
    pending = null;
  };
}
