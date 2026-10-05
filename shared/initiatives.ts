// RPC contracts for the Initiatives tab: the workspace's `.control/initiatives`
// files (one per intent, spec docs/specs/2026-10-03-initiative-ledger.html,
// workspace#894), each read as origin/main holds it with a checkout's edit
// that has not landed shown beside it, never instead of it; and the ideas
// filed for each, idea-triage asks in `.control/asks/ideas-<id>.yaml`,
// answered develop / park / kill through ask.answer like any other ask.
// Plain Zod values: this module is compiled into both bundles.

import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { DecisionAskSchema } from "./fleet";

export const INITIATIVE_STATUSES = ["active", "blocked_on_owner", "parked", "done", "killed"] as const;
export type InitiativeStatus = (typeof INITIATIVE_STATUSES)[number];

/** The intent the spec writes when the owner's words were never written down (§5.1). */
export const NOT_STATED = "(not stated verbatim)";

/** A YYYY-MM-DD date. */
export const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const PrLinkSchema = z.object({
  /** owner/repo#N, as the file writes it. */
  ref: z.string(),
  url: z.string(),
  /** From GitHub when it was cheap to ask (one batched query, cached): null when unknown. */
  state: z.enum(["open", "merged", "closed"]).nullable(),
});
export type PrLink = z.infer<typeof PrLinkSchema>;

export const SessionLinkSchema = z.object({
  /** As the file writes it: a hex id, often its first 8. */
  id: z.string(),
  /** The Paseo agent it names, when exactly one does; null when none is known here. */
  agentId: z.string().nullable(),
});
export type SessionLink = z.infer<typeof SessionLinkSchema>;

export const WaitingOnSchema = z.object({
  kind: z.string(),
  ref: z.string(),
  note: z.string().nullable(),
  /** For an ask: the ledger file and the ask it names (null: the whole ledger). */
  ledger: z.string().nullable(),
  askId: z.string().nullable(),
});
export type WaitingOn = z.infer<typeof WaitingOnSchema>;

/** A work item, as an idea's develop filed it. */
export const WorkRefSchema = z.object({ id: z.string(), title: z.string(), path: z.string() });
export type WorkRef = z.infer<typeof WorkRefSchema>;
export const DevelopedSchema = WorkRefSchema.extend({ ref: z.string() });

/** Why an initiative needs you: its review date passed while active or blocked, or its wake date came while parked. */
export const InitiativeStaleSchema = z.object({ kind: z.enum(["overdue", "wake"]), date: z.string() });

/** A checkout whose copy of the file changed and has not landed on origin/main (§5.4). */
export const LocalEditSchema = z.object({
  path: z.string(),
  branch: z.string().nullable(),
  /** The fields that copy changes, against the record. */
  fields: z.array(z.string()),
  /** Its status and next action as that copy says, when they differ: what the change is about. */
  status: z.string().nullable(),
  nextAction: z.string().nullable(),
});
export type LocalEdit = z.infer<typeof LocalEditSchema>;

export const InitiativeSchema = z.object({
  /** The file's id; for a file that cannot be read, its name without .yaml. */
  id: z.string(),
  file: z.string(),
  /** Where the record shown was read: origin/main, or (for a file only a checkout has) that checkout. */
  home: z.object({ kind: z.enum(["main", "checkout"]), path: z.string(), branch: z.string().nullable() }),
  /** Why the file cannot be read as an initiative, in words: shown as an error row, never hidden. */
  error: z.string().nullable(),
  title: z.string().nullable(),
  /** The owner's words; null when the file says it was not stated verbatim. */
  quote: z.string().nullable(),
  intentSource: z.string().nullable(),
  summary: z.string().nullable(),
  status: z.enum(INITIATIVE_STATUSES).nullable(),
  stated: z.string().nullable(),
  reviewBy: z.string().nullable(),
  wake: z.string().nullable(),
  nextAction: z.string().nullable(),
  driver: z.string().nullable(),
  waitingOn: z.array(WaitingOnSchema),
  linear: z.array(z.string()),
  prs: z.array(PrLinkSchema),
  repos: z.array(z.string()),
  sessions: z.array(SessionLinkSchema),
  asks: z.array(z.string()),
  exit: z.string().nullable(),
  closedAt: z.string().nullable(),
  outcome: z.string().nullable(),
  stale: InitiativeStaleSchema.nullable(),
  /** Checkouts with an edit of this file that has not landed. */
  local: z.array(LocalEditSchema),
  /** Its ideas: open ones wait on develop / park / kill; triaged ones were answered. */
  ideas: z.object({ open: z.number(), triaged: z.number() }),
});
export type Initiative = z.infer<typeof InitiativeSchema>;

/** A stale or overdue initiative, as work.attention carries it: it counts in Needs you. */
export const InitiativeNoticeSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(["overdue", "wake"]),
  date: z.string(),
});
export type InitiativeNotice = z.infer<typeof InitiativeNoticeSchema>;

export function initiativeNotice(initiative: Initiative): InitiativeNotice | null {
  if (!initiative.stale) return null;
  return {
    id: initiative.id,
    title: initiative.title ?? initiative.id,
    kind: initiative.stale.kind,
    date: initiative.stale.date,
  };
}

/**
 * Every initiative in the control repo and every idea filed for them: the
 * open ideas, then the latest triaged. `today` is the daemon's local date,
 * which every overdue badge is judged against.
 */
export const getInitiatives = defineRpc({
  name: "initiatives.list",
  input: z.object({}),
  output: z.object({
    controlRepo: z.string(),
    today: z.string(),
    initiatives: z.array(InitiativeSchema),
    ideas: z.array(DecisionAskSchema),
    /** The work item filed for each idea answered develop, by `<ledger>#<id>`; absent from an older daemon. */
    developed: z.array(DevelopedSchema).optional(),
    /** What could not be read, in words. */
    warnings: z.array(z.string()),
  }),
});
export type InitiativesView = z.infer<typeof getInitiatives.output>;

/** The ref a developed idea's work item carries (`idea:` in _work.md): its ledger and id. */
export const ideaRef = (ask: { ledger: string; id: string }): string => `${ask.ledger}#${ask.id}`;

/**
 * Files the held work item for an idea answered develop that has none: the
 * filing failed after the answer was written, or the idea was answered outside
 * Maestro. Idempotent: an idea that has its work item gets that one back.
 */
export const fileIdeaWork = defineRpc({
  name: "initiatives.file",
  input: z.object({ ledger: z.string().min(1), id: z.string().min(1) }),
  output: z.object({ work: WorkRefSchema.nullable(), warning: z.string().nullable() }),
});
