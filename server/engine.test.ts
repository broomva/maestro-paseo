import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MaestroConfig } from "../shared/contracts";
import { Engine } from "./engine";
import type { Paseo } from "./runs";
import { EVENTS_FILE, WORK_FILE, WorkStore } from "./store";

interface FakeAgent {
  id: string;
  cwd: string;
  status: "idle" | "running" | "error" | "closed";
  workspaceId: string;
  provider: string;
  title: string | null;
  archivedAt: string | null;
  pendingPermissions: Array<{ id: string; name: string }>;
  activeTurn: null;
  lastError?: string;
}

function fakePaseo() {
  const agents = new Map<string, FakeAgent>();
  const sent: Array<{ agentId: string; text: string }> = [];
  const created: Array<Record<string, unknown>> = [];
  const archived: string[] = [];
  const timelines = new Map<string, unknown[]>();
  const timelineEnd = new Map<string, string>();
  let failSend = false;
  let n = 0;
  const makeWorkspace = (directory: string) => ({
    id: `ws-${++n}`,
    directory,
    agents: {
      create: async (options: Record<string, unknown>) => {
        const id = `agent-${n}`;
        created.push(options);
        agents.set(id, {
          id,
          cwd: directory,
          status: "running",
          workspaceId: `ws-${n}`,
          provider: "claude",
          title: null,
          archivedAt: null,
          pendingPermissions: [],
          activeTurn: null,
        });
        return { id, cwd: directory };
      },
    },
  });
  const paseo = {
    providers: {
      listModels: async () => ({ models: [{ id: "haiku" }, { id: "sonnet", isDefault: true }] }),
    },
    workspaces: {
      create: async (options: { source: { cwd: string; worktreeSlug: string } }) => {
        const directory = join(options.source.cwd, ".wt", options.source.worktreeSlug);
        await mkdir(directory, { recursive: true });
        return makeWorkspace(directory);
      },
      open: async (cwd: string) => makeWorkspace(cwd),
    },
    agents: {
      ref: (id: string) => ({
        refresh: async () => {
          const agent = agents.get(id);
          return agent ? { agent, project: null } : null;
        },
        send: async (text: string) => {
          if (failSend) throw new Error("socket closed");
          sent.push({ agentId: id, text });
        },
        archive: async () => {
          archived.push(id);
          const agent = agents.get(id);
          if (agent) agent.archivedAt = new Date().toISOString();
          return { archivedAt: new Date().toISOString() };
        },
        timeline: {
          refetch: async () => ({
            entries: (timelines.get(id) ?? []).map((item) => ({ item, timestamp: timelineEnd.get(id) ?? "" })),
          }),
        },
      }),
    },
  } as unknown as Paseo;
  return {
    paseo,
    agents,
    sent,
    created,
    archived,
    timelines,
    timelineEnd,
    failNextSends: () => {
      failSend = true;
    },
  };
}

/** A real agent is idle once its turn ends; the fixture has to say so too. */
async function endTurn(
  engine: Engine,
  fake: ReturnType<typeof fakePaseo>,
  timeline: Parameters<Engine["onTurnEnded"]>[2] = [],
  agentId = "agent-1",
) {
  const agent = fake.agents.get(agentId);
  if (agent) agent.status = "idle";
  await engine.onTurnEnded({ id: agentId }, { kind: "completed" }, timeline);
}

let clock = Date.parse("2026-09-22T09:00:00.000Z");
const tick = (minutes: number) => {
  clock += minutes * 60_000;
};

async function setup(overrides: Partial<MaestroConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), "maestro-engine-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  const config: MaestroConfig = {
    workRoot: join(root, "work"),
    provider: "claude",
    modeId: null,
    isolation: "worktree",
    ...overrides,
  };
  const engine = new Engine({
    now: () => new Date(clock),
    config: async () => config,
    log: process.env.DEBUG ? console.log : () => {},
  });
  const fake = fakePaseo();
  const create = (extra: Partial<{ gate: "human" | "auto"; check: string; dispatch: boolean }> = {}) =>
    engine.create(fake.paseo, {
      title: "Persist run transcripts",
      brief: "Store it on the Run record.",
      repo,
      gate: extra.gate ?? "human",
      check: extra.check ?? "",
      initiative: "hawthorne",
      dispatch: extra.dispatch ?? true,
    });
  return { engine, fake, repo, config, create, store: new WorkStore(config.workRoot) };
}

beforeEach(() => {
  clock = Date.parse("2026-09-22T09:00:00.000Z");
});

async function settle(engine: Engine, id: string, want: string) {
  for (let i = 0; i < 100; i += 1) {
    const { item } = await engine.get(id);
    if (item.state === want) return item;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`never reached ${want}`);
}

describe("dispatch", () => {
  test("a dispatch is a worktree on a run branch plus one labelled agent", async () => {
    const { create, fake } = await setup();
    const item = await create();
    expect(item.state).toBe("running");
    expect(item.worker).toMatchObject({ agentId: "agent-1", provider: "claude/sonnet" });
    expect(item.worker?.branch).toMatch(/^run\/[0-9a-f]+$/);
    expect(item.initiative).toBe("hawthorne");
    const options = fake.created[0] as { labels: Record<string, string>; prompt: string; config: { provider: string } };
    expect(options.labels["maestro.work"]).toBe(item.id);
    expect(options.config.provider).toBe("claude/sonnet");
    expect(options.prompt).toContain("## Decided");
    expect(options.prompt).toContain(item.worker?.branch ?? "missing");
  });

  test("gate:auto without a check is refused", async () => {
    const { create } = await setup();
    await expect(create({ gate: "auto" })).rejects.toThrow("needs a check command");
  });

  test("a missing repo folder is refused before anything is written", async () => {
    const { engine, fake, config } = await setup();
    await expect(
      engine.create(fake.paseo, {
        title: "x",
        brief: "",
        repo: "/definitely/not/here",
        gate: "human",
        check: "",
        initiative: "",
        dispatch: false,
      }),
    ).rejects.toThrow("No folder at");
    expect((await new WorkStore(config.workRoot).scan()).items).toHaveLength(0);
  });

  test("hook events that beat the binding are replayed, not lost", async () => {
    const { engine, fake, repo, store } = await setup();
    const draft = await engine.create(fake.paseo, {
      title: "Race",
      brief: "",
      repo,
      gate: "human",
      check: "",
      initiative: "",
      dispatch: false,
    });
    const original = fake.paseo.workspaces.create;
    fake.paseo.workspaces.create = (async (options: Parameters<typeof original>[0]) => {
      const workspace = await original(options);
      const create = workspace.agents.create;
      return {
        ...workspace,
        agents: {
          create: async (o: Parameters<typeof create>[0]) => {
            const agent = await create(o);
            await engine.onTurnStarted({ id: agent.id });
            return agent;
          },
        },
      };
    }) as typeof original;
    await engine.dispatch(fake.paseo, draft.id);
    const item = await store.findById(draft.id);
    expect(item.events.some((e) => e.type === "turn.started")).toBe(true);
  });
});

describe("the gate", () => {
  test("a clean run under gate:human lands at Needs you, never at done", async () => {
    const { create, engine } = await setup();
    const item = await create();
    tick(30);
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "completed" }, [
      { type: "user_message", text: "go" },
      { type: "assistant_message", text: "Done.\n## Decided\n- kept it small\n## Ask\nShip it?" },
    ]);
    const { item: landed } = await engine.get(item.id);
    expect(landed.state).toBe("review");
    expect(landed.look).toEqual({
      ran: "30m unsupervised · 1 turn · ran to the gate",
      decided: ["kept it small"],
      ask: "Ship it?",
    });
  });

  test("approve closes it; the file and the log both say so", async () => {
    const { create, engine, config, fake } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    const done = await engine.verdict(null as unknown as Paseo, item.id, "approve", "");
    expect(done.state).toBe("done");
    expect(done.verdict).toBe("You approved");
    const dir = join(config.workRoot, "hawthorne", "persist-run-transcripts");
    expect(await readFile(join(dir, WORK_FILE), "utf8")).toContain("state: done");
    expect(await readFile(join(dir, EVENTS_FILE), "utf8")).toContain('"verdict":"approve"');
  });

  test("send back needs a note, wakes the same session, and returns to running", async () => {
    const { create, engine, fake } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    await expect(engine.verdict(fake.paseo, item.id, "revise", "  ")).rejects.toThrow("Say what should change");
    const back = await engine.verdict(fake.paseo, item.id, "revise", "Add a replay test");
    expect(back.state).toBe("running");
    expect(fake.sent[0]?.agentId).toBe("agent-1");
    expect(fake.sent[0]?.text).toContain("Add a replay test");
  });

  test("a send back that cannot reach the session parks as stuck with the reason", async () => {
    const { create, engine, fake } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    fake.failNextSends();
    const stuck = await engine.verdict(fake.paseo, item.id, "revise", "Again");
    expect(stuck.state).toBe("blocked");
    expect(stuck.reason).toBe("Could not reach the session: socket closed");
  });

  test("verdicts only apply at the gate", async () => {
    const { create, engine, fake } = await setup();
    const item = await create();
    await expect(engine.verdict(fake.paseo, item.id, "approve", "")).rejects.toThrow("Only work waiting on you");
  });
});

describe("checks", () => {
  test("gate:auto with a passing check closes itself", async () => {
    const { create, engine, fake } = await setup();
    const item = await create({ gate: "auto", check: "true" });
    await endTurn(engine, fake);
    const done = await settle(engine, item.id, "done");
    expect(done.verdict).toBe("Check passed");
  });

  test("gate:auto with a failing check is stuck, with the reason", async () => {
    const { create, engine, fake } = await setup();
    const item = await create({ gate: "auto", check: "exit 1" });
    await endTurn(engine, fake);
    const stuck = await settle(engine, item.id, "blocked");
    expect(stuck.reason).toBe("Checks failed");
  });

  test("gate:human still waits for you when checks pass", async () => {
    const { create, engine, fake } = await setup();
    const item = await create({ check: "true" });
    await endTurn(engine, fake);
    const landed = await settle(engine, item.id, "review");
    expect(landed.verdict).toBe("Check passed");
  });
});

describe("the agent's side", () => {
  test("a permission request is a question at the gate until it is answered", async () => {
    const { create, engine } = await setup();
    const item = await create();
    await engine.onPermissionRequested(
      { id: "agent-1" },
      { id: "p1", name: "Bash", title: "Run a command", description: "rm -rf dist" },
    );
    const asking = (await engine.get(item.id)).item;
    expect(asking.state).toBe("review");
    expect(asking.phase).toBe("asking");
    await expect(engine.verdict(null as unknown as Paseo, item.id, "approve", "")).rejects.toThrow(
      "waiting on a question",
    );
    await engine.onPermissionResolved({ id: "agent-1" }, "p1");
    expect((await engine.get(item.id)).item.state).toBe("running");
  });

  test("a failed turn is stuck with the error; unblocking wakes the session", async () => {
    const { create, engine, fake } = await setup();
    const item = await create();
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "failed", error: { message: "rate limited" } }, []);
    expect((await engine.get(item.id)).item.reason).toBe("rate limited");
    const resumed = await engine.unblock(fake.paseo, item.id, "Try again now");
    expect(resumed.state).toBe("running");
    expect(fake.sent.at(-1)?.text).toBe("Try again now");
  });

  test("archiving a running session parks the work as stuck", async () => {
    const { create, engine } = await setup();
    const item = await create();
    await engine.onArchived({ id: "agent-1" });
    expect((await engine.get(item.id)).item).toMatchObject({
      state: "blocked",
      reason: "The session was archived before it finished",
    });
  });

  test("events for sessions Maestro does not track are ignored", async () => {
    const { engine, config } = await setup();
    await engine.onTurnEnded({ id: "stranger" }, { kind: "completed" }, []);
    expect((await new WorkStore(config.workRoot).scan()).items).toHaveLength(0);
  });
});

describe("reconcile", () => {
  test("a turn end missed while the plugin was down is recovered from the agent's status", async () => {
    const { create, engine, fake } = await setup();
    const item = await create();
    const agent = fake.agents.get("agent-1");
    if (agent) agent.status = "idle";
    tick(1);
    await engine.list(fake.paseo);
    expect((await engine.get(item.id)).item.state).toBe("running");
    tick(5);
    const { items } = await engine.list(fake.paseo);
    expect(items[0]?.state).toBe("review");
  });

  test("a vanished session is stuck, not silently running forever", async () => {
    const { create, engine, fake } = await setup();
    const item = await create();
    fake.agents.delete("agent-1");
    tick(1);
    await engine.list(fake.paseo);
    expect((await engine.get(item.id)).item).toMatchObject({
      state: "blocked",
      reason: "The session ended before the run finished",
    });
  });

  test("adopting an idle session puts it at the gate", async () => {
    const { engine, fake, repo } = await setup();
    fake.agents.set("manual", {
      id: "manual",
      cwd: repo,
      status: "idle",
      workspaceId: "ws-x",
      provider: "codex",
      title: "Fix the flaky test",
      archivedAt: null,
      pendingPermissions: [],
      activeTurn: null,
    });
    const item = await engine.adopt(fake.paseo, "manual", "");
    expect(item).toMatchObject({ state: "review", title: "Fix the flaky test" });
    expect((await engine.adopt(fake.paseo, "manual", "")).id).toBe(item.id);
    expect((await engine.forAgent("manual"))?.id).toBe(item.id);
  });
});

test("list orders attention first and reports broken files as warnings", async () => {
  const { create, engine, fake, config } = await setup();
  const running = await create();
  const other = await create({ dispatch: false });
  await endTurn(engine, fake);
  await mkdir(join(config.workRoot, "broken"), { recursive: true });
  await Bun.write(join(config.workRoot, "broken", WORK_FILE), "no frontmatter");
  const { items, warnings } = await engine.list(fake.paseo);
  expect(items.map((i) => i.id)).toEqual([running.id, other.id]);
  expect(items[0]?.group).toBe("review");
  expect(warnings.some((w) => w.includes("broken"))).toBe(true);
});

test("separate assistant messages keep a paragraph break, so a final heading still parses", async () => {
  const { latestOutputText } = await import("./engine");
  const { section } = await import("./events");
  const text = latestOutputText([
    { type: "user_message", text: "go" },
    { type: "assistant_message", text: "Let me verify" },
    { type: "assistant_message", text: " the checks:" },
    { type: "todo", items: [] },
    { type: "assistant_message", text: "## Decided\n- **Content**: exact line\n## Ask\nShip it" },
  ]);
  expect(text).toBe("Let me verify the checks:\n\n## Decided\n- **Content**: exact line\n## Ask\nShip it");
  expect(section(text, "Decided")).toBe("- **Content**: exact line");
});

describe("recovery acts only on what it saw", () => {
  test("M1: a real turn end that lands first wins; reconcile does not wipe its summary", async () => {
    const { create, engine, fake, store } = await setup();
    const item = await create();
    tick(5);
    const stale = (await store.scan()).items;
    await endTurn(engine, fake, [
      { type: "user_message", text: "go" },
      { type: "assistant_message", text: "Done.\n## Decided\n- kept it small\n## Ask\nShip it?" },
    ]);
    await engine.reconcile(fake.paseo, stale);
    const { item: landed, events } = await engine.get(item.id);
    expect(landed.state).toBe("review");
    expect(landed.look?.decided).toEqual(["kept it small"]);
    expect(events.filter((e) => e.type === "turn.ended")).toHaveLength(1);
  });

  test("M2: a missed end is read from the timeline, and a failure is not called a success", async () => {
    const { create, engine, fake } = await setup();
    const item = await create({ gate: "auto", check: "true" });
    const agent = fake.agents.get("agent-1");
    if (agent) agent.status = "idle";
    fake.timelines.set("agent-1", [
      { type: "user_message", text: "go" },
      { type: "error", message: "Provider rate limit" },
    ]);
    tick(5);
    await engine.list(fake.paseo);
    expect((await engine.get(item.id)).item).toMatchObject({ state: "blocked", reason: "Provider rate limit" });
  });

  test("M2: a recovered completion never closes itself, even when the checks pass", async () => {
    const { create, engine, fake } = await setup();
    const item = await create({ gate: "auto", check: "true" });
    const agent = fake.agents.get("agent-1");
    if (agent) agent.status = "idle";
    fake.timelines.set("agent-1", [
      { type: "user_message", text: "go" },
      { type: "assistant_message", text: "Finished." },
    ]);
    tick(5);
    await engine.list(fake.paseo);
    const landed = await settle(engine, item.id, "review");
    expect(landed.verdict).toBe("Check passed");
    const { events } = await engine.get(item.id);
    expect(events.at(-1)).toMatchObject({
      text: "Waiting on you",
      detail: "Recovered after a missed event; the checks passed",
    });
  });

  test("m2: a closed session is stuck, not running forever", async () => {
    const { create, engine, fake } = await setup();
    const item = await create();
    const agent = fake.agents.get("agent-1");
    if (agent) agent.status = "closed";
    tick(1);
    await engine.list(fake.paseo);
    expect((await engine.get(item.id)).item.state).toBe("blocked");
  });

  test("m3: a session archived while asking leaves stuck work, not an unanswerable question", async () => {
    const { create, engine } = await setup();
    const item = await create();
    await engine.onPermissionRequested({ id: "agent-1" }, { id: "p1", name: "Bash", input: { command: "ls" } });
    await engine.onArchived({ id: "agent-1" });
    expect((await engine.get(item.id)).item).toMatchObject({
      state: "blocked",
      reason: "The session was archived while it was asking",
    });
  });

  test("m5: approve is refused while the session is working again", async () => {
    const { create, engine, fake } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    const agent = fake.agents.get("agent-1");
    if (agent) agent.status = "running";
    await expect(engine.verdict(fake.paseo, item.id, "approve", "")).rejects.toThrow("working again");
    expect((await engine.get(item.id)).item.state).toBe("review");
  });
});

describe("dispatch and dead ends", () => {
  test("M4: work canceled while its run starts archives the new session and records it", async () => {
    const { engine, fake, repo, store } = await setup();
    const draft = await engine.create(fake.paseo, {
      title: "Race",
      brief: "",
      repo,
      gate: "human",
      check: "",
      initiative: "",
      dispatch: false,
    });
    const original = fake.paseo.workspaces.create;
    fake.paseo.workspaces.create = (async (options: Parameters<typeof original>[0]) => {
      const workspace = await original(options);
      await store.mutate(draft.id, () => ({ to: "canceled", actor: "human" }));
      return workspace;
    }) as typeof original;
    await expect(engine.dispatch(fake.paseo, draft.id)).rejects.toThrow("changed while the run was starting");
    expect(fake.archived).toEqual(["agent-1"]);
    const { item, events } = await engine.get(draft.id);
    expect(item.state).toBe("canceled");
    expect(events.at(-1)?.text).toContain("Archived session agent-1");
  });

  test("M5: running work with no recorded session gets a way out", async () => {
    const { engine, fake, config } = await setup();
    const dir = join(config.workRoot, "orphan");
    await mkdir(dir, { recursive: true });
    await Bun.write(
      join(dir, WORK_FILE),
      "---\nid: orphan-1\nkind: task\nstate: running\ngate: human\ncreated: 2026-09-22\nupdated: 2026-09-22\n---\n\n# Orphan\n",
    );
    await engine.list(fake.paseo);
    expect((await engine.get("orphan-1")).item).toMatchObject({
      state: "blocked",
      reason: "No session is recorded for this run",
    });
    expect((await engine.cancel("orphan-1")).state).toBe("canceled");
  });

  test("m4: a torn event line is reported, and the next event is not swallowed", async () => {
    const { create, engine, fake, config } = await setup();
    const item = await create({ dispatch: false });
    const events = join(config.workRoot, "hawthorne", "persist-run-transcripts", EVENTS_FILE);
    const { appendFile } = await import("node:fs/promises");
    await appendFile(events, '{"ts":"2026-09-22T09:00:00.000Z","type":"no');
    await engine.dispatch(fake.paseo, item.id);
    const { warnings } = await engine.list(fake.paseo);
    expect(warnings.some((w) => w.includes("1 unreadable line"))).toBe(true);
    expect((await engine.get(item.id)).item).toMatchObject({ state: "running", worker: { agentId: "agent-1" } });
  });

  test("relative repository paths are refused", async () => {
    const { engine, fake } = await setup();
    await expect(
      engine.create(fake.paseo, {
        title: "x",
        brief: "",
        repo: "code/project",
        gate: "human",
        check: "",
        initiative: "",
        dispatch: false,
      }),
    ).rejects.toThrow("absolute path");
  });
});

test("a recovered end is stamped when the agent really stopped, not when it was noticed", async () => {
  const { create, engine, fake } = await setup();
  const item = await create();
  const agent = fake.agents.get("agent-1");
  if (agent) agent.status = "idle";
  fake.timelines.set("agent-1", [
    { type: "user_message", text: "go" },
    { type: "assistant_message", text: "Done." },
  ]);
  fake.timelineEnd.set("agent-1", new Date(clock + 60_000).toISOString());
  tick(30);
  await engine.list(fake.paseo);
  const { item: landed } = await engine.get(item.id);
  expect(landed.state).toBe("review");
  expect(landed.look?.ran).toBe("1m unsupervised · 1 turn · ran to the gate");
});
