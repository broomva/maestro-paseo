import { describe, expect, test } from "bun:test";
import type { AnswerFate, AnswersLanding } from "../shared/answers";
import { landingWords } from "../shared/answers";
import type { DecisionAsk } from "../shared/fleet";
import { answersStatus } from "./answers-status";

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
      expect([status.acted, status.routed, status.held, status.window]).toEqual([2, 1, 1, 6]);
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
