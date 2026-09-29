// The plugin entry as the daemon drives it: its handlers and hooks, with the
// fake Paseo as the client they are handed.

import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";
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
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "maestro-plugin-integrations-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  const config = join(root, "config.json");
  await writeFile(
    config,
    JSON.stringify({ workRoot: join(root, "work"), provider: "claude/test", modeId: null, isolation: "worktree" }),
  );
  const saved = { config: process.env.MAESTRO_PASEO_CONFIG, socket: process.env.MAESTRO_PASEO_SOCKET };
  process.env.MAESTRO_PASEO_CONFIG = config;
  process.env.MAESTRO_PASEO_SOCKET = join(root, "m.sock");
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
    });
  } finally {
    await cleanup();
    for (const [key, value] of [
      ["MAESTRO_PASEO_CONFIG", saved.config],
      ["MAESTRO_PASEO_SOCKET", saved.socket],
    ] as const) {
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
