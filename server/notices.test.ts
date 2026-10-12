import { describe, expect, test } from "bun:test";
import { fakeWork } from "../client/fake-work";
import type { Initiative } from "../shared/initiatives";
import type { LoopNotice } from "../shared/loops";
import type { TimelineNotice } from "../shared/timeline";
import { noticesOf } from "./notices";

const NOW = Date.parse("2026-10-12T15:00:00.000Z");
const live = { agentId: "agent-1", workspaceId: "ws1" };
const quietFlag = {
  kind: "quiet" as const,
  reason: "Quiet for 808 minutes, worth a look.",
  at: "2026-10-12T01:00:00.000Z",
};

const review = (id: string, date: string): Initiative =>
  ({
    id,
    title: id,
    file: `${id}.yaml`,
    stale: { kind: "overdue", date },
    waitingOn: [],
    sessions: [],
  }) as unknown as Initiative;

const empty = { items: [], fleet: [], timeline: [], loops: [], reviews: [], snoozed: new Map<string, string>() };

describe("notices.list", () => {
  test("stuck work is a notice with what closes it, and its verb is Unblock", () => {
    const stuck = fakeWork("s1", "blocked", live, {
      project: "sri",
      reason: "Session ended mid-turn",
      adoptedBy: { by: "SRI Orchestrator" },
    });
    const [row] = noticesOf({ ...empty, items: [stuck] }, NOW).rows;
    expect(row).toMatchObject({
      key: "work:s1",
      kind: "stuck",
      scope: "sri",
      detail: "Session ended mid-turn",
      verb: { id: "unblock" },
      link: { kind: "work", id: "s1" },
    });
    expect(row?.closesWhen.map((close) => close.becomes)).toEqual(["Running", "Handled for you", "Canceled"]);
  });

  test("a quiet run is standing work's notice: it closes with its next turn, and Snooze is its verb", () => {
    const quiet = fakeWork("q1", "running", live, { flag: quietFlag });
    const running = fakeWork("r1", "running", live);
    const { rows } = noticesOf({ ...empty, items: [quiet, running] }, NOW);
    expect(rows.map((row) => [row.key, row.kind, row.verb.label])).toEqual([["quiet:q1", "quiet", "Snooze 4h"]]);
    expect(rows[0]?.detail).toBe("Quiet for 808 minutes, worth a look.");
  });

  test("a failed or missed scheduled run, a fleet tick and loop drift each have their kind and where they open", () => {
    const timeline: TimelineNotice = {
      id: "launchd:com.broomva.kg",
      kind: "launchd",
      name: "kg-compile",
      status: "failed",
      reason: "exit 1",
      since: "2026-10-12T10:00:00.000Z",
    };
    const fleet = {
      scope: "sri",
      status: "missed" as const,
      reason: "No tick for 3 h",
      since: "2026-10-12T09:00:00.000Z",
    };
    const loop: LoopNotice = {
      id: "x#unregistered",
      subject: "x",
      loop: "coordinator-tick",
      kind: "unregistered" as never,
      detail: "absent from Paseo heartbeats",
      fix: "a heartbeat named coordinator-tick exists",
    };
    const { rows, summary } = noticesOf({ ...empty, timeline: [timeline], fleet: [fleet], loops: [loop] }, NOW);
    expect(rows.map((row) => [row.kind, row.scope, row.link.kind])).toEqual([
      ["schedule", "fleet", "fleet"],
      ["schedule", "launchd", "timeline"],
      ["loop", "coordinator-tick", "loops"],
    ]);
    expect(rows[2]?.closesWhen).toEqual([{ when: "a heartbeat named coordinator-tick exists", becomes: "Healthy" }]);
    expect(summary).toEqual({
      total: 3,
      snoozed: 0,
      unread: [],
      byKind: { stuck: 0, quiet: 0, schedule: 2, loop: 1, initiative: 0 },
    });
  });

  test("initiatives past their review date are one notice, counted, oldest first; none is none", () => {
    const { rows } = noticesOf({ ...empty, reviews: [review("a", "2026-10-08"), review("b", "2026-10-07")] }, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: "initiatives:due",
      kind: "initiative",
      title: "2 initiatives are past their review date",
      verb: { id: "open-initiatives" },
    });
    expect(rows[0]?.detail).toBe("b since 2026-10-07");
    expect(noticesOf({ ...empty, reviews: [review("a", "2026-10-08")] }, NOW).rows[0]?.title).toBe(
      "1 initiative is past its review date",
    );
    expect(noticesOf(empty, NOW).rows).toEqual([]);
  });

  test("a snooze of a quiet run does not hide the stuck notice that run becomes", () => {
    const snoozed = new Map([["quiet:q1", new Date(NOW + 3_600_000).toISOString()]]);
    const stuck = fakeWork("q1", "blocked", null, { reason: "Checks failed" });
    expect(noticesOf({ ...empty, items: [stuck], snoozed }, NOW).rows.map((row) => row.kind)).toEqual(["stuck"]);
  });

  test("a source that could not be read is named, so a missing notice is not read as none", () => {
    expect(noticesOf({ ...empty, unread: ["the loops"] }, NOW).summary).toMatchObject({
      total: 0,
      unread: ["the loops"],
    });
    expect(noticesOf(empty, NOW).summary.unread).toEqual([]);
  });

  test("a snoozed notice is left out until its time is up, and is counted apart", () => {
    const quiet = fakeWork("q1", "running", live, { flag: quietFlag });
    const snoozed = new Map([["quiet:q1", new Date(NOW + 3_600_000).toISOString()]]);
    expect(noticesOf({ ...empty, items: [quiet], snoozed }, NOW)).toMatchObject({
      rows: [],
      summary: { total: 0, snoozed: 1 },
    });
    // Its time is up: it is back, and nothing is counted as snoozed.
    expect(noticesOf({ ...empty, items: [quiet], snoozed }, NOW + 3_600_001)).toMatchObject({
      summary: { total: 1, snoozed: 0 },
    });
  });

  test("oldest first, an unknown age last, ties by key: one order for equal input, whatever order it arrives in", () => {
    const old = fakeWork("a", "blocked", live, { updatedAt: "2026-10-12T01:00:00.000Z" });
    const newer = fakeWork("b", "blocked", live, { updatedAt: "2026-10-12T09:00:00.000Z" });
    const loop: LoopNotice = { id: "l", subject: "l", loop: "l", kind: "unregistered" as never, detail: "d", fix: "f" };
    const input = { ...empty, items: [newer, old], loops: [loop] };
    const order = (value: typeof input) => noticesOf(value, NOW).rows.map((row) => row.key);
    expect(order(input)).toEqual(["work:a", "work:b", "loop:l"]);
    expect(order({ ...input, items: [old, newer] })).toEqual(["work:a", "work:b", "loop:l"]);
  });

  test("a source listed twice counts once", () => {
    const stuck = fakeWork("s1", "blocked", live);
    expect(noticesOf({ ...empty, items: [stuck, stuck] }, NOW).summary.total).toBe(1);
  });

  test("a notice is never a hold: no key is one needs.list holds for the same thing twice (the quiet run is not an approval)", () => {
    const quiet = fakeWork("q1", "running", live, { flag: quietFlag });
    expect(noticesOf({ ...empty, items: [quiet] }, NOW).rows.every((row) => row.kind !== "stuck")).toBe(true);
  });
});
