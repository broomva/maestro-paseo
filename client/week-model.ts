// The week under the scoreboard: seven day bars and where the hours went. Pure,
// so every rule is tested. A bar is never read by its colour alone: each one
// carries its day and its hours as text.

import type { WeekDay } from "../shared/contracts";
import { duration } from "./format";
import { dayLabel, shortDay } from "./history-model";

export interface DayBar {
  date: string;
  /** Under the bar: "Mon", or "Today". */
  day: string;
  /** Over the bar: "2.5h", "45m", or "0m". */
  value: string;
  /** 0 to 1 of the tallest day. */
  height: number;
  today: boolean;
  /** Everything the bar says, in words. */
  label: string;
}

/** Hours as a bar can hold them: "45m" under an hour, "2.5h" over. */
export function barValue(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 6) / 10;
  return `${Number.isInteger(hours) ? hours.toFixed(0) : hours.toFixed(1)}h`;
}

export function weekTotal(week: readonly WeekDay[]): number {
  return week.reduce((sum, day) => sum + day.unsupervisedMs, 0);
}

export function dayBars(week: readonly WeekDay[], now: number = Date.now()): DayBar[] {
  const tallest = Math.max(0, ...week.map((day) => day.unsupervisedMs));
  return week.map((day) => {
    const today = shortDay(day.date, now) === "Today";
    const looks = `${day.looks} ${day.looks === 1 ? "look" : "looks"}`;
    const parts = [`${dayLabel(day.date, now)}: ${duration(day.unsupervisedMs)} unsupervised`, looks];
    if (day.longestRunMs > 0) parts.push(`longest run ${duration(day.longestRunMs)}`);
    return {
      date: day.date,
      day: shortDay(day.date, now),
      value: barValue(day.unsupervisedMs),
      height: tallest > 0 ? day.unsupervisedMs / tallest : 0,
      today,
      label: parts.join(", "),
    };
  });
}

export interface InitiativeHours {
  name: string;
  ms: number;
  /** 0 to 1 of the initiative with the most. */
  share: number;
}

export function whereHoursWent(
  entries: readonly { initiative: string | null; unsupervisedMs: number }[],
): InitiativeHours[] {
  const most = Math.max(0, ...entries.map((entry) => entry.unsupervisedMs));
  return entries
    .filter((entry) => entry.unsupervisedMs > 0)
    .map((entry) => ({
      name: entry.initiative ?? "No initiative",
      ms: entry.unsupervisedMs,
      share: most > 0 ? entry.unsupervisedMs / most : 0,
    }));
}

/** Runs in two initiatives at once count in both, so the rows can add up to more than the week. */
export function overlapNote(entries: readonly InitiativeHours[], total: number): string | null {
  const sum = entries.reduce((acc, entry) => acc + entry.ms, 0);
  return sum > total ? "Runs that overlapped count in each initiative they belong to." : null;
}
