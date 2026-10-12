// The owner's verbs and their undo window (BRO-2999, B4: 8 s everywhere). Every
// verb that changes state is recorded when you make it, applies 8 s later (shared/undo.ts UNDO_MS)
// unless you undo it, and leaves a receipt: `{ receipt, appliesAt }`. One ledger
// on the server (server/owner-verbs.ts) holds them all; `verb.undo` takes any of
// them back, `verbs.list` reads what waits and what just settled. Plain Zod
// values only: this module is compiled into both bundles.

import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * The verbs behind the 8 s window. All but `work.verdict` are held by the ledger (server/owner-verbs.ts); a
 * decision at the gate (Change course, Cancel) keeps its own window on the work's events (server/engine.ts), and
 * verbs.list reads it in beside the rest, so one Undo serves them all.
 */
export const OWNER_VERBS = [
  "work.verdict",
  "approval.decide",
  "session.prompt",
  "work.cancel",
  "work.stop",
  "work.unblock",
  "work.leave-running",
  "ask.answer",
  "fleet.review",
  "config.set",
  "loop.wake",
] as const;
export type OwnerVerb = (typeof OWNER_VERBS)[number];

/** What a verb answers with: its receipt, and when it takes effect (8 s after the call, shared/undo.ts). */
export const VerbReceiptSchema = z.object({ receipt: z.string(), appliesAt: z.string() });
export type VerbReceipt = z.infer<typeof VerbReceiptSchema>;

/** A verb that has not taken effect yet. */
export const PendingVerbSchema = z.object({
  receipt: z.string(),
  verb: z.enum(OWNER_VERBS),
  /** What it acts on: a hold's key (`work:…`, `approval:…`), a work id, `config`, `loop`. */
  key: z.string(),
  /** What you did, in the past tense: "Allowed git push origin main". */
  label: z.string(),
  at: z.string(),
  appliesAt: z.string(),
  /** Time left in the undo window when this was read; 0 once it is due. */
  remainingMs: z.number(),
});
export type PendingVerb = z.infer<typeof PendingVerbSchema>;

export const SETTLED = ["applied", "undone", "dropped"] as const;
export type Settled = (typeof SETTLED)[number];

/** A verb that took effect, was undone, or was dropped because what it acted on had moved. */
export const SettledVerbSchema = z.object({
  receipt: z.string(),
  verb: z.enum(OWNER_VERBS),
  key: z.string(),
  label: z.string(),
  at: z.string(),
  settledAt: z.string(),
  outcome: z.enum(SETTLED),
  /** What it did, or why it was dropped, in words. */
  detail: z.string(),
});
export type SettledVerb = z.infer<typeof SettledVerbSchema>;

/** How far back `verbs.list` reads settled receipts: a day. */
export const RECENT_VERBS_MS = 24 * 60 * 60 * 1000;

/** Why a second verb on the same thing waits for the first. */
export const ALREADY_PENDING = "A decision is already waiting to take effect. Undo it first to change it.";

/**
 * Allow or Deny one held action (A1): a permission prompt a session is paused
 * on, or an action an agent asked leave for (`approval.request`). `key` names the
 * hold (`work:<id>`, `approval:<id>`); `action` is the exact action you saw. The
 * decision binds to it: when the action has changed by the time the window
 * closes (a new prompt, a new head), the decision is dropped, never applied to
 * something else. It takes effect UNDO_MS later, unless undone. Yours alone:
 * never on the agent socket.
 */
export const decideApproval = defineRpc({
  name: "approval.decide",
  input: z.object({
    key: z.string().min(1),
    allow: z.boolean(),
    action: z.string().min(1),
    /** For a permission prompt: its request id (`body.requestId`). When given, a different prompt is refused. */
    requestId: z.string().min(1).optional(),
    /** Why, for a Deny: it reaches the session. */
    note: z.string().optional(),
  }),
  output: VerbReceiptSchema,
});

/**
 * Send a prompt to an existing session: Continue, Change course, Send a prompt.
 * It never creates a session (A8). Takes effect UNDO_MS later, unless undone.
 */
export const promptSession = defineRpc({
  name: "session.prompt",
  input: z.object({
    agentId: z.string().min(1),
    prompt: z.string().trim().min(1, "Say what to send"),
    key: z.string().optional(),
  }),
  output: VerbReceiptSchema,
});

/** Take back any verb of the ledger while its window runs. */
export const undoVerb = defineRpc({
  name: "verb.undo",
  input: z.object({ receipt: z.string().min(1) }),
  output: z.object({ undone: z.boolean() }),
});

/** What waits to take effect, and what settled in the last day, newest first. */
export const listVerbs = defineRpc({
  name: "verbs.list",
  input: z.object({}),
  output: z.object({ pending: z.array(PendingVerbSchema), recent: z.array(SettledVerbSchema) }),
});
