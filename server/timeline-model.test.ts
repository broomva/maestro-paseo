import { describe, expect, test } from "bun:test";
import type { WakeEntry } from "../shared/contracts";
import type { FleetDetail, FleetScope } from "../shared/fleet";
import type { LaunchdJob } from "./launchd";
import {
  fleetSource,
  inWindow,
  LOOP_GRACE_MS,
  launchdSource,
  loopSource,
  SCHEDULE_GRACE_MS,
  type StoredSchedule,
  StoredScheduleSchema,
  scheduleSource,
  seenOf,
  tailOf,
  timelineNotices,
  wakeSummary,
} from "./timeline-model";

const M = 60_000;
const H = 60 * M;
const NOW = Date.parse("2026-10-02T21:20:00Z");
const window = { now: NOW, from: NOW - 24 * H, to: NOW + 24 * H };
const iso = (at: number) => new Date(at).toISOString();

function schedule(extra: Partial<StoredSchedule> & Record<string, unknown> = {}): StoredSchedule {
  return StoredScheduleSchema.parse({
    id: "63cc3450",
    name: "Resume the fleet",
    prompt: "You are the fleet coordinator.",
    cadence: { type: "cron", expression: "0 9 * * *", timezone: "America/Bogota" },
    target: { type: "new-agent", config: { provider: "claude", cwd: "/Users/me/broomva" } },
    status: "active",
    createdAt: "2026-10-01T10:16:44.819Z",
    updatedAt: "2026-10-01T12:46:01.018Z",
    nextRunAt: "2026-10-03T14:00:00.000Z",
    lastRunAt: null,
    pausedAt: null,
    expiresAt: null,
    maxRuns: null,
    runs: [],
    ...extra,
  });
}

const paseoRun = (at: number, status: "succeeded" | "failed" | "running", extra: Record<string, unknown> = {}) => ({
  id: `run-${at}`,
  scheduledFor: iso(at),
  startedAt: iso(at),
  endedAt: status === "running" ? null : iso(at + 5 * M),
  status,
  agentId: "4791055f-1726-4bb9-a010-1c201b43b7cf",
  workspaceId: "wks_1",
  output: null,
  error: null,
  ...extra,
});

describe("a Paseo schedule", () => {
  test("its schedule file reads as the daemon writes it, and a shape it does not know does not", () => {
    expect(schedule().cadence).toEqual({ type: "cron", expression: "0 9 * * *", timezone: "America/Bogota" });
    expect(StoredScheduleSchema.safeParse({ id: "x", cadence: { type: "lunar" } }).success).toBe(false);
  });

  test("on time: its next run, the runs its cron makes of the window after it, and where it runs", () => {
    const source = scheduleSource(schedule({ runs: [paseoRun(NOW - 7 * H, "succeeded")] }), window, "/s.json", null);
    expect(source).toMatchObject({
      id: "schedule:63cc3450",
      kind: "schedule",
      name: "Resume the fleet",
      cadence: "cron 0 9 * * * (America/Bogota)",
      status: "ok",
      needsYou: false,
      next: "2026-10-03T14:00:00.000Z",
      upcoming: ["2026-10-03T14:00:00.000Z"],
      where: "/s.json",
      link: { kind: "agent", agentId: "4791055f-1726-4bb9-a010-1c201b43b7cf" },
    });
    expect(source?.runs.map((run) => [run.at, run.status])).toEqual([[iso(NOW - 7 * H), "ok"]]);
  });

  test("an `every` cadence fills the window; a run limit and an expiry cut it short", () => {
    const every = { type: "every", everyMs: 6 * H };
    const next = iso(NOW + H);
    expect(
      scheduleSource(schedule({ cadence: every, nextRunAt: next } as never), window, null, null)?.upcoming,
    ).toEqual([iso(NOW + H), iso(NOW + 7 * H), iso(NOW + 13 * H), iso(NOW + 19 * H)]);
    expect(
      scheduleSource(
        schedule({ cadence: every, nextRunAt: next, maxRuns: 3, runs: [paseoRun(NOW - 5 * H, "succeeded")] } as never),
        window,
        null,
        null,
      )?.upcoming,
    ).toEqual([iso(NOW + H), iso(NOW + 7 * H)]);
    expect(
      scheduleSource(
        schedule({ cadence: every, nextRunAt: next, expiresAt: iso(NOW + 8 * H) } as never),
        window,
        null,
        null,
      )?.upcoming,
    ).toEqual([iso(NOW + H), iso(NOW + 7 * H)]);
  });

  test("a newest run that failed is failed, with Paseo's error, and needs you", () => {
    const source = scheduleSource(
      schedule({ runs: [paseoRun(NOW - 3 * H, "failed", { error: "Provider quota exhausted" })] } as never),
      window,
      null,
      null,
    );
    expect(source).toMatchObject({
      status: "failed",
      reason: "Its last run failed: Provider quota exhausted.",
      since: iso(NOW - 3 * H),
      needsYou: true,
    });
    expect(source?.runs[0]).toMatchObject({ status: "failed", detail: "Provider quota exhausted" });
  });

  test("a next run overdue past its grace with none started is missed, drawn where it was due", () => {
    const due = NOW - SCHEDULE_GRACE_MS - M;
    const source = scheduleSource(schedule({ nextRunAt: iso(due) }), window, null, null);
    expect(source).toMatchObject({ status: "missed", since: iso(due), needsYou: true });
    expect(source?.runs).toEqual([
      { at: iso(due), endedAt: null, status: "missed", exit: null, detail: "due, and it did not start" },
    ]);
    // Inside the grace it is only due.
    expect(scheduleSource(schedule({ nextRunAt: iso(NOW - M) }), window, null, null)?.status).toBe("ok");
    // A run going is running, however late.
    expect(
      scheduleSource(schedule({ nextRunAt: iso(due), runs: [paseoRun(due, "running")] } as never), window, null, null)
        ?.status,
    ).toBe("running");
  });

  test("paused is off and stays listed; completed or expired with nothing in the window is not listed", () => {
    expect(scheduleSource(schedule({ status: "paused", nextRunAt: null }), window, null, null)).toMatchObject({
      status: "off",
      reason: "Paused.",
      next: null,
    });
    expect(
      scheduleSource(
        schedule({ status: "completed", nextRunAt: null, runs: [paseoRun(NOW - 30 * H, "succeeded")] } as never),
        window,
        null,
        null,
      ),
    ).toBeNull();
    expect(scheduleSource(schedule({ expiresAt: iso(NOW - H) }), window, null, null)).toBeNull();
    // A one-shot that ran today stays, with its run.
    const ran = scheduleSource(
      schedule({ status: "completed", nextRunAt: null, runs: [paseoRun(NOW - 7 * H, "succeeded")] } as never),
      window,
      null,
      null,
    );
    expect(ran).toMatchObject({ status: "off", reason: "Completed: it has no runs left." });
    expect(ran?.runs).toHaveLength(1);
  });

  test("paused, completed or expired, a failed last run is history: off, and it never needs you", () => {
    const failed = [paseoRun(NOW - 72 * H, "failed", { error: "Provider quota exhausted" })];
    for (const extra of [
      { status: "paused", nextRunAt: null },
      { status: "completed", nextRunAt: null, maxRuns: 1 },
      { expiresAt: iso(NOW - H) },
    ]) {
      // Listed or not (a finished one with nothing in the window is not), it is never failed.
      const source = scheduleSource(schedule({ ...extra, runs: failed } as never), window, null, null);
      if (source) expect(source).toMatchObject({ status: "off", needsYou: false });
    }
    const paused = scheduleSource(
      schedule({ status: "paused", nextRunAt: null, runs: failed } as never),
      window,
      null,
      null,
    );
    expect(paused?.reason).toBe("Paused. Its last run failed: Provider quota exhausted.");
  });

  test("a next run overdue in the file is not a miss when a run started at or after it was due", () => {
    const due = NOW - 2 * H;
    // The daemon ran it and has not moved nextRunAt on yet.
    const source = scheduleSource(
      schedule({ nextRunAt: iso(due), runs: [paseoRun(due + 30_000, "succeeded")] } as never),
      window,
      null,
      null,
    );
    expect(source).toMatchObject({ status: "ok", needsYou: false });
    // A run that came before the due time does not cover it.
    const earlier = scheduleSource(
      schedule({ nextRunAt: iso(due), runs: [paseoRun(due - H, "succeeded")] } as never),
      window,
      null,
      null,
    );
    expect(earlier?.status).toBe("missed");
  });

  test("a schedule the Mac slept through has its grace from the wake", () => {
    const due = NOW - 2 * H;
    expect(scheduleSource(schedule({ nextRunAt: iso(due) }), window, null, NOW - 5 * M)?.status).toBe("ok");
    expect(scheduleSource(schedule({ nextRunAt: iso(due) }), window, null, NOW - 30 * M)?.status).toBe("missed");
  });

  test("a time zone this host does not know is said, and no runs are guessed in another", () => {
    const source = scheduleSource(
      schedule({ cadence: { type: "cron", expression: "0 9 * * *", timezone: "Mars/Olympus" } } as never),
      window,
      null,
      null,
    );
    expect(source?.cadence).toBe("cron 0 9 * * * (Mars/Olympus, a time zone this host does not know)");
    expect(source?.upcoming).toEqual(["2026-10-03T14:00:00.000Z"]);
  });

  test("a time in the file that does not read is left out, never sent as one", () => {
    const source = scheduleSource(
      schedule({
        runs: [
          paseoRun(NOW - H, "succeeded"),
          { ...paseoRun(NOW - 2 * H, "failed"), startedAt: "yesterday" },
          // Date takes a year past 9999; the wire does not.
          { ...paseoRun(NOW - 3 * H, "failed"), startedAt: "+010000-01-01T00:00:00.000Z" },
        ],
      } as never),
      window,
      null,
      null,
    );
    expect(source?.runs.map((run) => run.status)).toEqual(["ok"]);
    expect(source).toMatchObject({ status: "ok", last: { at: iso(NOW - H) } });
  });

  test("a heartbeat prompts its own session: kind, link and a name from its prompt when it has none", () => {
    const source = scheduleSource(
      schedule({
        name: null,
        prompt: "\n  Check the PR queue and report.\nMore.",
        target: { type: "agent", agentId: "6d1930cd-ad28-4046-ac6a-a3985d7fbfe1" },
        cadence: { type: "cron", expression: "13,43 * * * *" },
        nextRunAt: iso(NOW + 23 * M),
      } as never),
      window,
      "/h.json",
      null,
    );
    expect(source).toMatchObject({
      id: "heartbeat:63cc3450",
      kind: "heartbeat",
      name: "Check the PR queue and report.",
      link: { kind: "agent", agentId: "6d1930cd-ad28-4046-ac6a-a3985d7fbfe1" },
      where: "/h.json",
    });
    // Twice an hour for a day, its next first.
    expect(source?.upcoming[0]).toBe(iso(NOW + 23 * M));
    expect(source?.upcoming).toHaveLength(48);
  });
});

const wake = (at: number, extra: Partial<WakeEntry> = {}): WakeEntry => ({
  tickId: `w-${at}`,
  cause: "timer",
  wokeAt: iso(at),
  dispatched: [],
  deferred: [],
  needsYou: { gate: 0, stuck: 0, asking: 0 },
  quiet: [],
  unasked: [],
  flagged: [],
  cleared: [],
  narrative: [],
  ...extra,
});

describe("Maestro's loop", () => {
  test("its wakes in the window, each in a line, and its wakes to come", () => {
    const source = loopSource(
      { minutes: 15, nextAt: iso(NOW + 5 * M), ticking: false },
      [
        wake(NOW - 10 * M, {
          dispatched: [{ id: "a", title: "A" }],
          deferred: [{ id: "b", title: "B", reason: "at the run cap" }],
        }),
        wake(NOW - 25 * M, { skipped: "another check was already running" }),
        wake(NOW - 30 * H),
      ],
      window,
      null,
      "/wake-log.jsonl",
    );
    expect(source).toMatchObject({
      id: "loop",
      kind: "loop",
      status: "ok",
      cadence: "every 15 minutes",
      next: iso(NOW + 5 * M),
    });
    expect(source.runs.map((run) => [run.status, run.detail])).toEqual([
      ["ok", "Started 1, left 1 alone."],
      ["skipped", "Skipped: another check was already running."],
    ]);
    expect(source.upcoming.slice(0, 3)).toEqual([iso(NOW + 5 * M), iso(NOW + 20 * M), iso(NOW + 35 * M)]);
    expect(source.upcoming).toHaveLength(96);
  });

  test("off has nothing to come, and keeps its past wakes; waking is running", () => {
    const off = loopSource(
      { minutes: null, nextAt: null, ticking: false },
      [wake(NOW - H, { cause: "manual" })],
      window,
      null,
      null,
    );
    expect(off).toMatchObject({ status: "off", next: null, upcoming: [], needsYou: false });
    expect(off.runs).toHaveLength(1);
    expect(loopSource({ minutes: 5, nextAt: iso(NOW), ticking: true }, [], window, null, null).status).toBe("running");
  });

  test("a wake due past its grace that has not run is missed; after a sleep, from the wake", () => {
    const due = NOW - LOOP_GRACE_MS - M;
    expect(loopSource({ minutes: 15, nextAt: iso(due), ticking: false }, [], window, null, null)).toMatchObject({
      status: "missed",
      since: iso(due),
      needsYou: true,
      next: null,
    });
    expect(loopSource({ minutes: 15, nextAt: iso(due), ticking: false }, [], window, NOW - M, null).status).toBe("ok");
    // A timer does not count the sleep: up to a whole period after the wake it may still fire.
    expect(
      loopSource({ minutes: 15, nextAt: iso(NOW - 3 * H), ticking: false }, [], window, NOW - 18 * M, null).status,
    ).toBe("ok");
    expect(
      loopSource({ minutes: 15, nextAt: iso(NOW - 3 * H), ticking: false }, [], window, NOW - 21 * M, null).status,
    ).toBe("missed");
  });

  test("a wake in a line", () => {
    expect(wakeSummary(wake(NOW))).toBe("Did nothing new.");
    expect(
      wakeSummary(
        wake(NOW, {
          flagged: [{ id: "a", title: "A", kind: "quiet", reason: "x" }],
          cleared: [{ id: "b", title: "B" }],
        }),
      ),
    ).toBe("Flagged 1, cleared 1.");
  });
});

const scope = (extra: Partial<FleetScope> = {}): FleetScope => ({
  id: "broomva",
  mode: "report",
  dryRun: true,
  health: {
    status: "ok",
    reason: "Ticks every hour. The last, tick 35, passed.",
    notice: "Ticks every hour. The last, tick 35, passed.",
    since: iso(NOW - 45 * M),
    item: null,
    needsYou: false,
  },
  lastTick: { tick: 35, at: iso(NOW - 45 * M), status: "ok" },
  unreviewed: 0,
  openAsks: 0,
  ...extra,
});

const detail = (ticks: FleetDetail["ticks"]): FleetDetail => ({
  id: "broomva",
  stateDir: "/state/broomva",
  schedule: { scheduled: true, intervalMinutes: 60 },
  ticks,
  report: null,
  proposals: [],
  asks: [],
  alerts: [],
  warnings: [],
});

const tick = (
  n: number,
  at: number,
  status: FleetDetail["ticks"][number]["status"],
  extra: Partial<FleetDetail["ticks"][number]> = {},
) => ({
  tick: n,
  at: iso(at),
  finishedAt: status === "running" || status === "died" ? null : iso(at + 10_000),
  status,
  exit: status === "ok" ? 0 : status === "failed" ? 1 : null,
  steps: null,
  failedStep: null,
  dryRun: true,
  mode: "report",
  classCounts: null,
  openAsks: null,
  proposals: null,
  ...extra,
});

describe("a fleet scope", () => {
  test("its ticks are its runs, its health its status, its next an interval after the last tick", () => {
    const source = fleetSource(
      scope(),
      detail([tick(35, NOW - 45 * M, "ok"), tick(34, NOW - 105 * M, "failed", { failedStep: "tick-observe" })]),
      window,
    );
    expect(source).toMatchObject({
      id: "fleet:broomva",
      kind: "fleet",
      name: "fleet-reconcile broomva",
      cadence: "every hour",
      status: "ok",
      next: iso(NOW + 15 * M),
      link: { kind: "fleet", scope: "broomva" },
      where: "/state/broomva",
    });
    expect(source.runs.map((run) => [run.status, run.detail])).toEqual([
      ["ok", "tick 35"],
      ["failed", "tick 34, failed at tick-observe, exit 1"],
    ]);
    expect(source.upcoming).toHaveLength(24);
  });

  test("failing and missed map to failed and missed; it needs you as the Fleet view says, and never as a timeline notice", () => {
    const failing = fleetSource(
      scope({
        health: {
          status: "failing",
          reason: "Tick 35 failed.",
          notice: "Tick 35 failed.",
          since: iso(NOW - 45 * M),
          item: null,
          needsYou: true,
        },
      }),
      detail([tick(35, NOW - 45 * M, "failed")]),
      window,
    );
    expect(failing).toMatchObject({ status: "failed", needsYou: true, reason: "Tick 35 failed." });
    const covered = fleetSource(
      scope({
        health: {
          status: "missed",
          reason: "No tick for 3h.",
          notice: "No tick for 3h.",
          since: iso(NOW - 3 * H),
          item: { id: "w", title: "fleet alert", state: "review", group: "review", needsYou: true },
          needsYou: false,
        },
        lastTick: { tick: 35, at: iso(NOW - 3 * H), status: "ok" },
      }),
      detail([tick(35, NOW - 3 * H, "ok")]),
      window,
    );
    // In Needs you as the fleet's own alert work.
    expect(covered).toMatchObject({ status: "missed", needsYou: true, next: null });
    expect(covered.runs[0]).toMatchObject({ status: "missed", at: iso(NOW - 2 * H) });
    expect(timelineNotices([failing, covered])).toEqual([]);
  });

  test("a scope run only by hand is off, with nothing to come", () => {
    const source = fleetSource(
      scope({
        id: "sri",
        health: {
          status: "unscheduled",
          reason: "Not scheduled.",
          notice: "Not scheduled.",
          since: null,
          item: null,
          needsYou: false,
        },
      }),
      { ...detail([]), id: "sri", schedule: { scheduled: false, intervalMinutes: null } },
      window,
    );
    expect(source).toMatchObject({ status: "off", cadence: "by hand only", next: null, upcoming: [] });
  });
});

function job(extra: Partial<LaunchdJob> = {}): LaunchdJob {
  return {
    label: "com.broomva.kg-lint",
    loaded: true,
    printed: {
      path: "/LaunchAgents/com.broomva.kg-lint.plist",
      state: "not running",
      pid: null,
      lastExit: 0,
      stdout: "/tmp/kg-lint.log",
      intervalSeconds: null,
    },
    lastExit: 0,
    plist: { StartCalendarInterval: { Weekday: 0, Hour: 2, Minute: 30 } },
    installedAt: Date.parse("2026-09-20T00:00:00Z"),
    runningSince: null,
    running: false,
    logPath: "/tmp/kg-lint.log",
    logText:
      "==========\n[2026-09-29T16:00:50Z] P6 kg maintenance: lint\n[2026-09-29T16:00:50Z] SKIP: already fresh.\n",
    logWrittenAt: Date.parse("2026-09-29T16:00:50Z"),
    ...extra,
  };
}

describe("a launchd job", () => {
  const context = { exits: [], seen: { from: NOW - 20 * H, to: NOW }, awakeSince: null, prefix: "com.broomva." };

  test("its name, cadence, its newest run from its own log with launchd's exit, and its log's end", () => {
    const source = launchdSource(job(), context, window);
    expect(source).toMatchObject({
      id: "launchd:com.broomva.kg-lint",
      kind: "launchd",
      name: "kg-lint",
      cadence: "Sundays at 02:30",
      status: "ok",
      runs: [],
      where: "/tmp/kg-lint.log",
      link: null,
    });
    expect(source.last).toMatchObject({ at: "2026-09-29T16:00:50.000Z", status: "ok", exit: 0 });
    // Its log end is asked for when the row opens (timeline.log), never carried by the polled view.
    expect(source.hasLog).toBe(true);
    expect("tail" in source).toBe(false);
    expect(source.next).toBe(iso(new Date(2026, 9, 4, 2, 30).getTime()));
  });

  test("a failed newest run needs you; an unloaded job is off with nothing to come", () => {
    const failed = launchdSource(
      job({ plist: { StartInterval: 900 } }),
      {
        ...context,
        exits: [
          {
            label: "com.broomva.kg-lint",
            pid: 1,
            endedAt: NOW - 5 * M,
            exit: 1,
            signal: null,
            byLaunchd: false,
            ranMs: 2000,
          },
        ],
      },
      window,
    );
    expect(failed).toMatchObject({ status: "failed", needsYou: true, cadence: "every 15 minutes" });
    expect(timelineNotices([failed])).toEqual([
      {
        id: "launchd:com.broomva.kg-lint",
        kind: "launchd",
        name: "kg-lint",
        status: "failed",
        reason: "Its last run failed: exit 1.",
        since: iso(NOW - 5 * M - 2000),
      },
    ]);
    const off = launchdSource(job({ loaded: false, printed: null }), context, window);
    expect(off).toMatchObject({ status: "off", next: null, upcoming: [] });
  });

  test("judged at the read's horizon: an old read cannot call a run missed that came due after it", () => {
    const molt = job({
      label: "com.broomva.moltbook-loop",
      plist: { StartInterval: 900 },
      logText: null,
      logWrittenAt: null,
      printed: null,
    });
    const ran = [
      {
        label: "com.broomva.moltbook-loop",
        pid: 1,
        endedAt: NOW - 60 * M,
        exit: 0,
        signal: null,
        byLaunchd: false,
        ranMs: 20,
      },
    ];
    expect(launchdSource(molt, { ...context, exits: ran }, window).status).toBe("missed");
    // The last good read of the unified log ended 50 minutes ago: ten minutes after that run, nothing was due.
    const stale = launchdSource(
      molt,
      { ...context, exits: ran, seen: { from: NOW - 20 * H, to: NOW - 50 * M } },
      window,
    );
    expect(stale).toMatchObject({ status: "ok", needsYou: false });
  });

  test("a list's non-zero exit stands in when print failed; its 0 is not taken as a pass", () => {
    const stamped = job({ printed: null, lastExit: 1, plist: { StartInterval: 900 } });
    // Its own log stamped a run five minutes ago; launchd's list said 1.
    const logText = `[${new Date(NOW - 5 * M).toISOString().replace(/\.\d{3}Z$/, "Z")}] tick`;
    expect(launchdSource({ ...stamped, logText }, context, window)).toMatchObject({ status: "failed", needsYou: true });
    expect(launchdSource({ ...stamped, logText, lastExit: null }, context, window).status).toBe("unknown");
  });

  test("a fleet scope's tick job shown as a launchd job (the Fleet view unreadable) needs you like any job", () => {
    const tick = job({
      label: "com.broomva.fleet-reconcile.broomva",
      plist: { StartInterval: 3600 },
      logText: null,
      logWrittenAt: null,
    });
    const exits = [
      { label: tick.label, pid: 1, endedAt: NOW - 5 * M, exit: 1, signal: null, byLaunchd: false, ranMs: 10_000 },
    ];
    expect(launchdSource(tick, { ...context, exits }, window)).toMatchObject({ status: "failed", needsYou: true });
  });

  test("what the unified log saw, from a read: its reach to where its last good read ended, never past now", () => {
    expect(seenOf({ coverage: NOW - 20 * H, exitsUntil: NOW - M }, NOW)).toEqual({ from: NOW - 20 * H, to: NOW - M });
    expect(seenOf({ coverage: NOW - 20 * H, exitsUntil: NOW + M }, NOW)).toEqual({ from: NOW - 20 * H, to: NOW });
    expect(seenOf({ coverage: null, exitsUntil: NOW }, NOW)).toBeNull();
    expect(seenOf({ coverage: NOW - H, exitsUntil: null }, NOW)).toBeNull();
  });

  test("cadence in words when it has no schedule", () => {
    expect(launchdSource(job({ plist: { KeepAlive: true } }), context, window).cadence).toBe("kept running");
    expect(launchdSource(job({ plist: { RunAtLoad: true } }), context, window).cadence).toBe("once, when loaded");
    expect(launchdSource(job({ plist: {} }), context, window).cadence).toBe("on demand");
  });
});

describe("the window", () => {
  test("a run shows while any of it falls inside: begun before now, ended (or still going) after the window began", () => {
    const runs = [
      { at: iso(NOW - 25 * H), endedAt: iso(NOW - 23 * H), status: "ok" as const, exit: 0, detail: null },
      { at: iso(NOW - 26 * H), endedAt: iso(NOW - 25 * H), status: "ok" as const, exit: 0, detail: null },
      { at: iso(NOW - 26 * H), endedAt: null, status: "running" as const, exit: null, detail: null },
    ];
    // Newest first by when each began.
    expect(inWindow(runs, window).map((run) => [run.status, run.at])).toEqual([
      ["ok", iso(NOW - 25 * H)],
      ["running", iso(NOW - 26 * H)],
    ]);
  });

  test("a log's end is its last whole lines", () => {
    const long = `${"x".repeat(3000)}\nlast line`;
    expect(tailOf(long)).toBe("last line");
    expect(tailOf("short\n\n")).toBe("short");
    expect(tailOf("")).toBeNull();
  });
});
