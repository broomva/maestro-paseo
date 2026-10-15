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

/** One bucket's numbers. The key names are read by the workspace coordinator: keep them. */
export const EconomyBucketSchema = z.object({
  /** Distinct sessions (agent ids) that ran. */
  runs: z.number(),
  /** Distinct work items with at least one run here. */
  works: z.number(),
  /** Work whose approve verdict followed a run here. */
  approved: z.number(),
  /** Send-back verdicts that followed a run here. */
  sentBack: z.number(),
  /** Each run's latest cumulative input + output + cache creation, subagents included. */
  tokens: z.number(),
  cacheRead: z.number(),
  tokensPerApproved: z.number().nullable(),
  cacheReadPerApproved: z.number().nullable(),
  /** Approved work with one dispatch and no send-back, over approved: 0 to 1, null when nothing is approved. */
  firstPass: z.number().nullable(),
  /** Work whose later dispatch moved up a tier into this bucket. */
  escalations: z.number(),
  /** Subagents (and mid-run model switches) above the run's own tier, summed over the runs. */
  raises: z.number(),
  /** Runs with at least one raise. */
  raisedRuns: z.number(),
  /** Runs whose usage could not be read. */
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
