import { describe, expect, test } from "bun:test";
import type { TimelineRun, TimelineSource } from "../shared/timeline";
import {
  axisOf,
  axisTicks,
  labelOffset,
  lastWords,
  MERGE_GAP,
  marksOf,
  nextWords,
  noticeText,
  place,
  rowLabel,
  runLine,
  runsShown,
  sinceWords,
  sortSources,
  statusLabel,
  summaryLine,
  toneOf,
  tookWords,
  whenWords,
} from "./timeline-model";

const M = 60_000;
const H = 60 * M;
/** A local afternoon, so day words do not depend on the machine's zone. */
const NOW = new Date(2026, 9, 2, 16, 20).getTime();
const iso = (at: number) => new Date(at).toISOString();
const axis = { from: NOW - 24 * H, to: NOW + 24 * H, now: NOW };

function source(id: string, extra: Partial<TimelineSource> = {}): TimelineSource {
  return {
    id,
    kind: "launchd",
    name: id,
    cadence: "every 15 minutes",
    status: "ok",
    reason: "On schedule.",
    since: null,
    needsYou: false,
    next: null,
    upcoming: [],
    runs: [],
    last: null,
    where: null,
    hasLog: false,
    link: null,
    ...extra,
  };
}

const run = (
  at: number,
  status: TimelineRun["status"],
  endedAt: number | null = at + 1000,
  extra: Partial<TimelineRun> = {},
): TimelineRun => ({
  at: iso(at),
  endedAt: endedAt === null ? null : iso(endedAt),
  status,
  exit: status === "ok" ? 0 : status === "failed" ? 1 : null,
  detail: null,
  ...extra,
});

describe("the order", () => {
  test("what needs you first, failed before missed; then what runs; then by next run; off last", () => {
    const sorted = sortSources([
      source("off", { status: "off" }),
      source("later", { next: iso(NOW + 5 * H) }),
      source("missed", { status: "missed", needsYou: true }),
      source("sooner", { next: iso(NOW + H) }),
      source("running", { status: "running" }),
      source("failed", { status: "failed", needsYou: true }),
      source("fleet-missed-elsewhere", { kind: "fleet", status: "missed", needsYou: false }),
    ]);
    expect(sorted.map((one) => one.id)).toEqual([
      "failed",
      "missed",
      "fleet-missed-elsewhere",
      "running",
      "sooner",
      "later",
      "off",
    ]);
  });

  test("the header's line", () => {
    expect(summaryLine([source("a"), source("b", { needsYou: true })])).toBe("2 scheduled sources; 1 needs you.");
    expect(summaryLine([source("a")])).toBe("1 scheduled source; none needs you.");
  });
});

describe("the axis", () => {
  test("an instant's place, held inside", () => {
    expect(place(axis, NOW)).toBe(0.5);
    expect(place(axis, NOW - 48 * H)).toBe(0);
    expect(place(axis, NOW + 48 * H)).toBe(1);
    expect(axisOf({ from: iso(axis.from), to: iso(axis.to), now: iso(NOW) })).toEqual(axis);
  });

  test("runs as marks: a run's length kept, touching runs of one tone joined, a failure never joined to a pass", () => {
    const close = MERGE_GAP * 48 * H * 0.5;
    const marks = marksOf(
      source("x", {
        runs: [
          run(NOW - 3 * H, "ok"),
          run(NOW - 3 * H + close, "ok"),
          run(NOW - 3 * H + 2 * close, "failed"),
          run(NOW - 10 * H, "ok", NOW - 9 * H),
          run(NOW - 20 * H, "missed", null),
        ],
      }),
      axis,
    );
    expect(marks.map((mark) => mark.tone)).toEqual(["warn", "success", "success", "danger"]);
    const [missed, long] = marks;
    expect(missed?.width).toBe(0);
    expect(long?.width).toBeCloseTo(1 / 48, 5);
  });

  test("a run going reaches now", () => {
    const [mark] = marksOf(source("x", { runs: [run(NOW - 6 * H, "running", null)] }), axis);
    expect(mark?.left).toBeCloseTo(0.375, 5);
    expect((mark?.left ?? 0) + (mark?.width ?? 0)).toBeCloseTo(0.5, 5);
  });

  test("runs to come are hollow, the next among them marked; one past the window is not drawn", () => {
    const marks = marksOf(
      source("x", { next: iso(NOW + H), upcoming: [iso(NOW + H), iso(NOW + 2 * H), iso(NOW + 30 * H)] }),
      axis,
    );
    expect(marks.map((mark) => [mark.future, mark.next])).toEqual([
      [true, true],
      [true, false],
    ]);
    // A next run already due is drawn at now.
    const [due] = marksOf(source("x", { next: iso(NOW - 2 * M) }), axis);
    expect(due?.left).toBe(0.5);
  });

  test("hour labels on the local clock, none crowding now", () => {
    const ticks = axisTicks(axis, 6);
    expect(ticks.every((tick) => /^\d{2}:00$/.test(tick.label))).toBe(true);
    // 18:00 today is under three hours (half a step) from now (16:20): its label would sit on now's.
    expect(ticks.map((tick) => tick.label)).toEqual(["18:00", "00:00", "06:00", "12:00", "00:00", "06:00", "12:00"]);
    expect(ticks.every((tick) => Math.abs(tick.left - 0.5) >= 3 / 48)).toBe(true);
    // A phone's 12-hour labels keep six hours clear of now: 12:00 is 4h20m before 16:20.
    expect(axisTicks(axis, 12).map((tick) => tick.label)).toEqual(["00:00", "00:00", "12:00"]);
  });
});

describe("words", () => {
  test("an instant from now", () => {
    expect(whenWords(new Date(2026, 9, 2, 14, 0).getTime(), NOW)).toBe("14:00");
    expect(whenWords(new Date(2026, 9, 1, 21, 55).getTime(), NOW)).toBe("yesterday 21:55");
    expect(whenWords(new Date(2026, 9, 3, 9, 0).getTime(), NOW)).toBe("tomorrow 09:00");
    expect(whenWords(new Date(2026, 9, 4, 4, 0).getTime(), NOW)).toBe("Sun 04:00");
    expect(whenWords(new Date(2026, 9, 12, 4, 0).getTime(), NOW)).toBe("Oct 12 04:00");
  });

  test("the next run", () => {
    expect(nextWords(source("x", { next: iso(NOW + 12 * M) }), NOW)).toBe("Next in 12 min");
    expect(nextWords(source("x", { next: iso(new Date(2026, 9, 3, 9, 0).getTime()) }), NOW)).toBe(
      "Next tomorrow 09:00",
    );
    expect(nextWords(source("x", { next: iso(NOW - M) }), NOW)).toBe("Due now");
    expect(nextWords(source("x", { status: "off" }), NOW)).toBeNull();
    expect(nextWords(source("x"), NOW)).toBe("No next run known");
  });

  test("the last run, and how long a run took", () => {
    expect(lastWords(source("x"), NOW)).toBe("No run yet");
    expect(lastWords(source("x", { last: run(new Date(2026, 9, 2, 16, 17).getTime(), "ok") }), NOW)).toBe(
      "Last 16:17, passed",
    );
    expect(lastWords(source("x", { last: run(new Date(2026, 9, 2, 2, 0).getTime(), "failed") }), NOW)).toBe(
      "Last 02:00, failed (exit 1)",
    );
    expect(lastWords(source("x", { last: run(NOW - H, "unknown") }), NOW)).toContain("exit not recorded");
    expect(tookWords(run(NOW, "ok", NOW + 26))).toBe("26 ms");
    expect(tookWords(run(NOW, "ok", NOW + 10_400))).toBe("10 s");
    expect(tookWords(run(NOW, "ok", NOW + 65 * M))).toBe("1 h 5 min");
    expect(tookWords(run(NOW, "running", null))).toBeNull();
  });

  test("a run's line in the detail: when, how it ended, how long, and what it said", () => {
    const at = new Date(2026, 9, 2, 16, 2).getTime();
    expect(runLine(run(at, "ok", at + 22, { detail: "exit 0" }), NOW)).toBe("16:02 · passed · 22 ms · exit 0");
    expect(runLine(run(at, "failed", at + 2000, { detail: "killed by SIGKILL", exit: null }), NOW)).toBe(
      "16:02 · failed · 2 s · killed by SIGKILL",
    );
    expect(runLine(run(at, "missed", null, { detail: "due, and it did not run" }), NOW)).toBe(
      "16:02 · missed · due, and it did not run",
    );
  });

  test("since, only for what needs you", () => {
    const at = new Date(2026, 9, 2, 2, 30).getTime();
    expect(sinceWords(source("x", { status: "failed", since: iso(at) }), NOW)).toBe("since 02:30");
    expect(sinceWords(source("x", { status: "ok", since: iso(at) }), NOW)).toBeNull();
  });

  test("statuses keep their words beside their color", () => {
    expect(
      ["failed", "missed", "running", "ok", "off", "unknown"].map((status) => statusLabel(status as never)),
    ).toEqual(["Failed", "Missed", "Running", "On time", "Off", "Not known"]);
    expect(
      ["failed", "missed", "ok", "running", "skipped", "unknown", "off"].map((status) => toneOf(status as never)),
    ).toEqual(["danger", "warn", "success", "accent", "muted", "muted", "muted"]);
  });

  test("a row read aloud, and a notice", () => {
    const row = source("kg-lint", {
      name: "kg-lint",
      status: "failed",
      needsYou: true,
      reason: "Its last run failed: exit 1.",
      next: iso(NOW + 30 * M),
    });
    // One period between sentences, though the reason brings its own.
    expect(rowLabel(row, NOW)).toBe(
      "kg-lint, launchd. Failed. Its last run failed: exit 1. No run yet. Next in 30 min",
    );
    // Its time comes from `since`, so the words the header count reads do not change minute to minute.
    const due = new Date(2026, 9, 2, 14, 0).getTime();
    expect(
      noticeText(
        { name: "kg-lint", status: "missed", reason: "A run came due and it has not run.", since: iso(due) },
        NOW,
      ),
    ).toBe("kg-lint: missed run 14:00. A run came due and it has not run.");
    expect(
      noticeText({ name: "kg-lint", status: "failed", reason: "Its last run failed: exit 1.", since: null }, NOW),
    ).toBe("kg-lint: failed run. Its last run failed: exit 1.");
  });

  test("an axis label at either end stays inside the row", () => {
    expect(labelOffset(0.01, 56)).toBe(0);
    expect(labelOffset(0.5, 56)).toBe(-28);
    expect(labelOffset(0.99, 56)).toBe(-56);
  });

  test("the detail lists a dozen runs and counts the rest", () => {
    const runs = Array.from({ length: 30 }, (_, index) => run(NOW - index * 15 * M, "ok"));
    const { shown, more } = runsShown(runs);
    expect(shown).toHaveLength(12);
    expect(more).toBe(18);
  });
});
