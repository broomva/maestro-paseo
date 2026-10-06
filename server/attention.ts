// What the header count and the composer pills read (work.attention). It is
// computed from the work files alone, with no session reconcile, so every
// open client can poll it without costing an agent round trip per item. Pure.

import type { Attention, WorkItem } from "../shared/contracts";
import type { AskNotice, FleetNotice } from "../shared/fleet";
import { withoutMarker } from "../shared/fleet-item";
import type { InitiativeNotice } from "../shared/initiatives";
import { needsYouOf } from "../shared/needs-you";
import { isTerminal } from "../shared/states";
import type { TimelineNotice } from "../shared/timeline";

/** How long finished work keeps its pill: long enough to see it closed, not forever. */
export const RECENT_MS = 24 * 60 * 60 * 1000;

/**
 * `waiting`: what needs you (shared/needs-you.ts), at your gate, then stuck,
 * then flagged by the loop, each in the list's order. Sessions keep the list's
 * order (attention first), which the pills rely on when two items name one
 * session. `fleet`: each fleet scope whose tick is missed or failing and is
 * not already in Needs you as the fleet's own alert item (server/fleet.ts).
 * `timeline`: each scheduled source whose run failed or was missed, other
 * than a fleet scope, which `fleet` already counts (server/timeline.ts).
 * `asks`: decision asks that wait on you (shared/fleet.ts isWaiting): the
 * workspace's (server/control-home.ts) and each fleet scope's own root's.
 * `initiatives`: initiatives past their review date, or parked ones whose
 * wake date came (server/initiatives.ts).
 */
export function attentionOf(
  items: readonly WorkItem[],
  now: number,
  fleet: readonly FleetNotice[] = [],
  timeline: readonly TimelineNotice[] = [],
  asks: readonly AskNotice[] = [],
  initiatives: readonly InitiativeNotice[] = [],
): Attention {
  const waiting = needsYouOf(items).map(({ id, group, flag }) => ({ id, group, flag }));
  const sessions: Attention["sessions"] = [];
  for (const item of items) {
    const worker = item.worker;
    if (!worker) continue;
    if (isTerminal(item.state) && now - Date.parse(item.updatedAt) >= RECENT_MS) continue;
    sessions.push({
      workId: item.id,
      // The title a person reads: a composer pill never shows the fleet's marker.
      title: item.display?.title || withoutMarker(item.title),
      state: item.state,
      agentId: worker.agentId,
      workspaceId: worker.workspaceId,
    });
  }
  return {
    waiting,
    sessions,
    fleet: [...fleet],
    timeline: [...timeline],
    asks: [...asks],
    initiatives: [...initiatives],
  };
}
