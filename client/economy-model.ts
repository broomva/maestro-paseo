// The Fleet's Economy section (BRO-3118), in words: one row per tier that ran, and a line for the whole. Pure, so
// every rule is tested; the screen (fleet-economy.tsx) only lays the words out.

import { ECONOMY_BUCKETS, type EconomyBucket, type EconomyBucketName, type EconomySummary } from "../shared/economy";
import { plural } from "./format";

/** Tokens as a person reads them: 950, 12k, 1.4M. */
export function tokenWords(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${n < 10_000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") : Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

const TITLE: Record<EconomyBucketName, string> = {
  mechanical: "Mechanical",
  standard: "Standard",
  frontier: "Frontier",
  apex: "Apex",
  unknown: "Unknown tier",
};

export interface EconomyRow {
  name: EconomyBucketName;
  title: string;
  /** The row's facts, in the order a reader scans them; a part that is zero and says nothing is left out. */
  parts: string[];
  /** The same as one sentence for a screen reader. */
  words: string;
}

/** Runs, approved, tokens per approved, first pass, escalations and raises, unmeasured: what a tier's row says. */
export function partsOf(bucket: EconomyBucket): string[] {
  const parts = [plural(bucket.runs, "run"), `${bucket.approved} approved`];
  parts.push(
    bucket.tokensPerApproved === null
      ? "no tokens per approved yet"
      : `${tokenWords(bucket.tokensPerApproved)} tokens per approved`,
  );
  parts.push(bucket.firstPass === null ? "no first pass yet" : `${Math.round(bucket.firstPass * 100)}% first pass`);
  parts.push(plural(bucket.escalations, "escalation"));
  parts.push(
    bucket.raises > 0 ? `${plural(bucket.raises, "raise")} in ${plural(bucket.raisedRuns, "run")}` : "no raises",
  );
  if (bucket.unmeasured > 0) parts.push(`${bucket.unmeasured} unmeasured`);
  return parts;
}

/** One row per tier that ran in the window, lowest tier first and the unknown last. */
export function economyRows(summary: EconomySummary): EconomyRow[] {
  return ECONOMY_BUCKETS.filter((name) => summary.tiers[name].runs > 0).map((name) => {
    const parts = partsOf(summary.tiers[name]);
    return { name, title: TITLE[name], parts, words: `${TITLE[name]}: ${parts.join(", ")}` };
  });
}

/** The whole window in one line. */
export function totalWords(summary: EconomySummary): string {
  const total = summary.totals;
  const days = summary.windowDays === 1 ? "the last day" : `the last ${summary.windowDays} days`;
  if (total.runs === 0) return `No runs in ${days}.`;
  const first = total.firstPass === null ? null : `${Math.round(total.firstPass * 100)}% first pass`;
  return [
    `In ${days}: ${plural(total.runs, "run")} on ${plural(total.works, "work item")}`,
    `${total.approved} approved`,
    `${tokenWords(total.tokens)} tokens`,
    ...(first ? [first] : []),
    ...(total.raisedRuns > 0 ? [plural(total.raisedRuns, "run") + " raised"] : []),
    ...(total.unmeasured > 0 ? [`${total.unmeasured} unmeasured`] : []),
  ].join(" · ");
}
