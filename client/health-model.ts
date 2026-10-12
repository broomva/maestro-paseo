// J7, Health (BRO-3036; docs/design/next/j7-health.png), as a pure model: one sentence on how the fleet is, four
// tiles that say why (ticks as a 2 × 24 grid, sessions as one bar, schedules as a number, the conductor and
// its lanes), the open notices with what closes each, each schedule's own recent runs, and the sessions that
// want a look. Every number reads one projection and none is summed from another (view-models.md):
//   - the verdict's count, the Health tab's badge, the Feed's Health section and the list are notices.list's rows;
//   - the sessions bar's Running is the Running tray's (runningOf), its Stuck and Quiet are notices.list's kinds;
//   - the schedules tile is the length of the schedules list beside it (loops.get's standing rows).

import type { WorkItem } from "../shared/contracts";
import type { LoopRow, LoopsView } from "../shared/loops";
import { runningOf } from "../shared/needs-you";
import type { Notices } from "../shared/notices";
import type { TimelineRun } from "../shared/timeline";
import {
  askedSessions,
  bucketOf,
  type Cell,
  cadenceText,
  healthCells,
  modeBadge,
  proposalsBySession,
  type RosterRow,
  rosterRows,
  type ScopeRead,
  shortPath,
  UNMANAGED_CLASS,
  wantsAttention,
  wouldText,
} from "./fleet-cockpit-model";
import { ageWords } from "./fleet-words";
import { ago, plural } from "./format";
import type { LoopState } from "./loop-model";
import { waitWords } from "./loop-model";
import { KIND_WORDS, sections } from "./loops-model";

export type Tone = "ok" | "warn" | "danger" | "muted" | "info";

export interface TickRow {
  scope: string;
  cells: Cell[];
}

export interface BarSegment {
  id: "running" | "idle" | "stuck" | "quiet" | "unmanaged";
  label: string;
  count: number;
  /** How the count reads under the bar: "longest 13 h", "since 04:10Z". */
  note: string | null;
  tone: Tone;
}

export interface ScheduleRow {
  key: string;
  name: string;
  /** "launchd · hourly". */
  where: string;
  cells: Cell[];
  status: { word: "On time" | "Failed" | "Missed" | "Absent" | "Off" | "Running" | "Not read"; tone: Tone };
}

export interface HealthModel {
  header: { mode: string | null; cadence: string | null };
  verdict: { title: string; sentence: string; tone: Tone };
  ticks: { rows: TickRow[]; passed: number; total: number; line: string };
  sessions: { segments: BarSegment[]; seen: number };
  schedules: { total: number; breakdown: string; next: string | null };
  conductor: { on: boolean; cadence: string; words: string };
  schedulesList: ScheduleRow[];
  sessionRows: { rows: RosterRow[]; shown: number; total: number; would: (row: RosterRow) => string };
}

export interface HealthInput {
  reads: readonly ScopeRead[];
  loops: LoopsView | null;
  notices: Notices | null;
  items: readonly WorkItem[];
  loop: LoopState | null;
  now: number;
}

/** A schedule's runs as the cells beside its name: the last `n`, oldest first, the newest on the right. */
export function runCells(runs: readonly TimelineRun[], n = 16, now = Date.now()): Cell[] {
  const kind = (status: TimelineRun["status"]): Cell["kind"] =>
    status === "ok"
      ? "passed"
      : status === "failed"
        ? "failed"
        : status === "running"
          ? "running"
          : status === "missed"
            ? "missed"
            : "unknown";
  const words: Record<TimelineRun["status"], string> = {
    ok: "ran",
    failed: "failed",
    running: "running",
    missed: "was missed",
    skipped: "was skipped",
    unknown: "ended with no exit recorded",
  };
  const shown = [...runs].slice(0, n).reverse();
  const cells: Cell[] = shown.map((run) => ({
    kind: kind(run.status),
    tick: null,
    at: run.at,
    label: `Run ${words[run.status]}, ${ago(run.at, now)} ago`,
  }));
  const empty: Cell[] = Array.from({ length: Math.max(0, n - cells.length) }, () => ({
    kind: "empty" as const,
    tick: null,
    at: null,
    label: "No run recorded",
  }));
  return [...empty, ...cells];
}

const SCHEDULE_WORD: Record<ScheduleRow["status"]["word"], Tone> = {
  "On time": "ok",
  Running: "info",
  Failed: "danger",
  Missed: "warn",
  Absent: "warn",
  Off: "muted",
  "Not read": "muted",
};

/** One standing loop or schedule as its row: its recent runs, and one word for how it is. */
export function scheduleRow(row: LoopRow, now: number): ScheduleRow {
  const observed = row.observed;
  const status = ((): ScheduleRow["status"]["word"] => {
    if (row.unread) return "Not read";
    if (row.desired === "paused" || row.desired === "retired" || observed?.presence === "off") return "Off";
    if (row.id !== null && (!observed || observed.presence === "gone")) return "Absent";
    if (observed?.status === "failed") return "Failed";
    if (observed?.status === "missed") return "Missed";
    if (observed?.status === "running") return "Running";
    return "On time";
  })();
  const absentOrOff = status === "Absent" || status === "Off";
  return {
    key: row.subject,
    name: row.name,
    where: [KIND_WORDS[row.kind], row.intent?.cadence ?? observed?.cadence].filter(Boolean).join(" · "),
    cells: absentOrOff ? runCells([], 16, now) : runCells(observed?.runs ?? [], 16, now),
    status: { word: status, tone: SCHEDULE_WORD[status] },
  };
}

/** The sentence under the verdict: how the ticks went, and what each kind of notice says. */
export function verdictSentence(
  notices: Notices | null,
  ticks: { passed: number; total: number },
  reads: readonly ScopeRead[],
): string {
  const scopes = reads.map((read) => read.scope);
  const names = scopes.map((scope) => scope.id).join(" and ");
  const bad = scopes.filter((scope) => scope.health.status === "failing" || scope.health.status === "missed");
  const tickLine =
    scopes.length === 0
      ? ""
      : bad.length > 0
        ? `${bad.map((scope) => scope.id).join(" and ")} ${bad.length === 1 ? "is" : "are"} not ticking on time: ${ticks.passed} of ${ticks.total} ticks passed in 24 h.`
        : `${scopes.length === 1 ? names : `Both scopes`} tick${scopes.length === 1 ? "s" : ""} on time: ${ticks.passed} of ${ticks.total} ticks passed in 24 h.`;
  const kinds = notices?.summary.byKind;
  const parts = kinds
    ? [
        kinds.stuck > 0 ? `${kinds.stuck === 1 ? "a run is" : `${kinds.stuck} runs are`} stuck` : null,
        kinds.quiet > 0 ? `${kinds.quiet === 1 ? "one is" : `${kinds.quiet} are`} quiet` : null,
        kinds.schedule > 0
          ? `${kinds.schedule === 1 ? "a schedule" : `${kinds.schedule} schedules`} failed or missed`
          : null,
        kinds.loop > 0 ? `${kinds.loop === 1 ? "a loop" : `${kinds.loop} loops`} drifted` : null,
        kinds.initiative > 0 ? "initiatives are past their review date" : null,
      ].filter((part): part is string => part !== null)
    : [];
  const rest =
    parts.length === 0
      ? ""
      : parts.length === 1
        ? `${parts[0]}.`
        : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}.`;
  const capital = rest ? `${rest[0]?.toUpperCase()}${rest.slice(1)}` : "";
  return [tickLine, capital].filter(Boolean).join(" ");
}

/** Health, from what the screen has read. Pure. */
export function healthModel({ reads, loops, notices, items, loop, now }: HealthInput): HealthModel {
  const scopes = reads.map((read) => read.scope);
  const cells = reads.map((read) => ({
    scope: read.scope.id,
    cells: healthCells(read.detail?.ticks ?? [], read.scope.health, 24, now),
  }));
  const counted = cells.flatMap((row) => row.cells).filter((cell) => cell.kind !== "empty");
  const passed = counted.filter((cell) => cell.kind === "passed").length;
  const featured = reads.find((read) => read.detail)?.detail ?? null;
  const total = notices?.summary.total ?? 0;
  const ticks = { rows: cells, passed, total: counted.length };
  const tone: Tone = total === 0 ? "ok" : (notices?.summary.byKind.stuck ?? 0) > 0 ? "danger" : "warn";

  const roster = rosterRows(reads);
  const inScope = roster.inScope;
  const running = runningOf(items).length;
  const idle = inScope.filter((row) => bucketOf(row.state) === "idle").length;
  const unmanaged = inScope.filter((row) => row.classId === UNMANAGED_CLASS).length;
  const oldestIdle = inScope
    .filter((row) => bucketOf(row.state) === "idle" && row.activeAt)
    .map((row) => Date.parse(row.activeAt ?? ""))
    .filter(Number.isFinite);
  const stuck = notices?.summary.byKind.stuck ?? 0;
  const quiet = notices?.summary.byKind.quiet ?? 0;
  const stuckSince = notices?.rows.find((row) => row.kind === "stuck")?.since ?? null;
  const segments: BarSegment[] = [
    { id: "running", label: "Running", count: running, note: null, tone: "info" },
    {
      id: "idle",
      label: "Idle",
      count: idle,
      note: oldestIdle.length > 0 ? `longest ${waitWords(now - Math.min(...oldestIdle))}` : null,
      tone: "muted",
    },
    {
      id: "stuck",
      label: "Stuck",
      count: stuck,
      note: stuckSince ? `since ${stuckSince.slice(11, 16)}Z` : null,
      tone: "danger",
    },
    {
      id: "quiet",
      label: "Quiet",
      count: quiet,
      note: notices?.rows.find((row) => row.kind === "quiet")?.detail.match(/(\d+) minutes/)?.[0] ?? null,
      tone: "warn",
    },
    {
      id: "unmanaged",
      label: "Unmanaged",
      count: unmanaged,
      note: unmanaged > 0 ? "not adopted" : null,
      tone: "muted",
    },
  ];

  const rows = sections(loops?.rows ?? []).loops.map((row) => scheduleRow(row, now));
  const word = (name: ScheduleRow["status"]["word"]) => rows.filter((row) => row.status.word === name).length;
  const breakdown = [
    word("On time") + word("Running") > 0 ? `${word("On time") + word("Running")} on time` : null,
    word("Failed") > 0 ? `${word("Failed")} failed` : null,
    word("Missed") > 0 ? `${word("Missed")} missed` : null,
    word("Absent") > 0 ? `${word("Absent")} absent` : null,
    word("Off") > 0 ? `${word("Off")} off` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const upcoming = (loops?.rows ?? [])
    .filter((row) => row.section === "loops" && row.observed?.next && Date.parse(row.observed.next) > now)
    .sort((a, b) => Date.parse(a.observed?.next ?? "") - Date.parse(b.observed?.next ?? ""))[0];

  const asked = askedSessions(reads);
  const look = inScope.filter((row) => wantsAttention(row, asked) || row.classId === UNMANAGED_CLASS);
  const proposals = proposalsBySession(reads);
  return {
    header: {
      mode: modeBadge(scopes),
      cadence: cadenceText(
        featured?.schedule ?? null,
        scopes.find((scope) => scope.lastTick)?.lastTick?.at ?? null,
        now,
      ),
    },
    verdict: {
      title: total === 0 ? "All clear" : `${plural(total, "thing")} ${total === 1 ? "needs" : "need"} a look`,
      sentence: verdictSentence(notices, ticks, reads),
      tone,
    },
    ticks: {
      ...ticks,
      line: `${passed} of ${ticks.total} passed`,
    },
    sessions: { segments, seen: segments.reduce((sum, segment) => sum + segment.count, 0) },
    schedules: {
      total: rows.length,
      breakdown,
      next: upcoming?.observed?.next
        ? `next: ${upcoming.name} ${waitWords(Date.parse(upcoming.observed.next) - now)} from now`
        : null,
    },
    conductor: {
      on: loop?.minutes != null,
      cadence: loop
        ? loop.minutes === null
          ? "Maestro's loop is off"
          : `Ticks every ${loop.minutes} min and on events`
        : "Not read",
      words: "Never starts work itself (A8): it flags, applies what you decided and routes your answers.",
    },
    schedulesList: rows,
    sessionRows: {
      rows: look.slice(0, 6),
      shown: Math.min(look.length, 6),
      total: inScope.length,
      would: (row) => wouldText(row, proposals.get(row.id) ?? null, now),
    },
  };
}

/** A roster row's "Where": its folder and its branch. */
export function whereText(row: Pick<RosterRow, "cwd" | "branch">): string {
  return [shortPath(row.cwd), row.branch].filter(Boolean).join(" · ");
}

/** A roster row's "Active": how long ago it moved. */
export function activeText(row: Pick<RosterRow, "activeAt">, now: number): string {
  return ageWords(row.activeAt, now) ?? "";
}
