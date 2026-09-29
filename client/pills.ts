// The composer pill: a session Maestro tracks says, beside its composer, where
// its work stands in plain voice. Untracked sessions get no pill. Pure.

import type { Attention } from "../shared/contracts";
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
 * skipped. work.attention lists live work and work changed in the last day,
 * attention first, so if two items name one session the one that needs you
 * wins.
 */
export function pillSpecs(sessions: readonly Attention["sessions"][number][]): Map<string, PillSpec> {
  const specs = new Map<string, PillSpec>();
  for (const session of sessions) {
    const { workspaceId, agentId } = session;
    if (!workspaceId) continue;
    const key = `${workspaceId}/${agentId}`;
    if (specs.has(key)) continue;
    specs.set(key, { workspaceId, agentId, workId: session.workId, state: session.state, title: session.title });
  }
  return specs;
}

/** What the pill shows; the icon is the state dot, drawn by the caller. */
export function pillFace(spec: PillSpec): { title: string; label: string } {
  return { title: `Maestro: ${spec.title}`, label: pillLabel(spec.state) };
}
