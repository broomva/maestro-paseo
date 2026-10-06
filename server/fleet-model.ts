// The Fleet view's pure model: what fleet-reconcile's files say, folded into
// ticks, a scope's health, the dry run's proposals and the asks with the work
// the fleet raised for them. The fleet's formats are its own (broomva/skills
// orchestration/fleet-reconcile: fleetlib/ledger.py, report.py, tick.sh);
// everything here reads them defensively, since a record of a kind or shape it
// does not know is skipped, never fatal. No I/O here, so every rule is tested.

import { createHash } from "node:crypto";
import type { WorkItem } from "../shared/contracts";
import {
  type AskSession,
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
import { fleetMarker, withoutMarker } from "../shared/fleet-item";
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
  /** A runner_exit record was written; `exit` is null when it carried no code. */
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
      // The first ticks wrote `exit_code`; later ones write `exit`.
      const code = typeof record.exit === "number" ? record.exit : record.exit_code;
      at.exit = typeof code === "number" ? code : null;
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

/**
 * Awake milliseconds from a wall-clock time to now: what launchd counts for
 * StartInterval, and what a tick's time budget runs on (server/fleet.ts
 * AwakeClock). `whole` is false when the count could start only later than
 * asked (before the plugin's first record): then it is a lower bound.
 */
export type AwakeFor = (fromWallMs: number) => { ms: number; whole: boolean; blind?: boolean };

/** Wall time as awake time: no sleep accounted. */
export const awakeAsWall =
  (now: number): AwakeFor =>
  (from) => ({ ms: now - from, whole: true });

/**
 * A tick with no exit is running while the time awake since it started is
 * inside its budget, and died past it. When its start is before what the
 * awake clock knows (the plugin started later), wall time decides: an
 * unfinished tick from before a reload is not given a fresh budget. With no
 * awake time at all (`blind`), one past its budget in wall time is unknown,
 * not died: a tick the Mac slept through is not called dead on a guess.
 */
export function tickStatusOf(
  entry: TickEntry | undefined,
  now: number,
  budgetMs: number,
  awakeFor: AwakeFor = awakeAsWall(now),
): TickStatus {
  if (!entry) return "unknown";
  if (entry.ended) return entry.exit === null ? "unknown" : entry.exit === 0 ? "ok" : "failed";
  const started = ms(entry.fireAt);
  if (started === null) return "unknown";
  const awake = awakeFor(started);
  if (awake.blind) return now - started <= budgetMs ? "running" : "unknown";
  return (awake.whole ? awake.ms : now - started) <= budgetMs ? "running" : "died";
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
  /** The report's sessions by id, kept small: what an ask about one names and opens. */
  sessions: Map<string, { name: string | null; agentId: string | null }>;
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
        branch: str(session.branch),
        agentId: str(session.paseo_agent),
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
    asksOpen: openAsksOf(raw),
    sessions: new Map(
      sessions.flatMap((session) => {
        const id = str(session.session_id);
        return id ? [[id, { name: str(session.name), agentId: str(session.paseo_agent) }] as const] : [];
      }),
    ),
  };
}

/**
 * The session an ask is about, from its key (`prompt:<session id>:<words>`),
 * with its name and Paseo agent from the report; a key that names a Paseo
 * agent itself opens that agent.
 */
export function askSession(
  key: string,
  sessions: ReadonlyMap<string, { name: string | null; agentId: string | null }>,
): AskSession | null {
  const id = /^prompt:([0-9a-f][0-9a-f-]{7,}):/i.exec(key)?.[1];
  if (!id) return null;
  const known = sessions.get(id);
  const asAgent = [...sessions.values()].find((session) => session.agentId === id);
  return {
    id,
    short: id.slice(0, 8),
    name: known?.name ?? asAgent?.name ?? null,
    agentId: known?.agentId ?? asAgent?.agentId ?? null,
  };
}

/**
 * One tick's lines in tick.log: from its `tick <n> scope` line up to its
 * `tick <n> done` line, or the next tick's start. Null when the log has none.
 */
export function tickLogSection(log: string, tick: number): string | null {
  const lines = log.split("\n");
  const start = lines.findIndex((line) => new RegExp(`\\] tick ${tick} scope `).test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (new RegExp(`\\] tick ${tick} done`).test(line)) {
      end = index + 1;
      break;
    }
    if (/\] tick \d+ scope /.test(line)) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trimEnd();
}

/**
 * Every ask open at the tick, as report.md counts them: still open from
 * earlier ticks (`asks_open`), new this tick (`asks`), and open but not
 * checked this tick because their surface could not be read (`asks_unchecked`).
 */
function openAsksOf(raw: Json): Json[] {
  const seen = new Set<string>();
  const out: Json[] = [];
  const tick = int(raw.tick);
  for (const list of [raw.asks_open, raw.asks, raw.asks_unchecked]) {
    for (const ask of Array.isArray(list) ? list.filter(isObject) : []) {
      const key = str(ask.key);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      // New this tick (`asks`, which carries no first_tick): this tick raised it.
      out.push(list === raw.asks && ask.first_tick === undefined && tick !== null ? { ...ask, first_tick: tick } : ask);
    }
  }
  return out;
}

/** The class table's order: 1, 2, ... 9, 9a, 10, then anything else. */
function classOrder(id: string): number {
  const n = Number.parseInt(id, 10);
  if (!Number.isFinite(n)) return 1000;
  return n * 2 + (id.endsWith("a") ? 1 : 0);
}

/**
 * What a coordinator verb would do, in words, from its intent's target
 * (fleetlib/act.py): the label and whether it adds or removes it, the mail's
 * template, the role spawned. The fleet keys a label by its PR and a mail by
 * its recipient, so these words are what tell two verbs under one key apart.
 */
export function actWords(verb: string, key: string, target: Json): string {
  const pr = str(target.repo) && int(target.pr) !== null ? `${target.repo}#${target.pr}` : null;
  const who = str(target.name) ?? str(target.session_id)?.slice(0, 8) ?? key;
  switch (verb) {
    case "label":
      return `${str(target.op) === "remove" ? "remove" : "add"} label "${str(target.label) ?? "?"}" on ${pr ?? key}`;
    case "mail":
      return `mail ${who} (${str(target.template) ?? "no template"})`;
    case "spawn":
      return `spawn a ${str(target.role) ?? "driver"} for ${pr ?? key}`;
    case "resume":
      return `resume ${who}`;
    default:
      return `${verb} ${key}`;
  }
}

/**
 * A coordinator's dry verbs as proposals: the newest of each, keyed by its
 * verb, the fleet's key and a hash of its words and text, so a different
 * label, op or mail under the same fleet key is a different proposal.
 */
export function actProposals(acts: readonly DryAct[], sinceTick: number | null): FleetProposal[] {
  const newest = new Map<string, { act: DryAct; words: string }>();
  for (const act of acts) {
    // A verb run by hand outside a tick (no tick number) is old news, not a standing proposal.
    if (sinceTick !== null && (act.tick === null || act.tick < sinceTick)) continue;
    const words = actWords(act.verb, act.key, act.target);
    const hash = createHash("sha256")
      .update(`${words}\n${str(act.target.text) ?? ""}`)
      .digest("hex")
      .slice(0, 8);
    newest.set(`act:${act.verb}:${act.key}:${hash}`, { act, words });
  }
  return [...newest.entries()].reverse().map(([key, { act, words }]) => ({
    key,
    source: "act" as const,
    tick: act.tick,
    at: act.at,
    action: words,
    session: null,
    classId: null,
    className: null,
    // The whole text: the key binds all of it, so the card shows all of it.
    evidence: str(act.target.text) ? `text: ${str(act.target.text)}` : null,
    verb: act.verb,
    review: null,
  }));
}

export function tickRows(
  fold: LedgerFold,
  reports: ReadonlyMap<number, ReportSummary>,
  tickDirs: readonly number[],
  now: number,
  budgetMs: number,
  limit: number,
  awakeFor?: AwakeFor,
): FleetTick[] {
  const numbers = [...new Set([...fold.ticks.keys(), ...tickDirs])].sort((a, b) => b - a).slice(0, limit);
  return numbers.map((tick) => {
    const entry = fold.ticks.get(tick);
    const report = reports.get(tick);
    return {
      tick,
      at: entry?.fireAt ?? report?.ts ?? null,
      finishedAt: entry?.exitAt ?? null,
      status: tickStatusOf(entry, now, budgetMs, awakeFor),
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
  /** Awake time since a wall time (AwakeFor): launchd counts its interval in it, so a missed tick is measured in it too. */
  awakeFor: AwakeFor;
  now: number;
}

export interface Health {
  status: FleetHealthStatus;
  reason: string;
  /** The reason without a running span: what a notice carries, still while the condition lasts. */
  notice: string;
  since: string | null;
}

export function healthOf(input: HealthInput): Health {
  const { latest, now } = input;
  if (input.disabled) {
    const reason = "Off: the fleet's kill switch is set, so no tick runs.";
    return { status: "off", reason, notice: reason, since: null };
  }
  const startedAt = ms(latest?.at ?? null);
  const quietFrom = startedAt ?? input.scheduledAt;
  if (input.scheduled && quietFrom !== null) {
    // A lower bound when the quiet began before the plugin's first record: never a false alarm at a reload.
    const { ms: awake, whole } = input.awakeFor(quietFrom);
    if (awake > missedAfter(input.intervalMs)) {
      const wall = now - quietFrom;
      // Said in wall time, as people read a clock; the awake part when sleep (or not knowing) took a real share of it.
      const share = `${whole ? "" : "at least "}${span(awake)} of it awake`;
      const quiet = wall - awake > 10 * 60_000 ? `${span(wall)} (${share})` : span(wall);
      const runs = `It runs ${every(input.intervalMs)}.`;
      return {
        status: "missed",
        reason: latest
          ? `No tick for ${quiet}: the last was tick ${latest.tick}. ${runs}`
          : `No tick yet, ${quiet} after it was scheduled. ${runs}`,
        notice: latest ? `No tick since tick ${latest.tick}. ${runs}` : `No tick since it was scheduled. ${runs}`,
        since: new Date(quietFrom).toISOString(),
      };
    }
  }
  if (latest?.status === "failed") {
    const failed = `Tick ${latest.tick} failed${latest.failedStep ? ` at ${latest.failedStep}` : ""}`;
    return {
      status: "failing",
      reason: `${failed}${latest.steps ? ` (${latest.steps})` : ""}.`,
      notice: `${failed}.`,
      since: latest.at,
    };
  }
  if (latest?.status === "died") {
    const ago = startedAt !== null ? ` ${span(now - startedAt)} ago` : "";
    return {
      status: "failing",
      reason: `Tick ${latest.tick} started${ago} and never finished.`,
      notice: `Tick ${latest.tick} never finished.`,
      since: latest.at,
    };
  }
  if (!input.scheduled) {
    const reason = "Not scheduled: no LaunchAgent runs it, so it ticks only when run by hand.";
    return { status: "unscheduled", reason, notice: reason, since: null };
  }
  const ok = (reason: string) => ({ status: "ok" as const, reason, notice: reason, since: latest?.at ?? null });
  if (!latest) return ok(`Scheduled ${every(input.intervalMs)}; no tick yet.`);
  if (latest.status === "running") return ok(`Tick ${latest.tick} is running.`);
  return ok(
    `Ticks ${every(input.intervalMs)}. The last, tick ${latest.tick}, ${latest.status === "ok" ? "passed" : "finished"}.`,
  );
}

// ── The fleet's Maestro work ─────────────────────────────────────────────────

/**
 * The marker the fleet ends its items' titles with (fleetlib/paseo_ask.py
 * marker), read by the one grammar every surface uses (shared/fleet-item.ts
 * fleetMarker): a batch's or an alert's, with its id.
 */
export function markerOf(title: string): { scope: string; what: "batch" | "alert"; id: string } | null {
  const mark = fleetMarker(title.trim());
  const match = mark ? /^(batch|alert) (.+)$/.exec(mark.what) : null;
  if (!mark || !match?.[1] || !match[2]) return null;
  return { scope: mark.scope, what: match[1] as "batch" | "alert", id: match[2] };
}

/** A fleet item as the Fleet tab lists it: titled as a person reads it, never with the marker. */
export function fleetItem(item: WorkItem): FleetItem {
  const title = item.display?.title || withoutMarker(item.title);
  return { id: item.id, title, state: item.state, group: item.group, needsYou: needsHand(item) };
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
 * The fleet's own alert for a scope's health, when it raised one: a failed
 * tick's `tick-<step>` alert, or for a missed tick an alert that stops ticks
 * before they start. A tick that died raises none. An open alert stands for
 * every later alert of its kind (the fleet adopts it rather than raise
 * another). For a failing tick, one closed after that tick began counts as
 * answered: you dismissed this failure. Never for a missed tick: its `since`
 * is the last tick, which stays put however many causes come and go, so an
 * answer to one cause must not silence the next.
 */
export function coverOf(
  scope: string,
  status: FleetHealthStatus,
  failedStep: string | null,
  since: string | null,
  items: readonly WorkItem[],
): { item: WorkItem; answered: boolean } | null {
  const fits = (kind: string) =>
    status === "failing"
      ? failedStep !== null && kind === `tick-${failedStep}`
      : status === "missed" && BEFORE_A_TICK.has(kind);
  const mine = items
    .filter((item) => {
      const marker = markerOf(item.title);
      return marker?.scope === scope && marker.what === "alert" && fits(marker.id);
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const open = mine.find((item) => !isTerminal(item.state));
  if (open) return { item: open, answered: false };
  if (status !== "failing") return null;
  const began = ms(since);
  const answered = mine.find((item) => began !== null && (ms(item.updatedAt) ?? 0) >= began);
  return answered ? { item: answered, answered: true } : null;
}

/** The open asks in the newest report, each with the batch that carries it and the work raised for that batch. */
export function asksOf(
  scope: string,
  asksOpen: readonly Json[],
  fold: LedgerFold,
  items: readonly WorkItem[],
  sessions: ReadonlyMap<string, { name: string | null; agentId: string | null }> = new Map(),
): FleetAsk[] {
  const byBatch = new Map<string, WorkItem[]>();
  for (const item of items) {
    const marker = markerOf(item.title);
    if (marker?.scope !== scope || marker.what !== "batch") continue;
    byBatch.set(marker.id, [...(byBatch.get(marker.id) ?? []), item]);
  }
  // The item the fleet recorded for the batch comes first: a title can be written by anyone who makes work.
  const workFor = (batch: string): WorkItem | null => {
    const recorded = items.find((item) => item.id === fold.itemOfBatch.get(batch));
    const raised = byBatch.get(batch) ?? [];
    return recorded ?? raised.find((item) => !isTerminal(item.state)) ?? raised[0] ?? null;
  };
  return asksOpen.flatMap((ask) => {
    const key = str(ask.key);
    if (!key) return [];
    const batch = fold.batchOfAsk.get(key) ?? null;
    const work = batch ? workFor(batch) : null;
    const klass = str(ask.class);
    return [
      {
        id: str(ask.id) ?? key,
        key,
        question: str(ask.question) ?? key,
        class: klass,
        className: klass ? (FLEET_CLASSES[klass] ?? null) : null,
        firstTick: int(ask.first_tick),
        session: askSession(key, sessions),
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
    // Only what Maestro wrote for you: the file is not a boundary (any process running as you can write
    // it), so this keeps lines of another shape out, not a forger.
    const yours = record.by === "owner" && record.via === "maestro";
    if (record.kind !== REVIEW_KIND || record.scope !== scope || !yours || !key || !verdict || !at) continue;
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
  /** Unique among the records made in this millisecond: a grouped verdict writes many at once. */
  seq: number;
}): Json {
  const { proposal } = input;
  return {
    v: 1,
    kind: REVIEW_KIND,
    id: `review-${input.at.getTime()}-${input.seq}`,
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
