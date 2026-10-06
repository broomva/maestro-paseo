import { describe, expect, test } from "bun:test";
import type { DecisionAsk } from "../shared/fleet";
import {
  answeredLine,
  answerVerb,
  askKey,
  askNoticeText,
  currentIndex,
  cutAtWord,
  fallbackLine,
  fallbackOption,
  groupDecisions,
  groupMeta,
  headlineOf,
  homeText,
  ledgerRail,
  metaLine,
  progressOf,
  recentlyAnswered,
  reversibility,
  triageKey,
  triageQueue,
  upNext,
  writtenTo,
} from "./decisions-model";

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

const option = (id: string, extra: Partial<DecisionAsk["options"][number]> = {}) => ({
  id,
  label: id,
  consequence: null,
  reversible: true,
  recommended: false,
  ...extra,
});
const ids = (asks: readonly DecisionAsk[]) => asks.map((entry) => entry.id);

describe("the Decisions tab's queue", () => {
  const asks = () => [
    ask("b.yaml", "old", { askedAt: "2026-09-01T00:00Z" }),
    ask("a.yaml", "new", { askedAt: "2026-10-04T00:00Z" }),
    ask("a.yaml", "irrev", { askedAt: "2026-10-03T00:00Z", waiting: true }),
    ask("c.yaml", "block", { askedAt: "2026-10-02T00:00Z", blocking: true, waiting: true }),
    ask("c.yaml", "undated"),
    ask("c.yaml", "done", { state: "answered", answeredAt: "2026-10-05T00:00Z" }),
    ask("ideas.yaml", "idea", {
      idea: { initiative: null, idea: null, source: null, evidence: null, wake: null },
    }),
  ];

  test("Blocking first: blocking, then the rest that wait on you, then oldest; never an answered ask or an idea", () => {
    expect(ids(triageQueue(asks(), { ordering: "blocking" }))).toEqual(["block", "irrev", "old", "new", "undated"]);
  });

  test("Oldest: by when each was asked, the undated last", () => {
    expect(ids(triageQueue(asks(), { ordering: "oldest" }))).toEqual(["old", "block", "irrev", "new", "undated"]);
  });

  test("By ledger: a ledger at a time in the rail's order, each waiting then oldest first", () => {
    expect(ids(triageQueue(asks(), { ordering: "ledger" }))).toEqual(["irrev", "new", "block", "undated", "old"]);
    expect(ledgerRail(asks()).map((entry) => entry.ledger)).toEqual(["a.yaml", "c.yaml", "b.yaml"]);
  });

  test("one ledger; a skipped ask goes last, in order, and is never dropped", () => {
    expect(ids(triageQueue(asks(), { ordering: "blocking", ledger: "c.yaml" }))).toEqual(["block", "undated"]);
    const skipped = new Set([askKey(ask("c.yaml", "block")), askKey(ask("a.yaml", "irrev"))]);
    expect(ids(triageQueue(asks(), { ordering: "blocking", skipped }))).toEqual([
      "old",
      "new",
      "undated",
      "block",
      "irrev",
    ]);
  });

  test("the rail: open counts, and a waiting count only where an ask waits on you", () => {
    expect(ledgerRail(asks())).toEqual([
      { ledger: "a.yaml", open: 2, waiting: 1 },
      { ledger: "c.yaml", open: 2, waiting: 1 },
      { ledger: "b.yaml", open: 1, waiting: 0 },
    ]);
  });

  test("an ask is keyed by its home, ledger and uid (else id)", () => {
    expect(askKey(ask("l.yaml", "A1"))).toBe("origin/main:l.yaml:A1");
    expect(askKey(ask("l.yaml", "A1", { uid: "u-1", home: { kind: "checkout", path: "/w", branch: null } }))).toBe(
      "/w:l.yaml:u-1",
    );
  });

  test("the current ask holds its place as the order changes; gone, the one at its old place comes up", () => {
    const queue = triageQueue(asks(), { ordering: "blocking" });
    expect(currentIndex(queue, askKey(ask("b.yaml", "old")), 0)).toBe(2);
    // Answered, it leaves the queue: the next one is at its place.
    const after = queue.filter((entry) => entry.id !== "old");
    expect(currentIndex(after, askKey(ask("b.yaml", "old")), 2)).toBe(2);
    expect(after[2]?.id).toBe("new");
    // The last one answered: the one before it.
    expect(currentIndex(after, null, 9)).toBe(3);
    expect(currentIndex([], null, 0)).toBe(-1);
  });

  test("up next is the three after the current; the progress says where you are", () => {
    const queue = triageQueue(asks(), { ordering: "blocking" });
    expect(ids(upNext(queue, 0))).toEqual(["irrev", "old", "new"]);
    expect(ids(upNext(queue, 3))).toEqual(["undated"]);
    expect(upNext(queue, -1)).toEqual([]);
    expect(progressOf(11, 49)).toEqual({ text: "Decision 12 of 49", fraction: 12 / 49 });
    expect(progressOf(-1, 0)).toEqual({ text: "No decisions open", fraction: 0 });
  });
});

describe("the keys", () => {
  const free = { typing: false, onControl: false, options: 3 };

  test("1-4 choose an option that exists; Enter answers; S skips; J and K move", () => {
    expect(triageKey({ key: "1" }, free)).toEqual({ kind: "choose", index: 0 });
    expect(triageKey({ key: "3" }, free)).toEqual({ kind: "choose", index: 2 });
    expect(triageKey({ key: "4" }, free)).toBeNull();
    expect(triageKey({ key: "5" }, { ...free, options: 6 })).toBeNull();
    expect(triageKey({ key: "Enter" }, free)).toEqual({ kind: "answer" });
    expect(triageKey({ key: "s" }, free)).toEqual({ kind: "skip" });
    expect(triageKey({ key: "S" }, free)).toEqual({ kind: "skip" });
    expect(triageKey({ key: "j" }, free)).toEqual({ kind: "next" });
    expect(triageKey({ key: "k" }, free)).toEqual({ kind: "previous" });
    expect(triageKey({ key: "x" }, free)).toBeNull();
  });

  test("nothing while you type, nothing with a modifier, and Enter is the focused control's", () => {
    for (const key of ["1", "Enter", "s", "j", "k"]) {
      expect(triageKey({ key }, { ...free, typing: true })).toBeNull();
      expect(triageKey({ key, metaKey: true }, free)).toBeNull();
      expect(triageKey({ key, ctrlKey: true }, free)).toBeNull();
      expect(triageKey({ key, altKey: true }, free)).toBeNull();
    }
    expect(triageKey({ key: "Enter" }, { ...free, onControl: true })).toBeNull();
    expect(triageKey({ key: "2" }, { ...free, onControl: true })).toEqual({ kind: "choose", index: 1 });
  });
});

describe("the card's words", () => {
  test("the headline is the ask's own; without one, the question's first sentence, the rest behind Full question", () => {
    expect(headlineOf(ask("l.yaml", "A1", { headline: "Merge it?", question: "Merge PR #1 now?" }))).toEqual({
      headline: "Merge it?",
      rest: "Merge PR #1 now?",
      derived: false,
    });
    expect(
      headlineOf(ask("l.yaml", "A2", { headline: null, question: "Rename this session? It helps peers find it." })),
    ).toEqual({
      headline: "Rename this session?",
      rest: "Rename this session? It helps peers find it.",
      derived: true,
    });
    expect(headlineOf(ask("l.yaml", "A3", { headline: null, question: "Sign in to Linear?" }))).toEqual({
      headline: "Sign in to Linear?",
      rest: null,
      derived: true,
    });
    const long = `Should ${"the fleet ".repeat(20)}stop?`;
    const cut = headlineOf(ask("l.yaml", "A4", { headline: null, question: long }));
    expect(cut.headline.endsWith(" the…")).toBe(true);
    expect(cut.headline.length).toBeLessThanOrEqual(121);
    expect(cut.rest).toBe(long);
    expect(headlineOf(ask("l.yaml", "A5", { headline: null, question: null }))).toEqual({
      headline: "A5",
      rest: null,
      derived: true,
    });
    expect(cutAtWord("one two three", 8)).toBe("one two…");
  });

  test("the meta line: ledger · id, age, blocking or not, and whether it can be undone", () => {
    const now = Date.parse("2026-10-05T00:00:00Z");
    expect(
      metaLine(
        ask("maestro-paseo-gaps.yaml", "A10", { askedAt: "2026-10-01T00:00:00Z", options: [option("a"), option("b")] }),
        now,
      ),
    ).toBe("maestro-paseo-gaps · A10 · asked 4d ago · not blocking · reversible");
    expect(
      metaLine(
        ask("l.yaml", "A1", { blocking: true, options: [option("a"), option("b", { reversible: false })] }),
        now,
      ),
    ).toBe("l · A1 · blocking · an option cannot be undone");
    expect(reversibility([option("a", { reversible: null })])).toBeNull();
    expect(reversibility([])).toBeNull();
  });

  test("if you say nothing, and when that is not the recommendation, it says so", () => {
    const options = [
      option("merge", { label: "Merge PR #863", recommended: true }),
      option("hold", { label: "Hold PR #863" }),
    ];
    expect(fallbackLine(ask("l.yaml", "A1", { fallback: "hold", options }))).toBe(
      "If you say nothing: hold. That is not the recommendation (Merge PR #863).",
    );
    expect(fallbackOption(ask("l.yaml", "A1", { fallback: "hold", options }))?.id).toBe("hold");
    expect(fallbackLine(ask("l.yaml", "A1", { fallback: "merge PR #863 once green", options }))).toBe(
      "If you say nothing: merge PR #863 once green",
    );
    // A default that names no option is said as written: nothing is claimed about it.
    expect(fallbackLine(ask("l.yaml", "A1", { fallback: "continue as is", options }))).toBe(
      "If you say nothing: continue as is",
    );
    expect(fallbackLine(ask("l.yaml", "A1", { fallback: null, options }))).toBeNull();
  });

  test("the verb names what it sends, and waits for a choice", () => {
    expect(answerVerb(null, true, "")).toBe("Choose an option");
    expect(answerVerb(null, true, "my words")).toBe("Answer in your words");
    expect(answerVerb(null, false, "")).toBe("Answer");
    expect(answerVerb({ label: "File all four" }, true, "")).toBe("Answer with File all four");
    expect(answerVerb({ label: "File the two warning and test gaps, drop the accepted residual" }, true, "")).toBe(
      "Answer with File the two warning and test gaps…",
    );
  });

  test("answered and where it was written, in a line", () => {
    const now = Date.parse("2026-10-05T00:00:00Z");
    const done = ask("l.yaml", "A1", {
      state: "answered",
      options: [option("go", { label: "Go" })],
      answerOption: "go",
      answeredAt: "2026-10-04T23:59:30Z",
    });
    expect(answeredLine(done, now)).toBe("Answered just now: “Go”");
    expect(answeredLine({ ...done, answerOption: null, answeredAt: null }, now)).toBe("Answered: an answer");
    expect(writtenTo(ask("l.yaml", "A1"))).toBe("Written to Maestro's answers worktree, on maestro/answers");
    expect(writtenTo(ask("l.yaml", "A1", { home: { kind: "checkout", path: "/w", branch: "feat/x" } }))).toBe(
      "Written to /w (feat/x)",
    );
    expect(writtenTo(ask("l.yaml", "A1", { home: { kind: "root", path: "/state/asks", branch: null } }))).toBe(
      "Written to /state/asks",
    );
    expect(
      ids(
        recentlyAnswered([
          done,
          ask("l.yaml", "A2", { state: "answered", answeredAt: "2026-10-05T00:00Z" }),
          ask("l.yaml", "A3"),
        ]),
      ),
    ).toEqual(["A2", "A1"]);
  });
});
