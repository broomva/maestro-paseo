import { describe, expect, test } from "bun:test";
import { noticesOf } from "../server/notices";
import type { FleetDetail, FleetScope, FleetSession, FleetTick } from "../shared/fleet";
import type { LoopRow } from "../shared/loops";
import { runningOf } from "../shared/needs-you";
import type { TimelineRun } from "../shared/timeline";
import { fakeWork } from "./fake-work";
import type { ScopeRead } from "./fleet-cockpit-model";
import { healthModel, runCells, scheduleRow, verdictSentence } from "./health-model";

const NOW = Date.parse("2026-10-12T15:00:00.000Z");
const H = 3_600_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const live = (id: string) => ({ agentId: `agent-${id}`, workspaceId: "ws1" });
const quietFlag = { kind: "quiet" as const, reason: "Quiet for 808 minutes, worth a look.", at: ago(808 * 60_000) };

const tick = (n: number, hoursAgo: number, status: FleetTick["status"] = "ok"): FleetTick => ({
  tick: n,
  at: ago(hoursAgo * H),
  finishedAt: ago(hoursAgo * H - 10_000),
  status,
  exit: status === "ok" ? 0 : 1,
  steps: null,
  failedStep: null,
  dryRun: true,
  mode: "report",
  classCounts: null,
  openAsks: 0,
  proposals: 0,
});
const okHealth = {
  status: "ok" as const,
  reason: "Ticks every hour.",
  notice: "",
  since: null,
  item: null,
  needsYou: false,
};
const scope = (id: string, extra: Partial<FleetScope> = {}): FleetScope => ({
  id,
  mode: "report",
  dryRun: true,
  health: okHealth,
  lastTick: { tick: 24, at: ago(0.5 * H), status: "ok" },
  unreviewed: 0,
  openAsks: 0,
  ...extra,
});
const session = (id: string, classId: string, state: string): FleetSession => ({
  id: `${id}-x`,
  short: id,
  name: `s-${id}`,
  kind: "interactive",
  state,
  cwd: "/Users/me/.paseo/worktrees/abc/stingy-seal",
  branch: "feat/x",
  agentId: `agent-${id}`,
  classId,
  className: null,
  action: classId === "10" ? "report only" : "nothing",
  evidence: null,
  activeAt: ago(13 * H),
  scope: "broomva",
  placement: "cwd",
  inScope: true,
  history: [],
});
const detail = (id: string, ticks: FleetTick[], sessions: FleetSession[] = []): FleetDetail =>
  ({
    id,
    stateDir: `/state/${id}`,
    schedule: { scheduled: true, intervalMinutes: 60 },
    ticks,
    report: null,
    proposals: [],
    asks: [],
    decisions: [],
    askRoot: "/asks",
    alerts: [],
    warnings: [],
    roster: { tick: 24, at: ago(H), sessions },
  }) as FleetDetail;

const allOk = (id: string) => Array.from({ length: 24 }, (_, at) => tick(24 - at, at + 0.5));
const reads: ScopeRead[] = [
  {
    scope: scope("broomva"),
    detail: detail("broomva", allOk("broomva"), [
      session("a", "5", "busy"),
      session("b", "10", "idle"),
      session("c", "10", "idle"),
    ]),
  },
  {
    scope: scope("sri"),
    detail: detail(
      "sri",
      [...allOk("sri").slice(0, 23), tick(1, 24, "failed")].map((one, at) =>
        at === 5 ? { ...one, status: "failed" as const, exit: 1 } : one,
      ),
    ),
  },
];

const run = (hoursAgo: number, status: TimelineRun["status"]): TimelineRun => ({
  at: ago(hoursAgo * H),
  endedAt: null,
  status,
  exit: null,
  detail: null,
});
const loopRow = (name: string, extra: Partial<LoopRow> = {}): LoopRow =>
  ({
    subject: `loop:${name}`,
    id: name,
    name,
    kind: "launchd",
    ref: name,
    scope: "broomva",
    owner: "owner",
    purpose: null,
    desired: "active",
    section: "loops",
    intent: null,
    observed: {
      subject: `loop:launchd/${name}`,
      kind: "launchd",
      ref: name,
      name,
      scope: "broomva",
      presence: "on",
      status: "ok",
      reason: "ok",
      since: null,
      cadence: "hourly",
      next: new Date(NOW + 3 * H).toISOString(),
      last: null,
      runs: [run(1, "ok"), run(2, "ok")],
      ephemeral: false,
      where: null,
    },
    unread: false,
    drift: [],
    ...extra,
  }) as LoopRow;
const loops = (rows: LoopRow[]) => ({ now: ago(0), ledger: null, rows, ledgerErrors: [], warnings: [] });

const items = [
  fakeWork("stuck", "blocked", live("stuck"), { project: "sri", reason: "Session ended mid-turn" }),
  fakeWork("run1", "running", live("run1"), { project: "sri" }),
  fakeWork("run2", "running", live("run2"), { project: "holon" }),
  fakeWork("stand", "running", live("stand"), { project: "sri", flag: quietFlag }),
];
const notices = noticesOf({ items, fleet: [], timeline: [], loops: [], reviews: [], snoozed: new Map() }, NOW);

describe("the verdict says one thing, and the notices are its count", () => {
  const model = healthModel({ reads, loops: loops([loopRow("a")]), notices, items, loop: null, now: NOW });

  test("its count is notices.list's total, which is the Health tab's badge", () => {
    expect(model.verdict.title).toBe("2 things need a look");
    expect(notices.summary.total).toBe(2);
    expect(model.verdict.tone).toBe("danger");
  });

  test("nothing to look at is all clear, and says so", () => {
    const none = noticesOf({ items: [], fleet: [], timeline: [], loops: [], reviews: [], snoozed: new Map() }, NOW);
    const clear = healthModel({ reads, loops: loops([]), notices: none, items: [], loop: null, now: NOW });
    expect(clear.verdict).toMatchObject({ title: "All clear", tone: "ok" });
    expect(healthModel({ reads: [], loops: null, notices: null, items: [], loop: null, now: NOW }).verdict.title).toBe(
      "All clear",
    );
    expect(clear.verdict.sentence).not.toContain("stuck");
  });

  test("a notice that could not be read is missing, not none: never All clear over it", () => {
    const none = noticesOf(
      { items: [], fleet: [], timeline: [], loops: [], reviews: [], snoozed: new Map(), unread: ["the loops"] },
      NOW,
    );
    const half = healthModel({ reads, loops: loops([]), notices: none, items: [], loop: null, now: NOW });
    expect(half.verdict).toMatchObject({ title: "Not all clear", tone: "warn" });
    expect(half.verdict.sentence).toContain("Could not read the loops");
    const failed = healthModel({
      reads,
      loops: loops([]),
      notices: null,
      noticesFailed: true,
      items: [],
      loop: null,
      now: NOW,
    });
    expect(failed.verdict.title).toBe("Not all clear");
    // The work could not be read: the stuck and quiet rows are missing, and the verdict says the work.
    const noWork = healthModel({
      reads,
      loops: loops([]),
      notices: none,
      workFailed: true,
      items: [],
      loop: null,
      now: NOW,
    });
    expect(noWork.verdict.sentence).toContain("Could not read the loops, the work");
  });

  test("the sentence names the ticks and each kind of notice, in a person's words", () => {
    expect(verdictSentence(notices, { passed: 47, total: 48 }, reads)).toBe(
      "Both scopes tick on time: 47 of 48 ticks passed in 24 h. A run is stuck and one is quiet.",
    );
    const failing = [
      { ...reads[0], scope: scope("broomva", { health: { ...okHealth, status: "failing" } }) } as ScopeRead,
    ];
    expect(verdictSentence(null, { passed: 20, total: 24 }, failing)).toBe(
      "broomva is not ticking on time: 20 of 24 ticks passed in 24 h.",
    );
  });
});

describe("the four tiles", () => {
  const model = healthModel({
    reads,
    loops: loops([loopRow("a"), loopRow("b", { desired: "paused" })]),
    notices,
    items,
    loop: { minutes: 15, nextAt: null, ticking: false, recent: [] },
    now: NOW,
  });

  test("ticks: a 24-cell strip per scope, and 'passed of seen' counts the cells that are ticks", () => {
    expect(model.ticks.rows.map((row) => [row.scope, row.cells.length])).toEqual([
      ["broomva", 24],
      ["sri", 24],
    ]);
    expect(model.ticks.total).toBe(48);
    expect(model.ticks.passed).toBe(
      model.ticks.rows.flatMap((row) => row.cells).filter((cell) => cell.kind === "passed").length,
    );
    expect(model.ticks.line).toBe(`${model.ticks.passed} of 48 passed`);
    expect(model.ticks.passed).toBeLessThan(48);
  });

  test("sessions: Running is the Running tray's, Stuck and Quiet are notices.list's, and the seen total is their sum", () => {
    const by = Object.fromEntries(model.sessions.segments.map((segment) => [segment.id, segment.count]));
    expect(by.running).toBe(runningOf(items).length);
    expect(by.running).toBe(2);
    expect(by.stuck).toBe(notices.summary.byKind.stuck);
    expect(by.quiet).toBe(notices.summary.byKind.quiet);
    // The two idle sessions are the two unmanaged ones: each is in one segment, so none is counted twice.
    expect(by.idle).toBe(0);
    expect(by.unmanaged).toBe(2);
    expect(model.sessions.seen).toBe(2 + 0 + 1 + 1 + 2);
  });

  test("schedules: the number is the length of the list beside it, with how they stand", () => {
    expect(model.schedules.total).toBe(model.schedulesList.length);
    expect(model.schedules.total).toBe(2);
    expect(model.schedules.breakdown).toBe("1 on time · 1 off");
    expect(model.schedules.next).toBe("next: a 3 h from now");
  });

  test("the conductor: the loop's cadence in its own words, and that it never starts work (A8)", () => {
    expect(model.conductor).toMatchObject({ on: true, cadence: "Ticks every 15 min and on events" });
    expect(model.conductor.words).toContain("Never starts work itself (A8)");
    const off = healthModel({
      reads,
      loops: null,
      notices,
      items,
      loop: { minutes: null, nextAt: null, ticking: false, recent: [] },
      now: NOW,
    });
    expect(off.conductor).toMatchObject({ on: false, cadence: "Maestro's loop is off" });
  });

  test("the header: how the fleet runs, and when it ticks next", () => {
    expect(model.header.mode).toBe("Dry run · report only");
    expect(model.header.cadence).toMatch(/^Hourly · /);
  });
});

describe("a schedule's own recent runs", () => {
  test("the last sixteen, oldest left, the newest on the right; a short history is padded on the left", () => {
    const cells = runCells([run(1, "failed"), run(2, "ok"), run(3, "ok")], 16, NOW);
    expect(cells).toHaveLength(16);
    expect(cells.slice(-3).map((cell) => cell.kind)).toEqual(["passed", "passed", "failed"]);
    expect(cells.slice(0, 13).every((cell) => cell.kind === "empty")).toBe(true);
    expect(cells.at(-1)?.label).toBe("Run failed, 1h ago");
  });

  test("one word says how it is: on time, failed, missed, absent from where it should run, or off", () => {
    const word = (row: LoopRow) => scheduleRow(row, NOW).status.word;
    expect(word(loopRow("ok"))).toBe("On time");
    const failed = loopRow("f");
    if (failed.observed) failed.observed.status = "failed";
    expect(word(failed)).toBe("Failed");
    const missed = loopRow("m");
    if (missed.observed) missed.observed.status = "missed";
    expect(word(missed)).toBe("Missed");
    expect(word(loopRow("gone", { observed: null }))).toBe("Absent");
    expect(word(loopRow("paused", { desired: "paused" }))).toBe("Off");
    expect(word(loopRow("unread", { unread: true }))).toBe("Not read");
    // An absent or off schedule draws no runs: nothing ran, and nothing is pretended.
    expect(scheduleRow(loopRow("gone", { observed: null }), NOW).cells.every((cell) => cell.kind === "empty")).toBe(
      true,
    );
  });

  test("a failed schedule's cells are not 'on time' green: each run's own status shows", () => {
    const row = loopRow("f");
    if (row.observed) row.observed.runs = [run(1, "failed"), run(2, "missed"), run(3, "running")];
    expect(
      scheduleRow(row, NOW)
        .cells.slice(-3)
        .map((cell) => cell.kind),
    ).toEqual(["running", "missed", "failed"]);
  });
});

describe("sessions that want a look", () => {
  test("the unmanaged are listed, with where they are and what the fleet would do; shown of seen", () => {
    const model = healthModel({ reads, loops: null, notices, items, loop: null, now: NOW });
    expect(model.sessionRows.total).toBe(3);
    expect(model.sessionRows.rows.map((row) => row.short)).toEqual(["b", "c"]);
    expect(model.sessionRows.would(model.sessionRows.rows[0] as never)).toBe("List it in the report");
  });
});
