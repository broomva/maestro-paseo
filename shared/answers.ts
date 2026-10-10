// Your answers after you give them (BRO-2827): the answers batch on its way to
// origin/main (server/answers-landing.ts), and each answer turned into action
// once it is there (server/answer-routes.ts). The loop does both on each wake;
// neither decides anything: an answer is yours, a batch lands through a PR
// gated like any other, and Maestro never merges it. Neither starts work
// either (A8): an answer no session can take waits for the conductor.

import { defineRpc } from "@getpaseo/plugin";
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
 * - `blocked`: Maestro stopped for you, in `error` (the branch holds more than
 *   answers, origin's batch holds what this one lacks); the batch is kept;
 * - `failed`: a step failed (a fetch, gh), in `error`; the batch is kept.
 * `landed`: the last PR of Maestro's that landed, and when it was seen merged.
 */
export const AnswersLandingSchema = z.object({
  stage: z.enum(["none", "waiting", "conflict", "blocked", "failed"]),
  /** Answers on maestro/answers that origin/main does not record. */
  pending: z.number().int().min(0),
  asks: z.array(AskRefSchema),
  pr: PrRefSchema.nullable(),
  /** The ledgers a merge conflicted in, where to settle it, and what it merged (origin/main unless it says). */
  conflict: z.object({ ledgers: z.array(z.string()), path: z.string(), with: z.string().optional() }).nullable(),
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
 * - `superseded`: the ask was closed another way where it lives (main's
 *   outcome wins, §5.2), so your answer was recorded and not acted on;
 * - `before`: answered before Maestro routed answers, so nothing acted on it;
 * - `conductor`: its asker is gone and no one on its arc could take it, so it
 *   waits for the conductor to give it to a lane (route `conductor`). Nothing
 *   was started for it (A8, BRO-2990).
 */
export const ANSWER_STAGES = ["unlanded", "unrouted", "acted", "superseded", "before", "conductor"] as const;
export type AnswerStage = (typeof ANSWER_STAGES)[number];

/**
 * What routing did with an answer: told the session that asked, told another
 * session on its arc or its initiative's driver when the asker is gone
 * (relayed), filed work, nothing to do (and why), nothing because the ask
 * was closed another way, or queued it for the conductor (`conductor`) when
 * no session could take it. Routing never starts work (A8).
 */
export const ROUTES = ["delivered", "relayed", "work", "none", "superseded", "conductor"] as const;
export type Route = (typeof ROUTES)[number];

/**
 * An answer queued for the conductor (BRO-2990, A8): what a `lane.assign`
 * needs to give it to a lane, read from the ask and its `ask.answered`
 * receipt and written once, on the answer's `ask.routed` line in the asks'
 * receipt log, which is the queue. The conductor (BRO-2989) decides which
 * lane takes it, and whether it needs work at all; Maestro only queues it.
 * - `ask`: the ask as it read when the answer was routed;
 * - `answer`: the option taken and your words, verbatim;
 * - `pointers`: where to look: the ledger at its home, the session that asked
 *   (gone), the folder a lane would work in (the asker's when it is still a
 *   repository, else the control repo), the initiative, and the receipt key.
 */
export const ConductorCandidateSchema = z.object({
  for: z.literal("lane.assign"),
  ask: z.object({
    ledger: z.string(),
    uid: z.string().nullable(),
    id: z.string(),
    headline: z.string(),
    question: z.string().nullable(),
    stakes: z.string().nullable(),
    options: z.array(z.object({ id: z.string(), label: z.string(), consequence: z.string().nullable() })),
  }),
  answer: z.object({ option: z.string().nullable(), words: z.string().nullable(), at: z.string().nullable() }),
  pointers: z.object({
    key: z.string(),
    home: z.string(),
    homeKind: z.enum(["main", "checkout", "root"]),
    askedBy: z.string().nullable(),
    repo: z.string(),
    initiative: z.string().nullable(),
  }),
});
export type ConductorCandidate = z.infer<typeof ConductorCandidateSchema>;

/** What you may do with an answer that waits for the conductor (BRO-2990): file it as queued work, or dismiss it. */
export const CONDUCTOR_VERBS = ["file", "dismiss"] as const;
export type ConductorVerb = (typeof CONDUCTOR_VERBS)[number];

/** Your decision on such an answer while its undo window runs: what, its receipt, and when it takes effect. */
export const ConductorPendingSchema = z.object({
  verb: z.enum(CONDUCTOR_VERBS),
  receipt: z.string(),
  appliesAt: z.string(),
});
export type ConductorPending = z.infer<typeof ConductorPendingSchema>;

export const AnswerFateSchema = z.object({
  stage: z.enum(ANSWER_STAGES),
  /** The fate in a sentence, as the card says it. */
  words: z.string(),
  route: z.enum(ROUTES).nullable(),
  pr: PrRefSchema.nullable(),
  work: z.object({ id: z.string(), title: z.string() }).nullable(),
  agentId: z.string().nullable(),
  /** The answer's receipt key (server/answer-routes.ts answerKey): what conductor.decide names. Stage `conductor` only. */
  key: z.string().optional(),
  /** Your decision on it while its undo window runs (conductor.decide); null when none. Stage `conductor` only. */
  pending: ConductorPendingSchema.nullable().optional(),
});
export type AnswerFate = z.infer<typeof AnswerFateSchema>;

/**
 * Your decision on an answer that waits for the conductor (BRO-2990): `file`
 * files it as queued work (gate human, never dispatched: you or a lane start
 * it), carrying the ask, the answer and the pointers; `dismiss` closes it.
 * Either takes effect UNDO_MS later, unless undone (conductor.undo), and
 * leaves a receipt in the asks' receipt log; after it the answer no longer
 * waits for the conductor. Yours alone: never on the agent socket.
 */
export const decideConductor = defineRpc({
  name: "conductor.decide",
  input: z.object({ key: z.string().min(1), verb: z.enum(CONDUCTOR_VERBS) }),
  output: z.object({ receipt: z.string(), appliesAt: z.string() }),
});

/** Take back a conductor.decide while its undo window runs. Yours alone: never on the agent socket. */
export const undoConductor = defineRpc({
  name: "conductor.undo",
  input: z.object({ receipt: z.string().min(1) }),
  output: z.object({ undone: z.boolean() }),
});

/** The batch in Needs you: answers that wait to land, or a batch that cannot take main. */
export const AnswersNoticeSchema = z.object({
  kind: z.enum(["waiting", "conflict", "blocked", "failed"]),
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
    const other = landing.conflict?.with ?? "origin/main";
    return `${waits}, but maestro/answers conflicts with ${other}${where}. Every answer is kept.${path}`;
  }
  if (landing.stage === "blocked") {
    const why = landing.error ?? "no reason given";
    return landing.pending > 0 ? `${waits}, but Maestro stopped: ${why}.` : `Maestro stopped landing answers: ${why}.`;
  }
  if (landing.stage === "failed") return `${waits}, but the last step failed: ${landing.error ?? "no reason given"}`;
  return null;
}

/**
 * The notice the batch puts in Needs you, or none when nothing waits: a step
 * that failed with no answer waiting (an offline fetch, say) is the wake
 * log's to say, not yours to act on.
 */
export function answersNotice(landing: AnswersLanding | null): AnswersNotice | null {
  if (!landing || landing.stage === "none") return null;
  if (landing.stage === "failed" && landing.pending === 0) return null;
  const words = landingWords(landing);
  if (!words) return null;
  return { kind: landing.stage, pending: landing.pending, pr: landing.pr, words };
}
