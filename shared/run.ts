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

/** Modes that let a run edit files and run commands without asking first (Claude's and Codex's). */
export const PROMPT_FREE_MODES: ReadonlySet<string> = new Set(["bypassPermissions", "full-access"]);

export function skipsPrompts(modeId: string | null | undefined): boolean {
  return modeId != null && PROMPT_FREE_MODES.has(modeId);
}

/**
 * What the Queued card says before Dispatch: how the run will start, and a
 * warning when its mode skips permission prompts. Settings fills what is unset.
 */
export function queuedRunLine(
  run:
    | { provider?: string; modeId?: string; thinkingOptionId?: string; featureValues?: FeatureValues }
    | null
    | undefined,
): {
  line: string;
  warning: string | null;
} {
  if (!run) return { line: "Runs with your Settings defaults.", warning: null };
  const described = describeRun({ ...run, provider: run.provider ?? "the Settings provider" });
  return {
    line: `Runs with ${described}.`,
    warning: skipsPrompts(run.modeId)
      ? "This run skips permission prompts: it can edit files and run commands without asking."
      : null,
  };
}
