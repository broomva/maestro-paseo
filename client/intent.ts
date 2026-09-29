// Navigation intents: how a command, a header button or a timeline card asks
// the Maestro surface to open at something. openSurface() takes no argument,
// so the caller leaves the intent here and then opens the surface; the surface
// takes it when it mounts, or at once when it is already open.

import { useEffect, useRef } from "react";
import type { Group } from "../shared/states";

export type MaestroIntent = { kind: "select"; id: string } | { kind: "new" } | { kind: "filter"; group: Group };

let pending: MaestroIntent | null = null;
const listeners = new Set<() => void>();

/** Leaves an intent for the surface. A later request replaces an untaken one. */
export function requestIntent(intent: MaestroIntent): void {
  pending = intent;
  for (const listener of listeners) listener();
}

/** Takes the pending intent. It is taken once: the next reader sees null. */
export function takeIntent(): MaestroIntent | null {
  const intent = pending;
  pending = null;
  return intent;
}

export function subscribeIntent(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Hands every intent to `handle`: one already waiting on mount, then each new one. */
export function useIntent(handle: (intent: MaestroIntent) => void): void {
  const latest = useRef(handle);
  latest.current = handle;
  useEffect(() => {
    const drain = () => {
      const intent = takeIntent();
      if (intent) latest.current(intent);
    };
    drain();
    return subscribeIntent(drain);
  }, []);
}
