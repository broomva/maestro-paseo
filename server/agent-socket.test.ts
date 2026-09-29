import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, unlink } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call, main, Refused } from "../bin/maestro";
import type { MaestroConfig, WorkItem } from "../shared/contracts";
import { agentMethods, answer, serveAgents } from "./agent-socket";
import { Engine, NO_HANDLE } from "./engine";
import { parseEvents } from "./events";
import { fakePaseo } from "./fake-paseo";
import type { Paseo } from "./runs";
import { EVENTS_FILE } from "./store";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "maestro-socket-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  const config: MaestroConfig = {
    workRoot: join(root, "work"),
    provider: "claude",
    modeId: null,
    isolation: "worktree",
  };
  const engine = new Engine({ config: async () => config, log: () => {} });
  const fake = fakePaseo();
  let handle: Paseo | null = fake.paseo;
  const methods = agentMethods(engine, () => handle);
  const ask = async (method: string, input: unknown = {}, caller: string | null = "session-1") => {
    const response = await answer(methods, JSON.stringify({ id: 7, method, input, caller }));
    expect(response.id).toBe(7);
    return response;
  };
  const ok = async (method: string, input: unknown = {}, caller: string | null = "session-1") => {
    const response = await ask(method, input, caller);
    if (!response.ok) throw new Error(`${method} refused: ${response.error}`);
    return response.output as { item: WorkItem };
  };
  const events = async (item: WorkItem) =>
    parseEvents(await readFile(join(config.workRoot, item.path, EVENTS_FILE), "utf8")).events;
  const disconnect = () => {
    handle = null;
  };
  return { root, repo, config, engine, fake, methods, ask, ok, events, disconnect };
}

describe("what a session is offered", () => {
  test("work a session creates is recorded as that session's and waits at the gate", async () => {
    const { repo, ok, events } = await setup();
    const { item } = await ok("work.create", { title: "Trim the cache", repo });
    expect(item.gate).toBe("human");
    expect(item.group).toBe("queued");
    expect(await events(item)).toMatchObject([{ type: "created", actor: "agent", by: "session-1" }]);
  });

  test("a session cannot let checks close its own work", async () => {
    const { repo, ask, engine } = await setup();
    const response = await ask("work.create", { title: "Self-closing", repo, gate: "auto", check: "true" });
    expect(response).toMatchObject({ ok: false });
    expect(!response.ok && response.error).toContain("your call");
    expect((await engine.list()).items).toHaveLength(0);
  });

  test("a dispatch it asks for is its own, and is not counted as you stepping in", async () => {
    const { repo, ok, events, engine, fake } = await setup();
    const { item: created } = await ok("work.create", { title: "Trim the cache", repo });
    const { item } = await ok("work.dispatch", { id: created.id });
    expect(item.state).toBe("running");
    expect(item.worker?.agentId).toBe("agent-1");
    const log = await events(item);
    expect(log.find((event) => event.type === "dispatched")).toMatchObject({ actor: "agent", by: "session-1" });
    expect(log.find((event) => event.type === "state")).toMatchObject({ actor: "agent", to: "running" });
    expect((await engine.list(fake.paseo)).scoreboard.looks).toBe(0);

    // The same verb from Maestro's own screens is yours, and is a look.
    const mine = await engine.create(fake.paseo, {
      title: "By hand",
      brief: "",
      repo,
      gate: "human",
      check: "",
      initiative: "",
      dispatch: true,
    });
    expect((await engine.get(mine.id)).events.find((e) => e.type === "dispatched")?.actor).toBe("human");
    expect((await engine.list(fake.paseo)).scoreboard.looks).toBe(1);
  });

  test("create and dispatch in one step", async () => {
    const { repo, ok } = await setup();
    const { item } = await ok("work.create", { title: "Now", repo, dispatch: true });
    expect(item.state).toBe("running");
  });

  test("the gate, unblocking, canceling and settings are refused, and change nothing", async () => {
    const { repo, ok, ask, engine, fake } = await setup();
    const { item } = await ok("work.create", { title: "Trim the cache", repo, dispatch: true });
    const agent = fake.agents.get("agent-1");
    if (agent) agent.status = "idle";
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "completed" }, []);
    expect((await engine.get(item.id)).item.state).toBe("review");

    for (const [method, input] of [
      ["work.verdict", { id: item.id, verdict: "approve", note: "" }],
      ["work.unblock", { id: item.id, note: "" }],
      ["work.cancel", { id: item.id }],
      ["config.set", { workRoot: "/tmp", provider: "claude", modeId: "bypassPermissions", isolation: "directory" }],
    ] as const) {
      const response = await ask(method, input);
      expect(response.ok).toBe(false);
      expect(!response.ok && response.error).toContain("yours alone");
    }
    expect((await engine.get(item.id)).item.state).toBe("review");
    expect((await ok("config.get")) as unknown as MaestroConfig).toMatchObject({ modeId: null });
  });

  test("names that are not verbs are unknown, including object built-ins", async () => {
    const { ask } = await setup();
    for (const method of ["toString", "__proto__", "constructor", "work.delete"]) {
      const response = await ask(method);
      expect(!response.ok && response.error).toContain("Unknown method");
    }
  });

  test("tracking and looking up default to the calling session", async () => {
    const { ok, ask, fake, events } = await setup();
    fake.agents.set("session-1", {
      id: "session-1",
      cwd: "/tmp",
      status: "running",
      workspaceId: "ws-x",
      provider: "claude",
      title: "Refactor the loader",
      archivedAt: null,
      pendingPermissions: [],
      activeTurn: null,
    });
    const { item } = await ok("work.adopt", {});
    expect(item.worker?.agentId).toBe("session-1");
    expect(item.title).toBe("Refactor the loader");
    expect((await events(item)).find((event) => event.type === "adopted")).toMatchObject({
      actor: "agent",
      by: "session-1",
    });
    expect((await ok("work.for-agent")).item?.id).toBe(item.id);

    const anonymous = await ask("work.for-agent", {}, null);
    expect(!anonymous.ok && anonymous.error).toContain("Say which session");
  });

  test("without a daemon client, reads work and starting runs says why", async () => {
    const { repo, ok, ask, disconnect, engine } = await setup();
    disconnect();
    expect((await ok("work.list")) as unknown as { items: unknown[] }).toMatchObject({ items: [] });
    const { item } = await ok("work.create", { title: "Later", repo });
    const dispatch = await ask("work.dispatch", { id: item.id });
    expect(!dispatch.ok && dispatch.error).toBe(NO_HANDLE);
    const both = await ask("work.create", { title: "Now", repo, dispatch: true });
    expect(!both.ok && both.error).toContain("cannot be dispatched yet");
    const listed = (await engine.list()).items;
    expect(listed.map((i) => i.title).sort()).toEqual(["Later", "Now"]);
    expect(listed.every((i) => i.group === "queued")).toBe(true);
  });

  test("malformed requests get answers, not silence", async () => {
    const { methods } = await setup();
    expect(await answer(methods, "not json")).toMatchObject({ ok: false, error: "Each request is one line of JSON." });
    expect(await answer(methods, JSON.stringify({ input: {} }))).toMatchObject({ ok: false });
    expect(await answer(methods, JSON.stringify({ method: "work.get", input: {} }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("Invalid input"),
    });
  });
});

describe("the socket", () => {
  const once = (path: string, text: string) =>
    new Promise<string>((resolve, reject) => {
      const socket = connect(path);
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(text));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
      });
      socket.on("end", () => resolve(buffer));
      socket.on("error", reject);
      setTimeout(() => socket.end(), 300);
    });

  test("only this user can open it, and the CLI speaks to it", async () => {
    const { root, repo, methods } = await setup();
    const path = join(root, "maestro.sock");
    const close = await serveAgents({ path, methods });
    try {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const output = (await call("work.create", { title: "From the CLI", repo }, { path, caller: "cli-1" })) as {
        item: WorkItem;
      };
      expect(output.item.title).toBe("From the CLI");
      await expect(call("work.verdict", { id: output.item.id }, { path })).rejects.toBeInstanceOf(Refused);
    } finally {
      await close();
    }
  });

  test("requests on one connection are answered in order; an oversized one closes it", async () => {
    const { root, methods } = await setup();
    const path = join(root, "maestro.sock");
    const close = await serveAgents({ path, methods });
    try {
      const lines = await once(
        path,
        `${JSON.stringify({ id: 1, method: "config.get" })}\n\n${JSON.stringify({ id: 2, method: "nope" })}\n`,
      );
      expect(
        lines
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).id),
      ).toEqual([1, 2]);
      const big = await once(path, "x".repeat((1 << 20) + 10));
      expect(big).toContain("Request too large.");
    } finally {
      await close();
    }
  });

  test("a socket left by a crashed instance is replaced", async () => {
    const { root, methods } = await setup();
    const path = join(root, "maestro.sock");
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `require("node:net").createServer().listen(${JSON.stringify(path)}, () => console.log("up"))`,
      ],
      { stdout: "pipe" },
    );
    const reader = child.stdout.getReader();
    await reader.read();
    child.kill("SIGKILL");
    await child.exited;
    expect((await stat(path)).isSocket()).toBe(true);
    const close = await serveAgents({ path, methods });
    try {
      expect(await call("config.get", {}, { path })).toMatchObject({ provider: "claude" });
    } finally {
      await close();
    }
  });

  test("a live instance keeps its socket; a second one gives up", async () => {
    const { root, methods } = await setup();
    const path = join(root, "maestro.sock");
    const close = await serveAgents({ path, methods });
    try {
      await expect(serveAgents({ path, methods, attempts: 2, retryMs: 10 })).rejects.toThrow(/already answering/);
      expect(await call("config.get", {}, { path })).toMatchObject({ provider: "claude" });
    } finally {
      await close();
    }
  });

  test("closing removes the socket only while it is still this instance's", async () => {
    const { root, methods } = await setup();
    const path = join(root, "maestro.sock");
    const closeOld = await serveAgents({ path, methods });
    await unlink(path);
    const closeNew = await serveAgents({ path, methods });
    await closeOld();
    expect(await call("config.get", {}, { path })).toMatchObject({ provider: "claude" });
    await closeNew();
    await expect(stat(path)).rejects.toThrow();
  });

  test("the CLI finds the socket and the session from the environment", async () => {
    const { root, repo, methods, events } = await setup();
    const path = join(root, "maestro.sock");
    const close = await serveAgents({ path, methods });
    const saved = { socket: process.env.MAESTRO_PASEO_SOCKET, agent: process.env.PASEO_AGENT_ID };
    process.env.MAESTRO_PASEO_SOCKET = path;
    process.env.PASEO_AGENT_ID = "cli-session";
    const printed: string[] = [];
    try {
      expect(await main(["new", "Write", "the", "docs", "--repo", repo], (text) => printed.push(text))).toBe(0);
      expect(printed[0]).toMatch(/^Created \S+ {2}Write the docs/);
      expect(await main(["ls"], (text) => printed.push(text))).toBe(0);
      expect(printed[1]).toContain("Queued (1)");
      const json = [] as string[];
      await main(["ls", "--json"], (text) => json.push(text));
      const [item] = (JSON.parse(json[0] ?? "{}") as { items: WorkItem[] }).items;
      if (!item) throw new Error("no item listed");
      expect((await events(item))[0]).toMatchObject({ actor: "agent", by: "cli-session" });
      await main(["show", item.id], (text) => printed.push(text));
      expect(printed.at(-1)).toContain("by session cli-sess");
      await expect(main(["show"], () => {})).rejects.toBeInstanceOf(Refused);
    } finally {
      process.env.MAESTRO_PASEO_SOCKET = saved.socket;
      process.env.PASEO_AGENT_ID = saved.agent;
      if (saved.socket === undefined) delete process.env.MAESTRO_PASEO_SOCKET;
      if (saved.agent === undefined) delete process.env.PASEO_AGENT_ID;
      await close();
    }
  });
});
