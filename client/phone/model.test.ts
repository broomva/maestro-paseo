import { describe, expect, test } from "bun:test";
import { needsOf } from "../../server/needs";
import { noticesOf } from "../../server/notices";
import type { AnswersStatus } from "../../shared/answers";
import type { DecisionAsk } from "../../shared/fleet";
import type { Initiative } from "../../shared/initiatives";
import type { Handled, Needs } from "../../shared/needs";
import { fakeWork } from "../fake-work";
import { needsSection } from "../feed-model";
import { holdsByTab } from "../header-count";
import { holdInspector, homeSections } from "../home-model";
import type { InspectorItem } from "../kit/inspector";
import { withoutRefused } from "../kit/inspector-model";
import {
  advanceTo,
  answerStep,
  answersCounts,
  bothRead,
  CONFIRM_MS,
  CONFIRM_WINDOW_MS,
  decisionCards,
  decisionCountWords,
  decisionsDeck,
  deckEmptyWords,
  deckVerbs,
  feedCounts,
  feedDeck,
  feedSheet,
  irreversibleChoice,
  openAsks,
  openingChoice,
  PHONE_TABS,
  pageOfIntent,
  pageTrail,
  phoneTabOf,
  phoneTabs,
  readOf,
  resolveIndex,
  staleWords,
  unreadWords,
  workspaceNameOf,
} from "./model";

const NOW = Date.parse("2026-10-12T15:00:00.000Z");
// Real shapes: a Paseo agent id, a work id and a ledger uid are three different things.
const live = { agentId: "d3c2a1b0-7a54-4e0f-9b1e-5f6a7b8c9d01", workspaceId: "ws1" };

const ask = (id: string, extra: Partial<DecisionAsk> = {}): DecisionAsk => ({
  ledger: "claude-code-mods.yaml",
  uid: `u-${id.toLowerCase()}-7f3e`,
  id,
  hash: "0123456789abcdef",
  arc: null,
  headline: `Install the three mods ${id}?`,
  question: null,
  stakes: null,
  whyYou: null,
  options: [
    { id: "off", label: "Keep them off", consequence: "nothing changes", reversible: true, recommended: true },
    { id: "all", label: "Install fleet-wide", consequence: "every session", reversible: false, recommended: false },
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

const reviewOf = (id: string): Initiative =>
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

const items = [
  fakeWork("w-gate-9a1", "review", live, { project: "broomva", ticket: "BRO-1" }),
  fakeWork("w-stuck-3c4", "blocked", live, { project: "broomva" }),
  fakeWork(
    "w-run-1f2",
    "running",
    { agentId: "b7e1c9aa-1d2e-4f3a-8b4c-5d6e7f8a9b0c", workspaceId: "ws1" },
    { project: "broomva", phase: "working" },
  ),
  fakeWork(
    "w-run-2e8",
    "running",
    { agentId: "c8f2daab-2e3f-4a4b-9c5d-6e7f8a9b0c1d", workspaceId: "ws1" },
    { project: "holon" },
  ),
  fakeWork("w-queued-5d7", "proposed", null, { project: "broomva" }),
  fakeWork("w-done-0b6", "done", live, { project: "broomva" }),
];
const asks = [ask("A1"), ask("A2", { blocking: false })];
const needs: Needs = needsOf({ items, asks, reviews: [reviewOf("skene")], landing: null, workspace: "broomva" }, NOW);
const notices = noticesOf(
  { items, fleet: [], timeline: [], loops: [], reviews: [], snoozed: new Map<string, string>() },
  NOW,
);
const handled: Handled = {
  rows: [
    { key: "work:h1", title: "merged one", closedBy: "gates", reason: "checks green", at: "2026-10-12T14:00:00.000Z" },
  ],
  today: { closedForYou: 22, byYou: 4, asksAnswered: 3 },
};
const entries = needsSection(needs.rows, items, asks);
const sections = homeSections({ needs, handled, items, asks, notices, workspace: null, filter: "all", query: "" });

describe("the tab bar's counts are the desktop header's", () => {
  test("four tabs, Initiatives none: it is a page from Health", () => {
    expect(PHONE_TABS.map((tab) => tab.id)).toEqual(["feed", "decisions", "work", "health"]);
    expect(phoneTabOf("initiatives")).toBe("health");
    expect(phoneTabOf("work")).toBe("work");
  });

  test("Feed is needs.list's total, Decisions its holds that open there, Health notices.list's rows, Work none", () => {
    const tabs = phoneTabs(needs, notices.rows.length);
    const by = Object.fromEntries(tabs.map((tab) => [tab.id, tab]));
    expect(by.feed?.badge).toBe(needs.summary.total);
    expect(by.decisions?.badge).toBe(holdsByTab(needs.rows).decisions);
    expect(by.health?.badge).toBe(notices.summary.total);
    expect(by.work?.badge).toBeUndefined();
    expect(by.feed?.badgeTone).toBe("needs");
    expect(by.health?.badgeTone).toBe("warn");
  });

  test("a tab with none carries none, and none before needs.list is read", () => {
    const tabs = phoneTabs(null, 0);
    expect(tabs.every((tab) => tab.badge === undefined)).toBe(true);
  });
});

describe("the decks", () => {
  test("the Feed deck is every hold: its length is the Feed tab's badge", () => {
    expect(feedDeck(entries)).toHaveLength(needs.summary.total);
    expect(feedDeck(entries).map((entry) => entry.row.key)).toEqual(needs.rows.map((row) => row.key));
  });

  test("the Decisions deck is the holds that open in Decisions: its length is that tab's badge", () => {
    const deck = decisionsDeck(entries);
    expect(deck).toHaveLength(holdsByTab(needs.rows).decisions);
    expect(deck.length).toBeGreaterThan(0);
    expect(deck.length).toBeLessThan(entries.length);
    // A due review is Initiatives' and work's holds are the Feed's.
    expect(deck.every((entry) => entry.row.key.startsWith("ask:") || entry.row.key.startsWith("answers:"))).toBe(true);
  });

  test("the deck follows its hold by key: a neighbour leaving moves it, never onto the neighbour", () => {
    const keys = ["a", "b", "c", "d"];
    expect(resolveIndex(keys, "c", 0)).toBe(2);
    // "b" answered elsewhere and left: "c" is now second, and the deck is still on "c".
    expect(resolveIndex(["a", "c", "d"], "c", 2)).toBe(1);
    // The hold the deck was on left: it stays where it was, never past the last.
    expect(resolveIndex(["a", "b"], "c", 2)).toBe(1);
    expect(resolveIndex(["a", "b", "d"], "c", 2)).toBe(2);
    expect(resolveIndex([], "c", 3)).toBe(0);
    expect(resolveIndex(keys, null, 0)).toBe(0);
  });

  test("after a verb the deck moves to the next hold that is not waiting out its window, else the one before", () => {
    const keys = ["a", "b", "c", "d"];
    expect(advanceTo(keys, "a", new Set())).toBe("b");
    expect(advanceTo(keys, "a", new Set(["b"]))).toBe("c");
    expect(advanceTo(keys, "d", new Set())).toBe("c");
    expect(advanceTo(keys, "d", new Set(["c", "b"]))).toBe("a");
    // Nothing else is free: it stays on the one it is on.
    expect(advanceTo(["a"], "a", new Set())).toBe("a");
    expect(advanceTo(["a", "b"], "a", new Set(["b"]))).toBe("a");
  });
});

describe("what a hold offers on the deck", () => {
  const item = (key: string): InspectorItem => {
    const entry = entries.find((one) => one.row.key === key);
    if (!entry) throw new Error(`no hold ${key}`);
    return holdInspector(entry, NOW);
  };
  const askEntry = entries.find((entry) => entry.row.key.startsWith("ask:") && entry.ask?.id === "A1");

  test("an approval is Deny… and its own Allow; never Approve", () => {
    const gate = entries.find((entry) => entry.row.kind === "approval");
    expect(gate).toBeDefined();
    const verbs = deckVerbs(holdInspector(gate as never, NOW), false);
    expect(verbs.map((verb) => verb.id)).toEqual(["deny", "allow"]);
    expect(verbs.filter((verb) => verb.primary)).toHaveLength(1);
    expect(verbs.map((verb) => verb.label).join(" ")).not.toMatch(/approve/i);
  });

  test("an ask is Skip and Answer; a due review is its three answers or the driver's session, with no Skip", () => {
    const first = askEntry as NonNullable<typeof askEntry>;
    expect(deckVerbs(holdInspector(first, NOW), false).map((verb) => verb.id)).toEqual(["skip", "answer"]);
    const review = entries.find((entry) => entry.row.key.startsWith("review:"));
    expect(review).toBeDefined();
    const inspected = holdInspector(review as never, NOW);
    expect(inspected.kind).toBe("review");
    expect(deckVerbs(inspected, false).map((verb) => verb.id)).toEqual(["answer"]);
    expect(deckVerbs(inspected, true).map((verb) => verb.id)).toEqual(["open", "answer"]);
  });

  test("an ask opens on its recommendation, and says which options cannot be undone", () => {
    const first = holdInspector(askEntry as NonNullable<typeof askEntry>, NOW);
    expect(openingChoice(first)).toBe("off");
    expect(irreversibleChoice(first, "off")).toBe(false);
    expect(irreversibleChoice(first, "all")).toBe(true);
    expect(irreversibleChoice(first, undefined)).toBe(false);
    // Only an ask or a review has options.
    const gate = entries.find((entry) => entry.row.kind === "approval");
    expect(irreversibleChoice(holdInspector(gate as never, NOW), "all")).toBe(false);
    expect(openingChoice(item(gate?.row.key as string))).toBeUndefined();
  });
});

describe("an answer that cannot be undone asks twice", () => {
  const press = { key: "ask:one", choice: "all", irreversible: true };

  test("a reversible choice is sent at once", () => {
    expect(answerStep(null, { key: "ask:one", choice: "off", irreversible: false }, NOW)).toBe("send");
  });

  test("the first press arms; a deliberate second sends; one in the same breath waits", () => {
    expect(answerStep(null, press, NOW)).toBe("arm");
    const armed = { key: "ask:one", choice: "all", at: NOW };
    expect(answerStep(armed, press, NOW + CONFIRM_MS - 1)).toBe("wait");
    expect(answerStep(armed, press, NOW + CONFIRM_MS)).toBe("send");
  });

  test("another choice, another hold, or a stale press arms again; it never sends one it did not arm", () => {
    const armed = { key: "ask:one", choice: "all", at: NOW };
    expect(answerStep(armed, { ...press, choice: "other" }, NOW + 1000)).toBe("arm");
    expect(answerStep(armed, { ...press, key: "ask:two" }, NOW + 1000)).toBe("arm");
    expect(answerStep(armed, press, NOW + CONFIRM_WINDOW_MS + 1)).toBe("arm");
    expect(answerStep(armed, press, NOW + CONFIRM_WINDOW_MS)).toBe("send");
  });
});

describe("the Feed's sheet", () => {
  test("groups are Queued, Running, Health and Finished, each only when it has rows, none of them a hold", () => {
    const groups = feedSheet(sections, NOW);
    const order = ["queued", "running", "health", "finished"] as const;
    expect(groups.map((group) => group.id)).toEqual(order.filter((id) => groups.some((group) => group.id === id)));
    expect(groups.length).toBeGreaterThan(2);
    expect(groups.find((group) => group.id === "running")?.rows).toHaveLength(2);
    for (const row of groups.flatMap((group) => group.rows))
      expect(["running", "queued", "finished", "notice"]).toContain(row.kind);
  });

  test("each row says its work, its place and its age; a stuck item is a notice row with its work to open", () => {
    const groups = feedSheet(sections, NOW);
    const running = groups.find((group) => group.id === "running")?.rows ?? [];
    expect(running.map((row) => row.key)).toEqual(["work:w-run-1f2", "work:w-run-2e8"]);
    expect(running[0]?.meta).toContain("broomva");
    expect(running[0]?.target.item?.id).toBe("w-run-1f2");
    const health = groups.find((group) => group.id === "health")?.rows ?? [];
    expect(health.length).toBe(notices.rows.length);
    expect(health.every((row) => row.kind === "notice")).toBe(true);
  });

  test("only a row that can be snoozed offers Snooze, and only finished work offers Continue", () => {
    const groups = feedSheet(sections, NOW);
    for (const row of groups.flatMap((group) => group.rows)) {
      if (row.verbs.snooze) expect(row.target.notice?.verb.id).toBe("snooze");
      if (row.verbs.continue) expect(row.kind).toBe("finished");
    }
  });

  test("the counts are the lengths of what the sheet lists, and handled.list's today", () => {
    const counts = feedCounts(sections, handled);
    expect(counts.map((count) => count.label)).toEqual([
      `${sections.running.length} running`,
      `${sections.finished.length} finished`,
      `${sections.health.length} health`,
      "22 handled",
    ]);
    // An unread handled.list says so; it is never 0 handled.
    expect(feedCounts(sections, null).at(-1)?.label).toBe("handled: not read");
  });
});

describe("the Decisions sheet's counts are answers.status's", () => {
  const status: AnswersStatus = {
    waitingToLand: 27,
    landing: null,
    routed: 3,
    acted: 41,
    held: 2,
    window: 46,
    recent: [],
  };
  test("waiting to land is loudest, in warn; the rest are plain", () => {
    expect(answersCounts(status)).toEqual([
      { id: "waiting", label: "27 waiting to land", tone: "warn" },
      { id: "routed", label: "3 routed" },
      { id: "acted", label: "41 acted" },
      { id: "held", label: "2 held" },
    ]);
    expect(answersCounts({ ...status, waitingToLand: 0 })[0]).toEqual({ id: "waiting", label: "0 waiting to land" });
  });

  test("an unread status is said, never zeros", () => {
    expect(answersCounts(null)).toEqual([{ id: "unread", label: "answers: not read", tone: "warn" }]);
  });
});

describe("a failed read is never 'nothing needs you'", () => {
  test("pending, failed and read are three different sentences", () => {
    expect(deckEmptyWords("pending", "feed")).toBe("Reading what needs you…");
    expect(deckEmptyWords("error", "feed")).toBe("Couldn't read what needs you.");
    expect(deckEmptyWords("ok", "feed")).toBe("Nothing needs you.");
    expect(deckEmptyWords("ok", "decisions")).toBe("No ask is open: nothing waits on you.");
  });

  test("a source needs.list could not read is named, and an empty deck over it is never 'nothing needs you' (BRO-3008)", () => {
    expect(unreadWords(undefined)).toBeNull();
    expect(unreadWords([])).toBeNull();
    expect(unreadWords(["asks", "work"])).toBe("Couldn't read asks, work: what needs you may be missing holds.");
    expect(unreadWords(["the fleet"], "health")).toBe("Couldn't read the fleet: notices may be missing.");
    expect(deckEmptyWords("ok", "feed", ["asks"])).toBe("Couldn't read what needs you (asks).");
    expect(deckEmptyWords("ok", "decisions", ["asks"])).not.toContain("No decision waits");
    expect(deckEmptyWords("ok", "feed", [])).toBe("Nothing needs you.");
  });
});

describe("pages and what each tab's empty deck says", () => {
  test("an intent that names a view opens it as a page; the others are not pages", () => {
    expect(pageOfIntent({ kind: "fleet", scope: "sri" })).toEqual({ kind: "fleet", scope: "sri", tick: null });
    expect(pageOfIntent({ kind: "timeline" })).toEqual({ kind: "timeline" });
    expect(pageOfIntent({ kind: "loops" })).toEqual({ kind: "loops" });
    expect(pageOfIntent({ kind: "initiatives" })).toEqual({ kind: "initiatives" });
    expect(pageOfIntent({ kind: "new" })).toBeNull();
    expect(pageOfIntent({ kind: "select", id: "w" })).toBeNull();
    expect(pageOfIntent({ kind: "decisions" })).toBeNull();
  });

  test("Initiatives says where it came from, the rest name themselves", () => {
    expect(pageTrail({ kind: "initiatives" })).toEqual(["from Health"]);
    expect(pageTrail({ kind: "fleet", scope: null, tick: null })).toEqual(["Fleet"]);
  });

  test("a failed or unread read names what it could not read, never 'nothing'", () => {
    expect(deckEmptyWords("error", "health")).toBe("Couldn't read the notices.");
    expect(deckEmptyWords("error", "work")).toBe("Couldn't read the work that needs you.");
    expect(deckEmptyWords("ok", "health", ["the fleet"])).toBe("Couldn't read the notices (the fleet).");
    expect(deckEmptyWords("pending", "work")).toBe("Reading the work that needs you…");
    expect(deckEmptyWords("ok", "health")).toBe("Nothing is asking for a look.");
    expect(deckEmptyWords("ok", "work")).toBe("No work needs you.");
  });
});

// BRO-3140 (deciding BRO-3113): every open ask is on the Decisions deck, holds first, then the rest, each labelled.
describe("every open ask on the Decisions deck", () => {
  const quiet = (id: string, extra: Partial<DecisionAsk> = {}) =>
    ask(id, { blocking: false, waiting: false, ...extra });
  const hours = (n: number) => new Date(NOW - n * 3_600_000).toISOString();
  const idea = (id: string, extra: Partial<DecisionAsk> = {}) =>
    quiet(id, {
      ledger: "ideas-factory-learnings.yaml",
      options: [
        { id: "develop", label: "Develop", consequence: null, reversible: true, recommended: false },
        { id: "park", label: "Park until 2026-11-02", consequence: null, reversible: true, recommended: true },
        { id: "kill", label: "Kill", consequence: null, reversible: true, recommended: false },
      ],
      idea: { initiative: "factory-learnings", idea: `idea ${id}`, source: null, evidence: null, wake: "2026-11-02" },
      ...extra,
    });

  test("the owner's live case: every open ask is an idea and none waits, and the deck lists all of them", () => {
    // 2026-10-16 03:20Z, asks.workspace on the live daemon: 23 open asks, every one an idea; needs.list held none.
    const asks = Array.from({ length: 23 }, (_, n) => idea(`I${n + 1}`, { askedAt: hours(30 - n) }));
    const held = needsOf({ items: [], asks, reviews: [], landing: null, workspace: "broomva" }, NOW).rows;
    expect(held).toHaveLength(0);
    const cards = decisionCards([], openAsks(asks, "broomva", null, NOW));
    expect(cards).toHaveLength(23);
    expect(cards.every((card) => card.lane === "idea")).toBe(true);
    expect(decisionCountWords(cards)).toBe("23 open · none waits on you · 23 ideas");
    // Each card answers its ask through the same verb as a hold, with the idea's own options.
    const item = holdInspector((cards[0] as (typeof cards)[number]).entry, NOW);
    expect(item.kind).toBe("ask");
    expect(item.kind === "ask" ? item.options.map((option) => option.id) : []).toEqual(["develop", "park", "kill"]);
  });

  test("every open ask is on the deck once: the holds first, then those that wait, then the rest, then ideas", () => {
    const asks = [
      ask("W1", { askedAt: hours(1) }),
      quiet("Q1", { askedAt: hours(5) }),
      quiet("Q2", { askedAt: hours(2) }),
      // Not blocking, but it recommends what cannot be undone: a hold (isWaiting).
      quiet("W2", {
        waiting: true,
        options: [{ id: "all", label: "Install fleet-wide", consequence: null, reversible: false, recommended: true }],
        askedAt: hours(4),
      }),
      idea("I1", { askedAt: hours(9) }),
      ask("D1", { state: "answered", waiting: false }),
    ];
    const needs = needsOf({ items: [], asks, reviews: [], landing: null, workspace: "broomva" }, NOW);
    const holds = decisionsDeck(needsSection(needs.rows, [], asks));
    const cards = decisionCards(holds, openAsks(asks, "broomva", null, NOW, new Set(holds.map((e) => e.row.key))));
    expect(holds.map((entry) => entry.ask?.id).sort()).toEqual(["W1", "W2"]);
    expect(cards.map((card) => [card.entry.ask?.id, card.lane])).toEqual([
      ...holds.map((entry) => [entry.ask?.id, "waits"]),
      ["Q1", "open"],
      ["Q2", "open"],
      ["I1", "idea"],
    ]);
    const keys = cards.map((card) => card.entry.row.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(cards).toHaveLength(asks.filter((one) => one.state === "open").length);
  });

  test("an ask that waits but is not held (its prompt session holds it, or asks were unread) is on the deck, labelled", () => {
    // BRO-3112: subtracting by held key, not by `waiting`, so no open ask is on neither the deck nor the list.
    const asks = [quiet("W2", { waiting: true }), quiet("Q1")];
    const rows = openAsks(asks, "broomva", null, NOW, new Set());
    expect(rows.map((row) => [row.entry.ask?.id, row.lane])).toEqual([
      ["W2", "waits"],
      ["Q1", "open"],
    ]);
  });

  test("a row names its ledger, whether it can be undone, its age and what silence does", () => {
    const [row] = openAsks(
      [
        quiet("Q1", {
          ledger: "leadership-20261013.yaml",
          scope: "sri",
          askedAt: hours(3),
          fallback: "off",
          options: [{ id: "off", label: "Keep them off", consequence: null, reversible: true, recommended: true }],
        }),
      ],
      "broomva",
      null,
      NOW,
    );
    expect(row).toMatchObject({
      title: "Install the three mods Q1?",
      meta: "sri · leadership-20261013 · reversible",
      age: "3h",
      silent: "silent → Keep them off",
      lane: "open",
    });
  });

  test("a workspace chip narrows them as it narrows the holds: the control repo's own asks carry its name", () => {
    const asks = [quiet("Q1"), quiet("Q2", { scope: "sri" }), idea("I1")];
    expect(openAsks(asks, "broomva", null, NOW)).toHaveLength(3);
    expect(openAsks(asks, "broomva", "sri", NOW).map((row) => row.entry.ask?.id)).toEqual(["Q2"]);
    expect(openAsks(asks, "broomva", "broomva", NOW).map((row) => row.entry.ask?.id)).toEqual(["Q1", "I1"]);
    expect(workspaceNameOf("/Users/me/broomva")).toBe("broomva");
    expect(workspaceNameOf(undefined)).toBe("workspace");
  });

  test("the count line says how many wait on you", () => {
    const waits = { entry: { row: { key: "a" } }, lane: "waits" } as never;
    const open = { entry: { row: { key: "b" } }, lane: "open" } as never;
    expect(decisionCountWords([waits, open])).toBe("2 open · 1 waits on you");
    expect(decisionCountWords([waits, waits, open])).toBe("3 open · 2 wait on you");
  });

  test("an ask that cannot be answered here carries its refusal onto the card, which offers no Answer (BRO-3111)", () => {
    const refused = quiet("R1", { refusal: "Two asks in x.yaml are named R1 and neither has a uid." });
    const [row] = openAsks([refused], "broomva", null, NOW);
    if (!row) throw new Error("the refused ask is not listed");
    const item = holdInspector(row.entry, NOW);
    expect(item.kind === "ask" ? item.refusal : null).toContain("named R1");
    const verbs = withoutRefused(item, deckVerbs(item, false));
    expect(verbs.map((verb) => verb.id)).not.toContain("answer");
    const [ok] = openAsks([quiet("Q1")], "broomva", null, NOW);
    if (!ok) throw new Error("the ask is not listed");
    const fine = holdInspector(ok.entry, NOW);
    expect(withoutRefused(fine, deckVerbs(fine, false)).map((verb) => verb.id)).toContain("answer");
  });
});

// BRO-3094: a refetch that failed over data read before is stale, said, and never concluded from.
describe("a stale read", () => {
  test("data with a failed refetch is stale, not ok; no data and a failure is an error", () => {
    expect(readOf({ data: { rows: [] }, isError: false })).toBe("ok");
    expect(readOf({ data: { rows: [] }, isError: true })).toBe("stale");
    expect(readOf({ data: undefined, isError: true })).toBe("error");
    expect(readOf({ data: undefined, isError: false })).toBe("pending");
    expect(bothRead("ok", "stale")).toBe("stale");
    expect(bothRead("pending", "error")).toBe("error");
    expect(bothRead("ok", "pending")).toBe("pending");
  });

  test("an empty deck over a stale read never says nothing waits", () => {
    expect(deckEmptyWords("stale", "decisions")).not.toContain("nothing waits");
    expect(deckEmptyWords("stale", "feed")).not.toBe("Nothing needs you.");
    expect(deckEmptyWords("stale", "decisions")).toContain("may be out of date");
    expect(staleWords(NOW - 5 * 60_000, NOW)).toBe(
      "Couldn't read again: this is the read from 5m ago, and may be out of date.",
    );
  });
});
