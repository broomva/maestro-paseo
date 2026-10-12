// What a gate card in a session's timeline offers, given the card and the work
// as it is now. A card belongs to one landing in one session. Only the card for
// the work's current landing, in its current worker's session, offers a verb:
// an older card, or one left in a session the work has moved away from, says
// so and offers nothing. A card that asks holds one exact action (Allow or Deny,
// approval.decide); one that finished holds nothing, and offers Change course. Pure.

import type { WorkItem } from "../shared/contracts";
import type { GateCardData } from "../shared/gate-card";
import { isTerminal } from "../shared/states";

export type CardView = "asking" | "finished" | "resolved" | "superseded";

type Current = Pick<WorkItem, "state" | "permission" | "landing" | "worker">;
type Card = Pick<GateCardData, "landing" | "agentId">;

export const SUPERSEDED = "Superseded by a later run.";

export function cardView(card: Card, item: Current): CardView {
  if (card.landing === undefined || card.agentId === undefined) return "superseded";
  if (item.landing !== card.landing || item.worker?.agentId !== card.agentId) return "superseded";
  if (item.state !== "review") return "resolved";
  return item.permission ? "asking" : "finished";
}

/**
 * Whether the card can no longer change: a superseded card never becomes
 * current again (landings only grow and a new run is a new session), and
 * finished work stays finished. Such a card stops polling.
 */
export function cardSettled(card: Card, item: Current): boolean {
  const view = cardView(card, item);
  return view === "superseded" || (view === "resolved" && isTerminal(item.state));
}

/** The session a card may answer a question for: its own, and only while that session is still the worker. */
export function answerTarget(card: Card, item: Current): string | null {
  return cardView(card, item) === "asking" ? (card.agentId ?? null) : null;
}

/** How the work left the gate, in a sentence; shown beside its state. */
export function resolution(item: Pick<WorkItem, "state" | "verdict" | "reason">): string {
  switch (item.state) {
    case "done":
      return item.verdict ?? "Closed.";
    case "canceled":
      return item.verdict ?? "Canceled.";
    case "blocked":
      return item.reason ?? "The run stopped without a reason.";
    case "running":
      return "Back with the agent. A new card lands here when the run ends.";
    case "review":
      return "Waiting on you.";
    default:
      return "Queued again.";
  }
}
