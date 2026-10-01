// StoredWork -> the WorkItem the surfaces render. Pure: every derived field
// comes from the contract plus the event log, and `nextRun` from Settings too.

import type { MaestroConfig, WorkItem } from "../shared/contracts";
import { groupOf } from "../shared/states";
import { lookOf, pendingDecision, pendingPermission, phaseOf, reasonOf, verdictOf, workerOf } from "./events";
import { lastLanding } from "./gate-card";
import { nextRun } from "./runs";
import { placement, type StoredWork } from "./store";

/** `config` is the Settings this read used: `nextRun` fills the work's unset run choices from it. */
export function toWire(item: StoredWork, now: number, config: MaestroConfig): WorkItem {
  const { contract, events } = item;
  const last = events[events.length - 1];
  const created = events.find((event) => event.type === "created");
  const { initiative, project } = placement(item.rel);
  const decision = pendingDecision(events);
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
    nextRun: nextRun(config, item),
    landing: lastLanding(events) ?? undefined,
    pending: decision
      ? {
          verdict: decision.verdict,
          note: decision.note,
          decidedAt: decision.decidedAt,
          effectiveAt: decision.effectiveAt,
          remainingMs: Math.max(0, Date.parse(decision.effectiveAt) - now),
        }
      : null,
  };
}
