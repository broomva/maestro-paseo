// What the header count and the composer pills read (work.attention). It is
// computed from the work files alone, with no session reconcile, so every
// open client can poll it without costing an agent round trip per item. Pure.

import type { Attention, WorkItem } from "../shared/contracts";
import { needsYouOf } from "../shared/needs-you";
import { isTerminal } from "../shared/states";

/** How long finished work keeps its pill: long enough to see it closed, not forever. */
export const RECENT_MS = 24 * 60 * 60 * 1000;

/**
 * `waiting`: what needs you (shared/needs-you.ts), at your gate, then stuck,
 * then flagged by the loop, each in the list's order. Sessions keep the list's
 * order (attention first), which the pills rely on when two items name one
 * session.
 */
export function attentionOf(items: readonly WorkItem[], now: number): Attention {
  const waiting = needsYouOf(items).map(({ id, group, flag }) => ({ id, group, flag }));
  const sessions: Attention["sessions"] = [];
  for (const item of items) {
    const worker = item.worker;
    if (!worker) continue;
    if (isTerminal(item.state) && now - Date.parse(item.updatedAt) >= RECENT_MS) continue;
    sessions.push({
      workId: item.id,
      title: item.title,
      state: item.state,
      agentId: worker.agentId,
      workspaceId: worker.workspaceId,
    });
  }
  return { waiting, sessions };
}
