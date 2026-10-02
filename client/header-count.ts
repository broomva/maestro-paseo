// The header count: in every workspace, "N need you" while work waits at your
// gate, is stuck, or was flagged by the loop, or a fleet scope's tick is
// missed or failing and not already there as the fleet's own work, and
// nothing at all while none does. Pure.

import type { PluginButton } from "@getpaseo/plugin/client";
import type { WorkItem } from "../shared/contracts";
import type { FleetNotice } from "../shared/fleet";
import { needsHand } from "../shared/needs-you";
import type { MaestroIntent } from "./intent";

type Listed = Pick<WorkItem, "id" | "group" | "flag">;

/** Work that needs you: waiting at your gate, stuck, or flagged by the loop (plane-model needsHand). */
export function needsYou<T extends Listed>(items: readonly T[]): T[] {
  return items.filter(needsHand);
}

export function needsYouLabel(count: number): string {
  return `${count} ${count === 1 ? "needs" : "need"} you`;
}

/** What the count counts: the work that needs you, and each fleet notice (server/fleet.ts). */
export function needsYouCount(items: readonly Listed[], fleet: readonly Pick<FleetNotice, "scope">[] = []): number {
  return needsYou(items).length + fleet.length;
}

/**
 * Where the count opens Maestro: the one item that waits, else Needs you
 * (Stuck when only stuck work waits). The Needs you chip and section hold
 * exactly what needsHand holds (shared/needs-you.ts), stuck and flagged work
 * included, so the filter it opens lists everything the count counted; the
 * fleet's notices sit above every view but the Fleet view. With only fleet
 * notices, it opens the Fleet view at the first.
 */
export function needsYouTarget(
  items: readonly Listed[],
  fleet: readonly Pick<FleetNotice, "scope">[] = [],
): MaestroIntent {
  const waiting = needsYou(items);
  const [only] = waiting;
  const [notice] = fleet;
  if (waiting.length === 0 && notice) return { kind: "fleet", scope: notice.scope };
  if (waiting.length === 1 && only && fleet.length === 0) return { kind: "select", id: only.id };
  if (waiting.length > 0 && fleet.length === 0 && waiting.every((item) => item.group === "blocked"))
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
