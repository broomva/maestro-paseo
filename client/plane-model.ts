// The work plane's pure model: which items a view shows, how they group and
// count, and the words on each card. No React here, so every rule is tested.

import type { Worker, WorkItem } from "../shared/contracts";
import { GROUP_COPY, GROUP_ORDER, type Group, PLAIN_VOICE } from "../shared/states";
import { agoWords, basename, plural } from "./format";

export const VIEWS = [
  { id: "feed", label: "Feed", icon: "LayoutList" },
  { id: "board", label: "Board", icon: "Columns3" },
  { id: "list", label: "List", icon: "List" },
] as const;
export type PlaneView = (typeof VIEWS)[number]["id"];

/** Compact windows have no room for columns or dense rows: they always show the feed. */
export function viewFor(view: PlaneView, compact: boolean): PlaneView {
  return compact ? "feed" : view;
}

export type Filter = "all" | Group;
export const FILTERS: readonly Filter[] = ["all", ...GROUP_ORDER];

export function filterLabel(filter: Filter): string {
  return filter === "all" ? "All" : GROUP_COPY[filter].title;
}

export function countFilters(items: readonly WorkItem[]): Record<Filter, number> {
  const counts: Record<Filter, number> = { all: items.length, review: 0, blocked: 0, running: 0, queued: 0, done: 0 };
  for (const item of items) counts[item.group] += 1;
  return counts;
}

export function applyFilter(items: readonly WorkItem[], filter: Filter): WorkItem[] {
  return filter === "all" ? [...items] : items.filter((item) => item.group === filter);
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

/** Review and stuck work both wait on a person: the board's Needs you column and the scope badge. */
export const needsHand = (item: WorkItem): boolean => item.group === "review" || item.group === "blocked";

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

/** Non-empty groups in attention order. */
export function groupsOf(items: readonly WorkItem[]): { group: Group; items: WorkItem[] }[] {
  return GROUP_ORDER.map((group) => ({ group, items: items.filter((item) => item.group === group) })).filter(
    (entry) => entry.items.length > 0,
  );
}

export interface Column {
  id: "queued" | "running" | "needs-you" | "done";
  title: string;
  hint: string;
  groups: readonly Group[];
  items: WorkItem[];
}

const COLUMNS: readonly Omit<Column, "items">[] = [
  { id: "queued", title: GROUP_COPY.queued.title, hint: GROUP_COPY.queued.hint, groups: ["queued"] },
  { id: "running", title: GROUP_COPY.running.title, hint: GROUP_COPY.running.hint, groups: ["running"] },
  { id: "needs-you", title: GROUP_COPY.review.title, hint: "At your gate or stuck", groups: ["review", "blocked"] },
  { id: "done", title: GROUP_COPY.done.title, hint: GROUP_COPY.done.hint, groups: ["done"] },
];

/** Four columns, always present so work moves across a fixed frame. Needs you lists review before stuck. */
export function boardColumns(items: readonly WorkItem[]): Column[] {
  return COLUMNS.map((column) => ({
    ...column,
    items: column.groups.flatMap((group) => items.filter((item) => item.group === group)),
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

/** What a screen reader hears for a card or row: title, state, where, why it is stuck, and when. */
export function cardLabel(item: WorkItem, now = Date.now()): string {
  return [item.title, stateText(item), crumb(item), stuckText(item), agoWords(item.updatedAt, now)]
    .filter(Boolean)
    .join(", ");
}

/** The header line: what needs a person first, then what is moving. */
export function summaryText(items: readonly WorkItem[]): string {
  const counts = countFilters(items);
  const parts = [
    counts.review ? `${counts.review} ${counts.review === 1 ? "needs" : "need"} you` : null,
    counts.blocked ? `${counts.blocked} stuck` : null,
    counts.running ? `${counts.running} running` : null,
  ].filter(Boolean);
  return parts.join(" · ") || (items.length ? "Nothing needs you" : "No work yet");
}
