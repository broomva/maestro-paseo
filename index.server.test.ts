import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { call, Refused } from "./bin/maestro";
import contribute from "./index.server";
import { answers } from "./server/agent-socket";
import { NO_HANDLE } from "./server/engine";
import { fakePaseo } from "./server/fake-paseo";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

type Handler = (input: unknown, context: unknown) => unknown;

/** A host that records what the plugin registers, so the test can play the daemon's part. */
function fakeHost() {
  const handlers = new Map<string, Handler>();
  const hooks = new Map<string, Handler>();
  const host = {
    handle: (contract: { name: string }, handler: Handler) => handlers.set(contract.name, handler),
    on: (name: string, handler: Handler) => {
      hooks.set(name, handler);
      return () => hooks.delete(name);
    },
    before: () => () => undefined,
    registerProvider: () => undefined,
    registerSettings: () => undefined,
  } as unknown as PluginServerContext;
  return { host, handlers, hooks };
}

test("the plugin's handlers and hooks hand the agent socket its daemon client", async () => {
  const root = await mkdtemp(join(tmpdir(), "maestro-plugin-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  const config = join(root, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      workRoot: join(root, "work"),
      provider: "claude/test-model",
      modeId: null,
      isolation: "worktree",
    }),
  );
  const path = join(root, "m.sock");
  const saved = { config: process.env.MAESTRO_PASEO_CONFIG, socket: process.env.MAESTRO_PASEO_SOCKET };
  process.env.MAESTRO_PASEO_CONFIG = config;
  process.env.MAESTRO_PASEO_SOCKET = path;
  const { host, handlers, hooks } = fakeHost();
  const cleanup = contribute(host);
  try {
    for (let i = 0; i < 100 && !(await answers(path)); i += 1) await new Promise((r) => setTimeout(r, 20));

    // Before any event: reads and creates work, starting a run says why it cannot.
    const { item } = (await call("work.create", { title: "Wired", repo }, { path, caller: "s1" })) as {
      item: { id: string };
    };
    const early = call("work.dispatch", { id: item.id }, { path });
    await expect(early).rejects.toBeInstanceOf(Refused);
    await expect(early).rejects.toThrow(NO_HANDLE);

    // Any hook the daemon delivers carries the client; the socket can then start runs.
    const fake = fakePaseo();
    const created = hooks.get("agent.created");
    if (!created) throw new Error("agent.created is not subscribed");
    await created({ agent: { id: "someone" } }, { paseo: fake.paseo, signal: new AbortController().signal });
    const { item: running } = (await call("work.dispatch", { id: item.id }, { path })) as { item: { state: string } };
    expect(running.state).toBe("running");
    expect(fake.created).toHaveLength(1);

    // The wrapper hands back what the handler returns, unchanged.
    const list = handlers.get("work.list");
    if (!list) throw new Error("work.list is not handled");
    const listed = (await list({}, { paseo: fake.paseo })) as { items: Array<{ id: string }> };
    expect(listed.items.map((entry) => entry.id)).toEqual([item.id]);
  } finally {
    await cleanup();
    process.env.MAESTRO_PASEO_CONFIG = saved.config;
    process.env.MAESTRO_PASEO_SOCKET = saved.socket;
    if (saved.config === undefined) delete process.env.MAESTRO_PASEO_CONFIG;
    if (saved.socket === undefined) delete process.env.MAESTRO_PASEO_SOCKET;
  }
  await expect(stat(path)).rejects.toThrow();
});
