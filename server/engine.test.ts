import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { MaestroConfig } from "../shared/contracts";
import { Engine, MODED_BY_YOU } from "./engine";
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

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(overrides: Partial<MaestroConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), "maestro-engine-"));
  roots.push(root);
  const repo = join(root, "repo");
  // A git repository as far as Maestro checks: runs branch a worktree from it.
  await mkdir(join(repo, ".git"), { recursive: true });
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
    const { create, engine, fake } = await setup();
    const item = await create({ check: "sleep 0.2" });
    const idle = fake.agents.get("agent-1");
    if (idle) idle.status = "idle";
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "completed" }, [], "turn-1");
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "completed" }, [], "turn-1");
    await settle(engine, item.id, "review");
    expect((await engine.get(item.id)).events.filter((e) => e.type === "checks.started")).toHaveLength(1);
    // The session reopened and numbers its turns from 1 again.
    await engine.verdict(fake.paseo, item.id, "revise", "one more thing");
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

describe("the composer's choices", () => {
  const draft = (repo: string) => ({
    brief: "Store the transcript on each run.\n\nDone when the detail pane renders it.",
    repo,
    gate: "human" as const,
    check: "",
    initiative: "",
    dispatch: false,
  });

  test("a blank title takes the brief's first line; the brief stays whole", async () => {
    const { engine, fake, repo } = await setup();
    const item = await engine.create(fake.paseo, { ...draft(repo), title: "  " });
    expect(item.title).toBe("Store the transcript on each run.");
    expect(item.path).toBe("store-the-transcript-on-each-run");
    expect((await engine.get(item.id)).brief).toBe(
      "Store the transcript on each run.\n\nDone when the detail pane renders it.",
    );
    const untitled = await engine.create(fake.paseo, draft(repo));
    expect(untitled.title).toBe("Store the transcript on each run.");
  });

  test("no brief and no title is refused before anything is written", async () => {
    const { engine, fake, repo, config } = await setup();
    await expect(engine.create(fake.paseo, { ...draft(repo), title: "", brief: " \n " })).rejects.toThrow(
      "Write a brief, or at least a title",
    );
    expect((await new WorkStore(config.workRoot).scan()).items).toHaveLength(0);
  });

  test("a dispatch starts the agent the way the work chose, over Settings", async () => {
    const { engine, fake, repo, config } = await setup({ modeId: "bypassPermissions", isolation: "worktree" });
    const item = await engine.create(fake.paseo, {
      ...draft(repo),
      title: "Chosen",
      provider: "codex/gpt-5.5",
      isolation: "directory",
      modeId: "full-access",
      thinkingOptionId: "high",
      featureValues: { fast: true, plan: false },
      dispatch: true,
    });
    const options = fake.created[0] as { config: Record<string, unknown> };
    expect(options.config).toEqual({
      provider: "codex/gpt-5.5",
      modeId: "full-access",
      thinkingOptionId: "high",
      featureValues: { fast: true, plan: false },
    });
    expect(item.worker).toMatchObject({ provider: "codex/gpt-5.5", branch: null, cwd: repo });
    const file = await readFile(join(config.workRoot, item.path, WORK_FILE), "utf8");
    expect(file).toContain("isolation: directory");
    expect(file).toContain("mode: full-access");
  });

  test("what the work did not choose comes from Settings at dispatch time", async () => {
    const { engine, fake, repo, config } = await setup();
    const item = await engine.create(fake.paseo, { ...draft(repo), title: "Defaults", thinkingOptionId: "low" });
    // Before Dispatch, the Queued card shows only what the work itself chose.
    expect(item.run).toEqual({ thinkingOptionId: "low" });
    config.modeId = "bypassPermissions";
    config.isolation = "worktree";
    const running = await engine.dispatch(fake.paseo, item.id);
    const options = fake.created[0] as { config: Record<string, unknown> };
    expect(options.config).toEqual({ provider: "claude/sonnet", modeId: "bypassPermissions", thinkingOptionId: "low" });
    expect(running.worker?.branch).toMatch(/^run\//);
    // The receipt records the mode the agent really got, wherever it came from.
    expect(running.worker).toMatchObject({ modeId: "bypassPermissions", thinkingOptionId: "low", featureValues: null });
  });

  test("a Settings mode belongs to the Settings provider; work on another provider does not inherit it", async () => {
    const { engine, fake, repo } = await setup({ provider: "claude", modeId: "bypassPermissions" });
    await engine.create(fake.paseo, { ...draft(repo), title: "Codex", provider: "codex/gpt-5.5", dispatch: true });
    await engine.create(fake.paseo, { ...draft(repo), title: "Opus", provider: "claude/opus", dispatch: true });
    const configs = fake.created.map((options) => (options as { config: Record<string, unknown> }).config);
    expect(configs).toEqual([{ provider: "codex/gpt-5.5" }, { provider: "claude/opus", modeId: "bypassPermissions" }]);
  });

  test("work a session creates carries none of the run choices: how runs start stays yours", async () => {
    const { engine, fake, repo, config } = await setup();
    const item = await engine.create(
      fake.paseo,
      {
        ...draft(repo),
        title: "From a session",
        provider: "codex/gpt-5.5",
        isolation: "directory",
        modeId: "bypassPermissions",
        thinkingOptionId: "max",
        featureValues: { fast: true },
        dispatch: true,
      },
      { actor: "agent", by: "session-1" },
    );
    const file = await readFile(join(config.workRoot, item.path, WORK_FILE), "utf8");
    for (const key of ["provider:", "isolation:", "mode:", "thinking:", "features:"]) expect(file).not.toContain(key);
    const options = fake.created[0] as { config: Record<string, unknown> };
    expect(options.config).toEqual({ provider: "claude/sonnet" });
    expect(item.worker?.branch).toMatch(/^run\//);
  });
});

describe("a mode you chose is yours to use", () => {
  const moded = (repo: string) => ({
    title: "Moded",
    brief: "Trim the cache.",
    repo,
    gate: "human" as const,
    check: "",
    initiative: "",
    dispatch: false,
    modeId: "bypassPermissions",
    thinkingOptionId: "high",
    featureValues: { fast_mode: true },
  });
  const session = { actor: "agent" as const, by: "session-1" };

  test("a session cannot start work that carries a mode you chose; nothing starts", async () => {
    const { engine, fake, repo } = await setup();
    const item = await engine.create(fake.paseo, moded(repo));
    await expect(engine.dispatch(fake.paseo, item.id, session)).rejects.toThrow(MODED_BY_YOU);
    expect(fake.created).toHaveLength(0);
    expect((await engine.get(item.id)).item.state).toBe("proposed");
  });

  test("you start it, and the receipt says how it was started", async () => {
    const { engine, fake, repo } = await setup();
    const item = await engine.create(fake.paseo, moded(repo));
    const running = await engine.dispatch(fake.paseo, item.id);
    expect(running.state).toBe("running");
    expect(running.worker).toMatchObject({
      provider: "claude/sonnet",
      modeId: "bypassPermissions",
      thinkingOptionId: "high",
      featureValues: { fast_mode: true },
      startedWith: "claude/sonnet (mode bypassPermissions, thinking high, fast_mode on)",
    });
    const receipt = (await engine.get(item.id)).events.find((event) => event.type === "dispatched");
    expect(receipt?.detail).toStartWith("claude/sonnet (mode bypassPermissions, thinking high, fast_mode on) on run/");
  });

  test("a session still starts queued work that has no mode of its own", async () => {
    const { engine, fake, repo } = await setup({ modeId: "acceptEdits" });
    const item = await engine.create(fake.paseo, { ...moded(repo), modeId: undefined });
    const running = await engine.dispatch(fake.paseo, item.id, session);
    expect(running.worker?.modeId).toBe("acceptEdits");
  });
});

describe("where runs may start", () => {
  const plain = (repo: string) => ({
    title: "Where",
    brief: "",
    repo,
    gate: "human" as const,
    check: "",
    initiative: "",
    dispatch: false,
  });

  test("never the work folder, a folder holding it, or one inside it; nothing is written", async () => {
    const { engine, fake, config } = await setup();
    const inside = join(config.workRoot, "repo-in-work");
    await mkdir(join(inside, ".git"), { recursive: true });
    const holder = join(config.workRoot, "..");
    await mkdir(join(holder, ".git"), { recursive: true });
    await expect(engine.create(fake.paseo, plain(config.workRoot))).rejects.toThrow("holds the work folder");
    await expect(engine.create(fake.paseo, plain(holder))).rejects.toThrow("holds the work folder");
    await expect(engine.create(fake.paseo, plain(inside))).rejects.toThrow("inside the work folder");
    expect((await new WorkStore(config.workRoot).scan()).items).toHaveLength(0);
  });

  test("a symlink to the folder holding the work folder is the same folder", async () => {
    const { engine, fake, config } = await setup();
    const holder = join(config.workRoot, "..");
    await mkdir(join(holder, ".git"), { recursive: true });
    const link = join(holder, "alias");
    await symlink(holder, link);
    await expect(engine.create(fake.paseo, plain(link))).rejects.toThrow("holds the work folder");
  });

  test("never your home folder", async () => {
    const { engine, fake } = await setup();
    await expect(engine.create(fake.paseo, plain(homedir()))).rejects.toThrow("home folder");
    await expect(engine.create(fake.paseo, plain("~"))).rejects.toThrow("home folder");
  });

  test("a new worktree per run needs a git repository; running in the folder itself does not", async () => {
    const { engine, fake, config } = await setup();
    const folder = join(config.workRoot, "..", "plain");
    await mkdir(folder);
    await expect(engine.create(fake.paseo, plain(folder))).rejects.toThrow("is not a git repository");
    const item = await engine.create(fake.paseo, { ...plain(folder), isolation: "directory", dispatch: true });
    expect(item.worker).toMatchObject({ branch: null, cwd: folder });
  });

  test("Settings isolation decides for work that did not choose", async () => {
    const { engine, fake, config } = await setup({ isolation: "directory" });
    const folder = join(config.workRoot, "..", "plain");
    await mkdir(folder);
    expect((await engine.create(fake.paseo, plain(folder))).state).toBe("proposed");
    await expect(engine.create(fake.paseo, { ...plain(folder), isolation: "worktree" })).rejects.toThrow(
      "is not a git repository",
    );
  });
});

describe("every run passes the folder check, whichever verb starts it", () => {
  /** Paseo refuses to start anything, and says where it was asked to: nothing reaches a real folder. */
  function recordStarts(fake: ReturnType<typeof fakePaseo>) {
    const attempted: string[] = [];
    fake.paseo.workspaces.create = (async (options: { source: { cwd: string } }) => {
      attempted.push(options.source.cwd);
      throw new Error("a run would have started");
    }) as unknown as typeof fake.paseo.workspaces.create;
    fake.paseo.workspaces.open = (async (cwd: unknown) => {
      attempted.push(String(cwd));
      throw new Error("a run would have started");
    }) as unknown as typeof fake.paseo.workspaces.open;
    return attempted;
  }
  const draft = (repo: string) => ({
    title: "Guarded",
    brief: "",
    repo,
    gate: "human" as const,
    check: "",
    initiative: "",
    dispatch: false,
  });

  test("dispatch: a _work.md hand-edited to your home folder is refused, and the receipt says why", async () => {
    const { engine, fake, repo, config } = await setup();
    // A bare `~` is YAML's null (no repo at all); these are the spellings that name home.
    for (const spelling of ['"~"', "~/"]) {
      const item = await engine.create(fake.paseo, { ...draft(repo), title: `Home ${spelling}` });
      const file = join(config.workRoot, item.path, WORK_FILE);
      await writeFile(file, (await readFile(file, "utf8")).replace(`repo: ${repo}`, `repo: ${spelling}`));
      const attempted = recordStarts(fake);
      await expect(engine.dispatch(fake.paseo, item.id)).rejects.toThrow(
        "This work's folder is your home folder; set a repository to run it in.",
      );
      expect(attempted).toEqual([]);
      const after = await engine.get(item.id);
      expect(after.item.state).toBe("proposed");
      expect(after.events.at(-1)?.text).toContain("your home folder");
    }
  });

  test("adopt: tracking a session in your home folder is allowed; restarting it there is not", async () => {
    const { engine, fake } = await setup();
    fake.agents.set("manual", {
      id: "manual",
      cwd: homedir(),
      status: "running",
      workspaceId: "ws-x",
      provider: "claude",
      title: "Tidy the dotfiles",
      archivedAt: null,
      pendingPermissions: [],
      activeTurn: null,
    });
    const item = await engine.adopt(fake.paseo, "manual", "");
    expect(item).toMatchObject({ state: "running", repo: homedir() });
    await engine.onArchived({ id: "manual" });
    const agent = fake.agents.get("manual");
    if (agent) agent.archivedAt = new Date().toISOString();
    expect((await engine.get(item.id)).item.state).toBe("blocked");
    const attempted = recordStarts(fake);
    await expect(engine.unblock(fake.paseo, item.id, "")).rejects.toThrow(
      "This work's folder is your home folder; set a repository to run it in.",
    );
    expect(attempted).toEqual([]);
    expect((await engine.get(item.id)).item.state).toBe("blocked");
  });

  test("dispatch: a folder that is not a git repository under worktree isolation is refused at dispatch time", async () => {
    const { engine, fake, config } = await setup({ isolation: "directory" });
    const folder = join(config.workRoot, "..", "plain");
    await mkdir(folder);
    const item = await engine.create(fake.paseo, draft(folder));
    config.isolation = "worktree";
    const attempted = recordStarts(fake);
    await expect(engine.dispatch(fake.paseo, item.id)).rejects.toThrow(
      "This work's folder is not a git repository, and each run gets a new worktree",
    );
    expect(attempted).toEqual([]);
    config.isolation = "directory";
    await expect(engine.dispatch(fake.paseo, item.id)).rejects.toThrow("a run would have started");
    expect(attempted).toEqual([folder]);
    // The work's own isolation, hand-edited, is what the check reads; Settings still says directory.
    const own = await engine.create(fake.paseo, { ...draft(folder), title: "Own worktree" });
    const file = join(config.workRoot, own.path, WORK_FILE);
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace(`repo: ${folder}`, `repo: ${folder}\nisolation: worktree`),
    );
    await expect(engine.dispatch(fake.paseo, own.id)).rejects.toThrow("is not a git repository");
    expect(attempted).toEqual([folder]);
  });

  test("dispatch: a folder moved into the work folder, or holding it, is refused", async () => {
    const { engine, fake, repo, config } = await setup();
    const inside = await engine.create(fake.paseo, { ...draft(repo), title: "Inside" });
    const holding = await engine.create(fake.paseo, { ...draft(repo), title: "Holding" });
    const nested = join(config.workRoot, "nested-repo");
    await mkdir(join(nested, ".git"), { recursive: true });
    const holder = join(config.workRoot, "..");
    for (const [item, target] of [
      [inside, nested],
      [holding, holder],
    ] as const) {
      const file = join(config.workRoot, item.path, WORK_FILE);
      await writeFile(file, (await readFile(file, "utf8")).replace(`repo: ${repo}`, `repo: ${target}`));
    }
    const attempted = recordStarts(fake);
    await expect(engine.dispatch(fake.paseo, inside.id)).rejects.toThrow("is inside the work folder");
    await expect(engine.dispatch(fake.paseo, holding.id)).rejects.toThrow("holds the work folder");
    expect(attempted).toEqual([]);
  });
});
