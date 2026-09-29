// Work items as work.list returns them, for client tests.

import type { WorkItem } from "../shared/contracts";
import { groupOf, type OrchState } from "../shared/states";

export function fakeWork(
  id: string,
  state: OrchState,
  worker: { agentId: string; workspaceId: string | null } | null = null,
  extra: Partial<WorkItem> = {},
): WorkItem {
  return {
    id,
    path: id,
    title: `Work ${id}`,
    kind: "task",
    state,
    group: groupOf(state),
    gate: "human",
    owner: null,
    initiative: null,
    project: null,
    repo: "/repo",
    createdAt: "2026-09-29T09:00:00.000Z",
    updatedAt: "2026-09-29T09:00:00.000Z",
    lastEventAt: null,
    phase: null,
    worker: worker ? { ...worker, provider: "claude/sonnet", branch: null, cwd: "/repo" } : null,
    reason: null,
    verdict: null,
    look: null,
    permission: null,
    checks: [],
    ...extra,
  };
}
