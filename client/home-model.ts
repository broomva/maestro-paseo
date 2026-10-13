// J1, the Feed home on the desktop (BRO-3035; docs/design/next/j1-feed-home.png), as a pure
// model: Maestro's header (five tabs with their counts, the workspace menu), the scope bar's
// kind chips, the four glance tiles, the main column (holds as full cards, then what you watch
// as rows: Finished, Health, Running, Queued), the rail (Decide, Handled for you, Proposals),
// and the inspector's item for whatever is selected. The view (client/home.tsx) only draws it.
//
// Every count reads a projection and nothing is summed here (view-models.md, invariants 1 and 2):
// the Feed tab, the Needs you tile and an unfiltered Needs you section are needs.list's total, the
// header button's number; the tab badges are header-count.ts tabBadges; Handled today is
// handled.list's `today`; Running is the work whose state is `running` (invariant 4). The
// filters (workspace, kind chip, search) narrow the main column only, never a tile or a tab.

import type { Scoreboard, WorkItem } from "../shared/contracts";
import type { DecisionAsk } from "../shared/fleet";
import {
  type Handled,
  holdOf,
  KIND_WORDS,
  kindWords,
  type NeedKind,
  type NeedRow,
  type Needs,
  workKey,
} from "../shared/needs";
import { runningOf, sectionOf } from "../shared/needs-you";
import type { NoticeRow, Notices } from "../shared/notices";
import { ticketOf } from "../shared/text";
import { forTheConductor, headlineOf, ledgerName, ledgerOf, silenceOf } from "./decisions-model";
import {
  type DecideRow,
  decideOf,
  type HandledGroup,
  handledForYou,
  handledGroups,
  matchesQuery,
  type NeedEntry,
  needsSection,
} from "./feed-model";
import { ago, basename, duration, plural } from "./format";
import { type TabBadge, tabBadges } from "./header-count";
import type { MaestroIntent } from "./intent";
import type { Choice, InspectorItem, SessionRef } from "./kit/inspector";
import { waitWords } from "./loop-model";
import type { PlaneView } from "./plane-model";
import { stuckText, workerText } from "./plane-model";
import { placeText, titleText } from "./records-text";

// ── The header's tabs ────────────────────────────────────────────────────────

export const HOME_TABS = [
  { id: "feed", label: "Feed", icon: "Inbox" },
  { id: "decisions", label: "Decisions", icon: "MessagesSquare" },
  { id: "work", label: "Work", icon: "LayoutList" },
  { id: "health", label: "Health", icon: "Activity" },
  { id: "initiatives", label: "Initiatives", icon: "Target" },
] as const;
export type HomeTab = (typeof HOME_TABS)[number]["id"];

/**
 * The views each tab opens, the first its default. J1 is the Feed; until J2–J9 (BRO-3036) the
 * other tabs open today's views: Work its Board, List and History, Health the Fleet, the Timeline
 * and Loops.
 */
export const TAB_VIEWS: Record<HomeTab, readonly PlaneView[]> = {
  feed: ["feed"],
  decisions: ["decisions"],
  work: ["board", "list", "history"],
  health: ["health", "fleet", "timeline", "loops"],
  initiatives: ["initiatives"],
};

/** The tab a view sits under. */
export function tabOfView(view: PlaneView): HomeTab {
  for (const tab of HOME_TABS) if (TAB_VIEWS[tab.id].includes(view)) return tab.id;
  return "feed";
}

/**
 * The five tabs' badges. Feed, Decisions and Initiatives are needs.list's (tabBadges: the
 * total, the holds Decisions lists, the due reviews); Work is the running work, plain; Health
 * is the Health rows J1 lists, warn. A tab with none carries none.
 */
export function homeBadges(
  needs: Pick<Needs, "rows" | "summary"> | null,
  running: number,
  health: number,
): Record<HomeTab, TabBadge | null> {
  const fromNeeds = needs ? tabBadges(needs) : { feed: null, decisions: null, initiatives: null };
  return {
    ...fromNeeds,
    work: running > 0 ? { count: running, warn: false, label: `${running} running` } : null,
    health: health > 0 ? { count: health, warn: true, label: `${plural(health, "watched item")}` } : null,
  };
}

// ── Workspaces and filters ───────────────────────────────────────────────────

/** The workspace a work item belongs to, by the rule needs.list names a work hold's scope with (server/needs.ts scopeOf). */
export function workScope(item: Pick<WorkItem, "display" | "project" | "repo" | "initiative">): string {
  return (
    item.display?.fleet?.scope ??
    item.project ??
    (item.repo ? basename(item.repo) : null) ??
    item.initiative ??
    "maestro"
  );
}

export interface WorkspaceOption {
  /** null: all workspaces. */
  id: string | null;
  label: string;
  /** Its holds: needs.list's rows in it (all of them for All). */
  holds: number;
}

/** The workspace menu: All, then each workspace that holds something or has work, those with holds first. */
export function workspaceOptions(rows: readonly NeedRow[], items: readonly WorkItem[]): WorkspaceOption[] {
  const holds = new Map<string, number>();
  for (const row of rows) holds.set(row.scope, (holds.get(row.scope) ?? 0) + 1);
  const names = new Set<string>([...holds.keys(), ...items.map(workScope)]);
  const named = [...names]
    .map((id) => ({ id, label: id, holds: holds.get(id) ?? 0 }))
    .sort((a, b) => b.holds - a.holds || a.label.localeCompare(b.label));
  return [{ id: null, label: "All workspaces", holds: rows.length }, ...named];
}

export const KIND_FILTERS = ["all", "ask", "approval", "owner_step", "health", "finished"] as const;
export type KindFilter = (typeof KIND_FILTERS)[number];

export interface KindChip {
  id: KindFilter;
  label: string;
  count: number;
}

/**
 * The scope bar's chips: All, then each kind of hold by needs.list's summary (A1's three), then
 * the Health and Finished rows J1 lists. A kind with none is left out unless it is the one chosen.
 */
export function kindChips(
  summary: Needs["summary"] | null,
  health: number,
  finished: number,
  chosen: KindFilter,
): KindChip[] {
  const kinds: { id: NeedKind; count: number }[] = (["ask", "approval", "owner_step"] as const).map((id) => ({
    id,
    count: summary?.byKind[id] ?? 0,
  }));
  const chips: KindChip[] = [
    ...kinds.map(({ id, count }) => ({
      id,
      count,
      label: `${count} ${count === 1 ? KIND_WORDS[id].one : KIND_WORDS[id].many}`,
    })),
    { id: "health", count: health, label: `${health} health` },
    { id: "finished", count: finished, label: `${finished} finished` },
  ];
  return [
    { id: "all", label: "All", count: summary?.total ?? 0 },
    ...chips.filter((chip) => chip.count > 0 || chip.id === chosen),
  ];
}

// ── The main column ──────────────────────────────────────────────────────────

export interface HealthRow {
  key: string;
  title: string;
  detail: string;
  since: string | null;
  /** Stuck work opens its inspector; a schedule or a loop opens its tab. */
  item: WorkItem | null;
  open: MaestroIntent | null;
  notice: NoticeRow;
}

/** What you watch that went wrong (A1: never a need): each notice of notices.list as a row of the Feed's Health section. */
export function healthRows(items: readonly WorkItem[], notices: Notices | null): HealthRow[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return (notices?.rows ?? []).map((notice) => ({
    key: notice.key,
    title: notice.title,
    detail: notice.detail,
    since: notice.since,
    item: notice.link.kind === "work" ? (byId.get(notice.link.id) ?? null) : null,
    open: noticeIntent(notice),
    notice,
  }));
}

/** Where a notice opens: its work in the inspector (no intent), or the view that handles it. */
export function noticeIntent(notice: NoticeRow): MaestroIntent | null {
  const link = notice.link;
  switch (link.kind) {
    case "work":
      return null;
    case "fleet":
      return { kind: "fleet", scope: link.scope };
    case "timeline":
      return { kind: "timeline" };
    case "loops":
      return { kind: "loops" };
    case "initiatives":
      return { kind: "initiatives" };
  }
}

export interface HomeInput {
  needs: Needs | null;
  handled: Handled | null;
  items: readonly WorkItem[];
  /** Every decision ask this client reads (asks.workspace: the workspace's and the fleet's). */
  asks: readonly DecisionAsk[];
  notices: Notices | null;
  workspace: string | null;
  filter: KindFilter;
  query: string;
}

export interface HomeSections {
  /** needs.list's rows in deck order, joined to their work or ask; unfiltered, every row. */
  needs: NeedEntry[];
  /** Work that landed with nothing held on you (A1: watched; BRO-2999 moves Maestro's own gate here). */
  finished: WorkItem[];
  health: HealthRow[];
  running: WorkItem[];
  queued: WorkItem[];
}

const inWorkspace = (workspace: string | null, scope: string) => workspace === null || scope === workspace;

/** The main column, after the workspace, the kind chip and the search. Pure. */
export function homeSections(input: HomeInput): HomeSections {
  const { items, workspace, filter, query } = input;
  const rows = input.needs?.rows ?? [];
  const held = new Set(rows.map((row) => row.key));
  const shown = (item: WorkItem) => inWorkspace(workspace, workScope(item)) && matchesQuery(item, query);
  const needs = needsSection(rows, items, input.asks, null, query).filter(
    (entry) => inWorkspace(workspace, entry.row.scope) && (filter === "all" || filter === entry.row.kind),
  );
  const finished = items.filter((item) => item.group === "review" && !held.has(workKey(item.id)) && shown(item));
  const health = healthRows(items, input.notices).filter((row) =>
    row.item
      ? shown(row.item)
      : workspace === null && (!query.trim() || row.title.toLowerCase().includes(query.trim().toLowerCase())),
  );
  const only = (kind: KindFilter) => filter === "all" || filter === kind;
  return {
    needs: filter === "health" || filter === "finished" ? [] : needs,
    finished: only("finished") ? finished : [],
    health: only("health") ? health : [],
    running: filter === "all" ? runningOf(items).filter(shown) : [],
    queued:
      filter === "all"
        ? items.filter((item) => sectionOf(item) === "queued" && !held.has(workKey(item.id)) && shown(item))
        : [],
  };
}

/** "an approval and an owner step", "2 asks": the Needs you section's own rows, in words. Pure. */
export function needsHint(entries: readonly NeedEntry[]): string {
  const byKind = { ask: 0, approval: 0, owner_step: 0 };
  for (const entry of entries) byKind[entry.row.kind] += 1;
  return kindWords(byKind);
}

// ── The glance tiles ─────────────────────────────────────────────────────────

export interface Tiles {
  needs: { value: number; line: string; oldest: string | null };
  running: { value: number; rows: { key: string; scope: string; text: string }[] };
  handled: { value: number; line: string; last: string | null };
  unsupervised: { value: string; next: string; segments: Scoreboard["segments"] };
}

/** The four tiles (JE: four at most), each the length or a field of the read it names. Pure. */
export function glanceTiles(
  needs: Needs | null,
  handled: Handled | null,
  items: readonly WorkItem[],
  board: Scoreboard | null,
  loop: { minutes: number | null; nextAt: string | null; ticking: boolean } | null,
  now: number,
): Tiles {
  const oldest = needs?.summary.oldest ? needs.rows.find((row) => row.key === needs.summary.oldest?.key) : null;
  const running = runningOf(items);
  const forYou = handled ? handledForYou(handled.rows) : [];
  const last = forYou[0] ?? null;
  const next = !loop
    ? "loop not read"
    : loop.ticking
      ? "waking now"
      : loop.minutes === null
        ? "loop off"
        : loop.nextAt
          ? `next wake ${waitWords(Math.max(0, Date.parse(loop.nextAt) - now))} · every ${loop.minutes} min`
          : `every ${loop.minutes} min`;
  return {
    needs: {
      value: needs?.summary.total ?? 0,
      line: needs ? kindWords(needs.summary.byKind) || "Nothing holds on you" : "Not read yet",
      oldest:
        oldest && needs?.summary.oldest ? `oldest ${ago(needs.summary.oldest.since, now)} · ${oldest.title}` : null,
    },
    running: {
      value: running.length,
      rows: running.slice(0, 3).map((item) => ({
        key: item.id,
        scope: workScope(item),
        text: [item.ticket ?? ticketOf(item.title), item.phase].filter(Boolean).join(" · ") || titleText(item),
      })),
    },
    handled: {
      value: handled?.today.closedForYou ?? 0,
      line: handled
        ? `${handled.today.byYou} closed by you · ${plural(handled.today.asksAnswered, "ask")} answered`
        : "Not read yet",
      last: last ? `last: ${last.title} · ${CLOSER_WORDS[last.closedBy]}` : null,
    },
    unsupervised: {
      value: board ? duration(board.unsupervisedMs) : "—",
      next,
      segments: board?.segments ?? [],
    },
  };
}

const CLOSER_WORDS = {
  gates: "merged by gates",
  orchestrator: "by its orchestrator",
  maestro: "by Maestro",
  you: "by you",
};

// ── The rail ─────────────────────────────────────────────────────────────────

export interface Rail {
  decide: { rows: DecideRow[]; more: number };
  handled: HandledGroup[];
  /** Answers that wait for the conductor: File as work or Dismiss (BRO-2990). */
  proposals: DecisionAsk[];
}

export function railOf(asks: readonly DecisionAsk[], handled: Handled | null): Rail {
  return {
    decide: decideOf(asks),
    handled: handledGroups(handledForYou(handled?.rows ?? [])),
    proposals: forTheConductor(asks),
  };
}

// ── Selection, keys and params.hold ──────────────────────────────────────────

/** What the inspector shows: a hold by its key, or watched work by its id. */
export type Selection = { kind: "hold"; key: string } | { kind: "work"; id: string };

/** The next (`step` 1) or previous (-1) hold from `current`, by J and K; the first when none is selected. Pure. */
export function stepHold(keys: readonly string[], current: string | null, step: 1 | -1): string | null {
  if (keys.length === 0) return null;
  const at = current === null ? -1 : keys.indexOf(current);
  if (at < 0) return keys[step === 1 ? 0 : keys.length - 1] ?? null;
  return keys[Math.min(keys.length - 1, Math.max(0, at + step))] ?? null;
}

/**
 * What opening Maestro with `params.hold` selects (BRO-3033 fact 2): that hold when needs.list
 * holds it; `gone` when needs.list was read and no longer does (answered, or closed); `wait`
 * until it is read.
 */
export function holdParam(
  hold: string | undefined,
  rows: readonly Pick<NeedRow, "key">[] | null,
): { kind: "none" } | { kind: "wait" } | { kind: "open"; key: string } | { kind: "gone"; key: string } {
  if (!hold) return { kind: "none" };
  if (rows === null) return { kind: "wait" };
  return rows.some((row) => row.key === hold) ? { kind: "open", key: hold } : { kind: "gone", key: hold };
}

// ── The inspector's item ─────────────────────────────────────────────────────

function sessionOf(row: NeedRow, item: WorkItem | null, now: number): SessionRef | undefined {
  if (!row.session) return undefined;
  return {
    name: row.session.name,
    status: row.session.waiting ? `waiting on you · ${ago(row.since, now)}` : "not waiting",
    state: item?.state ?? "review",
    waiting: row.session.waiting,
  };
}

/** What Allow names when the action is one a person knows by its verb ("Allow merge", J1); plain Allow otherwise. */
export function allowLabel(action: string): string | undefined {
  if (/^gh pr merge\b/.test(action)) return "Allow merge";
  if (/^git push\b/.test(action)) return "Allow push";
  return undefined;
}

/** The primary's own words: an approval names what it allows, an owner step says what Done does here. */
export function primaryLabel(row: NeedRow): string | undefined {
  if (row.kind === "approval") return allowLabel(row.body.action);
  if (row.kind !== "owner_step") return undefined;
  const hold = holdOf(row.key);
  if (hold?.kind === "work") return "Start it";
  if (/^https?:\/\//.test(row.body.where)) return "Open PR";
  return undefined;
}

/** A hold's kicker: where it is, its ticket or ledger, and who held it. */
export function holdKicker(entry: NeedEntry): string[] {
  const { row, ask } = entry;
  const parts = [row.scope];
  if (row.ticket) parts.push(row.ticket);
  else if (ask) parts.push(ledgerName(ledgerOf(ask)));
  if (row.kind === "approval") parts.push(`held by ${row.body.heldBy}`);
  if (row.kind === "owner_step") parts.push("owner step");
  return parts;
}

/** An ask's options as the inspector offers them, the recommended one marked and chosen first. */
function choicesOf(entry: NeedEntry): { options: Choice[]; chosen?: string } {
  const { row, ask } = entry;
  if (row.kind !== "ask") return { options: [] };
  if (ask) {
    const options = ask.options.map((option) => ({
      id: option.id,
      label: option.label,
      note: [option.consequence, option.reversible === false ? "cannot be undone" : null].filter(Boolean).join(" · "),
      recommended: option.recommended,
      irreversible: option.reversible === false,
    }));
    return { options, chosen: ask.options.find((option) => option.recommended)?.id };
  }
  const options = row.body.options.map((option) => ({
    id: option.id,
    label: option.label,
    note: option.consequence ?? undefined,
    recommended: option.id === row.body.recommended,
  }));
  return { options, chosen: row.body.recommended };
}

/** What held an approval, in words (J2's "Held by"). */
export function heldByWords(heldBy: string): string {
  if (heldBy === "permission") return "the session's permission prompt";
  if (heldBy === "gate") return "Maestro's human gate";
  return heldBy;
}

/** What Deny does for what held the approval (J2). */
export function denyWords(heldBy: string): string[] {
  if (heldBy === "permission") return ["The session is told no and goes on without it; nothing runs."];
  return ["It goes back to its session; nothing is merged."];
}

/**
 * Where an answer goes, as J3 says it: the session that asked gets it verbatim; if that is gone, a sibling on
 * its arc, then the initiative's driver, and with no one to take it, it waits for the conductor (A8:
 * answers.routing never starts work). It is written to where the ask lives either way.
 */
export function goesLine(goesTo: string, session: string | undefined): string {
  return session
    ? `Goes to the session that asked (${session}), verbatim. If it is gone: a sibling, then the initiative's driver; with none, it waits for the conductor. Written to ${goesTo}.`
    : `Your answer is written to ${goesTo}; a session on its arc or the initiative's driver gets it verbatim, else it waits for the conductor.`;
}

/** A review's "hanging off it" tiles (J8): its work, its open asks, and whether a driver session runs it. */
export function hangingTiles(hanging: {
  work: number;
  asks: number;
  driver?: string;
}): { icon: string; value: string; label: string }[] {
  return [
    { icon: "LayoutList", value: String(hanging.work), label: "work" },
    { icon: "MessagesSquare", value: String(hanging.asks), label: hanging.asks === 1 ? "open ask" : "open asks" },
    { icon: "Radio", value: hanging.driver ? "1" : "0", label: "driver session" },
  ];
}

/**
 * What happens if you say nothing (J3): the ask's timed default and how far its countdown has run (A4:
 * reversible asks take their default after 30 min), else the ledger's own words with no countdown, else none.
 */
export function fallbackOf(entry: NeedEntry, now: number): { line: string; elapsed?: number } | undefined {
  const { row, ask } = entry;
  if (row.kind === "ask" && "default" in row.body && row.body.default) {
    const taken = row.body.default;
    const option = row.body.options.find((one) => one.id === taken.option);
    const start = Date.parse(row.since);
    const end = Date.parse(taken.appliesAt);
    const left = end - now;
    const span = end - start;
    return {
      line: `If you say nothing: ${option?.label ?? taken.option}${left > 0 ? `, in ${waitWords(left)}` : ", now"} (A4: reversible asks take their default after 30 min).`,
      ...(Number.isFinite(span) && span > 0 ? { elapsed: (now - start) / span } : {}),
    };
  }
  const silence = ask ? silenceOf(ask) : null;
  return silence ? { line: `${silence.text}.` } : undefined;
}

/** A hold as the inspector shows it: its kind's body, its session, and its verbs' words. Pure. */
export function holdInspector(entry: NeedEntry, now: number): InspectorItem {
  const { row, item, ask } = entry;
  const common = {
    key: row.key,
    kicker: holdKicker(entry).slice(1),
    age: ago(row.since, now),
    title: row.title,
    session: sessionOf(row, item, now),
  };
  switch (row.kind) {
    case "approval":
      return {
        ...common,
        kind: "approval",
        primaryLabel: primaryLabel(row),
        summary:
          row.body.heldBy === "permission"
            ? "The session is paused on its permission prompt until you answer."
            : `The ${row.body.heldBy} holds it until you decide.`,
        action: row.body.action,
        heldBy: heldByWords(row.body.heldBy),
        evidence: row.body.evidence,
        after: row.body.after,
        afterDeny: denyWords(row.body.heldBy),
      };
    case "owner_step":
      return {
        ...common,
        kind: "owner_step",
        where: row.body.where,
        check: row.body.doneCheck,
        primaryLabel: primaryLabel(row),
      };
    case "ask": {
      const { options, chosen } = choicesOf(entry);
      if ("initiative" in row.body)
        return {
          ...common,
          kind: "review",
          summary: row.body.intent,
          late: `Review due ${ago(row.since, now)} ago`,
          since: row.body.since,
          hanging: hangingTiles(row.body.hanging),
          options,
          chosen,
          goes: `Goes to ${row.body.goesTo}.`,
        };
      return {
        ...common,
        title: ask ? headlineOf(ask).headline : row.title,
        kind: "ask",
        why: row.body.why || undefined,
        summary: row.body.cost || undefined,
        cost: row.body.cost || undefined,
        whyYou: row.body.why || undefined,
        goes: goesLine(row.body.goesTo, row.session?.name),
        fallback: fallbackOf(entry, now),
        options,
        chosen,
      };
    }
  }
}

const LIFECYCLE: readonly { label: string; reached: (item: WorkItem) => boolean }[] = [
  { label: "Queued", reached: () => true },
  {
    label: "Running",
    reached: (item) => item.state !== "proposed" && item.state !== "reviewing" && item.state !== "triggered",
  },
  { label: "Landed", reached: (item) => item.state === "review" || item.state === "done" },
  { label: "Done", reached: (item) => item.state === "done" },
];

/** Watched work as the inspector shows it: stuck work as a notice (Unblock), the rest as work (Open). Pure. */
export function workInspector(item: WorkItem, now: number): InspectorItem {
  const owner = item.state === "blocked" && item.adoptedBy?.by ? `owner: ${item.adoptedBy.by}` : null;
  const kicker = [workScope(item), item.ticket ?? ticketOf(item.title), owner].filter((part): part is string => !!part);
  const session = item.worker
    ? {
        name: item.worker.agentId.slice(0, 8),
        status: workerText(item.worker) ?? "",
        state: item.state,
        waiting: false,
      }
    : undefined;
  const common = { key: workKey(item.id), kicker, age: ago(item.updatedAt, now), title: titleText(item), session };
  if (item.state === "blocked")
    return {
      ...common,
      kind: "notice",
      prompt: true,
      summary: placeText(item) ?? undefined,
      log: [{ at: ago(item.updatedAt, now), text: stuckText(item) ?? "It stopped.", tone: "danger" }],
      closesWhen: [
        { when: "Its session takes a turn again", becomes: "Running" },
        ...(item.adoptedBy ? [{ when: "Its orchestrator closes it", becomes: "Handled for you" }] : []),
        { when: "You cancel it", becomes: "Canceled" },
      ],
      note: "No Approve: a notice is a fact. Unblock sends your prompt into the session, or starts the work again from its brief if the session is gone; the card stays until the session moves.",
    };
  return {
    ...common,
    kind: "work",
    summary: [item.phase, workerText(item.worker)].filter(Boolean).join(" · ") || undefined,
    state: item.state,
    lifecycle: LIFECYCLE.map((step) => ({ label: step.label, done: step.reached(item) })),
  };
}

// ── The header's wake chip ───────────────────────────────────────────────────

/** The header's wake chip: "18 min" to the next wake, "waking…" or "loop off". Pure. */
export function wakeChip(
  loop: { minutes: number | null; nextAt: string | null; ticking: boolean } | null,
  now: number,
): string {
  if (!loop) return "loop";
  if (loop.ticking) return "waking…";
  if (loop.minutes === null) return "loop off";
  if (!loop.nextAt) return `every ${loop.minutes} min`;
  const wait = Date.parse(loop.nextAt) - now;
  return wait <= 0 ? "now" : waitWords(wait);
}

// ── What a hold is, for its card and its inspector ───────────────────────────

/** The kind the card and the inspector draw a hold as: an ask with an initiative body is a review. */
export function holdKindOf(row: NeedRow): "approval" | "owner_step" | "ask" | "review" {
  if (row.kind === "ask") return "initiative" in row.body ? "review" : "ask";
  return row.kind;
}

/** A hold's evidence as one line: the facts the approval's body names, "label value" each. */
export function evidenceLine(row: NeedRow): string | null {
  if (row.kind !== "approval" || row.body.evidence.length === 0) return null;
  return row.body.evidence.map((fact) => `${fact.label} ${fact.value}`).join(" · ");
}

/** The words after a card's "Needs you ·": what kind of hold it is. */
export function holdChipWords(row: NeedRow): string {
  const kind = holdKindOf(row);
  return kind === "owner_step" ? "owner step" : kind;
}

// ── Keys ─────────────────────────────────────────────────────────────────────

/**
 * What a key does in the inspector, by the caps its action bar shows (client/kit/inspector-model.ts):
 * ⌘↵ allows an approval; on an ask or a review S skips; J and K walk the holds. ↵ on an ask is the focused
 * Answer button's own: the option picked lives in the inspector, and a key here would answer without it.
 * Pure: `typing` is whether the key went to a field, which keeps every key but Esc for itself.
 */
export function keyAction(
  kind: "approval" | "owner_step" | "ask" | "review" | "notice" | "work",
  key: { key: string; meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean },
  typing: boolean,
): { verb: string } | { step: 1 | -1 } | null {
  if (typing) return null;
  const mod = key.meta || key.ctrl;
  if (key.alt) return null;
  if (key.key === "Enter" && mod && kind === "approval") return { verb: "allow" };
  if (mod) return null;
  const letter = key.key.toLowerCase();
  if (letter === "s" && (kind === "ask" || kind === "review")) return { verb: "skip" };
  // J and K walk the holds: a notice or a work item is not one, so they leave it where it is.
  if (kind === "notice" || kind === "work") return null;
  if (letter === "j") return { step: 1 };
  if (letter === "k") return { step: -1 };
  return null;
}

// ── Cancel work… ─────────────────────────────────────────────────────────────

/** How long the first press of "Cancel work…" stays armed for a second. */
export const CANCEL_ARM_MS = 5000;

/**
 * Cancelling work is the ellipsis verb (J4): the first press on an item arms it, a second on the same item within
 * CANCEL_ARM_MS does it. Pure: `armed` is the last press that armed, `key` the item pressed now.
 */
export function cancelStep(armed: { key: string; at: number } | null, key: string, now: number): "arm" | "go" {
  return armed !== null && armed.key === key && now - armed.at <= CANCEL_ARM_MS ? "go" : "arm";
}
