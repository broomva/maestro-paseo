// Which work needs you: one definition for every surface that counts, lists or
// opens work under Needs you. Owner answer A1: work needs you only while it
// holds something only you can give, an approval or an owner step:
//   - at your gate (`review`) with a permission prompt the session is paused
//     on: an approval, one exact held action (server/needs.ts). Work that
//     finished and merely waits at the gate asks nothing of you (BRO-2999):
//     gates merge it, so it is watched, "Finished", never counted here;
//   - queued work only you may start (a `yours` flag: held for you, a mode
//     you chose, filed from your answer; or a `failed` start from before A8):
//     an owner step, "Start it yourself".
// Stuck work and a run gone quiet are watched (Health), not held: they are
// listed under their own state, never under Needs you. needs.list builds its
// work rows from this predicate, so the Feed, the Board, the List, `maestro
// ls` and the header count cannot disagree about a work item. Pure.

import type { WorkItem } from "./contracts";
import type { Group } from "./states";

type Placed = Pick<WorkItem, "group" | "flag" | "permission">;

/** Whether queued work waits for you to start it: the loop flagged it yours (or a start before A8 failed). */
export const onlyYouStart = (item: Placed): boolean => item.flag?.kind === "yours" || item.flag?.kind === "failed";

/** Whether work at your gate holds a permission prompt: one exact action a policy layer held. */
export const holdsApproval = (item: Placed): boolean => item.group === "review" && item.permission != null;

/** Whether this work holds something only you can give: a held action, or work only you may start. */
export const needsHand = (item: Placed): boolean => holdsApproval(item) || onlyYouStart(item);

/** Work that finished and waits at the gate with no question pending: watched, "Finished" (BRO-2999). */
export const isFinished = (item: Placed): boolean => item.group === "review" && item.permission == null;

/** Work that needs you, in order: the held actions, then what only you may start, each as given. */
export function needsYouOf<T extends Placed>(items: readonly T[]): T[] {
  return [...items.filter(holdsApproval), ...items.filter((item) => item.group !== "review" && needsHand(item))];
}

/**
 * The work at your gate, as the board's and the list's first section shows it: held actions first, then
 * finished work waiting for your look, then what only you may start. Only the first and the last are counted
 * under Needs you (needsYouOf); finished work is listed here so none of it is lost from sight.
 */
export function atGateOf<T extends Placed>(items: readonly T[]): T[] {
  return [
    ...items.filter(holdsApproval),
    ...items.filter(isFinished),
    ...items.filter((item) => item.group !== "review" && needsHand(item)),
  ];
}

/**
 * Where work is listed: at the gate when it holds something or finished, else under its own group (stuck
 * work under Stuck, a quiet run under Running). Each item is listed once; its state label still says what it is.
 */
export function sectionOf(item: Placed): Group {
  return needsHand(item) || isFinished(item) ? "review" : item.group;
}

/**
 * Whether running work is standing (J6): alive, with no turn lately and nothing to review yet. The loop flags a
 * run quiet after 30 minutes (`flag.kind` "quiet"); that is the only signal work.list carries of a session between
 * turns, so a standing run is a quiet one. It is watched, never a hold (A1): Health says what closes it.
 */
export const isStanding = (item: Pick<WorkItem, "state" | "flag">): boolean =>
  item.state === "running" && item.flag?.kind === "quiet";

/**
 * The work that is running now, on a live turn: the Running lane, the Running tile, the Work tab's badge and the
 * Undertow all read this one list (view-models.md invariant 4); standing work is the Standing lane's.
 */
export function runningOf<T extends Pick<WorkItem, "state" | "flag">>(items: readonly T[]): T[] {
  return items.filter((item) => item.state === "running" && !isStanding(item));
}
