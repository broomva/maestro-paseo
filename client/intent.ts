// Navigation intents: how a command, a header button or a timeline card asks
// the Maestro surface to open at something. openSurface() takes no argument,
// so the caller leaves the intent here and then opens the surface; the surface
// takes it when it mounts, or at once when it is already open.
//
// An intent is taken once and goes stale after INTENT_TTL_MS: long enough for a
// cold surface load, short enough that one whose surface never opened does not
// fire later, when Maestro is opened for another reason.

import { useEffect, useRef } from "react";
import type { Group } from "../shared/states";

export type MaestroIntent =
  | { kind: "select"; id: string }
  | { kind: "new" }
  | { kind: "filter"; group: Group }
  | { kind: "fleet"; scope: string | null }
  | {
      kind: "decisions";
      /** The ledger the tab lists (null: all). */
      ledger?: string | null;
      /** The ask to show first, and, when the tab lists every ledger, the ledger it is in (ledgerOf). */
      id?: string | null;
      askLedger?: string | null;
    }
  | { kind: "timeline" }
  | { kind: "initiatives" };

export const INTENT_TTL_MS = 30_000;

let pending: { intent: MaestroIntent; at: number } | null = null;
let listeners: Array<() => void> = [];

/** Leaves an intent for the surface. A later request replaces an untaken one. */
export function requestIntent(intent: MaestroIntent, now: number = Date.now()): void {
  pending = { intent, at: now };
  // The newest surface hears it first: that is the one openSurface() just showed.
  for (const listener of [...listeners].reverse()) listener();
}

/** Takes the pending intent once. A stale one is dropped, not returned. */
export function takeIntent(now: number = Date.now()): MaestroIntent | null {
  const taken = pending;
  pending = null;
  if (!taken || now - taken.at > INTENT_TTL_MS) return null;
  return taken.intent;
}

export function subscribeIntent(listener: () => void): () => void {
  listeners = [...listeners, listener];
  return () => {
    listeners = listeners.filter((entry) => entry !== listener);
  };
}

/** Hands `handle` the intent already waiting, then each new one. Returns the unsubscribe. */
export function attachIntent(handle: (intent: MaestroIntent) => void): () => void {
  const drain = () => {
    const intent = takeIntent();
    if (intent) handle(intent);
  };
  drain();
  return subscribeIntent(drain);
}

/** The surface's hook: attachIntent for the lifetime of the component. */
export function useIntent(handle: (intent: MaestroIntent) => void): void {
  const latest = useRef(handle);
  latest.current = handle;
  useEffect(() => attachIntent((intent) => latest.current(intent)), []);
}

/** Test-only: forget the pending intent and every listener. */
export function resetIntents(): void {
  pending = null;
  listeners = [];
}
