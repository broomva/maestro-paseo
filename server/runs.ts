// Starting runs on Paseo. Paseo is the runtime: a dispatch is a Paseo
// workspace (a worktree on a fresh `run/<id>` branch, the receipt) plus one
// agent carrying the work's brief. The agent is labelled with the work id so
// the binding is visible from Paseo itself.

import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { MaestroConfig, NextRun, Worker } from "../shared/contracts";
import { type ModeFlag, modeSkipsPrompts, skipsPrompts } from "../shared/run";
import { ticketOf } from "../shared/text";
import { runFolder } from "./folders";
import { briefOf } from "./frontmatter";
import { type StoredWork, slugify } from "./store";

export type Paseo = PluginHandlerContext["paseo"];

export const WORK_LABEL = "maestro.work";

export class DispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchError";
  }
}

/** `claude` becomes `claude/<default model>`; `claude/opus` passes through. */
export async function resolveProvider(paseo: Paseo, selection: string, cwd: string): Promise<string> {
  const trimmed = selection.trim();
  if (trimmed.includes("/")) return trimmed;
  const result = await paseo.providers.listModels(trimmed, { cwd });
  const models = (result.models ?? []).filter((model) => model.isSelectable !== false);
  const model = models.find((candidate) => candidate.isDefault) ?? models[0];
  if (!model) {
    throw new DispatchError(`Provider "${trimmed}" has no models available${result.error ? `: ${result.error}` : ""}`);
  }
  return `${trimmed}/${model.id}`;
}

export function runBranch(random: () => string = () => Math.random().toString(16).slice(2, 10)): string {
  return `run/${random()}`;
}

export function composePrompt(item: StoredWork, branch: string | null): string {
  const brief = briefOf(item.work.body);
  const checks = item.contract.checks;
  const lines = [
    `# ${item.title}`,
    "",
    brief || "No brief was written beyond the title. Do the smallest complete version of it.",
    "",
    "## How this run works",
    `This is a tracked work item. ${branch ? `You are in an isolated worktree on branch \`${branch}\`.` : "You are working directly in the project directory."}`,
    "- Commit your changes on the current branch. Do not merge, push, or open a pull request unless the brief asks for it.",
    "- When you finish, a person reviews the result before it counts as done.",
  ];
  if (checks.length > 0) {
    lines.push("", "## Done means these checks pass", ...checks.map((check) => `- ${check.name}: \`${check.run}\``));
    lines.push("Do not edit the checks or their tests to make them pass.");
  }
  lines.push(
    "",
    "## End your final message with",
    "## Decided",
    "- up to three decisions you made, each with its reason",
    "## Ask",
    "One sentence: what you need from the reviewer.",
  );
  return lines.join("\n");
}

/** `claude/opus` is a `claude` run. */
export function providerFamily(selection: string): string {
  return selection.trim().split("/")[0] ?? "";
}

/**
 * The profile a run nobody watches starts with: its provider and the mode it
 * takes (frame D3: workers run in a mode that never asks). Until the socket
 * verifies its caller (BRO-2996) and `.broomva/lanes.yaml` exists (S-lanes,
 * BRO-2989), the caller never chooses it: it is your Settings (settingsLane),
 * whoever asked. `modes` is the provider's list, so modeSkipsPrompts can read
 * Paseo's own flag.
 */
export interface LaneProfile {
  /** Where the profile comes from, in words: "your Settings". */
  name: string;
  provider: string;
  modeId: string | null;
  modes?: readonly ModeFlag[] | null;
}

/** Your Settings as the profile of every run nobody watches, until callers are verified (BRO-2996). */
export function settingsLane(config: MaestroConfig): LaneProfile {
  return { name: "your Settings", provider: config.provider, modeId: config.modeId ?? null, modes: null };
}

/**
 * Why a run nobody watches may not start with this profile, or null
 * (BRO-2990, owner answer A8). Such a run takes the profile's mode, and
 * `modeId: null` never means Paseo's default, which is Always ask: a run that
 * asks with nobody to answer stops at its first command, as the six in
 * 13b97ad9 did. So there must be a profile, it must name a mode, the mode must
 * be the run's own provider's, and it must not ask. `unreadable`: why the
 * profile could not be read (a timeout, an error), said apart. Pure.
 */
export function unattendedRefusal(
  lane: LaneProfile | null,
  selection: string,
  unreadable: string | null = null,
): string | null {
  const start = "A run nobody watches never starts in Always ask, so this one was not started";
  const yours = "Start it yourself in Maestro, or set a mode that does not ask in Settings.";
  if (!lane && unreadable) return `${start}: Maestro could not read its profile (${unreadable}). ${yours}`;
  if (!lane) return `${start}: Maestro has no profile for it. ${yours}`;
  if (!lane.modeId) return `${start}: ${lane.name} name no mode for it. ${yours}`;
  if (providerFamily(lane.provider) !== providerFamily(selection)) {
    return `${start}: the mode in ${lane.name} is ${providerFamily(lane.provider)}'s, and this work runs ${providerFamily(selection)}. ${yours}`;
  }
  if (!modeSkipsPrompts(lane.provider, lane.modeId, lane.modes)) {
    return `${start}: the mode in ${lane.name} (${lane.modeId}) asks before it acts, so the run would stop at its first command. ${yours}`;
  }
  return null;
}

/**
 * How this item's runs start: what the work chose, else Settings. A mode is a
 * provider's own, so the Settings mode applies only while the run uses the
 * Settings provider; thinking and features are the work's alone. Dispatch
 * starts from this, and the wire shows it as `nextRun`, so the card and the
 * run cannot disagree. A run nobody watches (`lane`, already cleared by
 * unattendedRefusal) takes its profile's mode.
 */
export function runSettings(config: MaestroConfig, item: StoredWork, lane?: LaneProfile | null) {
  const contract = item.contract;
  const selection = contract.provider ?? config.provider;
  const sameProvider = providerFamily(selection) === providerFamily(config.provider);
  const modeId = lane?.modeId ?? contract.modeId ?? (sameProvider ? config.modeId : null);
  const fromSettings: NextRun["fromSettings"] = [];
  if (!contract.provider) fromSettings.push("provider");
  if (!contract.isolation) fromSettings.push("isolation");
  if (!lane?.modeId && !contract.modeId && modeId) fromSettings.push("modeId");
  return {
    selection,
    isolation: contract.isolation ?? config.isolation,
    modeId,
    thinkingOptionId: contract.thinkingOptionId,
    featureValues: contract.featureValues,
    fromSettings,
  };
}

/** runSettings in the wire's shape: what the cards show before Dispatch or Unblock. */
export function nextRun(config: MaestroConfig, item: StoredWork): NextRun {
  const run = runSettings(config, item);
  return {
    provider: run.selection,
    isolation: run.isolation,
    modeId: run.modeId ?? null,
    thinkingOptionId: run.thinkingOptionId ?? null,
    featureValues: run.featureValues ? { ...run.featureValues } : null,
    fromSettings: run.fromSettings,
    held: item.contract.hold,
  };
}

/** Why a session or the loop leaves work to you: it carries a mode you chose for it. */
export const MODED_BY_YOU = "This work runs in a mode you chose; start it yourself.";

/** Why the loop leaves queued work to you: its run would edit files and run commands without asking. */
export const PROMPT_FREE = "runs without permission prompts; start it yourself";

/** Why a session or the loop leaves work to you: it is held for you (`hold`), as an idea you chose to develop is. */
export const HELD_FOR_YOU = "This work waits for you to start it.";

/**
 * Why only you may start this queued work, or null (BRO-2990): it is held for
 * you, or carries a mode (or an auto-approving feature) you chose for it,
 * which a session's dispatch refuses (engine.ts startRefusal), so no lane and
 * no conductor can start it either. The loop flags it in Needs you as yours.
 * Settings' own mode is not a reason: a lane's run takes its lane's mode.
 */
export function yoursToStart(next: NextRun): string | null {
  if (next.held) return HELD_FOR_YOU;
  const own = next.fromSettings.includes("modeId") ? null : next.modeId;
  if (skipsPrompts({ provider: next.provider, modeId: own, featureValues: next.featureValues })) return PROMPT_FREE;
  return own ? MODED_BY_YOU : null;
}

/** Start the item's run; `lane` for a run nobody watches, which takes the lane profile's mode (runSettings). */
export async function startRun(
  paseo: Paseo,
  config: MaestroConfig,
  item: StoredWork,
  lane?: LaneProfile | null,
): Promise<Worker> {
  if (!item.contract.repo) {
    throw new DispatchError("This work has no repository to run in. Add a repo: line to _work.md.");
  }
  const run = runSettings(config, item, lane);
  // Every run starts here, whichever verb reached it: the folder is checked where it is used.
  const folder = await runFolder(item.contract.repo, { workRoot: config.workRoot, isolation: run.isolation });
  if (folder.refusal) throw new DispatchError(folder.refusal);
  const repo = folder.path;
  const provider = await resolveProvider(paseo, run.selection, repo);
  const branch = run.isolation === "worktree" ? runBranch() : null;
  const workspace = branch
    ? await paseo.workspaces.create({
        title: item.title,
        source: {
          kind: "worktree",
          cwd: repo,
          action: "branch-off",
          branchName: branch,
          worktreeSlug: `${slugify(item.title).slice(0, 32)}-${branch.slice(4)}`,
        },
      })
    : await paseo.workspaces.open(repo);
  const agent = await workspace.agents.create({
    config: {
      provider,
      ...(run.modeId ? { modeId: run.modeId } : {}),
      ...(run.thinkingOptionId ? { thinkingOptionId: run.thinkingOptionId } : {}),
      ...(run.featureValues ? { featureValues: { ...run.featureValues } } : {}),
    },
    title: item.title,
    prompt: composePrompt(item, branch),
    labels: {
      [WORK_LABEL]: item.contract.id,
      ...(ticketOf(item.title) ? { ticket: ticketOf(item.title) as string } : {}),
    },
  });
  return {
    agentId: agent.id,
    workspaceId: workspace.id,
    provider,
    branch,
    cwd: agent.cwd ?? workspace.directory ?? repo,
    modeId: run.modeId ?? null,
    thinkingOptionId: run.thinkingOptionId ?? null,
    featureValues: run.featureValues ? { ...run.featureValues } : null,
  };
}
