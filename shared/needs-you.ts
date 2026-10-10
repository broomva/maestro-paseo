// Which work needs you: one definition for every surface that counts, lists or
// opens work under Needs you. Owner answer A1: work needs you only while it
// holds something only you can give, an approval or an owner step:
//   - at your gate (`review`): a permission prompt the session is paused on,
//     or a landing Maestro's human gate holds (an approval, server/needs.ts);
//   - queued work only you may start (a `yours` flag: held for you, a mode
//     you chose, filed from your answer; or a `failed` start from before A8):
//     an owner step, "Start it yourself".
// Stuck work and a run gone quiet are watched (Health), not held: they are
// listed under their own state, never under Needs you. needs.list builds its
// work rows from this predicate, so the Feed, the Board, the List, `maestro
// ls` and the header count cannot disagree about a work item. Pure.

import type { WorkItem } from "./contracts";
import type { Group } from "./states";

type Placed = Pick<WorkItem, "group" | "flag">;

/** Whether queued work waits for you to start it: the loop flagged it yours (or a start before A8 failed). */
export const onlyYouStart = (item: Placed): boolean => item.flag?.kind === "yours" || item.flag?.kind === "failed";

/** Whether this work holds something only you can give: it is at your gate, or only you may start it. */
export const needsHand = (item: Placed): boolean => item.group === "review" || onlyYouStart(item);

/** Work that needs you, in order: at your gate, then what only you may start, each as given. */
export function needsYouOf<T extends Placed>(items: readonly T[]): T[] {
  return [
    ...items.filter((item) => item.group === "review"),
    ...items.filter((item) => item.group !== "review" && needsHand(item)),
  ];
}

/**
 * Where work is listed: under Needs you when it needs a hand, else under its
 * own group (stuck work under Stuck, a quiet run under Running). Each item is
 * listed once; its state label still says what it is.
 */
export function sectionOf(item: Placed): Group {
  return needsHand(item) ? "review" : item.group;
}
