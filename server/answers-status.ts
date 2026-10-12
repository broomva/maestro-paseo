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

/** What you answered: the option's label, else your words. */
function answerOf(ask: DecisionAsk): string {
  const option = ask.options.find((entry) => entry.id === ask.answerOption);
  if (option) return option.label;
  return ask.answer ? clipWords(ask.answer, ANSWER_CHARS) : "an answer";
}

const keyOf = (ask: Pick<DecisionAsk, "ledger" | "uid" | "id">) => `${ask.ledger}#${ask.uid ?? ask.id}`;

/**
 * Where your answers went: `asks` as the workspace read has them (every ask, with its fate), `landing` as the
 * last wake left it. Only an answer Maestro holds a receipt for has a fate; one answered elsewhere has none and
 * is in no count (`window` is how many are).
 */
export function answersStatus(asks: readonly DecisionAsk[], landing: AnswersLanding | null): AnswersStatus {
  const tracked = asks
    .filter((ask) => ask.state === "answered" && !ask.idea && !ask.scope)
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
    stage,
    words: ask.fate?.words ?? "In the answers batch on maestro/answers: not on origin/main until it lands.",
    answeredAt: ask.answeredAt,
  }));
  // The landing's count is as old as its last check; an answer batched since is already in the list. The two
  // measure one thing (answers on maestro/answers that origin/main lacks), so the tile never says "all landed"
  // while the rail below it says an answer waits.
  const batched = tracked.filter((one) => one.stage === "unlanded").length;
  return {
    waitingToLand: Math.max(landing?.pending ?? 0, batched),
    landing: landing ? { stage: landing.stage, pr: landing.pr, words: landingWords(landing) ?? "" } : null,
    routed: count("unrouted"),
    acted: count("acted"),
    held: count("conductor"),
    window: tracked.length,
    recent,
  };
}
