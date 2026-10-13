// StoredWork -> the WorkItem the surfaces render. Pure: every derived field
// comes from the contract plus the event log, and `nextRun` from Settings too.
// `updatedAt` and `lastEventAt` skip the loop's flags: a flag is a remark
// about the work, not a change to it (server/events.ts lastActivityOf).

import type { MaestroConfig, WorkItem } from "../shared/contracts";
import { fleetHeading } from "../shared/fleet-item";
import { groupOf } from "../shared/states";
import { ticketOf } from "../shared/text";
import {
  adoptedByOf,
  closedOf,
  lastActivityOf,
  lineageOf,
  lookOf,
  pendingDecision,
  pendingPermission,
  phaseOf,
  reasonOf,
  verdictOf,
  type WorkEvent,
  workerOf,
} from "./events";
import { flagNow } from "./flags";
import { briefOf } from "./frontmatter";
import { nextRun } from "./runs";
import { lastLanding } from "./session-cards";
import { placement, type StoredWork } from "./store";

/** `config` is the Settings this read used: `nextRun` fills the work's unset run choices from it. */
export function toWire(item: StoredWork, now: number, config: MaestroConfig): WorkItem {
  const { contract, events } = item;
  const last = lastActivityOf(events);
  const created = events.find((event) => event.type === "created");
  const { initiative, project } = placement(item.rel);
  const decision = pendingDecision(events);
  const next = nextRun(config, item);
  const heading = fleetHeading(item.title, briefOf(item.work?.body ?? ""));
  const landing = lastLanding(events);
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
    nextRun: next,
    landing: landing ?? undefined,
    landedAt: landing === null ? null : (events[landing]?.ts ?? null),
    pending: decision
      ? {
          verdict: decision.verdict,
          note: decision.note,
          decidedAt: decision.decidedAt,
          effectiveAt: decision.effectiveAt,
          remainingMs: Math.max(0, Date.parse(decision.effectiveAt) - now),
          receipt: decision.token,
        }
      : null,
    flag: flagNow(events, contract.state, next, now, item.mtime),
    closed: closedOf(contract.state, events),
    adoptedBy: adoptedByOf(events),
    ...lineage(events, item.title),
    display: { title: heading?.title ?? item.title, fleet: heading?.origin ?? null },
  };
}

/** The work's lineage: the work that adopted it, and its ticket, given at adoption or read from its title (BRO-2908). */
function lineage(events: readonly WorkEvent[], title: string): { parentWork: string | null; ticket: string | null } {
  const known = lineageOf(events);
  return { parentWork: known.parentWork, ticket: known.ticket ?? ticketOf(title) };
}
