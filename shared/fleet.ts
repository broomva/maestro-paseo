// RPC contracts for the Fleet view: fleet-reconcile's hourly runs per scope,
// their reports, the dry run's proposals with your verdict on each, and the
// fleet's asks and alerts as the Maestro work it raised for them. Served to
// Maestro's own surfaces only, never on the agent socket: a verdict is yours.
// Plain Zod values: this module is compiled into both bundles.

import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { GROUP_ORDER, ORCH_STATES } from "./states";

/**
 * How a scope's tick is doing:
 * - `ok`: it ticks on time and the latest tick passed (or is running);
 * - `failing`: the latest tick failed, or started and never finished;
 * - `missed`: it is scheduled, and no tick has started for longer than the
 *   threshold (FLEET_MISSED_MS, or two of its intervals if longer), counted
 *   from the later of the last tick and the Mac's last wake;
 * - `off`: the fleet's kill switch is off, so no tick runs, by your choice;
 * - `unscheduled`: no LaunchAgent runs it: ticks happen only by hand.
 */
export const FLEET_HEALTH = ["ok", "failing", "missed", "off", "unscheduled"] as const;
export type FleetHealthStatus = (typeof FLEET_HEALTH)[number];

/** No tick for this long, on a scheduled scope, puts it in Needs you. */
export const FLEET_MISSED_MS = 2 * 60 * 60 * 1000;

/**
 * One tick, as its ledger records say: `ok` (exit 0), `failed` (exit 1),
 * `running` (started, within its time budget), `died` (started, never
 * finished, past its budget), `unknown` (no exit code recorded: ticks from
 * before the ledger kept one, or a report with no ledger record).
 */
export const TICK_STATUS = ["ok", "failed", "running", "died", "unknown"] as const;
export type TickStatus = (typeof TICK_STATUS)[number];

/** Your verdict on one proposal. A later verdict on the same proposal replaces it. */
export const REVIEW_VERDICTS = ["accept", "reject"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export const REVIEW_NOTE_CHARS = 1000;

/** The fleet's spec's class table (§5.4), for class counts whose report names none. */
export const FLEET_CLASSES: Record<string, string> = {
  "1": "out of scope",
  "2": "dead: limit",
  "3": "waiting at a prompt",
  "4": "error",
  "5": "running",
  "6": "hung",
  "7": "blocked on the owner",
  "8": "closed",
  "9": "stalled",
  "9a": "idle, recent",
  "10": "unmanaged",
  unknown: "unknown",
};

/** A Maestro work item the fleet raised (an ask batch or an alert), as the Fleet view links it. */
export const FleetItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  state: z.enum(ORCH_STATES),
  group: z.enum(GROUP_ORDER),
  /** Whether it is in Needs you now (shared/needs-you.ts). */
  needsYou: z.boolean(),
});
export type FleetItem = z.infer<typeof FleetItemSchema>;

export const FleetHealthSchema = z.object({
  status: z.enum(FLEET_HEALTH),
  /** In words, one sentence. */
  reason: z.string(),
  /** When the condition began: the last tick's start for `missed`, the failing tick's for `failing`. */
  since: z.string().nullable(),
  /** The fleet's own open alert item for this condition, when it raised one. */
  item: FleetItemSchema.nullable(),
  /**
   * Whether this needs you on its own: `missed` or `failing`, and not already
   * in Needs you as the fleet's alert item (`item`). It is then shown and
   * counted once, as the fleet's item, never twice.
   */
  needsYou: z.boolean(),
});
export type FleetHealth = z.infer<typeof FleetHealthSchema>;

export const ClassCountSchema = z.object({ id: z.string(), name: z.string(), count: z.number() });
export type ClassCount = z.infer<typeof ClassCountSchema>;

export const FleetTickSchema = z.object({
  tick: z.number().int(),
  /** When it started (its tick_fire record, else its report's time). */
  at: z.string().nullable(),
  finishedAt: z.string().nullable(),
  status: z.enum(TICK_STATUS),
  exit: z.number().nullable(),
  /** Each step's exit code, as the tick wrote them: `recover=0 observe=0 report=0 ...`. */
  steps: z.string().nullable(),
  /** The first step that failed, as tick.sh names it in its alert (`tick-<step>`). */
  failedStep: z.string().nullable(),
  dryRun: z.boolean().nullable(),
  /** From its report; null when the tick wrote none. */
  mode: z.string().nullable(),
  classCounts: z.array(ClassCountSchema).nullable(),
  openAsks: z.number().nullable(),
  proposals: z.number().nullable(),
});
export type FleetTick = z.infer<typeof FleetTickSchema>;

export const FleetReviewSchema = z.object({
  verdict: z.enum(REVIEW_VERDICTS),
  note: z.string().nullable(),
  at: z.string(),
  /** The tick whose proposal you reviewed. */
  tick: z.number().nullable(),
});
export type FleetReview = z.infer<typeof FleetReviewSchema>;

/**
 * One thing the fleet would do, not done: a `would do` other than nothing in
 * its latest report (`report`, phase 1), or a verb its coordinator logged
 * under dry run (`act`, phase 2). `key` is stable across ticks while the
 * proposal stays the same, so one verdict holds for every tick that repeats it.
 */
export const FleetProposalSchema = z.object({
  key: z.string(),
  source: z.enum(["report", "act"]),
  tick: z.number().nullable(),
  at: z.string().nullable(),
  /** What it would do, in the fleet's words. */
  action: z.string(),
  /** The session it is about (report proposals). */
  session: z
    .object({
      id: z.string(),
      short: z.string(),
      name: z.string().nullable(),
      kind: z.string().nullable(),
      status: z.string().nullable(),
      cwd: z.string().nullable(),
    })
    .nullable(),
  classId: z.string().nullable(),
  className: z.string().nullable(),
  evidence: z.string().nullable(),
  /** The coordinator's verb (act proposals): mail, spawn, label or resume. */
  verb: z.string().nullable(),
  review: FleetReviewSchema.nullable(),
});
export type FleetProposal = z.infer<typeof FleetProposalSchema>;

export const FleetAskSchema = z.object({
  id: z.string(),
  key: z.string(),
  question: z.string(),
  class: z.string().nullable(),
  firstTick: z.number().nullable(),
  /** The batch that carries it now (its ledger intent id), and the Maestro work raised for that batch. */
  batch: z.string().nullable(),
  item: FleetItemSchema.nullable(),
});
export type FleetAsk = z.infer<typeof FleetAskSchema>;

export const FleetScopeSchema = z.object({
  id: z.string(),
  /** The config's mode (`report` or `act`) and whether it runs dry. */
  mode: z.string().nullable(),
  dryRun: z.boolean().nullable(),
  health: FleetHealthSchema,
  lastTick: z.object({ tick: z.number(), at: z.string().nullable(), status: z.enum(TICK_STATUS) }).nullable(),
  /** Proposals in the latest report with no verdict from you. */
  unreviewed: z.number(),
  openAsks: z.number(),
});
export type FleetScope = z.infer<typeof FleetScopeSchema>;

export const FleetDetailSchema = z.object({
  id: z.string(),
  stateDir: z.string(),
  schedule: z.object({ scheduled: z.boolean(), intervalMinutes: z.number().nullable() }),
  /** Newest first. */
  ticks: z.array(FleetTickSchema),
  report: z.object({ tick: z.number(), markdown: z.string(), truncated: z.boolean() }).nullable(),
  proposals: z.array(FleetProposalSchema),
  asks: z.array(FleetAskSchema),
  /** The fleet's alert items for this scope that are not done or canceled. */
  alerts: z.array(FleetItemSchema),
  /** Files that could not be read, in words. */
  warnings: z.array(z.string()),
});
export type FleetDetail = z.infer<typeof FleetDetailSchema>;

export const FLEET_TICKS = { min: 1, max: 100, default: 24 } as const;
/** report.md is read up to this many bytes. */
export const FLEET_REPORT_BYTES = 128 * 1024;

export const getFleet = defineRpc({
  name: "fleet.get",
  input: z.object({
    /** The scope to read in full; none: the first. */
    scope: z.string().optional(),
    ticks: z.number().int().min(FLEET_TICKS.min).max(FLEET_TICKS.max).default(FLEET_TICKS.default),
  }),
  output: z.object({
    scopes: z.array(FleetScopeSchema),
    detail: FleetDetailSchema.nullable(),
    /** The fleet config could not be read: why, in words. Scopes then come from the state dirs. */
    error: z.string().nullable(),
  }),
});
export type FleetView = z.infer<typeof getFleet.output>;

/** Your verdict on a proposal, written to the fleet's review file. Yours alone: never on the agent socket. */
export const reviewProposal = defineRpc({
  name: "fleet.review",
  input: z.object({
    scope: z.string().min(1),
    key: z.string().min(1),
    verdict: z.enum(REVIEW_VERDICTS),
    note: z.string().max(REVIEW_NOTE_CHARS).default(""),
  }),
  output: z.object({ proposal: FleetProposalSchema }),
});

/** A scope's tick that needs you on its own (FleetHealth.needsYou), as work.attention carries it. */
export const FleetNoticeSchema = z.object({
  scope: z.string(),
  status: z.enum(["missed", "failing"]),
  reason: z.string(),
  since: z.string().nullable(),
});
export type FleetNotice = z.infer<typeof FleetNoticeSchema>;
