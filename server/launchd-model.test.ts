import { describe, expect, test } from "bun:test";
import { calendarSpecs } from "./cron";
import { sleptThrough } from "./fake-awake";
import {
  CALENDAR_GRACE_MS,
  elapsedMs,
  exitKey,
  INTERVAL_GRACE_MS,
  type LaunchdExit,
  launchdRuns,
  launchdStatus,
  launchdUpcoming,
  logStamps,
  logTime,
  parseExitLine,
  parseExits,
  parseList,
  parsePrint,
  stampRuns,
} from "./launchd-model";

const M = 60_000;
const H = 60 * M;
const NOW = Date.parse("2026-10-02T21:20:00Z");
const iso = (at: number) => new Date(at).toISOString();

/** `launchctl print gui/501/com.broomva.kg-lint` as the Mac printed it, trimmed. */
const PRINT = `gui/501/com.broomva.kg-lint = {
\tactive count = 0
\tpath = /Users/broomva/Library/LaunchAgents/com.broomva.kg-lint.plist
\ttype = LaunchAgent
\tstate = not running

\tprogram = /bin/bash
\targuments = {
\t\t/bin/bash
\t\t/Users/broomva/broomva/scripts/bookkeeping-scheduled.sh
\t\tlint
\t}

\tstdout path = /tmp/broomva-kg-lint.log
\tstderr path = /tmp/broomva-kg-lint.log
\tdefault environment = {
\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin
\t}

\truns = 1
\tlast exit code = 0

\tevent triggers = {
\t\tcom.broomva.kg-lint.268435472 => {
\t\t\tstate = active
\t\t\tdescriptor = {
\t\t\t\t"Minute" => 30
\t\t\t}
\t\t}
\t}
}`;

/** One ndjson line of `log show`, as launchd writes a run end. */
const line = (label: string, pid: number, timestamp: string, message: string) =>
  JSON.stringify({ subsystem: `gui/501/${label} [${pid}]`, eventMessage: message, timestamp, processID: 1 });

describe("launchctl", () => {
  test("list: the jobs under the prefix, with their pid and last exit status", () => {
    const text =
      "PID\tStatus\tLabel\n-\t0\tcom.broomva.kg-lint\n4321\t0\tcom.broomva.moltbook-loop\n-\t-9\tcom.broomva.disk-janitor\n-\t0\tcom.apple.Safari\n";
    expect(parseList(text, "com.broomva.")).toEqual([
      { label: "com.broomva.kg-lint", pid: null, status: 0 },
      { label: "com.broomva.moltbook-loop", pid: 4321, status: 0 },
      { label: "com.broomva.disk-janitor", pid: null, status: -9 },
    ]);
  });

  test("print: the top-level keys only, never a nested block's", () => {
    expect(parsePrint(PRINT)).toEqual({
      path: "/Users/broomva/Library/LaunchAgents/com.broomva.kg-lint.plist",
      state: "not running",
      pid: null,
      lastExit: 0,
      stdout: "/tmp/broomva-kg-lint.log",
      intervalSeconds: null,
    });
    const running = parsePrint(
      "x = {\n\tstate = running\n\tpid = 812\n\tlast exit code = (never exited)\n\trun interval = 900 seconds\n}",
    );
    expect(running).toMatchObject({ state: "running", pid: 812, lastExit: null, intervalSeconds: 900 });
    expect(parsePrint("x = {\n\tlast exit code = 78: Function not implemented\n}").lastExit).toBe(78);
  });

  test("ps etime: [[dd-]hh:]mm:ss", () => {
    expect(elapsedMs("01:23")).toBe(83_000);
    expect(elapsedMs(" 02:03:04 ")).toBe((2 * 3600 + 3 * 60 + 4) * 1000);
    expect(elapsedMs("1-00:00:01")).toBe(86_401_000);
    expect(elapsedMs("soon")).toBeNull();
  });
});

describe("the unified log", () => {
  test("a timestamp with its zone, to the millisecond", () => {
    expect(iso(logTime("2026-10-01 21:55:17.002063-0500") ?? 0)).toBe("2026-10-02T02:55:17.002Z");
    expect(logTime("yesterday")).toBeNull();
  });

  test("a run end: its job, pid, exit or signal, and how long it ran", () => {
    expect(
      parseExitLine(
        line(
          "com.broomva.moltbook-loop",
          88036,
          "2026-10-01 21:55:17.002063-0500",
          "exited due to exit(0), ran for 39ms",
        ),
      ),
    ).toEqual({
      label: "com.broomva.moltbook-loop",
      pid: 88036,
      endedAt: Date.parse("2026-10-02T02:55:17.002Z"),
      exit: 0,
      signal: null,
      byLaunchd: false,
      ranMs: 39,
    });
    expect(
      parseExitLine(
        line(
          "com.broomva.kg-lint",
          7,
          "2026-10-02 02:30:05.000000-0500",
          "exited due to SIGKILL | sent by launchd[1], ran for 5000ms",
        ),
      ),
    ).toMatchObject({ exit: null, signal: "SIGKILL", byLaunchd: true, ranMs: 5000 });
    // Anything else launchd says about a job is not a run end.
    expect(
      parseExitLine(
        line("com.broomva.kg-lint", 7, "2026-10-02 02:30:05.000000-0500", "service inactive: com.broomva.kg-lint"),
      ),
    ).toBeNull();
    expect(parseExitLine("{not json")).toBeNull();
  });

  test("a stream: run ends oldest first, the closing summary and any noise skipped", () => {
    const text = [
      line("com.broomva.a", 2, "2026-10-02 10:00:00.000000-0500", "exited due to exit(1), ran for 10ms"),
      line("com.broomva.a", 1, "2026-10-02 09:00:00.000000-0500", "exited due to exit(0), ran for 10ms"),
      '{"count":2,"finished":1}',
      "",
    ].join("\n");
    const exits = parseExits(text);
    expect(exits.map((exit) => exit.exit)).toEqual([0, 1]);
    expect(new Set(exits.map(exitKey)).size).toBe(2);
  });
});

describe("the job's own log", () => {
  test("its stamps, grouped into runs by a five-minute gap", () => {
    const text = [
      "==========",
      "[2026-10-01T07:00:01Z] pass 'compile' start",
      "[2026-10-01T07:00:40Z] pass 'compile' done (rc=0)",
      "Deleted branch research/kg-compile-2026-10-02T07-00-01Z",
      "[2026-10-02T07:00:01Z] skip research/x.md",
      "2026-10-02T07:02:00Z no page differs",
    ].join("\n");
    const stamps = logStamps(text);
    expect(stamps.map(iso)).toEqual([
      "2026-10-01T07:00:01.000Z",
      "2026-10-01T07:00:40.000Z",
      "2026-10-02T07:00:01.000Z",
      "2026-10-02T07:02:00.000Z",
    ]);
    expect(stampRuns(stamps).map((run) => [iso(run.start), iso(run.end)])).toEqual([
      ["2026-10-01T07:00:01.000Z", "2026-10-01T07:00:40.000Z"],
      ["2026-10-02T07:00:01.000Z", "2026-10-02T07:02:00.000Z"],
    ]);
  });
});

const exit = (
  endedAt: number,
  code: number | null,
  ranMs = 1000,
  signal: string | null = null,
  byLaunchd = false,
): LaunchdExit => ({
  label: "com.broomva.x",
  pid: endedAt % 1000,
  endedAt,
  exit: code,
  signal,
  byLaunchd,
  ranMs,
});

describe("a job's runs", () => {
  test("the unified log's run ends, newest first, each with its exit", () => {
    const runs = launchdRuns({
      exits: [exit(NOW - 2 * H, 0), exit(NOW - H, 1)],
      logged: [],
      logWrittenAt: null,
      lastExit: 1,
      running: null,
      now: NOW,
    });
    expect(runs.map((run) => [run.at, run.status, run.exit, run.detail])).toEqual([
      [iso(NOW - H - 1000), "failed", 1, "exit 1"],
      [iso(NOW - 2 * H - 1000), "ok", 0, "exit 0"],
    ]);
  });

  test("the job's log adds the runs the unified log no longer keeps; one both saw is one run", () => {
    const runs = launchdRuns({
      exits: [exit(Date.parse("2026-10-02T07:00:18Z"), 0, 17_000)],
      logged: [
        { start: Date.parse("2026-10-01T07:00:01Z"), end: Date.parse("2026-10-01T07:00:40Z") },
        { start: Date.parse("2026-10-02T07:00:01Z"), end: Date.parse("2026-10-02T07:00:01Z") },
      ],
      logWrittenAt: Date.parse("2026-10-02T07:00:18Z"),
      lastExit: 0,
      running: null,
      now: NOW,
    });
    expect(runs.map((run) => [run.at, run.status, run.detail])).toEqual([
      ["2026-10-02T07:00:01.000Z", "ok", "exit 0"],
      ["2026-10-01T07:00:01.000Z", "unknown", "from its log"],
    ]);
  });

  test("launchd's last exit code goes to the newest run only, when nothing else recorded how it ended", () => {
    const runs = launchdRuns({
      exits: [],
      logged: [
        { start: NOW - 30 * H, end: NOW - 30 * H },
        { start: NOW - 6 * H, end: NOW - 6 * H },
      ],
      logWrittenAt: null,
      lastExit: 3,
      running: null,
      now: NOW,
    });
    expect(runs.map((run) => [run.status, run.exit])).toEqual([
      ["failed", 3],
      ["unknown", null],
    ]);
  });

  test("a log written after every run seen stands for the newest run; an empty log stands for nothing", () => {
    const written = Date.parse("2026-09-27T09:06:34Z");
    const runs = launchdRuns({ exits: [], logged: [], logWrittenAt: written, lastExit: null, running: null, now: NOW });
    expect(runs).toEqual([
      {
        at: iso(written),
        endedAt: iso(written),
        status: "unknown",
        exit: null,
        detail: "its log was last written then",
      },
    ]);
    // A log last written before the newest run says nothing new.
    expect(
      launchdRuns({
        exits: [exit(NOW - H, 0)],
        logged: [],
        logWrittenAt: NOW - 3 * H,
        lastExit: 0,
        running: null,
        now: NOW,
      }),
    ).toHaveLength(1);
  });

  test("what the log says of a run still going is that run, never a finished one with the last exit", () => {
    const runs = launchdRuns({
      exits: [],
      logged: [
        { start: NOW - 2 * H, end: NOW - 2 * H },
        { start: NOW - 4 * M, end: NOW - M },
      ],
      logWrittenAt: NOW - M,
      lastExit: 1,
      running: { since: NOW - 5 * M },
      now: NOW,
    });
    expect(runs.map((run) => [run.at, run.status, run.exit])).toEqual([
      [iso(NOW - 5 * M), "running", null],
      [iso(NOW - 2 * H), "failed", 1],
    ]);
  });

  test("a stamp from the future is not a run", () => {
    const runs = launchdRuns({
      exits: [exit(NOW - H, 0)],
      logged: [{ start: NOW + 5 * H, end: NOW + 5 * H }],
      logWrittenAt: null,
      lastExit: 0,
      running: null,
      now: NOW,
    });
    expect(runs.map((run) => run.at)).toEqual([iso(NOW - H - 1000)]);
  });

  test("a run going now comes first, and launchd's last exit stays with the run before it", () => {
    const runs = launchdRuns({
      exits: [],
      logged: [{ start: NOW - 2 * H, end: NOW - 2 * H }],
      logWrittenAt: null,
      lastExit: 0,
      running: { since: NOW - 5 * M },
      now: NOW,
    });
    expect(runs.map((run) => [run.at, run.status, run.exit])).toEqual([
      [iso(NOW - 5 * M), "running", null],
      [iso(NOW - 2 * H), "ok", 0],
    ]);
  });

  test("a signal is a failure, with its name", () => {
    const [run] = launchdRuns({
      exits: [exit(NOW - H, null, 10, "SIGKILL")],
      logged: [],
      logWrittenAt: null,
      lastExit: null,
      running: null,
      now: NOW,
    });
    expect(run).toMatchObject({ status: "failed", detail: "killed by SIGKILL" });
  });
});

const run = (at: number, status: "ok" | "failed" | "unknown" | "running" = "ok") => ({
  at: iso(at),
  endedAt: status === "running" ? null : iso(at + 1000),
  status,
  exit: status === "ok" ? 0 : status === "failed" ? 1 : null,
  detail: null,
});
const interval = { intervalMs: 15 * M, calendar: null };
const base = { loaded: true, seen: { from: NOW - 20 * H, to: NOW }, awake: sleptThrough(NOW), installedAt: null };

describe("a job's status", () => {
  test("not loaded is off; a run going is running; a newest run that failed is failed", () => {
    expect(launchdStatus({ ...base, loaded: false, schedule: interval, runs: [] }).status).toBe("off");
    expect(
      launchdStatus({ ...base, schedule: interval, runs: [run(NOW - M, "running"), run(NOW - H, "failed")] }).status,
    ).toBe("running");
    const failed = launchdStatus({
      ...base,
      schedule: interval,
      runs: [{ ...run(NOW - 5 * M, "failed"), detail: "exit 1" }],
    });
    expect(failed).toMatchObject({ status: "failed", reason: "Its last run failed: exit 1.", since: iso(NOW - 5 * M) });
    // A later run that passed puts it back on time.
    expect(
      launchdStatus({ ...base, schedule: interval, runs: [run(NOW - 5 * M), run(NOW - 20 * M, "failed")] }).status,
    ).toBe("ok");
  });

  test("on an interval: missed after two intervals and a grace with no run, from the newest run's end", () => {
    // run() lasts a second: this one ended two intervals and the grace ago, and a millisecond more.
    const ended = NOW - (2 * 15 * M + INTERVAL_GRACE_MS) - 1;
    const missed = launchdStatus({ ...base, schedule: interval, runs: [run(ended - 1000)] });
    expect(missed).toMatchObject({ status: "missed", since: iso(ended + 15 * M) });
    expect(missed.missed.map((one) => one.at)).toEqual([iso(ended + 15 * M)]);
    expect(launchdStatus({ ...base, schedule: interval, runs: [run(ended - 1000 + 2)] }).status).toBe("ok");
  });

  test("on an interval: only awake time counts, so a Mac that slept since its last run is given the sleep", () => {
    const last = NOW - 6 * H;
    expect(
      launchdStatus({
        ...base,
        awake: sleptThrough(NOW, [[last + 1000, NOW - 10 * M]]),
        schedule: interval,
        runs: [run(last)],
      }).status,
    ).toBe("ok");
    expect(
      launchdStatus({
        ...base,
        awake: sleptThrough(NOW, [[last + 1000, NOW - 40 * M]]),
        schedule: interval,
        runs: [run(last)],
      }).status,
    ).toBe("missed");
  });

  test("with no run seen: missed only from where the log reaches, and unknown when it reaches nowhere", () => {
    expect(launchdStatus({ ...base, schedule: interval, runs: [] }).status).toBe("missed");
    expect(launchdStatus({ ...base, seen: { from: NOW - 20 * M, to: NOW }, schedule: interval, runs: [] }).status).toBe(
      "unknown",
    );
    expect(launchdStatus({ ...base, seen: null, schedule: interval, runs: [] })).toMatchObject({
      status: "unknown",
      reason: "No run seen yet.",
    });
  });

  test("with the unified log never read, nothing is called missed, and the row says it cannot tell", () => {
    // Its last run was hours ago on a 15-minute interval: missed if the log had been read, not known if not.
    expect(launchdStatus({ ...base, schedule: interval, runs: [run(NOW - 3 * H)] }).status).toBe("missed");
    expect(launchdStatus({ ...base, seen: null, schedule: interval, runs: [run(NOW - 3 * H)] })).toMatchObject({
      status: "ok",
      reason: "Its last run passed; whether one was missed since cannot be told until the unified log reads.",
    });
  });

  test("a run the job's own log shows from before the unified log's reach does not open the gap to it", () => {
    // Sundays at 02:30; it last wrote its log twelve days ago; the unified log reaches 20 h back.
    const weekly = { intervalMs: null, calendar: calendarSpecs({ Weekday: 0, Hour: 2, Minute: 30 }) };
    const old = run(NOW - 12 * 24 * H, "unknown");
    expect(launchdStatus({ ...base, schedule: weekly, runs: [old] }).status).toBe("unknown");
    // On an interval, the gap is counted from where the log begins, not from the old run.
    const twoHourly = { intervalMs: 2 * H, calendar: null };
    const stale = launchdStatus({ ...base, seen: { from: NOW - 5 * H, to: NOW }, schedule: twoHourly, runs: [old] });
    expect(stale).toMatchObject({ status: "missed", reason: "No run seen in the unified log; it runs every 2h." });
    // Due an interval after the log begins; with two intervals and the grace gone, missed.
    expect(stale.since).toBe(iso(NOW - 3 * H));
  });

  test("on a calendar: a due time after the newest run, past its grace, is missed", () => {
    const calendar = { intervalMs: null, calendar: calendarSpecs({ Minute: 0 }) };
    // Hourly at :00. NOW is 21:20Z: 21:00Z is 20 min ago, inside the grace; 20:00Z is past it.
    const lastRan = Date.parse("2026-10-02T19:00:05Z");
    const missed = launchdStatus({ ...base, schedule: calendar, runs: [run(lastRan)] });
    expect(missed.status).toBe("missed");
    expect(missed.missed.map((one) => one.at)).toEqual(["2026-10-02T20:00:00.000Z"]);
    expect(missed.since).toBe("2026-10-02T20:00:00.000Z");
    // The 21:00 run came: on time.
    expect(launchdStatus({ ...base, schedule: calendar, runs: [run(Date.parse("2026-10-02T21:00:03Z"))] }).status).toBe(
      "ok",
    );
    // 20:00 ran, 21:00 is due but within its grace.
    expect(launchdStatus({ ...base, schedule: calendar, runs: [run(Date.parse("2026-10-02T20:00:02Z"))] }).status).toBe(
      "ok",
    );
  });

  test("on a calendar: a Mac asleep at the due time has its grace in awake time, from the wake", () => {
    const calendar = { intervalMs: null, calendar: calendarSpecs({ Minute: 0 }) };
    const lastRan = Date.parse("2026-10-02T19:00:05Z");
    const woke = NOW - CALENDAR_GRACE_MS + M;
    expect(
      launchdStatus({
        ...base,
        awake: sleptThrough(NOW, [[lastRan + 1000, woke]]),
        schedule: calendar,
        runs: [run(lastRan)],
      }).status,
    ).toBe("ok");
  });

  test("on a calendar: a due time before the log reaches is not judged", () => {
    const calendar = { intervalMs: null, calendar: calendarSpecs({ Minute: 0 }) };
    expect(launchdStatus({ ...base, seen: { from: NOW - 10 * M, to: NOW }, schedule: calendar, runs: [] }).status).toBe(
      "unknown",
    );
    expect(launchdStatus({ ...base, seen: { from: NOW - 3 * H, to: NOW }, schedule: calendar, runs: [] }).status).toBe(
      "missed",
    );
  });

  test("a newest run whose exit was not recorded is not known, never on time", () => {
    expect(launchdStatus({ ...base, schedule: interval, runs: [run(NOW - M, "unknown")] })).toMatchObject({
      status: "unknown",
      reason: "Its last run's exit was not recorded.",
    });
  });

  test("a long run that ended a moment ago is not missed: the clock runs from its end", () => {
    // Every 15 minutes; the newest run started 40 minutes ago and ran 39 of them.
    const long = { at: iso(NOW - 40 * M), endedAt: iso(NOW - M), status: "ok" as const, exit: 0, detail: null };
    expect(launchdStatus({ ...base, schedule: interval, runs: [long] }).status).toBe("ok");
    // A calendar due time that fell inside the run was folded into it.
    const calendar = { intervalMs: null, calendar: calendarSpecs({ Minute: 0 }) };
    const across = {
      at: "2026-10-02T19:50:00.000Z",
      endedAt: "2026-10-02T21:05:00.000Z",
      status: "ok" as const,
      exit: 0,
      detail: null,
    };
    expect(launchdStatus({ ...base, schedule: calendar, runs: [across] }).status).toBe("ok");
  });

  test("a job cannot miss a run due before its plist was written", () => {
    const calendar = { intervalMs: null, calendar: calendarSpecs({ Minute: 0 }) };
    // No run yet, the log reaches 3 h back, and 20:00 passed its grace: missed, unless the job is newer than that.
    expect(launchdStatus({ ...base, seen: { from: NOW - 3 * H, to: NOW }, schedule: calendar, runs: [] }).status).toBe(
      "missed",
    );
    expect(
      launchdStatus({
        ...base,
        seen: { from: NOW - 3 * H, to: NOW },
        installedAt: NOW - 40 * M,
        schedule: calendar,
        runs: [],
      }).status,
    ).toBe("unknown");
  });

  test("judged at the read's horizon: what came due after it is not missed, however late it is now", () => {
    const last = NOW - 3 * H;
    expect(launchdStatus({ ...base, schedule: interval, runs: [run(last)] }).status).toBe("missed");
    // The evidence reaches 10 minutes past that run: nothing was due yet then.
    expect(
      launchdStatus({ ...base, seen: { from: NOW - 20 * H, to: last + 10 * M }, schedule: interval, runs: [run(last)] })
        .status,
    ).toBe("ok");
  });

  test("launchd stopping a run (SIGTERM, at logout or unload) is not a failure", () => {
    const [stopped] = launchdRuns({
      exits: [exit(NOW - 5 * M, null, 10, "SIGTERM", true)],
      logged: [],
      logWrittenAt: null,
      lastExit: null,
      running: null,
      now: NOW,
    });
    expect(stopped).toMatchObject({ status: "unknown", detail: "stopped by launchd (SIGTERM)" });
    expect(launchdStatus({ ...base, schedule: interval, runs: stopped ? [stopped] : [] })).toMatchObject({
      status: "unknown",
      reason: "launchd stopped its last run (SIGTERM).",
    });
    // A SIGTERM from anyone else, or launchd's SIGKILL, still is.
    const [killed] = launchdRuns({
      exits: [exit(NOW - H, null, 10, "SIGKILL", true)],
      logged: [],
      logWrittenAt: null,
      lastExit: null,
      running: null,
      now: NOW,
    });
    expect(killed?.status).toBe("failed");
  });
});

describe("a job's runs to come", () => {
  test("on a calendar: the window's due times, and a weekly job's next past the window", () => {
    const weekly = { intervalMs: null, calendar: calendarSpecs({ Weekday: 0, Hour: 2, Minute: 30 }) };
    const local = new Date(2026, 9, 2, 16, 0).getTime();
    const { next, upcoming } = launchdUpcoming(weekly, null, local, local + 24 * H, 100);
    expect(upcoming).toEqual([]);
    expect(next).toBe(new Date(2026, 9, 4, 2, 30).getTime());
  });

  test("on an interval: an interval after the newest run, and on, within the window", () => {
    const { next, upcoming } = launchdUpcoming(interval, NOW - 5 * M, NOW, NOW + H, 100);
    expect(next).toBe(NOW + 10 * M);
    expect(upcoming).toEqual([NOW + 10 * M, NOW + 25 * M, NOW + 40 * M, NOW + 55 * M]);
    // A little late: due now, and the next ones keep its rhythm.
    const late = launchdUpcoming(interval, NOW - 17 * M, NOW, NOW + 30 * M, 100);
    expect(late.next).toBe(NOW - 2 * M);
    expect(late.upcoming).toEqual([NOW + 13 * M, NOW + 28 * M]);
    // Overdue past its grace: when it runs next is not known.
    expect(launchdUpcoming(interval, NOW - 3 * H, NOW, NOW + H, 100)).toEqual({ next: null, upcoming: [] });
    expect(launchdUpcoming(interval, null, NOW, NOW + H, 100)).toEqual({ next: null, upcoming: [] });
  });
});
