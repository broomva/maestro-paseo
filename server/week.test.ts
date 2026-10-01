import { describe, expect, test } from "bun:test";
import { localDate, scoreboard, shiftDays, type WorkEvent } from "./events";

/** Local times, so the week lines up with local midnights wherever the tests run. */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();
const TODAY = at(29, 0);
const NOW = at(29, 15);

const run = (from: number, to: number | null, extra: WorkEvent[] = []): WorkEvent[] => [
  { ts: new Date(from).toISOString(), type: "state", actor: "human", from: "proposed", to: "running", reason: null },
  ...(to === null
    ? []
    : [
        {
          ts: new Date(to).toISOString(),
          type: "state",
          actor: "maestro",
          from: "running",
          to: "review",
          reason: null,
        } as WorkEvent,
      ]),
  ...extra,
];
const look = (ts: number): WorkEvent => ({
  ts: new Date(ts).toISOString(),
  type: "gate",
  actor: "human",
  verdict: "approve",
  note: "",
});
const H = 3_600_000;

describe("the week behind today", () => {
  test("seven local days, oldest first and today last", () => {
    const board = scoreboard([], NOW, TODAY);
    expect(board.week.map((day) => day.date)).toEqual([
      "2026-09-23",
      "2026-09-24",
      "2026-09-25",
      "2026-09-26",
      "2026-09-27",
      "2026-09-28",
      "2026-09-29",
    ]);
    expect(board.week.every((day) => day.unsupervisedMs === 0 && day.looks === 0)).toBe(true);
  });

  test("each day is scored like today: a run over midnight counts on both sides, looks on their day", () => {
    const logs = [
      run(at(27, 22), at(28, 2), [look(at(28, 2, 30))]),
      run(at(29, 9), at(29, 11), [look(at(29, 11, 5))]),
      run(at(20, 9), at(20, 11)),
    ];
    const board = scoreboard(logs, NOW, TODAY);
    const byDate = Object.fromEntries(board.week.map((day) => [day.date, day]));
    expect(byDate["2026-09-27"]).toMatchObject({ unsupervisedMs: 2 * H, looks: 0, longestRunMs: 2 * H });
    expect(byDate["2026-09-28"]).toMatchObject({ unsupervisedMs: 2 * H, looks: 1, longestRunMs: 2 * H });
    // Today's entry is today's scoreboard.
    const today = board.week.at(-1);
    expect(today).toEqual({
      date: "2026-09-29",
      unsupervisedMs: board.unsupervisedMs,
      looks: board.looks,
      longestRunMs: board.longestRunMs,
    });
    expect(board.unsupervisedMs).toBe(2 * H);
    // A run from before the week counts nowhere in it.
    expect(board.week.reduce((sum, day) => sum + day.unsupervisedMs, 0)).toBe(6 * H);
  });

  test("a run still going counts up to now", () => {
    const board = scoreboard([run(at(29, 13), null)], NOW, TODAY);
    expect(board.week.at(-1)?.unsupervisedMs).toBe(2 * H);
    expect(board.live).toBe(true);
  });

  test("hours per initiative this week: overlaps count once within one, in each across two, most first", () => {
    const logs = [
      run(at(29, 9), at(29, 11)),
      run(at(29, 10), at(29, 12)),
      run(at(28, 9), at(28, 10)),
      run(at(29, 9), at(29, 10)),
      run(at(20, 9), at(20, 19)),
    ];
    const board = scoreboard(logs, NOW, TODAY, ["hawthorne", "hawthorne", "genesis", null, "genesis"]);
    expect(board.weekByInitiative).toEqual([
      { initiative: "hawthorne", unsupervisedMs: 3 * H },
      { initiative: "genesis", unsupervisedMs: 1 * H },
      { initiative: null, unsupervisedMs: 1 * H },
    ]);
  });

  test("without initiatives every hour is work outside any", () => {
    const board = scoreboard([run(at(29, 9), at(29, 10))], NOW, TODAY);
    expect(board.weekByInitiative).toEqual([{ initiative: null, unsupervisedMs: H }]);
  });

  test("days shift by the calendar, so a midnight stays a midnight", () => {
    expect(new Date(shiftDays(TODAY, -6)).getHours()).toBe(0);
    expect(localDate(shiftDays(TODAY, -6))).toBe("2026-09-23");
    expect(localDate(shiftDays(at(1, 0), -1))).toBe("2026-08-31");
  });
});
