// StoredWork -> the WorkItem the surfaces render. Pure: every derived field
// comes from the contract plus the event log.

import type { WorkItem } from "../shared/contracts";
import { groupOf } from "../shared/states";
import { lookOf, pendingPermission, phaseOf, reasonOf, verdictOf, workerOf } from "./events";
import { lastLanding } from "./gate-card";
import { placement, type StoredWork } from "./store";

export function toWire(item: StoredWork, now: number): WorkItem {
  const { contract, events } = item;
  const last = events[events.length - 1];
  const created = events.find((event) => event.type === "created");
  const { initiative, project } = placement(item.rel);
  return {
    id: contract.id,
    path: item.rel,
    title: item.title,
    kind: contract.kind,
    state: contract.state,
    group: groupOf(contract.state),
    gate: contract.gate,
    owner: contract.owner,
    initiative,
    project,
    repo: contract.repo,
    createdAt: created?.ts ?? contract.created ?? item.mtime,
    updatedAt: last?.ts ?? item.mtime,
    lastEventAt: last?.ts ?? null,
    phase: phaseOf(contract.state, events),
    worker: workerOf(events),
    reason: reasonOf(contract.state, events),
    verdict: verdictOf(contract.state, events),
    look: lookOf(contract.state, events, now),
    permission: contract.state === "review" ? pendingPermission(events) : null,
    checks: contract.checks.map(({ name, run }) => ({ name, run })),
    run: runChoices(contract),
    landing: lastLanding(events) ?? undefined,
  };
}

/** The run choices stored on the work, or null when every one is left to Settings. */
function runChoices(contract: StoredWork["contract"]): NonNullable<WorkItem["run"]> | null {
  const run: NonNullable<WorkItem["run"]> = {};
  if (contract.isolation) run.isolation = contract.isolation;
  if (contract.provider) run.provider = contract.provider;
  if (contract.modeId) run.modeId = contract.modeId;
  if (contract.thinkingOptionId) run.thinkingOptionId = contract.thinkingOptionId;
  if (contract.featureValues && Object.keys(contract.featureValues).length > 0)
    run.featureValues = contract.featureValues;
  return Object.keys(run).length > 0 ? run : null;
}
