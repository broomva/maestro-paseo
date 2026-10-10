// The loop as the surfaces say it: the control in the plane's header, the
// wake log in its panel, and the choice in Settings. Pure, so every word is
// tested. The loop itself is server/loop.ts; loop.get is what these read.

import type { WakeEntry } from "../shared/contracts";
import { dayKey, dayLabel, timeText } from "./history-model";

/** What loop.get answers. */
export interface LoopState {
  minutes: number | null;
  nextAt: string | null;
  ticking: boolean;
  recent: WakeEntry[];
}

/** How often the control asks for the loop's state, and how often it asks while a wake is due or running. */
export const LOOP_POLL_MS = 30_000;
export const LOOP_DUE_POLL_MS = 5_000;

/** "12 min", "1 h", "1 h 30 min": a wait the header has room for. */
export function waitWords(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * The control's face: "Loop off", "Waking…" while a wake runs, "Next wake in
 * 12 min", or "Next wake now" once the time has come and the wake has not
 * reported yet. On but with no wake armed (Settings were just saved) reads
 * "Loop on".
 */
export function loopChipText(loop: Pick<LoopState, "minutes" | "nextAt" | "ticking"> | null, now: number): string {
  if (!loop) return "Loop";
  if (loop.ticking) return "Waking…";
  if (loop.minutes === null) return "Loop off";
  if (!loop.nextAt) return "Loop on";
  const wait = Date.parse(loop.nextAt) - now;
  return wait <= 0 ? "Next wake now" : `Next wake in ${waitWords(wait)}`;
}

/** Whether the next wake's time has come: the control then asks again sooner. */
export function loopDue(loop: Pick<LoopState, "minutes" | "nextAt" | "ticking"> | null, now: number): boolean {
  if (!loop) return false;
  return loop.ticking || (loop.minutes !== null && loop.nextAt !== null && Date.parse(loop.nextAt) <= now);
}

/**
 * How long until the control asks again: every LOOP_DUE_POLL_MS while a wake
 * is due or running, else every LOOP_POLL_MS, but never past the next wake,
 * so the face turns to "Waking…" when the wake starts rather than up to a
 * whole poll later. The read lands a moment after the wake is due, and never
 * sooner than a second from now.
 */
export function loopPollMs(loop: Pick<LoopState, "minutes" | "nextAt" | "ticking"> | null, now: number): number {
  if (loopDue(loop, now)) return LOOP_DUE_POLL_MS;
  if (!loop || loop.minutes === null || !loop.nextAt) return LOOP_POLL_MS;
  const untilDue = Date.parse(loop.nextAt) - now + 250;
  return Math.min(LOOP_POLL_MS, Math.max(1_000, untilDue));
}

/** "every 15 minutes", "every minute": the same words Settings offers. */
export function everyWords(minutes: number): string {
  return minutes === 1 ? "every minute" : `every ${minutes} minutes`;
}

/** The panel's line on how often it wakes. */
export function periodText(minutes: number | null): string {
  return minutes === null ? "The loop is off." : `The loop wakes ${everyWords(minutes)}.`;
}

/** Why a wake ran, in the panel's words. */
export function causeText(cause: WakeEntry["cause"]): string {
  return cause === "timer" ? "on schedule" : "you asked";
}

/** When a wake ran: "Today at 09:05". */
export function wokeText(wokeAt: string, now: number = Date.now()): string {
  return `${dayLabel(dayKey(wokeAt), now)} at ${timeText(wokeAt)}`;
}

/** The narrative's first line says why it woke, which the row's header already says. */
const WOKE_LINES = new Set(["Woke on a scheduled check.", "Woke because you asked."]);

/** The narrative lines a wake's row shows: all of them but the one that repeats its cause. */
export function wakeLines(entry: Pick<WakeEntry, "narrative">): string[] {
  return entry.narrative.filter((line, index) => !(index === 0 && WOKE_LINES.has(line)));
}

/** Lines with keys for a list: a line that repeats inside one wake (two works with one title) keeps its own key. */
export function keyedLines(lines: readonly string[]): { key: string; line: string }[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const count = seen.get(line) ?? 0;
    seen.set(line, count + 1);
    return { key: `${line}#${count}`, line };
  });
}

/** What the panel shows: the newest wakes first, the one Wake now just returned on top if the poll has not caught up. */
export function wakesShown(recent: readonly WakeEntry[], latest: WakeEntry | null): WakeEntry[] {
  if (!latest || recent.some((entry) => entry.tickId === latest.tickId)) return [...recent];
  return [latest, ...recent];
}

/** What Wake now says when the wake it asked for did not run. */
export function skippedText(entry: Pick<WakeEntry, "skipped">): string | null {
  return entry.skipped ? `Not woken: ${entry.skipped}.` : null;
}

// ── Settings ─────────────────────────────────────────────────────────────────

/** The periods Settings offers, in minutes. Any other saved value shows as itself. */
export const LOOP_CHOICES = [5, 15, 30, 60] as const;

const OFF = "off";

/** The select's value for a period: "off" or the minutes as text. */
export function loopValue(minutes: number | null): string {
  return minutes === null ? OFF : String(minutes);
}

/** The period a select value stands for. */
export function loopMinutesOf(value: string): number | null {
  if (value === OFF) return null;
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes > 0 ? minutes : null;
}

/** "Every 15 minutes", "Every minute". */
function choiceLabel(minutes: number): string {
  const words = everyWords(minutes);
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** Off, every 5, 15, 30 or 60 minutes, and the saved period in its place when it is none of those. */
export function loopOptions(current: number | null): { label: string; value: string }[] {
  const periods: number[] = [...LOOP_CHOICES];
  if (current !== null && !periods.includes(current)) periods.push(current);
  periods.sort((a, b) => a - b);
  return [
    { label: "Off", value: OFF },
    ...periods.map((minutes) => ({ label: choiceLabel(minutes), value: String(minutes) })),
  ];
}

/** The one sentence under the choice in Settings. */
export const LOOP_HINT =
  "On a schedule, the loop flags quiet runs and acts on your answers; it never starts work, which waits for you, a lane or the conductor.";
