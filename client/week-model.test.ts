import { describe, expect, test } from "bun:test";
import type { WeekDay } from "../shared/contracts";
import { barValue, dayBars, overlapNote, weekTotal, whereHoursWent } from "./week-model";

const NOW = new Date(2026, 8, 29, 15).getTime();
const H = 3_600_000;
const day = (date: string, hours: number, looks = 0, longest = 0): WeekDay => ({
  date,
  unsupervisedMs: hours * H,
  looks,
  longestRunMs: longest * H,
});
const week = [
  day("2026-09-23", 0),
  day("2026-09-24", 1),
  day("2026-09-25", 4, 2, 3),
  day("2026-09-26", 0),
  day("2026-09-27", 0.5),
  day("2026-09-28", 2),
  day("2026-09-29", 1.25, 1, 1),
];

describe("the week's bars", () => {
  test("hours as a bar holds them", () => {
    expect(barValue(0)).toBe("0m");
    expect(barValue(45 * 60_000)).toBe("45m");
    expect(barValue(H)).toBe("1h");
    expect(barValue(2.5 * H)).toBe("2.5h");
    expect(barValue(2 * H + 4 * 60_000)).toBe("2.1h");
  });

  test("seven bars, each with its day and hours in words, heights against the tallest day", () => {
    const bars = dayBars(week, NOW);
    expect(bars.map((bar) => bar.day)).toEqual(["Wed", "Thu", "Fri", "Sat", "Sun", "Mon", "Today"]);
    expect(bars.map((bar) => bar.value)).toEqual(["0m", "1h", "4h", "0m", "30m", "2h", "1.3h"]);
    expect(bars.map((bar) => bar.height)).toEqual([0, 0.25, 1, 0, 0.125, 0.5, 0.3125]);
    expect(bars.map((bar) => bar.today)).toEqual([false, false, false, false, false, false, true]);
    expect(bars[2]?.label).toBe("Friday, September 25: 4h unsupervised, 2 looks, longest run 3h");
    expect(bars[6]?.label).toBe("Today: 1h 15m unsupervised, 1 look, longest run 1h");
    expect(bars[0]?.label).toBe("Wednesday, September 23: 0m unsupervised, 0 looks");
  });

  test("a week with nothing in it has flat bars, not a division by zero", () => {
    const bars = dayBars([day("2026-09-29", 0)], NOW);
    expect(bars[0]?.height).toBe(0);
  });

  test("the week's total is the sum of its days", () => {
    expect(weekTotal(week)).toBe(8.75 * H);
  });
});

describe("where the hours went", () => {
  test("initiatives by hours, work outside any named for what it is, shares against the most", () => {
    const rows = whereHoursWent([
      { initiative: "hawthorne", unsupervisedMs: 4 * H },
      { initiative: null, unsupervisedMs: H },
      { initiative: "genesis", unsupervisedMs: 0 },
    ]);
    expect(rows).toEqual([
      { name: "hawthorne", ms: 4 * H, share: 1 },
      { name: "No initiative", ms: H, share: 0.25 },
    ]);
  });

  test("rows that add up to more than the week say why", () => {
    const rows = whereHoursWent([
      { initiative: "a", unsupervisedMs: 2 * H },
      { initiative: "b", unsupervisedMs: 2 * H },
    ]);
    expect(overlapNote(rows, 3 * H)).toContain("overlapped");
    expect(overlapNote(rows, 4 * H)).toBeNull();
  });
});
