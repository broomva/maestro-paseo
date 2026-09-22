import { describe, expect, test } from "bun:test";
import {
  bullets,
  formatDuration,
  lookOf,
  parseEvents,
  pendingPermission,
  runningIntervals,
  scoreboard,
  section,
  verdictOf,
  type WorkEvent,
} from "./events";

const T0 = Date.parse("2026-09-22T08:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

const dispatched: WorkEvent = {
  ts: at(0),
  type: "dispatched",
  actor: "human",
  agentId: "a1",
  workspaceId: "w1",
  provider: "claude/sonnet",
  branch: "run/abc",
  cwd: "/tmp/wt",
};

const summary = [
  "All done.",
  "",
  "## Decided",
  "- Persist on the Run record, it survives restarts",
  "- Cover replay with tests",
  "",
  "## Ask",
  "Approve the branch so reviews stop needing the live session.",
].join("\n");

const toReview: WorkEvent[] = [
  { ts: at(0), type: "state", actor: "human", from: "proposed", to: "running", reason: null },
  dispatched,
  { ts: at(134), type: "turn.ended", actor: "agent", agentId: "a1", outcome: "completed", error: null, summary },
  { ts: at(134), type: "state", actor: "maestro", from: "running", to: "review", reason: null },
];

describe("the look at the gate", () => {
  test("pulls Decided and Ask out of the final message", () => {
    expect(section(summary, "Decided")).toContain("Persist on the Run record");
    expect(bullets(section(summary, "Decided") ?? "")).toEqual([
      "Persist on the Run record, it survives restarts",
      "Cover replay with tests",
    ]);
    const look = lookOf("review", toReview, T0 + 140 * 60_000);
    expect(look).toEqual({
      ran: "2h 14m unsupervised · 1 turn · ran to the gate",
      decided: ["Persist on the Run record, it survives restarts", "Cover replay with tests"],
      ask: "Approve the branch so reviews stop needing the live session.",
    });
  });

  test("a message without the sections still gives a usable ask", () => {
    const events = toReview.map((e) => (e.type === "turn.ended" ? { ...e, summary: "Finished." } : e));
    expect(lookOf("review", events, T0)).toMatchObject({
      decided: [],
      ask: "Approve to close it, or send it back with a note.",
    });
  });

  test("a pending permission becomes the ask", () => {
    const events: WorkEvent[] = [
      ...toReview.slice(0, 2),
      {
        ts: at(5),
        type: "permission.asked",
        actor: "agent",
        agentId: "a1",
        requestId: "p1",
        title: "Run rm",
        detail: "rm -rf build",
      },
      { ts: at(5), type: "state", actor: "agent", from: "running", to: "review", reason: "Asked for permission" },
    ];
    expect(pendingPermission(events)).toEqual({ requestId: "p1", title: "Run rm", detail: "rm -rf build" });
    expect(lookOf("review", events, T0 + 6 * 60_000)).toEqual({
      ran: "5m unsupervised · 0 turns · paused on a question",
      decided: [],
      ask: "Run rm: rm -rf build",
    });
    const resolved = [
      ...events,
      { ts: at(6), type: "permission.resolved", actor: "human", agentId: "a1", requestId: "p1" } as WorkEvent,
    ];
    expect(pendingPermission(resolved)).toBeNull();
  });

  test("only review work has a look", () => {
    expect(lookOf("running", toReview, T0)).toBeNull();
  });
});

describe("receipts", () => {
  test("verdict text never claims an approval that did not happen", () => {
    const checks: WorkEvent = {
      ts: at(10),
      type: "checks.finished",
      actor: "maestro",
      token: "t",
      results: [
        { name: "unit", run: "bun test", required: true, ok: true, exit: 0, durationMs: 1, timedOut: false, tail: "" },
        { name: "lint", run: "biome", required: true, ok: false, exit: 1, durationMs: 1, timedOut: false, tail: "" },
      ],
    };
    expect(verdictOf("review", [checks])).toBe("1 of 2 checks failed");
    expect(verdictOf("done", [checks])).toBe("1 of 2 checks failed");
    const approved: WorkEvent = { ts: at(11), type: "gate", actor: "human", verdict: "approve", note: "" };
    expect(verdictOf("done", [approved])).toBe("You approved");
    expect(verdictOf("canceled", [])).toBe("You canceled it");
  });

  test("parseEvents counts bad lines instead of dropping them silently", () => {
    const { events, bad } = parseEvents(`${JSON.stringify(dispatched)}\nnot json\n{"no":"ts"}\n`);
    expect(events).toHaveLength(1);
    expect(bad).toBe(2);
  });

  test("durations read as receipts", () => {
    expect(formatDuration(20_000)).toBe("under a minute");
    expect(formatDuration(45 * 60_000)).toBe("45m");
    expect(formatDuration(120 * 60_000)).toBe("2h");
    expect(formatDuration(230 * 60_000)).toBe("3h 50m");
  });
});

describe("unsupervised hours", () => {
  test("running time comes from state changes, open intervals run to now", () => {
    expect(runningIntervals(toReview, T0 + 999)).toEqual([[T0, T0 + 134 * 60_000]]);
    expect(runningIntervals(toReview.slice(0, 2), T0 + 5_000)).toEqual([[T0, T0 + 5_000]]);
  });

  test("overlapping runs count once, looks are human actions", () => {
    const dayStart = Date.parse("2026-09-22T00:00:00.000Z");
    const other: WorkEvent[] = [
      { ts: at(60), type: "state", actor: "human", from: "proposed", to: "running", reason: null },
      { ts: at(200), type: "state", actor: "maestro", from: "running", to: "review", reason: null },
      { ts: at(210), type: "gate", actor: "human", verdict: "approve", note: "" },
    ];
    const board = scoreboard([toReview, other], T0 + 300 * 60_000, dayStart);
    expect(board.unsupervisedMs).toBe(200 * 60_000);
    expect(board.longestRunMs).toBe(200 * 60_000);
    expect(board.looks).toBe(2);
    expect(board.live).toBe(false);
    expect(board.segments).toHaveLength(1);
    expect(board.notches).toHaveLength(2);
  });
});

test("bullets drop list markers and bold emphasis", () => {
  expect(bullets("- **File content**: exact\n2. plain")).toEqual(["File content: exact", "plain"]);
});

describe("receipts a person reads", () => {
  test("a state change right after its cause is folded in", async () => {
    const { toWireEvents } = await import("./events");
    const events: WorkEvent[] = [
      { ts: at(1), type: "permission.resolved", actor: "human", agentId: "a1", requestId: "p1" },
      { ts: at(1), type: "state", actor: "human", from: "review", to: "running", reason: "Permission answered" },
      { ts: at(2), type: "checks.finished", actor: "maestro", token: "t", results: [] },
      { ts: at(2), type: "state", actor: "maestro", from: "running", to: "blocked", reason: "Checks failed" },
    ];
    expect(toWireEvents(events).map((e) => e.text)).toEqual(["Permission answered", "Checks passed", "Stuck"]);
  });

  test("turn summaries drop the Decided and Ask sections and Markdown markers", async () => {
    const { plainSummary } = await import("./events");
    expect(plainSummary("Created `LICENSE.txt` with **care**.\n\n## Decided\n- x\n## Ask\ny")).toBe(
      "Created LICENSE.txt with care.",
    );
  });
});
