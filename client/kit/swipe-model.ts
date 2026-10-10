// The phone's swipe row (M1d, on M1's sheet rows only): swipe right for the
// row's default verb (Continue, Done), left to show Snooze and Open. A hold
// (an ask, an approval, an owner step) never swipes: acting on one is always a
// deliberate tap. On compact native Paseo takes every rightward drag (BRO-3033
// fact 3), so there the row swipes left only and its default verb joins the
// left actions (client/kit/assumptions.ts F4). Pure (client/kit/swipe.test.ts).

import type { Directions } from "./assumptions";

/**
 * The kinds that are holds: never swiped (M1: "a hold is always a deliberate tap"). `owner_step` is the
 * contract's spelling (view-models.md NeedKind); `owner-step` is the inventory's, so both count.
 */
export const HOLD_KINDS = ["ask", "approval", "owner_step", "owner-step"] as const;

export function isHold(kind: string): boolean {
  return (HOLD_KINDS as readonly string[]).includes(kind);
}

/** Whether a row of this kind swipes at all. */
export function canSwipe(kind: string): boolean {
  return !isHold(kind);
}

export const SWIPE = {
  /** A move this far (px), mostly sideways, starts a swipe. */
  slop: 10,
  /** A right swipe past this share of the row's width commits the default verb. */
  commit: 0.4,
  /** A right release this fast (px/ms) and at least `flickMin` px commits too. */
  flick: 0.6,
  flickMin: 48,
  /** Each left action's width; a left swipe past `reveal` px opens them. */
  action: 78,
  reveal: 56,
} as const;

/** The left actions' full width: Snooze (when the row has one) and Open. */
export function actionsWidth(count: number): number {
  return SWIPE.action * count;
}

/**
 * Whether a move starts a swipe: a row that swipes, sideways, past the slop,
 * in a direction it may go. A rightward drag on open actions closes them, so
 * it is taken either way (if the host takes it instead, the row springs shut).
 */
export function swipeCaptures(kind: string, dx: number, dy: number, directions: Directions, open = false): boolean {
  if (!canSwipe(kind) || Math.abs(dx) <= SWIPE.slop || Math.abs(dx) <= Math.abs(dy) * 1.5) return false;
  return dx > 0 ? directions.right || open : directions.left;
}

/** The left actions in order: the default verb first when it cannot be a right swipe, then Snooze, then Open. */
export function leftActions<T>(
  directions: Directions,
  primary: T | undefined,
  snooze: T | undefined,
  open: T | undefined,
): T[] {
  return [directions.right ? undefined : primary, snooze, open].filter((action): action is T => action !== undefined);
}

export type SwipeEnd = "commit" | "reveal" | "rest";

/**
 * Where a release ends. `open` says the left actions were showing when the
 * drag began, so a further left drag keeps them and a right one closes them.
 */
export function swipeRelease(
  dx: number,
  vx: number,
  width: number,
  open: boolean,
  actions: number,
  directions: Directions,
): SwipeEnd {
  if (!open && dx > 0) {
    if (!directions.right) return "rest";
    const far = dx >= width * SWIPE.commit;
    const flung = vx >= SWIPE.flick && dx >= SWIPE.flickMin;
    return far || flung ? "commit" : "rest";
  }
  if (actions === 0) return "rest";
  const at = (open ? -actionsWidth(actions) : 0) + dx;
  return at <= -SWIPE.reveal && vx <= SWIPE.flick ? "reveal" : "rest";
}

/**
 * The row's offset while dragging: to the right only where a right swipe is
 * allowed (and never past rest when it is not), to the left no further than
 * its actions plus a stretch.
 */
export function swipeOffset(dx: number, open: boolean, actions: number, directions: Directions): number {
  const base = open ? -actionsWidth(actions) : 0;
  const at = directions.right ? base + dx : Math.min(0, base + dx);
  const floor = -actionsWidth(actions);
  if (at >= floor) return at;
  return floor + (at - floor) / 3;
}
