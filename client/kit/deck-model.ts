// The phone's deck (M1c, in M1): one hold at a time, its verbs 52 pt tall,
// swipe sideways for the next. On compact native a rightward swipe is Paseo's
// (BRO-3033 fact 3), so there the deck pages forward by a leftward swipe and
// to any hold by a tap on its segment. The detail card that rises from it (M2–M4) says
// where you are, "Approval · 1 of 4", with a segment per hold. Pure
// (client/kit/deck.test.ts).

import type { Directions } from "./assumptions";

/** The hold to open on: the index of `key` among the keys, else the first (BRO-3033 fact 2: `params.hold`). */
export function indexOfKey(keys: readonly string[], key: string | undefined): number {
  const at = key === undefined ? -1 : keys.indexOf(key);
  return at < 0 ? 0 : at;
}

export const DECK = {
  /** A sideways swipe past this share of the width moves one hold. */
  advance: 0.25,
  /** A release this fast (px/ms) and at least `flickMin` px moves one hold too. */
  flick: 0.5,
  flickMin: 32,
  slop: 10,
  /** The verbs' height (M1: 52 pt taps on the deck). */
  verb: 52,
  /** Space between neighbouring cards. */
  gap: 12,
} as const;

/** Whether a move starts the deck's swipe: sideways, past the slop, in a direction it may go. */
export function deckCaptures(dx: number, dy: number, directions: Directions): boolean {
  if (Math.abs(dx) <= DECK.slop || Math.abs(dx) <= Math.abs(dy) * 1.5) return false;
  return dx > 0 ? directions.right : directions.left;
}

/** The hold a sideways release lands on: one step at most, never past either end, never a way it may not go. */
export function deckRelease(
  index: number,
  count: number,
  dx: number,
  vx: number,
  width: number,
  directions: Directions,
): number {
  if (dx > 0 ? !directions.right : !directions.left) return index;
  const far = Math.abs(dx) >= width * DECK.advance;
  const flung = Math.abs(vx) >= DECK.flick && Math.abs(dx) >= DECK.flickMin;
  if (!far && !flung) return index;
  const next = dx < 0 ? index + 1 : index - 1;
  return Math.min(Math.max(next, 0), Math.max(count - 1, 0));
}

/** The strip's offset while dragging: the edges resist, so the first and last holds stay put; a barred way does not move. */
export function deckOffset(index: number, count: number, dx: number, width: number, directions: Directions): number {
  const base = -index * (width + DECK.gap);
  if (dx > 0 ? !directions.right : !directions.left) return base;
  const atEdge = (index === 0 && dx > 0) || (index >= count - 1 && dx < 0);
  return base + (atEdge ? dx / 3 : dx);
}

/** "1 of 4": where you are, counted from one. */
export function place(index: number, total: number): string {
  return `${Math.min(index + 1, total)} of ${total}`;
}

/** The detail header's middle: "Approval · 1 of 4". */
export function placeLabel(kind: string, index: number, total: number): string {
  return `${kind} · ${place(index, total)}`;
}

export type Segment = "done" | "current" | "todo";

/** One segment per hold: the ones before you are done, yours is current. */
export function segments(index: number, total: number): Segment[] {
  return Array.from({ length: total }, (_, at) => (at < index ? "done" : at === index ? "current" : "todo"));
}
