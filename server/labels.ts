// Paseo is the harness registry (BRO-2908): a session says which work it is,
// and whose, in its own labels, so it can be found from the Paseo side as well
// as from Maestro's. Dispatch sets them when it creates the agent (runs.ts);
// an adopted session already exists, and the plugin's agent handle has no way
// to set a label, so this asks the paseo CLI, which the daemon answers.

import { execFile } from "node:child_process";
import { WORK_LABEL } from "./runs";

/** Sets `labels` on the session `agentId`, adding to the ones it has. Rejects when the daemon refuses. */
export type LabelAgent = (agentId: string, labels: Record<string, string>) => Promise<void>;

/** The label Paseo itself puts on a session a session started: the agent that started it (the daemon's record, not Maestro's). */
export const PARENT_AGENT_LABEL = "paseo.parent-agent-id";

/** The labels a work's session carries: its work, and when known its ticket and the work that adopted it. */
export const WORK_LABELS = { work: WORK_LABEL, ticket: "ticket", parent: "maestro.parent-work" } as const;

export const paseoLabel: LabelAgent = (agentId, labels) =>
  new Promise((done, fail) => {
    // The CLI splits each --label on commas: a value with one would set a second label (maestro.work, say).
    const unsafe = Object.entries(labels).find(([key, value]) => /[,=\s]/.test(key) || /[,\n]/.test(value));
    if (unsafe) {
      fail(new Error(`refused to label ${agentId}: ${unsafe[0]} holds a comma or line break`));
      return;
    }
    const args = [
      "agent",
      "update",
      agentId,
      ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
    ];
    execFile("paseo", args, { timeout: 15_000 }, (error, _stdout, stderr) =>
      error ? fail(new Error(stderr.trim() || error.message)) : done(),
    );
  });

/** The labels for a work's session: the ones it has a value for. Pure. */
export function workLabels(work: {
  id: string;
  ticket?: string | null;
  parentWork?: string | null;
}): Record<string, string> {
  return {
    [WORK_LABELS.work]: work.id,
    ...(work.ticket ? { [WORK_LABELS.ticket]: work.ticket } : {}),
    ...(work.parentWork ? { [WORK_LABELS.parent]: work.parentWork } : {}),
  };
}
