// The words of the countdown strip (client/pending-verbs.tsx), pure: what is still waiting out its 8 s window,
// how many seconds are left, and how a settled verb reads. Kept apart from the component so it is tested alone.

import type { OwnerVerb, PendingVerb, SettledVerb } from "../shared/verbs";

/** Whole seconds left, rounded up: "8" for the first second, "1" for the last. Pure. */
export function secondsLeft(remainingMs: number): number {
  return Math.max(0, Math.ceil(remainingMs / 1000));
}

/** The verbs of yours still waiting, those on `keys` only when given (a work's key, an ask's). Pure. */
export function pendingFor(
  pending: readonly PendingVerb[],
  keys?: readonly string[],
  skip: readonly OwnerVerb[] = [],
): PendingVerb[] {
  return pending.filter((verb) => (!keys || keys.includes(verb.key)) && !skip.includes(verb.verb));
}

/** What one waiting verb says: what you did, and when it takes effect. Pure. */
export function pendingWords(verb: Pick<PendingVerb, "label">, left: number): string {
  return left > 0 ? `${verb.label} · takes effect in ${left}s` : `${verb.label} · taking effect now`;
}

/** What became of your verbs on `keys` in the last day: took effect, undone, or dropped and why. Pure. */
export function settledWords(verb: Pick<SettledVerb, "label" | "outcome" | "detail">): string {
  if (verb.outcome === "applied") return `${verb.label} · took effect`;
  if (verb.outcome === "undone") return `${verb.label} · you undid it`;
  return `${verb.label} · dropped: ${verb.detail}`;
}
