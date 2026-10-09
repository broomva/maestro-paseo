// RPC contracts for the Loops view: every loop on this machine, what its
// intent says beside what is observed, and the drift between them (BRO-2911,
// workspace docs/specs/2026-10-07-unified-loop-layer.html). The intent is the
// ledger, `.broomva/loops/<id>.yaml` on the control repo's origin/main; the
// observation is computed on every read from each substrate's own record.
// Read-only: nothing here schedules, starts, stops or changes a loop. Plain
// Zod values: this module is compiled into both bundles.

import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { InstantSchema, SOURCE_STATUS, TimelineRunSchema } from "./timeline";

/** Where a loop runs (spec §1). */
export const SUBSTRATE_KINDS = [
  "launchd",
  "paseo-schedule",
  "paseo-heartbeat",
  "maestro-loop",
  "gha-schedule",
  "session-cron",
  "p9",
] as const;
export type SubstrateKind = (typeof SUBSTRATE_KINDS)[number];

export const LOOP_SCOPES = ["broomva", "sri", "external"] as const;
export type LoopScope = (typeof LOOP_SCOPES)[number];

export const DESIRED = ["active", "paused", "retired"] as const;
export type Desired = (typeof DESIRED)[number];

/**
 * The drift classes (spec §4), in the order a row shows them: the cause
 * first. Each is `data.kind` of a `loop.drift.detected` / `.cleared` line.
 */
export const DRIFT_CLASSES = [
  "paused_but_running",
  "orphaned",
  "active_but_absent",
  "bound_session_gone",
  "duplicate_binding",
  "target_changed",
  "prompt_mismatch",
  "state_lost",
  "tick_missing",
  "tick_unclosed",
  "failing",
  "missed",
  "skipped_busy",
  "expiring",
  "unregistered",
] as const;
export type DriftClass = (typeof DRIFT_CLASSES)[number];

/** The class as the spec names it: PAUSED_BUT_RUNNING. */
export const driftName = (kind: DriftClass): string => kind.toUpperCase();

/** One run, as the substrate recorded it; `scheduledFor` is a Paseo run's due time, the join key to a tick (§1a). */
export const LoopRunSchema = TimelineRunSchema.extend({ scheduledFor: InstantSchema.optional() });
export type LoopRun = z.infer<typeof LoopRunSchema>;

/** What is running (spec §2). */
export const LoopObservationSchema = z.object({
  /** `loop:launchd/com.broomva.kg-lint`, `loop:paseo-heartbeat/103a1850`, `loop:maestro/wake`, `loop:gha/<o>/<r>/<file>`. */
  subject: z.string(),
  kind: z.enum(SUBSTRATE_KINDS),
  ref: z.string(),
  name: z.string(),
  /** The adapter's guess; a ledger row's scope wins over it. */
  scope: z.enum(LOOP_SCOPES),
  /** on: will run · off: present, will not run (disabled, paused, completed) · gone: not found. */
  presence: z.enum(["on", "off", "gone"]),
  status: z.enum(SOURCE_STATUS),
  /** The status in one sentence, as the substrate's reader said it. */
  reason: z.string(),
  since: InstantSchema.nullable(),
  cadence: z.string(),
  next: InstantSchema.nullable(),
  last: LoopRunSchema.nullable(),
  /** Newest first, from the substrate's own record. */
  runs: z.array(LoopRunSchema),
  ephemeral: z.boolean(),
  /** A Paseo schedule's own name: what a `name:` ref joins on (§1a). */
  scheduleName: z.string().nullable().optional(),
  /** When the substrate record was made (a Paseo schedule's createdAt). */
  createdAt: InstantSchema.nullable().optional(),
  expiresAt: InstantSchema.nullable().optional(),
  /** What an agent-prompting substrate targets and says: a heartbeat's target.agentId and the schedule's prompt. */
  target: z.object({ agentId: z.string().nullable(), prompt: z.string().nullable() }).optional(),
  /** A session loop's session (P3's adapter fills it). */
  session: z
    .object({
      id: z.string(),
      agentId: z.string().nullable(),
      pid: z.number().nullable(),
      alive: z.boolean().nullable(),
      endedAt: InstantSchema.nullable(),
      /** The session's latest event of any type: ORPHANED is judged only while it is under 7 d old. */
      lastEventAt: InstantSchema.nullable().optional(),
    })
    .optional(),
  /** A session cron's createdAt is only a lower bound (the cron predates the hook). */
  createdAtLowerBound: z.boolean().optional(),
  recurring: z.boolean().optional(),
  /** The substrate's own record: a log path, a schedule file, a workflow URL. */
  where: z.string().nullable(),
});
export type LoopObservation = z.infer<typeof LoopObservationSchema>;

/** One `.broomva/loops/<id>.yaml` row, as the ledger reader parsed it (spec §1, §1a). */
export const LoopIntentSchema = z.object({
  id: z.string(),
  title: z.string(),
  purpose: z.string(),
  owner: z.string(),
  scope: z.enum(LOOP_SCOPES),
  initiative: z.string().nullable(),
  substrate: z.object({ kind: z.enum(SUBSTRATE_KINDS), ref: z.string() }),
  cadence: z.string(),
  /** Absent for scope sri. */
  desired: z.enum(DESIRED).nullable(),
  desiredSince: z.string().nullable(),
  reason: z.string().nullable(),
  reviewBy: z.string().nullable(),
  prompt: z.string().nullable(),
  session: z.enum(["bound", "fresh"]).nullable(),
  /** The tick's snapshot script, `.broomva/loops/checks/<name>.sh` (BRO-2942); only beside a prompt. */
  checks: z.string().nullable(),
  /** The ledger file as its repo's ref has it; prefixed `<label>:` when it comes from a repo other than the control repo. */
  file: z.string(),
});
export type LoopIntent = z.infer<typeof LoopIntentSchema>;

export const LoopDriftSchema = z.object({
  kind: z.enum(DRIFT_CLASSES),
  /** What is wrong, in a sentence. */
  detail: z.string(),
  /** The pinned fix (spec §4): a command to copy, or the steps. Maestro runs none of it. */
  fix: z.string(),
  /** Whether this drift is raised in Needs you (never for scope sri, nor for a class the Timeline already raises). */
  needsYou: z.boolean(),
});
export type LoopDrift = z.infer<typeof LoopDriftSchema>;

/** One loop on the tab: the intent beside the observation. */
export const LoopRowSchema = z.object({
  /** The row's subject: `loop:<id>` for a ledger row, the observation's for one with none. */
  subject: z.string(),
  /** The ledger id; null for an observation no row claims. */
  id: z.string().nullable(),
  name: z.string(),
  kind: z.enum(SUBSTRATE_KINDS),
  ref: z.string(),
  scope: z.enum(LOOP_SCOPES),
  owner: z.string().nullable(),
  purpose: z.string().nullable(),
  desired: z.enum(DESIRED).nullable(),
  /** Unregistered ephemerals: shown under Session & watchers, never drift. */
  section: z.enum(["loops", "ephemeral"]),
  intent: LoopIntentSchema.nullable(),
  observed: LoopObservationSchema.nullable(),
  /** The substrate could not be read this time: the row says so and judges nothing. */
  unread: z.boolean(),
  drift: z.array(LoopDriftSchema),
});
export type LoopRow = z.infer<typeof LoopRowSchema>;

/** A ledger file that could not be taken: shown in the tab, never a crash. */
export const LedgerErrorSchema = z.object({ file: z.string(), error: z.string() });
export type LedgerError = z.infer<typeof LedgerErrorSchema>;

export const getLoops = defineRpc({
  name: "loops.get",
  input: z.object({}),
  output: z.object({
    now: InstantSchema,
    /** The ledger's commit on origin/main; null when it could not be read. */
    ledger: z.object({ repo: z.string(), sha: z.string().nullable(), path: z.string() }).nullable(),
    rows: z.array(LoopRowSchema),
    ledgerErrors: z.array(LedgerErrorSchema),
    /** What could not be read, in words. */
    warnings: z.array(z.string()),
  }),
});
export type LoopsView = z.infer<typeof getLoops.output>;

/** A drift that needs you, as work.attention carries it (loopNeeds()). */
export const LoopNoticeSchema = z.object({
  /** `<subject>#<class>`: stable while the drift holds. */
  id: z.string(),
  subject: z.string(),
  loop: z.string(),
  kind: z.enum(DRIFT_CLASSES),
  detail: z.string(),
  fix: z.string(),
});
export type LoopNotice = z.infer<typeof LoopNoticeSchema>;
