import { describe, expect, test } from "bun:test";
import type { WorkItem } from "../shared/contracts";
import type { FleetTick } from "../shared/fleet";
import { groupOf, type OrchState } from "../shared/states";
import { askBatch, H, report, session } from "./fake-fleet";
import {
  actProposals,
  asksOf,
  coverOf,
  failedStepOf,
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

  test("folds each tick's start and exit, and an exit record with no code reads as no code", () => {
    const fold = foldLedger([
      { kind: "tick_fire", tick: 1, ts: at(3), dry_run: true },
      { kind: "runner_exit", tick: 1, ts: at(2.9), detail: "observe=0 report=0" },
      { kind: "tick_fire", tick: 2, ts: at(2) },
      { kind: "runner_exit", tick: 2, ts: at(1.9), exit: 1, detail: "recover=0 observe=1" },
      { kind: "tick_fire", tick: 3, ts: at(1) },
    ]);
    expect(fold.ticks.get(1)).toMatchObject({ ended: true, exit: null, dryRun: true });
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
        key: "drv:alpha:ws#9",
        dry_run: true,
        tick: 5,
        target: { repo: "o/ws", pr: 9, role: "driver" },
      },
      {
        kind: "done",
        of: "5-1",
        verb: "spawn",
        key: "drv:alpha:ws#9",
        dry_run: true,
        tick: 5,
        ts: at(1),
        result: { would: true },
      },
      { kind: "intent", id: "5-2", verb: "label", key: "lbl", dry_run: false, tick: 5, target: {} },
      { kind: "done", of: "5-2", verb: "label", key: "lbl", dry_run: false, tick: 5 },
      { kind: "intent", id: "5-3", verb: "mail", key: "mail:x", dry_run: true, tick: 5, target: {} },
      { kind: "failed", of: "5-3", verb: "mail", key: "mail:x", dry_run: true, tick: 5 },
    ]);
    expect(fold.dryActs).toEqual([
      { verb: "spawn", key: "drv:alpha:ws#9", tick: 5, at: at(1), target: { repo: "o/ws", pr: 9, role: "driver" } },
    ]);
    expect(actProposals(fold.dryActs, null)).toMatchObject([
      {
        key: "act:spawn:drv:alpha:ws#9",
        source: "act",
        action: "spawn o/ws #9",
        evidence: "role driver",
        verb: "spawn",
      },
    ]);
    expect(actProposals(fold.dryActs, 6)).toEqual([]);
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

describe("health", () => {
  const base = {
    disabled: false,
    scheduled: true,
    intervalMs: H,
    scheduledAt: NOW - 100 * H,
    awakeSince: null,
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

  test("the time the Mac slept does not count: missed only 2 h after it woke with no tick", () => {
    const slept = { ...base, latest: tick(35, "ok", 9) };
    expect(healthOf({ ...slept, awakeSince: NOW - 1.5 * H }).status).toBe("ok");
    expect(healthOf({ ...slept, awakeSince: NOW - 2.5 * H }).status).toBe("missed");
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
  });

  test("a failing tick is covered by the fleet's own open alert for that step, and only by that", () => {
    const items = [
      work("w1", "fleet alpha: tick-observe [fleet-reconcile alpha alert tick-observe]", "review"),
      work("w2", "fleet alpha: lock [fleet-reconcile alpha alert lock]", "review"),
      work("w3", "fleet alpha: tick-report [fleet-reconcile alpha alert tick-report]", "done"),
      work("w4", "fleet beta: tick-report [fleet-reconcile beta alert tick-report]", "review"),
    ];
    expect(coverOf("alpha", "failing", "observe", items)?.id).toBe("w1");
    expect(coverOf("alpha", "failing", "report", items)).toBeNull();
    expect(coverOf("alpha", "missed", null, items)?.id).toBe("w2");
    expect(coverOf("alpha", "failing", null, items)).toBeNull();
    expect(coverOf("alpha", "ok", null, items)).toBeNull();
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
      ["k1", "2-3", "open", true],
      ["k2", "7-3", null, null],
      ["k9", null, null, null],
    ]);
    // With the open one gone, the ledger's recorded item stands, even when it is done.
    const recorded = asksOf("alpha", [{ id: "a1", key: "k1" }], fold, [work("old-item", "renamed", "done")]);
    expect(recorded[0]?.item).toMatchObject({ id: "old-item", state: "done", needsYou: false });
  });
});

describe("reviews", () => {
  const proposal = summarizeReport(report(35, new Date(NOW)), "alpha", 35)?.proposals[0];
  if (!proposal) throw new Error("the fixture proposes nothing");

  test("the latest verdict on a key holds; other scopes, other kinds and bad verdicts are skipped", () => {
    const reviews = foldReviews(
      [
        { kind: REVIEW_KIND, scope: "alpha", key: "k", verdict: "accept", ts: at(2), tick: 33 },
        { kind: REVIEW_KIND, scope: "alpha", key: "k", verdict: "reject", note: "not this", ts: at(1), tick: 34 },
        { kind: REVIEW_KIND, scope: "beta", key: "k", verdict: "accept", ts: at(0.5) },
        { kind: "ack", scope: "alpha", key: "k", verdict: "accept", ts: at(0.4) },
        { kind: REVIEW_KIND, scope: "alpha", key: "k", verdict: "maybe", ts: at(0.3) },
      ],
      "alpha",
    );
    expect([...reviews.entries()]).toEqual([["k", { verdict: "reject", note: "not this", at: at(1), tick: 34 }]]);
  });

  test("a record says what you decided about which proposal, as the fleet reads it, by you through Maestro", () => {
    const record = reviewRecord({ scope: "alpha", proposal, verdict: "reject", note: "  ", at: new Date(NOW) });
    expect(record).toEqual({
      v: 1,
      kind: REVIEW_KIND,
      id: `review-${NOW}`,
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
