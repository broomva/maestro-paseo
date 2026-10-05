import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkItem } from "../shared/contracts";
import { groupOf, type OrchState } from "../shared/states";
import { acquireLock, releaseLock } from "./control-asks";
import { askBatch, H, report, session, writeFleet } from "./fake-fleet";
import { AwakeClock, DISABLED_NOTICE, Fleet, REVIEWS_FILE, uptimeRaw, wallClock } from "./fleet";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const NOW = Date.parse("2026-10-02T20:40:00Z");
const ago = (hours: number) => new Date(NOW - hours * H);

function work(id: string, title: string, state: OrchState): WorkItem {
  return {
    id,
    path: `/work/${id}`,
    title,
    kind: "task",
    state,
    group: groupOf(state),
    gate: "human",
    owner: null,
    initiative: "fleet-reconcile-alpha",
    project: null,
    repo: null,
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-01T10:00:00Z",
    lastEventAt: null,
    phase: null,
    worker: null,
    reason: null,
    verdict: null,
    look: null,
    permission: null,
    checks: [],
    pending: null,
    flag: null,
  };
}

/**
 * A Fleet on a test's own files, with the wall clock held by the test. Its
 * awake time is wall time, unless the test asks for the plugin's AwakeClock
 * (`beating`, its first record that many ms before NOW). The kernel's awake
 * count is then the test's too: `awakeFor` moves both clocks and takes a
 * record each minute, as the timer does; `sleepFor` moves only the wall
 * clock; `darkWake` moves the wall clock and credits only the CPU's seconds.
 */
async function setup(items: WorkItem[] = [], options: { beating?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "maestro-fleet-"));
  roots.push(root);
  const paths = { config: join(root, "fleet.json"), state: join(root, "state"), agents: join(root, "agents") };
  let now = options.beating === undefined ? NOW : NOW - options.beating;
  let uptime = 1_000_000_000;
  const beating =
    options.beating === undefined
      ? null
      : new AwakeClock(
          () => now,
          async () => uptime,
        );
  const logs: string[] = [];
  const fleet = new Fleet({
    configPath: paths.config,
    stateRoot: paths.state,
    agentsDir: paths.agents,
    items: async () => items,
    clock: beating ?? wallClock(() => now),
    now: () => now,
    log: (message) => logs.push(message),
    // Never the real lock directory or receipts: a test writes only under its own root.
    askLocks: join(root, "locks"),
    askReceipts: join(root, "receipts.jsonl"),
  });
  const awakeFor = async (ms: number) => {
    for (let step = 0; step < ms; step += 60_000) {
      const by = Math.min(60_000, ms - step);
      now += by;
      uptime += by;
      await beating?.beat();
    }
  };
  const sleepFor = (ms: number) => {
    now += ms;
  };
  /** A night of DarkWakes: every `everyMs` the CPU wakes for `cpuMs` and the timer takes a record. */
  const darkWake = async (ms: number, everyMs: number, cpuMs: number) => {
    for (let step = 0; step < ms; step += everyMs) {
      now += everyMs;
      uptime += cpuMs;
      await beating?.beat();
    }
  };
  if (beating) {
    await beating.beat();
    await awakeFor(NOW - now);
  }
  return { root, paths, fleet, logs, items, awakeFor, sleepFor, darkWake };
}

describe("reading the fleet", () => {
  test("each scope's ticks, report, proposals and asks, the asks linked to the work the fleet raised", async () => {
    const batch = askBatch("alpha", 34, [{ id: "a1", key: "records-without-process" }], "w-ask");
    const { paths, fleet } = await setup([
      work("w-ask", "1 ask (tick 34) [fleet-reconcile alpha batch 34-3]", "review"),
      work("w-alert", "fleet alpha: lock [fleet-reconcile alpha alert lock]", "running"),
      work("w-mine", "Persist transcripts", "review"),
    ]);
    await writeFleet(paths, {
      alpha: {
        ticks: [
          { tick: 34, at: ago(1.5), exit: 0 },
          { tick: 35, at: ago(0.5), exit: 0, markdown: "# tick 35\n\n| a | b |\n|---|---|\n| 1 | 2 |\n" },
        ],
        ledger: batch.lines,
      },
      beta: { ticks: [{ tick: 6, at: ago(40), exit: 0 }], scheduled: false },
    });
    const view = await fleet.get();
    expect(view.error).toBeNull();
    expect(
      view.scopes.map((scope) => [
        scope.id,
        scope.health.status,
        scope.lastTick?.tick,
        scope.unreviewed,
        scope.openAsks,
      ]),
    ).toEqual([
      ["alpha", "ok", 35, 2, 1],
      ["beta", "unscheduled", 6, 2, 1],
    ]);
    const detail = view.detail;
    expect(detail?.id).toBe("alpha");
    expect(detail?.schedule).toEqual({ scheduled: true, intervalMinutes: 60 });
    expect(detail?.ticks.map((tick) => [tick.tick, tick.status, tick.proposals])).toEqual([
      [35, "ok", 2],
      [34, "ok", 2],
    ]);
    expect(detail?.report).toEqual({
      tick: 35,
      markdown: "# tick 35\n\n| a | b |\n|---|---|\n| 1 | 2 |\n",
      truncated: false,
    });
    expect(detail?.proposals.map((proposal) => [proposal.session?.short, proposal.action, proposal.review])).toEqual([
      ["22222222", "report", null],
      ["33333333", "report only", null],
    ]);
    expect(detail?.asks.map((ask) => [ask.key, ask.batch, ask.item?.id, ask.item?.needsYou])).toEqual([
      ["records-without-process", "34-3", "w-ask", true],
    ]);
    // Alerts the fleet raised that are still open, whatever their state; never your own work.
    expect(detail?.alerts.map((item) => item.id)).toEqual(["w-alert"]);
    expect(detail?.warnings).toEqual([]);
    expect((await fleet.get("beta")).detail?.id).toBe("beta");
  });

  test("a missed tick is in Needs you, unless the fleet's own alert for it already is", async () => {
    const { paths, fleet, items } = await setup();
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(3), exit: 0 }] } });
    const [scope] = (await fleet.get()).scopes;
    expect(scope?.health).toMatchObject({ status: "missed", needsYou: true, item: null });
    expect(await fleet.notices(items)).toEqual([
      {
        scope: "alpha",
        status: "missed",
        reason: "No tick since tick 35. It runs every hour.",
        since: ago(3).toISOString(),
      },
    ]);
    // The fleet raised its lock alert, and it is at your gate: counted there, once.
    const alert = work("w-lock", "fleet alpha: lock [fleet-reconcile alpha alert lock]", "review");
    expect(await fleet.notices([alert])).toEqual([]);
    items.push(alert);
    expect((await fleet.get()).scopes[0]?.health).toMatchObject({
      status: "missed",
      needsYou: false,
      item: { id: "w-lock" },
    });
    // Still queued (Maestro's run cap): not in Needs you yet, so the notice stands, and links to it.
    const queued = work("w-lock", "fleet alpha: lock [fleet-reconcile alpha alert lock]", "proposed");
    expect((await fleet.notices([queued])).length).toBe(1);
  });

  test("a failing tick is in Needs you with its step; the fleet's tick-<step> alert at the gate covers it", async () => {
    const { paths, fleet } = await setup();
    await writeFleet(paths, {
      alpha: { ticks: [{ tick: 35, at: ago(0.5), exit: 1, detail: "recover=0 observe=1 compare=0 ask=0" }] },
    });
    expect(await fleet.notices([])).toMatchObject([
      { scope: "alpha", status: "failing", reason: "Tick 35 failed at observe." },
    ]);
    const alert = work("w-obs", "fleet alpha: tick-observe [fleet-reconcile alpha alert tick-observe]", "review");
    expect(await fleet.notices([alert])).toEqual([]);
    const other = work("w-rep", "fleet alpha: tick-report [fleet-reconcile alpha alert tick-report]", "review");
    expect((await fleet.notices([other])).length).toBe(1);
  });

  test("only time the Mac was awake counts toward a missed tick, as launchd counts its interval", async () => {
    const { paths, fleet, awakeFor, sleepFor } = await setup([], { beating: 10 * 60_000 });
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: new Date(NOW), exit: 0 }] } });
    // Short naps between meetings: 6 h of wall time, 1.5 h of it awake. launchd has not owed two ticks.
    for (let hour = 0; hour < 6; hour += 1) {
      await awakeFor(15 * 60_000);
      sleepFor(45 * 60_000);
      expect(await fleet.notices([])).toEqual([]);
    }
    // Awake 29 more minutes: 1h 59m awake, not missed. Two more: 2h 1m awake, missed, however the sleeps fell.
    await awakeFor(29 * 60_000);
    expect(await fleet.notices([])).toEqual([]);
    await awakeFor(2 * 60_000);
    expect(await fleet.notices([])).toMatchObject([
      { status: "missed", reason: "No tick since tick 35. It runs every hour." },
    ]);
    expect((await fleet.get()).scopes[0]?.health.reason).toBe(
      "No tick for 6h 31m (2h 1m of it awake): the last was tick 35. It runs every hour.",
    );
  });

  test("a night of DarkWakes is not awake time: no false alarm in the morning", async () => {
    const { paths, fleet, darkWake, awakeFor } = await setup([], { beating: 10 * 60_000 });
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: new Date(NOW), exit: 0 }] } });
    // 8 h asleep, the CPU up 5 s every 100 s (Power Nap): the timer fires at each wake, the kernel counts 24 min.
    await darkWake(8 * H, 100_000, 5_000);
    expect(await fleet.notices([])).toEqual([]);
    await awakeFor(60 * 60_000);
    expect(await fleet.notices([])).toEqual([]);
  });

  test("a reload or a cold boot never raises a false alarm: time before the plugin started is not counted", async () => {
    const { paths, fleet, awakeFor } = await setup([], { beating: 0 });
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(8), exit: 0 }] } });
    expect(await fleet.notices([])).toEqual([]);
    await awakeFor(1.9 * H);
    expect(await fleet.notices([])).toEqual([]);
    await awakeFor(0.2 * H);
    expect((await fleet.notices([]))[0]?.status).toBe("missed");
    // What it cannot know, it does not claim: the awake share is a lower bound, and says so.
    expect((await fleet.get()).scopes[0]?.health.reason).toContain("(at least 2h 6m of it awake)");
  });

  test("a tick that died stays dead after a wake; one the Mac slept through mid-run is still running", async () => {
    const { paths, fleet, awakeFor, sleepFor } = await setup([], { beating: 10 * 60_000 });
    await writeFleet(paths, {
      alpha: { ticks: [{ tick: 36, at: new Date(NOW - 5 * 60_000) }] },
      beta: { ticks: [{ tick: 9, at: ago(72) }] },
    });
    await fleet.get();
    sleepFor(4 * H);
    await awakeFor(5 * 60_000);
    const view = await fleet.get();
    expect(view.scopes.map((scope) => [scope.id, scope.lastTick?.status])).toEqual([
      ["alpha", "running"],
      ["beta", "died"],
    ]);
  });

  test("the kill switch and an unscheduled scope never need you, even when its last tick by hand failed", async () => {
    const { paths, fleet } = await setup();
    await writeFleet(paths, {
      alpha: { ticks: [{ tick: 35, at: ago(30), exit: 1 }] },
      beta: { ticks: [{ tick: 6, at: ago(30), exit: 0 }], scheduled: false },
      gamma: { ticks: [{ tick: 3, at: ago(30), exit: 1, detail: "observe=1" }], scheduled: false },
    });
    await writeFile(join(paths.state, "alpha", DISABLED_NOTICE), "");
    expect(await fleet.notices([])).toEqual([]);
    expect((await fleet.get()).scopes.map((scope) => [scope.health.status, scope.health.needsYou])).toEqual([
      ["off", false],
      ["unscheduled", false],
      ["failing", false],
    ]);
  });

  test("an alert of the fleet's you answered after the failure began keeps it out of Needs you", async () => {
    const { paths, fleet } = await setup();
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(0.5), exit: 1, detail: "observe=1" }] } });
    const alert = work("w", "fleet alpha: tick-observe [fleet-reconcile alpha alert tick-observe]", "done");
    expect(await fleet.notices([{ ...alert, updatedAt: ago(0.25).toISOString() }])).toEqual([]);
    expect((await fleet.notices([{ ...alert, updatedAt: ago(2).toISOString() }])).length).toBe(1);
  });

  test("no config: the state dirs that hold a ledger or ticks are the scopes; a broken config says so", async () => {
    const { paths, fleet } = await setup();
    await writeFleet(paths, { alpha: { ticks: [{ tick: 1, at: ago(0.2), exit: 0 }] } });
    await mkdir(join(paths.state, "maestro-asks", ".git"), { recursive: true });
    await rm(paths.config);
    expect((await fleet.get()).scopes.map((scope) => scope.id)).toEqual(["alpha"]);
    await writeFile(paths.config, "{ not json");
    const view = await fleet.get();
    expect(view.error).toContain("is not valid JSON");
    expect(view.scopes.map((scope) => scope.id)).toEqual(["alpha"]);
  });

  test("a config caught mid-edit keeps the scopes it last named, state dirs included, and says why", async () => {
    const { root, paths, fleet } = await setup();
    // The scope's state dir is somewhere of its own, which discovery under the state root would not find.
    const elsewhere = join(root, "elsewhere");
    await writeFleet({ ...paths, state: elsewhere }, { alpha: { ticks: [{ tick: 1, at: ago(0.2), exit: 0 }] } });
    expect((await fleet.get()).detail?.stateDir).toBe(join(elsewhere, "alpha"));
    await writeFile(paths.config, '{"scopes": {"alpha": {');
    const view = await fleet.get();
    expect(view.error).toContain("is not valid JSON");
    expect(view.detail?.stateDir).toBe(join(elsewhere, "alpha"));
  });

  test("a relative state dir is left out; a tick budget that is not a whole number of minutes is tick.sh's 15", async () => {
    const { paths, fleet } = await setup();
    await writeFleet(paths, {
      alpha: { ticks: [{ tick: 1, at: ago(0.25) }], config: { tick_timeout_min: 0 } },
      beta: { ticks: [], config: { state_dir: "relative/beta" } },
    });
    const view = await fleet.get();
    expect(view.scopes.map((scope) => scope.id)).toEqual(["alpha"]);
    expect(view.error).toBe("Left out of the Fleet view: beta (state_dir relative/beta is relative).");
    // 15 minutes into a 15 + 5 minute budget: still running, not died.
    expect(view.detail?.ticks[0]?.status).toBe("running");
  });

  test("a config that is gone is no error: the state dirs on disk are what there is, not the last config", async () => {
    const { root, paths, fleet } = await setup();
    const elsewhere = join(root, "elsewhere");
    await writeFleet({ ...paths, state: elsewhere }, { alpha: { ticks: [{ tick: 1, at: ago(0.2), exit: 0 }] } });
    expect((await fleet.get()).scopes.map((scope) => scope.id)).toEqual(["alpha"]);
    await rm(paths.config);
    const view = await fleet.get();
    expect(view.error).toBeNull();
    expect(view.scopes).toEqual([]);
  });

  test("the config and the LaunchAgent are yours and are read as linked: a dotfiles repo still schedules", async () => {
    const { root, paths, fleet } = await setup();
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(0.5), exit: 0 }] } });
    const dotfiles = join(root, "dotfiles");
    await mkdir(dotfiles);
    for (const [from, name] of [
      [paths.config, "fleet.json"],
      [join(paths.agents, "com.broomva.fleet-reconcile.alpha.plist"), "agent.plist"],
    ] as const) {
      await writeFile(join(dotfiles, name), await readFile(from));
      await rm(from);
      await symlink(join(dotfiles, name), from);
    }
    const view = await fleet.get();
    expect(view.error).toBeNull();
    expect(view.detail?.schedule).toEqual({ scheduled: true, intervalMinutes: 60 });
    expect(view.scopes[0]?.health.status).toBe("ok");
  });

  test("a LaunchAgent that cannot be read is said, and still counts as scheduled: a failed read never silences", async () => {
    const { paths, fleet } = await setup();
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(3), exit: 0 }] } });
    const plist = join(paths.agents, "com.broomva.fleet-reconcile.alpha.plist");
    await rm(plist);
    await mkdir(plist);
    const view = await fleet.get();
    expect(view.detail?.warnings.join(" ")).toContain("could not be read");
    expect(view.scopes[0]?.health.status).toBe("missed");
  });

  test("a config that is a FIFO is refused at once, never waited on", async () => {
    const { root, paths, fleet } = await setup();
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(0.5), exit: 0 }] } });
    const fifo = join(root, "fifo.json");
    execFileSync("mkfifo", [fifo]);
    await rm(paths.config);
    await symlink(fifo, paths.config);
    const view = await fleet.get();
    expect(view.error).toContain("could not be read");
  });

  test("a config gone and then back broken does not bring back the scopes it named before it went", async () => {
    const { root, paths, fleet } = await setup();
    const elsewhere = join(root, "elsewhere");
    await writeFleet({ ...paths, state: elsewhere }, { alpha: { ticks: [{ tick: 1, at: ago(0.2), exit: 0 }] } });
    expect((await fleet.get()).scopes.map((scope) => scope.id)).toEqual(["alpha"]);
    await rm(paths.config);
    await fleet.get();
    await writeFile(paths.config, "{ broken");
    const view = await fleet.get();
    expect(view.error).toContain("is not valid JSON");
    expect(view.scopes).toEqual([]);
  });

  test("a clock that cannot read the kernel never raises a false missed, and after 5 minutes says so in Needs you", async () => {
    const { root } = await setup();
    const paths = { config: join(root, "f3.json"), state: join(root, "s3"), agents: join(root, "a3") };
    await writeFleet(paths, {
      alpha: {
        ticks: [
          { tick: 35, at: ago(3), exit: 0 },
          { tick: 36, at: ago(2) },
        ],
      },
      beta: { ticks: [{ tick: 6, at: ago(40), exit: 0 }], scheduled: false },
    });
    let now = NOW;
    const logs: string[] = [];
    const clock = new AwakeClock(
      () => now,
      async () => null,
      (message) => logs.push(message),
    );
    const fleet = new Fleet({
      configPath: paths.config,
      stateRoot: paths.state,
      agentsDir: paths.agents,
      items: async () => [],
      clock,
      now: () => now,
    });
    // Blind from the start: tick 36 (2 h old, no exit) is not called dead on a guess, and nothing is missed.
    expect(await fleet.notices([])).toEqual([]);
    expect((await fleet.get()).scopes[0]?.lastTick?.status).toBe("unknown");
    expect(logs).toEqual(["fleet: the Mac's awake time (CLOCK_UPTIME_RAW) could not be read; missed ticks wait"]);
    now += 5 * 60_000;
    // Five minutes blind: the alarm itself is down, and that needs you, for each scheduled scope.
    expect(await fleet.notices([])).toEqual([
      {
        scope: "alpha",
        status: "blind",
        reason: expect.stringContaining("Missed ticks cannot be judged"),
        since: null,
      },
    ]);
  });

  test("an awake clock that cannot read the kernel is said in the view", async () => {
    const { root } = await setup();
    const paths = { config: join(root, "f2.json"), state: join(root, "s2"), agents: join(root, "a2") };
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(0.5), exit: 0 }] } });
    const fleet = new Fleet({
      configPath: paths.config,
      stateRoot: paths.state,
      agentsDir: paths.agents,
      items: async () => [],
      clock: new AwakeClock(
        () => NOW,
        async () => null,
      ),
      now: () => NOW,
    });
    // A torn ledger line is a warning too: the clock's comes first, since the view shows only the first few.
    const ledger = join(paths.state, "alpha", "ledger.jsonl");
    await writeFile(ledger, `${await readFile(ledger, "utf8")}{"kind":"tick_f`);
    const warnings = (await fleet.get()).detail?.warnings ?? [];
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("awake time could not be read");
  });

  test("a ledger that cannot be read is said, not taken for no ledger", async () => {
    const { paths, fleet } = await setup();
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(0.5), exit: 0 }] } });
    const ledger = join(paths.state, "alpha", "ledger.jsonl");
    await rm(ledger);
    await mkdir(ledger);
    expect((await fleet.get()).detail?.warnings.join(" ")).toContain("The ledger could not be read");
  });

  test("a tick folder with no ledger record (a report run by hand) does not stand for the newest tick", async () => {
    const { paths, fleet } = await setup();
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(0.5), exit: 0 }] } });
    await mkdir(join(paths.state, "alpha", "ticks", "00999"), { recursive: true });
    const [scope] = (await fleet.get()).scopes;
    expect(scope?.lastTick?.tick).toBe(35);
    expect(scope?.health.status).toBe("ok");
  });

  test("dry run is what the newest tick did, over what the config asks", async () => {
    const { paths, fleet } = await setup();
    // The config asks for live; the fleet refused it without live_accepted, and the tick ran dry.
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(0.5), exit: 0 }], config: { dry_run: 0 } } });
    expect((await fleet.get()).scopes[0]?.dryRun).toBe(true);
  });

  test("a report.md that is a symlink or a FIFO is not read; one past the limit is cut and says so", async () => {
    const { root, paths, fleet } = await setup();
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(0.2), exit: 0 }] } });
    const md = join(paths.state, "alpha", "ticks", "00035", "report.md");
    const secret = join(root, "secret.txt");
    await writeFile(secret, "not for the phone");
    await rm(md);
    await symlink(secret, md);
    let detail = (await fleet.get()).detail;
    expect(detail?.report).toBeNull();
    expect(detail?.warnings.join(" ")).toContain("report.md could not be read");
    await rm(md);
    execFileSync("mkfifo", [md]);
    // A FIFO is refused at once, not waited on.
    detail = (await fleet.get()).detail;
    expect(detail?.report).toBeNull();
    await rm(md);
    await writeFile(md, `# big\n${"x".repeat(200 * 1024)}`);
    detail = (await fleet.get()).detail;
    expect(detail?.report?.truncated).toBe(true);
    expect(detail?.report?.markdown.length).toBe(128 * 1024);
  });

  test("a torn report or ledger line is a warning, not a failure", async () => {
    const { paths, fleet } = await setup();
    await writeFleet(paths, {
      alpha: {
        ticks: [
          { tick: 34, at: ago(1.2), exit: 0 },
          { tick: 35, at: ago(0.2), exit: 0 },
        ],
      },
    });
    await writeFile(join(paths.state, "alpha", "ticks", "00035", "report.json"), '{"tick": 35, "ses');
    const ledger = join(paths.state, "alpha", "ledger.jsonl");
    await writeFile(ledger, `${await readFile(ledger, "utf8")}{"kind":"tick_f`);
    const detail = (await fleet.get()).detail;
    expect(detail?.warnings).toEqual([
      "The ledger has 1 line(s) that did not parse; they are left out.",
      expect.stringContaining("Tick 35's report.json could not be read"),
    ]);
    // Read again, it is said again, once: the torn file is not parsed twice, nor forgotten.
    expect((await fleet.get()).detail?.warnings.length).toBe(2);
    // The newest report that reads stands in: tick 34's.
    expect(detail?.proposals[0]?.tick).toBe(34);
    expect(detail?.ticks.map((tick) => tick.tick)).toEqual([35, 34]);
  });

  test("a scope's count to review is its groups, not its sessions: one class and action is one decision", async () => {
    const { paths, fleet } = await setup();
    const sessions = ["a", "b", "c"].map((id) => session(`${id}0000000-x`, "10", "report only"));
    await writeFleet(paths, {
      alpha: { ticks: [{ tick: 35, at: ago(0.2), exit: 0, report: report(35, ago(0.2), { sessions }) }] },
    });
    const view = await fleet.get();
    expect(view.detail?.proposals).toHaveLength(3);
    expect(view.scopes[0]?.unreviewed).toBe(1);
  });

  test("a coordinator's dry verbs are proposals beside the report's", async () => {
    const { paths, fleet } = await setup();
    await writeFleet(paths, {
      alpha: {
        ticks: [{ tick: 35, at: ago(0.2), exit: 0 }],
        ledger: [
          {
            kind: "intent",
            id: "35-5",
            verb: "resume",
            key: "session:abc",
            dry_run: true,
            tick: 35,
            target: { session_id: "abc" },
          },
          {
            kind: "done",
            of: "35-5",
            verb: "resume",
            key: "session:abc",
            dry_run: true,
            tick: 35,
            ts: ago(0.1).toISOString(),
          },
        ],
      },
    });
    const proposals = (await fleet.get()).detail?.proposals ?? [];
    expect(proposals.map((proposal) => [proposal.source, proposal.action])).toEqual([
      ["report", "report"],
      ["report", "report only"],
      ["act", "resume abc"],
    ]);
  });
});

describe("the awake clock", () => {
  const clocks = () => {
    let wall = 0;
    let uptime = 5_000_000;
    let reads = 0;
    let broken = false;
    const clock = new AwakeClock(
      () => wall,
      async () => {
        reads += 1;
        return broken ? null : uptime;
      },
    );
    const awake = async (ms: number) => {
      for (let step = 0; step < ms; step += 60_000) {
        wall += Math.min(60_000, ms - step);
        uptime += Math.min(60_000, ms - step);
        await clock.beat();
      }
    };
    return {
      clock,
      awake,
      asleep: (ms: number) => {
        wall += ms;
      },
      held: (ms: number) => {
        wall += ms;
        uptime += ms;
      },
      setBack: (ms: number) => {
        wall -= ms;
      },
      reads: () => reads,
      breakKernel: (value: boolean) => {
        broken = value;
      },
    };
  };

  test("counts the kernel's awake time: sleep never, a held event loop or a late timer all of it", async () => {
    const { clock, awake, asleep, held } = clocks();
    await clock.beat();
    await awake(10 * 60_000);
    asleep(3 * H);
    await awake(20 * 60_000);
    let since = await clock.read();
    expect(since(0)).toEqual({ ms: 30 * 60_000, whole: true });
    // From inside the sleep: what came after it, less the gap's one awake minute, which is put at the gap's
    // start so the count is never more than the Mac was awake (19 of the 20 minutes).
    expect(since(2 * H)).toEqual({ ms: 19 * 60_000, whole: true });
    // The event loop held for 5 minutes, no record taken in between: awake all the same.
    held(5 * 60_000);
    since = await clock.read();
    expect(since(0)).toEqual({ ms: 35 * 60_000, whole: true });
  });

  test("before its first record it counts from that record, a lower bound, and says so; at the record it is whole", async () => {
    const { clock, awake } = clocks();
    await clock.beat();
    await awake(30 * 60_000);
    const since = await clock.read();
    expect(since(-10 * H)).toEqual({ ms: 30 * 60_000, whole: false });
    expect(since(0)).toEqual({ ms: 30 * 60_000, whole: true });
  });

  test("a wall clock set back starts the records over, and the count goes on from there, never frozen", async () => {
    const { clock, awake, setBack } = clocks();
    await clock.beat();
    await awake(30 * 60_000);
    setBack(H);
    await awake(10 * 60_000);
    const since = await clock.read();
    // Wall times before the step no longer map: a lower bound from the first record after it, not a guess.
    expect(since(-2 * H)).toEqual({ ms: 9 * 60_000, whole: false });
    // After the step the count runs on (records at -29 min ... -20 min wall): five minutes since -25 min.
    expect(since(-25 * 60_000)).toEqual({ ms: 5 * 60_000, whole: true });
  });

  test("a kernel it cannot read takes no record and says so; the count does not grow on a guess", async () => {
    const { clock, awake, breakKernel } = clocks();
    await clock.beat();
    await awake(30 * 60_000);
    breakKernel(true);
    await awake(60 * 60_000);
    let since = await clock.read();
    expect(clock.error).toContain("could not be read");
    expect(since(0)).toEqual({ ms: 30 * 60_000, whole: true });
    breakKernel(false);
    since = await clock.read();
    expect(clock.error).toBeNull();
    expect(since(0)).toEqual({ ms: 90 * 60_000, whole: true });
  });

  test("keeps a record a minute at most, and none past eight days", async () => {
    const { clock, awake, asleep } = clocks();
    await clock.beat();
    asleep(9 * 24 * H);
    await awake(60_000);
    const since = await clock.read();
    // The first record is gone: from day 0 counts from the oldest kept, after the long sleep.
    expect(since(0)).toEqual({ ms: 0, whole: false });
  });

  test("its timer asks the kernel on each beat, from the start, until stopped", async () => {
    const { clock, reads, held } = clocks();
    let beat: (() => void) | null = null;
    let stopped = false;
    clock.start((run, ms) => {
      expect(ms).toBe(60_000);
      beat = run;
      return () => {
        stopped = true;
      };
    });
    // Started: one read of the kernel at once (awaited here, so the next beat is not sharing it).
    expect(reads()).toBe(1);
    await clock.beat();
    held(60_000);
    const before = reads();
    (beat as unknown as () => void)();
    // The timer's beat asks the kernel itself (synchronously, as the read starts).
    expect(reads() - before).toBe(1);
    clock.stop();
    expect(stopped).toBe(true);
  });

  test("reads never stack: one in flight is shared, and one under 5 s old is reused", async () => {
    let wall = 0;
    let calls = 0;
    let open = 0;
    let most = 0;
    let release: (() => void) | null = null;
    const clock = new AwakeClock(
      () => wall,
      () => {
        calls += 1;
        open += 1;
        most = Math.max(most, open);
        return new Promise<number>((resolve) => {
          release = () => {
            open -= 1;
            resolve(1_000_000 + wall);
          };
        });
      },
    );
    const first = clock.read();
    const second = clock.read();
    const third = clock.beat();
    expect(calls).toBe(1);
    (release as unknown as () => void)();
    await Promise.all([first, second, third]);
    expect(most).toBe(1);
    wall += 3_000;
    await clock.read();
    expect(calls).toBe(1);
    wall += 3_000;
    const fourth = clock.read();
    expect(calls).toBe(2);
    (release as unknown as () => void)();
    await fourth;
  });

  test("the Fleet's own clock takes records from the start, and stops with it", async () => {
    const beats: (() => void)[] = [];
    let stopped = 0;
    const fleet = new Fleet({
      items: async () => [],
      configPath: join(tmpdir(), "maestro-fleet-none.json"),
      stateRoot: join(tmpdir(), "maestro-fleet-none"),
      agentsDir: join(tmpdir(), "maestro-fleet-none-agents"),
      every: (beat) => {
        beats.push(beat);
        return () => {
          stopped += 1;
        };
      },
    });
    expect(beats).toHaveLength(1);
    fleet.stop();
    expect(stopped).toBe(1);
  });

  test("on macOS it reads CLOCK_UPTIME_RAW, in ms: the kernel's own wake counters predict it to the second", async () => {
    if (process.platform !== "darwin") {
      expect((await uptimeRaw()) === null || ((await uptimeRaw()) as number) > 0).toBe(true);
      return;
    }
    const sysctl = (name: string) => execFileSync("/usr/sbin/sysctl", ["-n", name], { encoding: "utf8" }).trim();
    const seconds = (value: string) =>
      Number(/sec = (\d+), usec = (\d+)/.exec(value)?.[1] ?? 0) * 1000 +
      Number(/usec = (\d+)/.exec(value)?.[1] ?? 0) / 1000;
    const wakeAt = seconds(sysctl("kern.waketime"));
    // The uptime clock at the last wake (mach ticks over the timebase), then awake since; never slept: since boot.
    const predicted =
      wakeAt > 0
        ? (Number(sysctl("kern.wake_abs_time")) / Number(sysctl("hw.tbfrequency"))) * 1000 + (Date.now() - wakeAt)
        : Date.now() - seconds(sysctl("kern.boottime"));
    const value = await uptimeRaw();
    expect(value).not.toBeNull();
    expect(Math.abs((value as number) - predicted)).toBeLessThan(2_000);
  });

  test("the wall clock is awake time with no sleep accounted, for a test of the plugin", async () => {
    expect((await wallClock(() => 5000).read())(1000)).toEqual({ ms: 4000, whole: true });
  });
});

describe("your verdict", () => {
  const proposalsOf = async (fleet: Fleet) => (await fleet.get()).detail?.proposals ?? [];

  test("is appended to the fleet's review file, a line per key, readable only by you, and read back", async () => {
    const { paths, fleet, logs } = await setup();
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(0.2), exit: 0 }] } });
    const ledger = join(paths.state, "alpha", "ledger.jsonl");
    const before = await readFile(ledger, "utf8");
    const [first, second] = await proposalsOf(fleet);
    if (!first || !second) throw new Error("the fixture proposes nothing");
    const { proposals } = await fleet.review({ scope: "alpha", keys: [first.key], verdict: "accept", note: "" });
    expect(proposals[0]?.review).toEqual({ verdict: "accept", note: null, at: new Date(NOW).toISOString(), tick: 35 });
    await fleet.review({ scope: "alpha", keys: [second.key], verdict: "reject", note: "Unmanaged is the owner's" });
    await fleet.review({ scope: "alpha", keys: [first.key], verdict: "reject", note: "changed my mind" });

    const file = join(paths.state, "alpha", REVIEWS_FILE);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const lines = (await readFile(file, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.map((line) => [line.kind, line.key, line.verdict, line.note, line.by, line.via])).toEqual([
      ["proposal_review", first.key, "accept", null, "owner", "maestro"],
      ["proposal_review", second.key, "reject", "Unmanaged is the owner's", "owner", "maestro"],
      ["proposal_review", first.key, "reject", "changed my mind", "owner", "maestro"],
    ]);
    const reviewed = await proposalsOf(fleet);
    expect(reviewed.map((entry) => [entry.key, entry.review?.verdict, entry.review?.note])).toEqual([
      [first.key, "reject", "changed my mind"],
      [second.key, "reject", "Unmanaged is the owner's"],
    ]);
    expect((await fleet.get()).scopes[0]?.unreviewed).toBe(0);
    // The fleet's own files are never written.
    expect(await readFile(ledger, "utf8")).toBe(before);
    expect(logs.at(-1)).toContain('you rejected 1 proposal(s): "report"');
  });

  test("one verdict on many keys is one append; a key no longer proposed writes none of them", async () => {
    const { paths, fleet } = await setup();
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(0.2), exit: 0 }] } });
    const keys = (await proposalsOf(fleet)).map((proposal) => proposal.key);
    await expect(
      fleet.review({ scope: "alpha", keys: [...keys, "session:gone:4:deadbeef"], verdict: "accept", note: "" }),
    ).rejects.toThrow("The fleet no longer proposes this");
    const file = join(paths.state, "alpha", REVIEWS_FILE);
    await expect(stat(file)).rejects.toThrow();
    const { proposals } = await fleet.review({ scope: "alpha", keys, verdict: "accept", note: "" });
    expect(proposals.map((proposal) => proposal.review?.verdict)).toEqual(["accept", "accept"]);
    expect((await readFile(file, "utf8")).trimEnd().split("\n")).toHaveLength(2);
  });

  test("verdicts made at once are each written, in order, none lost", async () => {
    const { paths, fleet } = await setup();
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(0.2), exit: 0 }] } });
    const [first, second] = await proposalsOf(fleet);
    if (!first || !second) throw new Error("the fixture proposes nothing");
    await Promise.all([
      fleet.review({ scope: "alpha", keys: [first.key], verdict: "accept", note: "" }),
      fleet.review({ scope: "alpha", keys: [second.key], verdict: "accept", note: "" }),
      fleet.review({ scope: "alpha", keys: [first.key], verdict: "reject", note: "" }),
    ]);
    const lines = (await readFile(join(paths.state, "alpha", REVIEWS_FILE), "utf8")).trimEnd().split("\n");
    expect(lines.map((line) => JSON.parse(line).verdict)).toEqual(["accept", "accept", "reject"]);
  });

  test("a line torn by a crash does not join the next verdict", async () => {
    const { paths, fleet } = await setup();
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(0.2), exit: 0 }] } });
    const file = join(paths.state, "alpha", REVIEWS_FILE);
    await writeFile(file, '{"kind":"proposal_rev', { mode: 0o600 });
    const [first] = await proposalsOf(fleet);
    if (!first) throw new Error("the fixture proposes nothing");
    await fleet.review({ scope: "alpha", keys: [first.key], verdict: "accept", note: "" });
    const detail = (await fleet.get()).detail;
    expect(detail?.proposals[0]?.review?.verdict).toBe("accept");
    expect(detail?.warnings).toEqual([`${REVIEWS_FILE} has 1 line(s) that did not parse; they are left out.`]);
  });

  test("a review file that is a symlink is not written through: the verdict is refused, the target untouched", async () => {
    const { root, paths, fleet } = await setup();
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(0.2), exit: 0 }] } });
    const target = join(root, "dotfile");
    await writeFile(target, "export PATH=/usr/bin\n");
    await symlink(target, join(paths.state, "alpha", REVIEWS_FILE));
    const [first] = await proposalsOf(fleet);
    await expect(
      fleet.review({ scope: "alpha", keys: [first?.key ?? ""], verdict: "accept", note: "" }),
    ).rejects.toThrow("Your verdict was not recorded");
    expect(await readFile(target, "utf8")).toBe("export PATH=/usr/bin\n");
  });

  test("a review file with another hard link is not written: the verdict is refused, the other name untouched", async () => {
    const { root, paths, fleet } = await setup();
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(0.2), exit: 0 }] } });
    const target = join(root, "dotfile");
    await writeFile(target, "export PATH=/usr/bin\n");
    await link(target, join(paths.state, "alpha", REVIEWS_FILE));
    const [first] = await proposalsOf(fleet);
    await expect(
      fleet.review({ scope: "alpha", keys: [first?.key ?? ""], verdict: "accept", note: "" }),
    ).rejects.toThrow("has another hard link");
    expect(await readFile(target, "utf8")).toBe("export PATH=/usr/bin\n");
  });

  test("a key sent twice is one line; every line has an id of its own", async () => {
    const { paths, fleet } = await setup();
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(0.2), exit: 0 }] } });
    const keys = (await proposalsOf(fleet)).map((proposal) => proposal.key);
    await fleet.review({ scope: "alpha", keys: [...keys, ...keys], verdict: "accept", note: "" });
    await fleet.review({ scope: "alpha", keys, verdict: "reject", note: "" });
    const lines = (await readFile(join(paths.state, "alpha", REVIEWS_FILE), "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line).id);
    expect(lines).toHaveLength(4);
    expect(new Set(lines).size).toBe(4);
  });

  test("a state dir that holds no fleet ledger gets no verdict", async () => {
    const { paths, fleet } = await setup();
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(0.2), exit: 0 }] } });
    const [first] = await proposalsOf(fleet);
    await rm(join(paths.state, "alpha", "ledger.jsonl"));
    await expect(
      fleet.review({ scope: "alpha", keys: [first?.key ?? ""], verdict: "accept", note: "" }),
    ).rejects.toThrow("holds no fleet ledger");
    await expect(stat(join(paths.state, "alpha", REVIEWS_FILE))).rejects.toThrow();
  });

  test("only what the fleet proposes now, in a scope it has, is reviewed; nothing is written otherwise", async () => {
    const { paths, fleet } = await setup();
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(0.2), exit: 0 }] } });
    await expect(
      fleet.review({ scope: "alpha", keys: ["session:x:4:deadbeef"], verdict: "accept", note: "" }),
    ).rejects.toThrow("The fleet no longer proposes this");
    await expect(fleet.review({ scope: "gamma", keys: ["k"], verdict: "accept", note: "" })).rejects.toThrow(
      "The fleet has no scope named gamma.",
    );
    // A later report that no longer proposes it refuses a verdict made from the earlier one.
    const [first] = await proposalsOf(fleet);
    await writeFile(
      join(paths.state, "alpha", "ticks", "00035", "report.json"),
      JSON.stringify(report(35, ago(0.2), { sessions: [] })),
    );
    await expect(
      fleet.review({ scope: "alpha", keys: [first?.key ?? ""], verdict: "accept", note: "" }),
    ).rejects.toThrow("The fleet no longer proposes this");
    await expect(stat(join(paths.state, "alpha", REVIEWS_FILE))).rejects.toThrow();
  });
});

describe("drilling in", () => {
  test("a proposal names its session's branch and Paseo agent; an ask about a session at a prompt names it", async () => {
    const { paths, fleet } = await setup();
    const agent = "aaaaaaaa-0000-4000-8000-000000000001";
    const waiting = "d4b991f0-1133-4c26-9c1a-2b213ec6aaa1";
    await writeFleet(paths, {
      alpha: {
        ticks: [
          {
            tick: 35,
            at: ago(0.2),
            exit: 0,
            report: report(35, ago(0.2), {
              sessions: [
                session("22222222-bbbb", "4", "report", { branch: "feat/x", paseo_agent: agent, kind: "interactive" }),
                session(waiting, "3", "nothing", { name: "broomva-88", paseo_agent: agent }),
              ],
              asks_open: [
                { id: "a2", key: "records-without-process", class: "count", first_tick: 30, question: "3 records" },
              ],
              // New this tick: the report lists it under `asks`, with no first_tick of its own.
              asks: [{ id: "a1", key: `prompt:${waiting}:3efecb94`, class: "3", question: "At a prompt." }],
            }),
          },
        ],
      },
    });
    const detail = (await fleet.get()).detail;
    expect(detail?.proposals[0]?.session).toEqual({
      id: "22222222-bbbb",
      short: "22222222",
      name: "session-2222",
      kind: "interactive",
      status: "failed",
      cwd: "~/alpha",
      branch: "feat/x",
      agentId: agent,
    });
    expect(detail?.asks.map((ask) => [ask.id, ask.className, ask.firstTick, ask.session])).toEqual([
      ["a2", null, 30, null],
      ["a1", "waiting at a prompt", 35, { id: waiting, short: "d4b991f0", name: "broomva-88", agentId: agent }],
    ]);
  });

  test("a tick opens to its own report and its lines in tick.log, from its start to its done line", async () => {
    const { paths, fleet } = await setup();
    await writeFleet(paths, {
      alpha: {
        ticks: [
          { tick: 34, at: ago(1.2), exit: 1, detail: "recover=0 observe=1", markdown: "# tick 34\n" },
          { tick: 35, at: ago(0.2), exit: 0, markdown: "# tick 35\n" },
        ],
      },
    });
    await writeFile(
      join(paths.state, "alpha", "tick.log"),
      [
        "[2026-10-02T19:00:00Z] tick 34 scope alpha (dry_run=1)",
        "[2026-10-02T19:00:01Z] step recover rc=0",
        "fleet observe: claude agents timed out",
        "[2026-10-02T19:00:09Z] step observe rc=1",
        "[2026-10-02T19:00:09Z] tick 34 done: recover=0 observe=1",
        "fleet config-check: ok",
        "[2026-10-02T20:00:00Z] tick 35 scope alpha (dry_run=1)",
        "[2026-10-02T20:00:05Z] tick 35 done: recover=0 observe=0",
        "",
      ].join("\n"),
    );
    const tick = await fleet.tick("alpha", 34);
    expect(tick.report).toEqual({ markdown: "# tick 34\n", truncated: false });
    expect(tick.notes).toEqual([]);
    expect(tick.log).toEqual({
      path: join(paths.state, "alpha", "tick.log"),
      text: [
        "[2026-10-02T19:00:00Z] tick 34 scope alpha (dry_run=1)",
        "[2026-10-02T19:00:01Z] step recover rc=0",
        "fleet observe: claude agents timed out",
        "[2026-10-02T19:00:09Z] step observe rc=1",
        "[2026-10-02T19:00:09Z] tick 34 done: recover=0 observe=1",
      ].join("\n"),
      truncated: false,
    });
    // A tick the log no longer holds, and one with no report: each is null, not an error.
    expect(await fleet.tick("alpha", 7)).toEqual({ tick: 7, report: null, notes: [], log: null });
    await expect(fleet.tick("nowhere", 1)).rejects.toThrow("The fleet has no scope named nowhere.");
  });

  test("decision asks in the fleet's ask root are in the view, and an answer is written there under the lock", async () => {
    const { root, paths, fleet, logs } = await setup();
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(0.2), exit: 0 }] } });
    const askRoot = join(paths.state, "alpha", ".control", "asks");
    await mkdir(askRoot, { recursive: true });
    const ledger = [
      "arc: fleet-alpha",
      "asks:",
      "  - id: spawn-duplicate-1",
      "    uid: 11111111-2222-4333-8444-555555555555",
      '    headline: "Stop the newer of two sessions on one ticket?"',
      '    stakes: "Both push to one branch."',
      "    options:",
      "      - id: stop-newer",
      '        label: "Stop the newer"',
      '        consequence: "Its work so far stays on disk."',
      "        reversible: true",
      "        recommended: true",
      "      - id: leave",
      '        label: "Leave both"',
      '        consequence: "They race."',
      "        reversible: true",
      '    default: "leave it; asked again while it lasts"',
      "    blocking: false",
      "",
    ].join("\n");
    await writeFile(join(askRoot, "fleet-alpha.yaml"), ledger);
    // Not blocking, and nothing it recommends is final: it does not wait on you, so the header does not count it.
    expect(await fleet.waitingAsks()).toEqual([]);
    await writeFile(join(askRoot, "fleet-blocking.yaml"), ledger.replace("blocking: false", "blocking: true"));
    expect((await fleet.waitingAsks()).map((notice) => [notice.scope, notice.ledger, notice.blocking])).toEqual([
      ["alpha", "fleet-blocking.yaml", true],
    ]);
    await rm(join(askRoot, "fleet-blocking.yaml"));
    const detail = (await fleet.get()).detail;
    expect(detail?.askRoot).toBe(askRoot);
    expect(detail?.decisions.map((ask) => [ask.id, ask.state, ask.options.map((option) => option.id)])).toEqual([
      ["spawn-duplicate-1", "open", ["stop-newer", "leave"]],
    ]);
    const { ask, warning } = await fleet.answer({
      scope: "alpha",
      ledger: "fleet-alpha.yaml",
      uid: "11111111-2222-4333-8444-555555555555",
      id: "spawn-duplicate-1",
      hash: detail?.decisions[0]?.hash ?? "",
      option: "stop-newer",
      note: "",
    });
    expect(warning).toBeNull();
    expect([ask.state, ask.answerOption, ask.answeredAt]).toEqual(["answered", "stop-newer", "2026-10-02T20:40:00Z"]);
    const written = await readFile(join(askRoot, "fleet-alpha.yaml"), "utf8");
    expect(written).toContain('    answer_option: "stop-newer"\n');
    expect(written).toContain('    answered_by: "owner:maestro"\n');
    expect((await readFile(join(root, "receipts.jsonl"), "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
    expect(logs).toContain("fleet alpha: you answered fleet-alpha.yaml spawn-duplicate-1 (stop-newer)");
    // Answered once: a second answer is refused, and a name that is not a ledger in the root never resolves.
    await expect(
      fleet.answer({
        scope: "alpha",
        ledger: "fleet-alpha.yaml",
        uid: ask.uid,
        id: ask.id,
        hash: ask.hash,
        option: "leave",
        note: "",
      }),
    ).rejects.toThrow("already answered");
    const stray = { uid: null, id: "x", hash: "h", option: null, note: "x" };
    await expect(fleet.answer({ scope: "alpha", ledger: "../ledger.jsonl", ...stray })).rejects.toThrow(
      "is not a ledger name",
    );
    // A .control that links out of the state dir (into a git checkout, say) is never written through.
    const elsewhere = join(root, "checkout");
    await mkdir(join(elsewhere, "asks"), { recursive: true });
    await writeFile(join(elsewhere, "asks", "fleet-alpha.yaml"), ledger);
    await rm(join(paths.state, "alpha", ".control"), { recursive: true });
    await symlink(elsewhere, join(paths.state, "alpha", ".control"));
    await expect(fleet.answer({ scope: "alpha", ledger: "fleet-alpha.yaml", ...stray })).rejects.toThrow(
      "is not a folder of the fleet's own",
    );
    expect(await readFile(join(elsewhere, "asks", "fleet-alpha.yaml"), "utf8")).toBe(ledger);
  });
});

describe("ledger locks Maestro left behind", () => {
  test("are cleared by a sweep a Fleet read queues, with no scope at all", async () => {
    const { root, fleet } = await setup();
    const ledger = join(root, "asks", "l.yaml");
    await mkdir(join(root, "asks"), { recursive: true });
    await writeFile(ledger, "asks: []\n");
    const locks = join(root, "locks");
    // A release whose token could not be read leaves the lock, our pid on it.
    const lock = await acquireLock(ledger, locks);
    await writeFile(join(lock.dir, "token"), "garbled\n");
    await releaseLock(lock);
    expect(await readdir(locks)).toHaveLength(1);
    expect((await fleet.get()).scopes).toEqual([]);
    for (let tries = 0; tries < 50 && (await readdir(locks)).length > 0; tries++) await Bun.sleep(20);
    expect(await readdir(locks)).toEqual([]);
  });
});
