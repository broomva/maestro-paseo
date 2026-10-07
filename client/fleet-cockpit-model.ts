// The Fleet cockpit's rules (BRO-2837): status first, the health of every
// scope, what needs you, and the sessions in scope. Every count here is read
// off what the server sent; nothing is estimated, and what the wire does not
// carry is not shown. Owner-facing words are plain: the fleet's class numbers
// and tick numbers stay in Details and the inspector's facts. No React here,
// so every rule is tested (client/fleet-cockpit-model.test.ts).

import type { Attention } from "../shared/contracts";
import {
  type DecisionAsk,
  FLEET_CLASSES,
  type FleetAsk,
  type FleetDetail,
  type FleetHealth,
  type FleetHealthStatus,
  type FleetItem,
  type FleetProposal,
  type FleetReview,
  type FleetScope,
  type FleetSession,
  type FleetTick,
  groupProposals,
  type ProposalGroup,
} from "../shared/fleet";
import { agoText, tickWhen } from "./fleet-model";
import { ago, plural } from "./format";
import { needsYouCount } from "./header-count";

/** One scope as the cockpit reads it: its summary, its detail once read, and why its read failed. */
export interface ScopeRead {
  scope: FleetScope;
  detail: FleetDetail | null;
  /** The scope's own read failed and there is no data: in words. Never dropped: the verdict and its strip say it. */
  error?: string | null;
  /** Its first read is still on its way: the verdict says "Reading…", never healthy. */
  reading?: boolean;
  /** A refetch failed while older data stands: a quiet note, not a "can't read". */
  stale?: string | null;
}

export * from "./fleet-words";

import { ageWords, displayName, nextTickAt, plainAction, plainStep } from "./fleet-words";

// ── Sessions ─────────────────────────────────────────────────────────────────

/** How the listing's state reads at a glance: the KPI tiles' buckets. */
export type Bucket = "running" | "idle" | "failed" | "other";

/** The listing's state (busy, idle, failed, blocked, done, stopped) in a tile's bucket. */
export function bucketOf(state: string | null): Bucket {
  if (state === "busy" || state === "running") return "running";
  if (state === "idle") return "idle";
  if (state === "failed" || state === "error") return "failed";
  return "other";
}

/** The state pill's word: the listing's own, `busy` said as running. */
export function stateWord(state: string | null): string {
  if (!state) return "unknown";
  return state === "busy" ? "running" : state;
}

export type Tone = "danger" | "warn" | "success" | "muted" | "info";

export function stateTone(state: string | null): Tone {
  const bucket = bucketOf(state);
  if (bucket === "running") return "info";
  if (bucket === "failed") return "danger";
  if (state === "blocked") return "warn";
  return "muted";
}

/**
 * Classes that want a look (the fleet's table, FLEET_CLASSES): dead at a
 * limit, waiting at a prompt, error, hung, blocked on you, stalled.
 */
export const ATTENTION_CLASSES: ReadonlySet<string> = new Set(["2", "3", "4", "6", "7", "9"]);
export const UNMANAGED_CLASS = "10";

/** A roster row: a session as the report of `scopeId` lists it. */
export interface RosterRow extends FleetSession {
  scopeId: string;
}

/**
 * The sessions in scope across the scopes read, each once (the first scope
 * that holds it in scope), and those no scope read holds: out of scope.
 */
export function rosterRows(reads: readonly ScopeRead[]): { inScope: RosterRow[]; out: RosterRow[] } {
  const inScope = new Map<string, RosterRow>();
  const seen = new Map<string, RosterRow>();
  for (const { scope, detail } of reads) {
    for (const session of detail?.roster?.sessions ?? []) {
      const row = { ...session, scopeId: scope.id };
      if (session.inScope && !inScope.has(session.id)) inScope.set(session.id, row);
      if (!seen.has(session.id)) seen.set(session.id, row);
    }
  }
  const out = [...seen.values()].filter((row) => !inScope.has(row.id));
  return { inScope: sortRoster([...inScope.values()]), out: sortRoster(out) };
}

const BUCKET_ORDER: Record<Bucket, number> = { failed: 0, running: 1, idle: 2, other: 3 };

/** Attention first, then failed, running, idle and the rest; the most recently active first within each. */
export function sortRoster(rows: readonly RosterRow[]): RosterRow[] {
  return [...rows].sort(
    (a, b) =>
      Number(ATTENTION_CLASSES.has(b.classId)) - Number(ATTENTION_CLASSES.has(a.classId)) ||
      BUCKET_ORDER[bucketOf(a.state)] - BUCKET_ORDER[bucketOf(b.state)] ||
      (b.activeAt ?? "").localeCompare(a.activeAt ?? ""),
  );
}

/**
 * What open fleet asks are about: the session id the key names and the Paseo
 * agent it resolved to. A key may name either (`prompt:<agent id>:…`), so a
 * row matches on its session id or its agent id.
 */
export function askedSessions(reads: readonly ScopeRead[]): Set<string> {
  const { inScope, out } = rosterRows(reads);
  const rows = [...inScope, ...out];
  return new Set(
    reads.flatMap(({ detail }) =>
      (detail?.asks ?? []).flatMap((ask) => {
        if (!ask.session) return [];
        // A key's short id links its roster row by a unique prefix (linkSession).
        const row = linkSession(ask, rows);
        return [ask.session.id, ...(ask.session.agentId ? [ask.session.agentId] : []), ...(row ? [row.id] : [])];
      }),
    ),
  );
}

export function wantsAttention(row: FleetSession, asked: ReadonlySet<string>): boolean {
  return ATTENTION_CLASSES.has(row.classId) || asked.has(row.id) || (row.agentId !== null && asked.has(row.agentId));
}

export type RosterFilter = "attention" | "unmanaged" | "running" | "idle" | "failed" | "all" | "out";

export function filterRoster(
  roster: { inScope: readonly RosterRow[]; out: readonly RosterRow[] },
  filter: RosterFilter,
  asked: ReadonlySet<string>,
): RosterRow[] {
  const rows = roster.inScope;
  switch (filter) {
    case "attention":
      return rows.filter((row) => wantsAttention(row, asked));
    case "unmanaged":
      return rows.filter((row) => row.classId === UNMANAGED_CLASS);
    case "running":
    case "idle":
    case "failed":
      return rows.filter((row) => bucketOf(row.state) === filter);
    case "out":
      return [...roster.out];
    default:
      return [...rows];
  }
}

/** How many each filter shows: a tile's number is the size of what it filters to. */
export function rosterCounts(
  roster: { inScope: readonly RosterRow[]; out: readonly RosterRow[] },
  asked: ReadonlySet<string>,
): Record<RosterFilter, number> & { unplaced: number; blocked: number } {
  const count = (filter: RosterFilter) => filterRoster(roster, filter, asked).length;
  return {
    attention: count("attention"),
    unmanaged: count("unmanaged"),
    running: count("running"),
    idle: count("idle"),
    failed: count("failed"),
    all: roster.inScope.length,
    out: roster.out.length,
    unplaced: roster.out.filter((row) => row.placement === "unplaced" || row.scope === null).length,
    blocked: roster.inScope.filter((row) => row.state === "blocked").length,
  };
}

/** The oldest last activity among `rows`, as `oldest 27 d ago`; null when none says. */
export function oldestText(rows: readonly FleetSession[], now: number = Date.now()): string | null {
  const times = rows.flatMap((row) => (row.activeAt ? [Date.parse(row.activeAt)] : [])).filter(Number.isFinite);
  if (times.length === 0) return null;
  const age = ageWords(new Date(Math.min(...times)).toISOString(), now);
  return age ? (age === "now" ? "active now" : `oldest ${age} ago`) : null;
}

// ── Needs you ────────────────────────────────────────────────────────────────

/**
 * One card. Counted cards (Needs you) are exactly the fleet's share of the
 * header's "N need you" (client/header-count.ts): a scope's missed or failing
 * tick, an alert or ask batch the fleet raised as work that needs you
 * (needsHand), and a decision ask that waits on you (shared/fleet.ts
 * `waiting`). Everything else the fleet holds open is shown, uncounted.
 */
export type QueueCard =
  | { kind: "health"; key: string; scope: string; health: FleetHealth }
  | { kind: "alert"; key: string; scope: string; item: FleetItem }
  /** An ask, or a raised batch: `asks` every ask the batch's item carries (one card per item). */
  | { kind: "ask"; key: string; scope: string; ask: FleetAsk; asks: FleetAsk[] }
  /** One decision ask that waits on you. */
  | { kind: "decision"; key: string; scope: string; ask: DecisionAsk }
  /** The scope's other decision asks, open and answered: listed, never counted. */
  | { kind: "decisions"; key: string; scope: string; asks: DecisionAsk[]; open: number }
  | { kind: "proposal"; key: string; scope: string; group: ProposalGroup };

/** How long a verdict you gave stays on its card, so the card can say so. */
export const ANSWERED_SHOWN_MS = 60 * 60 * 1000;

/**
 * What the fleet needs from you: the one selector the health band, the
 * Needs-you tile, the Needs-you section and the fleet's share of the header
 * count all read. It counts what the header counts, each once:
 * - `ticks`: scopes whose tick needs you (FleetHealth.needsYou, a FleetNotice);
 * - `alerts`: the fleet's alert items that need you (needsHand);
 * - `asks`: the fleet's ask batches raised as work that needs you, one per
 *   item however many asks it carries;
 * - `decisions`: decision asks in the fleet's own roots that wait on you
 *   (`waiting`, the contract's isWaiting), one each.
 * `sessions` (in-scope sessions that want a look) is named beside it and never
 * in `total`: the header does not count sessions.
 */
export interface FleetNeeds {
  cards: QueueCard[];
  /** What the fleet holds open that does not need you now: listed, uncounted. */
  also: QueueCard[];
  ticks: number;
  alerts: number;
  asks: number;
  decisions: number;
  total: number;
  sessions: number;
}

export function fleetNeedsYou(reads: readonly ScopeRead[]): FleetNeeds {
  const cards: QueueCard[] = [];
  const also: QueueCard[] = [];
  const answered: QueueCard[] = [];
  for (const { scope, detail } of reads) {
    const id = scope.id;
    if (scope.health.needsYou) cards.push({ kind: "health", key: `health:${id}`, scope: id, health: scope.health });
    if (!detail) continue;
    for (const item of detail.alerts) {
      (item.needsYou ? cards : also).push({ kind: "alert", key: `alert:${id}:${item.id}`, scope: id, item });
    }
    // One card per raised item that needs you, carrying all its asks; an ask not raised yet (or whose
    // work does not need you) is shown apart, uncounted.
    const byItem = new Map<string, FleetAsk[]>();
    for (const ask of detail.asks) {
      if (ask.item?.needsYou) byItem.set(ask.item.id, [...(byItem.get(ask.item.id) ?? []), ask]);
      else also.push({ kind: "ask", key: `ask:${id}:${ask.batch}:${ask.key}`, scope: id, ask, asks: [ask] });
    }
    for (const [item, asks] of byItem) {
      const [first] = asks;
      if (first) cards.push({ kind: "ask", key: `item:${id}:${item}`, scope: id, ask: first, asks });
    }
    for (const ask of detail.decisions.filter((entry) => entry.waiting)) {
      cards.push({ kind: "decision", key: `decision:${id}:${ask.ledger}:${ask.uid ?? ask.id}`, scope: id, ask });
    }
    const rest = detail.decisions.filter((entry) => !entry.waiting);
    const open = rest.filter((entry) => entry.state === "open").length;
    if (rest.length > 0) {
      (open > 0 ? also : answered).push({ kind: "decisions", key: `decisions:${id}`, scope: id, asks: rest, open });
    }
  }
  const count = (kind: QueueCard["kind"]) => cards.filter((card) => card.kind === kind).length;
  const ticks = count("health");
  const alerts = count("alert");
  const asks = count("ask");
  const decisions = count("decision");
  const { inScope, out } = rosterRows(reads);
  const asked = askedSessions(reads);
  const sessions = filterRoster({ inScope, out }, "attention", asked).length;
  return {
    cards,
    also: [...also, ...answered],
    ticks,
    alerts,
    asks,
    decisions,
    total: ticks + alerts + asks + decisions,
    sessions,
  };
}

/**
 * The header's "N need you", split the way the Fleet view says it: the
 * fleet's share (here) and each other surface's, from the very pieces the
 * header counts (header-count.ts needsYouCount over work.attention): work
 * that needs you, fleet notices, timeline notices, decision asks that wait
 * (a fleet root's are the fleet's, the workspace's are Decisions'),
 * initiatives, and the answers batch (Decisions'). `fleetItems`: the ids of the fleet's own work (its alerts and
 * raised asks), which the header counts among the work.
 */
export interface HeaderShares {
  total: number;
  fleet: number;
  work: number;
  decisions: number;
  timeline: number;
  initiatives: number;
}

export function headerShares(
  attention: Pick<Attention, "waiting" | "fleet" | "timeline" | "asks" | "initiatives" | "answers">,
  fleetItems: ReadonlySet<string>,
): HeaderShares {
  const waiting = attention.waiting;
  const fleetNotices = attention.fleet ?? [];
  const timeline = attention.timeline ?? [];
  const asks = attention.asks ?? [];
  const initiatives = attention.initiatives ?? [];
  const answers = attention.answers ?? [];
  const total = needsYouCount(waiting, fleetNotices, timeline, asks, initiatives, answers);
  const fleetWork = needsYouCount(waiting.filter((item) => fleetItems.has(item.id)));
  const fleetAsks = asks.filter((ask) => ask.scope !== null);
  return {
    total,
    fleet: fleetWork + fleetNotices.length + fleetAsks.length,
    work: needsYouCount(waiting.filter((item) => !fleetItems.has(item.id))),
    decisions: asks.length - fleetAsks.length + answers.length,
    timeline: timeline.length,
    initiatives: initiatives.length,
  };
}

/** The fleet's own work items in Needs you: what the header counts among the work as the fleet's. */
export function fleetItemIds(needs: Pick<FleetNeeds, "cards">): Set<string> {
  return new Set(
    needs.cards.flatMap((card) =>
      card.kind === "alert" ? [card.item.id] : card.kind === "ask" && card.ask.item ? [card.ask.item.id] : [],
    ),
  );
}

/**
 * Teach the fleet: the proposals still waiting on your verdict, and those you
 * gave one in the last hour (so the card can say so). Never counted: under
 * dry run a verdict changes nothing.
 */
export function teachQueue(
  reads: readonly ScopeRead[],
  now: number = Date.now(),
): Extract<QueueCard, { kind: "proposal" }>[] {
  return reads.flatMap(({ scope, detail }) =>
    groupProposals(detail?.proposals ?? [])
      .filter((group) => group.review === null || now - Date.parse(group.review.at) < ANSWERED_SHOWN_MS)
      .map((group) => ({
        kind: "proposal" as const,
        key: `proposal:${scope.id}:${group.key}`,
        scope: scope.id,
        group,
      })),
  );
}

/** The proposal groups you gave a verdict before the last hour: behind "Show reviewed". */
export function reviewedGroups(
  reads: readonly ScopeRead[],
  now: number = Date.now(),
): { scope: string; group: ProposalGroup }[] {
  return reads.flatMap(({ scope, detail }) =>
    groupProposals(detail?.proposals ?? [])
      .filter((group) => group.review !== null && now - Date.parse(group.review.at) >= ANSWERED_SHOWN_MS)
      .map((group) => ({ scope: scope.id, group })),
  );
}

/** What the count counts, in words: `1 tick · 2 asks · 1 alert · 3 decisions`. */
export function needsText(needs: Pick<FleetNeeds, "ticks" | "asks" | "alerts" | "decisions">): string {
  const parts = [
    needs.ticks > 0 ? plural(needs.ticks, "tick") : null,
    needs.asks > 0 ? plural(needs.asks, "ask") : null,
    needs.alerts > 0 ? plural(needs.alerts, "alert") : null,
    needs.decisions > 0 ? plural(needs.decisions, "decision") : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "nothing waits on you";
}

/**
 * A proposal group's title, plain: `Would list 4 unmanaged sessions in its
 * report — nothing is done`; one session by its name.
 */
export function proposalTitle(group: ProposalGroup): string {
  const [first] = group.proposals;
  const count = group.proposals.length;
  const kind = group.className && !/^\d/.test(group.className) ? `${group.className} ` : "";
  const who =
    count === 1 && first?.session
      ? displayName(first.session.name ?? first.session.short)
      : count === 1 && first?.verb
        ? ""
        : `${count} ${kind}${count === 1 ? "session" : "sessions"}`;
  const action = group.action;
  if (action === "report only" || action === "report") return `Would list ${who} in its report — nothing is done`;
  if (/^report; no spawns in the scope until the reset/.test(action)) {
    return `Would list ${who}; no new sessions until the usage limit resets`;
  }
  return `Would ${action}${who ? ` ${who}` : ""}`;
}

/**
 * The session an ask is about, in the roster: its id as the ask's key gives
 * it is often a short prefix of the session's UUID or its Paseo agent's.
 * Linked only by a unique match; two candidates link neither.
 */
export function linkSession(ask: Pick<FleetAsk, "session">, rows: readonly RosterRow[]): RosterRow | null {
  const id = ask.session?.id?.toLowerCase();
  if (!id) return null;
  const exact = rows.filter((row) => row.id.toLowerCase() === id || row.agentId?.toLowerCase() === id);
  if (exact.length === 1) return exact[0] ?? null;
  if (id.length < 8) return null;
  const prefix = rows.filter(
    (row) => row.id.toLowerCase().startsWith(id) || (row.agentId?.toLowerCase().startsWith(id) ?? false),
  );
  return prefix.length === 1 ? (prefix[0] ?? null) : null;
}

// ── The health strip ─────────────────────────────────────────────────────────

/**
 * A cell's kind. There is no "late": the wall-clock gap between two ticks
 * includes sleep, and the server judges lateness in awake time (`missed`), so
 * only its judgement is painted.
 */
export type CellKind = "passed" | "missed" | "failed" | "running" | "unknown" | "empty";

export interface Cell {
  kind: CellKind;
  tick: number | null;
  at: string | null;
  /** What a screen reader says for it: never the color alone. */
  label: string;
}

/** Each kind's glyph: failed and missed read by shape as well as color. */
export const CELL_GLYPH: Partial<Record<CellKind, string>> = { failed: "×", missed: "!", unknown: "?" };

export const CELL_LEGEND: { kind: CellKind; label: string }[] = [
  { kind: "passed", label: "passed" },
  { kind: "failed", label: "failed" },
  { kind: "missed", label: "missed" },
  { kind: "running", label: "running" },
  { kind: "unknown", label: "no exit recorded" },
];

/**
 * The scope's last `n` ticks as cells, oldest first; a scope whose health is
 * `missed` ends on a missed cell. Fewer ticks than cells: empty cells first,
 * so the newest is always on the right.
 */
export function healthCells(
  ticks: readonly FleetTick[],
  health: Pick<FleetHealth, "status" | "since">,
  n = 24,
  now: number = Date.now(),
): Cell[] {
  const missed = health.status === "missed";
  const shown = [...ticks].slice(0, missed ? n - 1 : n).reverse();
  const cells: Cell[] = shown.map((tick) => {
    const when = tick.at ? tickWhen(tick.at, now) : "time unknown";
    if (tick.status === "failed" || tick.status === "died") {
      const words =
        tick.status === "died" ? "never finished" : `failed${tick.failedStep ? ` at ${tick.failedStep}` : ""}`;
      return { kind: "failed", tick: tick.tick, at: tick.at, label: `Tick ${tick.tick}, ${words}, ${when}` };
    }
    if (tick.status === "running") {
      return { kind: "running", tick: tick.tick, at: tick.at, label: `Tick ${tick.tick}, running, ${when}` };
    }
    if (tick.status === "unknown") {
      return { kind: "unknown", tick: tick.tick, at: tick.at, label: `Tick ${tick.tick}, no exit recorded, ${when}` };
    }
    return { kind: "passed", tick: tick.tick, at: tick.at, label: `Tick ${tick.tick}, passed, ${when}` };
  });
  if (missed) {
    const since = health.since ? ago(health.since, now) : "";
    cells.push({ kind: "missed", tick: null, at: null, label: `No tick: missed${since ? ` for ${since}` : ""}` });
  }
  const empty: Cell[] = Array.from({ length: Math.max(0, n - cells.length) }, () => ({
    kind: "empty" as const,
    tick: null,
    at: null,
    label: "No tick recorded",
  }));
  return [...empty, ...cells];
}

/** The strip's time axis: the oldest tick's time, the middle one's, and the newest's. */
export function cellAxis(cells: readonly Cell[], now: number = Date.now()): string[] {
  const timed = cells.filter((cell) => cell.at);
  if (timed.length === 0) return [];
  const pick = [timed[0], timed[Math.floor((timed.length - 1) / 2)], timed[timed.length - 1]];
  const words = pick.map((cell) => tickWhen(cell?.at ?? null, now));
  return [...new Set(words)];
}

export interface Verdict {
  tone: "danger" | "warn" | "success" | "muted";
  icon: string;
  title: string;
  sentence: string;
}

/** What else the verdict weighs beside the ticks: what needs you (fleetNeedsYou), and sessions that want a look. */
export interface VerdictLoad {
  /** fleetNeedsYou's total and its words: the same number the tile, the section and the header count. */
  needs: number;
  needsText?: string;
  /** In-scope sessions that want a look (the Attention filter); never "need you": the header does not count them. */
  sessions: number;
  failed?: number;
  blocked?: number;
}

const names = (scopes: readonly { id: string }[]) => scopes.map((scope) => scope.id).join(" and ");
const RANK: Record<Verdict["tone"], number> = { danger: 3, warn: 2, muted: 1, success: 0 };

/**
 * The health band's verdict. It leads with the problem and never overclaims:
 * it is "healthy" (success) only when every scope was read, ticks on time,
 * nothing needs you (fleetNeedsYou) and no session wants a look. Each
 * scope that cannot be read, is failing, missed its tick, is paused or is not
 * scheduled is named; sessions that want a look are named whatever the
 * scope's state (a paused scope never hides them); a scope still loading says
 * "Reading…". The tone is the worst of them.
 */
export function verdictOf(
  reads: readonly ScopeRead[],
  cells: ReadonlyMap<string, readonly Cell[]>,
  all: boolean,
  load: VerdictLoad = { needs: 0, sessions: 0 },
): Verdict {
  const scopes = reads.map((read) => read.scope);
  const having = (status: FleetHealthStatus) => scopes.filter((scope) => scope.health.status === status);
  const unread = reads.filter((read) => read.error).map((read) => read.scope);
  const reading = reads.filter((read) => read.reading && !read.error).map((read) => read.scope);
  const failing = having("failing");
  const missed = having("missed");
  const off = having("off");
  const unscheduled = having("unscheduled");
  const dry = scopes.length > 0 && scopes.every((scope) => scope.dryRun === true);
  const parts: { tone: Verdict["tone"]; icon: string; title: string; sentence: string }[] = [];
  if (unread.length > 0) {
    const first = reads.find((read) => read.error);
    parts.push({ tone: "danger", icon: "EyeOff", title: `Can't read ${names(unread)}`, sentence: `${first?.error}.` });
  }
  if (failing[0]) {
    const title = `${names(failing)} ${failing.length > 1 ? "are" : "is"} failing`;
    parts.push({ tone: "danger", icon: "CircleX", title, sentence: failing[0].health.reason });
  }
  if (missed[0]) {
    const title = `${names(missed)} missed ${missed.length > 1 ? "their ticks" : "its tick"}`;
    parts.push({ tone: "danger", icon: "Clock", title, sentence: missed[0].health.reason });
  }
  if (load.needs > 0) {
    parts.push({
      tone: "warn",
      icon: "Inbox",
      title: `${load.needs} ${load.needs === 1 ? "needs" : "need"} you`,
      sentence: `Needs you: ${load.needsText ?? plural(load.needs, "thing")}.`,
    });
  }
  if (load.sessions > 0) {
    const detail = [
      load.failed ? `${load.failed} failed` : null,
      load.blocked ? `${load.blocked} blocked` : null,
    ].filter(Boolean);
    parts.push({
      tone: "warn",
      icon: "TriangleAlert",
      title: `${plural(load.sessions, "session")} ${load.sessions === 1 ? "wants" : "want"} a look`,
      sentence: `${plural(load.sessions, "session")} in scope ${load.sessions === 1 ? "wants" : "want"} a look${
        detail.length > 0 ? ` (${detail.join(", ")})` : ""
      }: see the sessions below.`,
    });
  }
  if (off.length > 0) {
    const title = off.length === scopes.length ? "Fleet paused" : `${names(off)} paused`;
    parts.push({
      tone: "warn",
      icon: "Pause",
      title,
      sentence: "The kill switch is off: no tick runs, by your choice.",
    });
  }
  if (unscheduled.length > 0) {
    const title = unscheduled.length === scopes.length ? "Not scheduled" : `${names(unscheduled)} not scheduled`;
    parts.push({
      tone: "muted",
      icon: "CalendarOff",
      title,
      sentence: `${names(unscheduled)} ticks only when run by hand.`,
    });
  }
  if (reading.length > 0) {
    parts.push({ tone: "muted", icon: "Loader", title: `Reading ${names(reading)}…`, sentence: "" });
  }
  const shown = scopes.flatMap((scope) => cells.get(scope.id) ?? []).filter((cell) => cell.tick !== null);
  const passed = shown.filter((cell) => cell.kind === "passed").length;
  const tally = shown.length > 0 ? ` ${passed} of ${plural(shown.length, "tick")} shown passed.` : "";
  const dryWords = dry ? " Dry run: nothing was acted on." : "";
  const subject = all
    ? scopes.length === 2
      ? "Both scopes"
      : scopes.length > 2
        ? "All scopes"
        : (scopes[0]?.id ?? "The fleet")
    : (scopes[0]?.id ?? "The fleet");
  const many = subject === "Both scopes" || subject === "All scopes";
  // The ticks are on time when no scope is unread, failing, missed, paused or still loading.
  const ticksFine = unread.length + failing.length + missed.length + off.length + reading.length === 0;
  if (parts.length === 0) {
    return {
      tone: "success",
      icon: "Check",
      title: all || scopes.length !== 1 ? "Fleet healthy" : `${subject} healthy`,
      sentence: `${subject} ${many ? "tick" : "ticks"} on time.${tally}${dryWords}`,
    };
  }
  // The worst first (stable within a tone), the good news last and only when it is true.
  const ordered = [...parts].sort((a, b) => RANK[b.tone] - RANK[a.tone]);
  const worst = ordered[0] as (typeof parts)[number];
  const titles = ordered.map((part) => part.title);
  if (ticksFine && unscheduled.length < scopes.length) titles.push("ticks on time");
  return {
    tone: worst.tone,
    icon: worst.icon,
    title: titles.join(" · "),
    sentence: `${ordered
      .map((part) => part.sentence)
      .filter(Boolean)
      .join(" ")}${tally}${dryWords}`.trim(),
  };
}

/** The mode badge: `Dry run · report only`, `Live · act`. */
export function modeBadge(scopes: readonly Pick<FleetScope, "mode" | "dryRun">[]): string | null {
  if (scopes.length === 0) return null;
  const dry = new Set(scopes.map((scope) => scope.dryRun));
  const modes = new Set(scopes.map((scope) => scope.mode));
  const run = dry.size > 1 ? "Mixed" : dry.has(true) ? "Dry run" : dry.has(false) ? "Live" : null;
  const [only] = [...modes];
  const mode = modes.size > 1 ? "mixed modes" : only === "report" ? "report only" : only ? `${only} mode` : null;
  return [run, mode].filter(Boolean).join(" · ") || null;
}

/** The cadence: `Hourly · next tick in 29 min`, `Every 30 min · tick due`, or `By hand only`. */
export function cadenceText(
  schedule: FleetDetail["schedule"] | null,
  lastAt: string | null,
  now: number = Date.now(),
): string | null {
  if (!schedule) return null;
  if (!schedule.scheduled) return "By hand only";
  const every = schedule.intervalMinutes;
  if (!every) return "Scheduled";
  const how = every === 60 ? "Hourly" : every % 60 === 0 ? `Every ${every / 60}h` : `Every ${every} min`;
  const next = nextTickAt(schedule, lastAt);
  if (next === null) return how;
  if (next - now <= 0) return `${how} · tick due`;
  return `${how} · next tick in ${Math.max(1, Math.round((next - now) / 60_000))} min`;
}

// ── The latest tick ──────────────────────────────────────────────────────────

export interface TickStep {
  name: string;
  rc: number | null;
  /** Ran and passed; false for a non-zero exit. */
  ok: boolean;
  /** It ran but did nothing, in its own words (`not run (prototype)`). */
  skipped: boolean;
  detail: string;
}

/**
 * The tick's steps in the order it ran them, from its runner's words
 * (`recover=0 observe=0 ...`), each with one plain line: what tick.log says it
 * did, else what its report counts, else its exit.
 */
export function tickSteps(tick: FleetTick, said: Readonly<Record<string, string>> = {}): TickStep[] {
  if (!tick.steps) return [];
  const counts = tick.classCounts;
  const total = counts?.reduce((sum, count) => sum + count.count, 0) ?? null;
  const out = counts?.find((count) => count.id === "1")?.count ?? 0;
  return [...tick.steps.matchAll(/([a-z-]+)=(-?\d+)/g)].map(([, name = "", code = ""]) => {
    const rc = Number.parseInt(code, 10);
    const words = said[name] ?? (name === "compare" ? said["core-compare"] : undefined);
    const skipped = words !== undefined && /^not run\b/.test(words);
    let detail = words !== undefined ? plainStep(name, words) : rc === 0 ? "passed" : `exit ${rc}`;
    if (!words && name === "observe" && total !== null) detail = `${plural(total, "session")} seen`;
    if (!words && name === "report" && total !== null) detail = `${total - out} in scope · ${out} out`;
    if (!words && name === "ask" && tick.openAsks !== null) detail = plural(tick.openAsks, "open ask");
    if (rc !== 0) detail = `exit ${rc}${words ? `: ${plainStep(name, words)}` : ""}`;
    return { name, rc: Number.isFinite(rc) ? rc : null, ok: rc === 0, skipped: skipped && rc === 0, detail };
  });
}

/** `Tick 108 · 18:24 · took 10 s`. */
export function tickLine(tick: FleetTick, now: number = Date.now()): string {
  const took =
    tick.at && tick.finishedAt
      ? Math.max(0, Math.round((Date.parse(tick.finishedAt) - Date.parse(tick.at)) / 1000))
      : null;
  const tookWords = took === null ? null : took < 120 ? `took ${took} s` : `took ${Math.round(took / 60)} min`;
  return [`Tick ${tick.tick}`, tickWhen(tick.at, now), tookWords].filter(Boolean).join(" · ");
}

/** The scope whose latest tick the side card shows: one that is failing or missed first, else the newest tick. */
export function featuredScope(reads: readonly ScopeRead[]): ScopeRead | null {
  const bad = reads.find((read) => read.scope.health.status === "failing" || read.scope.health.status === "missed");
  if (bad) return bad;
  return [...reads].sort((a, b) => (b.scope.lastTick?.at ?? "").localeCompare(a.scope.lastTick?.at ?? ""))[0] ?? null;
}

// ── A session ────────────────────────────────────────────────────────────────

/** Your verdict on a proposal: `You agreed 2h ago`. */
export function agreeText(review: FleetReview | null, now: number = Date.now()): string {
  if (!review) return "Waiting on your verdict";
  const verb = review.verdict === "accept" ? "You agreed" : "You disagreed";
  const at = agoText(review.at, now);
  return `${verb}${at ? ` ${at}` : ""}${review.note ? `: ${review.note}` : ""}`;
}

/** What a verdict does, in the owner's words: under dry run it teaches the fleet and changes nothing. */
export function verdictNote(dryRun: boolean | null): string {
  return dryRun === false
    ? "Your verdict is recorded for the fleet; it does not change what the fleet does."
    : dryRun === true
      ? "Your verdict teaches the fleet; it changes nothing now: the fleet runs dry."
      : "Your verdict teaches the fleet; it does not change what the fleet does.";
}

/** The roster's "The fleet would…" line: its action in plain words, and your verdict on it when you gave one. */
export function wouldText(
  row: Pick<FleetSession, "action">,
  proposal: FleetProposal | null,
  now: number = Date.now(),
): string {
  const words = plainAction(row.action);
  if (words === "Nothing" || !proposal?.review) return words;
  const verb = proposal.review.verdict === "accept" ? "you agreed" : "you disagreed";
  return `${words} · ${verb} ${agoText(proposal.review.at, now) ?? ""}`.trim();
}

/** The work's title when a session is adopted: its name, else its short id, else its id; never empty. */
export function adoptTitle(row: Pick<FleetSession, "name" | "short" | "id">): string {
  return row.name?.trim() || row.short?.trim() || row.id;
}

/** Whether a session can be adopted from here: a Paseo agent, in a scope shown. */
export function canAdopt(row: Pick<FleetSession, "agentId" | "inScope">): boolean {
  return row.agentId !== null && row.inScope;
}

/** Each session's proposal in the scopes read, by session id. */
export function proposalsBySession(reads: readonly ScopeRead[]): Map<string, FleetProposal> {
  const out = new Map<string, FleetProposal>();
  for (const { detail } of reads) {
    for (const proposal of detail?.proposals ?? []) {
      if (proposal.session && !out.has(proposal.session.id)) out.set(proposal.session.id, proposal);
    }
  }
  return out;
}

/** A path as the roster shows it: the last two folders under a long one (`…/worktrees/stingy-seal`). */
export function shortPath(path: string | null, keep = 2): string | null {
  if (!path) return null;
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= keep + 1) return path;
  return `…/${parts.slice(-keep).join("/")}`;
}

/** The inspector's history line: how many of the ticks read listed it, and in which classes. */
export function historyText(history: FleetSession["history"]): string {
  const listed = history.filter((entry) => entry.classId !== null);
  if (history.length === 0) return "Out of scope: the fleet keeps no history for it.";
  if (listed.length === 0) return `Not listed in the last ${plural(history.length, "tick")} read.`;
  const counts = new Map<string, number>();
  for (const entry of listed) counts.set(entry.classId as string, (counts.get(entry.classId as string) ?? 0) + 1);
  const classes = [...counts.entries()].map(([id, count]) => `${FLEET_CLASSES[id] ?? id} on ${count}`).join(", ");
  return `Listed at ${listed.length} of the last ${plural(history.length, "tick")}: ${classes}.`;
}

/** A class's kind in the inspector's strip, each with its own paint and legend entry. */
export type HistoryKind = "error" | "attention" | "running" | "unmanaged" | "quiet" | "unlisted";

export function historyKind(classId: string | null): HistoryKind {
  if (classId === null) return "unlisted";
  if (classId === "4" || classId === "2" || classId === "6") return "error";
  if (ATTENTION_CLASSES.has(classId)) return "attention";
  if (classId === "5") return "running";
  if (classId === UNMANAGED_CLASS) return "unmanaged";
  return "quiet";
}

/** Each history kind's glyph: error and attention read by shape as well as color. */
export const HISTORY_GLYPH: Partial<Record<HistoryKind, string>> = { error: "×", attention: "!" };

export const HISTORY_LEGEND: { kind: HistoryKind; label: string }[] = [
  { kind: "running", label: "running" },
  { kind: "error", label: "error, dead or hung" },
  { kind: "attention", label: "wants a look" },
  { kind: "unmanaged", label: "unmanaged" },
  { kind: "quiet", label: "idle or closed" },
  { kind: "unlisted", label: "not listed" },
];

/**
 * Whether an ask's body is long enough to clamp. One predicate decides both the
 * clamp and its "Show all", so text is never clamped without a way to read it;
 * the lengths are well past what the clamped lines hold at either width.
 */
export function clampedBody(body: string | null | undefined, phone: boolean): boolean {
  return Boolean(body) && (body as string).length > (phone ? 160 : 300);
}
