import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { call, Refused } from "./bin/maestro";
import contribute from "./index.server";
import { answers } from "./server/agent-socket";
import { loadConfig } from "./server/config";
import { Engine, NO_HANDLE, UNDO_MS } from "./server/engine";
import { fakePaseo } from "./server/fake-paseo";

setDefaultTimeout(60_000);

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
  // A git repository as far as Maestro checks: runs branch a worktree from it.
  await mkdir(join(repo, ".git"), { recursive: true });
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
    // Wait for the socket, not a fixed time: a busy machine stretches every sleep.
    const deadline = Date.now() + 30_000;
    while (!(await answers(path))) {
      if (Date.now() > deadline) throw new Error("the agent socket never opened");
      await new Promise((r) => setTimeout(r, 10));
    }

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

test("undo, stop and the default gate are wired through the plugin's handlers", async () => {
  const root = await mkdtemp(join(tmpdir(), "maestro-plugin-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  const config = join(root, "config.json");
  // Written before these settings existed, except the default gate.
  await writeFile(
    config,
    JSON.stringify({
      workRoot: join(root, "work"),
      provider: "claude/test-model",
      modeId: null,
      isolation: "worktree",
      defaultGate: "auto",
    }),
  );
  const saved = { config: process.env.MAESTRO_PASEO_CONFIG, socket: process.env.MAESTRO_PASEO_SOCKET };
  process.env.MAESTRO_PASEO_CONFIG = config;
  process.env.MAESTRO_PASEO_SOCKET = join(root, "m.sock");
  const { host, handlers, hooks } = fakeHost();
  const cleanup = contribute(host);
  const fake = fakePaseo();
  const context = { paseo: fake.paseo, signal: new AbortController().signal };
  const run = async (name: string, input: unknown) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`${name} is not handled`);
    return (await handler(input, context)) as {
      item: { id: string; state: string; gate: string } & Record<string, unknown>;
    };
  };
  try {
    for (const name of ["work.undo", "work.stop", "work.verdict", "work.cancel", "config.get", "config.set"]) {
      expect(handlers.has(name)).toBe(true);
    }
    expect(await run("config.get", {})).toMatchObject({ concurrencyCap: 3, archiveOnApprove: false });

    // The form said nothing about the gate: the default applies, and checks deciding still needs a check.
    const base = { brief: "", repo, initiative: "", dispatch: false };
    await expect(run("work.create", { ...base, title: "No check", check: "" })).rejects.toThrow(
      "needs a check command",
    );
    const { item: auto } = await run("work.create", { ...base, title: "Checked", check: "true" });
    expect(auto.gate).toBe("auto");
    const { item: chosen } = await run("work.create", { ...base, title: "Mine", check: "", gate: "human" });
    expect(chosen.gate).toBe("human");

    // Dispatch, land at the gate, decide, take it back.
    const { item: running } = await run("work.dispatch", { id: chosen.id });
    expect(running.state).toBe("running");
    const agent = fake.agents.get("agent-1");
    if (agent) agent.status = "idle";
    const ended = hooks.get("agent.turn_ended");
    if (!ended) throw new Error("agent.turn_ended is not subscribed");
    await ended({ agent: { id: "agent-1" }, outcome: { kind: "completed" }, timeline: [], turnId: "t1" }, context);
    const { item: pending } = await run("work.verdict", { id: chosen.id, verdict: "approve", note: "" });
    expect(pending).toMatchObject({ state: "review", pending: { verdict: "approve" } });
    const { item: undone } = await run("work.undo", { id: chosen.id });
    expect(undone).toMatchObject({ state: "review", pending: null });
    const { item: canceling } = await run("work.cancel", { id: chosen.id });
    expect(canceling).toMatchObject({ state: "review", pending: { verdict: "block" } });
    await run("work.undo", { id: chosen.id });

    // Stop a run from the handler: the session is archived and the work is stuck.
    const { item: other } = await run("work.create", { ...base, title: "Stop me", check: "", gate: "human" });
    await run("work.dispatch", { id: other.id });
    // Its folder is no git worktree, so nothing proves stopping loses nothing: refused, then confirmed.
    await expect(run("work.stop", { id: other.id })).rejects.toThrow("Not stopped:");
    expect(fake.archived).toEqual([]);
    const { item: stopped } = await run("work.stop", { id: other.id, discard: true });
    expect(stopped).toMatchObject({ state: "blocked", reason: "You stopped the run" });
    expect(fake.archived).toEqual(["agent-2"]);
  } finally {
    await cleanup();
    process.env.MAESTRO_PASEO_CONFIG = saved.config;
    process.env.MAESTRO_PASEO_SOCKET = saved.socket;
    if (saved.config === undefined) delete process.env.MAESTRO_PASEO_CONFIG;
    if (saved.socket === undefined) delete process.env.MAESTRO_PASEO_SOCKET;
  }
});

test("decisions left from before a restart apply on load, or once a client arrives", async () => {
  const root = await mkdtemp(join(tmpdir(), "maestro-plugin-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ workRoot: join(root, "work"), provider: "claude/test-model" }));
  const fake = fakePaseo();

  // The previous plugin process: two runs at the gate, each decided, then it went down inside the window.
  const past = Date.now() - 60_000;
  const before = new Engine({
    now: () => new Date(past),
    config: () => loadConfig(config),
    log: () => undefined,
    timer: () => () => undefined,
  });
  const make = async (title: string) => {
    const item = await before.create(fake.paseo, {
      title,
      brief: "",
      repo,
      gate: "human",
      check: "",
      initiative: "",
      dispatch: true,
    });
    const agent = fake.agents.get(item.worker?.agentId ?? "");
    if (agent) agent.status = "idle";
    await before.onTurnEnded({ id: item.worker?.agentId ?? "" }, { kind: "completed" }, []);
    return item.id;
  };
  const canceled = await make("Cancel me");
  const approved = await make("Approve me");
  await before.verdict(fake.paseo, canceled, "block", "");
  await before.verdict(fake.paseo, approved, "approve", "");
  before.stop();
  expect(past + UNDO_MS).toBeLessThan(Date.now());

  const saved = { config: process.env.MAESTRO_PASEO_CONFIG, socket: process.env.MAESTRO_PASEO_SOCKET };
  process.env.MAESTRO_PASEO_CONFIG = config;
  process.env.MAESTRO_PASEO_SOCKET = join(root, "m.sock");
  const { host, handlers, hooks } = fakeHost();
  const cleanup = contribute(host);
  const state = async (id: string) => {
    const get = handlers.get("work.get");
    if (!get) throw new Error("work.get is not handled");
    return ((await get({ id }, {})) as { item: { state: string } }).item.state;
  };
  const until = async (id: string, want: string) => {
    for (let i = 0; i < 100 && (await state(id)) !== want; i += 1) await new Promise((r) => setTimeout(r, 20));
    return state(id);
  };
  try {
    // On load, with no client yet: the cancel asks nothing of the session and applies.
    expect(await until(canceled, "canceled")).toBe("canceled");
    // The approval must ask whether the session is working again, so it waits for a client:
    // still waiting a while later, not merely not reached yet by the sweep.
    for (let i = 0; i < 15; i += 1) {
      expect(await state(approved)).toBe("review");
      await new Promise((r) => setTimeout(r, 20));
    }
    const created = hooks.get("agent.created");
    if (!created) throw new Error("agent.created is not subscribed");
    await created({ agent: { id: "someone" } }, { paseo: fake.paseo, signal: new AbortController().signal });
    expect(await until(approved, "done")).toBe("done");
  } finally {
    await cleanup();
    process.env.MAESTRO_PASEO_CONFIG = saved.config;
    process.env.MAESTRO_PASEO_SOCKET = saved.socket;
    if (saved.config === undefined) delete process.env.MAESTRO_PASEO_CONFIG;
    if (saved.socket === undefined) delete process.env.MAESTRO_PASEO_SOCKET;
  }
});

test("the loop is wired: off by default, Settings arm and disarm it, a wake now is yours, and cleanup stops it", async () => {
  const root = await mkdtemp(join(tmpdir(), "maestro-plugin-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  const config = join(root, "config.json");
  // Written before the loop existed: it loads off.
  await writeFile(
    config,
    JSON.stringify({
      workRoot: join(root, "work"),
      provider: "claude/test-model",
      modeId: null,
      isolation: "worktree",
    }),
  );
  const saved = {
    config: process.env.MAESTRO_PASEO_CONFIG,
    socket: process.env.MAESTRO_PASEO_SOCKET,
    wakeLog: process.env.MAESTRO_PASEO_WAKE_LOG,
  };
  process.env.MAESTRO_PASEO_CONFIG = config;
  process.env.MAESTRO_PASEO_SOCKET = join(root, "m.sock");
  delete process.env.MAESTRO_PASEO_WAKE_LOG;
  const { host, handlers } = fakeHost();
  const cleanup = contribute(host);
  const fake = fakePaseo();
  const context = { paseo: fake.paseo, signal: new AbortController().signal };
  // biome-ignore lint/suspicious/noExplicitAny: the handlers answer each contract's own output shape.
  const run = async (name: string, input: unknown): Promise<any> => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`${name} is not handled`);
    return handler(input, context);
  };
  try {
    expect(await run("loop.get", {})).toEqual({ minutes: null, nextAt: null, ticking: false, recent: [] });
    const { item } = await run("work.create", {
      title: "Loop me",
      brief: "",
      repo,
      check: "",
      initiative: "",
      dispatch: false,
    });

    // Saving Settings with a period arms the next wake a period from now.
    const settings = await run("config.get", {});
    expect(settings.loopMinutes).toBeNull();
    const before = Date.now();
    await run("config.set", { ...settings, loopMinutes: 5 });
    const on = await run("loop.get", {});
    expect(on.minutes).toBe(5);
    const ahead = Date.parse(on.nextAt) - before;
    expect(ahead).toBeGreaterThanOrEqual(5 * 60_000);
    expect(ahead).toBeLessThan(5 * 60_000 + 10_000);

    // A wake now is yours to ask for: it says so, and starts the queued work as the loop.
    const woke = await run("loop.wake", {});
    expect(woke).toMatchObject({ cause: "manual", dispatched: [{ id: item.id, title: "Loop me" }] });
    expect(fake.created).toHaveLength(1);
    expect((await run("loop.get", {})).recent.map((entry: { tickId: string }) => entry.tickId)).toEqual([woke.tickId]);
    expect((await stat(join(root, "wake-log.jsonl"))).isFile()).toBe(true);

    // Off again: nothing is armed.
    await run("config.set", { ...settings, loopMinutes: null });
    expect(await run("loop.get", {})).toMatchObject({ minutes: null, nextAt: null });
  } finally {
    await cleanup();
    for (const [key, value] of [
      ["MAESTRO_PASEO_CONFIG", saved.config],
      ["MAESTRO_PASEO_SOCKET", saved.socket],
      ["MAESTRO_PASEO_WAKE_LOG", saved.wakeLog],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
