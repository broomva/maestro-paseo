// The composer pill: a session Maestro tracks says, beside its composer, where
// its work stands in plain voice. Untracked sessions get no pill. Pure.

import type { WorkItem } from "../shared/contracts";
import { type OrchState, PLAIN_VOICE } from "../shared/states";

export type PillSpec = { workspaceId: string; agentId: string; workId: string; state: OrchState; title: string };

/** The plain-voice state, with canceled work named as such rather than as Done (as StateLabel does). */
export function pillLabel(state: OrchState): string {
  return state === "canceled" ? "Canceled" : PLAIN_VOICE[state].label;
}

/**
 * One pill per session that is some work's current worker, keyed by workspace
 * and agent: a pill is registered against both, so a session that moves
 * workspace is a new registration. Sessions with no known workspace are
 * skipped. The list comes attention first, so if two items name one session
 * the one that needs you wins.
 */
export function pillSpecs(items: readonly WorkItem[]): Map<string, PillSpec> {
  const specs = new Map<string, PillSpec>();
  for (const item of items) {
    const worker = item.worker;
    if (!worker?.workspaceId) continue;
    const key = `${worker.workspaceId}/${worker.agentId}`;
    if (specs.has(key)) continue;
    specs.set(key, {
      workspaceId: worker.workspaceId,
      agentId: worker.agentId,
      workId: item.id,
      state: item.state,
      title: item.title,
    });
  }
  return specs;
}

/** What the pill shows; the icon is the state dot, drawn by the caller. */
export function pillFace(spec: PillSpec): { title: string; label: string } {
  return { title: `Maestro: ${spec.title}`, label: pillLabel(spec.state) };
}
