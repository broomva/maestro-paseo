import { describe, expect, test } from "bun:test";
import type { WorkItem } from "../shared/contracts";
import { type FleetTick, groupProposals } from "../shared/fleet";
import { groupOf, type OrchState } from "../shared/states";
import { askBatch, H, report, session } from "./fake-fleet";
import {
  actProposals,
  askSession,
  asksOf,
  awakeAsWall,
  coverOf,
  failedStepOf,
  fleetItem,
  foldLedger,
  foldReviews,
  healthOf,
  markerOf,
  missedAfter,
  parseJsonLines,
  proposalKey,
  REVIEW_KIND,
  reviewRecord,
  span,
  summarizeReport,
  tickLogSection,
  tickRows,
  tickStatusOf,
} from "./fleet-model";

const NOW = Date.parse("2026-10-02T20:40:00Z");
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * H).toISOString();

function work(id: string, title: string, state: OrchState, createdAt = "2026-10-01T10:00:00Z"): WorkItem {
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
    createdAt,
    updatedAt: createdAt,
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

function tick(n: number, status: FleetTick["status"], hoursAgo: number, extra: Partial<FleetTick> = {}): FleetTick {
  return {
    tick: n,
    at: at(hoursAgo),
    finishedAt: null,
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
  };
}

describe("the ledger", () => {
  test("a torn or garbage line is counted and skipped, never fatal", () => {
    const { records, bad } = parseJsonLines('{"kind":"tick_fire","tick":1}\n{"kind":\n[1,2]\n\n{"kind":"x"}');
    expect(records.map((record) => record.kind)).toEqual(["tick_fire", "x"]);
    expect(bad).toBe(2);
  });

  test("folds each tick's start and exit; the first ticks' exit_code is their exit, and no code reads as none", () => {
    const fold = foldLedger([
      { kind: "tick_fire", tick: 1, ts: at(3), dry_run: true },
      { kind: "runner_exit", tick: 1, ts: at(2.9), detail: "observe=0 report=0", exit_code: 0 },
      { kind: "tick_fire", tick: 4, ts: at(0.5) },
      { kind: "runner_exit", tick: 4, ts: at(0.4) },
      { kind: "tick_fire", tick: 2, ts: at(2) },
      { kind: "runner_exit", tick: 2, ts: at(1.9), exit: 1, detail: "recover=0 observe=1" },
      { kind: "tick_fire", tick: 3, ts: at(1) },
    ]);
    expect(fold.ticks.get(1)).toMatchObject({ ended: true, exit: 0, dryRun: true });
    expect(fold.ticks.get(4)).toMatchObject({ ended: true, exit: null });
    expect(fold.ticks.get(2)).toMatchObject({ ended: true, exit: 1, detail: "recover=0 observe=1" });
    expect(fold.ticks.get(3)).toMatchObject({ ended: false, exit: null });
  });

  test("an ask belongs to the latest batch that carries it, and a gone item frees its batch", () => {
    const first = askBatch("alpha", 2, [{ id: "a1", key: "k1" }], "item-2");
    const second = askBatch(
      "alpha",
      7,
      [
        { id: "a1", key: "k1" },
        { id: "a2", key: "k2" },
      ],
      "item-7",
    );
    const fold = foldLedger([
      ...first.lines,
      ...second.lines,
      { kind: "seen", of: second.batch, result: { channel: "maestro", item: "item-7", state: "gone" } },
    ]);
    expect(fold.batchOfAsk.get("k1")).toBe(second.batch);
    expect(fold.batchOfAsk.get("k2")).toBe(second.batch);
    expect(fold.itemOfBatch.get(first.batch)).toBe("item-2");
    expect(fold.itemOfBatch.has(second.batch)).toBe(false);
  });

  test("a coordinator verb under dry run is a proposal only once closed done; a live or refused one is not", () => {
    const fold = foldLedger([
      {
        kind: "intent",
        id: "5-1",
        verb: "spawn",
        key: "alpha-workspace-pr9",
        dry_run: true,
        tick: 5,
        target: { repo: "broomva/workspace", pr: 9, role: "driver", name: "alpha-workspace-pr9" },
      },
      { kind: "done", of: "5-1", verb: "spawn", key: "alpha-workspace-pr9", dry_run: true, tick: 5, ts: at(1) },
      { kind: "intent", id: "5-2", verb: "label", key: "o/r#12", dry_run: false, tick: 5, target: {} },
      { kind: "done", of: "5-2", verb: "label", key: "o/r#12", dry_run: false, tick: 5 },
      { kind: "intent", id: "5-3", verb: "mail", key: "session:abc", dry_run: true, tick: 5, target: {} },
      { kind: "failed", of: "5-3", verb: "mail", key: "session:abc", dry_run: true, tick: 5 },
    ]);
    expect(fold.dryActs.map((act) => [act.verb, act.key, act.tick])).toEqual([["spawn", "alpha-workspace-pr9", 5]]);
    expect(actProposals(fold.dryActs, null)).toMatchObject([
      { source: "act", action: "spawn a driver for broomva/workspace#9", verb: "spawn" },
    ]);
    expect(actProposals(fold.dryActs, 6)).toEqual([]);
    // A verb run by hand outside a tick has no tick number: old news inside a window, never a standing proposal.
    const byHand = foldLedger([
      {
        kind: "intent",
        id: "owner-1",
        verb: "resume",
        key: "session:x",
        dry_run: true,
        tick: null,
        target: { session_id: "x" },
      },
      { kind: "done", of: "owner-1", verb: "resume", key: "session:x", dry_run: true, tick: null, ts: at(1) },
    ]);
    expect(actProposals(byHand.dryActs, null)).toHaveLength(1);
    expect(actProposals(byHand.dryActs, 5)).toEqual([]);
  });

  test("two verbs under one fleet key are two proposals, each named by what it would do", () => {
    // The fleet keys a label by its PR and a mail by its recipient (fleetlib/act.py).
    const dry = (id: string, verb: string, key: string, target: Record<string, unknown>) => [
      { kind: "intent", id, verb, key, dry_run: true, tick: 7, target },
      { kind: "done", of: id, verb, key, dry_run: true, tick: 7, ts: at(0.5) },
    ];
    const proposals = actProposals(
      foldLedger([
        ...dry("7-1", "label", "o/r#12", { repo: "o/r", pr: 12, label: "ready", op: "add" }),
        ...dry("7-2", "label", "o/r#12", { repo: "o/r", pr: 12, label: "ready", op: "remove" }),
        ...dry("7-3", "mail", "session:abc", { name: "walrus", template: "stalled", text: "Still there?" }),
        ...dry("7-4", "mail", "session:abc", { name: "walrus", template: "hung", text: "Stuck?" }),
        ...dry("7-5", "resume", "session:def", { session_id: "def12345-x" }),
      ]).dryActs,
      null,
    );
    expect(proposals.map((proposal) => proposal.action)).toEqual([
      "resume def12345",
      "mail walrus (hung)",
      "mail walrus (stalled)",
      'remove label "ready" on o/r#12',
      'add label "ready" on o/r#12',
    ]);
    expect(new Set(proposals.map((proposal) => proposal.key)).size).toBe(5);
    // The same verb again, word for word, is the same proposal: one verdict holds.
    const again = actProposals(
      foldLedger(dry("8-1", "label", "o/r#12", { repo: "o/r", pr: 12, label: "ready", op: "add" })).dryActs,
      null,
    );
    expect(again[0]?.key).toBe(proposals[4]?.key);
  });
});

describe("grouping proposals", () => {
  test("two mails of one template to one recipient with other text are two keys and two cards, never one", () => {
    const dry = (id: string, text: string) => [
      {
        kind: "intent",
        id,
        verb: "mail",
        key: "session:abc",
        dry_run: true,
        tick: 7,
        target: { name: "walrus", template: "stalled", text },
      },
      { kind: "done", of: id, verb: "mail", key: "session:abc", dry_run: true, tick: 7, ts: at(0.5) },
    ];
    const proposals = actProposals(
      foldLedger([...dry("7-1", "Still there?"), ...dry("7-2", "Rebase onto main")]).dryActs,
      null,
    );
    expect(proposals.map((proposal) => proposal.action)).toEqual(["mail walrus (stalled)", "mail walrus (stalled)"]);
    expect(proposals[0]?.key).not.toBe(proposals[1]?.key);
    // Each card shows its text, so the words a verdict binds are the words on screen.
    expect(proposals.map((proposal) => proposal.evidence)).toEqual(["text: Rebase onto main", "text: Still there?"]);
    expect(groupProposals(proposals).map((group) => group.proposals.length)).toEqual([1, 1]);
  });

  test("sessions judged apart stand apart: a group verdict never overwrites one given a single session", () => {
    const summary = summarizeReport(
      report(35, new Date(NOW), {
        sessions: ["a", "b", "c"].map((id) => session(`${id}0000000-x`, "10", "report only")),
      }),
      "alpha",
      35,
    );
    const [a, b, c] = summary?.proposals ?? [];
    if (!a || !b || !c) throw new Error("three proposals");
    const rejected = { verdict: "reject" as const, note: "mine", at: at(1), tick: 34 };
    const groups = groupProposals([{ ...a, review: rejected }, b, c]);
    // The two still waiting come first, the one you rejected after, each its own decision.
    expect(
      groups.map((group) => [group.review?.verdict ?? null, group.proposals.map((p) => p.session?.short)]),
    ).toEqual([
      [null, ["b0000000", "c0000000"]],
      ["reject", ["a0000000"]],
    ]);
  });
});

describe("group order", () => {
  test("waiting first, then accepted, then rejected; a reject's note is part of where it stands", () => {
    const summary = summarizeReport(
      report(35, new Date(NOW), {
        sessions: ["a", "b", "c", "d"].map((id) => session(`${id}0000000-x`, "10", "report only")),
      }),
      "alpha",
      35,
    );
    const [a, b, c, d] = summary?.proposals ?? [];
    if (!a || !b || !c || !d) throw new Error("four proposals");
    const verdict = (kind: "accept" | "reject", note: string | null) => ({ verdict: kind, note, at: at(1), tick: 34 });
    const groups = groupProposals([
      { ...a, review: verdict("reject", "mine") },
      { ...b, review: verdict("reject", "not yet") },
      { ...c, review: verdict("accept", null) },
      d,
    ]);
    expect(
      groups.map((group) => [group.review?.verdict ?? null, group.review?.note ?? null, group.proposals.length]),
    ).toEqual([
      [null, null, 1],
      ["accept", null, 1],
      ["reject", "mine", 1],
      ["reject", "not yet", 1],
    ]);
  });
});

describe("ticks", () => {
  test("the failed step is the first non-zero of the steps that fail a tick; compare's verdict is not the tick's", () => {
    expect(failedStepOf("recover=0 observe=0 report=0 compare=1 ask=0")).toBeNull();
    expect(failedStepOf("recover=0 observe=1 report=2 ask=1")).toBe("observe");
    expect(failedStepOf("recover=0 observe=0 report=0 compare=0 ask=1")).toBe("ask");
    expect(failedStepOf(null)).toBeNull();
  });

  test("a tick with no exit is running inside its budget and died past it", () => {
    const budget = 20 * 60_000;
    const started = (minutesAgo: number) => ({
      tick: 9,
      fireAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
      exitAt: null,
      ended: false,
      exit: null,
      detail: null,
      dryRun: true,
    });
    expect(tickStatusOf(started(5), NOW, budget)).toBe("running");
    expect(tickStatusOf(started(25), NOW, budget)).toBe("died");
    expect(tickStatusOf({ ...started(25), ended: true, exit: 0 }, NOW, budget)).toBe("ok");
    expect(tickStatusOf({ ...started(25), ended: true, exit: 1 }, NOW, budget)).toBe("failed");
    expect(tickStatusOf(undefined, NOW, budget)).toBe("unknown");
    // A tick the Mac slept through has its budget from the wake.
    // Its budget runs on awake time: a tick the Mac slept through mid-run is still running after the wake...
    expect(tickStatusOf(started(240), NOW, budget, () => ({ ms: 15 * 60_000, whole: true }))).toBe("running");
    // ...one that died days ago stays dead after a wake: its awake time since is long past the budget...
    expect(tickStatusOf(started(3 * 24 * 60), NOW, budget, () => ({ ms: 30 * H, whole: true }))).toBe("died");
    // ...one from before the plugin started is judged by wall time, not given a fresh budget at a reload...
    // ...and with no awake time at all, past its budget it is unknown, never called dead on a guess.
    expect(tickStatusOf(started(240), NOW, budget, () => ({ ms: 0, whole: false, blind: true }))).toBe("unknown");
    expect(tickStatusOf(started(5), NOW, budget, () => ({ ms: 0, whole: false, blind: true }))).toBe("running");
    expect(tickStatusOf(started(3 * 24 * 60), NOW, budget, () => ({ ms: 5 * 60_000, whole: false }))).toBe("died");
  });

  test("rows join the ledger with the reports, newest first, up to the limit", () => {
    const fold = foldLedger([
      { kind: "tick_fire", tick: 34, ts: at(1) },
      { kind: "runner_exit", tick: 34, ts: at(0.99), exit: 0, detail: "observe=0" },
      { kind: "tick_fire", tick: 35, ts: at(0.1) },
      { kind: "runner_exit", tick: 35, ts: at(0.09), exit: 1, detail: "recover=0 observe=0 report=1" },
    ]);
    const summary = summarizeReport(report(35, new Date(NOW - 0.1 * H)), "alpha", 35);
    const rows = tickRows(fold, new Map(summary ? [[35, summary]] : []), [33, 34, 35], NOW, 20 * 60_000, 2);
    expect(rows.map((row) => [row.tick, row.status, row.failedStep])).toEqual([
      [35, "failed", "report"],
      [34, "ok", null],
    ]);
    expect(rows[0]?.classCounts?.map((count) => `${count.count} ${count.name}`)).toEqual([
      "3 out of scope",
      "1 error",
      "1 unmanaged",
    ]);
    expect(rows[0]?.proposals).toBe(2);
    expect(rows[1]?.classCounts).toBeNull();
  });
});

describe("a report's proposals", () => {
  test("are what it would do other than nothing, for sessions in its own scope", () => {
    const summary = summarizeReport(report(35, new Date(NOW)), "alpha", 35);
    expect(summary?.proposals.map((proposal) => [proposal.session?.short, proposal.classId, proposal.action])).toEqual([
      ["22222222", "4", "report"],
      ["33333333", "10", "report only"],
    ]);
  });

  test("keep their key from tick to tick while the session, class and words stay, and change when any moves", () => {
    const key = proposalKey("22222222-bbbb", "4", "report");
    const later = summarizeReport(report(36, new Date(NOW)), "alpha", 36);
    expect(later?.proposals[0]?.key).toBe(key);
    expect(proposalKey("22222222-bbbb", "9", "report")).not.toBe(key);
    expect(proposalKey("22222222-bbbb", "4", "resume once")).not.toBe(key);
  });

  test("a report that is not an object, or has no sessions, proposes nothing and still counts", () => {
    expect(summarizeReport("torn", "alpha", 1)).toBeNull();
    const bare = summarizeReport({ tick: 3, class_counts: { "9a": 1, "2": 2, unknown: 1, "10": 4 } }, "alpha", 3);
    expect(bare?.proposals).toEqual([]);
    expect(bare?.classCounts.map((count) => count.id)).toEqual(["2", "9a", "10", "unknown"]);
    expect(
      summarizeReport({ sessions: [session("5555", "4", "report", { class: undefined })] }, "alpha", 7)?.tick,
    ).toBe(7);
  });
});

describe("a report's open asks", () => {
  test("are those still open, those new this tick and those it could not check, as report.md counts them", () => {
    const summary = summarizeReport(
      {
        tick: 4,
        asks_open: [{ id: "a1", key: "k1", first_tick: 2 }],
        asks: [
          { id: "a1", key: "k2" },
          { id: "a2", key: "k1" },
        ],
        asks_unchecked: [{ id: "a1", key: "k3", first_tick: 1 }, { id: "x" }],
      },
      "alpha",
      4,
    );
    expect(summary?.asksOpen.map((ask) => ask.key)).toEqual(["k1", "k2", "k3"]);
  });
});

describe("health", () => {
  const base = {
    disabled: false,
    scheduled: true,
    intervalMs: H,
    scheduledAt: NOW - 100 * H,
    // Awake the whole time, unless a test says how long it slept.
    awakeFor: awakeAsWall(NOW),
    now: NOW,
  };

  test("a scheduled scope with no tick for over 2 h is missed; under it, it is on time", () => {
    expect(healthOf({ ...base, latest: tick(35, "ok", 2.1) })).toMatchObject({
      status: "missed",
      reason: "No tick for 2h 6m: the last was tick 35. It runs every hour.",
      since: at(2.1),
    });
    expect(healthOf({ ...base, latest: tick(35, "ok", 1.9) })).toMatchObject({ status: "ok" });
  });

  test("only awake time counts, as launchd counts its interval: however the sleeps fall, 2 h awake is missed", () => {
    const slept = (sleptMs: number) => ({
      ...base,
      latest: tick(35, "ok", 9),
      awakeFor: (from: number) => ({ ms: NOW - from - sleptMs, whole: true }),
    });
    // 9 h since the last tick, 7.5 h of them asleep: 1.5 h awake, so launchd has had no fair chance to miss two.
    expect(healthOf(slept(7.5 * H)).status).toBe("ok");
    // 6.5 h asleep in short naps between meetings: 2.5 h awake, missed, and the reason says how much was sleep.
    expect(healthOf(slept(6.5 * H))).toMatchObject({
      status: "missed",
      reason: "No tick for 9h (2h 30m of it awake): the last was tick 35. It runs every hour.",
      notice: "No tick since tick 35. It runs every hour.",
    });
  });

  test("a longer interval stretches the threshold to two intervals", () => {
    expect(missedAfter(H)).toBe(2 * H);
    expect(missedAfter(3 * H)).toBe(6 * H);
    expect(healthOf({ ...base, intervalMs: 3 * H, latest: tick(35, "ok", 5) }).status).toBe("ok");
    expect(healthOf({ ...base, intervalMs: 3 * H, latest: tick(35, "ok", 7) }).status).toBe("missed");
  });

  test("a failed tick, or one that never finished, is failing; missed comes first, since nothing has run since", () => {
    const failed = tick(35, "failed", 0.5, { failedStep: "observe", steps: "recover=0 observe=1" });
    expect(healthOf({ ...base, latest: failed })).toMatchObject({
      status: "failing",
      reason: "Tick 35 failed at observe (recover=0 observe=1).",
    });
    expect(healthOf({ ...base, latest: tick(35, "died", 0.75) }).reason).toBe(
      "Tick 35 started 45m ago and never finished.",
    );
    expect(healthOf({ ...base, latest: { ...failed, at: at(3) } }).status).toBe("missed");
  });

  test("off by the kill switch, or unscheduled, never reads as missed", () => {
    expect(healthOf({ ...base, disabled: true, latest: tick(35, "failed", 30) }).status).toBe("off");
    const manual = { ...base, scheduled: false, intervalMs: null, scheduledAt: null };
    expect(healthOf({ ...manual, latest: tick(6, "ok", 40) })).toMatchObject({ status: "unscheduled" });
    // A tick run by hand that failed still says so.
    expect(healthOf({ ...manual, latest: tick(6, "failed", 40) }).status).toBe("failing");
  });

  test("a scheduled scope that never ticked is missed from when it was scheduled", () => {
    expect(healthOf({ ...base, scheduledAt: NOW - 3 * H, latest: null })).toMatchObject({
      status: "missed",
      reason: "No tick yet, 3h after it was scheduled. It runs every hour.",
    });
    expect(healthOf({ ...base, scheduledAt: NOW - H, latest: null }).status).toBe("ok");
  });

  test("spans read as people say them", () => {
    expect([span(45 * 60_000), span(3 * H + 12 * 60_000), span(2 * H), span(52 * H)]).toEqual([
      "45m",
      "3h 12m",
      "2h",
      "2d 4h",
    ]);
  });
});

describe("the fleet's work in Maestro", () => {
  test("the marker names the scope and what the item carries; a title without one is not the fleet's", () => {
    expect(markerOf("2 asks (tick 2) [fleet-reconcile broomva batch 2-1]")).toEqual({
      scope: "broomva",
      what: "batch",
      id: "2-1",
    });
    expect(markerOf("fleet sri: tick-observe [fleet-reconcile sri alert tick-observe]")).toMatchObject({
      what: "alert",
      id: "tick-observe",
    });
    expect(markerOf("[fleet-reconcile broomva batch 2-1] then more")).toBeNull();
    expect(markerOf("Persist transcripts")).toBeNull();
    // One grammar with shared/fleet-item.ts: what it is not a batch or an alert is not the fleet's work here.
    expect(markerOf("x [fleet-reconcile sri other 1]")).toBeNull();
  });

  test("the Fleet tab lists the fleet's work by the title a person reads, never its marker (BRO-2839)", () => {
    const raw = "1 ask (tick 7) [fleet-reconcile sri batch 7-3]";
    const shown = { ...work("w1", raw, "review"), display: { title: "The core comparison…", fleet: null } };
    expect(fleetItem(shown).title).toBe("The core comparison…");
    expect(fleetItem(work("w2", raw, "review")).title).toBe("1 ask (tick 7)");
  });

  test("a failing tick is covered by the fleet's own open alert for that step, and only by that", () => {
    const items = [
      work("w1", "fleet alpha: tick-observe [fleet-reconcile alpha alert tick-observe]", "review"),
      work("w2", "fleet alpha: lock [fleet-reconcile alpha alert lock]", "review"),
      work("w3", "fleet alpha: tick-report [fleet-reconcile alpha alert tick-report]", "done"),
      work("w4", "fleet beta: tick-report [fleet-reconcile beta alert tick-report]", "review"),
    ];
    const since = at(1);
    expect(coverOf("alpha", "failing", "observe", since, items)).toMatchObject({ item: { id: "w1" }, answered: false });
    // Closed before this failure began: an answer to an older one.
    expect(coverOf("alpha", "failing", "report", since, items)).toBeNull();
    expect(coverOf("alpha", "missed", null, since, items)?.item.id).toBe("w2");
    expect(coverOf("alpha", "failing", null, since, items)).toBeNull();
    expect(coverOf("alpha", "ok", null, since, items)).toBeNull();
  });

  test("each alert that stops ticks before they start covers a missed tick; a tick alert does not", () => {
    for (const kind of ["lock", "config", "statedir", "tick"]) {
      const items = [work("w", `fleet alpha: ${kind} [fleet-reconcile alpha alert ${kind}]`, "review")];
      expect(coverOf("alpha", "missed", null, at(3), items)?.item.id).toBe("w");
    }
    const observe = [work("w", "fleet alpha: tick-observe [fleet-reconcile alpha alert tick-observe]", "review")];
    expect(coverOf("alpha", "missed", null, at(3), observe)).toBeNull();
  });

  test("a missed tick is covered only by an open alert: an answer to one cause must not silence the next", () => {
    const answered = {
      ...work("w", "fleet alpha: lock [fleet-reconcile alpha alert lock]", "done"),
      updatedAt: at(0.5),
    };
    expect(coverOf("alpha", "missed", null, at(3), [answered])).toBeNull();
  });

  test("an alert you answered after the failure began counts as answered: the failure is yours already", () => {
    const answered = {
      ...work("w", "fleet alpha: tick-ask [fleet-reconcile alpha alert tick-ask]", "done"),
      updatedAt: at(0.5),
    };
    expect(coverOf("alpha", "failing", "ask", at(1), [answered])).toMatchObject({ item: { id: "w" }, answered: true });
    expect(coverOf("alpha", "failing", "ask", at(0.25), [answered])).toBeNull();
  });

  test("an open ask links to the open work raised for its batch, else to the item the ledger recorded", () => {
    const first = askBatch("alpha", 2, [{ id: "a1", key: "k1" }], "old-item");
    const second = askBatch("alpha", 7, [{ id: "a1", key: "k2" }]);
    const fold = foldLedger([...first.lines, ...second.lines]);
    const items = [
      work("open", "2 asks (tick 2) [fleet-reconcile alpha batch 2-3]", "review"),
      work("closed", "2 asks (tick 2) [fleet-reconcile alpha batch 2-3]", "done", "2026-09-30T10:00:00Z"),
      work("other", "1 ask (tick 2) [fleet-reconcile beta batch 2-3]", "review"),
    ];
    const asks = asksOf(
      "alpha",
      [
        { id: "a1", key: "k1", class: "count", first_tick: 2, question: "Is this right?" },
        { id: "a1", key: "k2", first_tick: 7, question: "And this?" },
        { id: "a9", key: "k9", question: "Not raised" },
        { id: "no-key" },
      ],
      fold,
      items,
    );
    expect(asks.map((ask) => [ask.key, ask.batch, ask.item?.id ?? null, ask.item?.needsYou ?? null])).toEqual([
      // The ledger recorded old-item, which Maestro no longer has: the open item under the batch's marker stands in.
      ["k1", "2-3", "open", true],
      ["k2", "7-3", null, null],
      ["k9", null, null, null],
    ]);
    // The item the ledger recorded comes first, even done, over any title that claims the batch.
    const spoof = work("spoof", "1 ask [fleet-reconcile alpha batch 2-3]", "review");
    const recorded = asksOf("alpha", [{ id: "a1", key: "k1" }], fold, [spoof, work("old-item", "renamed", "done")]);
    expect(recorded[0]?.item).toMatchObject({ id: "old-item", state: "done", needsYou: false });
  });
});

describe("reviews", () => {
  const proposal = summarizeReport(report(35, new Date(NOW)), "alpha", 35)?.proposals[0];
  if (!proposal) throw new Error("the fixture proposes nothing");

  test("the latest verdict on a key holds; other scopes, kinds, verdicts and writers are skipped", () => {
    const mine = { kind: REVIEW_KIND, scope: "alpha", by: "owner", via: "maestro" };
    const reviews = foldReviews(
      [
        { ...mine, key: "k", verdict: "accept", ts: at(2), tick: 33 },
        { ...mine, key: "k", verdict: "reject", note: "not this", ts: at(1), tick: 34 },
        { ...mine, scope: "beta", key: "k", verdict: "accept", ts: at(0.5) },
        { ...mine, kind: "ack", key: "k", verdict: "accept", ts: at(0.4) },
        { ...mine, key: "k", verdict: "maybe", ts: at(0.3) },
        // A line of another shape is not yours, whatever it says.
        { kind: REVIEW_KIND, scope: "alpha", key: "k", verdict: "accept", ts: at(0.2) },
        { ...mine, by: "tick", key: "k", verdict: "accept", ts: at(0.1) },
      ],
      "alpha",
    );
    expect([...reviews.entries()]).toEqual([["k", { verdict: "reject", note: "not this", at: at(1), tick: 34 }]]);
  });

  test("a record says what you decided about which proposal, as the fleet reads it, by you through Maestro", () => {
    const record = reviewRecord({ scope: "alpha", proposal, verdict: "reject", note: "  ", at: new Date(NOW), seq: 7 });
    expect(record).toEqual({
      v: 1,
      kind: REVIEW_KIND,
      id: `review-${NOW}-7`,
      scope: "alpha",
      key: proposal.key,
      verdict: "reject",
      note: null,
      tick: 35,
      proposal: {
        source: "report",
        action: "report",
        session_id: "22222222-bbbb",
        name: "session-2222",
        class: "4",
        class_name: "error",
        evidence: "evidence for 22222222",
        verb: null,
      },
      by: "owner",
      via: "maestro",
      ts: new Date(NOW).toISOString(),
    });
    expect(foldReviews([record], "alpha").get(proposal.key)?.verdict).toBe("reject");
  });
});

describe("drilling into a tick and an ask", () => {
  test("a tick's log lines run from its start line to its done line; tick 3 is never tick 35", () => {
    const log = [
      "[t] tick 3 scope alpha (dry_run=1)",
      "[t] step observe rc=1",
      "[t] tick 3 done: observe=1",
      "[t] tick 35 scope alpha (dry_run=1)",
      "[t] step observe rc=0",
      "[t] tick 36 scope alpha (dry_run=1)",
      "[t] tick 36 done: observe=0",
    ].join("\n");
    expect(tickLogSection(log, 3)).toBe(
      "[t] tick 3 scope alpha (dry_run=1)\n[t] step observe rc=1\n[t] tick 3 done: observe=1",
    );
    // One that never finished ends where the next tick starts.
    expect(tickLogSection(log, 35)).toBe("[t] tick 35 scope alpha (dry_run=1)\n[t] step observe rc=0");
    expect(tickLogSection(log, 5)).toBeNull();
  });

  test("an ask's session comes from its prompt key, named and opened through the report's sessions", () => {
    const sessions = new Map([["d4b991f0-1133", { name: "broomva-88", agentId: "agent-88" }]]);
    expect(askSession("prompt:d4b991f0-1133:3efecb94", sessions)).toEqual({
      id: "d4b991f0-1133",
      short: "d4b991f0",
      name: "broomva-88",
      agentId: "agent-88",
    });
    // A key that names the Paseo agent itself opens it.
    expect(askSession("prompt:agent-88:x", new Map())).toBeNull();
    expect(askSession("prompt:aaaaaaaa-88:x", new Map([["s", { name: "n", agentId: "aaaaaaaa-88" }]]))?.agentId).toBe(
      "aaaaaaaa-88",
    );
    expect(askSession("records-without-process", sessions)).toBeNull();
  });
});
