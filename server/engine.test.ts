import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MaestroConfig } from "../shared/contracts";
import type { Verdict } from "../shared/states";
import { defaultConfig } from "./config";
import { Engine, type Timer, UNDO_MS } from "./engine";
import { fakePaseo } from "./fake-paseo";
import type { Paseo } from "./runs";
import { EVENTS_FILE, WORK_FILE, WorkStore } from "./store";

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
const tickMs = (ms: number) => {
  clock += ms;
};

/** Timers the test fires by hand, after moving the same clock the engine reads. */
function fakeTimers() {
  const armed: Array<{ run: () => Promise<void>; ms: number; canceled: boolean }> = [];
  const timer: Timer = (run, ms) => {
    const entry = { run, ms, canceled: false };
    armed.push(entry);
    return () => {
      entry.canceled = true;
    };
  };
  return {
    timer,
    /** Timers armed and not canceled, not yet fired. */
    live: () => armed.filter((entry) => !entry.canceled),
    /** Fire every timer armed so far, as if its delay had passed, and wait for what it does. */
    fire: async () => {
      for (const entry of armed.splice(0)) if (!entry.canceled) await entry.run();
    },
  };
}

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(overrides: Partial<MaestroConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), "maestro-engine-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  const config: MaestroConfig = {
    ...defaultConfig(),
    workRoot: join(root, "work"),
    provider: "claude",
    modeId: null,
    isolation: "worktree",
    ...overrides,
  };
  const timers = fakeTimers();
  const engine = new Engine({
    now: () => new Date(clock),
    config: async () => config,
    log: process.env.DEBUG ? console.log : () => {},
    timer: timers.timer,
  });
  const fake = fakePaseo();
  /** Decide at the gate and let the undo window run out. */
  const decide = async (id: string, verdict: Verdict, note = "", paseo: Paseo | null = fake.paseo) => {
    await engine.verdict(paseo, id, verdict, note);
    tickMs(UNDO_MS);
    await timers.fire();
    return (await engine.get(id)).item;
  };
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
  return { engine, fake, repo, config, create, store: new WorkStore(config.workRoot), timers, decide };
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
    const { create, engine, config, fake, decide } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    const done = await decide(item.id, "approve");
    expect(done.state).toBe("done");
    expect(done.verdict).toBe("You approved");
    const dir = join(config.workRoot, "hawthorne", "persist-run-transcripts");
    expect(await readFile(join(dir, WORK_FILE), "utf8")).toContain("state: done");
    expect(await readFile(join(dir, EVENTS_FILE), "utf8")).toContain('"verdict":"approve"');
  });

  test("send back needs a note, wakes the same session, and returns to running", async () => {
    const { create, engine, fake, decide } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    await expect(engine.verdict(fake.paseo, item.id, "revise", "  ")).rejects.toThrow("Say what should change");
    const back = await decide(item.id, "revise", "Add a replay test");
    expect(back.state).toBe("running");
    expect(fake.sent[0]?.agentId).toBe("agent-1");
    expect(fake.sent[0]?.text).toContain("Add a replay test");
  });

  test("a send back that cannot reach the session parks as stuck with the reason", async () => {
    const { create, engine, fake, decide } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    fake.failNextSends();
    const stuck = await decide(item.id, "revise", "Again");
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
    expect(fake.archivedWorkspaces).toEqual(["ws-1"]);
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

/** Holds the next store scan open after it has read the tree, so a test can land a write in between. */
function holdNextScan() {
  const original = WorkStore.prototype.scan;
  let readDone!: () => void;
  let release!: () => void;
  const read = new Promise<void>((resolve) => {
    readDone = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let armed = true;
  WorkStore.prototype.scan = async function (this: WorkStore) {
    const result = await original.call(this);
    if (armed) {
      armed = false;
      readDone();
      await released;
    }
    return result;
  };
  return { read, release, restore: () => (WorkStore.prototype.scan = original) };
}

describe("round 2: lookups and duplicates", () => {
  test("a list whose scan overlaps a dispatch does not make the bound agent unknown", async () => {
    const { engine, fake, repo } = await setup();
    const draft = await engine.create(fake.paseo, {
      title: "Stale index",
      brief: "",
      repo,
      gate: "human",
      check: "",
      initiative: "",
      dispatch: false,
    });
    const hold = holdNextScan();
    try {
      const listing = engine.list();
      await hold.read;
      hold.restore();
      await engine.dispatch(fake.paseo, draft.id);
      hold.release();
      await listing;
    } finally {
      hold.restore();
    }
    await engine.onPermissionRequested({ id: "agent-1" }, { id: "p1", name: "Bash", input: { command: "ls" } });
    expect((await engine.get(draft.id)).item).toMatchObject({ state: "review", phase: "asking" });
    // Tracking the same session again finds the item instead of making a second one.
    expect((await engine.adopt(fake.paseo, "agent-1", "")).id).toBe(draft.id);
    expect((await engine.list()).items).toHaveLength(1);
  });

  test("an event queued for an agent that got bound meanwhile is delivered, not stranded", async () => {
    const { engine, fake, repo } = await setup();
    const make = (title: string) =>
      engine.create(fake.paseo, { title, brief: "", repo, gate: "human", check: "", initiative: "", dispatch: false });
    const first = await make("First");
    const second = await make("Second");
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let early!: Promise<void>;
    let secondDispatch!: Promise<unknown>;
    let releaseEarly!: () => void;
    const original = fake.paseo.workspaces.create;
    let calls = 0;
    fake.paseo.workspaces.create = (async (options: Parameters<typeof original>[0]) => {
      calls += 1;
      if (calls === 2) await secondGate;
      const workspace = await original(options);
      if (calls !== 1) return workspace;
      const create = workspace.agents.create;
      return {
        ...workspace,
        agents: {
          create: async (o: Parameters<typeof create>[0]) => {
            const agent = await create(o);
            const hold = holdNextScan();
            early = engine.onTurnStarted({ id: agent.id });
            await hold.read;
            hold.restore();
            releaseEarly = hold.release;
            secondDispatch = engine.dispatch(fake.paseo, second.id).catch(() => undefined);
            return agent;
          },
        },
      };
    }) as typeof original;
    await engine.dispatch(fake.paseo, first.id);
    releaseEarly();
    await early;
    await engine.onPermissionRequested({ id: "agent-1" }, { id: "p2", name: "Bash", input: { command: "git push" } });
    expect((await engine.get(first.id)).item).toMatchObject({ state: "review", phase: "asking" });
    releaseSecond();
    await secondDispatch;
  });

  test("a late real hook after a recovered end does not run the checks twice", async () => {
    const { create, engine, fake } = await setup();
    const item = await create({ check: "sleep 0.3" });
    const agent = fake.agents.get("agent-1");
    if (agent) agent.status = "idle";
    fake.timelines.set("agent-1", [
      { type: "user_message", text: "go" },
      { type: "assistant_message", text: "Done." },
    ]);
    tick(5);
    await engine.list(fake.paseo);
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "completed" }, [], null);
    await settle(engine, item.id, "review");
    const { events } = await engine.get(item.id);
    expect(events.filter((e) => e.type === "turn.ended")).toHaveLength(1);
    expect(events.filter((e) => e.type === "checks.started")).toHaveLength(1);
  });

  test("a repeated turn end in one stretch changes nothing; a reused id after a send back is a new turn", async () => {
    const { create, engine, fake, decide } = await setup();
    const item = await create({ check: "sleep 0.2" });
    const idle = fake.agents.get("agent-1");
    if (idle) idle.status = "idle";
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "completed" }, [], "turn-1");
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "completed" }, [], "turn-1");
    await settle(engine, item.id, "review");
    expect((await engine.get(item.id)).events.filter((e) => e.type === "checks.started")).toHaveLength(1);
    // The session reopened and numbers its turns from 1 again.
    await decide(item.id, "revise", "one more thing");
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "completed" }, [], "turn-1");
    await settle(engine, item.id, "review");
    expect((await engine.get(item.id)).events.filter((e) => e.type === "checks.started")).toHaveLength(2);
  });

  test("a recovered end with checks is still stamped when the agent stopped", async () => {
    const { create, engine, fake } = await setup();
    const item = await create({ check: "true" });
    const agent = fake.agents.get("agent-1");
    if (agent) agent.status = "idle";
    fake.timelines.set("agent-1", [
      { type: "user_message", text: "go" },
      { type: "assistant_message", text: "Done." },
    ]);
    fake.timelineEnd.set("agent-1", new Date(clock + 60_000).toISOString());
    tick(30);
    await engine.list(fake.paseo);
    const landed = await settle(engine, item.id, "review");
    expect(landed.look?.ran).toBe("1m unsupervised · 1 turn · ran to the gate");
  });

  test("a timeline that cannot be read leaves the run alone until the next look", async () => {
    const { create, engine, fake } = await setup();
    const item = await create();
    const agent = fake.agents.get("agent-1");
    if (agent) agent.status = "idle";
    const ref = fake.paseo.agents.ref;
    fake.paseo.agents.ref = ((id: string) => ({
      ...ref(id),
      timeline: {
        refetch: async () => {
          throw new Error("socket closed");
        },
      },
    })) as unknown as typeof ref;
    tick(5);
    await engine.list(fake.paseo);
    expect((await engine.get(item.id)).item.state).toBe("running");
  });
});

test("only an error that ends the turn fails it", async () => {
  const { outcomeOf } = await import("./engine");
  expect(
    outcomeOf([
      { type: "user_message", text: "go" },
      { type: "error", message: "tool hiccup" },
      { type: "assistant_message", text: "recovered, done" },
    ]).kind,
  ).toBe("completed");
  expect(
    outcomeOf([
      { type: "user_message", text: "go" },
      { type: "error", message: "rate limit" },
    ]),
  ).toEqual({
    kind: "failed",
    error: { message: "rate limit" },
  });
});

describe("round 3: ownership, missed starts, ordering", () => {
  test("in directory mode a failed bind never archives the user's own workspace", async () => {
    const { engine, fake, repo, store } = await setup({ isolation: "directory" });
    const draft = await engine.create(fake.paseo, {
      title: "Directory race",
      brief: "",
      repo,
      gate: "human",
      check: "",
      initiative: "",
      dispatch: false,
    });
    const original = fake.paseo.workspaces.open;
    fake.paseo.workspaces.open = (async (cwd: string) => {
      const workspace = await original(cwd);
      await store.mutate(draft.id, () => ({ to: "canceled", actor: "human" }));
      return workspace;
    }) as typeof original;
    await expect(engine.dispatch(fake.paseo, draft.id)).rejects.toThrow("changed while the run was starting");
    expect(fake.archived).toEqual(["agent-1"]);
    expect(fake.archivedWorkspaces).toEqual([]);
  });

  test("a new turn whose start was missed updates the gate, and a failed one is Stuck", async () => {
    const { create, engine, fake } = await setup();
    const item = await create();
    const idle = fake.agents.get("agent-1");
    if (idle) idle.status = "idle";
    await engine.onTurnEnded(
      { id: "agent-1" },
      { kind: "completed" },
      [
        { type: "user_message", text: "go" },
        { type: "assistant_message", text: "## Decided\n- first pass\n## Ask\nok?" },
      ],
      "turn-1",
    );
    await engine.onTurnEnded(
      { id: "agent-1" },
      { kind: "completed" },
      [
        { type: "user_message", text: "more" },
        { type: "assistant_message", text: "## Decided\n- force-pushed main\n## Ask\nfine?" },
      ],
      "turn-2",
    );
    expect((await engine.get(item.id)).item.look?.decided).toEqual(["force-pushed main"]);
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "failed", error: { message: "push rejected" } }, [], "turn-3");
    expect((await engine.get(item.id)).item).toMatchObject({ state: "blocked", reason: "push rejected" });
  });

  test("with checks, a later turn at the gate runs the checks again", async () => {
    const { create, engine, fake } = await setup({});
    const item = await create({ check: "true" });
    const idle = fake.agents.get("agent-1");
    if (idle) idle.status = "idle";
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "completed" }, [], "turn-1");
    await settle(engine, item.id, "review");
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "completed" }, [], "turn-2");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await settle(engine, item.id, "review");
    expect((await engine.get(item.id)).events.filter((e) => e.type === "checks.finished")).toHaveLength(2);
  });

  test("a slow turn start delivered after its own end does not reopen the gate", async () => {
    const { engine, fake, repo } = await setup();
    const draft = await engine.create(fake.paseo, {
      title: "Reorder",
      brief: "",
      repo,
      gate: "human",
      check: "",
      initiative: "",
      dispatch: false,
    });
    let early!: Promise<void>;
    let releaseEarly!: () => void;
    const original = fake.paseo.workspaces.create;
    fake.paseo.workspaces.create = (async (options: Parameters<typeof original>[0]) => {
      const workspace = await original(options);
      const create = workspace.agents.create;
      return {
        ...workspace,
        agents: {
          create: async (o: Parameters<typeof create>[0]) => {
            const agent = await create(o);
            const hold = holdNextScan();
            early = engine.onTurnStarted({ id: agent.id });
            await hold.read;
            hold.restore();
            releaseEarly = hold.release;
            return agent;
          },
        },
      };
    }) as typeof original;
    await engine.dispatch(fake.paseo, draft.id);
    const idle = fake.agents.get("agent-1");
    if (idle) idle.status = "idle";
    const ended = engine.onTurnEnded({ id: "agent-1" }, { kind: "completed" }, [], "t1");
    releaseEarly();
    await Promise.all([early, ended]);
    const { item, events } = await engine.get(draft.id);
    expect(item.state).toBe("review");
    expect(events.some((e) => e.detail === "You continued the session")).toBe(false);
  });
});

describe("round 4", () => {
  test("a newer check run stops the older one, so runs never overlap in one worktree", async () => {
    const { create, engine, fake, config } = await setup();
    const log = join(config.workRoot, "..", "checks.log");
    const item = await create({ check: `echo start >> ${log}; sleep 0.4; echo end >> ${log}` });
    const idle = fake.agents.get("agent-1");
    if (idle) idle.status = "idle";
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "completed" }, [], "t1");
    await settle(engine, item.id, "review");
    tick(1);
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "completed" }, [], "t2");
    await new Promise((resolve) => setTimeout(resolve, 100));
    tick(1);
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "completed" }, [], "t3");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await settle(engine, item.id, "review");
    const lines = (await readFile(log, "utf8")).trim().split("\n");
    // Three runs started; the superseded one was stopped before it could finish, so only two ended.
    expect(lines.filter((line) => line === "start")).toHaveLength(3);
    expect(lines.filter((line) => line === "end")).toHaveLength(2);
    expect(lines.at(-1)).toBe("end");
  });

  test("a failed turn end without a turn id is never hidden as a repeat", async () => {
    const { create, engine, fake } = await setup();
    const item = await create();
    const idle = fake.agents.get("agent-1");
    if (idle) idle.status = "idle";
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "completed" }, [], null);
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "failed", error: { message: "push rejected" } }, [], null);
    expect((await engine.get(item.id)).item).toMatchObject({ state: "blocked", reason: "push rejected" });
  });
});

test("a read while a change is in flight returns the finished change, never half of it", async () => {
  const { create, engine, store } = await setup();
  const item = await create();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const change = store.mutate(item.id, async () => {
    entered();
    await gate;
    return { to: "review", reason: "held open" };
  });
  await inside;
  const reading = engine.get(item.id);
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  await change;
  const { item: read, events } = await reading;
  expect(read.state).toBe("review");
  expect(events.at(-1)?.detail).toBe("held open");
});

describe("the undo window", () => {
  test("a decision is recorded when you make it and takes effect 10s later", async () => {
    const { create, engine, fake, timers } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    const looksBefore = (await engine.list(fake.paseo)).scoreboard.looks;
    const pending = await engine.verdict(fake.paseo, item.id, "approve", "");
    expect(pending).toMatchObject({ state: "review", pending: { verdict: "approve", remainingMs: UNDO_MS } });
    expect(timers.live().map((timer) => timer.ms)).toEqual([UNDO_MS]);
    // The look counts at the click, not when it applies.
    expect((await engine.list(fake.paseo)).scoreboard.looks).toBe(looksBefore + 1);

    // A timer that fires before the clock reaches the deadline applies nothing and waits out the rest.
    tickMs(UNDO_MS - 1);
    await timers.fire();
    expect((await engine.get(item.id)).item).toMatchObject({ state: "review", pending: { remainingMs: 1 } });
    expect(timers.live().map((timer) => timer.ms)).toEqual([1]);

    tickMs(1);
    await timers.fire();
    const { item: done, events } = await engine.get(item.id);
    expect(done).toMatchObject({ state: "done", pending: null, verdict: "You approved" });
    expect(events.slice(-2).map((event) => event.text)).toEqual(["Approving in 10s", "You approved"]);
    expect((await engine.list(fake.paseo)).scoreboard.looks).toBe(looksBefore + 1);
  });

  test("undo inside the window takes it back, and nothing applies later", async () => {
    const { create, engine, fake, timers } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    const looksBefore = (await engine.list(fake.paseo)).scoreboard.looks;
    await engine.verdict(fake.paseo, item.id, "revise", "Add a replay test");
    tickMs(4_000);
    expect(await engine.undo(item.id)).toMatchObject({ state: "review", pending: null });
    expect(timers.live()).toHaveLength(0);
    tickMs(UNDO_MS);
    await timers.fire();
    await engine.list(fake.paseo);
    const { item: after, events } = await engine.get(item.id);
    expect(after).toMatchObject({ state: "review", pending: null });
    expect(fake.sent).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ text: "Undone", detail: "Send back" });
    // The decision was a look; taking it back does not add or remove one.
    expect((await engine.list(fake.paseo)).scoreboard.looks).toBe(looksBefore + 1);
    // A fresh decision can follow.
    expect((await engine.verdict(fake.paseo, item.id, "approve", "")).pending?.verdict).toBe("approve");
  });

  test("undo after it took effect is refused, and so is undo with nothing decided", async () => {
    const { create, engine, fake, decide } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    await expect(engine.undo(item.id)).rejects.toThrow("There is no decision waiting to take effect.");
    expect((await decide(item.id, "approve")).state).toBe("done");
    await expect(engine.undo(item.id)).rejects.toThrow("Too late to undo: it already took effect.");
    expect((await engine.get(item.id)).item.state).toBe("done");
  });

  test("one decision at a time: a second is refused until the first is undone", async () => {
    const { create, engine, fake } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    await engine.verdict(fake.paseo, item.id, "approve", "");
    await expect(engine.verdict(fake.paseo, item.id, "block", "")).rejects.toThrow("already waiting to take effect");
    await expect(engine.cancel(item.id)).rejects.toThrow("already waiting to take effect");
    await engine.undo(item.id);
    expect((await engine.cancel(item.id)).pending?.verdict).toBe("block");
  });

  test("cancel from Needs you waits out the window; queued work cancels at once", async () => {
    const { create, engine, fake, timers } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    expect(await engine.cancel(item.id)).toMatchObject({ state: "review", pending: { verdict: "block" } });
    tickMs(UNDO_MS);
    await timers.fire();
    expect((await engine.get(item.id)).item).toMatchObject({ state: "canceled", verdict: "You canceled it" });

    const queued = await create({ dispatch: false });
    expect(await engine.cancel(queued.id)).toMatchObject({ state: "canceled", pending: null });
  });

  test("a restart after the window closed applies the decision on load", async () => {
    const { create, engine, fake, config, timers } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    await engine.verdict(fake.paseo, item.id, "approve", "");
    // The plugin goes down inside the window; its timer goes with it.
    engine.stop();
    expect(timers.live()).toHaveLength(0);
    tickMs(UNDO_MS + 60_000);
    const restarted = new Engine({ now: () => new Date(clock), config: async () => config, log: () => {} });
    expect(await restarted.sweep(fake.paseo)).toBe(true);
    expect((await restarted.get(item.id)).item).toMatchObject({ state: "done", pending: null });
  });

  test("a restart inside the window arms a timer for what is left of it", async () => {
    const { create, engine, fake, config } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    await engine.verdict(fake.paseo, item.id, "revise", "Rename the flag");
    engine.stop();
    tickMs(3_000);
    const timers = fakeTimers();
    const restarted = new Engine({
      now: () => new Date(clock),
      config: async () => config,
      log: () => {},
      client: () => fake.paseo,
      timer: timers.timer,
    });
    expect(await restarted.sweep()).toBe(false);
    expect(timers.live().map((timer) => timer.ms)).toEqual([UNDO_MS - 3_000]);
    tickMs(UNDO_MS - 3_000);
    await timers.fire();
    expect((await restarted.get(item.id)).item.state).toBe("running");
    expect(fake.sent.at(-1)?.text).toContain("Rename the flag");
  });

  test("with no client yet, an overdue approval waits instead of skipping its guard", async () => {
    const { create, engine, fake, config } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    await engine.verdict(fake.paseo, item.id, "approve", "");
    const other = await create();
    await endTurn(engine, fake, [], "agent-2");
    await engine.cancel(other.id);
    engine.stop();
    tickMs(UNDO_MS);
    let handle: Paseo | null = null;
    const restarted = new Engine({
      now: () => new Date(clock),
      config: async () => config,
      log: () => {},
      client: () => handle,
      timer: fakeTimers().timer,
    });
    // A cancel asks nothing of the session, so it applies; the approval must ask, so it waits.
    await restarted.sweep();
    expect((await restarted.get(other.id)).item.state).toBe("canceled");
    expect((await restarted.get(item.id)).item).toMatchObject({ state: "review", pending: { verdict: "approve" } });
    // The session started working again meanwhile: once a client exists, the guard sees it.
    const agent = fake.agents.get("agent-1");
    if (agent) agent.status = "running";
    handle = fake.paseo;
    await restarted.sweep();
    const { item: after, events } = await restarted.get(item.id);
    expect(after).toMatchObject({ state: "review", pending: null });
    expect(events.at(-1)).toMatchObject({ text: "Approve did not take effect" });
  });

  test("stopping the engine clears every timer it armed", async () => {
    const { create, engine, fake, timers } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    await engine.verdict(fake.paseo, item.id, "approve", "");
    expect(timers.live()).toHaveLength(1);
    engine.stop();
    expect(timers.live()).toHaveLength(0);
    // Nothing new is armed after the stop, even by a sweep.
    await engine.sweep(fake.paseo);
    expect(timers.live()).toHaveLength(0);
  });
});

describe("guards when a decision takes effect", () => {
  test("a question asked inside the window drops an approval, with the reason", async () => {
    const { create, engine, fake, timers } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    await engine.verdict(fake.paseo, item.id, "approve", "");
    await engine.onPermissionRequested({ id: "agent-1" }, { id: "p1", name: "Bash", input: { command: "ls" } });
    tickMs(UNDO_MS);
    await timers.fire();
    const { item: after, events } = await engine.get(item.id);
    expect(after).toMatchObject({ state: "review", pending: null, phase: "asking" });
    expect(events.at(-1)).toMatchObject({
      text: "Approve did not take effect",
      detail: "The agent is waiting on a question. Answer it first.",
    });
  });

  test("a session working again when the window closes drops the approval", async () => {
    const { create, engine, fake, timers } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    await engine.verdict(fake.paseo, item.id, "approve", "");
    const agent = fake.agents.get("agent-1");
    if (agent) agent.status = "running";
    tickMs(UNDO_MS);
    await timers.fire();
    const { item: after, events } = await engine.get(item.id);
    expect(after).toMatchObject({ state: "review", pending: null });
    expect(events.at(-1)).toMatchObject({
      text: "Approve did not take effect",
      detail: "The session is working again. Wait for it to stop, then decide.",
    });
  });

  test("work that moved on inside the window drops the decision", async () => {
    const { create, engine, fake, timers } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    await engine.verdict(fake.paseo, item.id, "revise", "More tests");
    await engine.onTurnStarted({ id: "agent-1" });
    tickMs(UNDO_MS);
    await timers.fire();
    const { item: after, events } = await engine.get(item.id);
    expect(after).toMatchObject({ state: "running", pending: null });
    expect(events.at(-1)).toMatchObject({
      text: "Send back did not take effect",
      detail: "It was no longer waiting on you.",
    });
    expect(fake.sent).toHaveLength(0);
  });

  test("a send back whose session record is gone is dropped, not sent to nobody", async () => {
    const { engine, fake, config, timers } = await setup();
    const dir = join(config.workRoot, "orphan");
    await mkdir(dir, { recursive: true });
    await Bun.write(
      join(dir, WORK_FILE),
      "---\nid: gate-orphan\nkind: task\nstate: review\ngate: human\ncreated: 2026-09-22\nupdated: 2026-09-22\n---\n\n# Orphan\n",
    );
    await expect(engine.verdict(fake.paseo, "gate-orphan", "revise", "again")).rejects.toThrow(
      "no session to send this back to",
    );
    // Cancel needs no session, and still applies.
    await engine.verdict(fake.paseo, "gate-orphan", "block", "");
    tickMs(UNDO_MS);
    await timers.fire();
    expect((await engine.get("gate-orphan")).item.state).toBe("canceled");
  });

  test("cancel applies while the agent asks: it needs no answer", async () => {
    const { create, engine, decide } = await setup();
    const item = await create();
    await engine.onPermissionRequested({ id: "agent-1" }, { id: "p1", name: "Bash", input: { command: "ls" } });
    expect((await decide(item.id, "block")).state).toBe("canceled");
  });
});

describe("concurrency cap", () => {
  test("at the cap a dispatch is refused and the work stays queued", async () => {
    const { create, engine, fake } = await setup({ concurrencyCap: 1 });
    await create();
    const queued = await create({ dispatch: false });
    await expect(engine.dispatch(fake.paseo, queued.id)).rejects.toThrow("At capacity: 1 running. It stays queued.");
    expect((await engine.get(queued.id)).item.state).toBe("proposed");
    expect(fake.created).toHaveLength(1);
    // A slot frees when the run lands at the gate.
    await endTurn(engine, fake);
    expect((await engine.dispatch(fake.paseo, queued.id)).state).toBe("running");
  });

  test("the default cap is 3; stuck work stays stuck at the cap", async () => {
    const { create, engine, fake } = await setup();
    const first = await create();
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "failed", error: { message: "boom" } }, []);
    await create();
    await create();
    await create();
    await expect(engine.dispatch(fake.paseo, first.id)).rejects.toThrow("At capacity: 3 running. It stays stuck.");
    expect((await engine.get(first.id)).item.state).toBe("blocked");
    await expect(create()).rejects.toThrow("At capacity: 3 running. It stays queued.");
  });

  test("no cap starts every dispatch", async () => {
    const { create } = await setup({ concurrencyCap: null });
    for (let n = 0; n < 5; n += 1) expect((await create()).state).toBe("running");
  });

  test("two dispatches at once cannot both take the last slot", async () => {
    const { create, engine, fake } = await setup({ concurrencyCap: 2 });
    await create();
    const a = await create({ dispatch: false });
    const b = await create({ dispatch: false });
    const results = await Promise.allSettled([engine.dispatch(fake.paseo, a.id), engine.dispatch(fake.paseo, b.id)]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(String(refused.reason)).toContain("At capacity: 2 running");
    expect(fake.created).toHaveLength(2);
  });
});

describe("archive on approve", () => {
  test("an approval archives the run's workspace; the branch stays", async () => {
    const { create, engine, fake, decide } = await setup({ archiveOnApprove: true });
    const item = await create();
    await endTurn(engine, fake);
    expect((await decide(item.id, "approve")).state).toBe("done");
    expect(fake.archivedWorkspaces).toEqual(["ws-1"]);
    const { events } = await engine.get(item.id);
    expect(events.at(-1)?.text).toBe(`Archived the workspace. The branch ${item.worker?.branch} stays.`);
  });

  test("off by default, and never on a send back or a cancel", async () => {
    const { create, engine, fake, decide, config } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    expect((await decide(item.id, "approve")).state).toBe("done");
    expect(fake.archivedWorkspaces).toEqual([]);
    config.archiveOnApprove = true;
    const other = await create();
    await endTurn(engine, fake, [], "agent-2");
    await decide(other.id, "revise", "again");
    await endTurn(engine, fake, [], "agent-2");
    await decide(other.id, "block");
    expect(fake.archivedWorkspaces).toEqual([]);
  });

  test("a failed archive is a receipt and the approval stands", async () => {
    const { create, engine, fake, decide } = await setup({ archiveOnApprove: true });
    const item = await create();
    await endTurn(engine, fake);
    fake.paseo.workspaces.archive = async () => {
      throw new Error("worktree has changes");
    };
    expect((await decide(item.id, "approve")).state).toBe("done");
    expect((await engine.get(item.id)).events.at(-1)?.text).toBe(
      "Could not archive the workspace: worktree has changes. The approval stands.",
    );

    // The daemon can also answer with an error instead of throwing.
    const other = await create();
    await endTurn(engine, fake, [], "agent-2");
    fake.paseo.workspaces.archive = (async (workspaceId: string) => ({
      requestId: "r",
      workspaceId,
      archivedAt: null,
      error: "busy",
    })) as typeof fake.paseo.workspaces.archive;
    expect((await decide(other.id, "approve")).state).toBe("done");
    expect((await engine.get(other.id)).events.at(-1)?.text).toBe(
      "Could not archive the workspace: busy. The approval stands.",
    );
  });

  test("a tracked session's workspace is yours and stays", async () => {
    const { engine, fake, repo, decide } = await setup({ archiveOnApprove: true });
    fake.agents.set("manual", {
      id: "manual",
      cwd: repo,
      status: "idle",
      workspaceId: "ws-mine",
      provider: "codex",
      title: "By hand",
      archivedAt: null,
      pendingPermissions: [],
      activeTurn: null,
    });
    const item = await engine.adopt(fake.paseo, "manual", "");
    expect((await decide(item.id, "approve")).state).toBe("done");
    expect(fake.archivedWorkspaces).toEqual([]);
    expect((await engine.get(item.id)).events.at(-1)?.text).toBe("Kept the workspace: Maestro did not create it.");
  });
});

describe("stop run", () => {
  test("stopping archives the session and leaves the work stuck with the reason", async () => {
    const { create, engine, fake } = await setup();
    const item = await create();
    const looksBefore = (await engine.list(fake.paseo)).scoreboard.looks;
    const stuck = await engine.stopRun(fake.paseo, item.id);
    expect(stuck).toMatchObject({ state: "blocked", reason: "You stopped the run" });
    expect(fake.archived).toEqual(["agent-1"]);
    // The worktree and its branch stay.
    expect(fake.archivedWorkspaces).toEqual([]);
    expect(stuck.worker?.branch).toBe(item.worker?.branch ?? "missing");
    expect((await engine.list(fake.paseo)).scoreboard.looks).toBe(looksBefore + 1);

    // What the archive sets off only adds receipts.
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "canceled", reason: "archived" }, []);
    await engine.onArchived({ id: "agent-1" });
    const { item: after, events } = await engine.get(item.id);
    expect(after).toMatchObject({ state: "blocked", reason: "You stopped the run" });
    expect(events.map((event) => event.text)).toContain("You stopped the run");

    // Unblock starts a fresh run: the session is gone.
    expect((await engine.unblock(fake.paseo, item.id, "")).state).toBe("running");
    expect(fake.created).toHaveLength(2);
  });

  test("stopped work can be canceled", async () => {
    const { create, engine, fake } = await setup();
    const item = await create();
    await engine.stopRun(fake.paseo, item.id);
    expect((await engine.cancel(item.id)).state).toBe("canceled");
  });

  test("only running work can be stopped", async () => {
    const { create, engine, fake } = await setup();
    const queued = await create({ dispatch: false });
    await expect(engine.stopRun(fake.paseo, queued.id)).rejects.toThrow("Only running work can be stopped.");
    const item = await create();
    await endTurn(engine, fake);
    await expect(engine.stopRun(fake.paseo, item.id)).rejects.toThrow("Only running work can be stopped.");
    expect(fake.archived).toEqual([]);
  });

  test("a failed archive puts the run back and says why", async () => {
    const { create, engine, fake } = await setup();
    const item = await create();
    const ref = fake.paseo.agents.ref;
    fake.paseo.agents.ref = ((id: string) => ({
      ...ref(id),
      archive: async () => {
        throw new Error("daemon busy");
      },
    })) as unknown as typeof ref;
    await expect(engine.stopRun(fake.paseo, item.id)).rejects.toThrow("Could not stop the session: daemon busy");
    const { item: after, events } = await engine.get(item.id);
    expect(after.state).toBe("running");
    expect(events.at(-1)).toMatchObject({ text: "Running", detail: "Could not stop the session: daemon busy" });
  });

  test("a run with no session recorded stops without archiving anything", async () => {
    const { engine, fake, config } = await setup();
    const dir = join(config.workRoot, "orphan");
    await mkdir(dir, { recursive: true });
    await Bun.write(
      join(dir, WORK_FILE),
      "---\nid: stop-orphan\nkind: task\nstate: running\ngate: human\ncreated: 2026-09-22\nupdated: 2026-09-22\n---\n\n# Orphan\n",
    );
    expect(await engine.stopRun(fake.paseo, "stop-orphan")).toMatchObject({
      state: "blocked",
      reason: "You stopped the run",
    });
    expect(fake.archived).toEqual([]);
  });
});

describe("races around a decision and a stop", () => {
  test("an undo that lands while the decision is being applied wins", async () => {
    const { create, engine, fake, timers } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    await engine.verdict(fake.paseo, item.id, "approve", "");
    // Hold the apply open while it asks the session whether it is working again.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let asking!: () => void;
    const asked = new Promise<void>((resolve) => {
      asking = resolve;
    });
    const ref = fake.paseo.agents.ref;
    fake.paseo.agents.ref = ((id: string) => ({
      ...ref(id),
      refresh: async () => {
        asking();
        await held;
        return ref(id).refresh();
      },
    })) as unknown as typeof ref;
    tickMs(UNDO_MS);
    const applying = timers.fire();
    await asked;
    await engine.undo(item.id);
    release();
    await applying;
    const { item: after, events } = await engine.get(item.id);
    expect(after).toMatchObject({ state: "review", pending: null });
    expect(events.map((event) => event.text)).not.toContain("You approved");
  });

  test("the list applies a decision whose timer never ran", async () => {
    const { create, engine, fake, config } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    await engine.verdict(fake.paseo, item.id, "approve", "");
    engine.stop();
    tickMs(UNDO_MS);
    const restarted = new Engine({ now: () => new Date(clock), config: async () => config, log: () => {} });
    const { items } = await restarted.list(fake.paseo);
    expect(items.find((entry) => entry.id === item.id)).toMatchObject({ state: "done", pending: null });
  });

  test("a run with no session recorded restarts in its own slot", async () => {
    const { engine, fake, config } = await setup({ concurrencyCap: 1 });
    const dir = join(config.workRoot, "orphan");
    await mkdir(dir, { recursive: true });
    await Bun.write(
      join(dir, WORK_FILE),
      `---\nid: cap-orphan\nkind: task\nstate: running\ngate: human\nrepo: ${join(config.workRoot, "..", "repo")}\ncreated: 2026-09-22\nupdated: 2026-09-22\n---\n\n# Orphan\n`,
    );
    expect((await engine.dispatch(fake.paseo, "cap-orphan")).worker?.agentId).toBe("agent-1");
  });

  test("hooks the archive sets off before it returns leave the reason as yours", async () => {
    const { create, engine, fake } = await setup();
    const item = await create();
    const ref = fake.paseo.agents.ref;
    fake.paseo.agents.ref = ((id: string) => ({
      ...ref(id),
      archive: async () => {
        await engine.onTurnEnded({ id }, { kind: "canceled", reason: "archived" }, [], "t9");
        await engine.onArchived({ id });
        return ref(id).archive();
      },
    })) as unknown as typeof ref;
    expect(await engine.stopRun(fake.paseo, item.id)).toMatchObject({
      state: "blocked",
      reason: "You stopped the run",
    });
    const { events } = await engine.get(item.id);
    expect(events.slice(-3).map((event) => event.text)).toEqual([
      "You stopped the run",
      "Turn stopped",
      "The session was archived",
    ]);
  });
});
