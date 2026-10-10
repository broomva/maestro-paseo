// The phone's deck (M1c, in M1): one hold at a time, its verbs 52 pt tall,
// swipe sideways for the next. The detail card that rises from it (M2–M4) says
// where you are, "Approval · 1 of 4", with a segment per hold. Pure
// (client/kit/deck.test.ts).

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

/** Whether a move starts the deck's swipe: sideways, past the slop. */
export function deckCaptures(dx: number, dy: number): boolean {
  return Math.abs(dx) > DECK.slop && Math.abs(dx) > Math.abs(dy) * 1.5;
}

/** The hold a sideways release lands on: one step at most, never past either end. */
export function deckRelease(index: number, count: number, dx: number, vx: number, width: number): number {
  const far = Math.abs(dx) >= width * DECK.advance;
  const flung = Math.abs(vx) >= DECK.flick && Math.abs(dx) >= DECK.flickMin;
  if (!far && !flung) return index;
  const next = dx < 0 ? index + 1 : index - 1;
  return Math.min(Math.max(next, 0), Math.max(count - 1, 0));
}

/** The strip's offset while dragging: the edges resist, so the first and last holds stay put. */
export function deckOffset(index: number, count: number, dx: number, width: number): number {
  const base = -index * (width + DECK.gap);
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
