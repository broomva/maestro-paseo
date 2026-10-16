import { describe, expect, test } from "bun:test";
import { answersStatus } from "../server/answers-status";
import { needsOf } from "../server/needs";
import { type AnswerFate, type AnswersLanding, answersNotice } from "../shared/answers";
import type { DecisionAsk } from "../shared/fleet";
import type { Initiative } from "../shared/initiatives";
import { isTriaged } from "./decisions-model";
import {
  askHolds,
  progressSegments,
  railLabel,
  routeLine,
  stageChip,
  stageItem,
  stageProgress,
  stageTiles,
  upNextRow,
  wentRows,
} from "./decisions-stage-model";
import { tabBadges } from "./header-count";

const NOW = Date.parse("2026-10-12T15:00:00.000Z");
const H = 3_600_000;

const ask = (id: string, extra: Partial<DecisionAsk> = {}): DecisionAsk => ({
  ledger: "claude-code-mods.yaml",
  uid: null,
  id,
  hash: "0123456789abcdef",
  arc: null,
  headline: `Question ${id}?`,
  question: null,
  stakes: "Nothing blocks.",
  whyYou: "A boundary only you move.",
  options: [
    { id: "off", label: "Keep them off", consequence: "nothing changes", reversible: true, recommended: true },
    { id: "one", label: "Install in one worktree", consequence: "a trial", reversible: true, recommended: false },
    { id: "all", label: "Install fleet-wide", consequence: "every session", reversible: false, recommended: false },
  ],
  fallback: null,
  blocking: false,
  askedAt: new Date(NOW - 2 * H).toISOString(),
  answeredAt: null,
  answer: null,
  answerOption: null,
  allowOther: true,
  state: "open",
  origin: null,
  refusal: null,
  home: { kind: "main", path: "/ctl", branch: null },
  batched: false,
  waiting: false,
  ...extra,
});

const landing = (extra: Partial<AnswersLanding> = {}): AnswersLanding => ({
  stage: "waiting",
  pending: 27,
  asks: [],
  pr: { number: 963, url: "https://github.com/broomva/workspace/pull/963" },
  conflict: null,
  error: null,
  landed: null,
  checkedAt: new Date(NOW).toISOString(),
  ...extra,
});

const fate = (stage: AnswerFate["stage"]): AnswerFate => ({
  stage,
  words: `fate ${stage}`,
  route: null,
  pr: null,
  work: null,
  agentId: null,
});

const needsFor = (asks: DecisionAsk[], l: AnswersLanding | null = null) =>
  needsOf({ items: [], asks, reviews: [], landing: l, workspace: "broomva" }, NOW);

describe("J5's tiles", () => {
  const open = [
    ask("a", { blocking: true, waiting: true, askedAt: new Date(NOW - 2 * H).toISOString() }),
    ask("b", { ledger: "sri.yaml", askedAt: new Date(NOW - 30 * 60_000).toISOString() }),
  ];

  test("Open is the queue's length; its on-you part is needs.list's asks, the Decisions badge less the batch", () => {
    const l = landing();
    const needs = needsFor(open, l);
    const tiles = stageTiles(open, needs, answersStatus([], l), NOW);
    expect(tiles.open.value).toBe(2);
    expect(tiles.open.line).toBe("1 blocks work · 1 on you · oldest 2h");
    expect(tiles.open.extra).toBe("claude-code-mods 1 · sri 1");
    // The invariant: the tile's "on you" is the Decisions tab's badge less the answers batch row.
    const badge = tabBadges(needs).decisions?.count ?? 0;
    const batch = needs.rows.filter((row) => row.key === "answers:batch").length;
    expect(askHolds(needs)).toBe(badge - batch);
    expect(askHolds(needs)).toBe(1);
  });

  test("a due review is Initiatives' hold, never counted as a decision on you", () => {
    const review = {
      id: "skene",
      title: "skene",
      stale: { kind: "overdue", date: "2026-10-07" },
      waitingOn: [],
      sessions: [],
    } as unknown as Initiative;
    const needs = needsOf({ items: [], asks: open, reviews: [review], landing: null, workspace: "broomva" }, NOW);
    expect(needs.summary.byKind.ask).toBe(2);
    expect(askHolds(needs)).toBe(1);
  });

  test("nothing is read yet: no tile claims a number it was not told", () => {
    const tiles = stageTiles([], null, null, NOW);
    expect(tiles.open.line).toBe("Nothing open in any ledger.");
    expect(tiles.open.tone).toBe("plain");
    expect(tiles.landing.value).toBe(0);
    expect(tiles.landing.line).toBe("Where your answers wait is not read yet.");
    expect(tiles.landing.verb).toBeUndefined();
    expect(askHolds(null)).toBe(0);
  });

  test("Waiting to land is the landing's own count, warn-tinted, and its verb opens the PR", () => {
    const l = landing();
    const { landing: tile } = stageTiles(open, needsFor(open, l), answersStatus([], l), NOW);
    // The same number the answers hold in Needs you says ("27 answers wait to land").
    expect(tile.value).toBe(27);
    expect(tile.unit).toBe("answers");
    expect(tile.tone).toBe("warn");
    expect(tile.verb).toEqual({ label: "Open the PR", url: "https://github.com/broomva/workspace/pull/963" });
    expect(tile.line).toContain("Agents can't act on them until they land");
  });

  test("the tile's verb only opens a link: it is never a merge (A8, the owner merges)", () => {
    const { landing: tile } = stageTiles(open, null, answersStatus([], landing()), NOW);
    expect(Object.keys(tile.verb ?? {}).sort()).toEqual(["label", "url"]);
    expect(tile.verb?.url).toMatch(/^https:\/\//);
  });

  test("no PR yet: it says Maestro opens it at its next check, and offers no verb", () => {
    const { landing: tile } = stageTiles(open, null, answersStatus([], landing({ pr: null })), NOW);
    expect(tile.tone).toBe("warn");
    expect(tile.verb).toBeUndefined();
    expect(tile.line).toContain("Maestro opens its PR at its next check");
  });

  test("a stopped batch is warn with its own words, even with nothing counted", () => {
    const stopped = landing({ stage: "conflict", pending: 0, conflict: { ledgers: ["a.yaml"], path: "/x" } });
    const { landing: tile } = stageTiles([], null, answersStatus([], stopped), NOW);
    expect(tile.tone).toBe("warn");
    expect(tile.line).toContain("conflicts with origin/main");
  });

  test("a failed step with nothing waiting is the wake log's to say, as Needs you has it: the tile does not warn", () => {
    const offline = landing({ stage: "failed", pending: 0, pr: null, error: "fetch failed: offline" });
    expect(answersNotice(offline)).toBeNull();
    expect(stageTiles([], null, answersStatus([], offline), NOW).landing.tone).toBe("plain");
    // With answers waiting, a failed step is a warning in both places.
    const waiting = landing({ stage: "failed", pending: 2, pr: null, error: "gh: not signed in" });
    expect(answersNotice(waiting)).not.toBeNull();
    expect(stageTiles([], null, answersStatus([], waiting), NOW).landing.tone).toBe("warn");
  });

  test("everything landed: a plain tile that says so", () => {
    const { landing: tile } = stageTiles(
      [],
      null,
      answersStatus([], landing({ stage: "none", pending: 0, pr: null })),
      NOW,
    );
    expect(tile.tone).toBe("plain");
    expect(tile.line).toBe("Everything you answered is on main.");
  });

  test("Routed, in progress and Acted on are answers.status's, with the held answers named apart", () => {
    const asks = [
      ask("1", { state: "answered", answeredAt: "2026-10-12T01:00:00Z", fate: fate("acted") }),
      ask("2", { state: "answered", answeredAt: "2026-10-12T02:00:00Z", fate: fate("acted") }),
      ask("3", { state: "answered", answeredAt: "2026-10-12T03:00:00Z", fate: fate("unrouted") }),
      ask("4", { state: "answered", answeredAt: "2026-10-12T04:00:00Z", fate: fate("conductor") }),
    ];
    const tiles = stageTiles([], null, answersStatus(asks, null), NOW);
    expect(tiles.routed.value).toBe(1);
    expect(tiles.routed.line).toContain("live session or a coordinator");
    expect(tiles.acted.value).toBe(2);
    expect(tiles.acted.line).toContain(
      "1 more answer held for the conductor: nothing starts until a lane takes it (A8)",
    );
  });
});

describe("J5's header and rail", () => {
  test("the progress line: where you are, what blocks, what you skipped", () => {
    const queue = [ask("a", { blocking: true }), ask("b", { blocking: true }), ask("c")];
    expect(stageProgress({ text: "Decision 1 of 3" }, queue, 0)).toBe("Decision 1 of 3 · 2 block work");
    expect(stageProgress({ text: "Decision 1 of 3" }, [queue[0] as DecisionAsk], 1)).toBe(
      "Decision 1 of 3 · 1 blocks work · 1 skipped",
    );
    expect(stageProgress({ text: "No decisions open" }, [], 0)).toBe("No decisions open");
  });

  test("one segment per decision, filled for each answered, never more than twelve", () => {
    expect(progressSegments(1, 3)).toEqual([true, false, false]);
    expect(progressSegments(0, 0)).toEqual([]);
    expect(progressSegments(30, 30)).toHaveLength(12);
    expect(progressSegments(99, 2)).toEqual([true, true]);
  });

  test("an Up next card: its headline, ledger, whether it blocks, its silent default, and a label for a screen reader", () => {
    const row = upNextRow(ask("a", { ledger: "sri/sti-3587.yaml", blocking: true, fallback: "hold" }));
    expect(row).toMatchObject({ title: "Question a?", blocks: true, silent: "silent → hold" });
    expect(row.ledger).toBe("sri · sti-3587");
    expect(row.label).toBe("Go to a in sri/sti-3587.yaml: Question a?");
    expect(upNextRow(ask("b")).silent).toBeNull();
  });

  test("each stage is one word, and a stranded answer is never 'acted'", () => {
    expect(stageChip("acted")).toEqual({ word: "acted", tone: "ok" });
    expect(stageChip("unrouted").word).toBe("routed");
    expect(stageChip("conductor")).toEqual({ word: "held", tone: "warn" });
    expect(stageChip("unlanded")).toEqual({ word: "waiting", tone: "warn" });
    expect(stageChip("superseded").tone).toBe("muted");
    expect(stageChip("before").word).toBe("earlier");
  });

  test("where your last answers went: what you said, and the fate in its own words", () => {
    const status = answersStatus(
      [
        ask("1", {
          state: "answered",
          answeredAt: "2026-10-12T01:00:00Z",
          answerOption: "off",
          fate: fate("unlanded"),
        }),
      ],
      null,
    );
    expect(wentRows(status.recent)).toEqual([
      {
        key: "claude-code-mods.yaml#1",
        title: "Question 1?",
        line: "You: Keep them off",
        words: "fate unlanded",
        chip: { word: "waiting", tone: "warn" },
      },
    ]);
  });

  test("your note rides on the line, after what you chose (BRO-3146)", () => {
    const status = answersStatus(
      [
        ask("1", {
          state: "answered",
          answeredAt: "2026-10-12T01:00:00Z",
          answerOption: "off",
          answerNote: "Until the launch.",
          fate: fate("unlanded"),
        }),
      ],
      null,
    );
    expect(wentRows(status.recent)[0]?.line).toBe("You: Keep them off · Note: Until the launch.");
  });

  test("a ledger chip's words for a screen reader", () => {
    expect(railLabel("a.yaml", 2, 0)).toBe("a.yaml: 2 open");
    expect(railLabel("a.yaml", 2, 1)).toBe("a.yaml: 2 open, 1 waits on you");
    expect(railLabel("All ledgers", 3, 2)).toBe("All ledgers: 3 open, 2 wait on you");
  });
});

describe("the decision as J3's inspector, at full width", () => {
  test("the ask's own words: kicker, headline, the two tiles, numbered options, and where the answer goes", () => {
    const item = stageItem(ask("A3", { origin: { agentId: "claude-code-mods-1", cwd: null } }), null, NOW);
    if (item.kind !== "ask") throw new Error("an ask");
    expect(item.kicker).toEqual(["claude-code-mods", "A3", "an option cannot be undone"]);
    expect(item.age).toBe("2h");
    expect(item.title).toBe("Question A3?");
    expect([item.cost, item.whyYou]).toEqual(["Nothing blocks.", "A boundary only you move."]);
    expect(item.options.map((option) => [option.id, option.recommended, option.irreversible])).toEqual([
      ["off", true, false],
      ["one", false, false],
      ["all", false, true],
      // The Other row (BRO-3146): none of these fit, in your words.
      ["maestro:other", undefined, undefined],
    ]);
    expect(item.options[2]?.note).toBe("every session · cannot be undone");
    expect(item.goes).toContain("Goes to the session that asked (claude-c)");
    expect(item.fieldLabel).toBe("Your words for A3");
    expect(item.optionsLabel).toBe("Options for A3");
  });

  test("nothing is chosen for you, the recommendation included: only your draft is the choice", () => {
    const none = stageItem(ask("A1"), null, NOW);
    const picked = stageItem(ask("A1"), "one", NOW);
    expect(none.kind === "ask" && none.chosen).toBeUndefined();
    expect(picked.kind === "ask" && picked.chosen).toBe("one");
  });

  test("if you say nothing: the ledger's default, in its words", () => {
    const item = stageItem(ask("A1", { fallback: "off" }), null, NOW);
    expect(item.kind === "ask" && item.fallback?.line).toBe("If you say nothing: Keep them off.");
    expect(
      stageItem(ask("A1"), null, NOW).kind === "ask" &&
        (stageItem(ask("A1"), null, NOW) as { fallback?: unknown }).fallback,
    ).toBeFalsy();
  });

  test("the route line says what happens when the asker is gone, and that nothing is started (A8)", () => {
    expect(routeLine(ask("A1"))).toContain(
      "a sibling, then the initiative's driver; with none, it waits for the conductor",
    );
  });

  test("the decisions it walks are the open ones, ideas aside (isTriaged)", () => {
    expect(isTriaged(ask("A1"))).toBe(true);
    expect(isTriaged(ask("A1", { state: "answered" }))).toBe(false);
  });
});
