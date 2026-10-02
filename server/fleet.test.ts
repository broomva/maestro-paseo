import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkItem } from "../shared/contracts";
import { groupOf, type OrchState } from "../shared/states";
import { askBatch, H, report, session, writeFleet } from "./fake-fleet";
import { AwakeClock, DISABLED_NOTICE, Fleet, REVIEWS_FILE, wallClock } from "./fleet";

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
 * A Fleet on a test's own files, with its wall clock and its awake clock held
 * by the test. By default the Mac was awake the whole time: the first record
 * is taken far back, so awake time since any tick equals wall time.
 */
async function setup(items: WorkItem[] = [], options: { fresh?: boolean; beforeWrite?: () => Promise<void> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "maestro-fleet-"));
  roots.push(root);
  const paths = { config: join(root, "fleet.json"), state: join(root, "state"), agents: join(root, "agents") };
  let now = NOW;
  let awake = 1_000_000_000;
  const clock = new AwakeClock(
    () => now,
    () => awake,
  );
  if (!options.fresh) {
    // A record from 100 h ago, awake since: the plugin has been running and the Mac has not slept.
    now = NOW - 100 * H;
    awake -= 100 * H;
    clock.read();
    now = NOW;
    awake += 100 * H;
  }
  const logs: string[] = [];
  const fleet = new Fleet({
    configPath: paths.config,
    stateRoot: paths.state,
    agentsDir: paths.agents,
    items: async () => items,
    clock,
    beforeWrite: options.beforeWrite,
    now: () => now,
    log: (message) => logs.push(message),
  });
  /** Moves the wall clock by `wallMs`, of which `awakeMs` awake (the rest asleep). */
  const pass = (wallMs: number, awakeMs: number = wallMs) => {
    now += wallMs;
    awake += awakeMs;
  };
  return { root, paths, fleet, logs, items, pass };
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
    const { paths, fleet, pass } = await setup([], { fresh: true });
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: new Date(NOW), exit: 0 }] } });
    await fleet.notices([]);
    // Short naps between meetings: 6 h of wall time, 1.5 h of it awake. launchd has not owed two ticks.
    for (let hour = 0; hour < 6; hour += 1) {
      pass(H, 15 * 60_000);
      expect(await fleet.notices([])).toEqual([]);
    }
    // Awake another 35 minutes: 2h 5m awake with no tick, which is missed however the sleeps fell.
    pass(35 * 60_000);
    expect(await fleet.notices([])).toMatchObject([
      { status: "missed", reason: "No tick since tick 35. It runs every hour." },
    ]);
    expect((await fleet.get()).scopes[0]?.health.reason).toBe(
      "No tick for 6h 35m (2h 5m of it awake): the last was tick 35. It runs every hour.",
    );
  });

  test("a reload or a cold boot never raises a false alarm: time before the plugin started is not counted", async () => {
    const { paths, fleet, pass } = await setup([], { fresh: true });
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(8), exit: 0 }] } });
    expect(await fleet.notices([])).toEqual([]);
    pass(1.9 * H);
    expect(await fleet.notices([])).toEqual([]);
    pass(0.2 * H);
    expect((await fleet.notices([]))[0]?.status).toBe("missed");
  });

  test("a tick that died stays dead after a wake; one the Mac slept through mid-run is still running", async () => {
    // The plugin has been running all along, as the daemon does: its clock knows both ticks' starts.
    const { paths, fleet, pass } = await setup();
    await writeFleet(paths, {
      alpha: { ticks: [{ tick: 36, at: new Date(NOW - 5 * 60_000) }] },
      beta: { ticks: [{ tick: 9, at: ago(72) }] },
    });
    await fleet.get();
    // Asleep 4 h, then awake 5 minutes.
    pass(4 * H, 5 * 60_000);
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
  test("reads awake time off its records: a gap between two records was awake first, then asleep", () => {
    let wall = 0;
    let awake = 0;
    const clock = new AwakeClock(
      () => wall,
      () => awake,
    );
    clock.read();
    // 10 minutes awake, then asleep 3 h, then awake 20 minutes; the plugin read only at the start and the end.
    wall += 10 * 60_000 + 3 * H + 20 * 60_000;
    awake += 30 * 60_000;
    const since = clock.read();
    expect(since(0)).toEqual({ ms: 30 * 60_000, whole: true });
    expect(since(5 * 60_000)).toEqual({ ms: 25 * 60_000, whole: true });
    // From inside the gap: it cannot tell where in the gap the Mac was awake, and counts as if first, so never more.
    expect(since(2 * H)).toEqual({ ms: 0, whole: true });
    // From before the first record: counted from it, a lower bound, and said to be one.
    expect(since(-10 * H)).toEqual({ ms: 30 * 60_000, whole: false });
    // Awake two more hours with a record after the gap: from inside the gap, the gap gives at most what it held.
    wall += 2 * H;
    awake += 2 * H;
    const later = clock.read();
    expect(later(2 * H)).toEqual({ ms: 2 * H, whole: true });
  });

  test("keeps a record at most once a minute, and forgets those past eight days", () => {
    let wall = 0;
    let awake = 0;
    const clock = new AwakeClock(
      () => wall,
      () => awake,
    );
    clock.read();
    wall += 30_000;
    awake += 30_000;
    clock.read();
    wall += 9 * 24 * H;
    awake += 9 * 24 * H;
    const since = clock.read();
    // The first record is gone: from day 0 counts from the newest kept, which is now.
    expect(since(0)).toEqual({ ms: 0, whole: false });
  });

  test("the wall clock is awake time with no sleep accounted, for a test of the plugin", () => {
    expect(wallClock(() => 5000).read()(1000)).toEqual({ ms: 4000, whole: true });
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

  test("a tick that lands while a verdict is checked stops it: nothing is written, and it says to look again", async () => {
    let tickNow: (() => Promise<void>) | null = null;
    const { paths, fleet } = await setup([], { beforeWrite: async () => tickNow?.() });
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(0.2), exit: 0 }] } });
    const [first] = await proposalsOf(fleet);
    tickNow = async () => {
      const dir = join(paths.state, "alpha", "ticks", "00036");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "report.json"), JSON.stringify(report(36, new Date(NOW), {}, "alpha")));
    };
    await expect(
      fleet.review({ scope: "alpha", keys: [first?.key ?? ""], verdict: "accept", note: "" }),
    ).rejects.toThrow("The fleet ticked while you decided");
    await expect(stat(join(paths.state, "alpha", REVIEWS_FILE))).rejects.toThrow();
    // Looked at again, the same words are still proposed, and the verdict goes in.
    tickNow = null;
    const { proposals } = await fleet.review({ scope: "alpha", keys: [first?.key ?? ""], verdict: "accept", note: "" });
    expect(proposals[0]?.review?.verdict).toBe("accept");
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
