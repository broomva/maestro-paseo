// Starting runs on Paseo. Paseo is the runtime: a dispatch is a Paseo
// workspace (a worktree on a fresh `run/<id>` branch, the receipt) plus one
// agent carrying the work's brief. The agent is labelled with the work id so
// the binding is visible from Paseo itself.

import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { MaestroConfig, Worker } from "../shared/contracts";
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
 * Settings provider; thinking and features are the work's alone.
 */
export function runSettings(config: MaestroConfig, item: StoredWork) {
  const contract = item.contract;
  const selection = contract.provider ?? config.provider;
  const sameProvider = providerFamily(selection) === providerFamily(config.provider);
  return {
    selection,
    isolation: contract.isolation ?? config.isolation,
    modeId: contract.modeId ?? (sameProvider ? config.modeId : null),
    thinkingOptionId: contract.thinkingOptionId,
    featureValues: contract.featureValues,
  };
}

export async function startRun(paseo: Paseo, config: MaestroConfig, item: StoredWork): Promise<Worker> {
  const repo = item.contract.repo;
  if (!repo) throw new DispatchError("This work has no repository to run in. Add a repo: line to _work.md.");
  const run = runSettings(config, item);
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
    labels: { [WORK_LABEL]: item.contract.id },
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
