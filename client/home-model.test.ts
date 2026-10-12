import { describe, expect, test } from "bun:test";
import { needsOf } from "../server/needs";
import { noticesOf } from "../server/notices";
import type { Scoreboard } from "../shared/contracts";
import type { DecisionAsk } from "../shared/fleet";
import type { Initiative } from "../shared/initiatives";
import { askHoldKey, type Handled, type Needs } from "../shared/needs";
import { fakeWork } from "./fake-work";
import { needsSection } from "./feed-model";
import {
  allowLabel,
  CANCEL_ARM_MS,
  cancelStep,
  denyWords,
  evidenceLine,
  fallbackOf,
  glanceTiles,
  goesLine,
  hangingTiles,
  heldByWords,
  holdChipWords,
  holdInspector,
  holdKindOf,
  holdParam,
  homeBadges,
  homeSections,
  keyAction,
  kindChips,
  primaryLabel,
  stepHold,
  tabOfView,
  wakeChip,
  workInspector,
  workScope,
  workspaceOptions,
} from "./home-model";

const NOW = Date.parse("2026-10-12T15:00:00.000Z");
const live = { agentId: "agent-1", workspaceId: "ws1" };

const ask = (id: string, extra: Partial<DecisionAsk> = {}): DecisionAsk => ({
  ledger: "bro-3035.yaml",
  uid: null,
  id,
  hash: "0123456789abcdef",
  arc: null,
  headline: `Ask ${id}?`,
  question: null,
  stakes: null,
  whyYou: null,
  options: [
    { id: "yes", label: "Yes", consequence: "ships", reversible: true, recommended: true },
    { id: "no", label: "No", consequence: "holds", reversible: false, recommended: false },
  ],
  fallback: null,
  blocking: true,
  askedAt: "2026-10-12T10:00:00.000Z",
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

const review = (id: string): Initiative =>
  ({
    id,
    file: `${id}.yaml`,
    title: id,
    quote: null,
    summary: null,
    nextAction: null,
    driver: null,
    waitingOn: [],
    sessions: [],
    stale: { kind: "overdue", date: "2026-10-08" },
  }) as unknown as Initiative;

const yours = { kind: "yours" as const, reason: "Start it yourself.", at: "2026-10-12T09:00:00.000Z" };

const items = [
  fakeWork("gate", "review", live, { project: "broomva", ticket: "BRO-1" }),
  fakeWork("step", "proposed", null, { flag: yours, project: "sri" }),
  fakeWork("stuck", "blocked", live, { project: "broomva" }),
  fakeWork("run1", "running", { agentId: "agent-2", workspaceId: "ws1" }, { project: "broomva", phase: "working" }),
  fakeWork("run2", "running", { agentId: "agent-3", workspaceId: "ws1" }, { project: "holon" }),
  fakeWork("queued", "proposed", null, { project: "broomva" }),
  fakeWork("done", "done", live, { project: "broomva" }),
];
const asks = [ask("A1"), ask("A2", { blocking: false, waiting: false })];
const needs: Needs = needsOf({ items, asks, reviews: [review("skene")], landing: null, workspace: "broomva" }, NOW);

const handled: Handled = {
  rows: [
    { key: "work:h1", title: "merged one", closedBy: "gates", reason: "checks green", at: "2026-10-12T14:00:00.000Z" },
    { key: "work:h2", title: "you closed", closedBy: "you", reason: "approved", at: "2026-10-12T13:00:00.000Z" },
  ],
  today: { closedForYou: 22, byYou: 4, asksAnswered: 3 },
};

const board: Scoreboard = {
  unsupervisedMs: (4 * 60 + 32) * 60_000,
  looks: 1,
  longestRunMs: 1,
  live: true,
  segments: [{ start: 0.5, width: 0.1, live: true }],
  notches: [],
  week: [],
  weekByInitiative: [],
};

const notices = noticesOf(
  { items, fleet: [], timeline: [], loops: [], reviews: [], snoozed: new Map<string, string>() },
  NOW,
);
const base = { needs, handled, items, asks, notices, workspace: null, filter: "all" as const, query: "" };

describe("the tabs' counts", () => {
  test("Feed, Decisions and Initiatives are needs.list's; Work is the running work; Health the rows listed", () => {
    const badges = homeBadges(needs, 2, 3);
    expect(badges.feed?.count).toBe(needs.summary.total);
    expect(badges.decisions?.count).toBe(needs.rows.filter((row) => row.key.startsWith("ask:")).length);
    expect(badges.initiatives?.count).toBe(1);
    expect(badges.work).toEqual({ count: 2, warn: false, label: "2 running" });
    expect(badges.health).toEqual({ count: 3, warn: true, label: "3 watched items" });
  });

  test("none where none is, and none before needs.list is read", () => {
    expect(homeBadges(null, 0, 0)).toEqual({
      feed: null,
      decisions: null,
      initiatives: null,
      work: null,
      health: null,
    });
  });

  test("every view sits under one tab", () => {
    expect(
      ["feed", "board", "list", "history", "fleet", "timeline", "loops", "decisions", "initiatives"].map((v) =>
        tabOfView(v as never),
      ),
    ).toEqual(["feed", "work", "work", "work", "health", "health", "health", "decisions", "initiatives"]);
  });
});

describe("workspaces", () => {
  test("a work item's workspace is the one needs.list names its hold with", () => {
    expect(workScope(items[0])).toBe("broomva");
    expect(workScope(fakeWork("x", "running", null, { project: null, repo: "/Users/o/skene", initiative: null }))).toBe(
      "skene",
    );
  });

  test("All first with every hold, then each workspace, those with holds first", () => {
    const options = workspaceOptions(needs.rows, items);
    expect(options[0]).toEqual({ id: null, label: "All workspaces", holds: needs.rows.length });
    const named = options.slice(1);
    expect(named.map((option) => option.id)).toContain("holon");
    for (let at = 1; at < named.length; at += 1) expect(named[at - 1].holds).toBeGreaterThanOrEqual(named[at].holds);
    expect(named.reduce((sum, option) => sum + option.holds, 0)).toBe(needs.rows.length);
  });
});

describe("the scope bar's chips", () => {
  test("All is needs.list's total; each kind, then health and finished; a kind with none is left out", () => {
    const chips = kindChips(needs.summary, 2, 1, "all");
    expect(chips[0]).toEqual({ id: "all", label: "All", count: needs.summary.total });
    expect(chips.map((chip) => chip.id)).toEqual(["all", "ask", "approval", "owner_step", "health", "finished"]);
    expect(chips.find((chip) => chip.id === "ask")?.label).toBe("2 asks");
    expect(kindChips(needs.summary, 0, 0, "all").map((chip) => chip.id)).not.toContain("health");
    expect(kindChips(needs.summary, 0, 0, "health").map((chip) => chip.id)).toContain("health");
  });
});

describe("the main column", () => {
  test("unfiltered, Needs you lists every needs.list row in its order: its length is the header's number", () => {
    const sections = homeSections(base);
    expect(sections.needs.map((entry) => entry.row.key)).toEqual(needs.rows.map((row) => row.key));
    expect(sections.needs).toHaveLength(needs.summary.total);
  });

  test("a hold joins the work or the ask it holds", () => {
    const sections = homeSections(base);
    const gate = sections.needs.find((entry) => entry.row.key === "work:gate");
    expect(gate?.item?.id).toBe("gate");
    const first = sections.needs.find((entry) => entry.row.key === askHoldKey(asks[0]));
    expect(first?.ask?.id).toBe("A1");
  });

  test("a kind chip keeps that kind; Health and Finished keep only their own rows", () => {
    expect(homeSections({ ...base, filter: "approval" }).needs.every((entry) => entry.row.kind === "approval")).toBe(
      true,
    );
    const health = homeSections({ ...base, filter: "health" });
    expect(health.needs).toEqual([]);
    expect(health.health.map((row) => row.item?.id)).toEqual(["stuck"]);
    expect(health.running).toEqual([]);
  });

  test("watched work is never a hold: stuck is Health, running and queued are listed once, held work is not repeated", () => {
    const sections = homeSections(base);
    const held = new Set(needs.rows.map((row) => row.key));
    expect(sections.running.map((item) => item.id)).toEqual(["run1", "run2"]);
    expect(sections.queued.map((item) => item.id)).toEqual(["queued"]);
    expect(sections.queued.every((item) => !held.has(`work:${item.id}`))).toBe(true);
    expect(sections.finished.map((item) => item.id)).toEqual([]);
  });

  test("work that landed with nothing held on you is Finished", () => {
    const landed = fakeWork("landed", "review", live, { project: "broomva" });
    const noHold: Needs = { ...needs, rows: needs.rows.filter((row) => row.key !== "work:gate") };
    const sections = homeSections({ ...base, needs: noHold, items: [...items, landed] });
    expect(sections.finished.map((item) => item.id)).toContain("landed");
  });

  test("a workspace narrows holds by their scope and work by its own; the search narrows the rest", () => {
    const sri = homeSections({ ...base, workspace: "sri" });
    expect(sri.needs.every((entry) => entry.row.scope === "sri")).toBe(true);
    expect(sri.running).toEqual([]);
    const holon = homeSections({ ...base, workspace: "holon" });
    expect(holon.running.map((item) => item.id)).toEqual(["run2"]);
    expect(homeSections({ ...base, query: "Work run1" }).running.map((item) => item.id)).toEqual(["run1"]);
  });

  test("a filter or a workspace never changes a tile or a tab: they read the unfiltered projection", () => {
    const filtered = homeSections({ ...base, workspace: "sri", filter: "approval" });
    expect(filtered.needs.length).toBeLessThan(needs.summary.total);
    const tiles = glanceTiles(needs, handled, items, board, null, NOW);
    expect(tiles.needs.value).toBe(needs.summary.total);
  });
});

describe("the glance tiles equal what they name", () => {
  const tiles = glanceTiles(
    needs,
    handled,
    items,
    board,
    { minutes: 15, nextAt: "2026-10-12T15:18:00.000Z", ticking: false },
    NOW,
  );

  test("Needs you is needs.list's total, and says its kinds and its oldest", () => {
    expect(tiles.needs.value).toBe(needs.summary.total);
    expect(tiles.needs.value).toBe(homeSections(base).needs.length);
    expect(tiles.needs.line).toContain("2 asks");
    expect(tiles.needs.oldest).toMatch(/^oldest /);
  });

  test("Running is the work whose state is running", () => {
    expect(tiles.running.value).toBe(items.filter((item) => item.state === "running").length);
    expect(tiles.running.rows.map((row) => row.key)).toEqual(["run1", "run2"]);
  });

  test("Handled today is handled.list's today.closedForYou, with its parts", () => {
    expect(tiles.handled.value).toBe(22);
    expect(tiles.handled.line).toBe("4 closed by you · 3 asks answered");
    expect(tiles.handled.last).toBe("last: merged one · merged by gates");
  });

  test("Unsupervised is the scoreboard's, with the next wake in words", () => {
    expect(tiles.unsupervised.value).toBe("4h 32m");
    expect(tiles.unsupervised.next).toBe("next wake 18 min · every 15 min");
    expect(tiles.unsupervised.segments).toEqual(board.segments);
  });

  test("before a read it says so, and never a number it did not read", () => {
    const empty = glanceTiles(null, null, [], null, null, NOW);
    expect(empty.needs).toEqual({ value: 0, line: "Not read yet", oldest: null });
    expect(empty.handled.line).toBe("Not read yet");
    expect(empty.unsupervised.value).toBe("—");
  });
});

describe("the wake chip", () => {
  test("minutes to the next wake, or why there is none", () => {
    expect(wakeChip({ minutes: 15, nextAt: "2026-10-12T15:18:00.000Z", ticking: false }, NOW)).toBe("18 min");
    expect(wakeChip({ minutes: 15, nextAt: "2026-10-12T14:59:00.000Z", ticking: false }, NOW)).toBe("now");
    expect(wakeChip({ minutes: 15, nextAt: null, ticking: false }, NOW)).toBe("every 15 min");
    expect(wakeChip({ minutes: null, nextAt: null, ticking: false }, NOW)).toBe("loop off");
    expect(wakeChip({ minutes: 15, nextAt: null, ticking: true }, NOW)).toBe("waking…");
    expect(wakeChip(null, NOW)).toBe("loop");
  });
});

describe("walking the holds and opening on one", () => {
  const keys = ["a", "b", "c"];
  test("J and K step, never past an end; with none selected J takes the first and K the last", () => {
    expect(stepHold(keys, "a", 1)).toBe("b");
    expect(stepHold(keys, "c", 1)).toBe("c");
    expect(stepHold(keys, "a", -1)).toBe("a");
    expect(stepHold(keys, null, 1)).toBe("a");
    expect(stepHold(keys, null, -1)).toBe("c");
    expect(stepHold(keys, "gone", 1)).toBe("a");
    expect(stepHold([], null, 1)).toBeNull();
  });

  test("params.hold opens that hold; one needs.list no longer holds is gone; before the read, wait", () => {
    expect(holdParam(undefined, needs.rows)).toEqual({ kind: "none" });
    expect(holdParam("work:gate", null)).toEqual({ kind: "wait" });
    expect(holdParam("work:gate", needs.rows)).toEqual({ kind: "open", key: "work:gate" });
    expect(holdParam("work:answered", needs.rows)).toEqual({ kind: "gone", key: "work:answered" });
  });
});

describe("the inspector's keys", () => {
  test("⌘↵ allows an approval; S skips an ask or a review; ↵ is left to the button that has focus", () => {
    expect(keyAction("approval", { key: "Enter", meta: true }, false)).toEqual({ verb: "allow" });
    expect(keyAction("approval", { key: "Enter" }, false)).toBeNull();
    expect(keyAction("ask", { key: "Enter" }, false)).toBeNull();
    expect(keyAction("review", { key: "s" }, false)).toEqual({ verb: "skip" });
    expect(keyAction("owner_step", { key: "s" }, false)).toBeNull();
    expect(keyAction("ask", { key: "Enter", meta: true }, false)).toBeNull();
  });

  test("J and K walk the holds: on a notice or a work item, which is not one, they do nothing", () => {
    for (const kind of ["approval", "ask", "owner_step", "review"] as const) {
      expect(keyAction(kind, { key: "j" }, false)).toEqual({ step: 1 });
      expect(keyAction(kind, { key: "K" }, false)).toEqual({ step: -1 });
    }
    for (const kind of ["work", "notice"] as const) {
      expect(keyAction(kind, { key: "j" }, false)).toBeNull();
      expect(keyAction(kind, { key: "K" }, false)).toBeNull();
    }
  });

  test("a field being typed in keeps every key", () => {
    expect(keyAction("ask", { key: "Enter" }, true)).toBeNull();
    expect(keyAction("work", { key: "j" }, true)).toBeNull();
  });
});

describe("what a hold is", () => {
  const entries = needsSection(needs.rows, items, asks);
  const entryOf = (key: string) => entries.find((entry) => entry.row.key === key);

  test("an approval, an owner step, an ask, a review", () => {
    const kinds = Object.fromEntries(needs.rows.map((row) => [row.key, holdKindOf(row)]));
    expect(kinds["work:gate"]).toBe("approval");
    expect(kinds["work:step"]).toBe("owner_step");
    expect(kinds[askHoldKey(asks[0])]).toBe("ask");
    expect(kinds["review:skene"]).toBe("review");
    expect(holdChipWords(needs.rows.find((row) => row.key === "work:step") as never)).toBe("owner step");
  });

  test("an approval's Allow names the action when it is one people know by its verb", () => {
    expect(allowLabel("gh pr merge 933 --squash @ ce73104")).toBe("Allow merge");
    expect(allowLabel("git push origin HEAD")).toBe("Allow push");
    expect(allowLabel("Close it as done")).toBeUndefined();
  });

  test("an owner step on work says what Done does", () => {
    expect(primaryLabel(needs.rows.find((row) => row.key === "work:step") as never)).toBe("Start it");
    expect(primaryLabel(needs.rows.find((row) => row.key === "work:gate") as never)).toBeUndefined();
  });

  test("the approval's evidence is one line of its facts", () => {
    const row = needs.rows.find((one) => one.key === "work:gate");
    if (row?.kind !== "approval") throw new Error("expected an approval");
    const facts = [
      { label: "Checks", value: "7 of 7", tone: "ok" as const },
      { label: "P20", value: "8 · 9 · 8", tone: "ok" as const },
    ];
    expect(evidenceLine({ ...row, body: { ...row.body, evidence: facts } })).toBe("Checks 7 of 7 · P20 8 · 9 · 8");
    expect(evidenceLine({ ...row, body: { ...row.body, evidence: [] } })).toBeNull();
  });

  test("the inspector gets the kind's body: an approval its action, an ask its options with the recommended one chosen", () => {
    const approval = holdInspector(entryOf("work:gate") as never, NOW);
    expect(approval.kind).toBe("approval");
    expect(approval.primaryLabel).toBeUndefined();
    expect(approval.key).toBe("work:gate");
    const one = holdInspector(entryOf(askHoldKey(asks[0])) as never, NOW);
    if (one.kind !== "ask") throw new Error("expected an ask");
    expect(one.options.map((option) => option.id)).toEqual(["yes", "no"]);
    expect(one.chosen).toBe("yes");
    expect(one.options[1].note).toContain("cannot be undone");
    const due = holdInspector(entryOf("review:skene") as never, NOW);
    expect(due.kind).toBe("review");
    expect(holdInspector(entryOf("work:step") as never, NOW).kind).toBe("owner_step");
  });

  test("watched work: stuck work is a notice with its ways out, other work a lifecycle", () => {
    const notice = workInspector(items[2], NOW);
    expect(notice.kind).toBe("notice");
    if (notice.kind !== "notice") return;
    expect(notice.closesWhen.map((entry) => entry.becomes)).toEqual(["Running", "Canceled"]);
    const running = workInspector(items[3], NOW);
    expect(running.kind).toBe("work");
    if (running.kind !== "work") return;
    expect(running.state).toBe("running");
    expect(running.lifecycle.map((step) => step.done)).toEqual([true, true, false, false]);
  });
});

describe("J2–J4: what each inspector body says", () => {
  const entries = needsSection(needs.rows, items, asks);
  const entryOf = (key: string) => entries.find((entry) => entry.row.key === key);

  test("an approval says what held it, and what each of its two answers does", () => {
    // Work at the gate with no prompt is Finished, never a hold (BRO-2999): an approval is a session's prompt.
    const item = holdInspector(entryOf("work:gate") as never, NOW);
    if (item.kind !== "approval") throw new Error("an approval");
    expect(item.heldBy).toBe(
      heldByWords(needs.rows.find((row) => row.key === "work:gate")?.kind === "approval" ? "permission" : ""),
    );
    expect(item.afterDeny).toEqual(denyWords("permission"));
    expect(heldByWords("permission")).toBe("the session's permission prompt");
    expect(heldByWords("gate")).toBe("Maestro's human gate");
    expect(denyWords("permission")).toEqual(["The session is told no and goes on without it; nothing runs."]);
    expect(denyWords("gate")).toEqual(["It goes back to its session; nothing is merged."]);
  });

  test("an ask says what waiting costs and why it is yours as two tiles, and where the answer goes", () => {
    const withWords = [ask("A1", { stakes: "x", whyYou: "y" })];
    const row = needsOf({ items: [], asks: withWords, reviews: [], landing: null, workspace: "broomva" }, NOW).rows[0];
    const [entry] = needsSection(row ? [row] : [], [], withWords);
    const item = holdInspector(entry as never, NOW);
    if (item.kind !== "ask") throw new Error("an ask");
    expect(item.cost).toBe("x");
    expect(item.whyYou).toBe("y");
    expect(item.goes).toContain("Your answer is written to origin/main, through Maestro's answers batch");
    expect(item.fieldLabel).toBeUndefined();
  });

  test("a session that asked is named in where the answer goes, and what follows if it is gone (A8)", () => {
    const line = goesLine("origin/main", "agent-12");
    expect(line).toContain("Goes to the session that asked (agent-12), verbatim");
    expect(line).toContain("with none, it waits for the conductor");
    expect(line).not.toContain("starts");
  });

  test("a review lists what changed, what hangs off it, and its three answers", () => {
    const item = holdInspector(entryOf("review:skene") as never, NOW);
    if (item.kind !== "review") throw new Error("a review");
    expect(item.options.map((option) => option.id)).toEqual(["keep", "park", "close"]);
    expect(item.hanging?.map((tile) => tile.label)).toEqual(["work", "open asks", "driver session"]);
    expect(item.goes).toContain("skene.yaml in the control repo");
    expect(hangingTiles({ work: 3, asks: 1, driver: "skene-driver" })).toEqual([
      { icon: "LayoutList", value: "3", label: "work" },
      { icon: "MessagesSquare", value: "1", label: "open ask" },
      { icon: "Radio", value: "1", label: "driver session" },
    ]);
    expect(hangingTiles({ work: 0, asks: 0 })[2]?.value).toBe("0");
  });

  test("if you say nothing: a timed default counts down from when it was asked to when it applies (A4)", () => {
    const entry = entryOf(askHoldKey(asks[0])) as never as {
      row: { kind: "ask"; since: string; body: Record<string, unknown> };
    };
    const since = Date.parse(entry.row.since);
    const timed = {
      ...entry,
      row: {
        ...entry.row,
        body: { ...entry.row.body, default: { option: "yes", appliesAt: new Date(since + 30 * 60_000).toISOString() } },
      },
    };
    const half = fallbackOf(timed as never, since + 15 * 60_000);
    expect(half?.line).toContain("If you say nothing: Yes, in 15 min");
    expect(half?.line).toContain("A4: reversible asks take their default after 30 min");
    expect(half?.elapsed).toBeCloseTo(0.5);
    expect(fallbackOf(timed as never, since + 31 * 60_000)?.line).toContain(", now");
    // No timed default: the ledger's own words with no countdown, or nothing.
    expect(fallbackOf({ ...entry, ask: ask("A1", { fallback: "yes" }) } as never, NOW)).toEqual({
      line: "If you say nothing: Yes.",
    });
    expect(fallbackOf({ ...entry, ask: null } as never, NOW)).toBeUndefined();
  });

  test("stuck work is a notice: what closes it, who owns it, a prompt field, and no Approve", () => {
    const stuck = fakeWork("s1", "blocked", live, {
      project: "sri",
      ticket: "STI-3593",
      adoptedBy: { by: "SRI Orchestrator" },
    });
    const notice = workInspector(stuck, NOW);
    if (notice.kind !== "notice") throw new Error("a notice");
    expect(notice.kicker).toEqual(["sri", "STI-3593", "owner: SRI Orchestrator"]);
    expect(notice.prompt).toBe(true);
    expect(notice.closesWhen).toEqual([
      { when: "Its session takes a turn again", becomes: "Running" },
      { when: "Its orchestrator closes it", becomes: "Handled for you" },
      { when: "You cancel it", becomes: "Canceled" },
    ]);
    expect(notice.note).toContain("No Approve: a notice is a fact");
  });
});

describe("Cancel work…: the first press arms it, the second on the same item does it", () => {
  test("a second press on the same item inside the window cancels; any other press arms", () => {
    expect(cancelStep(null, "w1", 1000)).toBe("arm");
    expect(cancelStep({ key: "w1", at: 1000 }, "w1", 1000 + CANCEL_ARM_MS)).toBe("go");
    expect(cancelStep({ key: "w1", at: 1000 }, "w1", 1001 + CANCEL_ARM_MS)).toBe("arm");
    expect(cancelStep({ key: "w1", at: 1000 }, "w2", 1500)).toBe("arm");
  });
});
