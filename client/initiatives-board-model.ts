// J8, Initiatives (BRO-3036; docs/design/next/j8-initiatives.png), as a pure model: lateness is the loudest
// thing, four tiles say what needs you before you scan, and each row says its driver, its review date and what
// hangs off it. A due review is an Ask on its due date (B2): it is a hold in needs.list (`review:<id>`), so the
// Review due tile, its chip, the Initiatives tab's badge and the reviews in the Feed's deck are one number, read
// from needs.list and never recounted from the files. Work and asks hanging off an initiative are the work.list
// items and the open decisions that name it.

import type { WorkItem } from "../shared/contracts";
import type { DecisionAsk } from "../shared/fleet";
import type { Initiative, InitiativeStatus } from "../shared/initiatives";
import type { Needs } from "../shared/needs";
import { isTerminal } from "../shared/states";
import { isTriaged } from "./decisions-model";
import { plural } from "./format";

export const INITIATIVE_FILTERS = ["all", "due", "active", "proposed", "parked"] as const;
export type InitiativeFilter = (typeof INITIATIVE_FILTERS)[number];

export interface DateWords {
  text: string;
  /** How late, loudest: "2 d late", "1 d late", "today" for a day that is today; null when not late. */
  late: string | null;
}

const days = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** A review's date and how late it is, against the daemon's local day. */
export function dateWords(
  initiative: Pick<Initiative, "status" | "reviewBy" | "wake" | "stale" | "closedAt">,
  today: string,
): DateWords {
  if (initiative.status === "done" || initiative.status === "killed") {
    return { text: initiative.closedAt ? `closed ${initiative.closedAt.slice(5)}` : "closed", late: null };
  }
  const day = initiative.status === "parked" ? initiative.wake : initiative.reviewBy;
  if (!day) return { text: "no date", late: null };
  const shown = day.slice(5);
  const late = initiative.stale ? days(day, today) : null;
  return {
    text: shown,
    late: late === null ? null : late <= 0 ? "today" : `${late} d late`,
  };
}

export interface InitiativeRow {
  id: string;
  name: string;
  status: { word: string; tone: "ok" | "warn" | "muted" };
  summary: string | null;
  driver: { name: string; live: boolean };
  date: DateWords;
  work: number;
  asks: number;
  /** Past its review date: a hold in needs.list (`review:<id>`). */
  due: boolean;
  initiative: Initiative;
}

const STATUS: Record<InitiativeStatus, InitiativeRow["status"]> = {
  active: { word: "active", tone: "ok" },
  blocked_on_owner: { word: "waits on you", tone: "warn" },
  parked: { word: "parked", tone: "muted" },
  done: { word: "done", tone: "muted" },
  killed: { word: "killed", tone: "muted" },
};

/** A driver in a word: the file's own, with `none` when it names nobody; live when a session of its is known here. */
export function driverOf(initiative: Initiative): InitiativeRow["driver"] {
  const named = initiative.driver && initiative.driver !== "none" ? initiative.driver : null;
  const raw = named ?? "none";
  const name = raw.includes(":") ? (raw.split(":")[1] ?? raw) : raw;
  return { name, live: named !== null && initiative.sessions.some((session) => session.agentId !== null) };
}

export interface InitiativeTiles {
  due: { value: number; line: string };
  active: { value: number; line: string };
  proposed: { value: number; line: string };
  hanging: { work: number; asks: number; line: string };
}

export interface InitiativeBoard {
  rows: InitiativeRow[];
  chips: { id: InitiativeFilter; label: string; count: number }[];
  tiles: InitiativeTiles;
}

export interface BoardInput {
  initiatives: readonly Initiative[];
  /** The ideas filed for initiatives (initiatives.list): open ones are Proposed. */
  ideas: readonly DecisionAsk[];
  items: readonly WorkItem[];
  /** Every decision ask the client reads. */
  asks: readonly DecisionAsk[];
  needs: Needs | null;
  filter: InitiativeFilter;
  today: string;
}

/** The board: every initiative as a row (lateness first), the chips, and the four tiles. Pure. */
export function initiativeBoard({
  initiatives,
  ideas,
  items,
  asks,
  needs,
  filter,
  today,
}: BoardInput): InitiativeBoard {
  const due = new Set(
    (needs?.rows ?? []).flatMap((row) => (row.key.startsWith("review:") ? [row.key.slice("review:".length)] : [])),
  );
  const open = items.filter((item) => !isTerminal(item.state));
  const all: InitiativeRow[] = initiatives
    .filter((initiative) => !initiative.error)
    .map((initiative) => {
      // Late only while needs.list holds its review: an answered one no longer says how late it was.
      const holds = due.has(initiative.id);
      const date = dateWords(initiative, today);
      return {
        id: initiative.id,
        name: initiative.title ?? initiative.id,
        status: initiative.status ? STATUS[initiative.status] : { word: "unknown", tone: "muted" as const },
        summary: initiative.summary ?? initiative.quote,
        driver: driverOf(initiative),
        date: holds ? date : { ...date, late: null },
        work: open.filter((item) => item.initiative === initiative.id).length,
        asks: asks.filter((ask) => ask.initiative === initiative.id && isTriaged(ask)).length,
        due: holds,
        initiative,
      };
    });
  // Late first, the longest late loudest; then by date; those with none last.
  const lateness = (row: InitiativeRow) => (row.due ? days(row.initiative.stale?.date ?? today, today) : -1);
  const order = (row: InitiativeRow) => row.initiative.reviewBy ?? row.initiative.wake ?? "9999-12-31";
  const sorted = [...all].sort(
    (a, b) => lateness(b) - lateness(a) || order(a).localeCompare(order(b)) || a.id.localeCompare(b.id),
  );
  const parked = sorted.filter((row) => row.initiative.status === "parked");
  const active = sorted.filter((row) => row.initiative.status === "active");
  const proposed = ideas.filter((ask) => ask.state === "open");
  const dueRows = sorted.filter((row) => row.due);
  const keep = (id: InitiativeFilter) =>
    id === "all" ? sorted : id === "due" ? dueRows : id === "active" ? active : id === "parked" ? parked : [];
  const chips = [
    { id: "all" as const, label: "All", count: sorted.length },
    { id: "due" as const, label: "Review due", count: dueRows.length },
    { id: "active" as const, label: "Active", count: active.length },
    { id: "proposed" as const, label: "Proposed", count: proposed.length },
    { id: "parked" as const, label: "Parked", count: parked.length },
  ];
  const noDriver = active.filter((row) => !row.driver.live);
  const work = sorted.reduce((sum, row) => sum + row.work, 0);
  const askCount = sorted.reduce((sum, row) => sum + row.asks, 0);
  return {
    rows: keep(filter),
    chips,
    tiles: {
      due: {
        value: dueRows.length,
        line:
          dueRows.length === 0
            ? "No review is late."
            : dueRows.map((row) => `${row.name} ${row.date.late ?? "due"}`).join(" · "),
      },
      active: {
        value: active.length,
        line:
          active.length === 0
            ? "None is active."
            : noDriver.length === 0
              ? `${active.length === 1 ? "It has" : "All have"} a driver session.`
              : `${active.length - noDriver.length} have a driver session; ${noDriver.map((row) => row.name).join(", ")} ${noDriver.length === 1 ? "has" : "have"} none.`,
      },
      proposed: {
        value: proposed.length,
        line: proposed[0] ? (proposed[0].headline ?? proposed[0].id) : "No idea is waiting to be triaged.",
      },
      hanging: {
        work,
        asks: askCount,
        line: "The asks are in Decisions; the work is in Work.",
      },
    },
  };
}

/** The line at the right of the chips: where they are read from, and how they are sorted. */
export function sourceLine(controlRepo: string): string {
  return `from ${controlRepo ? `${controlRepo}/` : ""}.control/initiatives/*.yaml · sorted by review date`;
}

/** The words under a tile that counts what hangs off initiatives. */
export function hangingWords(work: number, asks: number): string {
  return `${plural(work, "work item")} · ${plural(asks, "ask")}`;
}
