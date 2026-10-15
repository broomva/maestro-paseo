// The delegation economy (BRO-3118): what each tier of model cost over a window and how often its work passed.
// Computed from the work items' receipts (server/economy-model.ts), written to ~/.config/maestro-paseo/economy.json
// for the workspace coordinator, and served to the Fleet view. Plain Zod values: compiled into both bundles.

import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** The buckets work is counted in: the four tiers, and the runs whose tier nothing says. */
export const ECONOMY_BUCKETS = ["mechanical", "standard", "frontier", "apex", "unknown"] as const;
export type EconomyBucketName = (typeof ECONOMY_BUCKETS)[number];

/** The days an economy summary looks back, unless asked for another. */
export const ECONOMY_DAYS = { min: 1, max: 90, default: 7 } as const;

export const TokensSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheCreation: z.number(),
});
export type Tokens = z.infer<typeof TokensSchema>;

/**
 * One bucket's numbers. The key names are read by the workspace coordinator: keep them. A run is in the bucket of its
 * effective tier: its latest reading's, else the one declared at dispatch, else the one its model implies, else
 * `unknown`. The totals are the sum of the buckets (`works` is counted once overall).
 */
export const EconomyBucketSchema = z.object({
  /** Distinct sessions (agent ids) with a receipt in the window. */
  runs: z.number(),
  /** Distinct work items with at least one run here. */
  works: z.number(),
  /**
   * Work approved in the window: by an approve verdict, or, for work no verdict closed (an auto gate's checks, a merged
   * branch), by landing as done (a send-back before it only costs it its first pass). Each work counts once, in the
   * bucket of the latest run before its last approval, whether or not that run is itself inside the window: a bucket
   * can show approvals with `runs: 0`.
   */
  approved: z.number(),
  /** Send-back (revise) verdicts made in the window, in the bucket of the latest run before each. */
  sentBack: z.number(),
  /** Each measured run's latest cumulative input + output + cache creation, subagents included. A run never read adds none. */
  tokens: z.number(),
  cacheRead: z.number(),
  /**
   * tokens over the approvals credited to a run in the window whose usage was read (the runs whose tokens are in the
   * numerator); null when there are none.
   */
  tokensPerApproved: z.number().nullable(),
  cacheReadPerApproved: z.number().nullable(),
  /**
   * Over approved, 0 to 1 (null when nothing is approved): approvals with no send-back and no second run (dispatch or
   * adoption) before them, judged as things stood at the approval.
   */
  firstPass: z.number().nullable(),
  /** Re-dispatches that moved up a tier from the previous run, counted in the tier moved to: one per event. */
  escalations: z.number(),
  /**
   * What runs used above their own tier, by tier however a model is spelled: the dispatched model above the declared
   * tier, a main-thread switch to a higher tier, and each subagent transcript (at any depth) on a higher tier.
   */
  raises: z.number(),
  /** Runs with at least one raise. */
  raisedRuns: z.number(),
  /** Runs whose usage was not read: no reading yet, or a reading that says why not. */
  unmeasured: z.number(),
});
export type EconomyBucket = z.infer<typeof EconomyBucketSchema>;

export const EconomySummarySchema = z.object({
  generatedAt: z.string(),
  windowDays: z.number(),
  tiers: z.object({
    mechanical: EconomyBucketSchema,
    standard: EconomyBucketSchema,
    frontier: EconomyBucketSchema,
    apex: EconomyBucketSchema,
    unknown: EconomyBucketSchema,
  }),
  totals: EconomyBucketSchema,
});
export type EconomySummary = z.infer<typeof EconomySummarySchema>;

export const getEconomy = defineRpc({
  name: "economy.get",
  input: z.object({ days: z.number().int().min(ECONOMY_DAYS.min).max(ECONOMY_DAYS.max).optional() }),
  output: EconomySummarySchema,
});
