// The phone's Work and Health tabs as pure models (BRO-3037 part 2; docs/design/next/m6-work-mobile.png,
// m7-health-mobile.png). Work: the deck holds the work that needs you (the Needs you tray's work-backed holds),
// the sheet is the board as one list with a lane switcher. Health: the deck holds the notices, stuck first;
// the sheet is the fleet at a glance (four tiles) and the schedules. Every number is a projection's, never a
// sum of two reads (view-models.md invariants 1 and 2): the sheet's counts are the lengths of the cards it
// lists, the Health tab's badge is notices.list's total, and the sessions tile counts work and fleet sessions
// in their own units.

import type { WorkItem } from "../../shared/contracts";
import { holdOf } from "../../shared/needs";
import type { NoticeKind, NoticeRow } from "../../shared/notices";
import { ago } from "../format";
import type { HealthModel } from "../health-model";
import { type HealthRow, LIFECYCLE } from "../home-model";
import type { TileTone } from "../kit/tile-model";
import type { LaneCard, LaneId, WorkBoard } from "../work-model";
import type { RowLead, SheetCount, SheetRow } from "./model";

// ── Work ─────────────────────────────────────────────────────────────────────

/** The sheet's lanes: Needs you is the deck, so the switcher has the other four (M6 frame 2). */
export const WORK_LANES = [
  { id: "running", title: "Running" },
  { id: "queued", title: "Queued" },
  { id: "standing", title: "Standing" },
  { id: "done", title: "Done" },
] as const satisfies readonly { id: LaneId; title: string }[];
export type WorkLaneId = (typeof WORK_LANES)[number]["id"];

/** The work that needs you: the Needs you tray's holds that are work (an ask with no work is Decisions'). */
export function workDeck(board: WorkBoard): LaneCard[] {
  return (board.lanes.find((lane) => lane.id === "needs")?.cards ?? []).filter((card) => card.item !== null);
}

/** One lane's cards, as the sheet lists them. */
export function laneCards(board: WorkBoard, lane: WorkLaneId): LaneCard[] {
  return board.lanes.find((one) => one.id === lane)?.cards ?? [];
}

/** The line of counts under the sheet's title ("3 running · 2 queued · 1 standing · 4 done"): each lane's length. */
export function workCounts(board: WorkBoard): SheetCount[] {
  return WORK_LANES.map((lane) => ({
    id: lane.id,
    label: `${laneCards(board, lane.id).length} ${lane.title.toLowerCase()}`,
    ...(lane.id === "running" ? { running: true } : {}),
  }));
}

const LEAD: Record<WorkLaneId, RowLead> = { running: "running", queued: "queued", standing: "standing", done: "ok" };

/**
 * One lane's cards as the sheet's swipe rows. A running row says where, its ticket and its live turn; Continue is
 * offered on Done only, and only the screen decides whether that work has a session to prompt. Nothing swipes to
 * stop work (M6): the left swipe is Open session.
 */
export function laneRows(cards: readonly LaneCard[], lane: WorkLaneId, now: number): SheetRow[] {
  return cards.map((card) => ({
    key: card.key,
    kind: lane === "done" ? "finished" : lane === "queued" ? "queued" : "running",
    title: card.title,
    meta: [...card.kicker, card.line].filter(Boolean).join(" · "),
    age: card.item ? ago(card.item.updatedAt, now) : "",
    lead: LEAD[lane],
    target: { item: card.item, notice: null, open: null },
    verbs: { continue: lane === "done" && card.item !== null, snooze: false },
  }));
}

/** The lane the switcher opens on: the first of Running, Queued, Standing, Done that has cards. */
export function firstLane(board: WorkBoard): WorkLaneId {
  return WORK_LANES.find((lane) => laneCards(board, lane.id).length > 0)?.id ?? "running";
}

/** What a hold on the Work deck shows besides its words: the work's lifecycle, reached steps first. */
export function lifecycleOf(item: WorkItem): { label: string; done: boolean }[] {
  return LIFECYCLE.map((step) => ({ label: step.label, done: step.reached(item) }));
}

/**
 * The work's receipts so far, one line each, from what work.list holds (the diff stat, its checks, its branch's
 * session): nothing is invented, so a work with none says so.
 */
export function receiptLines(item: WorkItem): string[] {
  const lines: string[] = [];
  if (item.changed) lines.push(`changed  +${item.changed.additions} −${item.changed.deletions}`);
  if (item.checks.length > 0) lines.push(`checks   ${item.checks.map((check) => check.name).join(" · ")}`);
  if (item.verdict) lines.push(`verdict  ${item.verdict}`);
  return lines;
}

/** Whether a hold on the Work deck is an approval, an owner step or an ask: what "Open the hold" opens. */
export function holdWords(card: LaneCard): string {
  const hold = holdOf(card.key);
  return hold?.kind === "work" ? card.line : `Its hold: ${card.line}`;
}

// ── Health ───────────────────────────────────────────────────────────────────

const NOTICE_ORDER: Record<NoticeKind, number> = { stuck: 0, quiet: 1, schedule: 2, loop: 3, initiative: 4 };

/** The notices on the Health deck: stuck first (M7 frame 1), then the quiet, in notices.list's order within a kind. */
export function healthDeck(rows: readonly HealthRow[]): HealthRow[] {
  return rows
    .map((row, at) => ({ row, at }))
    .sort((a, b) => NOTICE_ORDER[a.row.notice.kind] - NOTICE_ORDER[b.row.notice.kind] || a.at - b.at)
    .map((entry) => entry.row);
}

/** What a notice's verb does on the phone: Unblock asks for words in a sheet, Snooze is sent, the rest open a page. */
export type NoticeAct = "unblock" | "snooze" | "open";

export function noticeAct(notice: NoticeRow, item: WorkItem | null): NoticeAct {
  if (notice.verb.id === "unblock" && item) return "unblock";
  if (notice.verb.id === "snooze") return "snooze";
  return "open";
}

/** The label of a notice's primary: "Unblock…" (it asks), "Snooze 4h", "Open log". */
export function noticePrimary(notice: NoticeRow, item: WorkItem | null): string {
  const act = noticeAct(notice, item);
  return act === "unblock" ? "Unblock…" : act === "open" && notice.verb.id === "unblock" ? "Open" : notice.verb.label;
}

export interface FleetTileSpec {
  id: "ticks" | "sessions" | "schedules" | "conductor";
  icon: string;
  label: string;
  value: string;
  unit?: string;
  line: string;
  tone: TileTone;
}

/** The four tiles the Health sheet opens with (M7 frame 2), from the model the desktop's J7 draws. */
export function fleetTiles(model: HealthModel): FleetTileSpec[] {
  const missed = model.ticks.rows.flatMap((row) => {
    const bad = row.cells.filter((cell) => cell.kind === "failed" || cell.kind === "missed").length;
    return bad > 0 ? [`${row.scope} missed ${bad}`] : [];
  });
  const segment = (id: string) => model.sessions.segments.find((one) => one.id === id)?.count ?? 0;
  const stuck = segment("stuck");
  const quiet = segment("quiet");
  const sessionsLine = [
    stuck > 0 ? `${stuck} stuck` : null,
    quiet > 0 ? `${quiet} quiet` : null,
    model.sessions.fleet > 0 ? `${model.sessions.fleet} fleet idle or unmanaged` : null,
  ].filter(Boolean);
  const absentOrBad = model.schedulesList.filter((row) => row.status.tone === "danger" || row.status.tone === "warn");
  return [
    {
      id: "ticks",
      icon: "Activity",
      label: "Fleet ticks",
      value: String(model.ticks.rows.length === 0 ? 0 : model.ticks.passed),
      unit: model.ticks.rows.length === 0 ? undefined : `of ${model.ticks.total}`,
      line:
        model.ticks.rows.length === 0
          ? "No fleet scope is read."
          : missed.length > 0
            ? missed.join(" · ")
            : "none missed",
      tone: missed.length > 0 ? "warn" : "plain",
    },
    {
      id: "sessions",
      icon: "CircleDot",
      label: "Sessions",
      value: String(segment("running")),
      unit: "running",
      line: sessionsLine.length > 0 ? sessionsLine.join(" · ") : "none stuck or quiet",
      tone: stuck > 0 ? "warn" : "plain",
    },
    {
      id: "schedules",
      icon: "CalendarClock",
      label: "Schedules",
      value: String(model.schedules.total),
      line: model.schedules.breakdown || "none registered",
      tone: absentOrBad.length > 0 ? "warn" : "plain",
    },
    {
      id: "conductor",
      icon: "Radio",
      label: "Conductor",
      value: model.conductor.on ? "On" : "Off",
      line: model.conductor.cadence,
      tone: "plain",
    },
  ];
}

/**
 * The line of counts under the Health sheet's title ("47/48 ticks · Dry run · 10 schedules · 2 lanes"): the tiles'
 * own numbers, and a scope or loop that was not read says so instead of a zero.
 */
export function healthCounts(model: HealthModel, lanes: number | null): SheetCount[] {
  const counts: SheetCount[] = [
    {
      id: "ticks",
      label: model.ticks.rows.length === 0 ? "ticks: not read" : `${model.ticks.passed}/${model.ticks.total} ticks`,
      ...(model.ticks.passed < model.ticks.total ? { tone: "warn" as const } : {}),
    },
  ];
  if (model.header.mode)
    counts.push({ id: "mode", label: model.header.mode.split(" · ")[0] ?? model.header.mode, tone: "warn" });
  counts.push({ id: "schedules", label: `${model.schedules.total} schedules` });
  counts.push({
    id: "lanes",
    label: lanes === null ? "lanes: not read" : `${lanes} ${lanes === 1 ? "lane" : "lanes"}`,
    ...(lanes === null ? { tone: "warn" as const } : {}),
  });
  return counts;
}
