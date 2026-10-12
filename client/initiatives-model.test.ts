import { describe, expect, test } from "bun:test";
import { reviewNeed } from "../server/needs";
import type { DecisionAsk } from "../shared/fleet";
import type { Initiative } from "../shared/initiatives";
import {
  addDays,
  dateLine,
  defaultWake,
  driverText,
  evidenceUrl,
  ideaOutcome,
  ideasText,
  initiativesMeta,
  reviewNoticeText,
  waitingText,
  wakeProblem,
} from "./initiatives-model";

const initiative = (extra: Partial<Initiative>): Initiative =>
  ({
    id: "x",
    status: "active",
    reviewBy: "2026-10-10",
    wake: null,
    closedAt: null,
    stale: null,
    error: null,
    sessions: [],
    ...extra,
  }) as Initiative;

describe("the card's words", () => {
  test("the date line follows the status, and the badge only a passed date", () => {
    expect(dateLine(initiative({}), "2026-10-05")).toEqual({ text: "Review by 2026-10-10", badge: null });
    expect(dateLine(initiative({ stale: { kind: "overdue", date: "2026-10-10" } }), "2026-10-11")).toEqual({
      text: "Review by 2026-10-10",
      badge: "Overdue",
    });
    const parked = initiative({ status: "parked", wake: "2026-10-31", stale: { kind: "wake", date: "2026-10-31" } });
    expect(dateLine(parked, "2026-10-31").badge).toBe("Wakes today");
    expect(dateLine(parked, "2026-11-02").badge).toBe("Wake date passed");
    expect(dateLine(initiative({ status: "done", closedAt: "2026-10-04" }), "2026-10-05")).toEqual({
      text: "Closed 2026-10-04",
      badge: null,
    });
  });

  test("drivers and waits in words", () => {
    expect(["owner", "fleet", "none", "coordinator:f5307ce7", "session:abc"].map(driverText)).toEqual([
      "Driven by you",
      "Driven by the fleet",
      "No driver",
      "Driven by the coordinator f5307ce7",
      "Driven by the session abc",
    ]);
    expect(waitingText({ kind: "ask", ref: "a.yaml#A1", note: "soon", ledger: "a.yaml", askId: "A1" })).toBe(
      "Your answer to a.yaml A1 (soon)",
    );
    expect(waitingText({ kind: "ask", ref: "a.yaml", note: null, ledger: "a.yaml", askId: null })).toBe(
      "Your answer to a.yaml",
    );
  });

  test("evidence opens when it is a ticket, a PR or a URL; a path is read, not opened", () => {
    expect(evidenceUrl("BRO-2810")).toBe("https://linear.app/broomva/issue/BRO-2810");
    expect(evidenceUrl("broomva/skills#267")).toBe("https://github.com/broomva/skills/pull/267");
    expect(evidenceUrl("https://x.example/y")).toBe("https://x.example/y");
    expect(evidenceUrl("research/entities/x.md")).toBeNull();
    expect(evidenceUrl(null)).toBeNull();
  });

  test("ideas, counts and notices", () => {
    expect(ideasText({ open: 0, triaged: 0 })).toBe("No ideas filed");
    expect(ideasText({ open: 1, triaged: 0 })).toBe("1 idea: 1 open, 0 triaged");
    const list = [initiative({ stale: { kind: "overdue", date: "2026-10-01" } }), initiative({ error: "bad" })];
    const ideas = [{ state: "open" }, { state: "answered" }] as DecisionAsk[];
    expect(initiativesMeta(list, ideas)).toBe("2 initiatives · 1 needs you · 1 cannot be read · 1 open idea");
    // Due reviews, as needs.list raises them (B2): each titled with its initiative and saying why.
    const due = [
      reviewNeed(
        initiative({ id: "a", title: "A", waitingOn: [], stale: { kind: "wake", date: "2026-10-31" } }),
        [],
        [],
        "broomva",
      ),
      reviewNeed(
        initiative({ id: "b", title: "B", waitingOn: [], stale: { kind: "overdue", date: "2026-10-01" } }),
        [],
        [],
        "broomva",
      ),
    ].filter((row) => row !== null);
    expect(reviewNoticeText(due)).toBe("2 initiative reviews are due: Review A: keep, park or close? (+1 more)");
    expect(reviewNoticeText(due.slice(1))).toBe(
      "Review B: keep, park or close? Its review date, 2026-10-01, has passed.",
    );
    expect(reviewNoticeText([])).toBe("");
    const answered = (option: string) =>
      ({
        state: "answered",
        answerOption: option,
        answeredAt: "2026-10-06T10:00Z",
        idea: { wake: "2026-12-01" },
      }) as DecisionAsk;
    expect(ideaOutcome(answered("park"))).toBe("Parked on 2026-10-06 until 2026-12-01.");
    expect(ideaOutcome(answered("kill"))).toBe("Killed on 2026-10-06.");
  });
});

describe("the wake date", () => {
  test("the idea's own while it is ahead, else thirty days on; by the calendar, across a month end", () => {
    expect(defaultWake("2026-11-02", "2026-10-05")).toBe("2026-11-02");
    expect(defaultWake("2026-10-01", "2026-10-05")).toBe("2026-11-04");
    expect(defaultWake(null, "2026-12-15")).toBe("2027-01-14");
    expect(addDays("2026-02-27", 2)).toBe("2026-03-01");
  });

  test("a wake must be a real date, today or later", () => {
    expect(wakeProblem("2026-10-05", "2026-10-05")).toBeNull();
    expect(wakeProblem("2026-10-04", "2026-10-05")).toBe("Choose today or a later day.");
    expect(wakeProblem("2026-13-01", "2026-10-05")).toBe("Write the date as YYYY-MM-DD.");
    expect(wakeProblem("tomorrow", "2026-10-05")).toBe("Write the date as YYYY-MM-DD.");
    // A day the calendar lacks, which Date.parse alone would roll into March.
    expect(wakeProblem("2027-02-30", "2026-10-05")).toBe("Write the date as YYYY-MM-DD.");
  });
});
