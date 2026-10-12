import { describe, expect, test } from "bun:test";
import { needsOf } from "../server/needs";
import type { DecisionAsk } from "../shared/fleet";
import type { HandledRow } from "../shared/needs";
import { fakeWork } from "./fake-work";
import {
  cardHint,
  cardOf,
  DECIDE_INLINE,
  decideOf,
  handledGroups,
  handledTitle,
  headerLine,
  matchesQuery,
  needsByInitiative,
  needsSection,
  sectionsOf,
  ticketOf,
} from "./feed-model";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const live = { agentId: "a1", workspaceId: "w1" };

const ask = (id: string, extra: Partial<DecisionAsk> = {}): DecisionAsk => ({
  ledger: "bro-2909-r2.yaml",
  uid: null,
  id,
  hash: "0123456789abcdef",
  arc: null,
  headline: `Ask ${id}?`,
  question: null,
  stakes: null,
  whyYou: null,
  options: [],
  fallback: null,
  blocking: false,
  askedAt: null,
  answeredAt: null,
  answer: null,
  answerOption: null,
  state: "open",
  origin: null,
  refusal: null,
  home: { kind: "main", path: "/repo", branch: null },
  batched: false,
  waiting: false,
  ...extra,
});

describe("the feed's sections", () => {
  test("stuck work has its own section (watched, A1); Done holds yours and what was handled over a week ago", () => {
    const items = [
      fakeWork("g", "review", live),
      fakeWork("b", "blocked", live),
      fakeWork("r", "running", live),
      fakeWork("quiet", "running", live, { flag: { kind: "quiet", reason: "Quiet.", at: "2026-10-08T11:00:00Z" } }),
      fakeWork("q", "proposed"),
      fakeWork("yours", "proposed", null, { flag: { kind: "yours", reason: "Held.", at: "2026-10-08T11:00:00Z" } }),
      fakeWork("h1", "done", null, {
        closed: { by: "maestro", at: "2026-10-08T11:00:00Z" },
        adoptedBy: { by: "SRI Orchestrator" },
      }),
      fakeWork("old", "done", null, { closed: { by: "maestro", at: "2026-09-20T10:00:00Z" } }),
      fakeWork("y1", "done", null, { closed: { by: "you", at: "2026-10-08T09:00:00Z" } }),
      fakeWork("y2", "canceled", null, { closed: { by: "you", at: "2026-10-05T09:00:00Z" } }),
    ];
    const sections = sectionsOf(items, NOW);
    expect(sections.stuck.map((item) => item.id)).toEqual(["b"]);
    // A quiet run is watched: it stays under Running. Work only you may start is a hold, not Queued.
    expect([sections.running.map((i) => i.id), sections.queued.map((i) => i.id)]).toEqual([["r", "quiet"], ["q"]]);
    // A week-old close by Maestro is no longer "handled for you": it is in Done with yours.
    expect([sections.done.count, sections.done.today, sections.done.week]).toEqual([3, 1, 2]);
  });

  test("the header says what needs you, what runs, and what was handled for you", () => {
    expect([headerLine(6, 1, 1), headerLine(0, 0, 0), headerLine(1, 0, 0)]).toEqual([
      "6 need you · 1 running · 1 handled for you",
      "Nothing needs you",
      "1 needs you",
    ]);
  });
});

describe("Needs you on the Feed (BRO-3001)", () => {
  const blocking = ask("A1", {
    blocking: true,
    waiting: true,
    askedAt: "2026-10-08T08:00:00Z",
    initiative: "hawthorne",
  });
  const items = [
    fakeWork("g", "review", live, { initiative: "hawthorne", updatedAt: "2026-10-08T09:00:00Z" }),
    fakeWork("p", "review", live, { initiative: "genesis", updatedAt: "2026-10-08T10:00:00Z" }),
    fakeWork("b", "blocked", live, { initiative: "hawthorne" }),
  ];
  const needs = needsOf({ items, asks: [blocking], reviews: [], landing: null, workspace: "broomva" }, NOW);

  test("lists every row needs.list holds, in its order, joined to its work or ask: as many as the header counts", () => {
    const entries = needsSection(needs.rows, items, [blocking]);
    expect(entries).toHaveLength(needs.summary.total);
    expect(entries.map((entry) => entry.row.key)).toEqual(needs.rows.map((row) => row.key));
    expect(entries.map((entry) => [entry.item?.id ?? null, entry.ask?.id ?? null])).toEqual([
      [null, "A1"],
      ["g", null],
      ["p", null],
    ]);
  });

  test("each initiative's count is the length of the section its scope lists: its work, its asks, its review", () => {
    const review = {
      id: "genesis",
      file: "genesis.yaml",
      title: "genesis",
      quote: null,
      summary: null,
      nextAction: null,
      driver: null,
      waitingOn: [],
      sessions: [],
      stale: { kind: "overdue", date: "2026-10-01" },
    } as unknown as Parameters<typeof needsOf>[0]["reviews"][number];
    const all = needsOf({ items, asks: [blocking], reviews: [review], landing: null, workspace: "broomva" }, NOW);
    const counts = needsByInitiative(needsSection(all.rows, items, [blocking]));
    expect([...counts].sort()).toEqual([
      ["genesis", 2],
      ["hawthorne", 2],
    ]);
    for (const [initiative, count] of counts) {
      expect([initiative, count]).toEqual([initiative, needsSection(all.rows, items, [blocking], initiative).length]);
    }
  });

  test("a hold this client cannot join still shows, as its row", () => {
    const entries = needsSection(needs.rows, [], []);
    expect(entries.map((entry) => [entry.row.key, entry.item, entry.ask])).toEqual(
      needs.rows.map((row) => [row.key, null, null]),
    );
  });

  test("a scope keeps its initiative's holds; a search keeps the rows it matches", () => {
    expect(needsSection(needs.rows, items, [blocking], "hawthorne").map((entry) => entry.row.key)).toEqual([
      needs.rows[0]?.key,
      "work:g",
    ]);
    expect(needsSection(needs.rows, items, [blocking], null, "work p").map((entry) => entry.row.key)).toEqual([
      "work:p",
    ]);
    expect(needsSection(needs.rows, items, [blocking], null, "ask a1").map((entry) => entry.row.key)).toEqual([
      needs.rows[0]?.key,
    ]);
  });
});

describe("Handled for you (handled.list)", () => {
  const row = (key: string, closedBy: HandledRow["closedBy"]): HandledRow => ({
    key,
    title: key,
    closedBy,
    reason: "Done",
    at: "2026-10-08T10:00:00Z",
  });

  test("groups what closed without you by who closed it, gates first; yours are not here", () => {
    const rows = [row("a", "maestro"), row("b", "you"), row("c", "gates"), row("d", "orchestrator"), row("e", "gates")];
    expect(handledGroups(rows).map((group) => [group.by, group.rows.map((entry) => entry.key)])).toEqual([
      ["gates", ["c", "e"]],
      ["orchestrator", ["d"]],
      ["maestro", ["a"]],
    ]);
    expect(handledGroups([row("b", "you")])).toEqual([]);
  });

  test("each group's title says who closed the arcs, in the singular too", () => {
    const one = [row("a", "maestro")];
    expect([
      handledTitle({ by: "maestro", rows: one }),
      handledTitle({ by: "maestro", rows: [...one, ...one] }),
      handledTitle({ by: "orchestrator", rows: [...one, ...one] }),
      handledTitle({ by: "gates", rows: one }),
    ]).toEqual([
      "Maestro closed 1 arc that finished on its own",
      "Maestro closed 2 arcs that finished on their own",
      "From their orchestrators: 2 arcs closed",
      "The gates closed 1 arc",
    ]);
  });
});

describe("Decide", () => {
  test("open asks that do not wait on you, oldest first, a few inline and how many more", () => {
    const asks = [
      ask("A1", { askedAt: "2026-10-01T00:00Z" }),
      ask("A2", { askedAt: "2026-10-03T00:00Z" }),
      ask("A3", { askedAt: "2026-10-02T00:00Z" }),
      ask("A4", { askedAt: "2026-10-04T00:00Z" }),
      ask("A5", { state: "answered" }),
      ask("A6", { idea: { initiative: "x" } as never }),
      // It waits on you: a hold, under Needs you, never here too.
      ask("A7", { blocking: true, waiting: true, askedAt: "2026-09-01T00:00Z" }),
    ];
    const decide = decideOf(asks);
    expect(decide.rows.map((row) => row.ask.id)).toEqual(["A1", "A3", "A2"]);
    expect([decide.rows.length, decide.more]).toEqual([DECIDE_INLINE, 1]);
    expect(decide.rows[0]?.where).toBe("bro-2909-r2");
  });

  test("what silence does reads `silent → <option>`, or nothing when the ledger does not say", () => {
    const withDefault = ask("A1", {
      fallback: "hold",
      options: [{ id: "hold", label: "Hold it", consequence: "", reversible: true, recommended: false } as never],
    });
    expect([decideOf([withDefault]).rows[0]?.silent, decideOf([ask("A2")]).rows[0]?.silent]).toEqual([
      "silent → Hold it",
      null,
    ]);
  });
});

describe("a card", () => {
  test("at your gate with an ask: its source, the ask, Needs you, Answer, and the lead border", () => {
    const card = cardOf(
      fakeWork("g", "review", live, {
        title: "SRI: STI-3508 Enroll the staging smoke identity",
        adoptedBy: { by: "SRI Orchestrator" },
        verdict: "All 6 checks passed",
        changed: { additions: 412, deletions: 38 },
        look: { ran: "", decided: [], ask: "Enrol the identity: steps in §3.6." },
      }),
      NOW,
    );
    expect([card.source, card.via, card.ask, card.pill.label, card.action, card.lead, card.session]).toEqual([
      ["sri", "STI-3508"],
      "via SRI Orchestrator",
      { kind: "ask", text: "Enrol the identity: steps in §3.6." },
      "Needs you",
      "Answer",
      true,
      "session idle",
    ]);
    expect(card.evidence?.text).toContain("All 6 checks passed");
  });

  test("an answer's work with no ask quotes its last words, and offers Review", () => {
    const card = cardOf(
      fakeWork("a", "review", live, {
        title: "Act on your answer: Add a status_quo key",
        permission: null,
        look: { ran: "", decided: [], ask: "", closing: "I've added the key, with tests." },
      }),
      NOW,
    );
    expect([card.via, card.title, card.ask, card.action]).toEqual([
      "your answer",
      "Add a status_quo key",
      { kind: "words", text: 'No ask written. Its last words: "I\'ve added the key, with tests."' },
      "Review",
    ]);
  });

  test("a stuck fleet tick is an Alert with its reason and Open log; a stuck run is Stuck with Look", () => {
    const fleet = cardOf(
      fakeWork("f", "blocked", null, {
        reason: "Transport not connected",
        display: { title: "The SRI fleet tick failed", fleet: { scope: "sri", what: "alert", tick: "37" } },
      }),
      NOW,
    );
    expect([fleet.source, fleet.pill, fleet.action, fleet.session, fleet.ask?.kind]).toEqual([
      ["fleet", "sri tick 37"],
      { label: "Alert", tone: "danger" },
      "Open log",
      "no session",
      "reason",
    ]);
    const stuck = cardOf(fakeWork("s", "blocked", live, { reason: "rate limited" }), NOW);
    expect([stuck.pill.label, stuck.action]).toEqual(["Stuck", "Look"]);
  });

  test("a running arc an orchestrator adopted says the orchestrator decides; yours lands at your gate", () => {
    const adopted = cardOf(
      fakeWork("r", "running", live, { lastEventAt: "2026-10-08T11:58:00Z", adoptedBy: { by: null } }),
      NOW,
    );
    const yours = cardOf(fakeWork("r2", "running", live, { lastEventAt: "2026-10-08T11:58:00Z" }), NOW);
    expect([adopted.pill.label, adopted.session, yours.session, adopted.action]).toEqual([
      "Running",
      "orchestrator decides",
      "lands at your gate",
      null,
    ]);
    expect(adopted.evidence?.text).toContain("last activity 2m ago");
    // Inside the minute it reads as words, never "now ago".
    const fresh = cardOf(fakeWork("r3", "running", live, { lastEventAt: "2026-10-08T11:59:40Z" }), NOW);
    expect(fresh.evidence?.text).toContain("active just now");
    expect(fresh.evidence?.text).not.toContain("now ago");
  });

  test("failed checks are not drawn as a pass", () => {
    // verdictOf's words (server/events.ts): one check, several, and a pass.
    const evidence = ["1 of 1 check failed", "2 of 3 checks failed", "All 3 checks passed", "Check passed"].map(
      (verdict) => cardOf(fakeWork("v", "review", live, { verdict }), NOW).evidence,
    );
    expect(evidence.map((e) => [e?.icon, e?.tone])).toEqual([
      ["CircleX", "danger"],
      ["CircleX", "danger"],
      ["CircleCheck", "success"],
      ["CircleCheck", "success"],
    ]);
  });

  test("a card's hint says the verb it opens to and what it asks", () => {
    expect([
      cardHint({ action: "Answer", ask: { kind: "ask", text: "Enrol the identity." } }),
      cardHint({ action: null, ask: null }),
    ]).toEqual(["Opens it to answer. Enrol the identity.", "Opens it"]);
  });
});

describe("search", () => {
  test("matches title, ticket, branch and who adopted it, case-folded; an empty query matches all", () => {
    const item = fakeWork(
      "x",
      "review",
      { agentId: "a", workspaceId: null },
      {
        title: "SRI: STI-3508 Enroll identity",
        worker: { agentId: "a", workspaceId: null, provider: "claude", branch: "feature/sti-3508-smoke", cwd: null },
        adoptedBy: { by: "SRI Orchestrator" },
      },
    );
    expect(["sti-3508", "SMOKE", "orchestrator", "", "nothing like it"].map((q) => matchesQuery(item, q))).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
    expect([ticketOf("Act on BRO-2827 now"), ticketOf("no ticket here")]).toEqual(["BRO-2827", null]);
  });
});
