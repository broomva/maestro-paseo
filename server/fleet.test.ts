import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkItem } from "../shared/contracts";
import { groupOf, type OrchState } from "../shared/states";
import { askBatch, H, report, writeFleet } from "./fake-fleet";
import { DISABLED_NOTICE, Fleet, kernelAwakeSince, REVIEWS_FILE } from "./fleet";

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

/** A Fleet on a test's own files, its clock and the kernel's wake time held by the test (by default: booted long ago). */
async function setup(items: WorkItem[] = [], options: { awake?: number | null; started?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "maestro-fleet-"));
  roots.push(root);
  const paths = { config: join(root, "fleet.json"), state: join(root, "state"), agents: join(root, "agents") };
  let now = options.started ?? NOW;
  let awake: number | null = "awake" in options ? (options.awake ?? null) : NOW - 100 * H;
  const logs: string[] = [];
  const fleet = new Fleet({
    configPath: paths.config,
    stateRoot: paths.state,
    agentsDir: paths.agents,
    items: async () => items,
    awakeSince: async () => awake,
    now: () => now,
    log: (message) => logs.push(message),
  });
  now = NOW;
  return {
    root,
    paths,
    fleet,
    logs,
    items,
    setNow: (at: number) => {
      now = at;
    },
    setAwake: (at: number | null) => {
      awake = at;
    },
  };
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

  test("time the Mac slept or was off is not counted toward a missed tick: the clock starts at the wake", async () => {
    const { paths, fleet, setNow, setAwake } = await setup();
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(8), exit: 0 }] } });
    // Booted (or woke) half an hour ago; the last tick was 8 h ago, before the Mac went down.
    setAwake(NOW - 0.5 * H);
    expect(await fleet.notices([])).toEqual([]);
    expect((await fleet.get()).scopes[0]?.health.status).toBe("ok");
    // 2 h after the wake with still no tick, it is missed, and says how long since the last.
    setNow(NOW + 1.4 * H);
    expect(await fleet.notices([])).toEqual([]);
    setNow(NOW + 1.6 * H);
    expect(await fleet.notices([])).toMatchObject([
      { status: "missed", reason: "No tick since tick 35. It runs every hour." },
    ]);
    expect((await fleet.get()).scopes[0]?.health.reason).toContain("No tick for 9h 36m");
  });

  test("when the kernel cannot say when the Mac woke, the plugin's own start stands in: no false alarm at load", async () => {
    const { paths, fleet, setNow } = await setup([], { awake: null, started: NOW - 0.25 * H });
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(8), exit: 0 }] } });
    expect(await fleet.notices([])).toEqual([]);
    setNow(NOW + 2 * H);
    expect((await fleet.notices([]))[0]?.status).toBe("missed");
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
    // 15 minutes into a 15 + 5 minute budget: still running, not died.
    expect(view.detail?.ticks[0]?.status).toBe("running");
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

test("the kernel's wake time is the later of boot and wake; a test may give its own", async () => {
  expect(await kernelAwakeSince({ MAESTRO_PASEO_FLEET_AWAKE: "1790000000000" })).toBe(1_790_000_000_000);
  const kernel = await kernelAwakeSince({});
  // Wherever sysctl answers (macOS), it is a time in the past; elsewhere it cannot say.
  if (kernel !== null) expect(kernel).toBeLessThanOrEqual(Date.now());
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
