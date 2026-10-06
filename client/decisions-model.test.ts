import { describe, expect, test } from "bun:test";
import type { DecisionAsk } from "../shared/fleet";
import {
  answeredLine,
  answerVerb,
  askKey,
  askNoticeText,
  cutAtWord,
  fallbackOption,
  groupDecisions,
  groupMeta,
  headlineOf,
  homeText,
  keyedLines,
  ledgerRail,
  matchFocus,
  metaLine,
  nextAfter,
  progressOf,
  pruneSkipped,
  railName,
  railOverflow,
  recentlyAnswered,
  reversibility,
  sameAsk,
  silenceOf,
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

  test("a skip of an ask no longer open is dropped; nothing dropped keeps the same set", () => {
    const open = triageQueue(asks(), { ordering: "blocking" });
    const kept = new Set([askKey(ask("b.yaml", "old"))]);
    expect(pruneSkipped(kept, open)).toBe(kept);
    const gone = new Set([askKey(ask("b.yaml", "old")), askKey(ask("c.yaml", "done"))]);
    expect([...pruneSkipped(gone, open)]).toEqual([askKey(ask("b.yaml", "old"))]);
  });

  test("the rail: open counts, and a waiting count only where an ask waits on you; its overflow counts both", () => {
    expect(ledgerRail(asks())).toEqual([
      { ledger: "a.yaml", open: 2, waiting: 1 },
      { ledger: "c.yaml", open: 2, waiting: 1 },
      { ledger: "b.yaml", open: 1, waiting: 0 },
    ]);
    expect(railOverflow(ledgerRail(asks()))).toBe("+ 3 more · 5 open · 2 wait on you");
    expect(railOverflow([{ ledger: "b.yaml", open: 1, waiting: 0 }])).toBe("+ 1 more · 1 open");
    expect(railOverflow([{ ledger: "b.yaml", open: 3, waiting: 1 }])).toBe("+ 1 more · 3 open · 1 waits on you");
  });

  test("a rail name is cut at a word, never mid-word", () => {
    expect(railName("maestro-paseo-gaps.yaml")).toBe("maestro-paseo-gaps");
    expect(railName("harness-engineering-followups.yaml")).toBe("harness-engineering…");
    expect(railName("profiler-gated-hillclimb.yaml")).toBe("profiler-gated-hillclimb");
    expect(railName("2026-10-01-auth-preflight-hook-stderr.yaml")).toBe("2026-10-01-auth…");
    expect(railName("averyveryverylongledgernamewithnohyphens.yaml")).toBe("averyveryverylongledger…");
  });

  test("an ask's key is its full identity: home, ledger, uid and id, as sameAsk compares", () => {
    const main = ask("l.yaml", "A1");
    expect(askKey(main)).toBe('["origin/main","l.yaml",null,"A1"]');
    const elsewhere = ask("l.yaml", "A1", { home: { kind: "checkout", path: "/w", branch: null } });
    expect(askKey(elsewhere)).not.toBe(askKey(main));
    expect(sameAsk(main, elsewhere)).toBe(false);
    // A uid and an id are both part of it: the same uid under another id is another ask.
    const a = ask("l.yaml", "A1", { uid: "u-1" });
    expect(askKey(a)).not.toBe(askKey(ask("l.yaml", "A2", { uid: "u-1" })));
    expect(sameAsk(a, { ...a })).toBe(true);
  });

  test("a focus names one ask by every field it gives; two matches pick none", () => {
    const queue = [
      ask("l.yaml", "A1", { uid: "u-1" }),
      ask("l.yaml", "A1", { uid: "u-2", home: { kind: "checkout", path: "/w", branch: null } }),
      ask("m.yaml", "B1"),
    ];
    expect(matchFocus(queue, { ledger: "l.yaml", id: "A1" })).toBeNull();
    expect(matchFocus(queue, { ledger: "l.yaml", id: "A1", uid: "u-2" })?.home.kind).toBe("checkout");
    expect(matchFocus(queue, { ledger: "l.yaml", id: "A1", home: "origin/main" })?.uid).toBe("u-1");
    expect(matchFocus(queue, { ledger: null, id: "B1" })?.ledger).toBe("m.yaml");
    expect(matchFocus(queue, { ledger: "m.yaml", id: "B1", uid: "nope" })).toBeNull();
  });

  test("leaving an ask goes to the one at its place, the one on screen excluded; none when nothing else is open", () => {
    const queue = triageQueue(asks(), { ordering: "blocking" });
    expect(nextAfter(queue, askKey(ask("b.yaml", "old")), 2)?.id).toBe("new");
    expect(nextAfter(queue, askKey(ask("c.yaml", "undated")), 4)?.id).toBe("new");
    expect(nextAfter([ask("l.yaml", "A1")], askKey(ask("l.yaml", "A1")), 0)).toBeNull();
    // Gone from the queue already (answered elsewhere): the one now at its place.
    expect(nextAfter(queue, "gone", 1)?.id).toBe("irrev");
  });

  test("up next is the three after the current", () => {
    const queue = triageQueue(asks(), { ordering: "blocking" });
    expect(ids(upNext(queue, 0))).toEqual(["irrev", "old", "new"]);
    expect(ids(upNext(queue, 3))).toEqual(["undated"]);
    expect(ids(upNext(queue, -1))).toEqual(["block", "irrev", "old"]);
  });

  test("progress moves with what is handled: N is handled + 1 of M, the bar handled / M", () => {
    expect(progressOf(0, 49)).toEqual({ text: "Decision 1 of 49", fraction: 0 });
    expect(progressOf(11, 49)).toEqual({ text: "Decision 12 of 49", fraction: 11 / 49 });
    expect(progressOf(49, 49)).toEqual({ text: "Decision 49 of 49", fraction: 1 });
    expect(progressOf(60, 49).fraction).toBe(1);
    expect(progressOf(0, 0)).toEqual({ text: "No decisions open", fraction: 0 });
  });
});

describe("the keys", () => {
  const free = { typing: false, onControl: false, options: 3, canSkip: true };

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

  test("S only where Skip is offered", () => {
    expect(triageKey({ key: "s" }, { ...free, canSkip: false })).toBeNull();
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
  test("the headline is the ask's own; without one, the first sentence, and Full question holds only the rest", () => {
    expect(headlineOf(ask("l.yaml", "A1", { headline: "Merge it?", question: "Merge PR #1 now?" }))).toEqual({
      headline: "Merge it?",
      rest: null,
      derived: false,
    });
    expect(
      headlineOf(ask("l.yaml", "A2", { headline: null, question: "Rename this session? It helps peers find it." })),
    ).toEqual({ headline: "Rename this session?", rest: "It helps peers find it.", derived: true });
    expect(headlineOf(ask("l.yaml", "A3", { headline: null, question: "Sign in to Linear?" }))).toEqual({
      headline: "Sign in to Linear?",
      rest: null,
      derived: true,
    });
    const long = `Should ${"the fleet ".repeat(20)}stop? Then report.`;
    const cut = headlineOf(ask("l.yaml", "A4", { headline: null, question: long }));
    expect(cut.headline.endsWith(" the…")).toBe(true);
    expect(cut.headline.length).toBeLessThanOrEqual(121);
    // A sentence cut short: the rest picks up where the headline stopped, never repeats it.
    expect(cut.rest).toBe(`…${long.slice(cut.headline.length - 1).trimStart()}`);
    expect(`${cut.headline.slice(0, -1)} ${(cut.rest ?? "").slice(1)}`.replace(/\s+/g, " ")).toBe(long);
    expect(headlineOf(ask("l.yaml", "A5", { headline: null, question: null }))).toEqual({
      headline: "A5",
      rest: null,
      derived: true,
    });
    expect(cutAtWord("one two three", 8)).toBe("one two…");
  });

  test("the meta line: ledger, age, blocking or not, and undo, said even when the ledger does not say", () => {
    const now = Date.parse("2026-10-05T00:00:00Z");
    expect(
      metaLine(
        ask("maestro-paseo-gaps.yaml", "A10", { askedAt: "2026-10-01T00:00:00Z", options: [option("a"), option("b")] }),
        now,
      ),
    ).toBe("maestro-paseo-gaps · asked 4d ago · not blocking · reversible");
    expect(
      metaLine(
        ask("l.yaml", "A1", { blocking: true, options: [option("a"), option("b", { reversible: false })] }),
        now,
      ),
    ).toBe("l · blocking · an option cannot be undone");
    expect(metaLine(ask("l.yaml", "A1", { options: [] }), now)).toBe("l · not blocking · Undo: not stated");
    expect(reversibility([option("a", { reversible: null })])).toBeNull();
    expect(reversibility([])).toBeNull();
  });

  test("the default names an option only whole or as its first words; a short id inside a sentence never matches", () => {
    const merge = option("merge", { label: "Merge PR #863", recommended: true });
    const hold = option("hold", { label: "Hold PR #863" });
    expect(fallbackOption(ask("l.yaml", "A1", { fallback: "hold", options: [merge, hold] }))?.id).toBe("hold");
    expect(
      fallbackOption(ask("l.yaml", "A1", { fallback: "merge PR #863 once green", options: [merge, hold] }))?.id,
    ).toBe("merge");
    // "no" and "a" are inside the sentence, not its name.
    const short = [option("no", { label: "No" }), option("a", { label: "A" })];
    expect(
      fallbackOption(ask("l.yaml", "A1", { fallback: "proceed; no lane waits on a reviewer", options: short })),
    ).toBeNull();
    expect(fallbackOption(ask("l.yaml", "A1", { fallback: "No", options: short }))?.id).toBe("no");
    expect(fallbackOption(ask("l.yaml", "A1", { fallback: "no lane waits on a reviewer", options: short }))).toBeNull();
    // A word that only starts like an option is not it.
    expect(fallbackOption(ask("l.yaml", "A1", { fallback: "holding pattern", options: [merge, hold] }))).toBeNull();
  });

  test("if you say nothing: the option it names and whether that is the recommendation; else the words, not an option", () => {
    const options = [
      option("merge", { label: "Merge PR #863", recommended: true }),
      option("hold", { label: "Hold PR #863" }),
    ];
    expect(silenceOf(ask("l.yaml", "A1", { fallback: "hold", options }))).toEqual({
      text: "If you say nothing: Hold PR #863",
      tag: "differs",
      words: null,
    });
    // The ledger's wording says more than the label: it is kept, under the line.
    expect(silenceOf(ask("l.yaml", "A1", { fallback: "merge PR #863 once green", options }))).toEqual({
      text: "If you say nothing: Merge PR #863",
      tag: "same",
      words: "merge PR #863 once green",
    });
    expect(silenceOf(ask("l.yaml", "A1", { fallback: "Merge PR #863", options }))).toEqual({
      text: "If you say nothing: Merge PR #863",
      tag: "same",
      words: null,
    });
    expect(silenceOf(ask("l.yaml", "A1", { fallback: "continue as is", options }))).toEqual({
      text: "If you say nothing: continue as is (not one of the options above)",
      tag: null,
      words: null,
    });
    expect(silenceOf(ask("l.yaml", "A1", { fallback: "continue as is", options: [] }))?.text).toBe(
      "If you say nothing: continue as is",
    );
    expect(silenceOf(ask("l.yaml", "A1", { fallback: null, options }))).toBeNull();
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

  test("answered, and where it was written, short: no machine path", () => {
    const now = Date.parse("2026-10-05T00:00:00Z");
    const done = ask("l.yaml", "A1", {
      state: "answered",
      options: [option("go", { label: "Go" })],
      answerOption: "go",
      answeredAt: "2026-10-04T23:59:30Z",
    });
    expect(answeredLine(done, now)).toBe("Answered just now: “Go”");
    expect(answeredLine({ ...done, answerOption: null, answeredAt: null }, now)).toBe("Answered: an answer");
    expect(writtenTo(ask("l.yaml", "A1"))).toBe("Written to Maestro's answers batch, on maestro/answers");
    expect(
      writtenTo(ask("l.yaml", "A1", { home: { kind: "checkout", path: "/private/tmp/x/broomva", branch: "feat/x" } })),
    ).toBe("Written to the checkout broomva (feat/x)");
    expect(writtenTo(ask("l.yaml", "A1", { home: { kind: "root", path: "/state/asks", branch: null } }))).toBe(
      "Written to asks",
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

  test("lines that read the same still get keys of their own", () => {
    expect(keyedLines(["read: x", "read: x", "y"]).map((entry) => entry.key)).toEqual(["read: x", "read: x#2", "y"]);
  });
});
