// answers.status (J5, BRO-3036): where your answers went, as one pure read. The batch waiting to land is
// the landing's own count (the number the answers hold in Needs you words), or the answers already listed as
// batched when the landing's last check is older than they are; the other three counts are over
// the answered asks Maestro reads, and `window` says how many that is. Nothing here reads a file or writes.

import {
  ANSWERS_RECENT,
  type AnswersLanding,
  type AnswersStatus,
  landingWords,
  type RecentAnswer,
} from "../shared/answers";
import type { DecisionAsk } from "../shared/fleet";
import { clipWords } from "../shared/text";

/** The longest an answer's words run in `recent` before they are cut at a word. */
const ANSWER_CHARS = 90;
/** The longest an ask's headline runs in `recent`. */
const TITLE_CHARS = 120;

/** What you answered: the option's label, else an Other answer in your words (BRO-3146), else your words. */
function answerOf(ask: DecisionAsk): string {
  const option = ask.options.find((entry) => entry.id === ask.answerOption);
  if (option) return option.label;
  if (ask.answerOther) return `Other: ${clipWords(ask.answerOther, ANSWER_CHARS)}`;
  return ask.answer ? clipWords(ask.answer, ANSWER_CHARS) : "an answer";
}

const keyOf = (ask: Pick<DecisionAsk, "ledger" | "uid" | "id">) => `${ask.ledger}#${ask.uid ?? ask.id}`;

/**
 * Answers on maestro/answers that origin/main lacks, as the asks list them: batched, answered here, not a scope's
 * (a fleet scope's answer is written at its root, never batched). An idea's counts: the phone's Decisions deck
 * answers ideas, and their answers land in the same batch (BRO-3140).
 */
export function batchedCount(asks: readonly DecisionAsk[]): number {
  return asks.filter((ask) => ask.state === "answered" && ask.batched && !ask.scope).length;
}

/**
 * The answers batch as it stands: the landing's last check, and any answer batched since (the landing is as old
 * as its last wake). One function for both readers, needs.list's answers hold and answers.status's tile, so the
 * badge, the hold and the tile cannot say different numbers (BRO-3001). With nothing waiting it is the landing
 * as it was, or none.
 */
export function landingNow(
  landing: AnswersLanding | null,
  asks: readonly DecisionAsk[],
  now: number,
): AnswersLanding | null {
  const batched = batchedCount(asks);
  const pending = Math.max(landing?.pending ?? 0, batched);
  if (pending === 0 || (landing && landing.pending >= pending && landing.stage !== "none")) return landing;
  if (!landing)
    return {
      stage: "waiting",
      pending,
      asks: [],
      pr: null,
      conflict: null,
      error: null,
      landed: null,
      checkedAt: new Date(now).toISOString(),
    };
  return { ...landing, stage: landing.stage === "none" ? "waiting" : landing.stage, pending };
}

/** The stages an answer can still be acted on from: the ones before routing began, or superseded, never are. */
const ACTIONABLE: readonly string[] = ["unlanded", "unrouted", "acted", "conductor"];

/**
 * Where your answers went: `asks` as the workspace read has them (every ask, with its fate), `landing` as the
 * last wake left it. Only an answer Maestro holds a receipt for has a fate; one answered elsewhere has none and
 * is in no count. `window` is the answers the three counts are over: those that can still be acted on, never the
 * ones given before Maestro routed answers or closed another way.
 */
export function answersStatus(
  asks: readonly DecisionAsk[],
  landing: AnswersLanding | null,
  now = Date.now(),
): AnswersStatus {
  const tracked = asks
    // Every answer of yours that lands here, an idea's among them (BRO-3140); a fleet scope's is its root's.
    .filter((ask) => ask.state === "answered" && !ask.scope)
    .flatMap((ask) => {
      const stage = ask.fate?.stage ?? (ask.batched ? ("unlanded" as const) : null);
      return stage ? [{ ask, stage }] : [];
    })
    .sort((a, b) => (b.ask.answeredAt ?? "").localeCompare(a.ask.answeredAt ?? ""));
  const count = (stage: string) => tracked.filter((one) => one.stage === stage).length;
  const recent: RecentAnswer[] = tracked.slice(0, ANSWERS_RECENT).map(({ ask, stage }) => ({
    key: keyOf(ask),
    ledger: ask.ledger,
    id: ask.id,
    title: ask.headline ?? (ask.question ? clipWords(ask.question, TITLE_CHARS) : ask.id),
    answer: answerOf(ask),
    note: ask.answerNote ? clipWords(ask.answerNote, ANSWER_CHARS) : null,
    stage,
    words: ask.fate?.words ?? "In the answers batch on maestro/answers: not on origin/main until it lands.",
    answeredAt: ask.answeredAt,
  }));
  const batch = landingNow(landing, asks, now);
  return {
    waitingToLand: batch?.pending ?? 0,
    landing: batch ? { stage: batch.stage, pr: batch.pr, words: landingWords(batch) ?? "" } : null,
    routed: count("unrouted"),
    acted: count("acted"),
    held: count("conductor"),
    window: tracked.filter((one) => ACTIONABLE.includes(one.stage)).length,
    recent,
  };
}
