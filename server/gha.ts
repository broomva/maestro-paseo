// GitHub Actions schedules as loop observations (BRO-2911 spec §2, §3): each
// repo's workflows, its runs that the schedule started, and whether a
// workflow's file still has a `schedule:`. Read through `gh api` (no write
// verb is ever built here: every call is a GET), cached GHA_CACHE_MS per
// repo, so a disabled workflow shows on the first read after the cache ends.
//
// Which workflows: every one a ledger row names, and every one whose runs the
// schedule started in the last GHA_RECENT_MS (one a row does not name is then
// UNREGISTERED in the reconcile). The parse is pure (ghaObservations).

import { execFile } from "node:child_process";
import type { LoopObservation, LoopRun } from "../shared/loops";
import type { SourceStatus } from "../shared/timeline";
import { dueTimes, parseCron } from "./cron";

export const GHA_CACHE_MS = 10 * 60_000;
/** A workflow the schedule ran within this is a scheduled one, named by a row or not. */
export const GHA_RECENT_MS = 14 * 24 * 60 * 60_000;
const RUNS = 50;

/** `gh` with its arguments; answers stdout. */
export type Gh = (args: readonly string[]) => Promise<string>;

export const execGh: Gh = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      "gh",
      [...args],
      { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1" } },
      (error, stdout, stderr) => {
        if (error)
          reject(new Error(`gh ${args.slice(0, 2).join(" ")}: ${(stderr || error.message).trim().split("\n")[0]}`));
        else resolve(stdout);
      },
    );
  });

export interface GhaWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
  html_url?: string;
}

export interface GhaRun {
  workflow_id: number;
  status: string | null;
  conclusion: string | null;
  created_at: string;
  run_started_at?: string | null;
  updated_at?: string | null;
  html_url?: string;
  event?: string;
}

/** One repo as read: its workflows, its schedule-started runs, and the `schedule:` crons of the files read. */
export interface GhaRepoRead {
  repo: string;
  workflows: GhaWorkflow[];
  runs: GhaRun[];
  /** Workflow path → its schedule crons (empty: no `schedule:`); a path not here was not read. */
  crons: Map<string, string[]>;
}

/** The `cron:` lines under a workflow's `schedule:`; empty when it has none. Read as text: a cron line is one shape. */
export function scheduleCrons(text: string): string[] {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => /^\s*schedule\s*:/.test(line));
  if (at < 0) return [];
  const indent = (lines[at] ?? "").search(/\S/);
  const crons: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (line.search(/\S/) <= indent) break;
    const match = /cron\s*:\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/.exec(line);
    if (match?.[1]) crons.push(match[1].trim());
  }
  return crons;
}

const RUN_STATUS = (run: GhaRun): LoopRun["status"] =>
  run.status !== "completed"
    ? "running"
    : run.conclusion === "success"
      ? "ok"
      : run.conclusion === "skipped" || run.conclusion === "cancelled"
        ? "skipped"
        : run.conclusion === "failure" || run.conclusion === "timed_out" || run.conclusion === "startup_failure"
          ? "failed"
          : "unknown";

/** The observations of one repo: the named workflows and the recently scheduled ones. */
export function ghaObservations(read: GhaRepoRead, named: ReadonlySet<string>, now: number): LoopObservation[] {
  const [owner] = read.repo.split("/");
  const out: LoopObservation[] = [];
  for (const workflow of read.workflows) {
    const runs = read.runs
      .filter((run) => run.workflow_id === workflow.id && (run.event ?? "schedule") === "schedule")
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const ref = `${read.repo}/${workflow.path}`;
    const recent = runs.some((run) => now - Date.parse(run.created_at) < GHA_RECENT_MS);
    if (!named.has(ref) && !recent) continue;
    const crons = read.crons.get(workflow.path);
    const scheduled = crons ? crons.length > 0 : recent;
    const active = workflow.state === "active";
    const loopRuns: LoopRun[] = runs.map((run) => ({
      at: new Date(Date.parse(run.run_started_at ?? run.created_at)).toISOString(),
      endedAt: run.status === "completed" && run.updated_at ? new Date(Date.parse(run.updated_at)).toISOString() : null,
      status: RUN_STATUS(run),
      exit: null,
      detail: run.conclusion ?? run.status,
    }));
    const last = loopRuns[0] ?? null;
    let status: SourceStatus;
    let reason: string;
    if (!active || !scheduled) {
      status = "off";
      reason = !active ? `The workflow is ${workflow.state}.` : "Its file has no schedule:.";
    } else if (!last) {
      status = "unknown";
      reason = "No scheduled run yet.";
    } else if (last.status === "running") {
      status = "running";
      reason = "Running now.";
    } else if (last.status === "failed") {
      status = "failed";
      reason = `Its last scheduled run ended ${last.detail}.`;
    } else {
      status = "ok";
      reason = `Its last scheduled run ended ${last.detail}.`;
    }
    const specs = (crons ?? []).flatMap((cron) => parseCron(cron) ?? []);
    const next = active && scheduled ? dueTimes(specs, "UTC", now, now + 8 * 24 * 60 * 60_000, 1)[0] : undefined;
    out.push({
      subject: `loop:gha/${read.repo}/${workflow.path.split("/").at(-1)}`,
      kind: "gha-schedule",
      ref,
      name: `${read.repo.split("/")[1]} · ${workflow.name}`,
      scope: owner === "broomva" ? "broomva" : "external",
      presence: active && scheduled ? "on" : "off",
      status,
      reason,
      since: last?.at ?? null,
      cadence: crons && crons.length > 0 ? crons.map((cron) => `cron ${cron} (UTC)`).join(", ") : "schedule",
      next: next !== undefined ? new Date(next).toISOString() : null,
      last,
      runs: loopRuns.slice(0, 20),
      ephemeral: false,
      where: workflow.html_url ?? `https://github.com/${read.repo}/actions`,
    });
  }
  return out;
}

/** The repos to read and the workflow refs the ledger names, from the gha rows' refs. */
export function ghaTargets(refs: readonly string[]): { repos: string[]; named: Set<string> } {
  const named = new Set(refs);
  const repos = [...new Set(refs.map((ref) => ref.split("/").slice(0, 2).join("/")))].sort();
  return { repos, named };
}

/** The reader: one repo read at most every GHA_CACHE_MS; a repo that fails keeps its last read, said in warnings. */
export class GhaSchedules {
  private readonly cache = new Map<string, { at: number; read: GhaRepoRead }>();

  constructor(
    private readonly gh: Gh = execGh,
    private readonly now: () => number = Date.now,
  ) {}

  async observe(
    refs: readonly string[],
    warnings: string[],
  ): Promise<{ observations: LoopObservation[]; unread: boolean }> {
    const { repos, named } = ghaTargets(refs);
    let unread = false;
    const observations: LoopObservation[] = [];
    for (const repo of repos) {
      const read = await this.repo(repo, named).catch((error) => {
        warnings.push(`GitHub Actions for ${repo} could not be read: ${(error as Error).message}`);
        return this.cache.get(repo)?.read ?? null;
      });
      if (!read) {
        unread = true;
        continue;
      }
      observations.push(...ghaObservations(read, named, this.now()));
    }
    return { observations, unread };
  }

  private async repo(repo: string, named: ReadonlySet<string>): Promise<GhaRepoRead> {
    const kept = this.cache.get(repo);
    if (kept && this.now() - kept.at < GHA_CACHE_MS) return kept.read;
    const [workflows, runs] = await Promise.all([
      this.gh(["api", `repos/${repo}/actions/workflows?per_page=100`]).then(
        (text) => (JSON.parse(text) as { workflows: GhaWorkflow[] }).workflows,
      ),
      this.gh(["api", `repos/${repo}/actions/runs?event=schedule&per_page=${RUNS}`]).then(
        (text) => (JSON.parse(text) as { workflow_runs: GhaRun[] }).workflow_runs,
      ),
    ]);
    const crons = new Map<string, string[]>();
    const now = this.now();
    for (const workflow of workflows) {
      const recent = runs.some(
        (run) => run.workflow_id === workflow.id && now - Date.parse(run.created_at) < GHA_RECENT_MS,
      );
      if (!named.has(`${repo}/${workflow.path}`) && !recent) continue;
      const text = await this.gh([
        "api",
        `repos/${repo}/contents/${workflow.path}`,
        "-H",
        "Accept: application/vnd.github.raw",
      ]);
      crons.set(workflow.path, scheduleCrons(text));
    }
    const read = { repo, workflows, runs, crons };
    this.cache.set(repo, { at: now, read });
    return read;
  }
}
