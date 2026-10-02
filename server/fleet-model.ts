// The Fleet view's pure model: what fleet-reconcile's files say, folded into
// ticks, a scope's health, the dry run's proposals and the asks with the work
// the fleet raised for them. The fleet's formats are its own (broomva/skills
// orchestration/fleet-reconcile: fleetlib/ledger.py, report.py, tick.sh);
// everything here reads them defensively, since a record of a kind or shape it
// does not know is skipped, never fatal. No I/O here, so every rule is tested.

import { createHash } from "node:crypto";
import type { WorkItem } from "../shared/contracts";
import {
  type ClassCount,
  FLEET_CLASSES,
  FLEET_MISSED_MS,
  type FleetAsk,
  type FleetHealthStatus,
  type FleetItem,
  type FleetProposal,
  type FleetReview,
  type FleetTick,
  REVIEW_VERDICTS,
  type TickStatus,
} from "../shared/fleet";
import { needsHand } from "../shared/needs-you";
import { isTerminal } from "../shared/states";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const int = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const ms = (iso: string | null): number | null => {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : null;
};

/** A scope id as tick.sh accepts one: it names files and a LaunchAgent, so nothing else is read. */
export const SCOPE_ID = /^[a-z0-9_-]+$/;

/** One JSON object per line; a torn or garbage line is counted, not fatal. */
export function parseJsonLines(raw: string): { records: Json[]; bad: number } {
  const records: Json[] = [];
  let bad = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isObject(value)) records.push(value);
      else bad += 1;
    } catch {
      bad += 1;
    }
  }
  return { records, bad };
}

// ── The ledger ───────────────────────────────────────────────────────────────

export interface TickEntry {
  tick: number;
  fireAt: string | null;
  exitAt: string | null;
  /** A runner_exit record was written; `exit` is null when it carried no code (ticks 1 to 3 wrote none). */
  ended: boolean;
  exit: number | null;
  detail: string | null;
  dryRun: boolean | null;
}

/** A verb the coordinator ran under dry run: what it would have done, closed at once (fleetlib/act.py). */
export interface DryAct {
  verb: string;
  key: string;
  tick: number | null;
  at: string | null;
  target: Json;
}

export interface LedgerFold {
  ticks: Map<number, TickEntry>;
  /** Each ask key's batch now: the latest ask intent that carries it (ledger.py key_states). */
  batchOfAsk: Map<string, string>;
  /** Each batch's Maestro item, as the fleet last recorded it (a `seen` record on the maestro channel). */
  itemOfBatch: Map<string, string>;
  /** Oldest first. */
  dryActs: DryAct[];
}

const ACT_VERBS = new Set(["mail", "spawn", "label", "resume"]);

export function foldLedger(records: readonly Json[]): LedgerFold {
  const ticks = new Map<number, TickEntry>();
  const batchOfAsk = new Map<string, string>();
  const itemOfBatch = new Map<string, string>();
  const dryIntents = new Map<string, Json>();
  const dryActs: DryAct[] = [];
  const entry = (tick: number): TickEntry => {
    let found = ticks.get(tick);
    if (!found) {
      found = { tick, fireAt: null, exitAt: null, ended: false, exit: null, detail: null, dryRun: null };
      ticks.set(tick, found);
    }
    return found;
  };
  for (const record of records) {
    const kind = str(record.kind);
    const tick = int(record.tick);
    const id = str(record.id);
    const verb = str(record.verb);
    if (kind === "tick_fire" && tick !== null) {
      const at = entry(tick);
      at.fireAt = str(record.ts);
      at.dryRun = bool(record.dry_run);
    } else if (kind === "runner_exit" && tick !== null) {
      const at = entry(tick);
      at.ended = true;
      at.exitAt = str(record.ts);
      at.exit = typeof record.exit === "number" ? record.exit : null;
      at.detail = str(record.detail);
      at.dryRun ??= bool(record.dry_run);
    } else if (kind === "intent" && verb === "ask" && id) {
      const target = isObject(record.target) ? record.target : {};
      for (const ask of Array.isArray(target.asks) ? target.asks : []) {
        const key = isObject(ask) ? str(ask.key) : null;
        if (key) batchOfAsk.set(key, id);
      }
    } else if (kind === "seen" && isObject(record.result) && record.result.channel === "maestro") {
      const of = str(record.of);
      const item = str(record.result.item);
      if (!of) continue;
      // Gone: Maestro no longer has the item, and the fleet raises the batch again.
      if (record.result.state === "gone") itemOfBatch.delete(of);
      else if (item) itemOfBatch.set(of, item);
    } else if (kind === "intent" && verb && ACT_VERBS.has(verb) && record.dry_run === true && id) {
      dryIntents.set(id, record);
    } else if (kind === "done" && verb && ACT_VERBS.has(verb) && record.dry_run === true) {
      const intent = dryIntents.get(str(record.of) ?? "");
      const key = str(record.key) ?? (intent ? str(intent.key) : null);
      if (!intent || !key) continue;
      dryIntents.delete(str(record.of) ?? "");
      dryActs.push({
        verb,
        key,
        tick: int(record.tick) ?? int(intent.tick),
        at: str(record.ts),
        target: isObject(intent.target) ? intent.target : {},
      });
    }
  }
  return { ticks, batchOfAsk, itemOfBatch, dryActs };
}

// ── Ticks ────────────────────────────────────────────────────────────────────

/** The step names tick.sh counts as failing the tick, in its order; compare's verdict is not the tick's. */
const STEPS_THAT_FAIL = new Set(["recover", "observe", "report", "coordinator", "ask"]);

/** The first step that failed, as tick.sh names its alert (`tick-<step>`), from `recover=0 observe=1 ...`. */
export function failedStepOf(detail: string | null): string | null {
  if (!detail) return null;
  for (const [, name, rc] of detail.matchAll(/([a-z]+)=(\d+)/g)) {
    if (name && STEPS_THAT_FAIL.has(name) && rc !== "0") return name;
  }
  return null;
}

export function tickStatusOf(entry: TickEntry | undefined, now: number, budgetMs: number): TickStatus {
  if (!entry) return "unknown";
  if (entry.ended) return entry.exit === null ? "unknown" : entry.exit === 0 ? "ok" : "failed";
  const started = ms(entry.fireAt);
  if (started === null) return "unknown";
  return now - started <= budgetMs ? "running" : "died";
}

/** What one report.json says, kept small: the rest of the file is not held. */
export interface ReportSummary {
  tick: number;
  ts: string | null;
  mode: string | null;
  dryRun: boolean | null;
  classCounts: ClassCount[];
  proposals: FleetProposal[];
  asksOpen: Json[];
}

/** A stable key for one proposal: the same session, class and words read the same at every tick. */
export function proposalKey(sessionId: string, classId: string, action: string): string {
  const words = createHash("sha256").update(action).digest("hex").slice(0, 8);
  return `session:${sessionId}:${classId}:${words}`;
}

export function summarizeReport(raw: unknown, scope: string, fallbackTick: number): ReportSummary | null {
  if (!isObject(raw)) return null;
  const tick = int(raw.tick) ?? fallbackTick;
  const ts = str(raw.ts);
  const sessions = Array.isArray(raw.sessions) ? raw.sessions.filter(isObject) : [];
  // Class names as the report gives them, else the spec's table.
  const names = new Map<string, string>();
  for (const session of sessions) {
    const id = str(session.class);
    const name = str(session.class_name);
    if (id && name) names.set(id, name);
  }
  const counts = isObject(raw.class_counts) ? raw.class_counts : {};
  const classCounts: ClassCount[] = Object.entries(counts)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .map(([id, count]) => ({ id, name: names.get(id) ?? FLEET_CLASSES[id] ?? id, count }))
    .sort((a, b) => classOrder(a.id) - classOrder(b.id));
  const proposals: FleetProposal[] = [];
  for (const session of sessions) {
    const action = str(session.action);
    const sessionId = str(session.session_id);
    const classId = str(session.class) ?? "unknown";
    const elsewhere = str(session.scope) !== null && str(session.scope) !== scope;
    // Nothing to do is no proposal, and a session out of this scope is never this scope's to act on.
    if (!action || action === "nothing" || !sessionId || classId === "1" || elsewhere) continue;
    proposals.push({
      key: proposalKey(sessionId, classId, action),
      source: "report",
      tick,
      at: ts,
      action,
      session: {
        id: sessionId,
        short: str(session.short) ?? sessionId.slice(0, 8),
        name: str(session.name),
        kind: str(session.kind),
        status: str(session.status) ?? str(session.state),
        cwd: str(session.cwd),
      },
      classId,
      className: str(session.class_name) ?? FLEET_CLASSES[classId] ?? null,
      evidence: str(session.evidence),
      verb: null,
      review: null,
    });
  }
  return {
    tick,
    ts,
    mode: str(raw.mode),
    dryRun: bool(raw.dry_run),
    classCounts,
    proposals,
    asksOpen: Array.isArray(raw.asks_open) ? raw.asks_open.filter(isObject) : [],
  };
}

/** The class table's order: 1, 2, ... 9, 9a, 10, then anything else. */
function classOrder(id: string): number {
  const n = Number.parseInt(id, 10);
  if (!Number.isFinite(n)) return 1000;
  return n * 2 + (id.endsWith("a") ? 1 : 0);
}

/** A coordinator's dry verb as a proposal: the newest of each verb and key. */
export function actProposals(acts: readonly DryAct[], sinceTick: number | null): FleetProposal[] {
  const newest = new Map<string, DryAct>();
  for (const act of acts) {
    if (sinceTick !== null && act.tick !== null && act.tick < sinceTick) continue;
    newest.set(`act:${act.verb}:${act.key}`, act);
  }
  return [...newest.entries()].reverse().map(([key, act]) => {
    const target = act.target;
    const about = [str(target.repo), int(target.pr) !== null ? `#${target.pr}` : null, str(target.session_id)]
      .filter(Boolean)
      .join(" ");
    return {
      key,
      source: "act" as const,
      tick: act.tick,
      at: act.at,
      action: about ? `${act.verb} ${about}` : `${act.verb} ${act.key}`,
      session: null,
      classId: null,
      className: null,
      evidence: str(target.role) ? `role ${target.role}` : null,
      verb: act.verb,
      review: null,
    };
  });
}

export function tickRows(
  fold: LedgerFold,
  reports: ReadonlyMap<number, ReportSummary>,
  tickDirs: readonly number[],
  now: number,
  budgetMs: number,
  limit: number,
): FleetTick[] {
  const numbers = [...new Set([...fold.ticks.keys(), ...tickDirs])].sort((a, b) => b - a).slice(0, limit);
  return numbers.map((tick) => {
    const entry = fold.ticks.get(tick);
    const report = reports.get(tick);
    return {
      tick,
      at: entry?.fireAt ?? report?.ts ?? null,
      finishedAt: entry?.exitAt ?? null,
      status: tickStatusOf(entry, now, budgetMs),
      exit: entry?.exit ?? null,
      steps: entry?.detail ?? null,
      failedStep: failedStepOf(entry?.detail ?? null),
      dryRun: entry?.dryRun ?? report?.dryRun ?? null,
      mode: report?.mode ?? null,
      classCounts: report?.classCounts ?? null,
      openAsks: report ? report.asksOpen.length : null,
      proposals: report ? report.proposals.length : null,
    };
  });
}

// ── Health ───────────────────────────────────────────────────────────────────

/** A span a person reads: "45m", "3h 12m", "2d 4h". */
export function span(msLong: number): string {
  const minutes = Math.max(0, Math.round(msLong / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

/** How long with no tick before a scheduled scope is missed: FLEET_MISSED_MS, or two intervals if longer. */
export function missedAfter(intervalMs: number | null): number {
  return Math.max(FLEET_MISSED_MS, intervalMs !== null ? 2 * intervalMs : 0);
}

function every(intervalMs: number | null): string {
  if (intervalMs === null) return "on its schedule";
  if (intervalMs === 3_600_000) return "every hour";
  return `every ${span(intervalMs)}`;
}

export interface HealthInput {
  /** The fleet's kill switch is off (tick.sh leaves `.disabled-notice` while it is). */
  disabled: boolean;
  /** A LaunchAgent runs the tick. */
  scheduled: boolean;
  intervalMs: number | null;
  /** When the LaunchAgent was written: a scope that never ticked is missed from then. */
  scheduledAt: number | null;
  /** The newest tick. */
  latest: FleetTick | null;
  /** When this host last woke from sleep; null when no sleep was seen. launchd misses ticks while the Mac sleeps. */
  awakeSince: number | null;
  now: number;
}

export function healthOf(input: HealthInput): { status: FleetHealthStatus; reason: string; since: string | null } {
  const { latest, now } = input;
  if (input.disabled) {
    return { status: "off", reason: "Off: the fleet's kill switch is set, so no tick runs.", since: null };
  }
  const startedAt = ms(latest?.at ?? null);
  if (input.scheduled) {
    const from = Math.max(startedAt ?? input.scheduledAt ?? now, input.awakeSince ?? 0);
    if (now - from > missedAfter(input.intervalMs)) {
      const quiet = span(now - (startedAt ?? input.scheduledAt ?? now));
      return {
        status: "missed",
        reason: latest
          ? `No tick for ${quiet}: the last was tick ${latest.tick}. It runs ${every(input.intervalMs)}.`
          : `No tick yet, ${quiet} after it was scheduled. It runs ${every(input.intervalMs)}.`,
        since: latest?.at ?? (input.scheduledAt !== null ? new Date(input.scheduledAt).toISOString() : null),
      };
    }
  }
  if (latest?.status === "failed") {
    return {
      status: "failing",
      reason: `Tick ${latest.tick} failed${latest.failedStep ? ` at ${latest.failedStep}` : ""}${latest.steps ? ` (${latest.steps})` : ""}.`,
      since: latest.at,
    };
  }
  if (latest?.status === "died") {
    const ago = startedAt !== null ? ` ${span(now - startedAt)} ago` : "";
    return { status: "failing", reason: `Tick ${latest.tick} started${ago} and never finished.`, since: latest.at };
  }
  if (!input.scheduled) {
    return {
      status: "unscheduled",
      reason: "Not scheduled: no LaunchAgent runs it, so it ticks only when run by hand.",
      since: null,
    };
  }
  if (!latest) return { status: "ok", reason: `Scheduled ${every(input.intervalMs)}; no tick yet.`, since: null };
  if (latest.status === "running") return { status: "ok", reason: `Tick ${latest.tick} is running.`, since: latest.at };
  return {
    status: "ok",
    reason: `Ticks ${every(input.intervalMs)}. The last, tick ${latest.tick}, ${latest.status === "ok" ? "passed" : "finished"}.`,
    since: latest.at,
  };
}

// ── The fleet's Maestro work ─────────────────────────────────────────────────

/** The marker the fleet ends its items' titles with (fleetlib/paseo_ask.py marker). */
export function markerOf(title: string): { scope: string; what: "batch" | "alert"; id: string } | null {
  const match = /\[fleet-reconcile ([a-z0-9_-]+) (batch|alert) ([^\]]+)\]$/.exec(title.trim());
  if (!match?.[1] || !match[3]) return null;
  return { scope: match[1], what: match[2] as "batch" | "alert", id: match[3] };
}

export function fleetItem(item: WorkItem): FleetItem {
  return { id: item.id, title: item.title, state: item.state, group: item.group, needsYou: needsHand(item) };
}

/** The scope's alert items that are not done or canceled, newest first. */
export function openAlerts(scope: string, items: readonly WorkItem[]): WorkItem[] {
  return items
    .filter((item) => {
      const marker = markerOf(item.title);
      return marker?.scope === scope && marker.what === "alert" && !isTerminal(item.state);
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** tick.sh alerts that stop a tick before it starts: a held lock, a bad config, an unwritable state dir, no tick number. */
const BEFORE_A_TICK = new Set(["lock", "config", "statedir", "tick"]);

/**
 * The fleet's own open alert for a scope's health, when it raised one: a
 * failed tick's `tick-<step>` alert, or for a missed tick an alert that stops
 * ticks before they start. A tick that died raises none.
 */
export function coverOf(
  scope: string,
  status: FleetHealthStatus,
  failedStep: string | null,
  items: readonly WorkItem[],
): WorkItem | null {
  const alerts = openAlerts(scope, items);
  const kind = (item: WorkItem) => markerOf(item.title)?.id ?? "";
  if (status === "failing" && failedStep) return alerts.find((item) => kind(item) === `tick-${failedStep}`) ?? null;
  if (status === "missed") return alerts.find((item) => BEFORE_A_TICK.has(kind(item))) ?? null;
  return null;
}

/** The open asks in the newest report, each with the batch that carries it and the work raised for that batch. */
export function asksOf(
  scope: string,
  asksOpen: readonly Json[],
  fold: LedgerFold,
  items: readonly WorkItem[],
): FleetAsk[] {
  const byBatch = new Map<string, WorkItem[]>();
  for (const item of items) {
    const marker = markerOf(item.title);
    if (marker?.scope !== scope || marker.what !== "batch") continue;
    byBatch.set(marker.id, [...(byBatch.get(marker.id) ?? []), item]);
  }
  const workFor = (batch: string): WorkItem | null => {
    const raised = byBatch.get(batch) ?? [];
    const recorded = fold.itemOfBatch.get(batch);
    const found = raised.find((item) => !isTerminal(item.state)) ?? raised.find((item) => item.id === recorded);
    return found ?? items.find((item) => item.id === recorded) ?? raised[0] ?? null;
  };
  return asksOpen.flatMap((ask) => {
    const key = str(ask.key);
    if (!key) return [];
    const batch = fold.batchOfAsk.get(key) ?? null;
    const work = batch ? workFor(batch) : null;
    return [
      {
        id: str(ask.id) ?? key,
        key,
        question: str(ask.question) ?? key,
        class: str(ask.class),
        firstTick: int(ask.first_tick),
        batch,
        item: work ? fleetItem(work) : null,
      },
    ];
  });
}

// ── Reviews ──────────────────────────────────────────────────────────────────

/** The review file's record kind. */
export const REVIEW_KIND = "proposal_review";

/** Each proposal's latest verdict, by key: a later review replaces an earlier one. */
export function foldReviews(records: readonly Json[], scope: string): Map<string, FleetReview> {
  const out = new Map<string, FleetReview>();
  for (const record of records) {
    const key = str(record.key);
    const verdict = REVIEW_VERDICTS.find((value) => value === record.verdict);
    const at = str(record.ts);
    if (record.kind !== REVIEW_KIND || record.scope !== scope || !key || !verdict || !at) continue;
    out.set(key, { verdict, note: str(record.note), at, tick: int(record.tick) });
  }
  return out;
}

export function withReviews(proposals: readonly FleetProposal[], reviews: ReadonlyMap<string, FleetReview>) {
  return proposals.map((proposal) => ({ ...proposal, review: reviews.get(proposal.key) ?? null }));
}

/** One line of the review file: what you decided, about which proposal, as the fleet would read it. */
export function reviewRecord(input: {
  scope: string;
  proposal: FleetProposal;
  verdict: (typeof REVIEW_VERDICTS)[number];
  note: string;
  at: Date;
}): Json {
  const { proposal } = input;
  return {
    v: 1,
    kind: REVIEW_KIND,
    id: `review-${input.at.getTime()}`,
    scope: input.scope,
    key: proposal.key,
    verdict: input.verdict,
    note: input.note.trim() || null,
    tick: proposal.tick,
    proposal: {
      source: proposal.source,
      action: proposal.action,
      session_id: proposal.session?.id ?? null,
      name: proposal.session?.name ?? null,
      class: proposal.classId,
      class_name: proposal.className,
      evidence: proposal.evidence,
      verb: proposal.verb,
    },
    by: "owner",
    via: "maestro",
    ts: input.at.toISOString(),
  };
}
