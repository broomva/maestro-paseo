import { describe, expect, test } from "bun:test";
import type { WakeEntry } from "../shared/contracts";
import {
  causeText,
  keyedLines,
  LOOP_HINT,
  loopChipText,
  loopDue,
  loopMinutesOf,
  loopOptions,
  loopValue,
  periodText,
  skippedText,
  waitWords,
  wakeLines,
  wakesShown,
} from "./loop-model";

const now = Date.parse("2026-10-01T09:00:00.000Z");
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();

function entry(tickId: string, extra: Partial<WakeEntry> = {}): WakeEntry {
  return {
    tickId,
    cause: "timer",
    wokeAt: at(-5),
    dispatched: [],
    deferred: [],
    needsYou: { gate: 0, stuck: 0, asking: 0 },
    quiet: [],
    unasked: [],
    flagged: [],
    narrative: ["Woke on a scheduled check.", "Did nothing new this tick."],
    ...extra,
  };
}

describe("the loop control", () => {
  test("says off, waking, or when it wakes next", () => {
    expect(loopChipText(null, now)).toBe("Loop");
    expect(loopChipText({ minutes: null, nextAt: null, ticking: false }, now)).toBe("Loop off");
    expect(loopChipText({ minutes: 15, nextAt: at(12), ticking: false }, now)).toBe("Next wake in 12 min");
    // A part minute counts as one: never "in 0 min".
    expect(loopChipText({ minutes: 15, nextAt: at(0.2), ticking: false }, now)).toBe("Next wake in 1 min");
    expect(loopChipText({ minutes: 1440, nextAt: at(90), ticking: false }, now)).toBe("Next wake in 1 h 30 min");
    expect(loopChipText({ minutes: 1440, nextAt: at(120), ticking: false }, now)).toBe("Next wake in 2 h");
    expect(loopChipText({ minutes: 15, nextAt: at(-1), ticking: false }, now)).toBe("Next wake now");
    expect(loopChipText({ minutes: 15, nextAt: null, ticking: false }, now)).toBe("Loop on");
    // A wake you asked for runs whether or not the loop is on.
    expect(loopChipText({ minutes: null, nextAt: null, ticking: true }, now)).toBe("Waking…");
  });

  test("asks again sooner only while a wake is due or running", () => {
    expect(loopDue({ minutes: 15, nextAt: at(12), ticking: false }, now)).toBe(false);
    expect(loopDue({ minutes: 15, nextAt: at(-1), ticking: false }, now)).toBe(true);
    expect(loopDue({ minutes: null, nextAt: null, ticking: true }, now)).toBe(true);
    expect(loopDue({ minutes: null, nextAt: null, ticking: false }, now)).toBe(false);
    expect(loopDue(null, now)).toBe(false);
  });

  test("waits read in minutes, then hours and minutes", () => {
    expect(waitWords(59 * 60_000)).toBe("59 min");
    expect(waitWords(60 * 60_000)).toBe("1 h");
    expect(waitWords(61 * 60_000)).toBe("1 h 1 min");
  });
});

describe("the loop panel", () => {
  test("says how often it wakes, and why each wake ran", () => {
    expect(periodText(null)).toBe("The loop is off.");
    expect(periodText(15)).toBe("The loop wakes every 15 minutes.");
    expect(periodText(1)).toBe("The loop wakes every minute.");
    expect(causeText("timer")).toBe("on schedule");
    expect(causeText("manual")).toBe("you asked");
  });

  test("a wake's lines drop only the first, which repeats its cause", () => {
    expect(
      wakeLines(entry("a", { narrative: ["Woke because you asked.", "Did:", "  Started Fix the build."] })),
    ).toEqual(["Did:", "  Started Fix the build."]);
    expect(wakeLines(entry("b", { narrative: ["Did nothing new this tick.", "Woke on a scheduled check."] }))).toEqual([
      "Did nothing new this tick.",
      "Woke on a scheduled check.",
    ]);
  });

  test("a line that repeats in one wake keeps a key of its own", () => {
    expect(keyedLines(["Did:", "  Started Fix.", "  Started Fix."]).map((line) => line.key)).toEqual([
      "Did:#0",
      "  Started Fix.#0",
      "  Started Fix.#1",
    ]);
  });

  test("the wake Wake now returned shows on top until a read lists it", () => {
    const older = entry("older");
    const fresh = entry("fresh", { cause: "manual" });
    expect(wakesShown([older], null).map((wake) => wake.tickId)).toEqual(["older"]);
    expect(wakesShown([older], fresh).map((wake) => wake.tickId)).toEqual(["fresh", "older"]);
    expect(wakesShown([fresh, older], fresh).map((wake) => wake.tickId)).toEqual(["fresh", "older"]);
  });

  test("a skipped wake says why; one that ran says nothing more", () => {
    expect(skippedText({ skipped: "another check was already running" })).toBe(
      "Not woken: another check was already running.",
    );
    expect(skippedText({})).toBeNull();
  });
});

describe("the loop in Settings", () => {
  test("offers off, every 5, 15, 30 or 60 minutes", () => {
    expect(loopOptions(null)).toEqual([
      { label: "Off", value: "off" },
      { label: "Every 5 minutes", value: "5" },
      { label: "Every 15 minutes", value: "15" },
      { label: "Every 30 minutes", value: "30" },
      { label: "Every 60 minutes", value: "60" },
    ]);
  });

  test("a saved period that is none of those shows as itself, in order", () => {
    expect(loopOptions(45).map((option) => option.label)).toEqual([
      "Off",
      "Every 5 minutes",
      "Every 15 minutes",
      "Every 30 minutes",
      "Every 45 minutes",
      "Every 60 minutes",
    ]);
    expect(loopOptions(1).map((option) => option.label)[1]).toBe("Every minute");
    expect(loopOptions(1440).at(-1)).toEqual({ label: "Every 1440 minutes", value: "1440" });
  });

  test("the select's value and the period round-trip", () => {
    for (const minutes of [null, 1, 5, 45, 1440]) expect(loopMinutesOf(loopValue(minutes))).toBe(minutes);
  });

  test("one sentence says what the loop starts and what it leaves to you", () => {
    expect(LOOP_HINT.match(/\./g)).toHaveLength(1);
    expect(LOOP_HINT).toContain("starts Queued work under the run cap");
    expect(LOOP_HINT).toContain("leaves work that skips permission prompts");
  });
});
