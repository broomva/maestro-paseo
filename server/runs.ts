// Starting runs on Paseo. Paseo is the runtime: a dispatch is a Paseo
// workspace (a worktree on a fresh `run/<id>` branch, the receipt) plus one
// agent carrying the work's brief. The agent is labelled with the work id so
// the binding is visible from Paseo itself.

import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { MaestroConfig, NextRun, Worker } from "../shared/contracts";
import { skipsPrompts } from "../shared/run";
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
 * How this item's runs start: what the work chose, else Settings. A mode is a
 * provider's own, so the Settings mode applies only while the run uses the
 * Settings provider; thinking and features are the work's alone. Dispatch
 * starts from this, and the wire shows it as `nextRun`, so the card and the
 * run cannot disagree.
 */
export function runSettings(config: MaestroConfig, item: StoredWork) {
  const contract = item.contract;
  const selection = contract.provider ?? config.provider;
  const sameProvider = providerFamily(selection) === providerFamily(config.provider);
  const modeId = contract.modeId ?? (sameProvider ? config.modeId : null);
  const fromSettings: NextRun["fromSettings"] = [];
  if (!contract.provider) fromSettings.push("provider");
  if (!contract.isolation) fromSettings.push("isolation");
  if (!contract.modeId && modeId) fromSettings.push("modeId");
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
    held: filedBeforeA8(item) ? FILED_BEFORE_A8 : item.contract.hold,
  };
}

/**
 * Why queued work the old routing filed from an answer waits for you: before
 * A8 (BRO-2990) an answer whose asker was gone became unheld queued work, and
 * the loop started it. The loop starts nothing now, so it would sit in Queued
 * unseen; it is yours, in Needs you, until you start or cancel it.
 */
export const FILED_BEFORE_A8 = "Filed from your answer before A8: start it yourself, or cancel it.";

/**
 * Queued work Maestro filed for an answer, with no hold: only the routing
 * before A8 filed that. Yours to start or cancel, as held work is. Pure.
 */
export function filedBeforeA8(item: StoredWork): boolean {
  if (!item.contract.answer || item.contract.hold) return false;
  const created = item.events.find((event) => event.type === "created");
  return created?.type === "created" && created.actor === "maestro";
}

/** Why a session or the loop leaves work to you: it carries a mode you chose for it. */
export const MODED_BY_YOU = "This work runs in a mode you chose; start it yourself.";

/** Why the loop leaves queued work to you: its run would edit files and run commands without asking. */
export const PROMPT_FREE = "runs without permission prompts; start it yourself";

/** Why a session or the loop leaves work to you: it is held for you (`hold`), as an idea you chose to develop is. */
export const HELD_FOR_YOU = "This work waits for you to start it.";

/**
 * Why only you may start this queued work, or null (BRO-2990): it is held for
 * you (or was filed from your answer before A8: FILED_BEFORE_A8), or carries
 * a mode (or an auto-approving feature) you chose for it, which no lane and
 * no conductor may start either. The loop flags it in Needs you as yours.
 * Settings' own mode is not a reason: a lane's run takes its lane's mode.
 */
export function yoursToStart(next: NextRun): string | null {
  if (next.held) return next.held === FILED_BEFORE_A8 ? FILED_BEFORE_A8 : HELD_FOR_YOU;
  const own = next.fromSettings.includes("modeId") ? null : next.modeId;
  if (skipsPrompts({ provider: next.provider, modeId: own, featureValues: next.featureValues })) return PROMPT_FREE;
  return own ? MODED_BY_YOU : null;
}

/** Start the item's run, as you asked for it: the one way a run starts (engine.ts dispatch, yours alone). */
export async function startRun(paseo: Paseo, config: MaestroConfig, item: StoredWork): Promise<Worker> {
  if (!item.contract.repo) {
    throw new DispatchError("This work has no repository to run in. Add a repo: line to _work.md.");
  }
  const run = runSettings(config, item);
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
