import { describe, expect, test } from "bun:test";
import type { DecisionAsk } from "../shared/fleet";
import { askNoticeText, groupDecisions, groupMeta, homeText } from "./decisions-model";

const ask = (ledger: string, id: string, extra: Partial<DecisionAsk> = {}): DecisionAsk => ({
  ledger,
  uid: null,
  id,
  hash: "0123456789abcdef",
  arc: null,
  headline: id,
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

describe("Decisions, a ledger at a time", () => {
  test("ledgers with an ask that waits on you first, then the most open; in each, waiting then oldest first", () => {
    const groups = groupDecisions([
      ask("b.yaml", "b1"),
      ask("b.yaml", "b2"),
      ask("a.yaml", "a1", { askedAt: "2026-10-02T00:00Z" }),
      ask("a.yaml", "a2", { askedAt: "2026-10-01T00:00Z" }),
      ask("a.yaml", "a3", { state: "answered", answeredAt: "2026-10-03T00:00Z" }),
      ask("z.yaml", "z1", { waiting: true, blocking: true }),
      ask("z.yaml", "z0", { askedAt: "2026-09-01T00:00Z" }),
    ]);
    expect(groups.map((group) => [group.ledger, group.open.map((entry) => entry.id), group.answered.length])).toEqual([
      ["z.yaml", ["z1", "z0"], 0],
      ["a.yaml", ["a2", "a1"], 1],
      ["b.yaml", ["b1", "b2"], 0],
    ]);
    expect(groups.map(groupMeta)).toEqual(["2 open · 1 waits on you", "2 open · 1 recently answered", "2 open"]);
  });

  test("where an answer goes, by the ask's home", () => {
    expect(homeText(ask("l.yaml", "A1"))).toContain("Its home is origin/main");
    expect(homeText(ask("l.yaml", "A1", { home: { kind: "checkout", path: "/w", branch: "feat/x" } }))).toBe(
      "Its home is the checkout /w, on feat/x, which has not landed it: your answer is written into l.yaml there, and goes with that branch.",
    );
    expect(homeText(ask("l.yaml", "A1", { home: { kind: "root", path: "/state", branch: null } }))).toBe(
      "Written into l.yaml.",
    );
  });

  test("the Needs you line: one ask by its headline; many by count, the blocking ones said", () => {
    const notice = (headline: string, blocking: boolean) => ({
      scope: null,
      ledger: "l.yaml",
      uid: null,
      id: headline,
      headline,
      blocking,
      askedAt: null,
    });
    expect(askNoticeText([])).toBe("");
    expect(askNoticeText([notice("Merge #863?", true)])).toBe("A decision waits on you: Merge #863?");
    expect(askNoticeText([notice("Merge #863?", true), notice("Send?", false)])).toBe(
      "2 decisions wait on you, 1 blocking: Merge #863?, and more.",
    );
  });
});
