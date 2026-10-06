// Your answers after you give them (BRO-2827): the answers batch on its way to
// origin/main (server/answers-landing.ts), and each answer turned into action
// once it is there (server/answer-routes.ts). The loop does both on each wake;
// neither decides anything: an answer is yours, a batch lands through a PR
// gated like any other, and Maestro never merges it.

import { z } from "zod";

export const PrRefSchema = z.object({ number: z.number().int(), url: z.string() });
export type PrRef = z.infer<typeof PrRefSchema>;

/** An ask by its handle (§5.2): its ledger, its uid when it has one, and its id. */
export const AskRefSchema = z.object({ ledger: z.string(), uid: z.string().nullable(), id: z.string() });
export type AskRef = z.infer<typeof AskRefSchema>;

/**
 * The answers batch as the last wake left it:
 * - `none`: nothing on maestro/answers that origin/main lacks;
 * - `waiting`: answers wait to land, through `pr` once it is open;
 * - `conflict`: maestro/answers could not take origin/main's latest; the
 *   batch is kept as it was, and `conflict` names the ledgers;
 * - `failed`: a step failed (a push, the PR), in `error`; the batch is kept.
 * `landed`: the last PR of Maestro's that landed, and when it was seen merged.
 */
export const AnswersLandingSchema = z.object({
  stage: z.enum(["none", "waiting", "conflict", "failed"]),
  /** Answers on maestro/answers that origin/main does not record. */
  pending: z.number().int().min(0),
  asks: z.array(AskRefSchema),
  pr: PrRefSchema.nullable(),
  conflict: z.object({ ledgers: z.array(z.string()), path: z.string() }).nullable(),
  error: z.string().nullable(),
  landed: z.object({ pr: PrRefSchema.nullable(), at: z.string() }).nullable(),
  checkedAt: z.string(),
});
export type AnswersLanding = z.infer<typeof AnswersLandingSchema>;

/**
 * Where your answer is now, as Decisions shows it on an answered ask:
 * - `unlanded`: in the answers batch, not on origin/main yet;
 * - `unrouted`: where it belongs (landed, or in its checkout), not acted on
 *   yet: a delivery waiting for its session to go idle, or the next wake;
 * - `acted`: routed, once, by its receipt (`route`);
 * - `before`: answered before Maestro routed answers, so nothing acted on it.
 */
export const ANSWER_STAGES = ["unlanded", "unrouted", "acted", "before"] as const;
export type AnswerStage = (typeof ANSWER_STAGES)[number];

/** What routing did with an answer: told the session that asked, filed work, or nothing to do (and why). */
export const ROUTES = ["delivered", "work", "none"] as const;
export type Route = (typeof ROUTES)[number];

export const AnswerFateSchema = z.object({
  stage: z.enum(ANSWER_STAGES),
  /** The fate in a sentence, as the card says it. */
  words: z.string(),
  route: z.enum(ROUTES).nullable(),
  pr: PrRefSchema.nullable(),
  work: z.object({ id: z.string(), title: z.string() }).nullable(),
  agentId: z.string().nullable(),
});
export type AnswerFate = z.infer<typeof AnswerFateSchema>;

/** The batch in Needs you: answers that wait to land, or a batch that cannot take main. */
export const AnswersNoticeSchema = z.object({
  kind: z.enum(["waiting", "conflict", "failed"]),
  pending: z.number().int().min(0),
  pr: PrRefSchema.nullable(),
  /** The notice in a sentence: "3 answers wait to land: PR #915". */
  words: z.string(),
});
export type AnswersNotice = z.infer<typeof AnswersNoticeSchema>;

export function answersWord(count: number): string {
  return `${count} ${count === 1 ? "answer" : "answers"}`;
}

/** The batch's line, for the wake log and Needs you alike: one wording, so the two never disagree. */
export function landingWords(landing: AnswersLanding): string | null {
  const waits = `${answersWord(landing.pending)} ${landing.pending === 1 ? "waits" : "wait"} to land`;
  if (landing.stage === "waiting") return landing.pr ? `${waits}: PR #${landing.pr.number}` : `${waits}.`;
  if (landing.stage === "conflict") {
    const where = landing.conflict ? ` in ${landing.conflict.ledgers.join(", ") || "its files"}` : "";
    const path = landing.conflict ? ` Settle it by hand in ${landing.conflict.path}.` : "";
    return `${waits}, but maestro/answers conflicts with origin/main${where}. Every answer is kept.${path}`;
  }
  if (landing.stage === "failed") return `${waits}, but the last step failed: ${landing.error ?? "no reason given"}`;
  return null;
}

/** The notice the batch puts in Needs you, or none when nothing waits. */
export function answersNotice(landing: AnswersLanding | null): AnswersNotice | null {
  if (!landing || landing.stage === "none") return null;
  const words = landingWords(landing);
  if (!words) return null;
  return { kind: landing.stage, pending: landing.pending, pr: landing.pr, words };
}
