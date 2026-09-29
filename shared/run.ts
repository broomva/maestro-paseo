// How a run was started, in words: the provider, then the choices that shaped
// it. The receipts and the detail pane both say it this way.

import type { FeatureValues } from "./contracts";

export interface RunShape {
  provider: string;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  featureValues?: FeatureValues | null;
}

export function runTerms(run: Omit<RunShape, "provider">): string[] {
  const terms: string[] = [];
  if (run.modeId) terms.push(`mode ${run.modeId}`);
  if (run.thinkingOptionId) terms.push(`thinking ${run.thinkingOptionId}`);
  for (const [id, value] of Object.entries(run.featureValues ?? {})) {
    terms.push(value === true ? `${id} on` : value === false ? `${id} off` : `${id} ${value ?? "unset"}`);
  }
  return terms;
}

/** `claude/opus (mode bypassPermissions, thinking high)`; the provider alone when nothing else was chosen. */
export function describeRun(run: RunShape): string {
  const terms = runTerms(run);
  return terms.length > 0 ? `${run.provider} (${terms.join(", ")})` : run.provider;
}
