import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FleetView } from "../shared/fleet";
import type { LaunchdJob, LaunchdRead } from "./launchd";
import { LAUNCHD_NOTICE_MS, LAUNCHD_VIEW_MS, NOTICE_WAIT_MS, Timeline, VIEW_MS } from "./timeline";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const M = 60_000;
const H = 60 * M;
const NOW = Date.parse("2026-10-02T21:20:00Z");
const iso = (at: number) => new Date(at).toISOString();

function job(label: string, extra: Partial<LaunchdJob> = {}): LaunchdJob {
  return {
    label,
    loaded: true,
    printed: {
      path: null,
      state: "not running",
      pid: null,
      lastExit: 0,
      stdout: null,
      intervalSeconds: null,
    },
    plist: { StartInterval: 900 },
    installedAt: NOW - 30 * 24 * H,
    runningSince: null,
    running: false,
    logPath: null,
    logText: null,
    logWrittenAt: null,
    ...extra,
  };
}

const fleetView = (detailFor: string | undefined): FleetView => ({
  scopes: [
    {
      id: "broomva",
      mode: "report",
      dryRun: true,
      health: {
        status: "ok",
        reason: "Ticks every hour.",
        notice: "Ticks every hour.",
        since: iso(NOW - 30 * M),
        item: null,
        needsYou: false,
      },
      lastTick: { tick: 35, at: iso(NOW - 30 * M), status: "ok" },
      unreviewed: 0,
      openAsks: 0,
    },
    {
      id: "sri",
      mode: "report",
      dryRun: true,
      health: {
        status: "unscheduled",
        reason: "Not scheduled.",
        notice: "Not scheduled.",
        since: null,
        item: null,
        needsYou: false,
      },
      lastTick: null,
      unreviewed: 0,
      openAsks: 0,
    },
  ],
  detail: {
    id: detailFor ?? "broomva",
    stateDir: `/state/${detailFor ?? "broomva"}`,
    schedule: { scheduled: (detailFor ?? "broomva") === "broomva", intervalMinutes: 60 },
    ticks: [],
    report: null,
    proposals: [],
    asks: [],
    alerts: [],
    warnings: [],
  },
  error: null,
});

async function setup(options: { launchdMs?: number } = {}) {
  let slowMs = options.launchdMs ?? 0;
  let fails = false;
  const root = await mkdtemp(join(tmpdir(), "maestro-timeline-"));
  roots.push(root);
  const schedules = join(root, "schedules");
  await mkdir(schedules, { recursive: true });
  let now = NOW;
  let launchdReads = 0;
  let exits: LaunchdRead["exits"] = [
    {
      label: "com.broomva.moltbook-loop",
      pid: 1,
      endedAt: NOW - 10 * M,
      exit: 0,
      signal: null,
      byLaunchd: false,
      ranMs: 20,
    },
  ];
  const launchd = {
    read: async (): Promise<LaunchdRead> => {
      launchdReads += 1;
      const readAt = now;
      if (slowMs) await new Promise((resolve) => setTimeout(resolve, slowMs));
      if (fails) throw new Error("launchctl is unhappy");
      return {
        readAt,
        jobs: [
          job("com.broomva.moltbook-loop"),
          job("com.broomva.fleet-reconcile.broomva", { plist: { StartInterval: 3600 } }),
        ],
        exits,
        coverage: NOW - 20 * H,
        exitsUntil: readAt,
        awakeSince: null,
        warnings: [],
      };
    },
  };
  const fleetCalls: (string | undefined)[] = [];
  const timeline = new Timeline({
    launchd,
    schedulesDir: schedules,
    loop: async () => ({ minutes: 15, nextAt: iso(now + 5 * M), ticking: false }),
    wakes: async () => [],
    wakeLogPath: "/wake-log.jsonl",
    fleet: {
      get: async (scope) => {
        fleetCalls.push(scope);
        return fleetView(scope);
      },
    },
    now: () => now,
    log: () => undefined,
  });
  return {
    timeline,
    schedules,
    fleetCalls,
    reads: () => launchdReads,
    setNow: (at: number) => (now = at),
    setSlow: (ms: number) => (slowMs = ms),
    failReads: () => (fails = true),
    setExits: (next: LaunchdRead["exits"]) => (exits = next),
  };
}

const paseoSchedule = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id,
    name: `Schedule ${id}`,
    prompt: "Do the thing.",
    cadence: { type: "cron", expression: "0 9 * * *", timezone: "America/Bogota" },
    target: { type: "new-agent", config: { provider: "claude", cwd: "/repo" } },
    status: "active",
    createdAt: iso(NOW - 48 * H),
    updatedAt: iso(NOW - 48 * H),
    nextRunAt: "2026-10-03T14:00:00.000Z",
    lastRunAt: null,
    pausedAt: null,
    expiresAt: null,
    maxRuns: null,
    runs: [],
    ...extra,
  });

describe("the timeline", () => {
  test("every source on one axis: fleet scopes, launchd jobs, Paseo schedules and the loop; a scope's tick job once, as the scope", async () => {
    const { timeline, schedules, fleetCalls } = await setup();
    await writeFile(join(schedules, "aa.json"), paseoSchedule("aa"));
    const view = await timeline.get();
    expect(view.sources.map((source) => [source.kind, source.name])).toEqual([
      ["fleet", "fleet-reconcile broomva"],
      ["fleet", "fleet-reconcile sri"],
      ["launchd", "moltbook-loop"],
      ["schedule", "Schedule aa"],
      ["loop", "Maestro's loop"],
    ]);
    expect(view).toMatchObject({ now: iso(NOW), from: iso(NOW - 24 * H), to: iso(NOW + 24 * H), warnings: [] });
    // One read for the first scope and its summaries, one for the other scope's ticks.
    expect(fleetCalls).toEqual([undefined, "sri"]);
  });

  test("a schedule file that does not read is said, and the rest are still shown", async () => {
    const { timeline, schedules } = await setup();
    await writeFile(join(schedules, "aa.json"), paseoSchedule("aa"));
    await writeFile(join(schedules, "bb.json"), "{ torn");
    await writeFile(join(schedules, "cc.json"), JSON.stringify({ id: "cc", cadence: { type: "lunar" } }));
    const view = await timeline.get();
    expect(view.sources.filter((source) => source.kind === "schedule")).toHaveLength(1);
    expect(view.warnings).toEqual([
      expect.stringContaining("Paseo schedule bb.json could not be read"),
      "Paseo schedule cc.json is in a shape the timeline does not read.",
    ]);
  });

  test("launchd is read again only once its read is a minute old for the view, five for the header count", async () => {
    const { timeline, reads, setNow } = await setup();
    await timeline.get();
    expect(reads()).toBe(1);
    setNow(NOW + VIEW_MS + 1);
    await timeline.get();
    expect(reads()).toBe(1);
    setNow(NOW + LAUNCHD_VIEW_MS + 1);
    await timeline.get();
    expect(reads()).toBe(2);
    const last = NOW + LAUNCHD_VIEW_MS + 1;
    setNow(last + LAUNCHD_VIEW_MS + 1);
    await timeline.notices();
    expect(reads()).toBe(2);
    setNow(last + LAUNCHD_NOTICE_MS + 1);
    await timeline.notices();
    expect(reads()).toBe(3);
  });

  test("notices: the failed and missed, never a fleet scope; a read too slow is answered with the last one", async () => {
    const { timeline, schedules, setExits } = await setup();
    await writeFile(
      join(schedules, "aa.json"),
      paseoSchedule("aa", {
        runs: [
          {
            id: "r1",
            scheduledFor: iso(NOW - 2 * H),
            startedAt: iso(NOW - 2 * H),
            endedAt: iso(NOW - 2 * H + M),
            status: "failed",
            agentId: null,
            error: "boom",
          },
        ],
      }),
    );
    setExits([
      {
        label: "com.broomva.moltbook-loop",
        pid: 2,
        endedAt: NOW - 5 * M,
        exit: 1,
        signal: null,
        byLaunchd: false,
        ranMs: 20,
      },
    ]);
    expect((await timeline.notices()).map((notice) => [notice.id, notice.status, notice.reason])).toEqual([
      ["launchd:com.broomva.moltbook-loop", "failed", "Its last run failed: exit 1."],
      ["schedule:aa", "failed", "Its last run failed: boom."],
    ]);
  });

  test("the header count never waits on a slow launchd longer than its wait; it answers with the last read", async () => {
    const { timeline, setExits, setNow, setSlow } = await setup();
    setExits([
      {
        label: "com.broomva.moltbook-loop",
        pid: 2,
        endedAt: NOW - 5 * M,
        exit: 1,
        signal: null,
        byLaunchd: false,
        ranMs: 20,
      },
    ]);
    expect((await timeline.notices()).map((notice) => notice.id)).toEqual(["launchd:com.broomva.moltbook-loop"]);
    // Five minutes on, launchd is due again and now too slow: the last read's notices answer, on time.
    setNow(NOW + LAUNCHD_NOTICE_MS + 1);
    setSlow(NOTICE_WAIT_MS + 1500);
    const started = Date.now();
    expect((await timeline.notices()).map((notice) => notice.id)).toEqual(["launchd:com.broomva.moltbook-loop"]);
    expect(Date.now() - started).toBeLessThan(NOTICE_WAIT_MS + 1000);
  }, 10_000);

  test("with no read yet and a slow launchd, the header count says nothing rather than wait", async () => {
    const { timeline } = await setup({ launchdMs: NOTICE_WAIT_MS + 1500 });
    const started = Date.now();
    expect(await timeline.notices()).toEqual([]);
    expect(Date.now() - started).toBeLessThan(NOTICE_WAIT_MS + 1000);
  }, 10_000);

  test("a read that fails after a good one is said, and pages no one for the hour it has not seen", async () => {
    const { timeline, setNow, failReads } = await setup();
    expect(await timeline.notices()).toEqual([]);
    failReads();
    setNow(NOW + H);
    // moltbook last ran ten minutes before the good read; an hour on, on no new evidence, it is not missed.
    expect(await timeline.notices()).toEqual([]);
    const view = await timeline.get();
    expect(view.sources.find((source) => source.id === "launchd:com.broomva.moltbook-loop")?.status).toBe("ok");
    expect(view.warnings).toEqual([
      "launchd could not be read: launchctl is unhappy",
      "launchd has not been read for a while; its rows show the last read, and nothing since is called missed.",
    ]);
  });

  test("a view never takes a header-count read: launchd a minute old for the view though a slower read is in flight", async () => {
    const { timeline, reads, setNow, setSlow } = await setup();
    await timeline.get();
    expect(reads()).toBe(1);
    setNow(NOW + 2 * M);
    setSlow(200);
    // The header count accepts a read two minutes old and computes on it; the view does not, and reads again.
    const [notices, view] = await Promise.all([timeline.notices(), timeline.get()]);
    expect(notices).toEqual([]);
    expect(reads()).toBe(2);
    expect(view.now).toBe(iso(NOW + 2 * M));
  });

  test("a launchd job's log end, only when asked for", async () => {
    const { timeline } = await setup();
    await timeline.get();
    expect(await timeline.logOf("launchd:com.broomva.moltbook-loop")).toEqual({ path: null, tail: null });
    expect(await timeline.logOf("schedule:nope")).toEqual({ path: null, tail: null });
  });

  test("a launchd that will not read costs its rows, not the view", async () => {
    const root = await mkdtemp(join(tmpdir(), "maestro-timeline-"));
    roots.push(root);
    const timeline = new Timeline({
      launchd: { read: () => Promise.reject(new Error("no launchctl here")) },
      schedulesDir: join(root, "missing"),
      loop: async () => ({ minutes: null, nextAt: null, ticking: false }),
      wakes: async () => [],
      fleet: null,
      now: () => NOW,
      log: () => undefined,
    });
    const view = await timeline.get();
    expect(view.sources.map((source) => source.id)).toEqual(["loop"]);
    expect(view.warnings).toEqual(["launchd could not be read: no launchctl here"]);
  });
});
