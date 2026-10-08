// The header count: in every workspace, "N need you" while work waits at your
// gate, is stuck, or was flagged by the loop, or a fleet scope's tick is
// missed or failing and not already there as the fleet's own work, or another
// scheduled run failed or was missed (the Timeline's notices), or a decision
// ask waits on you (blocking, or recommending what cannot be undone), or your
// answers wait to land through a PR Maestro never merges (shared/answers.ts),
// and nothing at all while none does. Pure.

import type { PluginButton } from "@getpaseo/plugin/client";
import type { AnswersNotice } from "../shared/answers";
import type { WorkItem } from "../shared/contracts";
import type { AskNotice, FleetNotice } from "../shared/fleet";
import type { InitiativeNotice } from "../shared/initiatives";
import type { LoopNotice } from "../shared/loops";
import { needsHand } from "../shared/needs-you";
import type { TimelineNotice } from "../shared/timeline";
import type { MaestroIntent } from "./intent";

type Listed = Pick<WorkItem, "id" | "group" | "flag">;

/** Work that needs you: waiting at your gate, stuck, or flagged by the loop (plane-model needsHand). */
export function needsYou<T extends Listed>(items: readonly T[]): T[] {
  return items.filter(needsHand);
}

export function needsYouLabel(count: number): string {
  return `${count} ${count === 1 ? "needs" : "need"} you`;
}

/**
 * What the count counts: the work that needs you, each fleet notice
 * (server/fleet.ts), each timeline notice (server/timeline.ts), each
 * decision ask that waits on you (shared/fleet.ts isWaiting), and the answers
 * batch while it waits on you (shared/answers.ts answersNotice).
 */
export function needsYouCount(
  items: readonly Listed[],
  fleet: readonly Pick<FleetNotice, "scope">[] = [],
  timeline: readonly Pick<TimelineNotice, "id">[] = [],
  asks: readonly Pick<AskNotice, "scope">[] = [],
  initiatives: readonly Pick<InitiativeNotice, "id">[] = [],
  answers: readonly Pick<AnswersNotice, "kind">[] = [],
  loops: readonly Pick<LoopNotice, "id">[] = [],
): number {
  return (
    needsYou(items).length +
    fleet.length +
    timeline.length +
    asks.length +
    initiatives.length +
    answers.length +
    loops.length
  );
}

/**
 * Where the count opens Maestro: the one item that waits, else Needs you
 * (Stuck when only stuck work waits). The Needs you chip and section hold
 * exactly what needsHand holds (shared/needs-you.ts), stuck and flagged work
 * included, so the filter it opens lists everything the count counted; the
 * fleet's notices sit above every view but the Fleet view, and the
 * timeline's above every view but the Timeline, and the asks' above every
 * view but Decisions, which holds them all. With only fleet notices,
 * it opens the Fleet view at the first; with only asks, or an answers batch
 * that waits, Decisions (blocking first), which lists the workspace's and
 * each fleet root's;
 * with only timeline notices, the Timeline;
 * with only stale or overdue initiatives, Initiatives, whose notices sit above
 * every other view; with only loop drift, Loops (BRO-2911).
 */
export function needsYouTarget(
  items: readonly Listed[],
  fleet: readonly Pick<FleetNotice, "scope">[] = [],
  timeline: readonly Pick<TimelineNotice, "id">[] = [],
  asks: readonly Pick<AskNotice, "scope">[] = [],
  initiatives: readonly Pick<InitiativeNotice, "id">[] = [],
  answers: readonly Pick<AnswersNotice, "kind">[] = [],
  loops: readonly Pick<LoopNotice, "id">[] = [],
): MaestroIntent {
  const waiting = needsYou(items);
  const [only] = waiting;
  const [notice] = fleet;
  const [ask] = asks;
  const notices = fleet.length + timeline.length + asks.length + initiatives.length + answers.length + loops.length;
  if (waiting.length === 0 && notice) return { kind: "fleet", scope: notice.scope };
  if (waiting.length === 0 && (ask || answers.length > 0)) return { kind: "decisions" };
  if (waiting.length === 0 && timeline.length > 0) return { kind: "timeline" };
  if (waiting.length === 0 && initiatives.length > 0) return { kind: "initiatives" };
  if (waiting.length === 0 && loops.length > 0) return { kind: "loops" };
  if (waiting.length === 1 && only && notices === 0) return { kind: "select", id: only.id };
  if (waiting.length > 0 && notices === 0 && waiting.every((item) => item.group === "blocked"))
    return { kind: "filter", group: "blocked" };
  return { kind: "filter", group: "review" };
}

export type HeaderSpec = { count: number };

/** One header button per workspace, all showing the same count. */
export function headerSpecs(workspaceIds: readonly string[], count: number): Map<string, HeaderSpec> {
  return new Map(workspaceIds.map((id) => [id, { count }]));
}

/** What the button shows. Compact headers drop the label, so the title carries the count too. */
export function headerFace(count: number): Pick<PluginButton, "title" | "label" | "icon" | "visible"> {
  const label = needsYouLabel(count);
  return { title: `${label} in Maestro`, label, icon: "Inbox", visible: count > 0 };
}
