import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkItem } from "../shared/contracts";
import { groupOf, type OrchState } from "../shared/states";
import { askBatch, H, report, writeFleet } from "./fake-fleet";
import { DISABLED_NOTICE, Fleet, REVIEWS_FILE } from "./fleet";

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

async function setup(items: WorkItem[] = []) {
  const root = await mkdtemp(join(tmpdir(), "maestro-fleet-"));
  roots.push(root);
  const paths = { config: join(root, "fleet.json"), state: join(root, "state"), agents: join(root, "agents") };
  let now = NOW;
  const logs: string[] = [];
  const fleet = new Fleet({
    configPath: paths.config,
    stateRoot: paths.state,
    agentsDir: paths.agents,
    items: async () => items,
    now: () => now,
    log: (message) => logs.push(message),
  });
  return { root, paths, fleet, logs, setNow: (at: number) => (now = at), items };
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
        reason: "No tick for 3h: the last was tick 35. It runs every hour.",
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
      { scope: "alpha", status: "failing", reason: "Tick 35 failed at observe (recover=0 observe=1 compare=0 ask=0)." },
    ]);
    const alert = work("w-obs", "fleet alpha: tick-observe [fleet-reconcile alpha alert tick-observe]", "review");
    expect(await fleet.notices([alert])).toEqual([]);
    const other = work("w-rep", "fleet alpha: tick-report [fleet-reconcile alpha alert tick-report]", "review");
    expect((await fleet.notices([other])).length).toBe(1);
  });

  test("time the Mac slept is not counted toward a missed tick", async () => {
    const { paths, fleet, setNow } = await setup();
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(8), exit: 0 }] } });
    // Asleep from 7 h ago: the heartbeat's next beat comes only at wake, half an hour ago, then every minute.
    const awake = (from: number, to: number) => {
      for (let minute = from; minute <= to; minute += 1) {
        setNow(NOW + minute * 60_000);
        fleet.beat();
      }
    };
    setNow(NOW - 7 * H);
    fleet.beat();
    awake(-30, 0);
    expect((await fleet.notices([])).length).toBe(0);
    expect((await fleet.get()).scopes[0]?.health.status).toBe("ok");
    // 2 h after the wake with no tick, it is missed: counted from the wake, not from the last tick 8 h ago.
    awake(1, 89);
    expect((await fleet.notices([])).length).toBe(0);
    awake(90, 91);
    expect(await fleet.notices([])).toMatchObject([
      { status: "missed", reason: expect.stringContaining("No tick for 9h 31m") },
    ]);
  });

  test("the kill switch and an unscheduled scope never need you", async () => {
    const { paths, fleet } = await setup();
    await writeFleet(paths, {
      alpha: { ticks: [{ tick: 35, at: ago(30), exit: 1 }] },
      beta: { ticks: [{ tick: 6, at: ago(30), exit: 0 }], scheduled: false },
    });
    await writeFile(join(paths.state, "alpha", DISABLED_NOTICE), "");
    expect(await fleet.notices([])).toEqual([]);
    expect((await fleet.get()).scopes.map((scope) => scope.health.status)).toEqual(["off", "unscheduled"]);
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
            key: "resume:abc",
            dry_run: true,
            tick: 35,
            target: { session_id: "abc" },
          },
          {
            kind: "done",
            of: "35-5",
            verb: "resume",
            key: "resume:abc",
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

describe("your verdict", () => {
  test("is appended to the fleet's review file, one fsynced line, readable only by you, and read back", async () => {
    const { paths, fleet, logs } = await setup();
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(0.2), exit: 0 }] } });
    const ledger = join(paths.state, "alpha", "ledger.jsonl");
    const before = await readFile(ledger, "utf8");
    const [first, second] = (await fleet.get()).detail?.proposals ?? [];
    if (!first || !second) throw new Error("the fixture proposes nothing");
    const { proposal } = await fleet.review({ scope: "alpha", key: first.key, verdict: "accept", note: "" });
    expect(proposal.review).toEqual({ verdict: "accept", note: null, at: new Date(NOW).toISOString(), tick: 35 });
    await fleet.review({ scope: "alpha", key: second.key, verdict: "reject", note: "Unmanaged is the owner's" });
    await fleet.review({ scope: "alpha", key: first.key, verdict: "reject", note: "changed my mind" });

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
    const reviewed = (await fleet.get()).detail?.proposals ?? [];
    expect(reviewed.map((entry) => [entry.key, entry.review?.verdict, entry.review?.note])).toEqual([
      [first.key, "reject", "changed my mind"],
      [second.key, "reject", "Unmanaged is the owner's"],
    ]);
    expect((await fleet.get()).scopes[0]?.unreviewed).toBe(0);
    // The fleet's own files are never written.
    expect(await readFile(ledger, "utf8")).toBe(before);
    expect(logs.at(-1)).toContain('you rejected "report"');
  });

  test("verdicts made at once are each written, in order, none lost", async () => {
    const { paths, fleet } = await setup();
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(0.2), exit: 0 }] } });
    const [first, second] = (await fleet.get()).detail?.proposals ?? [];
    if (!first || !second) throw new Error("the fixture proposes nothing");
    await Promise.all([
      fleet.review({ scope: "alpha", key: first.key, verdict: "accept", note: "" }),
      fleet.review({ scope: "alpha", key: second.key, verdict: "accept", note: "" }),
      fleet.review({ scope: "alpha", key: first.key, verdict: "reject", note: "" }),
    ]);
    const lines = (await readFile(join(paths.state, "alpha", REVIEWS_FILE), "utf8")).trimEnd().split("\n");
    expect(lines.map((line) => JSON.parse(line).verdict)).toEqual(["accept", "accept", "reject"]);
  });

  test("a line torn by a crash does not join the next verdict", async () => {
    const { paths, fleet } = await setup();
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(0.2), exit: 0 }] } });
    const file = join(paths.state, "alpha", REVIEWS_FILE);
    await writeFile(file, '{"kind":"proposal_rev', { mode: 0o600 });
    const [first] = (await fleet.get()).detail?.proposals ?? [];
    if (!first) throw new Error("the fixture proposes nothing");
    await fleet.review({ scope: "alpha", key: first.key, verdict: "accept", note: "" });
    const detail = (await fleet.get()).detail;
    expect(detail?.proposals[0]?.review?.verdict).toBe("accept");
    expect(detail?.warnings).toEqual([`${REVIEWS_FILE} has 1 line(s) that did not parse; they are left out.`]);
  });

  test("only what the fleet proposes now, in a scope it has, is reviewed; nothing is written otherwise", async () => {
    const { paths, fleet } = await setup();
    await writeFleet(paths, { alpha: { ticks: [{ tick: 35, at: ago(0.2), exit: 0 }] } });
    await expect(
      fleet.review({ scope: "alpha", key: "session:x:4:deadbeef", verdict: "accept", note: "" }),
    ).rejects.toThrow("The fleet no longer proposes this");
    await expect(fleet.review({ scope: "gamma", key: "k", verdict: "accept", note: "" })).rejects.toThrow(
      "The fleet has no scope named gamma.",
    );
    // A later report that no longer proposes it refuses a verdict made from the earlier one.
    const [first] = (await fleet.get()).detail?.proposals ?? [];
    await writeFile(
      join(paths.state, "alpha", "ticks", "00035", "report.json"),
      JSON.stringify(report(35, ago(0.2), { sessions: [] })),
    );
    await expect(fleet.review({ scope: "alpha", key: first?.key ?? "", verdict: "accept", note: "" })).rejects.toThrow(
      "The fleet no longer proposes this",
    );
    await expect(stat(join(paths.state, "alpha", REVIEWS_FILE))).rejects.toThrow();
  });
});
