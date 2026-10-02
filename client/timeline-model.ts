// The Timeline view's pure model: where each run sits on the axis, the order
// sources are listed in, and every word a row says. No React here, so each
// rule is tested. The read is server/timeline.ts; timeline.get is what this
// draws.

import type { RunStatus, SourceKind, SourceStatus, TimelineRun, TimelineSource } from "../shared/timeline";
import { plural } from "./format";
import { waitWords } from "./loop-model";

/** How often the view asks again. The daemon reads launchd at most once a minute however often this asks. */
export const TIMELINE_POLL_MS = 30_000;

/** The tone a status or a run is drawn in: the theme's danger, warning, success, accent, or muted ink. */
export type MarkTone = "danger" | "warn" | "success" | "accent" | "muted";

/** One run's tone, or a source's: the two share their words for failed, missed, passed and running. */
export function toneOf(status: RunStatus | SourceStatus): MarkTone {
  switch (status) {
    case "failed":
      return "danger";
    case "missed":
      return "warn";
    case "ok":
      return "success";
    case "running":
      return "accent";
    default:
      return "muted";
  }
}

/** The status label beside a source's name: color always paired with these words. */
export function statusLabel(status: SourceStatus): string {
  switch (status) {
    case "failed":
      return "Failed";
    case "missed":
      return "Missed";
    case "running":
      return "Running";
    case "ok":
      return "On time";
    case "off":
      return "Off";
    default:
      return "Not known";
  }
}

export function kindLabel(kind: SourceKind): string {
  switch (kind) {
    case "schedule":
      return "Paseo schedule";
    case "heartbeat":
      return "Paseo heartbeat";
    case "launchd":
      return "launchd";
    case "loop":
      return "Maestro";
    default:
      return "Fleet";
  }
}

const rank: Record<SourceStatus, number> = { failed: 0, missed: 1, running: 2, ok: 3, unknown: 4, off: 5 };
const time = (at: string | null) => (at ? Date.parse(at) : Number.POSITIVE_INFINITY);

/**
 * The order a timeline lists its sources in: what needs you first (failed,
 * then missed), then what runs now, then the rest by their next run, soonest
 * first, and what will not run last.
 */
export function sortSources(sources: readonly TimelineSource[]): TimelineSource[] {
  return [...sources].sort(
    (a, b) =>
      Number(b.needsYou) - Number(a.needsYou) ||
      rank[a.status] - rank[b.status] ||
      time(a.next) - time(b.next) ||
      a.name.localeCompare(b.name),
  );
}

/** The header's line: how many sources, and how many need you. */
export function summaryLine(sources: readonly TimelineSource[]): string {
  const needs = sources.filter((source) => source.needsYou).length;
  const all = plural(sources.length, "scheduled source");
  return needs > 0 ? `${all}; ${needs} ${needs === 1 ? "needs" : "need"} you.` : `${all}; none needs you.`;
}

// ── The axis ─────────────────────────────────────────────────────────────────

export interface Axis {
  from: number;
  to: number;
  now: number;
}

export function axisOf(view: { from: string; to: string; now: string }): Axis {
  return { from: Date.parse(view.from), to: Date.parse(view.to), now: Date.parse(view.now) };
}

/** Where an instant sits along the axis, 0 at its start and 1 at its end, held inside. */
export function place(axis: Axis, at: number): number {
  const span = axis.to - axis.from;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (at - axis.from) / span));
}

/** One mark on a source's track: a run, a missed run, or one still to come. */
export interface Mark {
  key: string;
  /** Its start along the axis, 0 to 1. */
  left: number;
  /** How far along it runs, 0 for an instant; the track draws a minimum. */
  width: number;
  tone: MarkTone;
  /** A run still to come is drawn hollow. */
  future: boolean;
  /** The next run, drawn stronger than the rest still to come. */
  next: boolean;
}

/** Marks closer than this along the axis (about a pixel and a half on a phone) are drawn as one. */
export const MERGE_GAP = 0.004;

/**
 * A source's marks: its runs, by status, then the runs still to come. Runs
 * of one tone that touch are joined, so a dense job reads as a band and the
 * track stays light; a failed or missed run is never joined to a passing one.
 */
export function marksOf(source: Pick<TimelineSource, "runs" | "upcoming" | "next">, axis: Axis): Mark[] {
  const past = [...source.runs]
    .map((run) => {
      const start = Date.parse(run.at);
      const end = run.endedAt ? Date.parse(run.endedAt) : run.status === "running" ? axis.now : start;
      const left = place(axis, start);
      return { left, right: Math.max(left, place(axis, end)), tone: toneOf(run.status), at: run.at };
    })
    .sort((a, b) => a.left - b.left);
  const joined: { left: number; right: number; tone: MarkTone; at: string }[] = [];
  for (const mark of past) {
    const last = joined[joined.length - 1];
    if (last && last.tone === mark.tone && mark.left - last.right < MERGE_GAP)
      last.right = Math.max(last.right, mark.right);
    else joined.push({ ...mark });
  }
  const marks: Mark[] = joined.map((mark) => ({
    key: `run:${mark.at}`,
    left: mark.left,
    width: mark.right - mark.left,
    tone: mark.tone,
    future: false,
    next: false,
  }));
  const coming = new Set(source.upcoming);
  if (source.next && Date.parse(source.next) <= axis.to) coming.add(source.next);
  for (const at of [...coming].sort()) {
    const ms = Date.parse(at);
    if (ms > axis.to) continue;
    marks.push({
      key: `next:${at}`,
      left: place(axis, Math.max(ms, axis.now)),
      width: 0,
      tone: "accent",
      future: true,
      next: at === source.next,
    });
  }
  return marks;
}

/** The axis's labels: every `hours` on the local clock, with "now" at its place. */
export function axisTicks(axis: Axis, hours = 6): { key: string; left: number; label: string }[] {
  const ticks: { key: string; left: number; label: string }[] = [];
  const start = new Date(axis.from);
  start.setMinutes(0, 0, 0);
  for (let at = start.getTime(); at <= axis.to; at += 3_600_000) {
    const date = new Date(at);
    if (at < axis.from || date.getHours() % hours !== 0) continue;
    // Within half a step of now its label would overlap now's (a phone draws 12 h in about 75 px).
    if (Math.abs(at - axis.now) < (hours / 2) * 3_600_000) continue;
    ticks.push({ key: String(at), left: place(axis, at), label: clock(at) });
  }
  return ticks;
}

// ── Words ────────────────────────────────────────────────────────────────────

const two = (n: number) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function clock(at: number): string {
  const date = new Date(at);
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

function dayStart(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** An instant as a person says it from now: "14:00", "yesterday 21:55", "tomorrow 09:00", "Sun 04:00", "Oct 12 04:00". */
export function whenWords(at: number, now: number): string {
  const days = Math.round((dayStart(at) - dayStart(now)) / 86_400_000);
  const date = new Date(at);
  if (days === 0) return clock(at);
  if (days === -1) return `yesterday ${clock(at)}`;
  if (days === 1) return `tomorrow ${clock(at)}`;
  if (days > 1 && days < 7) return `${DAYS[date.getDay()]} ${clock(at)}`;
  return `${MONTHS[date.getMonth()]} ${date.getDate()} ${clock(at)}`;
}

/** The next run in words: "Next in 12 min", "Next tomorrow 09:00", "Due now", or nothing to say. */
export function nextWords(source: Pick<TimelineSource, "next" | "status">, now: number): string | null {
  if (!source.next) return source.status === "off" ? null : "No next run known";
  const at = Date.parse(source.next);
  if (at <= now) return "Due now";
  if (at - now < 60 * 60_000) return `Next in ${waitWords(at - now)}`;
  return `Next ${whenWords(at, now)}`;
}

/** How long a run took, when it is known and worth saying: "26 ms", "10 s", "3 min", "1 h 5 min". */
export function tookWords(run: Pick<TimelineRun, "at" | "endedAt">): string | null {
  if (!run.endedAt) return null;
  const ms = Date.parse(run.endedAt) - Date.parse(run.at);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return waitWords(ms);
}

export function runStatusWords(status: RunStatus): string {
  switch (status) {
    case "ok":
      return "passed";
    case "failed":
      return "failed";
    case "running":
      return "running";
    case "missed":
      return "missed";
    case "skipped":
      return "skipped";
    default:
      return "ended, exit not recorded";
  }
}

/** The last run in words: "Last 21:17, passed", "Last yesterday 02:00, failed (exit 1)", "No run yet". */
export function lastWords(source: Pick<TimelineSource, "last">, now: number): string {
  const { last } = source;
  if (!last) return "No run yet";
  const exit = last.status === "failed" && last.exit !== null && last.exit !== 0 ? ` (exit ${last.exit})` : "";
  return `Last ${whenWords(Date.parse(last.at), now)}, ${runStatusWords(last.status)}${exit}`;
}

/** A run's row in the detail: "21:17 · passed · 26 ms · exit 0". */
export function runLine(run: TimelineRun, now: number): string {
  const parts = [whenWords(Date.parse(run.at), now), runStatusWords(run.status)];
  const took = tookWords(run);
  if (took) parts.push(took);
  if (run.detail && run.detail !== `exit ${run.exit}`) parts.push(run.detail);
  else if (run.exit !== null) parts.push(`exit ${run.exit}`);
  return parts.join(" · ");
}

/** Since when a source has been failed or missed, in words: "since 02:30". */
export function sinceWords(source: Pick<TimelineSource, "since" | "status">, now: number): string | null {
  if (!source.since || (source.status !== "failed" && source.status !== "missed")) return null;
  return `since ${whenWords(Date.parse(source.since), now)}`;
}

/** The runs a row's detail lists: the newest first, at most `limit`. */
export function runsShown(runs: readonly TimelineRun[], limit = 12): { shown: TimelineRun[]; more: number } {
  return { shown: runs.slice(0, limit), more: Math.max(0, runs.length - limit) };
}

/** The row's label for a screen reader: name, status, why, last and next, in one sentence each. */
export function rowLabel(source: TimelineSource, now: number): string {
  return [
    `${source.name}, ${kindLabel(source.kind)}`,
    statusLabel(source.status),
    source.reason,
    lastWords(source, now),
    nextWords(source, now),
  ]
    .filter((part): part is string => Boolean(part))
    .map((part) => part.replace(/\.$/, ""))
    .join(". ");
}

/** What a notice above the other views says for one source that needs you: its time, from `since`, so the words stay put. */
export function noticeText(
  notice: { name: string; status: "failed" | "missed"; reason: string; since: string | null },
  now: number,
): string {
  const when = notice.since ? ` ${whenWords(Date.parse(notice.since), now)}` : "";
  return `${notice.name}: ${notice.status === "failed" ? "failed run" : "missed run"}${when}. ${notice.reason}`;
}

/** Where a label sits along the axis without hanging off either end: its offset, in points, from its place. */
export function labelOffset(left: number, width: number): number {
  if (left < 0.05) return 0;
  if (left > 0.95) return -width;
  return -width / 2;
}
