import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
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

// Your verbs wait 8 s before they take effect (B4). The plugin's tests shorten the window so they can wait it
// out; the 8 s itself is proved to the millisecond in server/owner-verbs.test.ts.
const windowWas = process.env.MAESTRO_PASEO_VERB_WINDOW_MS;
beforeAll(() => {
  process.env.MAESTRO_PASEO_VERB_WINDOW_MS = "0";
});
afterAll(() => {
  if (windowWas === undefined) delete process.env.MAESTRO_PASEO_VERB_WINDOW_MS;
  else process.env.MAESTRO_PASEO_VERB_WINDOW_MS = windowWas;
});

/** Wait until every verb of yours has taken effect (or been dropped): the ledger holds none pending. */
async function settled(read: (name: string, input: unknown) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    const { pending } = (await read("verbs.list", {})) as { pending: unknown[] };
    if (pending.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("a verb of yours never took effect");
}

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
      // A Settings mode that does not ask: a session's run takes it (BRO-2990).
      modeId: "bypassPermissions",
      isolation: "worktree",
    }),
  );
  const path = join(root, "m.sock");
  const saved = { config: process.env.MAESTRO_PASEO_CONFIG, socket: process.env.MAESTRO_PASEO_SOCKET };
  // No fleet here: the plugin's Fleet view reads this test's empty folder, never the machine's fleet.
  const fleet = [
    "MAESTRO_PASEO_FLEET_CONFIG",
    "MAESTRO_PASEO_FLEET_STATE",
    "MAESTRO_PASEO_FLEET_AGENTS",
    // Nor the owner's control repo, whose ledgers a test never reads or writes.
    "MAESTRO_PASEO_CONTROL_REPO",
    "MAESTRO_PASEO_CONTROL_ANSWERS",
    // Nor the owner's ask receipts and locks: routing marks where it begins there (server/answer-routes.ts).
    "MAESTRO_PASEO_ASK_RECEIPTS",
    "MAESTRO_PASEO_ASK_LOCKS",
  ] as const;
  const savedFleet = fleet.map((key) => [key, process.env[key]] as const);
  for (const key of fleet) process.env[key] = join(root, "no-fleet", key);
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

    // Any hook the daemon delivers carries the client; the socket can then start runs for a lane,
    // in Settings' mode, which does not ask (BRO-2990).
    const fake = fakePaseo();
    const created = hooks.get("agent.created");
    if (!created) throw new Error("agent.created is not subscribed");
    await created({ agent: { id: "someone" } }, { paseo: fake.paseo, signal: new AbortController().signal });
    const { item: running } = (await call("work.dispatch", { id: item.id }, { path, caller: "lane-1" })) as {
      item: { state: string };
    };
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
    for (const [key, value] of savedFleet) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
  // No fleet here: the plugin's Fleet view reads this test's empty folder, never the machine's fleet.
  const fleet = [
    "MAESTRO_PASEO_FLEET_CONFIG",
    "MAESTRO_PASEO_FLEET_STATE",
    "MAESTRO_PASEO_FLEET_AGENTS",
    // Nor the owner's control repo, whose ledgers a test never reads or writes.
    "MAESTRO_PASEO_CONTROL_REPO",
    "MAESTRO_PASEO_CONTROL_ANSWERS",
    // Nor the owner's ask receipts and locks: routing marks where it begins there (server/answer-routes.ts).
    "MAESTRO_PASEO_ASK_RECEIPTS",
    "MAESTRO_PASEO_ASK_LOCKS",
  ] as const;
  const savedFleet = fleet.map((key) => [key, process.env[key]] as const);
  for (const key of fleet) process.env[key] = join(root, "no-fleet", key);
  process.env.MAESTRO_PASEO_CONFIG = config;
  process.env.MAESTRO_PASEO_SOCKET = join(root, "m.sock");
  // The ledger's window, shortened so the test can wait it out: the 8 s itself is proved in server/owner-verbs.test.ts.
  const savedWindow = process.env.MAESTRO_PASEO_VERB_WINDOW_MS;
  process.env.MAESTRO_PASEO_VERB_WINDOW_MS = "4000";
  const { host, handlers, hooks } = fakeHost();
  const cleanup = contribute(host);
  const fake = fakePaseo();
  const context = { paseo: fake.paseo, signal: new AbortController().signal };
  const run = async (name: string, input: unknown) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`${name} is not handled`);
    return (await handler(input, context)) as {
      item: { id: string; state: string; gate: string } & Record<string, unknown>;
      receipt?: string;
      appliesAt?: string;
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
    // Work is not approved (A1): the verdict is refused, and nothing is recorded.
    await expect(run("work.verdict", { id: chosen.id, verdict: "approve", note: "" })).rejects.toThrow(
      "Work is not approved",
    );
    expect((await run("work.get", { id: chosen.id })).item).toMatchObject({ state: "review", pending: null });
    // Change course is recorded with a receipt, and verb.undo takes it back by that receipt.
    const revised = await run("work.verdict", { id: chosen.id, verdict: "revise", note: "Again" });
    expect(revised.item).toMatchObject({ state: "review", pending: { verdict: "revise" } });
    expect(revised.receipt).toBeString();
    expect(revised.appliesAt).toBe(
      revised.item.pending ? (revised.item.pending as { effectiveAt: string }).effectiveAt : "",
    );
    const listedPending = (await run("verbs.list", {})) as unknown as {
      pending: Array<{ receipt: string; verb: string }>;
    };
    expect(listedPending.pending).toMatchObject([{ receipt: revised.receipt, verb: "work.verdict" }]);
    expect(await run("verb.undo", { receipt: revised.receipt })).toMatchObject({ undone: true });
    expect((await run("work.get", { id: chosen.id })).item).toMatchObject({ state: "review", pending: null });
    const { item: canceling } = await run("work.cancel", { id: chosen.id });
    expect(canceling).toMatchObject({ state: "review", pending: { verdict: "block" } });
    await run("work.undo", { id: chosen.id });

    // Stop a run from the handler: the session is archived and the work is stuck.
    const { item: other } = await run("work.create", { ...base, title: "Stop me", check: "", gate: "human" });
    await run("work.dispatch", { id: other.id });
    // Its folder is no git worktree, so nothing proves stopping loses nothing: refused, then confirmed.
    await expect(run("work.stop", { id: other.id })).rejects.toThrow("Not stopped:");
    expect(fake.archived).toEqual([]);
    // Stop waits out its window: recorded, the run still running, and Undo takes it back.
    const asked = await run("work.stop", { id: other.id, discard: true });
    expect(asked.item).toMatchObject({ state: "running" });
    expect(asked.receipt).toBeString();
    expect(await run("verb.undo", { receipt: asked.receipt })).toMatchObject({ undone: true });
    // Past the end of the window it would have had: nothing took effect.
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Date.parse(asked.appliesAt ?? "") - Date.now()) + 300),
    );
    expect(fake.archived).toEqual([]);
    expect((await run("work.get", { id: other.id })).item.state).toBe("running");
    await run("work.stop", { id: other.id, discard: true });
    expect(fake.archived).toEqual([]);
    for (let i = 0; i < 600 && fake.archived.length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(fake.archived).toEqual(["agent-2"]);
    expect((await run("work.get", { id: other.id })).item).toMatchObject({
      state: "blocked",
      reason: "You stopped the run",
    });
    expect(
      ((await run("verbs.list", {})) as unknown as { recent: Array<{ outcome: string }> }).recent.map((v) => v.outcome),
    ).toEqual(["applied", "undone"]);
  } finally {
    if (savedWindow === undefined) delete process.env.MAESTRO_PASEO_VERB_WINDOW_MS;
    else process.env.MAESTRO_PASEO_VERB_WINDOW_MS = savedWindow;
    await cleanup();
    process.env.MAESTRO_PASEO_CONFIG = saved.config;
    process.env.MAESTRO_PASEO_SOCKET = saved.socket;
    if (saved.config === undefined) delete process.env.MAESTRO_PASEO_CONFIG;
    if (saved.socket === undefined) delete process.env.MAESTRO_PASEO_SOCKET;
    for (const [key, value] of savedFleet) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
  const revised = await make("Change my course");
  await before.verdict(fake.paseo, canceled, "block", "");
  await before.verdict(fake.paseo, revised, "revise", "Again");
  before.stop();
  expect(past + UNDO_MS).toBeLessThan(Date.now());

  const saved = { config: process.env.MAESTRO_PASEO_CONFIG, socket: process.env.MAESTRO_PASEO_SOCKET };
  // No fleet here: the plugin's Fleet view reads this test's empty folder, never the machine's fleet.
  const fleet = [
    "MAESTRO_PASEO_FLEET_CONFIG",
    "MAESTRO_PASEO_FLEET_STATE",
    "MAESTRO_PASEO_FLEET_AGENTS",
    // Nor the owner's control repo, whose ledgers a test never reads or writes.
    "MAESTRO_PASEO_CONTROL_REPO",
    "MAESTRO_PASEO_CONTROL_ANSWERS",
    // Nor the owner's ask receipts and locks: routing marks where it begins there (server/answer-routes.ts).
    "MAESTRO_PASEO_ASK_RECEIPTS",
    "MAESTRO_PASEO_ASK_LOCKS",
  ] as const;
  const savedFleet = fleet.map((key) => [key, process.env[key]] as const);
  for (const key of fleet) process.env[key] = join(root, "no-fleet", key);
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
    // A change of course must ask whether the session is working again, so it waits for a client:
    // still waiting a while later, not merely not reached yet by the sweep.
    for (let i = 0; i < 15; i += 1) {
      expect(await state(revised)).toBe("review");
      await new Promise((r) => setTimeout(r, 20));
    }
    const created = hooks.get("agent.created");
    if (!created) throw new Error("agent.created is not subscribed");
    await created({ agent: { id: "someone" } }, { paseo: fake.paseo, signal: new AbortController().signal });
    expect(await until(revised, "running")).toBe("running");
  } finally {
    await cleanup();
    process.env.MAESTRO_PASEO_CONFIG = saved.config;
    process.env.MAESTRO_PASEO_SOCKET = saved.socket;
    if (saved.config === undefined) delete process.env.MAESTRO_PASEO_CONFIG;
    if (saved.socket === undefined) delete process.env.MAESTRO_PASEO_SOCKET;
    for (const [key, value] of savedFleet) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
  // A wake lands and routes answers (BRO-2827): never in the owner's control repo, answers worktree or receipts.
  const owner = ["MAESTRO_PASEO_CONTROL_REPO", "MAESTRO_PASEO_ASK_RECEIPTS", "MAESTRO_PASEO_ASK_LOCKS"] as const;
  const savedOwner = owner.map((key) => [key, process.env[key]] as const);
  process.env.MAESTRO_PASEO_CONTROL_REPO = "off";
  process.env.MAESTRO_PASEO_ASK_RECEIPTS = join(root, "asks.jsonl");
  process.env.MAESTRO_PASEO_ASK_LOCKS = join(root, "locks");
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
    const saving = await run("config.set", { ...settings, loopMinutes: 5 });
    // Recorded, with its receipt: nothing is armed until the window closes.
    expect(saving.receipt).toBeString();
    expect((await run("loop.get", {})).minutes).toBeNull();
    await settled(run);
    const on = await run("loop.get", {});
    expect(on.minutes).toBe(5);
    const ahead = Date.parse(on.nextAt) - before;
    expect(ahead).toBeGreaterThanOrEqual(5 * 60_000);
    expect(ahead).toBeLessThan(5 * 60_000 + 10_000);

    // A wake now is yours to ask for: it says so, and starts nothing (A8): the work stays queued.
    const asked = await run("loop.wake", {});
    expect(asked.receipt).toBeString();
    await settled(run);
    const [woke] = (await run("loop.get", {})).recent;
    expect(woke).toMatchObject({ cause: "manual", dispatched: [], deferred: [] });
    expect(fake.created).toHaveLength(0);
    expect((await run("loop.get", {})).recent).toHaveLength(1);
    expect((await stat(join(root, "wake-log.jsonl"))).isFile()).toBe(true);
    // Your Dispatch still starts it.
    expect((await run("work.dispatch", { id: item.id })).item.state).toBe("running");
    expect(fake.created).toHaveLength(1);

    // Off again: nothing is armed.
    await run("config.set", { ...settings, loopMinutes: null });
    await settled(run);
    expect(await run("loop.get", {})).toMatchObject({ minutes: null, nextAt: null });
  } finally {
    await cleanup();
    for (const [key, value] of [
      ["MAESTRO_PASEO_CONFIG", saved.config],
      ["MAESTRO_PASEO_SOCKET", saved.socket],
      ["MAESTRO_PASEO_WAKE_LOG", saved.wakeLog],
      ...savedOwner,
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("initiatives and their ideas are wired: develop files held work in the initiative's folder, park writes its wake", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "maestro-plugin-")));
  roots.push(root);
  // A control repo of the test's own, with origin/main: never the owner's, and never their git config.
  const gitConfig = join(root, "gitconfig");
  await writeFile(
    gitConfig,
    "[user]\n\tname = Maestro Test\n\temail = maestro@example.invalid\n[init]\n\tdefaultBranch = main\n",
  );
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" },
    });
  const control = join(root, "broomva");
  git(root, "init", "--quiet", "--bare", join(root, "origin.git"));
  git(root, "init", "--quiet", control);
  await mkdir(join(control, ".control", "initiatives"), { recursive: true });
  await mkdir(join(control, ".control", "asks"), { recursive: true });
  await writeFile(
    join(control, ".control", "initiatives", "maestro.yaml"),
    `id: maestro\ntitle: "Maestro"\nintent: "(not stated verbatim)"\nstated: 2026-09-29\nstatus: active\nnext_action: "Ship the tab."\ndriver: owner\nlinks:\n  linear: [BRO-2802]\nreview_by: 2026-10-01\nexit: "Shipped."\n`,
  );
  const idea = (id: string, wake: string) =>
    `  - id: ${id}\n    class: idea\n    initiative: maestro\n    idea: "Idea ${id}"\n    source: {kind: pr, ref: "broomva/workspace#894"}\n    evidence: BRO-2802\n    ask: "Develop, park or kill ${id}?"\n    headline: "Build ${id}, or park it?"\n    stakes: "None."\n    why_you: "Yours."\n    options:\n      - {id: develop, label: Develop, consequence: "Work", reversible: true}\n      - {id: park, label: Park, consequence: "Later", reversible: true, recommended: true}\n      - {id: kill, label: Kill, consequence: "Gone", reversible: true}\n    default: "park"\n    wake: ${wake}\n    blocking: false\n    asked_at: 2026-10-05T21:00Z\n    answered_at: null\n`;
  const ledger = join(control, ".control", "asks", "ideas-maestro.yaml");
  await writeFile(
    ledger,
    `arc: ideas-maestro\nopened: 2026-10-05T21:00Z\ntz: America/Bogota\nlanes: [triage]\nasks:\n${idea("I1", "2099-01-01")}${idea("I2", "2099-01-01")}`,
  );
  git(control, "add", ".");
  git(control, "commit", "--quiet", "-m", "initiatives");
  git(control, "remote", "add", "origin", join(root, "origin.git"));
  git(control, "push", "--quiet", "origin", "main");
  git(control, "fetch", "--quiet", "origin");
  // The owner's checkout is on a branch; the ideas are on origin/main, so their answers go to the answers worktree.
  git(control, "switch", "--quiet", "-c", "feat/ideas");

  const config = join(root, "config.json");
  await writeFile(
    config,
    JSON.stringify({ workRoot: join(root, "work"), provider: "claude/test-model", modeId: null }),
  );
  const keys = [
    "MAESTRO_PASEO_CONFIG",
    "MAESTRO_PASEO_SOCKET",
    "MAESTRO_PASEO_FLEET_CONFIG",
    "MAESTRO_PASEO_FLEET_STATE",
    "MAESTRO_PASEO_FLEET_AGENTS",
    "MAESTRO_PASEO_CONTROL_REPO",
    "MAESTRO_PASEO_CONTROL_ANSWERS",
    "MAESTRO_PASEO_ASK_LOCKS",
    "MAESTRO_PASEO_ASK_RECEIPTS",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
  ] as const;
  const saved = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) process.env[key] = join(root, "unused", key);
  Object.assign(process.env, {
    MAESTRO_PASEO_CONFIG: config,
    MAESTRO_PASEO_SOCKET: join(root, "m.sock"),
    MAESTRO_PASEO_CONTROL_REPO: control,
    MAESTRO_PASEO_CONTROL_ANSWERS: join(root, "state", "control-answers"),
    MAESTRO_PASEO_ASK_LOCKS: join(root, "state", "locks"),
    MAESTRO_PASEO_ASK_RECEIPTS: join(root, "state", "asks.jsonl"),
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  });
  const { host, handlers } = fakeHost();
  const cleanup = contribute(host);
  const fake = fakePaseo();
  const context = { paseo: fake.paseo, signal: new AbortController().signal };
  const run = async <T>(name: string, input: unknown): Promise<T> => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`${name} is not handled`);
    return (await handler(input, context)) as T;
  };
  type Ask = {
    id: string;
    hash: string;
    state: string;
    answerOption: string | null;
    idea: { wake: string | null };
    home: { kind: string };
    batched: boolean;
  };
  type View = {
    initiatives: { id: string; stale: unknown; ideas: { open: number; triaged: number } }[];
    ideas: Ask[];
  };
  try {
    const view = await run<View>("initiatives.list", {});
    expect(view.initiatives.map((entry) => [entry.id, entry.stale, entry.ideas])).toEqual([
      ["maestro", { kind: "overdue", date: "2026-10-01" }, { open: 2, triaged: 0 }],
    ]);
    // Overdue, it counts in Needs you.
    const attention = await run<{ initiatives: unknown[] }>("work.attention", {});
    expect(attention.initiatives).toEqual([{ id: "maestro", title: "Maestro", kind: "overdue", date: "2026-10-01" }]);

    const [first, second] = view.ideas;
    if (!first || !second) throw new Error("two ideas expected");
    // Each idea is answered at its home as read: origin/main, whose answers are batched on maestro/answers.
    expect([first.home.kind, second.home.kind]).toEqual(["main", "main"]);
    const where = { kind: "workspace", home: "origin/main" };
    const asked = await run<{ ask: Ask; receipt?: string }>("ask.answer", {
      where,
      ledger: "ideas-maestro.yaml",
      uid: null,
      id: "I1",
      hash: first.hash,
      option: "develop",
      note: "start small",
    });
    // Recorded, with its receipt; written when the window closes, so until then the ask stands open.
    expect([asked.ask.state, typeof asked.receipt]).toEqual(["open", "string"]);
    await settled(run);
    const answered = (await run<View>("initiatives.list", {})).ideas.find((ask) => ask.id === "I1");
    expect([answered?.state, answered?.answerOption, answered?.batched]).toEqual(["answered", "develop", true]);
    const [made] = (await run<{ developed: { id: string; path: string }[] }>("initiatives.list", {})).developed;
    if (!made) throw new Error("no work filed");
    const developed = { work: made };
    expect(developed.work.path).toStartWith("maestro/");
    // Queued, held for you: the loop and sessions leave it, and its brief carries the initiative and the idea.
    const { item } = await run<{ item: { state: string; initiative: string; nextRun: { held: string | null } } }>(
      "work.get",
      { id: developed.work.id },
    );
    expect([item.state, item.initiative, item.nextRun.held]).toEqual([
      "proposed",
      "maestro",
      "You chose to develop the idea ideas-maestro.yaml I1; it starts when you start it.",
    ]);
    const brief = await readFile(join(root, "work", developed.work.path, "_work.md"), "utf8");
    expect(brief).toContain("hold: You chose to develop the idea ideas-maestro.yaml I1");
    expect(brief).toContain("Its next action: Ship the tab.");
    expect(brief).toContain("> start small");
    expect(brief).toContain("idea: ideas-maestro.yaml#I1");
    // Filed once: asked again (a retry after a warning), the idea gets the same work item back.
    const fileAgain = () =>
      run<{ work: { id: string } | null; warning: string | null }>("initiatives.file", {
        ledger: "ideas-maestro.yaml",
        id: "I1",
        home: "origin/main",
      });
    const again = await fileAgain();
    expect([again.work?.id, again.warning]).toEqual([developed.work.id, null]);
    // At another home it is not this idea.
    await expect(
      run("initiatives.file", { ledger: "ideas-maestro.yaml", id: "I1", home: "/elsewhere" }),
    ).rejects.toThrow("No idea I1");
    // Its item gone (filing failed, or it was removed), two presses at once file exactly one.
    await rm(join(root, "work", developed.work.path), { recursive: true, force: true });
    const [one, two] = await Promise.all([fileAgain(), fileAgain()]);
    if (!one.work || !two.work) throw new Error("no work filed again");
    expect(one.work.id).toBe(two.work.id);
    expect(one.work.id).not.toBe(developed.work.id);
    const ideaItems = (await readdir(join(root, "work", "maestro"))).filter((name) => !name.startsWith("."));
    expect(ideaItems).toHaveLength(1);
    const listed = await run<{ developed: { ref: string; id: string }[] }>("initiatives.list", {});
    expect(listed.developed.map((entry) => [entry.ref, entry.id])).toEqual([["ideas-maestro.yaml#I1", one.work.id]]);
    // An idea not answered develop gets no work filed.
    await expect(
      run("initiatives.file", { ledger: "ideas-maestro.yaml", id: "I2", home: "origin/main" }),
    ).rejects.toThrow("is not answered develop");

    await run("ask.answer", {
      where,
      ledger: "ideas-maestro.yaml",
      uid: null,
      id: "I2",
      hash: second.hash,
      option: "park",
      note: "",
      wake: "2099-02-03",
    });
    await settled(run);
    const parked = (await run<View>("initiatives.list", {})).ideas.find((ask) => ask.id === "I2");
    expect([parked?.answerOption, parked?.idea.wake]).toEqual(["park", "2099-02-03"]);
    const batch = join(root, "state", "control-answers", ".control", "asks", "ideas-maestro.yaml");
    expect(await readFile(batch, "utf8")).toContain('wake: "2099-02-03"');
    // The owner's checkout is untouched: the answer waits in the batch.
    expect(await readFile(ledger, "utf8")).not.toContain("2099-02-03");
    const after = await run<View>("initiatives.list", {});
    expect(after.initiatives[0]?.ideas).toEqual({ open: 0, triaged: 2 });
  } finally {
    await cleanup();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("asks.workspace carries each fleet scope's root asks, tagged; a fleet answer is written at its root (BRO-2856)", async () => {
  const root = await mkdtemp(join(tmpdir(), "maestro-plugin-"));
  roots.push(root);
  const config = join(root, "config.json");
  await writeFile(
    config,
    JSON.stringify({ workRoot: join(root, "work"), provider: "claude/test-model", modeId: null }),
  );
  const state = join(root, "fleet-state");
  const fleetConfig = join(root, "fleet.json");
  await writeFile(fleetConfig, "{ not json");
  // A scope found on disk (its ticks folder), with one decision ask in its own root.
  await mkdir(join(state, "alpha", "ticks"), { recursive: true });
  const askRoot = join(state, "alpha", ".control", "asks");
  await mkdir(askRoot, { recursive: true });
  await writeFile(
    join(askRoot, "fleet-alpha.yaml"),
    [
      "arc: fleet-alpha",
      "asks:",
      "  - id: redeploy",
      '    headline: "Redeploy main?"',
      "    options:",
      "      - id: go",
      '        label: "Redeploy"',
      '        consequence: "Production runs the fix."',
      "        reversible: true",
      "        recommended: true",
      "    blocking: false",
      "",
    ].join("\n"),
  );
  const keys = [
    "MAESTRO_PASEO_CONFIG",
    "MAESTRO_PASEO_SOCKET",
    "MAESTRO_PASEO_FLEET_CONFIG",
    "MAESTRO_PASEO_FLEET_STATE",
    "MAESTRO_PASEO_FLEET_AGENTS",
    "MAESTRO_PASEO_CONTROL_REPO",
    "MAESTRO_PASEO_ASK_LOCKS",
    "MAESTRO_PASEO_ASK_RECEIPTS",
  ] as const;
  const saved = keys.map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, {
    MAESTRO_PASEO_CONFIG: config,
    MAESTRO_PASEO_SOCKET: join(root, "m.sock"),
    // An unreadable fleet config: the scopes are the state dirs found, and Decisions says why.
    MAESTRO_PASEO_FLEET_CONFIG: fleetConfig,
    MAESTRO_PASEO_FLEET_STATE: state,
    MAESTRO_PASEO_FLEET_AGENTS: join(root, "agents"),
    MAESTRO_PASEO_CONTROL_REPO: "off",
    MAESTRO_PASEO_ASK_LOCKS: join(root, "locks"),
    MAESTRO_PASEO_ASK_RECEIPTS: join(root, "asks.jsonl"),
  });
  const { host, handlers } = fakeHost();
  const cleanup = contribute(host);
  const context = { paseo: fakePaseo().paseo, signal: new AbortController().signal };
  const run = async <T>(name: string, input: unknown): Promise<T> => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`${name} is not handled`);
    return (await handler(input, context)) as T;
  };
  type Ask = { ledger: string; id: string; hash: string; state: string; scope?: string | null };
  try {
    const view = await run<{ decisions: Ask[]; fleet?: Ask[]; warnings: string[] }>("asks.workspace", {});
    expect(view.decisions).toEqual([]);
    expect(view.fleet?.map((ask) => [ask.scope, ask.ledger, ask.id, ask.state])).toEqual([
      ["alpha", "fleet-alpha.yaml", "redeploy", "open"],
    ]);
    expect(view.warnings.some((warning) => warning === `The fleet config (${fleetConfig}) is not valid JSON.`)).toBe(
      true,
    );
    const asked = await run<{ ask: Ask; receipt?: string }>("ask.answer", {
      where: { kind: "fleet", scope: "alpha" },
      ledger: "fleet-alpha.yaml",
      uid: null,
      id: "redeploy",
      hash: view.fleet?.[0]?.hash ?? "",
      option: "go",
      note: "",
    });
    // Recorded with its receipt, written 8 s later: until then the ask stands open, and the ledger is untouched.
    expect([asked.ask.state, typeof asked.receipt]).toEqual(["open", "string"]);
    expect(await readFile(join(askRoot, "fleet-alpha.yaml"), "utf8")).not.toContain("answered_at");
    await settled(run);
    const after = await run<{ fleet?: Ask[] }>("asks.workspace", {});
    expect(after.fleet?.map((ask) => [ask.scope, ask.state])).toEqual([["alpha", "answered"]]);
  } finally {
    await cleanup();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("the archive hook hands the engine the daemon's client, so a finished arc closes at once (BRO-2861)", async () => {
  const root = await mkdtemp(join(tmpdir(), "maestro-plugin-"));
  roots.push(root);
  const config = join(root, "config.json");
  await writeFile(
    config,
    JSON.stringify({ workRoot: join(root, "work"), provider: "claude/test-model", modeId: null }),
  );
  const keys = ["MAESTRO_PASEO_CONFIG", "MAESTRO_PASEO_SOCKET", "MAESTRO_PASEO_CONTROL_REPO"] as const;
  const saved = keys.map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, {
    MAESTRO_PASEO_CONFIG: config,
    MAESTRO_PASEO_SOCKET: join(root, "m.sock"),
    MAESTRO_PASEO_CONTROL_REPO: "off",
  });
  const seen: unknown[][] = [];
  const original = Engine.prototype.onArchived;
  Engine.prototype.onArchived = async function (this: Engine, ...args: Parameters<Engine["onArchived"]>) {
    seen.push(args);
  };
  const { host, hooks } = fakeHost();
  const cleanup = contribute(host);
  try {
    const archived = hooks.get("agent.archived");
    if (!archived) throw new Error("agent.archived is not subscribed");
    const fake = fakePaseo();
    await archived({ agent: { id: "someone" } }, { paseo: fake.paseo, signal: new AbortController().signal });
    expect(seen).toEqual([[{ id: "someone" }, fake.paseo]]);
  } finally {
    Engine.prototype.onArchived = original;
    await cleanup();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

/** Every file under a folder, with its bytes and its mtime: what a pure read must leave as it found it. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const visit = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) out.set(path, `${(await stat(path)).mtimeMs}:${await readFile(path, "utf8")}`);
    }
  };
  await visit(root);
  return out;
}

/** Waits until nothing under `root` changes for a second: the plugin's start-up work settled. */
async function quiet(root: string): Promise<void> {
  let last = await snapshot(root);
  let still = 0;
  for (let tries = 0; tries < 120 && still < 4; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const now = await snapshot(root);
    still = JSON.stringify([...now]) === JSON.stringify([...last]) ? still + 1 : 0;
    last = now;
  }
  if (still < 4) throw new Error("the plugin never went quiet");
}

test("needs.list and handled.list are wired, pure, and the one number every surface says (BRO-3001)", async () => {
  const root = await mkdtemp(join(tmpdir(), "maestro-plugin-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  // A control repo with an origin, so a fetch would show: it rewrites FETCH_HEAD.
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd,
      stdio: "pipe",
    });
  const origin = join(root, "origin.git");
  const control = join(root, "control");
  await mkdir(origin);
  git(origin, "init", "-q", "--bare", "-b", "main");
  git(root, "clone", "-q", origin, control);
  await mkdir(join(control, ".control", "asks"), { recursive: true });
  await mkdir(join(control, ".control", "initiatives"), { recursive: true });
  const option = (id: string, reversible: boolean, recommended: boolean) =>
    `      - id: ${id}\n        label: "${id}"\n        consequence: "It ${id}s."\n        reversible: ${reversible}\n        recommended: ${recommended}\n`;
  await writeFile(
    join(control, ".control", "asks", "needs.yaml"),
    "arc: needs\nasks:\n" +
      `  - id: Q1\n    headline: "Blocks?"\n    blocking: true\n    asked_at: 2026-10-10T12:00:00Z\n    options:\n${option("go", true, true)}` +
      `  - id: Q2\n    headline: "One way?"\n    blocking: false\n    asked_at: 2026-10-10T11:00:00Z\n    options:\n${option("delete", false, true)}` +
      `  - id: Q3\n    headline: "Calm?"\n    blocking: false\n    asked_at: 2026-10-10T10:00:00Z\n    options:\n${option("name", true, true)}`,
  );
  await writeFile(
    join(control, ".control", "initiatives", "skene.yaml"),
    'id: skene\ntitle: "Skene"\nintent: "Ship the stage."\nintent_source: "owner, 2026-09-01"\nstated: 2026-09-01\nstatus: active\nnext_action: "Land the PR."\ndriver: owner\nlinks:\n  linear: [BRO-2953]\nreview_by: 2026-01-01\nexit: "It ships."\n',
  );
  git(control, "add", ".control");
  git(control, "commit", "-q", "-m", "ledgers");
  git(control, "push", "-q", "origin", "main");
  // The answers batch as the last wake left it: waiting to land through its PR.
  const state = join(root, "state");
  await mkdir(state, { recursive: true });
  await writeFile(
    join(state, "answers-landing.json"),
    JSON.stringify({
      stage: "waiting",
      pending: 1,
      asks: [],
      pr: { number: 915, url: "https://github.com/broomva/workspace/pull/915" },
      conflict: null,
      error: null,
      landed: null,
      checkedAt: "2026-10-10T14:00:00.000Z",
    }),
  );
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
  const saved = { config: process.env.MAESTRO_PASEO_CONFIG, socket: process.env.MAESTRO_PASEO_SOCKET };
  const env: Record<string, string> = {
    // The sweep's own timer never fires inside the test: only its start-up run and the first hook's (BRO-2995).
    MAESTRO_PASEO_SWEEP_SECONDS: "3600",
    // Every sweep may fetch, so no throttle armed at start-up would hide a fetch a read makes.
    MAESTRO_PASEO_FETCH_SECONDS: "0",
    // What the sweep records (loop drift) lands under the test's root, where the snapshot sees it.
    BROOMVA_HOME: join(root, "home"),
    MAESTRO_PASEO_LAUNCHD: "off",
    MAESTRO_PASEO_SCHEDULES: join(root, "schedules"),
    MAESTRO_PASEO_LOOP_REPOS: "off",
    MAESTRO_PASEO_FLEET_CONFIG: join(root, "no-fleet", "config"),
    MAESTRO_PASEO_FLEET_STATE: join(root, "no-fleet", "state"),
    MAESTRO_PASEO_FLEET_AGENTS: join(root, "no-fleet", "agents"),
    MAESTRO_PASEO_CONTROL_REPO: control,
    MAESTRO_PASEO_CONTROL_ANSWERS: join(root, "answers"),
    MAESTRO_PASEO_ASK_RECEIPTS: join(state, "asks.jsonl"),
    MAESTRO_PASEO_ASK_LOCKS: join(state, "locks"),
  };
  const savedEnv = Object.keys(env).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, env);
  process.env.MAESTRO_PASEO_CONFIG = config;
  process.env.MAESTRO_PASEO_SOCKET = join(root, "m.sock");
  const { host, handlers, hooks } = fakeHost();
  const cleanup = contribute(host);
  const fake = fakePaseo();
  const context = { paseo: fake.paseo, signal: new AbortController().signal };
  const run = async (name: string, input: unknown) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`${name} is not handled`);
    return (await handler(input, context)) as Record<string, unknown> & { item: { id: string; state: string } };
  };
  type Needs = import("./shared/needs").Needs;
  const needsNow = async (input: unknown = {}) => (await run("needs.list", input)) as unknown as Needs;
  try {
    // Work: queued, paused on a permission prompt (a held action), stuck, and held for you (only you may start
    // it, once the loop has seen it). And an action an agent asked leave for, through the agent socket.
    const base = { brief: "", repo, initiative: "", dispatch: false, check: "", gate: "human" };
    const { item: queued } = await run("work.create", { ...base, title: "Queued" });
    const { item: gated } = await run("work.create", { ...base, title: "At your gate" });
    await run("work.dispatch", { id: gated.id });
    const agent = fake.agents.get("agent-1");
    const asked = hooks.get("agent.permission_requested");
    if (!asked) throw new Error("agent.permission_requested is not subscribed");
    agent?.pendingPermissions.push({ id: "p1", name: "Bash" });
    await asked(
      { agent: { id: "agent-1" }, request: { id: "p1", name: "Bash", input: { command: "git push" } } },
      context,
    );
    const ended = hooks.get("agent.turn_ended");
    if (!ended) throw new Error("agent.turn_ended is not subscribed");
    const socket = join(root, "m.sock");
    const deadline = Date.now() + 30_000;
    while (!(await answers(socket))) {
      if (Date.now() > deadline) throw new Error("the agent socket never opened");
      await new Promise((r) => setTimeout(r, 10));
    }
    await call(
      "approval.request",
      { action: "gh pr merge 933 --squash", ref: "ce73104", heldBy: "gate", title: "Merge #933", scope: "broomva" },
      { path: socket, caller: "agent-9" },
    );
    const { item: stuck } = await run("work.create", { ...base, title: "Stuck" });
    await run("work.dispatch", { id: stuck.id });
    await run("work.stop", { id: stuck.id, discard: true });
    await settled(run);
    // Held for you (`hold` in its _work.md, as an idea you chose to develop is filed), and flagged so by the
    // loop: its receipt, as a wake writes it.
    const { item: held } = await run("work.create", { ...base, title: "Held" });
    const heldDir = join(root, "work", (held as unknown as { path: string }).path);
    const workFile = join(heldDir, "_work.md");
    await writeFile(workFile, (await readFile(workFile, "utf8")).replace(/^---\n/, "---\nhold: Only you start it.\n"));
    const flag = { type: "loop.flagged", actor: "maestro", kind: "yours", reason: "Only you start it." };
    await writeFile(
      join(heldDir, "_events.jsonl"),
      `${await readFile(join(heldDir, "_events.jsonl"), "utf8")}${JSON.stringify({ ts: new Date().toISOString(), ...flag })}\n`,
    );
    // The sweeps the start-up and the first hook ran (the work kept true, origin/main fetched, the loops' drift
    // recorded) settle first: what follows is the reads' alone.
    await quiet(root);
    // Its session went back to work: a reconcile would move the work off your gate and write it. The sweep's
    // next run would (at most SWEEP_MS later); no read here may.
    if (agent) agent.status = "running";

    // Pure, from the first read on: no file under the test's root changes (the work, the control repo and its
    // .git, which a fetch rewrites, the receipts, the config, the drift ledger), and nothing is sent, started
    // or archived.
    const before = await snapshot(root);
    const counts = () => [fake.sent.length, fake.created.length, fake.archived.length];
    const sentBefore = counts();

    // Every kind, from every source: the two held actions (a prompt and a request), the held start and the batch as
    // owner steps, the two asks that wait and the due review. Queued and stuck work, finished work and the calm
    // ask hold nothing of yours (A1).
    const needs = await needsNow();
    expect(needs.rows.map((row) => [row.kind, row.key.split(":")[0], row.title]).sort()).toEqual(
      [
        ["approval", "approval", "Merge #933"],
        ["approval", "work", "At your gate"],
        ["ask", "ask", "Blocks?"],
        ["ask", "ask", "One way?"],
        ["ask", "review", "Review Skene: keep, park or close?"],
        ["owner_step", "answers", "1 answer waits to land: PR #915"],
        ["owner_step", "work", "Start it yourself: Held"],
      ].sort(),
    );
    expect(needs.summary).toMatchObject({ total: 7, byKind: { ask: 3, approval: 2, owner_step: 2 } });
    expect((await needsNow({ kind: "ask" })).rows).toHaveLength(3);
    // What you watch (notices.list, BRO-3036): the stuck work and the initiative past its review date, a notice
    // each and never a hold (A1); the rest of Health's sources are quiet in this fixture.
    type Notices = import("./shared/notices").Notices;
    const noticesNow = async () => (await run("notices.list", {})) as unknown as Notices;
    const notices = await noticesNow();
    expect(notices.rows.map((row) => [row.kind, row.key.split(":")[0], row.title])).toEqual([
      ["initiative", "initiatives", "1 initiative is past its review date"],
      ["stuck", "work", "Stuck"],
      // Loop drift: this fixture registers none of its loops, so Maestro's own is unclaimed. Its age is unknown: last.
      ["loop", "loop", "Maestro's loop: Unregistered"],
    ]);
    expect(notices.summary).toMatchObject({ total: 3, snoozed: 0, byKind: { stuck: 1, initiative: 1, loop: 1 } });
    expect(needs.rows.some((row) => notices.rows.some((one) => one.key === row.key))).toBe(false);
    expect(queued.state).toBe("proposed");
    const handled = (await run("handled.list", {})) as unknown as { rows: unknown[]; today: Record<string, number> };
    expect(handled).toEqual({ rows: [], today: { closedForYou: 0, byYou: 0, asksAnswered: 0 } });

    // And 25 reads of each: still nothing written. A fetch a read had started in the background lands by then.
    for (let read = 0; read < 25; read += 1) {
      await needsNow();
      await run("handled.list", {});
      await noticesNow();
      // answers.status is a read like the rest: it fetches nothing and writes nothing (the snapshot below).
      await run("answers.status", {});
    }
    await new Promise((r) => setTimeout(r, 1_000));
    expect(counts()).toEqual(sentBefore);
    expect(await snapshot(root)).toEqual(before);
    expect(await needsNow()).toEqual(needs);
    expect(await noticesNow()).toEqual(notices);
    // J5's Waiting to land and the answers hold in Needs you are one number (BRO-3001): the batch's own count.
    const status = (await run("answers.status", {})) as unknown as import("./shared/answers").AnswersStatus;
    expect(status.waitingToLand).toBe(1);
    expect(needs.rows.find((row) => row.key === "answers:batch")?.title).toBe("1 answer waits to land: PR #915");

    // Invariant 1, end to end. The header button, as startIntegrations registers it, its reads served by these
    // handlers; the Feed's section and tab from needs.list; the push from a real landing, through the real Inbox.
    const { startIntegrations } = await import("./client/integrations");
    const { needsSection } = await import("./client/feed-model");
    const { tabBadges } = await import("./client/header-count");
    const { decodeNotice, noticeText } = await import("./server/inbox");
    const header: { label?: string }[] = [];
    const integrations = startIntegrations(
      {
        paseo: {
          workspaces: {
            list: async () => ({ entries: [{ id: "ws1" }], pageInfo: { hasMore: false, nextCursor: null } }),
            subscribe: () => () => undefined,
          },
          agents: { subscribe: () => () => undefined },
        },
        rpc: (contract: { name: string }, input: unknown) => run(contract.name, input),
        openScreen: () => undefined,
        addHeaderButton: ({ button }: { button: { label?: string } }) => {
          header.push(button);
          return { update: (patch: object) => Object.assign(button, patch), remove: () => undefined };
        },
        addComposerPill: () => ({ update: () => undefined, remove: () => undefined }),
      } as never,
      { pillIcon: () => "dot" as never, PillContent: () => null },
      { later: () => () => undefined, log: () => undefined },
    );
    // A landing pushes through the inbox session: Paseo's side of it, recorded.
    const pushed: string[] = [];
    const agents = fake.paseo.agents as unknown as Record<string, unknown>;
    const ref = agents.ref as (id: string) => Record<string, unknown>;
    agents.create = async () => ({ id: "inbox-1" });
    agents.ref = (id: string) =>
      id === "inbox-1"
        ? {
            refresh: async () => ({ agent: { archivedAt: null, requiresAttention: false } }),
            send: async (_prompt: string, options?: { attachments?: { text: string }[] }) => {
              pushed.push(options?.attachments?.[0]?.text ?? "");
            },
          }
        : ref(id);
    const { item: landing } = await run("work.create", { ...base, title: "Lands now" });
    await run("work.dispatch", { id: landing.id });
    const landingAgent = fake.agents.get("agent-3");
    if (landingAgent) landingAgent.status = "idle";
    await ended({ agent: { id: "agent-3" }, outcome: { kind: "completed" }, timeline: [], turnId: "t3" }, context);
    for (let tries = 0; tries < 200 && pushed.length === 0; tries += 1) await new Promise((r) => setTimeout(r, 10));
    const after = await needsNow();
    const total = after.summary.total;
    // The header reads as it does after an event, once its first read (which also lists the pills' sessions) is in.
    const headerCount = () => Number(/^(\d+) needs? you$/.exec(header[0]?.label ?? "")?.[1]);
    for (let tries = 0; tries < 300 && headerCount() !== total; tries += 1) {
      await integrations.refresh();
      await new Promise((r) => setTimeout(r, 50));
    }
    integrations.stop();
    const items = ((await run("work.list", {})) as unknown as { items: import("./shared/contracts").WorkItem[] }).items;
    const notice = decodeNotice(pushed[0] ?? "");
    if (!notice) throw new Error("the landing pushed nothing");
    expect(total).toBe(7);
    expect({
      sumOfKinds: after.summary.byKind.ask + after.summary.byKind.approval + after.summary.byKind.owner_step,
      header: headerCount(),
      section: needsSection(after.rows, items, []).length,
      feedTab: tabBadges(after).feed?.count,
      push: Number(/^\*\*(\d+) needs? you\*\*/.exec(noticeText(notice))?.[1]),
    }).toEqual({ sumOfKinds: total, header: total, section: total, feedTab: total, push: total });

    // Your verbs, now that nothing is being proved pure (the window is 0 here): a snooze quiets its notice, a review
    // answer is a receipt in the asks' log and ends the review (the date it answered), and neither edits a file
    // of an initiative or starts a session.
    // Only a notice offering Snooze can be snoozed: not a stuck run (it closes with a turn or a cancel), and never the
    // aggregate that stands for every due review.
    for (const kind of ["stuck", "initiative"] as const) {
      const key = (await noticesNow()).rows.find((row) => row.kind === kind)?.key ?? "";
      expect(key).not.toBe("");
      await expect(run("notice.snooze", { key, hours: 4 })).rejects.toThrow(/closes when its source does/);
    }
    // A quiet run can: flagged by the loop, it is standing work's notice.
    const { item: quietWork } = await run("work.create", { ...base, title: "Quiet" });
    await run("work.dispatch", { id: quietWork.id });
    const quietDir = join(root, "work", (quietWork as unknown as { path: string }).path);
    await writeFile(
      join(quietDir, "_events.jsonl"),
      `${await readFile(join(quietDir, "_events.jsonl"), "utf8")}${JSON.stringify({
        ts: new Date().toISOString(),
        type: "loop.flagged",
        actor: "maestro",
        kind: "quiet",
        reason: "Quiet for 90 minutes.",
      })}\n`,
    );
    const quietKey = (await noticesNow()).rows.find((row) => row.kind === "quiet")?.key ?? "";
    expect(quietKey).toBe(`quiet:${quietWork.id}`);
    const totalBefore = (await noticesNow()).summary.total;
    await run("notice.snooze", { key: quietKey, hours: 4 });
    for (let tries = 0; tries < 100 && (await noticesNow()).summary.snoozed === 0; tries += 1)
      await new Promise((r) => setTimeout(r, 20));
    expect((await noticesNow()).summary).toMatchObject({ total: totalBefore - 1, snoozed: 1 });
    await expect(run("notice.snooze", { key: "work:nothing", hours: 4 })).rejects.toThrow(/no longer holds/);
    const initiativeFile = join(control, ".control", "initiatives", "skene.yaml");
    const initiativeBefore = await readFile(initiativeFile, "utf8");
    await expect(
      run("initiatives.review", { id: "skene", date: "2026-02-02", answer: "keep", note: "" }),
    ).rejects.toThrow(/not due for that date/);
    await run("initiatives.review", { id: "skene", date: "2026-01-01", answer: "park", note: "Not this quarter." });
    for (let tries = 0; tries < 100 && (await needsNow()).rows.some((row) => row.key === "review:skene"); tries += 1)
      await new Promise((r) => setTimeout(r, 20));
    expect((await needsNow()).rows.some((row) => row.key === "review:skene")).toBe(false);
    expect((await noticesNow()).rows.some((row) => row.kind === "initiative")).toBe(false);
    const receipts = (await readFile(join(state, "asks.jsonl"), "utf8"))
      .split("\n")
      .filter((line) => line.includes("initiative.reviewed"));
    expect(receipts.map((line) => JSON.parse(line))).toMatchObject([
      {
        kind: "initiative.reviewed",
        initiative: "skene",
        date: "2026-01-01",
        answer: "park",
        note: "Not this quarter.",
      },
    ]);
    expect(await readFile(initiativeFile, "utf8")).toBe(initiativeBefore);

    // The work cannot be read (a broken config): that costs the work's own rows, never the asks', the review's
    // or the batch's, and the read still answers.
    const beforeBreak = await needsNow();
    await writeFile(config, "{ not json");
    const unread = await needsNow();
    expect(unread.rows.filter((row) => row.key.startsWith("work:"))).toEqual([]);
    expect(unread.summary.total).toBe(beforeBreak.rows.filter((row) => !row.key.startsWith("work:")).length);
    expect(unread.summary.total).toBeGreaterThan(0);

    // Answers batched after the landing's last check (it says 1 waits, and is as old as its last wake): the hold in
    // Needs you and J5's tile both count the two now batched, as one number (landingNow, server/answers-status.ts).
    type AskRead = { ledger: string; id: string; hash: string };
    const open = (await run("asks.workspace", {})) as unknown as { decisions: AskRead[] };
    for (const [id, option] of [
      ["Q3", "name"],
      ["Q1", "go"],
    ] as const) {
      const ask = open.decisions.find((one) => one.id === id);
      await run("ask.answer", {
        where: { kind: "workspace", home: "origin/main" },
        ledger: ask?.ledger ?? "",
        uid: null,
        id,
        hash: ask?.hash ?? "",
        option,
        note: "",
      });
    }
    await settled(run);
    const afterAnswer = await needsNow();
    expect(afterAnswer.rows.find((row) => row.key === "answers:batch")?.title).toStartWith("2 answers wait to land");
    expect(
      ((await run("answers.status", {})) as unknown as import("./shared/answers").AnswersStatus).waitingToLand,
    ).toBe(2);
    // And the notices say so: unread work is named, so Health never says "All clear" over a missing stuck run.
    expect((await noticesNow()).summary.unread).toContain("the work");
  } finally {
    await cleanup();
    process.env.MAESTRO_PASEO_CONFIG = saved.config;
    process.env.MAESTRO_PASEO_SOCKET = saved.socket;
    if (saved.config === undefined) delete process.env.MAESTRO_PASEO_CONFIG;
    if (saved.socket === undefined) delete process.env.MAESTRO_PASEO_SOCKET;
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
