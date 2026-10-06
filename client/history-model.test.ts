import { describe, expect, test } from "bun:test";
import type { HistoryEvent } from "../shared/records";
import {
  byWho,
  countWho,
  dayKey,
  dayLabel,
  emptyHistoryText,
  eventCrumb,
  groupByDay,
  groupByWork,
  inScope,
  rowLabel,
  shortDay,
  timeText,
} from "./history-model";

/** Local times, so day grouping follows local midnights wherever the tests run. */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute).toISOString();
const NOW = new Date(2026, 8, 29, 15).getTime();

function event(
  itemId: string,
  ts: string,
  actor: HistoryEvent["actor"],
  extra: Partial<HistoryEvent> = {},
): HistoryEvent {
  return {
    ts,
    type: "note",
    actor,
    text: `${itemId} at ${ts}`,
    detail: null,
    itemId,
    title: `Work ${itemId}`,
    initiative: null,
    project: null,
    ...extra,
  };
}

// Newest first, as work.history returns them.
const events: HistoryEvent[] = [
  event("a", at(29, 14, 5), "human", { text: "You approved", initiative: "hawthorne", project: "core" }),
  event("b", at(29, 9), "agent", { text: "Turn finished", initiative: "genesis" }),
  event("a", at(28, 23, 59), "maestro", { text: "Checks passed", initiative: "hawthorne", project: "core" }),
  event("c", at(25, 8), "agent", { text: "Turn failed" }),
];

describe("who did it", () => {
  test("you are the human actor; an agent or Maestro is the loop on its own", () => {
    expect(byWho(events, "you").map((e) => e.text)).toEqual(["You approved"]);
    expect(byWho(events, "autonomous").map((e) => e.text)).toEqual(["Turn finished", "Checks passed", "Turn failed"]);
    expect(byWho(events, "all")).toHaveLength(4);
    expect(countWho(events)).toEqual({ all: 4, you: 1, autonomous: 3 });
  });

  test("a scope keeps its initiative's events", () => {
    expect(inScope(events, "hawthorne").map((e) => e.itemId)).toEqual(["a", "a"]);
    expect(inScope(events, null)).toHaveLength(4);
  });
});

describe("grouping", () => {
  test("by local day, newest day first, each day's events newest first", () => {
    const groups = groupByDay(events, NOW);
    expect(groups.map((group) => [group.title, group.events.length])).toEqual([
      ["Today", 2],
      ["Yesterday", 1],
      ["Friday, September 25", 1],
    ]);
    expect(groups[0]?.events.map((e) => e.text)).toEqual(["You approved", "Turn finished"]);
  });

  test("by work, the work with the newest event first, its crumb under the title", () => {
    const groups = groupByWork(events);
    expect(groups.map((group) => [group.title, group.hint, group.events.length])).toEqual([
      ["Work a", "hawthorne · core", 2],
      ["Work b", "genesis", 1],
      ["Work c", null, 1],
    ]);
  });
});

describe("words", () => {
  test("days and times", () => {
    expect(dayKey(at(28, 23, 59))).toBe("2026-09-28");
    expect(dayLabel("2026-09-29", NOW)).toBe("Today");
    expect(dayLabel("2026-09-28", NOW)).toBe("Yesterday");
    expect(dayLabel("2026-09-23", NOW)).toBe("Wednesday, September 23");
    expect(shortDay("2026-09-29", NOW)).toBe("Today");
    expect(shortDay("2026-09-27", NOW)).toBe("Sun");
    expect(timeText(at(29, 9, 5))).toBe("09:05");
  });

  test("a crumb names initiative and project once", () => {
    expect(eventCrumb({ initiative: "hawthorne", project: "core" })).toBe("hawthorne · core");
    expect(eventCrumb({ initiative: "hawthorne", project: "hawthorne" })).toBe("hawthorne");
    expect(eventCrumb({ initiative: null, project: null })).toBeNull();
  });

  test("a row reads as what happened, to which work, by whom, and when", () => {
    expect(rowLabel(events[0] as HistoryEvent, NOW)).toBe(
      "You approved, Work a, hawthorne · core, You, Today at 14:05",
    );
    expect(rowLabel(events[3] as HistoryEvent, NOW)).toBe("Turn failed, Work c, Agent, Friday, September 25 at 08:00");
  });

  test("an empty view says what it looked for", () => {
    expect(emptyHistoryText("all", 7)).toBe("Nothing happened in the last 7 days.");
    expect(emptyHistoryText("you", 7)).toBe("No looks from you in the last 7 days.");
    expect(emptyHistoryText("autonomous", 1)).toBe("Nothing ran on its own today.");
  });
});
