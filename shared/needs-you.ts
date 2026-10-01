// What needs you: one definition for every surface that counts, lists or
// opens it. Work at your gate, stuck work, and work the loop flagged (a start
// it left to you or could not make, a run gone quiet). The header count, the
// Needs you chip, the feed's and the list's Needs you section, the board's
// column, the initiative badge, work.attention and `maestro ls` all read it
// here, so none of them can count what another does not show. Pure.

import type { WorkItem } from "./contracts";
import type { Group } from "./states";

type Placed = Pick<WorkItem, "group" | "flag">;

/** Whether this work waits on a person: at your gate, stuck, or flagged by the loop. */
export const needsHand = (item: Placed): boolean =>
  item.group === "review" || item.group === "blocked" || Boolean(item.flag);

/** Work that needs you, in order: at your gate, then stuck, then flagged by the loop, each as given. */
export function needsYouOf<T extends Placed>(items: readonly T[]): T[] {
  return [
    ...items.filter((item) => item.group === "review"),
    ...items.filter((item) => item.group === "blocked"),
    ...items.filter((item) => item.group !== "review" && item.group !== "blocked" && needsHand(item)),
  ];
}

/**
 * Where work is listed: under Needs you when it needs a hand, else under its
 * own group. Each item is listed once; its state label still says what it is
 * (Stuck, Queued, Running).
 */
export function sectionOf(item: Placed): Group {
  return needsHand(item) ? "review" : item.group;
}
