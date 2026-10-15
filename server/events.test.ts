import { describe, expect, test } from "bun:test";
import { UNDO_MS } from "../shared/undo";
import {
  ARCHIVED_NOTE,
  adoptedByOf,
  arcStatus,
  bullets,
  closedOf,
  closingAbove,
  type FlaggedEvent,
  flagOf,
  formatDuration,
  handsBack,
  keptSummary,
  lastActivityOf,
  lookOf,
  parseEvents,
  pendingPermission,
  runningIntervals,
  SUMMARY_MAX,
  scoreboard,
  section,
  toWireEvents,
  verdictOf,
  type WorkEvent,
  workerOf,
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
      arc: null,
      closing: null,
      archived: false,
      handed: null,
    });
  });

  test("a message that asks nothing gets no invented ask: its last words are what the card shows", () => {
    const said = "Ran the suite.\n\nAll 40 pass; the branch is pushed.";
    const events = toReview.map((e) => (e.type === "turn.ended" ? { ...e, summary: said } : e));
    expect(lookOf("review", events, T0)).toMatchObject({ decided: [], ask: "", closing: said, handed: null });
  });

  test("a turn hands something back by a verdict line, an ask or a ⛔ block; a mention of the grammar is not one", () => {
    for (const text of [
      "Merged.\n\nARC-STATUS: CLOSED",
      "Checks done.\n\n**ARC-STATUS:** done with handback.",
      "Checks done.\n\n*ARC-STATUS*: DONE",
      "Built it.\n\n## Ask\n- Merge #12?",
      "## ⛔ Blocked on you — 1 item\n\n| 1 | Merge #12 |",
    ]) {
      expect(handsBack(text)).toBe(true);
    }
    for (const text of [
      "Adding `referrerSample` to the catalog card schema, then the app card.",
      "The hook reads `ARC-STATUS:` lines; continuing the implementation.",
      "> ARC-STATUS: CLOSED is what the brief asks for at the end. Continuing.",
      "- ARC-STATUS: the grammar ctx-core reads. Next, the approval route.",
      "The ARC-STATUS grammar is ctx-core's; next, the approval route.",
      "ARC-STATUS: lines are what the stop hook reads; continuing.",
      "Its stop hook reads this:\n\n    ARC-STATUS: CLOSED\n\nNext, the approval route.",
    ]) {
      expect(handsBack(text)).toBe(false);
    }
    // ctx-core reads a line that starts `ARC-STATUS: WORD` wherever it sits, a fence included (ctx.py
    // _extract_arc), and the session's own stop hook takes it as its verdict: Maestro reads it the same way.
    expect(handsBack("Example:\n```\nARC-STATUS: CLOSED\n```")).toBe(true);
  });

  test("a heading or a dressed verdict the session only quotes or mentions hands nothing back", () => {
    for (const text of [
      "The brief ends like this:\n```\n## Ask\n- Merge #12?\n```\nNext, the approval route.",
      "The template opens with:\n~~~md\n## ⛔ Blocked on you — 1 item\n~~~\nContinuing.",
      "**ARC-STATUS:** is what the hook reads; continuing…",
      "The verdict goes last:\n```\n**ARC-STATUS:** done\n```",
      "**ARC-STATUS:** HANDBACK was the old form.\n\nNext, the approval route.",
      // A message cut inside a fence ends in the fence: its last line is still quoted, not said.
      "The verdict goes last, like this:\n```md\n**ARC-STATUS:** DONE",
    ]) {
      expect(handsBack(text)).toBe(false);
    }
    // The same forms, said and not quoted, still hand back.
    expect(handsBack("Done.\n\n## Ask\n- Merge #12?")).toBe(true);
    expect(handsBack("Checks done.\n\n**ARC-STATUS:** HANDBACK 2")).toBe(true);
  });

  test("a long handback keeps its ask when its turn's text is cut, so it still lands and shows what it asked", () => {
    const receipt = Array.from({ length: 400 }, (_, i) => `${i + 1}. A receipt line about the work done.`).join("\n");
    const table =
      "| # | Ask | Unblocks | If you say nothing |\n|---|---|---|---|\n| 1 | Merge #12 | deploy | it waits |";
    const text = ["## ⛔ Blocked on you — 1 item, ~1 min", "", table, "", "## 📋 Receipt", "", receipt].join("\n");
    expect(text.length).toBeGreaterThan(SUMMARY_MAX);
    const kept = keptSummary(text);
    expect(handsBack(kept)).toBe(true);
    expect(kept.startsWith("## ⛔ Blocked on you — 1 item, ~1 min")).toBe(true);
    expect(kept.endsWith("400. A receipt line about the work done.")).toBe(true);
    const events = toReview.map((e) => (e.type === "turn.ended" ? { ...e, summary: kept } : e));
    expect(lookOf("review", events, T0)).toMatchObject({ ask: "⛔ Blocked on you — 1 item, ~1 min", handed: table });
    // One that is cut but asked nothing is kept as its end, as before.
    expect(keptSummary(receipt).includes("Blocked on you")).toBe(false);
  });

  test("a handback's ⛔ block is the ask, its table verbatim, and its words are not repeated as last words", () => {
    const table =
      "| # | ask | unblocks | if you say nothing |\n|---|---|---|---|\n| 1 | Merge #12 | deploy | it waits |";
    const said = ["## ⛔ Blocked on you — 1 item, ~2 min", "", table, "", "## ✅ Shipped", "- the fix"].join("\n");
    const events = toReview.map((e) => (e.type === "turn.ended" ? { ...e, summary: said } : e));
    expect(lookOf("review", events, T0)).toMatchObject({
      ask: "⛔ Blocked on you — 1 item, ~2 min",
      handed: table,
      closing: null,
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

describe("who asked", () => {
  const bySession: WorkEvent = { ...dispatched, actor: "agent", by: "5e55107a-0000-4000-8000-000000000000" };

  test("a session starting work is not you stepping in", () => {
    const dayStart = Date.parse("2026-09-22T00:00:00.000Z");
    const run = (event: WorkEvent) => [
      { ts: at(0), type: "state", actor: event.actor, from: "proposed", to: "running", reason: null } as WorkEvent,
      event,
    ];
    expect(scoreboard([run(bySession)], T0 + 60 * 60_000, dayStart).looks).toBe(0);
    expect(scoreboard([run(dispatched)], T0 + 60 * 60_000, dayStart).looks).toBe(1);
  });

  test("receipts name the session that asked, and nothing for you", async () => {
    const { toWireEvent } = await import("./events");
    expect(toWireEvent(bySession)?.detail).toBe("claude/sonnet on run/abc by session 5e55107a");
    expect(toWireEvent({ ...bySession, by: null })?.detail).toBe("claude/sonnet on run/abc by a session");
    expect(toWireEvent(dispatched)?.detail).toBe("claude/sonnet on run/abc");
    expect(toWireEvent({ ts: at(0), type: "created", actor: "human" })?.detail).toBeNull();
  });
});

describe("the loop's flag", () => {
  const flagged = (minutes: number, kind: "yours" | "failed" | "quiet" = "quiet"): FlaggedEvent => ({
    ts: at(minutes),
    type: "loop.flagged",
    actor: "maestro",
    kind,
    reason: `flagged at ${minutes}`,
  });
  const after: WorkEvent[] = [
    { ts: at(40), type: "turn.started", actor: "agent", agentId: "a1" },
    { ts: at(40), type: "state", actor: "agent", from: "running", to: "review", reason: null },
    { ts: at(40), type: "note", actor: "maestro", text: "Dispatch failed: boom" },
    { ...dispatched, ts: at(40) },
  ];

  test("is the latest flag, while nothing but another flag follows it", () => {
    expect(flagOf([])).toBeNull();
    expect(flagOf([dispatched])).toBeNull();
    expect(flagOf([dispatched, flagged(30)])).toEqual(flagged(30));
    expect(flagOf([dispatched, flagged(30), flagged(31, "failed")])).toEqual(flagged(31, "failed"));
    for (const event of after) expect(flagOf([dispatched, flagged(30), event])).toBeNull();
  });

  test("is not activity: the work's last activity skips it", () => {
    expect(lastActivityOf([dispatched, flagged(30), flagged(31)])).toEqual(dispatched);
    expect(lastActivityOf([flagged(30)])).toBeNull();
    expect(lastActivityOf([dispatched, flagged(30), ...after])).toEqual({ ...dispatched, ts: at(40) });
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

  // BRO-2839: excerpts as the dogfood saw them, pipe rows, links and a summary cut mid-word.
  test("a turn's receipt reads as prose: a table as its header, links as their text, cut at a word", async () => {
    const { toWireEvent } = await import("./events");
    const summary = [
      "Yes, there are two now. I checked, and they don't overlap:",
      "",
      "| Orchestrator | Scope | What it's driving now |",
      "|---|---|---|",
      "| f5307ce7 (me) | every broomva/* repo | [BRO-2830](https://linear.app/x/BRO-2830) |",
      "",
      `Upgrades are tracked in **[BRO-2830](https://linear.app/x/BRO-2830)**. ${"More words follow here. ".repeat(20)}`,
      "## Decided",
      "- nothing",
    ].join("\n");
    const ended: WorkEvent = {
      ts: at(1),
      type: "turn.ended",
      actor: "agent",
      agentId: "a1",
      outcome: "completed",
      error: null,
      summary,
      turnId: "t1",
    };
    const detail = toWireEvent(ended)?.detail ?? "";
    expect(
      detail.startsWith("Yes, there are two now. I checked, and they don't overlap: (table: Orchestrator, Scope,"),
    ).toBe(true);
    expect(detail).toContain("Upgrades are tracked in BRO-2830.");
    expect(detail).not.toMatch(/[|*[\]]/);
    expect(detail.length).toBeLessThanOrEqual(280);
    expect(detail.endsWith("\u2026")).toBe(true);
    expect(detail.slice(0, -1).endsWith(" ")).toBe(false);
    // The excerpt's last word is whole: in the summary it is followed by a space or a stop.
    const tail = detail.slice(-12, -1);
    expect(/[\s.]/.test(summary.charAt(summary.indexOf(tail) + tail.length))).toBe(true);
  });

  test("a summary an older daemon cut at its limit mid-word starts at its first whole word, marked", async () => {
    const { plainSummary, SUMMARY_MAX } = await import("./events");
    const cut = `t ignores major-version bumps from now on. ${"Failing majors closed. ".repeat(400)}`.slice(
      0,
      SUMMARY_MAX,
    );
    expect(cut.length).toBe(SUMMARY_MAX);
    expect(plainSummary(cut).startsWith("\u2026 ignores major-version bumps")).toBe(true);
    // A shorter summary is whole: its first word stays.
    expect(plainSummary("t is a word here.")).toBe("t is a word here.");
  });

  test("a turn's kept text is its end, starting at a line or word with …, so its sections still parse", async () => {
    const { latestOutputText } = await import("./engine");
    const { section, SUMMARY_MAX } = await import("./events");
    const long = `${"Dependabot ignores major-version bumps from now on. ".repeat(200)}\n## Decided\n- kept it small\n## Ask\nShip it?`;
    const kept = latestOutputText([
      { type: "user_message", text: "go" },
      { type: "assistant_message", text: long },
    ]);
    expect(kept.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(kept.startsWith("\u2026 Dependabot ignores")).toBe(true);
    expect(section(kept, "Decided")).toBe("- kept it small");
    expect(section(kept, "Ask")).toBe("Ship it?");
    // Short text is kept exactly as written.
    expect(latestOutputText([{ type: "assistant_message", text: " Done.\n## Ask\nShip it " }])).toBe(
      "Done.\n## Ask\nShip it",
    );
  });

  test("the look's bullets read as plain words, a link as text (host); globs and names stay", () => {
    expect(bullets("- Closed **all 6** in [BRO-2830](https://x.y/z)\n- `ctx` _registered_")).toEqual([
      "Closed all 6 in BRO-2830 (x.y)",
      "ctx _registered_",
    ]);
    expect(bullets("- Edited `src/*.ts` and `__init__.py`")).toEqual(["Edited src/*.ts and __init__.py"]);
    expect(bullets("- Edited src/*.ts and lib/*.js\n- Renamed __init__ to __main__")).toEqual([
      "Edited src/*.ts and lib/*.js",
      "Renamed __init__ to __main__",
    ]);
  });

  test("a summary that was not cut is shown whole, whatever its length", async () => {
    const { plainSummary, SUMMARY_MAX } = await import("./events");
    const longer = `t starts lowercase and runs on. ${"More words. ".repeat(800)}`;
    expect(longer.length).toBeGreaterThan(SUMMARY_MAX);
    expect(plainSummary(longer).startsWith("t starts lowercase")).toBe(true);
    const exact = `The message starts as a sentence. ${"More words. ".repeat(800)}`.slice(0, SUMMARY_MAX);
    expect(plainSummary(exact).startsWith("The message starts")).toBe(true);
  });
});

describe("a decision inside its undo window", () => {
  const made: WorkEvent = {
    ts: at(10),
    type: "gate.pending",
    actor: "human",
    verdict: "approve",
    note: "",
    token: "d1",
    effectiveAt: new Date(T0 + 10 * 60_000 + UNDO_MS).toISOString(),
  };

  test("is pending until it is applied, undone or dropped, by its own token", async () => {
    const { pendingDecision, decisionApplied } = await import("./events");
    expect(pendingDecision([...toReview, made])).toMatchObject({ token: "d1", verdict: "approve", decidedAt: at(10) });
    const applied: WorkEvent = { ts: at(11), type: "gate", actor: "human", verdict: "approve", note: "", token: "d1" };
    const undone: WorkEvent = { ts: at(11), type: "gate.undone", actor: "human", verdict: "approve", token: "d1" };
    const dropped: WorkEvent = {
      ts: at(11),
      type: "gate.dropped",
      actor: "maestro",
      verdict: "approve",
      token: "d1",
      reason: "x",
    };
    for (const settled of [applied, undone, dropped]) expect(pendingDecision([made, settled])).toBeNull();
    // Another decision's settlement does not settle this one.
    expect(pendingDecision([made, { ...undone, token: "other" }])?.token).toBe("d1");
    expect(decisionApplied([made, applied])).toBe(true);
    expect(decisionApplied([made, undone])).toBe(false);
    expect(decisionApplied([made])).toBe(false);
  });

  test("the look counts when you decide, once, and an applied decision is not a second look", () => {
    const dayStart = Date.parse("2026-09-22T00:00:00.000Z");
    const applied: WorkEvent = { ts: at(11), type: "gate", actor: "human", verdict: "approve", note: "", token: "d1" };
    const board = (events: WorkEvent[]) => scoreboard([events], T0 + 60 * 60_000, dayStart);
    const base = board(toReview).looks;
    expect(board([...toReview, made]).looks).toBe(base + 1);
    expect(board([...toReview, made, applied]).looks).toBe(base + 1);
    expect(board([...toReview, made, applied]).notches.at(-1)).toBe((Date.parse(made.ts) - dayStart) / 86_400_000);
    // A gate recorded before the window existed carries no token and still counts.
    const { token: _drop, ...legacy } = applied as Extract<WorkEvent, { type: "gate" }>;
    expect(board([...toReview, legacy]).looks).toBe(base + 1);
    // Stopping a run is stepping in.
    expect(board([...toReview, { ts: at(12), type: "stopped", actor: "human", agentId: "a1" }]).looks).toBe(base + 1);
  });

  test("its receipts say what is coming, what was taken back, and why one did not apply", async () => {
    const { toWireEvents } = await import("./events");
    const events: WorkEvent[] = [
      { ...made, verdict: "revise", note: "Add a test" },
      { ts: at(11), type: "gate.undone", actor: "human", verdict: "revise", token: "d1" },
      { ...made, token: "d2" },
      {
        ts: at(12),
        type: "gate.dropped",
        actor: "maestro",
        verdict: "approve",
        token: "d2",
        reason: "The agent is waiting on a question. Answer it first.",
      },
      { ts: at(13), type: "stopped", actor: "human", agentId: "a1" },
      { ts: at(13), type: "state", actor: "human", from: "running", to: "blocked", reason: "You stopped the run" },
    ];
    // Settled decisions read as made; only the open one still counts down.
    expect(toWireEvents(events).map(({ text, detail }) => [text, detail])).toEqual([
      ["You sent it back", "Add a test"],
      ["Undone", "Send back"],
      ["You approved", null],
      ["Approve did not take effect", "The agent is waiting on a question. Answer it first."],
      ["You stopped the run", null],
    ]);
    expect(toWireEvents([{ ...made, token: "open" }]).map((event) => event.text)).toEqual(["Approving in 8s"]);
    // Applied: the decision reads as made, then when it took effect, with the state change folded in.
    const applied: WorkEvent[] = [
      made,
      { ts: at(11), type: "gate", actor: "human", verdict: "approve", note: "", token: "d1" },
      { ts: at(11), type: "state", actor: "human", from: "review", to: "done", reason: null },
    ];
    expect(toWireEvents(applied).map((event) => event.text)).toEqual(["You approved", "Took effect"]);
  });
});

describe("an arc's own verdict at the gate (BRO-2856)", () => {
  const ended = (text: string): WorkEvent[] =>
    toReview.map((e) => (e.type === "turn.ended" ? { ...e, summary: text } : e));
  const line = (text: string) => arcStatus(text)?.at ?? -1;

  test("the verdict is ctx-core's: the last line that starts exactly `ARC-STATUS: WORD`", () => {
    expect(arcStatus("x\nARC-STATUS: DONE\nmore\nARC-STATUS: HANDBACK 2\n")).toEqual({
      status: "HANDBACK",
      line: "ARC-STATUS: HANDBACK 2",
      at: 3,
    });
    // Indented, lower case, or mid-line: not the grammar.
    expect(arcStatus("  ARC-STATUS: DONE")).toBeNull();
    expect(arcStatus("ARC-STATUS: done")).toBeNull();
    expect(arcStatus("it said ARC-STATUS: DONE")).toBeNull();
  });

  test("a tail cut inside a code block still reads the verdict: fences are not read", () => {
    // The kept text starts mid-block, so its first fence line is that block's closer.
    const cut = ["…fly deploy", "```", "", "Left: redeploy.", "", "ARC-STATUS: HANDBACK 1"].join("\n");
    expect(arcStatus(cut)?.status).toBe("HANDBACK");
    expect(closingAbove(cut, line(cut))).toBe("…fly deploy\n```\n\nLeft: redeploy.");
  });

  test("the closing is the block above the verdict: back to a heading (kept), a table or a rule", () => {
    const text = [
      "# Report",
      "| a | b |",
      "| 1 | 2 |",
      "",
      "### No handback",
      "",
      "Two notes:",
      "- one",
      "",
      "ARC-STATUS: CLOSED",
    ].join("\n");
    expect(closingAbove(text, line(text))).toBe("### No handback\n\nTwo notes:\n- one");
    const prose = ["| a | b |", "| 1 | 2 |", "What's left:", "1. Redeploy", "", "ARC-STATUS: HANDBACK 1"].join("\n");
    expect(closingAbove(prose, line(prose))).toBe("What's left:\n1. Redeploy");
    const rule = ["before", "---", "after", "ARC-STATUS: DONE"].join("\n");
    expect(closingAbove(rule, line(rule))).toBe("after");
  });

  test("the closing is verbatim, indentation kept; a heading or rule is one indented at most 3 spaces", () => {
    const code = ["Run this:", "", "    fly deploy", "ARC-STATUS: DONE"].join("\n");
    expect(closingAbove(code, line(code))).toBe("Run this:\n\n    fly deploy");
    const opens = ["Intro", "---", "", "    fly deploy", "", "ARC-STATUS: DONE"].join("\n");
    expect(closingAbove(opens, line(opens))).toBe("    fly deploy");
    // Indented 4 spaces, `# sri` and `---` are code, not a heading or a rule.
    const nested = [
      "What's left:",
      "- Redeploy:",
      "    # sri",
      "    ---",
      "    fly deploy",
      "ARC-STATUS: HANDBACK 1",
    ].join("\n");
    expect(closingAbove(nested, line(nested))).toBe("What's left:\n- Redeploy:\n    # sri\n    ---\n    fly deploy");
  });

  test("a rule that only sets the verdict apart is passed over, not taken as the end of the closing", () => {
    const text = ["Done, PR merged.", "", "---", "", "ARC-STATUS: HANDBACK 2"].join("\n");
    expect(closingAbove(text, line(text))).toBe("Done, PR merged.");
  });

  test("a table right above the verdict is the closing; nothing above is none", () => {
    const text = [
      "Intro",
      "",
      "| item | evidence |",
      "| --- | --- |",
      "| Deploy | failed |",
      "",
      "ARC-STATUS: HANDBACK 1",
    ].join("\n");
    expect(closingAbove(text, line(text))).toBe("| item | evidence |\n| --- | --- |\n| Deploy | failed |");
    expect(closingAbove("ARC-STATUS: DONE", 0)).toBeNull();
  });

  test("the ask says what the arc reported and nothing about where; an Ask section still wins", () => {
    const verbs = "Approve to close the work, or send it back with a note.";
    expect(lookOf("review", ended("Merged.\n\nNothing left.\n\nARC-STATUS: CLOSED"), T0)).toMatchObject({
      ask: `It reports its arc finished. ${verbs}`,
      arc: { status: "CLOSED", line: "ARC-STATUS: CLOSED" },
      closing: "Merged.\n\nNothing left.",
    });
    expect(lookOf("review", ended("Left:\n1. a\n2. b\nARC-STATUS: HANDBACK 2"), T0)?.ask).toBe(
      "It hands 2 things back to you. Approve to close the work once you have taken them on, or send it back with a note.",
    );
    expect(lookOf("review", ended("Left: a\nARC-STATUS: HANDBACK 1"), T0)?.ask).toBe(
      "It hands 1 thing back to you. Approve to close the work once you have taken it on, or send it back with a note.",
    );
    expect(lookOf("review", ended("Left: a\nARC-STATUS: HANDBACK 0"), T0)?.ask).toBe(
      `It reports nothing handed back to you. ${verbs}`,
    );
    expect(lookOf("review", ended("Left: a\nARC-STATUS: HANDBACK"), T0)?.ask).toStartWith(
      "It hands work back to you. Approve to close the work once you have taken it on",
    );
    expect(lookOf("review", ended("x\nARC-STATUS: BLOCKED"), T0)?.ask).toBe(
      "It reports its arc blocked. Send it back with a note, or cancel the work.",
    );
    expect(lookOf("review", ended("x\nARC-STATUS: PAUSED"), T0)?.ask).toBe(
      `It ended with “ARC-STATUS: PAUSED”. ${verbs}`,
    );
    // Nothing above the verdict: no closing.
    expect(lookOf("review", ended("ARC-STATUS: CLOSED"), T0)).toMatchObject({ closing: null });
    expect(lookOf("review", ended(`${summary}\nARC-STATUS: DONE`), T0)?.ask).toBe(
      "Approve the branch so reviews stop needing the live session.",
    );
  });

  test("archived only when its session was archived after this run was bound and after the turn that landed it", () => {
    const note = (minutes: number): WorkEvent => ({
      ts: at(minutes),
      type: "note",
      actor: "maestro",
      text: ARCHIVED_NOTE,
    });
    expect(lookOf("review", [...toReview, note(135)], T0)?.archived).toBe(true);
    expect(lookOf("review", toReview, T0)?.archived).toBe(false);
    // An earlier session's archiving, before this run's dispatch, is not this one's.
    const earlier = [note(-5), ...toReview.map((e) => (e.type === "dispatched" ? { ...e, ts: at(1) } : e))];
    expect(lookOf("review", earlier, T0)?.archived).toBe(false);
    // Sent back after it was archived, run again, and landed again: not archived now.
    const turn = toReview.find((e) => e.type === "turn.ended") as WorkEvent;
    const again: WorkEvent[] = [
      ...toReview,
      note(135),
      { ts: at(136), type: "state", actor: "human", from: "review", to: "running", reason: "Sent back with a note" },
      { ...turn, ts: at(150) },
      { ts: at(150), type: "state", actor: "maestro", from: "running", to: "review", reason: null },
    ];
    expect(lookOf("review", again, T0)?.archived).toBe(false);
  });
});

describe("who closed it, and who adopted it (BRO-2906)", () => {
  const closing = (actor: "human" | "maestro" | "agent", to: "done" | "canceled"): WorkEvent[] => [
    ...toReview,
    { ts: at(140), type: "state", actor, from: "review", to, reason: null },
  ];

  test("your verdict or cancel is yours; Maestro's own close (or an agent's) is handled for you", () => {
    expect([
      closedOf("done", closing("human", "done")),
      closedOf("canceled", closing("human", "canceled")),
      closedOf("done", closing("maestro", "done")),
      closedOf("done", closing("agent", "done")),
    ]).toEqual([
      { by: "you", at: at(140) },
      { by: "you", at: at(140) },
      { by: "maestro", at: at(140) },
      { by: "maestro", at: at(140) },
    ]);
  });

  test("open work, or a log with no move into its state, was closed by no one", () => {
    expect([closedOf("review", toReview), closedOf("done", toReview)]).toEqual([null, null]);
  });

  test("only an agent's adoption counts, by its name when it gave one, and a later dispatch of yours undoes it", () => {
    const adopted = (actor: "agent" | "human", by?: string): WorkEvent[] => [
      { ...dispatched, type: "adopted", actor, ...(by ? { by } : {}) } as WorkEvent,
    ];
    expect([
      adoptedByOf(adopted("agent", "SRI Orchestrator")),
      adoptedByOf(adopted("agent")),
      adoptedByOf(adopted("human", "you")),
      adoptedByOf([...adopted("agent", "SRI Orchestrator"), { ...dispatched, ts: at(9) }]),
      adoptedByOf(toReview),
    ]).toEqual([{ by: "SRI Orchestrator" }, { by: null }, null, null, null]);
  });
});

describe("run.economy (BRO-3118)", () => {
  const reading: WorkEvent = {
    ts: at(30),
    type: "run.economy",
    actor: "maestro",
    agentId: "a1",
    tier: "standard",
    tierSource: "model",
    provider: "claude/claude-sonnet-5-5",
    model: "claude-sonnet-5-5",
    thinkingOptionId: null,
    measured: true,
    tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 },
    subagentTokens: null,
    subagentModels: null,
    raises: 0,
    maxSubagentTier: null,
    peakContext: 8,
    assistantMessages: 1,
  };

  test("a meter reading is no receipt: the history and the detail do not list it", () => {
    expect(toWireEvents([dispatched, reading]).map((event) => event.type)).toEqual(["dispatched"]);
  });

  test("it moves no clock and takes no flag down", () => {
    const flagged: FlaggedEvent = {
      ts: at(20),
      type: "loop.flagged",
      actor: "maestro",
      kind: "quiet",
      reason: "quiet",
    };
    expect(lastActivityOf([dispatched, flagged, reading])).toEqual(dispatched);
    expect(flagOf([dispatched, flagged, reading])).toEqual(flagged);
    expect(flagOf([dispatched, flagged, reading, { ...reading, ts: at(40) }])).toEqual(flagged);
  });

  test("dispatch and adoption receipts carry the declared tier, and older ones without it still read", () => {
    const old = parseEvents(JSON.stringify(dispatched)).events;
    expect(old).toHaveLength(1);
    expect(workerOf(old)?.tier).toBeNull();
    const declared: WorkEvent = { ...dispatched, tier: "standard" };
    expect(workerOf([declared])).toMatchObject({ tier: "standard", startedWith: "claude/sonnet (tier standard)" });
    const adopted: WorkEvent = {
      ts: at(1),
      type: "adopted",
      actor: "agent",
      by: null,
      agentId: "a2",
      workspaceId: null,
      provider: "claude",
      branch: null,
      cwd: null,
      tier: null,
    };
    expect(workerOf([adopted])?.tier).toBeNull();
  });
});
