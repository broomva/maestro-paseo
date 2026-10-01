// How a run was started, in words: the provider, then the choices that shaped
// it. The receipts and the detail pane both say it this way.

import type { FeatureValues, NextRun } from "./contracts";

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

/**
 * What lets a run edit files and run commands without asking first. Sources,
 * in Paseo (dedebbfc5) packages/server/src/server/agent/providers/:
 * - `bypassPermissions`: Claude's mode, "Skip all permission prompts" (claude/agent.ts:344).
 * - `full-access`: Codex's mode, "without additional prompts" (codex-app-server-agent.ts:238);
 *   OpenCode reads the same id as its legacy full-access mode and turns auto_accept on
 *   (opencode-agent.ts:143, :250 and :262).
 * - `auto_accept` on: OpenCode's feature, "Automatically approves OpenCode tool permission
 *   prompts" (opencode-agent.ts:167; unattended when true or "true", :287-291), and the
 *   same toggle on ACP providers (acp-agent.ts:129 and :818).
 */
export const PROMPT_FREE_MODES: ReadonlySet<string> = new Set(["bypassPermissions", "full-access"]);
export const PROMPT_FREE_FEATURES: ReadonlySet<string> = new Set(["auto_accept"]);

export function skipsPrompts(run: Pick<RunShape, "modeId" | "featureValues">): boolean {
  if (run.modeId != null && PROMPT_FREE_MODES.has(run.modeId)) return true;
  return Object.entries(run.featureValues ?? {}).some(
    ([id, value]) => PROMPT_FREE_FEATURES.has(id) && (value === true || value === "true"),
  );
}

const SKIPS = "it can edit files and run commands without asking.";

/**
 * What a card says before a verb that can start a run: Dispatch on a Queued
 * card, Unblock on a Stuck one (it starts a new run when the session is gone).
 * Every part Settings fills is marked, and a run that skips permission
 * prompts is warned about, wherever its mode or features came from.
 */
export function nextRunCopy(
  next: NextRun | null | undefined,
  card: "queued" | "stuck",
): { line: string; warning: string | null } {
  if (!next) {
    return {
      line:
        card === "queued"
          ? "Queued. Dispatching starts an agent the way your Settings say."
          : "If the session is gone, Unblock starts a new run the way your Settings say.",
      warning: null,
    };
  }
  const mark = (field: NextRun["fromSettings"][number], words: string) =>
    next.fromSettings.includes(field) ? `${words} (from Settings)` : words;
  const where = mark(
    "isolation",
    next.isolation === "directory" ? "in the repository itself" : "in a fresh worktree on its own run branch",
  );
  const terms = [
    ...(next.modeId ? [mark("modeId", `mode ${next.modeId}`)] : []),
    ...runTerms({ thinkingOptionId: next.thinkingOptionId, featureValues: next.featureValues }),
  ];
  const how = `${mark("provider", next.provider)}${terms.length > 0 ? `: ${terms.join(", ")}` : ""}`;
  const skips = skipsPrompts(next);
  return card === "queued"
    ? {
        line: `Queued. Dispatching starts an agent ${where}. Runs with ${how}.`,
        warning: skips ? `This run skips permission prompts: ${SKIPS}` : null,
      }
    : {
        line: `If the session is gone, Unblock starts a new run ${where}, with ${how}.`,
        warning: skips ? `That new run would skip permission prompts: ${SKIPS}` : null,
      };
}
