import { describe, expect, test } from "bun:test";
import type { DecisionAsk } from "../shared/fleet";
import { fakeWork } from "./fake-work";
import {
  cardHint,
  cardOf,
  DECIDE_INLINE,
  decideOf,
  handledTitle,
  headerLine,
  matchesQuery,
  sectionsOf,
  ticketOf,
  UNNAMED,
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
  test("Handled for you holds what Maestro closed this week, by who handed it over; Done holds yours", () => {
    const items = [
      fakeWork("g", "review", live),
      fakeWork("b", "blocked", live),
      fakeWork("r", "running", live),
      fakeWork("q", "proposed"),
      fakeWork("h1", "done", null, {
        closed: { by: "maestro", at: "2026-10-08T11:00:00Z" },
        adoptedBy: { by: "SRI Orchestrator" },
      }),
      fakeWork("h2", "done", null, { closed: { by: "maestro", at: "2026-10-08T10:00:00Z" }, adoptedBy: { by: null } }),
      fakeWork("old", "done", null, { closed: { by: "maestro", at: "2026-09-20T10:00:00Z" } }),
      fakeWork("y1", "done", null, { closed: { by: "you", at: "2026-10-08T09:00:00Z" } }),
      fakeWork("y2", "canceled", null, { closed: { by: "you", at: "2026-10-05T09:00:00Z" } }),
    ];
    const sections = sectionsOf(items, NOW);
    expect(sections.gate.map((item) => item.id)).toEqual(["g", "b"]);
    expect([sections.running.map((i) => i.id), sections.queued.map((i) => i.id)]).toEqual([["r"], ["q"]]);
    expect(sections.handled.count).toBe(2);
    expect(sections.handled.groups.map((group) => [group.by, group.items.map((i) => i.id)])).toEqual([
      ["SRI Orchestrator", ["h1"]],
      ["Their orchestrators", ["h2"]],
    ]);
    // A week-old close by Maestro is no longer "handled for you": it is in Done with yours.
    expect([sections.done.count, sections.done.today, sections.done.week]).toEqual([3, 1, 2]);
  });

  test("the header says what needs you, what runs, and what was handled for you", () => {
    const sections = sectionsOf(
      [
        fakeWork("r", "running", live),
        fakeWork("h", "done", null, { closed: { by: "maestro", at: "2026-10-08T11:00:00Z" } }),
      ],
      NOW,
    );
    expect([headerLine(6, sections), headerLine(0, sectionsOf([], NOW))]).toEqual([
      "6 need you · 1 running · 1 handled for you",
      "Nothing needs you",
    ]);
    expect(handledTitle({ by: "SRI Orchestrator", items: sections.handled.groups[0]?.items ?? [] })).toBe(
      "From SRI Orchestrator: 1 arc closed",
    );
  });
});

describe("Handled for you's group titles (BRO-2928)", () => {
  test("name who handed the arcs over, never who closed them; Maestro's own read in the singular too", () => {
    const one = [fakeWork("h", "done", null)];
    expect([
      handledTitle({ by: "Maestro", items: one }),
      handledTitle({ by: "Maestro", items: [...one, ...one] }),
      handledTitle({ by: "SRI Orchestrator", items: [...one, ...one] }),
    ]).toEqual([
      "Maestro closed 1 arc that finished on its own",
      "Maestro closed 2 arcs that finished on their own",
      "From SRI Orchestrator: 2 arcs closed",
    ]);
    // An adopter that gave no name reads in the sentence's case.
    expect(handledTitle({ by: UNNAMED, items: one })).toBe("From their orchestrators: 1 arc closed");
  });
});

describe("Decide", () => {
  test("open asks only, those that block work first, a few inline and how many more", () => {
    const asks = [
      ask("A1", { askedAt: "2026-10-01T00:00Z" }),
      ask("A2", { blocking: true, askedAt: "2026-10-03T00:00Z" }),
      ask("A3", { askedAt: "2026-10-02T00:00Z" }),
      ask("A4", { askedAt: "2026-10-04T00:00Z" }),
      ask("A5", { state: "answered" }),
      ask("A6", { idea: { initiative: "x" } as never }),
    ];
    const decide = decideOf(asks);
    expect(decide.rows.map((row) => row.ask.id)).toEqual(["A2", "A1", "A3"]);
    expect([decide.rows.length, decide.more, decide.blocking]).toEqual([DECIDE_INLINE, 1, 1]);
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
