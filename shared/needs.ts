// What needs you and what was handled for you (BRO-3001): the two projections
// every count, badge, section and push reads (docs/design/next/view-models.md).
// The server computes them once (server/needs.ts) from what it already holds,
// as a pure read; nothing on the client adds lists up. Plain Zod values only:
// this module is compiled into both bundles.
//
// Needs you is only a hold (owner answer A1): an ask, an approval or an owner
// step. Everything else is watched: stuck work, quiet runs, failed or missed
// schedules, loop drift, open asks that do not wait on you, and answers that
// wait for the conductor.

import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { type DecisionAsk, homeKey } from "./fleet";

export const NEED_KINDS = ["ask", "approval", "owner_step"] as const;
export type NeedKind = (typeof NEED_KINDS)[number];

/**
 * A hold's verbs, by the ids the component kit maps to its RPCs
 * (client/kit/inspector-model.ts KIND_VERBS): Allow/Deny, Answer/Skip,
 * Done/Not now (`later`). No kind offers Approve (A0).
 */
export const VERBS = ["allow", "deny", "answer", "skip", "done", "later"] as const;
export type Verb = (typeof VERBS)[number];

/** Each kind's verbs, and only its own, in the order a card draws them. */
export const KIND_VERBS: Record<NeedKind, readonly Verb[]> = {
  approval: ["allow", "deny"],
  ask: ["answer", "skip"],
  owner_step: ["done", "later"],
};

/** How a kind is named, as a count, a chip or a push says it. */
export const KIND_WORDS: Record<NeedKind, { one: string; many: string }> = {
  ask: { one: "ask", many: "asks" },
  approval: { one: "approval", many: "approvals" },
  owner_step: { one: "owner step", many: "owner steps" },
};

export const OptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  consequence: z.string().nullable(),
});
export type Option = z.infer<typeof OptionSchema>;

/** One fact a card shows as evidence (the kit's Evidence). */
export const EvidenceSchema = z.object({
  label: z.string(),
  value: z.string(),
  note: z.string().optional(),
  tone: z.enum(["ok", "warn", "danger", "muted"]),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const AskBodySchema = z.object({
  /** Why it is yours to answer. */
  why: z.string(),
  /** What it costs while it waits. */
  cost: z.string(),
  options: z.array(OptionSchema),
  /** The option the asker recommends, by id. */
  recommended: z.string().optional(),
  /** The option taken if you stay silent, and when (A4). Absent until a timed default exists for it. */
  default: z.object({ option: z.string(), appliesAt: z.string() }).optional(),
  /** Where your answer is written and acted on, in words. */
  goesTo: z.string(),
});
export type AskBody = z.infer<typeof AskBodySchema>;

/** A due initiative review, raised as an ask on its due date (B2). */
export const ReviewBodySchema = AskBodySchema.extend({
  initiative: z.string(),
  /** The owner's intent, verbatim when the file has it. */
  intent: z.string(),
  /** What its record says now: its next action and what it waits on. */
  since: z.array(z.string()),
  hanging: z.object({ work: z.number().int().min(0), asks: z.number().int().min(0), driver: z.string().optional() }),
});
export type ReviewBody = z.infer<typeof ReviewBodySchema>;

/** Your Allow or Deny on a held action while its undo window runs (approval.decide): what to count down to, and undo. */
export const PendingApprovalSchema = z.object({
  receipt: z.string(),
  /** "Allowed git push origin main": what you did, in the past tense. */
  label: z.string(),
  appliesAt: z.string(),
});
export type PendingApproval = z.infer<typeof PendingApprovalSchema>;

/**
 * An approval is one exact action that a policy layer held (A1): a session's permission prompt, or an
 * action an agent asked leave for (approval.request). Work is never asked to be approved.
 */
export const ApprovalBodySchema = z.object({
  /** The exact action held, in words. Your decision binds to this text: when it has changed, the decision is dropped. */
  action: z.string(),
  /** The layer that held it: `permission` (the session's permission prompt), or the policy an agent names (`gate`, `policy`). */
  heldBy: z.string(),
  evidence: z.array(EvidenceSchema),
  /** What happens after you allow it, step by step. */
  after: z.array(z.string()),
  /** Your decision, while it waits out its undo window. Absent when none is pending. */
  pending: PendingApprovalSchema.optional(),
});
export type ApprovalBody = z.infer<typeof ApprovalBodySchema>;

export const OwnerStepBodySchema = z.object({
  /** Where the step is done. */
  where: z.string(),
  /** How Maestro knows it is done, and what holds until then. */
  doneCheck: z.string(),
  /** Sessions waiting on it. */
  waitingSessions: z.number().int().min(0),
});
export type OwnerStepBody = z.infer<typeof OwnerStepBodySchema>;

// ── Keys ─────────────────────────────────────────────────────────────────────
// A hold's key is stable for as long as the hold lasts, and names what it holds:
// openScreen and the session card address the hold by it, and holdOf reads it back.

export const workKey = (id: string): string => `work:${id}`;
/** An ask's: `ask:` and the ask's full identity as Decisions keys it (client/decisions-model.ts askKey). */
export const askHoldKey = (ask: Pick<DecisionAsk, "home" | "ledger" | "uid" | "id">): string =>
  `ask:${JSON.stringify([homeKey(ask.home), ask.ledger, ask.uid, ask.id])}`;
export const reviewKey = (initiative: string): string => `review:${initiative}`;
/** An action an agent asked leave for (approval.request): `approval:<id>`. */
export const approvalKey = (id: string): string => `approval:${id}`;

/** A permission prompt's action, as an approval says it and a decision binds to it. */
export function permissionAction(permission: { title: string; detail: string | null }): string {
  return permission.detail ? `${permission.title}: ${permission.detail}` : permission.title;
}
export const ANSWERS_KEY = "answers:batch";

export type Hold =
  | { kind: "work"; id: string }
  | { kind: "ask"; askKey: string }
  | { kind: "review"; initiative: string }
  | { kind: "approval"; id: string }
  | { kind: "answers" };

/** What a key holds, or null for a key no hold has. */
export function holdOf(key: string): Hold | null {
  if (key === ANSWERS_KEY) return { kind: "answers" };
  const at = key.indexOf(":");
  if (at < 0) return null;
  const rest = key.slice(at + 1);
  if (!rest) return null;
  switch (key.slice(0, at)) {
    case "work":
      return { kind: "work", id: rest };
    case "ask":
      return { kind: "ask", askKey: rest };
    case "review":
      return { kind: "review", initiative: rest };
    case "approval":
      return { kind: "approval", id: rest };
    default:
      return null;
  }
}

const RowBase = z.object({
  /** `work:<id>`, `ask:<ask key>`, `review:<initiative>`, `approval:<id>` or `answers:batch` (holdOf). */
  key: z.string(),
  title: z.string(),
  /** The workspace or lane it belongs to, e.g. "broomva", "sri". */
  scope: z.string(),
  ticket: z.string().optional(),
  session: z.object({ agentId: z.string(), name: z.string(), waiting: z.boolean() }).optional(),
  /** When it started waiting, ISO. */
  since: z.string(),
  /** Something stops until it is answered. */
  blocksWork: z.boolean(),
});

export const NeedRowSchema = z.discriminatedUnion("kind", [
  RowBase.extend({
    kind: z.literal("ask"),
    verbs: z.array(z.enum(VERBS)),
    // A review first: an ask body would parse a review and drop its fields.
    body: z.union([ReviewBodySchema, AskBodySchema]),
  }),
  RowBase.extend({ kind: z.literal("approval"), verbs: z.array(z.enum(VERBS)), body: ApprovalBodySchema }),
  RowBase.extend({ kind: z.literal("owner_step"), verbs: z.array(z.enum(VERBS)), body: OwnerStepBodySchema }),
]);
export type NeedRow = z.infer<typeof NeedRowSchema>;

export const NeedSummarySchema = z.object({
  /** == rows.length == the header badge == the Feed tab badge == the push count (server/needs.test.ts). */
  total: z.number().int().min(0),
  byKind: z.object({
    ask: z.number().int().min(0),
    approval: z.number().int().min(0),
    owner_step: z.number().int().min(0),
  }),
  oldest: z.object({ key: z.string(), since: z.string() }).optional(),
});
export type NeedSummary = z.infer<typeof NeedSummarySchema>;

/**
 * What needs you, in deck order (server/needs.ts sortNeeds), and its summary.
 * `kind` narrows the rows to one kind; the summary then describes those rows.
 * A pure read: it reconciles nothing and writes nothing (BRO-2995).
 */
export const listNeeds = defineRpc({
  name: "needs.list",
  input: z.object({ kind: z.enum(NEED_KINDS).optional() }),
  output: z.object({ rows: z.array(NeedRowSchema), summary: NeedSummarySchema }),
});
export type Needs = z.infer<typeof listNeeds.output>;

export const CLOSERS = ["gates", "you", "orchestrator", "maestro"] as const;
export type Closer = (typeof CLOSERS)[number];

export const HandledRowSchema = z.object({
  key: z.string(),
  title: z.string(),
  closedBy: z.enum(CLOSERS),
  /** Why it closed, in its receipt's words. */
  reason: z.string(),
  at: z.string(),
});
export type HandledRow = z.infer<typeof HandledRowSchema>;

/**
 * What closed, newest first: work closed in the last week, by whoever closed
 * it (Done's who-closed chips read `you` too; Handled for you reads the rest).
 * `today` counts the local day: work closed for you (by gates, an orchestrator
 * or Maestro), work you closed, and asks you answered.
 */
export const listHandled = defineRpc({
  name: "handled.list",
  input: z.object({}),
  output: z.object({
    rows: z.array(HandledRowSchema),
    today: z.object({
      closedForYou: z.number().int().min(0),
      byYou: z.number().int().min(0),
      asksAnswered: z.number().int().min(0),
    }),
  }),
});
export type Handled = z.infer<typeof listHandled.output>;

/** "3 need you", "1 needs you", "Nothing needs you": the one wording for a count. */
export function needsWords(total: number): string {
  if (total <= 0) return "Nothing needs you";
  return `${total} ${total === 1 ? "needs" : "need"} you`;
}

/** The order a summary says its kinds in (J1): "1 approval · 1 owner step · 2 asks". */
const KIND_ORDER: readonly NeedKind[] = ["approval", "owner_step", "ask"];

/** "1 approval · 2 asks": counts by kind, kinds with none left out. */
export function kindWords(byKind: NeedSummary["byKind"]): string {
  return KIND_ORDER.filter((kind) => byKind[kind] > 0)
    .map((kind) => `${byKind[kind]} ${byKind[kind] === 1 ? KIND_WORDS[kind].one : KIND_WORDS[kind].many}`)
    .join(" · ");
}
