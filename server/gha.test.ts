import { describe, expect, test } from "bun:test";
import { GHA_CACHE_MS, type GhaRepoRead, GhaSchedules, ghaObservations, ghaTargets, scheduleCrons } from "./gha";

const NOW = Date.parse("2026-10-08T16:00:00Z");
const H = 3_600_000;
const iso = (at: number) => new Date(at).toISOString();
const WORKFLOW = {
  id: 7,
  name: "Agent evals",
  path: ".github/workflows/agent-evals.yml",
  state: "active",
  html_url: "https://github.com/broomva/workspace/actions/workflows/agent-evals.yml",
};
const REF = "broomva/workspace/.github/workflows/agent-evals.yml";

function read(extra: Partial<GhaRepoRead> = {}): GhaRepoRead {
  return {
    repo: "broomva/workspace",
    workflows: [WORKFLOW],
    runs: [
      {
        workflow_id: 7,
        status: "completed",
        conclusion: "success",
        created_at: iso(NOW - 9 * H),
        updated_at: iso(NOW - 8.9 * H),
        event: "schedule",
      },
      {
        workflow_id: 7,
        status: "completed",
        conclusion: "failure",
        created_at: iso(NOW - 33 * H),
        updated_at: iso(NOW - 32.9 * H),
        event: "schedule",
      },
    ],
    crons: new Map([[WORKFLOW.path, ["17 7 * * *"]]]),
    ...extra,
  };
}

describe("the workflow file", () => {
  test("reads the crons under schedule:, and none when there is none", () => {
    const text = `on:\n  schedule:\n    - cron: '17 7 * * *'  # nightly\n    - cron: "0 12 * * 1"\n  workflow_dispatch:\njobs: {}\n`;
    expect(scheduleCrons(text)).toEqual(["17 7 * * *", "0 12 * * 1"]);
    expect(scheduleCrons("on:\n  push:\n    branches: [main]\n")).toEqual([]);
  });
});

describe("observations", () => {
  test("an active scheduled workflow is on, its newest scheduled run its status, its next run from the cron", () => {
    const [one] = ghaObservations(read(), new Set([REF]), NOW);
    expect(one).toMatchObject({
      subject: "loop:gha/broomva/workspace/agent-evals.yml",
      kind: "gha-schedule",
      ref: REF,
      presence: "on",
      status: "ok",
      scope: "broomva",
      cadence: "cron 17 7 * * * (UTC)",
      next: "2026-10-09T07:17:00.000Z",
    });
    expect(one?.runs.map((run) => run.status)).toEqual(["ok", "failed"]);
  });
  test("a failed newest run is failed; a disabled workflow or one with no schedule: is off", () => {
    const failing = read({
      runs: [
        { workflow_id: 7, status: "completed", conclusion: "failure", created_at: iso(NOW - H), event: "schedule" },
      ],
    });
    expect(ghaObservations(failing, new Set([REF]), NOW)[0]?.status).toBe("failed");
    const disabled = read({ workflows: [{ ...WORKFLOW, state: "disabled_manually" }] });
    expect(ghaObservations(disabled, new Set([REF]), NOW)[0]).toMatchObject({ presence: "off", status: "off" });
    const unscheduled = read({ crons: new Map([[WORKFLOW.path, []]]) });
    expect(ghaObservations(unscheduled, new Set([REF]), NOW)[0]?.presence).toBe("off");
  });
  test("a workflow no row names is observed only when the schedule ran it lately", () => {
    expect(ghaObservations(read(), new Set(), NOW)).toHaveLength(1);
    expect(ghaObservations(read(), new Set(), NOW + 30 * 24 * H)).toHaveLength(0);
    expect(ghaObservations(read({ runs: [] }), new Set(), NOW)).toHaveLength(0);
  });
  test("the repos to read come from the rows' refs", () => {
    expect(
      ghaTargets([REF, "broomva/life/.github/workflows/ci.yml", "broomva/workspace/.github/workflows/bands.yml"]).repos,
    ).toEqual(["broomva/life", "broomva/workspace"]);
  });
});

describe("the reader", () => {
  test("only GETs, cached GHA_CACHE_MS per repo; a failed read keeps the last, said in warnings", async () => {
    const calls: string[][] = [];
    let now = NOW;
    let fail = false;
    const gh = async (args: readonly string[]) => {
      calls.push([...args]);
      if (fail) throw new Error("HTTP 502");
      const path = args[1] ?? "";
      if (path.endsWith("workflows?per_page=100")) return JSON.stringify({ workflows: [WORKFLOW] });
      if (path.includes("runs?event=schedule")) return JSON.stringify({ workflow_runs: read().runs });
      return "on:\n  schedule:\n    - cron: '17 7 * * *'\n";
    };
    const reader = new GhaSchedules(gh, () => now);
    const warnings: string[] = [];
    const first = await reader.observe([REF], warnings);
    expect(first.observations).toHaveLength(1);
    expect(calls.every((args) => args[0] === "api" && !args.includes("-X") && !args.includes("--method"))).toBe(true);
    const count = calls.length;
    await reader.observe([REF], warnings);
    expect(calls.length).toBe(count);
    now += GHA_CACHE_MS;
    fail = true;
    const kept = await reader.observe([REF], warnings);
    expect(kept.observations).toHaveLength(1);
    expect(kept.unread).toBe(false);
    expect(warnings[0]).toContain("HTTP 502");
    const cold = await new GhaSchedules(gh, () => now).observe([REF], []);
    expect(cold.unread).toBe(true);
  });
});
