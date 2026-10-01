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

/** A mode as a provider list gives it. `isUnattended` is Paseo's own flag for a mode that never asks. */
export interface ModeFlag {
  id: string;
  isUnattended?: boolean;
}

/**
 * The modes Paseo marks `isUnattended`, by provider, for a provider list that
 * does not carry the flag. Paseo 0.8.0's does not: the flag lives on its
 * provider manifest, but the wire schema for a mode (protocol messages.ts:303,
 * AgentModeSchema) has no such field, so snapshot() and listModes() parse it
 * away. Lines are Paseo dedebbfc5 packages/protocol/src/provider-manifest.ts;
 * shared/run.test.ts holds this map to the pinned @getpaseo/protocol manifest.
 */
export const UNATTENDED_MODES: ReadonlyMap<string, readonly string[]> = new Map([
  ["claude", ["bypassPermissions"]], // provider-manifest.ts:73, "Skip all permission prompts"
  ["codex", ["full-access"]], // provider-manifest.ts:99
  ["copilot", ["allow-all"]], // provider-manifest.ts:124
  ["omp", ["full"]], // provider-manifest.ts:152 (also OMP's default mode, :255)
  // Not marked in the manifest: OpenCode reads Codex's id as its legacy full-access mode and turns
  // auto_accept on (server/src/server/agent/providers/opencode-agent.ts:143, :250 and :262).
  ["opencode", ["full-access"]],
]);

/**
 * The features that approve on their own when on: OpenCode's auto_accept,
 * "Automatically approves OpenCode tool permission prompts" (opencode-agent.ts:167;
 * unattended when true or "true", :287-291), and the same toggle on ACP
 * providers (acp-agent.ts:129 and :818).
 */
export const PROMPT_FREE_FEATURES: ReadonlySet<string> = new Set(["auto_accept"]);

/**
 * Whether a provider's mode runs without permission prompts. Paseo's own flag
 * decides when the provider list carries it: Paseo sets it only on the mode
 * that never asks, so on a list where any mode has it, a mode without it asks.
 * Otherwise UNATTENDED_MODES decides, and a provider it does not know is read
 * against every provider's modes, so a custom wrapper of a known agent warns.
 */
export function modeSkipsPrompts(
  provider: string | null | undefined,
  modeId: string | null | undefined,
  modes?: readonly ModeFlag[] | null,
): boolean {
  if (!modeId) return false;
  if (modes?.some((mode) => mode.isUnattended !== undefined)) {
    const listed = modes.find((mode) => mode.id === modeId);
    if (listed) return listed.isUnattended === true;
  }
  const family = (provider ?? "").trim().split("/")[0] ?? "";
  const known = UNATTENDED_MODES.get(family) ?? [...UNATTENDED_MODES.values()].flat();
  return known.includes(modeId);
}

/** Whether a run edits files and runs commands without asking: its mode (above) or an auto-approving feature. */
export function skipsPrompts(
  run: { provider?: string | null } & Pick<RunShape, "modeId" | "featureValues">,
  modes?: readonly ModeFlag[] | null,
): boolean {
  if (modeSkipsPrompts(run.provider, run.modeId, modes)) return true;
  return Object.entries(run.featureValues ?? {}).some(
    ([id, value]) => PROMPT_FREE_FEATURES.has(id) && (value === true || value === "true"),
  );
}

const SKIPS = "it can edit files and run commands without asking.";
/** What the composer and the Queued card say before a Dispatch that skips the prompts. */
export const SKIPS_WARNING = `This run skips permission prompts: ${SKIPS}`;

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
        warning: skips ? SKIPS_WARNING : null,
      }
    : {
        line: `If the session is gone, Unblock starts a new run ${where}, with ${how}.`,
        warning: skips ? `That new run would skip permission prompts: ${SKIPS}` : null,
      };
}
