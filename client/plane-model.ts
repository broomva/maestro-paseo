// The work plane's pure model: which items a view shows, how they group and
// count, and the words on each card. No React here, so every rule is tested.

import type { Worker, WorkItem } from "../shared/contracts";
import { needsHand, needsYouOf, sectionOf } from "../shared/needs-you";
import { GROUP_COPY, GROUP_ORDER, type Group, PLAIN_VOICE, QUEUED_LOOP_HINT } from "../shared/states";
import { agoWords, basename, plural } from "./format";

export const VIEWS = [
  { id: "feed", label: "Feed", icon: "LayoutList" },
  { id: "board", label: "Board", icon: "Columns3" },
  { id: "list", label: "List", icon: "List" },
  { id: "history", label: "History", icon: "History" },
] as const;
export type PlaneView = (typeof VIEWS)[number]["id"];

/** Compact windows have no room for columns or dense rows: they show the feed or History. */
export function viewFor(view: PlaneView, compact: boolean): PlaneView {
  return compact && view !== "history" ? "feed" : view;
}

/** The views a window offers: compact ones only those viewFor keeps. */
export function viewsFor(compact: boolean): (typeof VIEWS)[number][] {
  return VIEWS.filter((option) => viewFor(option.id, compact) === option.id);
}

export type Filter = "all" | Group;
export const FILTERS: readonly Filter[] = ["all", ...GROUP_ORDER];

export function filterLabel(filter: Filter): string {
  return filter === "all" ? "All" : GROUP_COPY[filter].title;
}

/**
 * Whether an item is under a chip. The chips follow the sections (sectionOf):
 * Needs you, Running, Queued and Done each hold exactly what their section
 * lists, so flagged or stuck work is under Needs you and under no state chip.
 * Stuck narrows Needs you to its stuck work. All holds everything, which is
 * the four sections together, since each item is in exactly one.
 */
export function inFilter(item: Pick<WorkItem, "group" | "flag">, filter: Filter): boolean {
  if (filter === "all") return true;
  return filter === "blocked" ? item.group === "blocked" : sectionOf(item) === filter;
}

export function applyFilter(items: readonly WorkItem[], filter: Filter): WorkItem[] {
  return items.filter((item) => inFilter(item, filter));
}

/** Each chip's count: the length of what its filter shows (applyFilter), so the two cannot disagree. */
export function countFilters(items: readonly WorkItem[]): Record<Filter, number> {
  return Object.fromEntries(FILTERS.map((filter) => [filter, applyFilter(items, filter).length])) as Record<
    Filter,
    number
  >;
}

/** A chip shows when it has work or is selected, so a filter opened from elsewhere is never hidden. */
export function visibleFilters(counts: Record<Filter, number>, active: Filter): Filter[] {
  return FILTERS.filter((filter) => filter === "all" || filter === active || counts[filter] > 0);
}

export function emptyText(filter: Filter): string {
  switch (filter) {
    case "review":
      return "Nothing needs you right now.";
    case "blocked":
      return "Nothing is stuck.";
    case "running":
      return "Nothing is running.";
    case "queued":
      return "Nothing is queued.";
    case "done":
      return "Nothing is done yet.";
    default:
      return "No work here yet.";
  }
}

/** What needs you, as every surface counts it (shared/needs-you.ts). */
export { needsHand, needsYouOf, sectionOf };

export interface Initiative {
  name: string;
  open: number;
  total: number;
  needsYou: number;
}

/** Initiatives by name, so chips hold their place while work moves. */
export function initiatives(items: readonly WorkItem[]): Initiative[] {
  const byName = new Map<string, Initiative>();
  for (const item of items) {
    if (!item.initiative) continue;
    const entry = byName.get(item.initiative) ?? { name: item.initiative, open: 0, total: 0, needsYou: 0 };
    entry.total += 1;
    if (item.group !== "done") entry.open += 1;
    if (needsHand(item)) entry.needsYou += 1;
    byName.set(item.initiative, entry);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** A scope whose initiative has left the list falls back to all work. */
export function resolveScope(items: readonly WorkItem[], scope: string | null): string | null {
  return scope !== null && items.some((item) => item.initiative === scope) ? scope : null;
}

export function inScope(items: readonly WorkItem[], scope: string | null): WorkItem[] {
  return scope === null ? [...items] : items.filter((item) => item.initiative === scope);
}

export function scopeLabel(initiative: Initiative): string {
  const base = `${initiative.name}, ${initiative.open} of ${initiative.total} open`;
  return initiative.needsYou > 0 ? `${base}, ${initiative.needsYou} waiting on you` : base;
}

/**
 * A group's subtitle, in the feed, the list and the board alike. Queued says
 * who starts it: you, or, while the loop is on, the loop at its next wake.
 */
export function groupHint(group: Group, loopOn: boolean): string {
  return group === "queued" && loopOn ? QUEUED_LOOP_HINT : GROUP_COPY[group].hint;
}

/**
 * The feed's and the list's sections, non-empty, in attention order. Needs
 * you holds what needs you (at your gate, stuck, then flagged), as the board's
 * column and the header count do, so stuck and flagged work is listed there
 * and not again under its own group.
 */
export function groupsOf(items: readonly WorkItem[]): { group: Group; items: WorkItem[] }[] {
  return GROUP_ORDER.map((group) => ({
    group,
    items: group === "review" ? needsYouOf(items) : items.filter((item) => sectionOf(item) === group),
  })).filter((entry) => entry.items.length > 0);
}

export interface Column {
  id: "queued" | "running" | "needs-you" | "done";
  title: string;
  hint: string;
  items: WorkItem[];
}

/** The board's columns, left to right, and the section each one shows. */
const COLUMNS: readonly { id: Column["id"]; group: Group }[] = [
  { id: "queued", group: "queued" },
  { id: "running", group: "running" },
  { id: "needs-you", group: "review" },
  { id: "done", group: "done" },
];

/**
 * Four columns, always present so work moves across a fixed frame. Needs you
 * lists review, then stuck, then work the loop flagged, which it takes from
 * its own column: each item shows once, in the section the feed puts it in
 * (sectionOf). `loopOn` words the Queued hint.
 */
export function boardColumns(items: readonly WorkItem[], loopOn = false): Column[] {
  return COLUMNS.map(({ id, group }) => ({
    id,
    title: GROUP_COPY[group].title,
    hint: groupHint(group, loopOn),
    items: group === "review" ? needsYouOf(items) : items.filter((item) => sectionOf(item) === group),
  }));
}

/** "initiative › project", the project falling back to the repo's folder name. */
export function crumb(item: WorkItem): string | null {
  const leaf = item.project ?? basename(item.repo);
  const parts = [item.initiative, leaf === item.initiative ? null : leaf].filter(Boolean);
  return parts.length > 0 ? parts.join(" › ") : null;
}

export function stateText(item: WorkItem): string {
  if (item.phase === "asking") return "Question";
  if (item.phase === "checking") return "Checking";
  return item.state === "canceled" ? "Canceled" : PLAIN_VOICE[item.state].label;
}

export function workerText(worker: Worker | null): string | null {
  if (!worker) return null;
  return `${worker.provider} · ${worker.branch ? "own worktree" : "in the repo"}`;
}

export function stuckText(item: WorkItem): string | null {
  if (item.group !== "blocked") return null;
  return item.reason || "The run stopped without a reason.";
}

/** Why the loop flagged it for you, or null. */
export function flagText(item: Pick<WorkItem, "flag">): string | null {
  return item.flag?.reason ?? null;
}

export type DiffStat = { additions: number; deletions: number };

/** The changed row shows only when it has something to say: a branch or a stat actually read. */
export function changedVisible(branch: string | null | undefined, stat: DiffStat | null): boolean {
  return Boolean(branch) || stat !== null;
}

export function changeText(stat: DiffStat | null): string | null {
  return stat ? `+${stat.additions} −${stat.deletions}` : null;
}

export function changeLabel(stat: DiffStat): string {
  return `${plural(stat.additions, "line")} added, ${stat.deletions} removed`;
}

/** What a screen reader hears for a card or row: title, state, where, why it is stuck or flagged, and when. */
export function cardLabel(item: WorkItem, now = Date.now()): string {
  return [item.title, stateText(item), crumb(item), stuckText(item), flagText(item), agoWords(item.updatedAt, now)]
    .filter(Boolean)
    .join(", ");
}

/**
 * The header line: what needs a person, then what is moving, each counted as
 * its section lists it. Stuck and flagged work is in "need you" (as in the
 * header count), and a flagged run is not counted again as running.
 */
export function summaryText(items: readonly WorkItem[]): string {
  const needs = needsYouOf(items).length;
  const running = items.filter((item) => sectionOf(item) === "running").length;
  const parts = [
    needs ? `${needs} ${needs === 1 ? "needs" : "need"} you` : null,
    running ? `${running} running` : null,
  ].filter(Boolean);
  return parts.join(" · ") || (items.length ? "Nothing needs you" : "No work yet");
}
