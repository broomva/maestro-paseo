// History's pure model: who did it, grouping by day or by work, and the words
// on each row. No React here, so every rule is tested.

import type { HistoryEvent } from "../shared/records";
import { plural } from "./format";
import { eventFleetPlace, eventTitle } from "./records-text";

export type Who = "all" | "you" | "autonomous";
export const WHO: readonly { id: Who; label: string }[] = [
  { id: "all", label: "All" },
  { id: "you", label: "You" },
  { id: "autonomous", label: "Autonomous" },
];

export type HistoryGrouping = "day" | "work";
export const GROUPINGS: readonly { id: HistoryGrouping; label: string }[] = [
  { id: "day", label: "By day" },
  { id: "work", label: "By work" },
];

/** You are the human actor; an agent or Maestro itself is the loop running on its own. */
export function isYours(event: Pick<HistoryEvent, "actor">): boolean {
  return event.actor === "human";
}

export function byWho(events: readonly HistoryEvent[], who: Who): HistoryEvent[] {
  if (who === "all") return [...events];
  return events.filter((event) => isYours(event) === (who === "you"));
}

export function countWho(events: readonly HistoryEvent[]): Record<Who, number> {
  const you = events.filter(isYours).length;
  return { all: events.length, you, autonomous: events.length - you };
}

export function inScope(events: readonly HistoryEvent[], scope: string | null): HistoryEvent[] {
  return scope === null ? [...events] : events.filter((event) => event.initiative === scope);
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** The local calendar day of `ts`, as YYYY-MM-DD. */
export function dayKey(ts: string | number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A local day key back as a Date at that day's local noon, clear of any clock change. */
function dayOf(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1, 12);
}

/** "Today", "Yesterday", or "Monday, September 28". */
export function dayLabel(key: string, now: number = Date.now()): string {
  if (key === dayKey(now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === dayKey(yesterday.getTime())) return "Yesterday";
  const date = dayOf(key);
  return `${WEEKDAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

/** Three letters for a day under a bar: "Mon", or "Today". */
export function shortDay(key: string, now: number = Date.now()): string {
  if (key === dayKey(now)) return "Today";
  return (WEEKDAYS[dayOf(key).getDay()] ?? "").slice(0, 3);
}

/** Local 24-hour time, "09:05". */
export function timeText(ts: string): string {
  const date = new Date(ts);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function actorText(actor: HistoryEvent["actor"]): string {
  return actor === "human" ? "You" : actor === "agent" ? "Agent" : "Maestro";
}

/** "initiative › project", the fleet's words for fleet work (`fleet · sri · tick 7`), or null for work outside any initiative. */
export function eventCrumb(event: Pick<HistoryEvent, "initiative" | "project"> & { title?: string }): string | null {
  const fleet = event.title ? eventFleetPlace({ title: event.title }) : null;
  if (fleet) return fleet;
  const parts = [event.initiative, event.project === event.initiative ? null : event.project].filter(Boolean);
  return parts.length > 0 ? parts.join(" › ") : null;
}

export interface EventGroup {
  key: string;
  title: string;
  /** Second line of the header: the crumb for a work group. */
  hint: string | null;
  events: HistoryEvent[];
}

/** Newest day first; each day's events keep their newest-first order. */
export function groupByDay(events: readonly HistoryEvent[], now: number = Date.now()): EventGroup[] {
  const groups = new Map<string, EventGroup>();
  for (const event of events) {
    const key = dayKey(event.ts);
    let group = groups.get(key);
    if (!group) {
      group = { key, title: dayLabel(key, now), hint: null, events: [] };
      groups.set(key, group);
    }
    group.events.push(event);
  }
  return [...groups.values()].sort((a, b) => b.key.localeCompare(a.key));
}

/** One group per work, the one with the newest event first. */
export function groupByWork(events: readonly HistoryEvent[]): EventGroup[] {
  const groups = new Map<string, EventGroup>();
  for (const event of events) {
    let group = groups.get(event.itemId);
    if (!group) {
      group = { key: event.itemId, title: eventTitle(event), hint: eventCrumb(event), events: [] };
      groups.set(event.itemId, group);
    }
    group.events.push(event);
  }
  const newest = (group: EventGroup) => Math.max(...group.events.map((event) => Date.parse(event.ts)));
  return [...groups.values()].sort((a, b) => newest(b) - newest(a));
}

export function groupEvents(
  events: readonly HistoryEvent[],
  grouping: HistoryGrouping,
  now: number = Date.now(),
): EventGroup[] {
  return grouping === "day" ? groupByDay(events, now) : groupByWork(events);
}

/** What a screen reader hears for a row: what happened, to which work, by whom, and when. */
export function rowLabel(event: HistoryEvent, now: number = Date.now()): string {
  const when = `${dayLabel(dayKey(event.ts), now)} at ${timeText(event.ts)}`;
  return [event.text, eventTitle(event), eventCrumb(event), actorText(event.actor), when].filter(Boolean).join(", ");
}

export function emptyHistoryText(who: Who, days: number): string {
  const span = days === 1 ? "today" : `in the last ${plural(days, "day")}`;
  if (who === "you") return `No looks from you ${span}.`;
  if (who === "autonomous") return `Nothing ran on its own ${span}.`;
  return `Nothing happened ${span}.`;
}
