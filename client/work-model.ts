// J6, Work as five trays (BRO-3036; docs/design/next/j6-work.png), as a pure model: Queued, Running, Standing,
// Needs you and Done, each with the one line that says why an item is where it is. Every count reads one
// projection and nothing is summed from another (view-models.md, invariants 1 and 4):
//   - Needs you is needs.list's rows, every one of them (the header's number), narrowed only by your filters;
//   - Running and Standing are runningOf and isStanding (shared/needs-you.ts): the Work tab's badge, J1's Running
//     tile and the Undertow read the same list;
//   - Done is handled.list's last 24 h, each with who closed it.
// Stuck work is a notice (Health), never a tray.

import type { WorkItem } from "../shared/contracts";
import type { DecisionAsk } from "../shared/fleet";
import { type Closer, type Handled, holdOf, type NeedRow, type Needs } from "../shared/needs";
import { isStanding, runningOf, sectionOf } from "../shared/needs-you";
import { matchesQuery, type NeedEntry, needsSection } from "./feed-model";
import { ago } from "./format";
import { holdKicker, workScope } from "./home-model";
import { titleText } from "./records-text";

export const LANES = [
  { id: "queued", title: "Queued", hint: "you or a lane start these", icon: "CircleDashed" },
  { id: "running", title: "Running", hint: "a session is taking turns", icon: "LoaderCircle" },
  { id: "standing", title: "Standing", hint: "alive, between turns; nothing to review yet", icon: "Pause" },
  { id: "needs", title: "Needs you", hint: "holds an ask, an approval or an owner step", icon: "Hand" },
  { id: "done", title: "Done", hint: "last 24 h, with who closed it", icon: "CircleCheck" },
] as const;
export type LaneId = (typeof LANES)[number]["id"];

const DAY_MS = 24 * 60 * 60 * 1000;

export interface LaneChip {
  word: string;
  tone: "ok" | "info" | "muted";
}

export interface LaneCard {
  key: string;
  lane: LaneId;
  /** The kicker: where it is, and its ticket or ledger. */
  kicker: string[];
  title: string;
  /** Why it is here, in one line: its hold, its live turn, who closed it. */
  line: string;
  chip: LaneChip | null;
  /** What opening it selects: a hold by key (Needs you), or work by id. */
  select: { kind: "hold"; key: string } | { kind: "work"; id: string };
  /** The Undertow's halo: running only. */
  running: boolean;
  /** The standing pulse: standing only. */
  standing: boolean;
  item: WorkItem | null;
}

export interface Lane {
  id: LaneId;
  title: string;
  hint: string;
  icon: string;
  cards: LaneCard[];
}

export interface WorkFilters {
  /** The workspace menu (header): null for all. */
  workspace: string | null;
  initiative: string | null;
  provider: string | null;
  query: string;
}

export const NO_FILTERS: WorkFilters = { workspace: null, initiative: null, provider: null, query: "" };

/** The provider a work item runs or would run on: its worker's, else its next run's (`claude/sonnet` is claude). */
export function providerOf(item: Pick<WorkItem, "worker" | "nextRun">): string | null {
  const named = item.worker?.provider ?? item.nextRun?.provider ?? null;
  return named ? (named.split("/")[0] ?? null) : null;
}

const CLOSER_CHIP: Record<Closer, LaneChip> = {
  gates: { word: "gates", tone: "ok" },
  you: { word: "you", tone: "info" },
  orchestrator: { word: "orchestrator", tone: "ok" },
  maestro: { word: "Maestro", tone: "ok" },
};

/** An approval's action, short for a card line. */
function shortAction(action: string): string {
  const first = action.split("\n")[0] ?? action;
  return first.length > 60 ? `${first.slice(0, 57)}…` : first;
}

/** What a hold says on its card: its kind, and where it is handled. */
export function holdLine(row: NeedRow, ask: DecisionAsk | null): string {
  if (row.kind === "approval") return `approval: ${shortAction(row.body.action)}`;
  if (row.kind === "owner_step")
    return holdOf(row.key)?.kind === "answers" ? "owner step: answers waiting to land" : "owner step";
  return holdOf(row.key)?.kind === "review"
    ? "review due → in Initiatives"
    : `ask ${ask?.id ?? ""} → in Decisions`.replace("ask  →", "ask →");
}

/** Whether a card passes the filters. `item` is the work behind it, when there is one; `initiative` its initiative. */
function passes(
  filters: WorkFilters,
  scope: string,
  item: WorkItem | null,
  initiative: string | null,
  text: string,
): boolean {
  if (filters.workspace !== null && scope !== filters.workspace) return false;
  if (filters.initiative !== null && (item?.initiative ?? initiative) !== filters.initiative) return false;
  if (filters.provider !== null && (item ? providerOf(item) : null) !== filters.provider) return false;
  return item ? matchesQuery(item, filters.query) : text.toLowerCase().includes(filters.query.trim().toLowerCase());
}

function workCard(item: WorkItem, lane: LaneId, line: string): LaneCard {
  const ticket = item.ticket ?? null;
  return {
    key: `work:${item.id}`,
    lane,
    kicker: [workScope(item), ticket].filter((part): part is string => !!part),
    title: titleText(item),
    line,
    chip: null,
    select: { kind: "work", id: item.id },
    running: lane === "running",
    standing: lane === "standing",
    item,
  };
}

/** What a running card says: its phase, its provider and how long since it last moved. */
export function runningLine(item: WorkItem, now: number): string {
  return [item.phase ?? "working", providerOf(item), ago(item.updatedAt, now)].filter(Boolean).join(" · ");
}

export interface WorkInput {
  items: readonly WorkItem[];
  needs: Needs | null;
  handled: Handled | null;
  asks: readonly DecisionAsk[];
  filters: WorkFilters;
  now: number;
}

export interface WorkBoard {
  lanes: Lane[];
  /** Cards in scope, every tray: "11 work items in scope". */
  inScope: number;
  /** Every provider and initiative the work names, for the two menus. */
  providers: string[];
  initiatives: string[];
}

/** The five trays, after the filters. Pure. */
export function workBoard({ items, needs, handled, asks, filters, now }: WorkInput): WorkBoard {
  const held = new Set((needs?.rows ?? []).map((row) => row.key));
  const entries: NeedEntry[] = needsSection(needs?.rows ?? [], items, asks);
  const byId = new Map(items.map((item) => [item.id, item]));

  const queued = items
    .filter((item) => sectionOf(item) === "queued" && !held.has(`work:${item.id}`))
    .filter((item) => passes(filters, workScope(item), item, null, titleText(item)))
    .map((item) => workCard(item, "queued", item.gate === "human" ? "gate: you" : "a lane starts it next"));
  const running = runningOf(items)
    .filter((item) => passes(filters, workScope(item), item, null, titleText(item)))
    .map((item) => workCard(item, "running", runningLine(item, now)));
  const standing = items
    .filter((item) => isStanding(item))
    .filter((item) => passes(filters, workScope(item), item, null, titleText(item)))
    .map((item) => workCard(item, "standing", `quiet ${ago(item.flag?.at ?? item.updatedAt, now)} → in Health`));
  const needsYou: LaneCard[] = entries
    .filter((entry) => {
      const hold = holdOf(entry.row.key);
      const initiative = entry.ask?.initiative ?? (hold?.kind === "review" ? hold.initiative : null);
      return passes(filters, entry.row.scope, entry.item, initiative, entry.row.title);
    })
    .map((entry) => ({
      key: entry.row.key,
      lane: "needs" as const,
      kicker: holdKicker(entry).filter((part) => !part.startsWith("held by") && part !== "owner step"),
      title: entry.row.title,
      line: holdLine(entry.row, entry.ask),
      chip: null,
      select: { kind: "hold" as const, key: entry.row.key },
      running: false,
      standing: false,
      item: entry.item,
    }));
  const done: LaneCard[] = (handled?.rows ?? [])
    .filter((row) => now - Date.parse(row.at) <= DAY_MS)
    .flatMap((row) => {
      const hold = holdOf(row.key);
      const item = hold?.kind === "work" ? (byId.get(hold.id) ?? null) : null;
      const scope = item ? workScope(item) : "maestro";
      if (!passes(filters, scope, item, null, row.title)) return [];
      return [
        {
          key: row.key,
          lane: "done" as const,
          kicker: [scope, item?.ticket ?? null].filter((part): part is string => !!part),
          title: row.title,
          line: row.reason,
          chip: CLOSER_CHIP[row.closedBy],
          select:
            hold?.kind === "work" ? { kind: "work" as const, id: hold.id } : { kind: "hold" as const, key: row.key },
          running: false,
          standing: false,
          item,
        },
      ];
    });

  const cards: Record<LaneId, LaneCard[]> = { queued, running, standing, needs: needsYou, done };
  const lanes = LANES.map((lane) => ({ ...lane, cards: cards[lane.id] }));
  const providers = [...new Set(items.map(providerOf).filter((name): name is string => name !== null))].sort();
  const initiatives = [
    ...new Set(items.map((item) => item.initiative).filter((name): name is string => !!name)),
  ].sort();
  return {
    lanes,
    inScope: lanes.reduce((sum, lane) => sum + lane.cards.length, 0),
    providers,
    initiatives,
  };
}

/** The line above the trays: how many cards are in scope, and what Done reaches back to. */
export function scopeLine(board: WorkBoard): string {
  return `${board.inScope} work ${board.inScope === 1 ? "item" : "items"} in scope · Done shows the last 24 h`;
}
