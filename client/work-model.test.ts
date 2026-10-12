import { describe, expect, test } from "bun:test";
import { needsOf } from "../server/needs";
import type { DecisionAsk } from "../shared/fleet";
import type { Initiative } from "../shared/initiatives";
import { askHoldKey, type Handled } from "../shared/needs";
import { runningOf } from "../shared/needs-you";
import { fakeWork } from "./fake-work";
import { homeBadges } from "./home-model";
import { LANES, NO_FILTERS, providerOf, runningLine, scopeLine, type WorkInput, workBoard } from "./work-model";

const NOW = Date.parse("2026-10-12T15:00:00.000Z");
const H = 3_600_000;
const live = (id: string) => ({ agentId: `agent-${id}`, workspaceId: "ws1" });
const quiet = {
  kind: "quiet" as const,
  reason: "Quiet for 808 minutes.",
  at: new Date(NOW - 808 * 60_000).toISOString(),
};
const yours = { kind: "yours" as const, reason: "Start it yourself.", at: "2026-10-12T09:00:00.000Z" };

const ask = (id: string, extra: Partial<DecisionAsk> = {}): DecisionAsk => ({
  ledger: "claude-code-mods.yaml",
  uid: null,
  id,
  hash: "0123456789abcdef",
  arc: null,
  headline: `Ask ${id}?`,
  question: null,
  stakes: null,
  whyYou: null,
  options: [{ id: "a", label: "A", consequence: null, reversible: true, recommended: true }],
  fallback: null,
  blocking: true,
  askedAt: new Date(NOW - 2 * H).toISOString(),
  answeredAt: null,
  answer: null,
  answerOption: null,
  state: "open",
  origin: null,
  refusal: null,
  home: { kind: "main", path: "/ctl", branch: null },
  batched: false,
  waiting: true,
  ...extra,
});

const review = {
  id: "skene",
  title: "skene",
  file: "skene.yaml",
  stale: { kind: "overdue", date: "2026-10-07" },
  waitingOn: [],
  sessions: [],
} as unknown as Initiative;

const items = [
  fakeWork("gate", "review", live("gate"), {
    project: "workspace",
    permission: { requestId: "r1", title: "Run a command", detail: "gh pr merge 933" },
  }),
  fakeWork("step", "proposed", null, { flag: yours, project: "sri" }),
  fakeWork("stuck", "blocked", live("stuck"), { project: "sri" }),
  fakeWork("run1", "running", live("run1"), {
    project: "sri",
    phase: "working",
    ticket: "STI-3684",
    initiative: "outlook",
    updatedAt: new Date(NOW - 40_000).toISOString(),
  }),
  fakeWork("run2", "running", live("run2"), { project: "holon", phase: "checking" }),
  fakeWork("stand", "running", live("stand"), { project: "sri", flag: quiet, ticket: "STI-3617" }),
  fakeWork("q1", "proposed", null, { project: "maestro-paseo", ticket: "BRO-2936" }),
  fakeWork("q2", "proposed", null, { project: "workspace", gate: "auto" }),
  fakeWork("done1", "done", live("done1"), { project: "maestro-paseo", ticket: "BRO-2980" }),
];
const asks = [ask("A3")];
const needs = needsOf({ items, asks, reviews: [review], landing: null, workspace: "broomva" }, NOW);
const handled: Handled = {
  rows: [
    {
      key: "work:done1",
      title: "Close leftover fleet items",
      closedBy: "gates",
      reason: "#47 merged by gates · checks 5/5",
      at: new Date(NOW - 3 * H).toISOString(),
    },
    {
      key: "work:old",
      title: "Loops ledger reads",
      closedBy: "you",
      reason: "#45 merged",
      at: new Date(NOW - 30 * H).toISOString(),
    },
    {
      key: "work:h3",
      title: "Eve reach",
      closedBy: "orchestrator",
      reason: "SRI Orchestrator: done",
      at: new Date(NOW - 5 * H).toISOString(),
    },
  ],
  today: { closedForYou: 2, byYou: 0, asksAnswered: 0 },
};
const input: WorkInput = { items, needs, handled, asks, filters: NO_FILTERS, now: NOW };
const laneOf = (board: ReturnType<typeof workBoard>, id: string) =>
  board.lanes.find((lane) => lane.id === id)?.cards ?? [];

describe("the five trays", () => {
  test("in order: Queued, Running, Standing, Needs you, Done", () => {
    expect(workBoard(input).lanes.map((lane) => lane.title)).toEqual([
      "Queued",
      "Running",
      "Standing",
      "Needs you",
      "Done",
    ]);
    expect(LANES.map((lane) => lane.id)).toEqual(["queued", "running", "standing", "needs", "done"]);
  });

  test("Needs you is needs.list's rows, every one, in their order: the header's number", () => {
    const needsYou = laneOf(workBoard(input), "needs");
    expect(needsYou.map((card) => card.key)).toEqual(needs.rows.map((row) => row.key));
    expect(needsYou).toHaveLength(needs.summary.total);
    // An approval, an ask and a review each say where they are handled; work only you may start is an owner step.
    const line = (key: string) => needsYou.find((card) => card.key === key)?.line;
    expect(line("work:gate")).toBe("approval: Run a command: gh pr merge 933");
    expect(line(askHoldKey(asks[0] as DecisionAsk))).toBe("ask A3 → in Decisions");
    expect(line("review:skene")).toBe("review due → in Initiatives");
    expect(line("work:step")).toBe("owner step");
  });

  test("Running and Standing split the running work, and Running is the Work tab's badge and J1's tile", () => {
    const board = workBoard(input);
    expect(laneOf(board, "running").map((card) => card.item?.id)).toEqual(["run1", "run2"]);
    expect(laneOf(board, "standing").map((card) => card.item?.id)).toEqual(["stand"]);
    expect(laneOf(board, "running")).toHaveLength(runningOf(items).length);
    expect(homeBadges(needs, runningOf(items).length, 0).work?.count).toBe(laneOf(board, "running").length);
    // Between them, every running item is in a tray exactly once.
    expect(laneOf(board, "running").length + laneOf(board, "standing").length).toBe(
      items.filter((item) => item.state === "running").length,
    );
  });

  test("only Running wears the Undertow, only Standing the pulse (JE rule 9)", () => {
    const board = workBoard(input);
    expect(board.lanes.flatMap((lane) => lane.cards.filter((card) => card.running).map((card) => lane.id))).toEqual([
      "running",
      "running",
    ]);
    expect(board.lanes.flatMap((lane) => lane.cards.filter((card) => card.standing).map((card) => lane.id))).toEqual([
      "standing",
    ]);
  });

  test("Queued holds what a lane or you start, never held work; stuck work is in no tray (it is Health's)", () => {
    const board = workBoard(input);
    expect(laneOf(board, "queued").map((card) => [card.item?.id, card.line])).toEqual([
      ["q1", "gate: you"],
      ["q2", "a lane starts it next"],
    ]);
    const keys = board.lanes.flatMap((lane) => lane.cards.map((card) => card.key));
    expect(keys).not.toContain("work:stuck");
    expect(keys.filter((key) => key === "work:step")).toHaveLength(1);
  });

  test("a running card says its phase, who runs it and how long since it moved; a standing one says how long it was quiet", () => {
    const board = workBoard(input);
    expect(laneOf(board, "running")[0]?.line).toBe("working · claude · now");
    expect(runningLine(items[4] as never, NOW)).toMatch(/^checking · claude · /);
    expect(laneOf(board, "standing")[0]?.line).toBe("quiet 13h → in Health");
  });

  test("Done is the last 24 h, each with who closed it and why", () => {
    const done = laneOf(workBoard(input), "done");
    expect(done.map((card) => [card.title, card.chip?.word])).toEqual([
      ["Close leftover fleet items", "gates"],
      ["Eve reach", "orchestrator"],
    ]);
    expect(done[0]?.line).toBe("#47 merged by gates · checks 5/5");
    expect(done[0]?.select).toEqual({ kind: "work", id: "done1" });
  });
});

describe("the filters narrow the trays, never the counts the tabs say", () => {
  test("the initiative and the provider keep the work that names them; a hold that is not work has no provider", () => {
    const outlook = workBoard({ ...input, filters: { ...NO_FILTERS, initiative: "outlook" } });
    expect(outlook.lanes.flatMap((lane) => lane.cards.map((card) => card.item?.id))).toEqual(["run1"]);
    const claude = workBoard({ ...input, filters: { ...NO_FILTERS, provider: "claude" } });
    expect(laneOf(claude, "needs").map((card) => card.key)).toEqual(["work:gate"]);
    expect(providerOf(items[3] as never)).toBe("claude");
    expect(workBoard(input).providers).toEqual(["claude"]);
    expect(workBoard(input).initiatives).toEqual(["outlook"]);
  });

  test("the workspace is the header's menu: holds by their scope, work by its own", () => {
    const sri = workBoard({ ...input, filters: { ...NO_FILTERS, workspace: "sri" } });
    expect(laneOf(sri, "needs").every((card) => card.kicker[0] === "sri")).toBe(true);
    expect(laneOf(sri, "running").map((card) => card.item?.id)).toEqual(["run1"]);
  });

  test("the search keeps cards whose words match; the line says how many are in scope", () => {
    const found = workBoard({ ...input, filters: { ...NO_FILTERS, query: "BRO-2936" } });
    expect(found.lanes.flatMap((lane) => lane.cards.map((card) => card.key))).toEqual(["work:q1"]);
    expect(scopeLine(found)).toBe("1 work item in scope · Done shows the last 24 h");
    expect(scopeLine(workBoard(input))).toBe(
      `${workBoard(input).inScope} work items in scope · Done shows the last 24 h`,
    );
  });

  test("nothing is read yet: empty trays, never a number made up", () => {
    const board = workBoard({ ...input, items: [], needs: null, handled: null, asks: [] });
    expect(board.lanes.every((lane) => lane.cards.length === 0)).toBe(true);
    expect(board.inScope).toBe(0);
  });
});
