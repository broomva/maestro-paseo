// The plugin entry as the daemon drives it: its handlers and hooks, with the
// fake Paseo as the client they are handed.

import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";
import type { FleetView } from "../shared/fleet";
import { H, writeFleet } from "./fake-fleet";
import { fakePaseo } from "./fake-paseo";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

type Handler = (input: unknown, context: unknown) => unknown;

async function withPlugin(
  run: (plugin: {
    call: (name: string, input: unknown) => Promise<unknown>;
    hook: (name: string, event: unknown) => Promise<unknown>;
    repo: string;
    fake: ReturnType<typeof fakePaseo>;
    /** Where the fleet's files go: its config, its state root and its LaunchAgents. */
    fleet: { config: string; state: string; agents: string };
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "maestro-plugin-integrations-"));
  roots.push(root);
  const repo = join(root, "repo");
  // A git repository as far as Maestro checks: runs branch a worktree from it.
  await mkdir(join(repo, ".git"), { recursive: true });
  const config = join(root, "config.json");
  await writeFile(
    config,
    JSON.stringify({ workRoot: join(root, "work"), provider: "claude/test", modeId: null, isolation: "worktree" }),
  );
  // The fleet's files are this test's own: never the fleet on the machine running it.
  const fleetEnv = {
    MAESTRO_PASEO_FLEET_CONFIG: join(root, "fleet", "fleet.json"),
    MAESTRO_PASEO_FLEET_STATE: join(root, "fleet", "state"),
    MAESTRO_PASEO_FLEET_AGENTS: join(root, "fleet", "agents"),
    // Awake for days: what counts toward a missed tick is the test's, not this machine's last wake.
    MAESTRO_PASEO_FLEET_AWAKE: String(Date.now() - 100 * 3_600_000),
  };
  const saved = {
    MAESTRO_PASEO_CONFIG: process.env.MAESTRO_PASEO_CONFIG,
    MAESTRO_PASEO_SOCKET: process.env.MAESTRO_PASEO_SOCKET,
    ...Object.fromEntries(Object.keys(fleetEnv).map((key) => [key, process.env[key]])),
  };
  process.env.MAESTRO_PASEO_CONFIG = config;
  process.env.MAESTRO_PASEO_SOCKET = join(root, "m.sock");
  Object.assign(process.env, fleetEnv);
  const handlers = new Map<string, Handler>();
  const hooks = new Map<string, Handler>();
  const host = {
    handle: (contract: { name: string }, handler: Handler) => handlers.set(contract.name, handler),
    on: (name: string, handler: Handler) => hooks.set(name, handler),
  } as unknown as PluginServerContext;
  const cleanup = contribute(host);
  const fake = fakePaseo();
  const context = { paseo: fake.paseo, signal: new AbortController().signal };
  const find = (from: Map<string, Handler>, name: string) => {
    const handler = from.get(name);
    if (!handler) throw new Error(`${name} is not wired`);
    return handler;
  };
  try {
    await run({
      call: async (name, input) => find(handlers, name)(input, context),
      hook: async (name, event) => find(hooks, name)(event, context),
      repo,
      fake,
      fleet: {
        config: fleetEnv.MAESTRO_PASEO_FLEET_CONFIG,
        state: fleetEnv.MAESTRO_PASEO_FLEET_STATE,
        agents: fleetEnv.MAESTRO_PASEO_FLEET_AGENTS,
      },
    });
  } finally {
    await cleanup();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("the plugin cards a landing through the client its hooks were handed", async () => {
  await withPlugin(async ({ call, hook, repo, fake }) => {
    const { item } = (await call("work.create", {
      title: "Wired",
      brief: "",
      repo,
      gate: "human",
      check: "",
      initiative: "",
      dispatch: true,
    })) as { item: { id: string } };
    const agent = fake.agents.get("agent-1");
    if (agent) agent.status = "idle";
    await hook("agent.turn_ended", {
      agent: { id: "agent-1" },
      outcome: { kind: "completed" },
      timeline: [],
      turnId: "t1",
    });
    await flush();
    expect(fake.appended.map((entry) => entry.item.data)).toEqual([
      { workId: item.id, landing: expect.any(Number), agentId: "agent-1" },
    ]);
  });
});

test("work.attention reads the files and reconciles no session; work.list does", async () => {
  await withPlugin(async ({ call, hook, repo, fake }) => {
    const { item } = (await call("work.create", {
      title: "Counted",
      brief: "",
      repo,
      gate: "human",
      check: "",
      initiative: "",
      dispatch: true,
    })) as { item: { id: string } };
    const running = await call("work.attention", {});
    expect(running).toEqual({
      waiting: [],
      sessions: [{ workId: item.id, title: "Counted", state: "running", agentId: "agent-1", workspaceId: "ws-1" }],
      fleet: [],
    });
    const agent = fake.agents.get("agent-1");
    if (agent) agent.status = "idle";
    await hook("agent.turn_ended", {
      agent: { id: "agent-1" },
      outcome: { kind: "completed" },
      timeline: [],
      turnId: "t1",
    });
    for (let read = 0; read < 5; read += 1) await call("work.attention", {});
    expect(await call("work.attention", {})).toMatchObject({ waiting: [{ id: item.id, group: "review" }] });
    expect(fake.refreshed).toEqual([]);
    await call("work.list", {});
    expect(fake.refreshed).toEqual(["agent-1"]);
  });
});

test("the Fleet view, your verdict and a missed tick in the header count, through the plugin's handlers", async () => {
  await withPlugin(async ({ call, fleet }) => {
    const now = Date.now();
    await writeFleet(fleet, {
      broomva: { ticks: [{ tick: 35, at: new Date(now - 3 * H), exit: 0 }] },
      sri: { ticks: [{ tick: 6, at: new Date(now - 40 * H), exit: 0 }], scheduled: false },
    });
    const view = (await call("fleet.get", { ticks: 24 })) as FleetView;
    expect(view.scopes.map((scope) => [scope.id, scope.health.status, scope.health.needsYou])).toEqual([
      ["broomva", "missed", true],
      ["sri", "unscheduled", false],
    ]);
    // The header count carries the missed tick beside the work; an unscheduled scope is not counted.
    const attention = (await call("work.attention", {})) as { fleet: { scope: string; status: string }[] };
    expect(attention.fleet.map((notice) => [notice.scope, notice.status])).toEqual([["broomva", "missed"]]);

    const [proposal] = view.detail?.proposals ?? [];
    if (!proposal) throw new Error("the fixture proposes nothing");
    const { proposals } = (await call("fleet.review", {
      scope: "broomva",
      keys: [proposal.key],
      verdict: "reject",
      note: "Not yet",
    })) as { proposals: NonNullable<FleetView["detail"]>["proposals"] };
    expect(proposals[0]?.review).toMatchObject({ verdict: "reject", note: "Not yet" });
    const lines = (await readFile(join(fleet.state, "broomva", "proposal-reviews.jsonl"), "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).verdict)).toEqual(["reject"]);
  });
});
