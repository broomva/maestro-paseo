import { describe, expect, test } from "bun:test";
import type { AnswerFate, AnswersLanding } from "../shared/answers";
import { landingWords } from "../shared/answers";
import type { DecisionAsk } from "../shared/fleet";
import { answersStatus, batchedCount, landingNow } from "./answers-status";

const ask = (id: string, extra: Partial<DecisionAsk> = {}): DecisionAsk => ({
  ledger: "claude-code-mods.yaml",
  uid: null,
  id,
  hash: "0123456789abcdef",
  arc: null,
  headline: `Question ${id}?`,
  question: null,
  stakes: null,
  whyYou: null,
  options: [{ id: "a", label: "Keep them off", consequence: null, recommended: true, reversible: true }],
  fallback: null,
  blocking: false,
  askedAt: "2026-10-01T00:00:00Z",
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

const fate = (stage: AnswerFate["stage"], words = stage): AnswerFate => ({
  stage,
  words,
  route: null,
  pr: null,
  work: null,
  agentId: null,
});

const answered = (id: string, at: string, stage: AnswerFate["stage"] | null, extra: Partial<DecisionAsk> = {}) =>
  ask(id, {
    state: "answered",
    answeredAt: at,
    answerOption: "a",
    fate: stage ? fate(stage) : null,
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
  checkedAt: "2026-10-10T10:00:00Z",
  ...extra,
});

describe("answers.status: where your answers went", () => {
  test("the batch waiting to land is the landing's own count, and the words are the Needs you row's", () => {
    const l = landing();
    const status = answersStatus([], l);
    expect(status.waitingToLand).toBe(27);
    expect(status.landing).toEqual({ stage: "waiting", pr: l.pr, words: landingWords(l) as string });
  });

  test("answers batched since the landing's last check count: the tile never says everything landed while one waits", () => {
    const batchedAsk = answered("1", "2026-10-01T01:00:00Z", "unlanded", { batched: true });
    expect(answersStatus([batchedAsk], null).waitingToLand).toBe(1);
    expect(answersStatus([batchedAsk], landing({ stage: "none", pending: 0, pr: null })).waitingToLand).toBe(1);
    // The landing's own count stands when it is larger (answers older than the read), and never adds to it.
    expect(answersStatus([batchedAsk], landing({ pending: 27 })).waitingToLand).toBe(27);
    expect(answersStatus([batchedAsk, batchedAsk], landing({ pending: 1 })).waitingToLand).toBe(2);
  });

  test("nothing known: zero everywhere, no landing", () => {
    expect(answersStatus([], null)).toEqual({
      waitingToLand: 0,
      landing: null,
      routed: 0,
      acted: 0,
      held: 0,
      window: 0,
      recent: [],
    });
  });

  test("routed, acted and held count the answers by their fate stage, whatever order they come in", () => {
    const asks = [
      answered("1", "2026-10-01T01:00:00Z", "acted"),
      answered("2", "2026-10-01T02:00:00Z", "acted"),
      answered("3", "2026-10-01T03:00:00Z", "unrouted"),
      answered("4", "2026-10-01T04:00:00Z", "conductor"),
      answered("5", "2026-10-01T05:00:00Z", "unlanded"),
      answered("6", "2026-10-01T06:00:00Z", "superseded"),
    ];
    for (const order of [asks, [...asks].reverse()]) {
      const status = answersStatus(order, null);
      expect([status.acted, status.routed, status.held, status.window]).toEqual([2, 1, 1, 5]);
    }
  });

  test("an answer with no fate (answered elsewhere) and an open ask are in no count", () => {
    const status = answersStatus(
      [answered("1", "2026-10-01T01:00:00Z", null), ask("2"), answered("3", "2026-10-01T03:00:00Z", "acted")],
      null,
    );
    expect(status.window).toBe(1);
    expect(status.recent.map((one) => one.id)).toEqual(["3"]);
  });

  test("a batched answer from an older daemon with no fate reads as waiting to land", () => {
    const status = answersStatus([answered("1", "2026-10-01T01:00:00Z", null, { batched: true })], null);
    expect(status.recent[0]?.stage).toBe("unlanded");
    expect(status.window).toBe(1);
  });

  test("recent is the latest five, newest first, with the answer you gave", () => {
    const asks = Array.from({ length: 8 }, (_, at) => answered(String(at), `2026-10-0${at + 1}T00:00:00Z`, "acted"));
    const status = answersStatus(asks, null);
    expect(status.recent.map((one) => one.id)).toEqual(["7", "6", "5", "4", "3"]);
    expect(status.recent[0]).toMatchObject({ title: "Question 7?", answer: "Keep them off", stage: "acted" });
    expect(status.acted).toBe(8);
  });

  test("words with no option are shown as your words, cut at a word; a fleet scope's and an idea's answers are not counted", () => {
    const words = "Same vendor for now ".repeat(20);
    const status = answersStatus(
      [
        answered("1", "2026-10-01T01:00:00Z", "acted", {
          answerOption: null,
          answer: words,
          headline: null,
          question: "Long?",
        }),
        answered("2", "2026-10-01T02:00:00Z", "acted", { scope: "sri" }),
      ],
      null,
    );
    expect(status.window).toBe(1);
    expect(status.recent[0]?.answer.length).toBeLessThanOrEqual(90);
    expect(status.recent[0]?.answer.endsWith("…")).toBe(true);
    expect(status.recent[0]?.title).toBe("Long?");
  });
});

describe("the batch waiting to land is one function for needs.list's hold and J5's tile", () => {
  const NOW = Date.parse("2026-10-12T15:00:00.000Z");
  const batchedAsk = (id: string, extra: Partial<DecisionAsk> = {}) =>
    answered(id, "2026-10-01T01:00:00Z", "unlanded", { batched: true, ...extra });

  test("with no landing yet, answers batched since still wait: a waiting batch with no PR", () => {
    const batch = landingNow(null, [batchedAsk("1"), batchedAsk("2")], NOW);
    expect(batch).toMatchObject({ stage: "waiting", pending: 2, pr: null, checkedAt: new Date(NOW).toISOString() });
    expect(batchedCount([batchedAsk("1"), answered("2", "2026-10-01T02:00:00Z", "acted")])).toBe(1);
  });

  test("the landing's own count stands when it is larger or equal, and its PR and stage with it; nothing waiting is the landing as it was", () => {
    const l = landing({ pending: 27 });
    expect(landingNow(l, [batchedAsk("1")], NOW)).toBe(l);
    expect(landingNow(null, [], NOW)).toBeNull();
    const none = landing({ stage: "none", pending: 0, pr: null });
    expect(landingNow(none, [], NOW)).toBe(none);
    // An older landing that says none, with an answer batched since: waiting, its PR kept (it is the same batch).
    expect(landingNow(none, [batchedAsk("1")], NOW)).toMatchObject({ stage: "waiting", pending: 1 });
    // More batched than it counted: the larger count, the stage it had.
    expect(
      landingNow(landing({ pending: 1, stage: "conflict" }), [batchedAsk("1"), batchedAsk("2")], NOW),
    ).toMatchObject({
      stage: "conflict",
      pending: 2,
    });
  });

  test("an idea's or a fleet scope's batched answer is not Maestro's to land here", () => {
    expect(batchedCount([batchedAsk("1", { scope: "sri" })])).toBe(0);
  });

  test("what the tile counts against is what can still be acted on: answers from before routing, or closed another way, are not", () => {
    const status = answersStatus(
      [
        answered("1", "2026-10-01T01:00:00Z", "acted"),
        answered("2", "2026-10-01T02:00:00Z", "unrouted"),
        answered("3", "2026-10-01T03:00:00Z", "before"),
        answered("4", "2026-10-01T04:00:00Z", "before"),
        answered("5", "2026-10-01T05:00:00Z", "superseded"),
      ],
      null,
    );
    expect(status.window).toBe(2);
    // They still say where they went.
    expect(status.recent.map((one) => one.stage)).toEqual(["superseded", "before", "before", "unrouted", "acted"]);
  });
});
