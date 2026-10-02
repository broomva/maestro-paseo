import { describe, expect, test } from "bun:test";
import { calendarCadence, calendarSpecs, calendarWords, dueTimes, everyWords, knownZone, parseCron } from "./cron";

const H = 3_600_000;
const iso = (at: number) => new Date(at).toISOString();
/** A wall-clock time on the machine running the test: launchd's calendar is the Mac's own zone. */
const local = (month: number, day: number, hour: number, minute = 0) =>
  new Date(2026, month - 1, day, hour, minute).getTime();

describe("cron expressions", () => {
  test("fields read as cron does: lists, ranges, steps, names, Sunday as 0 or 7", () => {
    const spec = parseCron("*/15 9-17 1,15 jan-mar mon-fri");
    expect(spec && [...spec.minute]).toEqual([0, 15, 30, 45]);
    expect(spec && [...spec.hour]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(spec && [...spec.day]).toEqual([1, 15]);
    expect(spec && [...spec.month]).toEqual([1, 2, 3]);
    expect(spec && [...spec.weekday]).toEqual([1, 2, 3, 4, 5]);
    expect(parseCron("0 0 * * 7")?.weekday.has(0)).toBe(true);
    expect(parseCron("5/20 * * * *") && [...(parseCron("5/20 * * * *")?.minute ?? [])]).toEqual([5, 25, 45]);
    expect(parseCron("@hourly") && [...(parseCron("@hourly")?.minute ?? [])]).toEqual([0]);
  });

  test("what does not read is null, never a guess", () => {
    for (const bad of [
      "",
      "* * * *",
      "61 * * * *",
      "* 24 * * *",
      "*/0 * * * *",
      "0 0 32 * *",
      "a b c d e",
      "0 0 * * * *",
    ]) {
      expect(parseCron(bad)).toBeNull();
    }
  });

  test("a cron's due times in its own time zone", () => {
    const spec = parseCron("0 9 * * *");
    if (!spec) throw new Error("did not read");
    // Bogotá is UTC-5 all year: 09:00 there is 14:00 UTC.
    const from = Date.parse("2026-10-02T21:00:00Z");
    expect(dueTimes([spec], "America/Bogota", from, from + 48 * H, 10).map(iso)).toEqual([
      "2026-10-03T14:00:00.000Z",
      "2026-10-04T14:00:00.000Z",
    ]);
    // Strictly after `from`: a time exactly at it is not due again.
    expect(dueTimes([spec], "America/Bogota", Date.parse("2026-10-03T14:00:00Z"), from + 48 * H, 1).map(iso)).toEqual([
      "2026-10-04T14:00:00.000Z",
    ]);
  });

  test("a day of the month and a weekday both restricted match either, as cron does", () => {
    const spec = parseCron("0 12 1 * mon");
    if (!spec) throw new Error("did not read");
    // October 2026: the 1st is a Thursday, the 5th a Monday.
    const due = dueTimes([spec], "UTC", Date.parse("2026-09-30T00:00:00Z"), Date.parse("2026-10-06T00:00:00Z"), 10);
    expect(due.map(iso)).toEqual(["2026-10-01T12:00:00.000Z", "2026-10-05T12:00:00.000Z"]);
  });

  test("an unknown time zone is told apart", () => {
    expect(knownZone("America/Bogota")).toBe(true);
    expect(knownZone("Mars/Olympus")).toBe(false);
  });
});

describe("launchd's calendar", () => {
  test("a key left out is a wildcard, in the Mac's own zone", () => {
    const specs = calendarSpecs({ Weekday: 0, Hour: 2, Minute: 30 });
    if (!specs) throw new Error("did not read");
    // Friday 2 October 2026; the next Sunday is the 4th.
    expect(dueTimes(specs, undefined, local(10, 2, 16), local(10, 12, 0), 3)).toEqual([
      local(10, 4, 2, 30),
      local(10, 11, 2, 30),
    ]);
    // Only an hour: every minute of that hour, as launchd runs it.
    const hour = calendarSpecs({ Hour: 2 });
    if (!hour) throw new Error("did not read");
    expect(dueTimes(hour, undefined, local(10, 3, 1, 58), local(10, 3, 4), 100)).toHaveLength(60);
  });

  test("a list of dictionaries is their union; a bad value reads as nothing", () => {
    const specs = calendarSpecs([
      { Hour: 2, Minute: 0 },
      { Hour: 14, Minute: 0 },
    ]);
    if (!specs) throw new Error("did not read");
    expect(dueTimes(specs, undefined, local(10, 2, 0), local(10, 3, 0), 10)).toEqual([
      local(10, 2, 2),
      local(10, 2, 14),
    ]);
    expect(calendarSpecs({ Hour: 25 })).toBeNull();
    expect(calendarSpecs({ Minute: "30" })).toBeNull();
    expect(calendarSpecs([])).toBeNull();
    expect(calendarSpecs("daily")).toBeNull();
  });

  test("in words", () => {
    expect(calendarWords({ Hour: 2, Minute: 0 })).toBe("daily at 02:00");
    expect(calendarWords({ Weekday: 0, Hour: 2, Minute: 30 })).toBe("Sundays at 02:30");
    expect(calendarWords({ Weekday: 7, Hour: 4, Minute: 0 })).toBe("Sundays at 04:00");
    expect(calendarWords({ Minute: 30 })).toBe("hourly at :30");
    expect(calendarWords({ Day: 1, Hour: 3, Minute: 5 })).toBe("on day 1 at 03:05");
    expect(calendarWords({ Hour: 2 })).toBe("every minute from 02:00 to 02:59");
    expect(calendarCadence([{ Hour: 2, Minute: 0 }, { Minute: 15 }])).toBe("daily at 02:00; hourly at :15");
  });

  test("an interval in words", () => {
    expect(everyWords(900_000)).toBe("every 15 minutes");
    expect(everyWords(3_600_000)).toBe("every hour");
    expect(everyWords(2 * 3_600_000)).toBe("every 2 hours");
    expect(everyWords(86_400_000)).toBe("every day");
    expect(everyWords(60_000)).toBe("every minute");
    expect(everyWords(30_000)).toBe("every 30 seconds");
  });
});
