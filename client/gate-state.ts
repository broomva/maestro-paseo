// What the gate card in a session's timeline offers, given the work as it is
// now. The card reads the item live, so once the work leaves your gate it says
// how that went and offers no verb. Pure.

import type { WorkItem } from "../shared/contracts";

export type GateMode = "asking" | "deciding" | "resolved";

export function gateMode(item: Pick<WorkItem, "state" | "permission">): GateMode {
  if (item.state !== "review") return "resolved";
  return item.permission ? "asking" : "deciding";
}

/** How the work left your gate, in a sentence; shown beside its state. */
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
