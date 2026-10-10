import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { MaestroConfig } from "../shared/contracts";
import { nextRunCopy } from "../shared/run";
import type { Verdict } from "../shared/states";
import { NAME_RETRY_MS } from "./adopter-names";
import { defaultConfig } from "./config";
import {
  CHECKING,
  CLIENT_WAIT_MS,
  Engine,
  type EngineOptions,
  MODED_BY_YOU,
  NOT_STOPPABLE,
  RUN_WENT_ON,
  STOP_BEFORE_CANCEL,
  STOPPED,
  type Timer,
  UNDO_MS,
} from "./engine";
import { ARCHIVED_NOTE } from "./events";
import { fakePaseo } from "./fake-paseo";
import type { Paseo } from "./runs";
import { EVENTS_FILE, WORK_FILE, WorkStore } from "./store";
import { gitEnv } from "./worktree";

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

/** git for fixtures, with none of this machine's config (no signing, no hooks). */
function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync(["git", "-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
    env: gitEnv() as Record<string, string>,
  });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString();
}

/**
 * Makes a run's folder what Paseo makes it: a worktree of the work's repository
 * on the run's branch, with nothing uncommitted. The repository gets one commit
 * the first time.
 */
function cleanWorktree(repo: string, worker: { cwd: string | null; branch: string | null } | null | undefined): string {
  if (!worker?.cwd || !worker.branch) throw new Error("the run has no worktree");
  // setup() marks the repository with a bare .git folder; a real one has a HEAD.
  if (!existsSync(join(repo, ".git", "HEAD"))) {
    git(repo, "init", "-q");
    writeFileSync(join(repo, "a.txt"), "hello\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", "init");
  }
  git(repo, "worktree", "add", "-q", "-b", worker.branch, worker.cwd);
  return worker.cwd;
}

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

async function setup(overrides: Partial<MaestroConfig> = {}, options: Partial<EngineOptions> = {}) {
  // Real path: the repository's path may not pass through a link, and macOS's tmpdir does (/var).
  const root = await realpath(await mkdtemp(join(tmpdir(), "maestro-engine-")));
  roots.push(root);
  const repo = join(root, "repo");
  // A git repository as far as Maestro checks: runs branch a worktree from it.
  await mkdir(join(repo, ".git"), { recursive: true });
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
    claimWaitMs: 200,
    git: async () => ({ branch: null, githubRepo: null }),
    merged: async () => null,
    ...options,
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

/** For tests of what a stop does to the work's state, not to its worktree: discarding skips the worktree check. */
const DISCARD = { discard: true } as const;

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

  test("a dispatch labels its agent with the ticket its title names (BRO-2908)", async () => {
    const { engine, fake, repo } = await setup();
    await engine.create(fake.paseo, {
      title: "BRO-2908 Persist run transcripts",
      brief: "Store it on the Run record.",
      repo,
      gate: "human",
      check: "",
      initiative: "hawthorne",
      dispatch: true,
    });
    const options = fake.created[0] as { labels: Record<string, string> };
    expect(options.labels.ticket).toBe("BRO-2908");
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
      arc: null,
      closing: null,
      archived: false,
      handed: null,
    });
  });

  test("approve closes it; the file and the log both say so", async () => {
    const { create, engine, config, fake, decide } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    const done = await decide(item.id, "approve");
    expect(done.state).toBe("done");
    expect(done.verdict).toBe("You approved");
    // Yours: the feed lists it under Done, never under Handled for you (BRO-2906).
    expect(done.closed?.by).toBe("you");
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
    expect(done.closed?.by).toBe("maestro");
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
    await engine.upkeep(fake.paseo);
    expect((await engine.get(item.id)).item.state).toBe("running");
    tick(5);
    await engine.upkeep(fake.paseo);
    const { items } = await engine.list(fake.paseo);
    expect(items[0]?.state).toBe("review");
  });

  test("a vanished session is stuck, not silently running forever", async () => {
    const { create, engine, fake } = await setup();
    const item = await create();
    fake.agents.delete("agent-1");
    tick(1);
    await engine.upkeep(fake.paseo);
    expect((await engine.get(item.id)).item).toMatchObject({
      state: "blocked",
      reason: "The session ended before the run finished",
    });
  });

  const idleSession = (repo: string) => ({
    id: "manual",
    cwd: repo,
    status: "idle" as const,
    workspaceId: "ws-x",
    provider: "codex",
    title: "Fix the flaky test",
    archivedAt: null,
    pendingPermissions: [],
    activeTurn: null,
  });
  const said = (text: string) => [{ type: "assistant_message", text }];

  test("adopting an idle session puts it at the gate", async () => {
    const { engine, fake, repo } = await setup();
    fake.agents.set("manual", idleSession(repo));
    fake.timelines.set("manual", said("Fixed it; the tests pass."));
    const item = await engine.adopt(fake.paseo, "manual", "");
    expect(item).toMatchObject({ state: "review", title: "Fix the flaky test" });
    expect((await engine.adopt(fake.paseo, "manual", "")).id).toBe(item.id);
    expect((await engine.forAgent("manual"))?.id).toBe(item.id);
  });

  const BY_ORCHESTRATOR = { actor: "agent" as const, by: "orchestrator" };

  test("an orchestrator adopting an idle arc whose last turn handed you something puts it at the gate", async () => {
    const { engine, fake, repo } = await setup();
    fake.agents.set("manual", idleSession(repo));
    fake.timelines.set("manual", said("Fixed it.\n\n## Ask\n- Merge #12?"));
    const item = await engine.adopt(fake.paseo, "manual", "", BY_ORCHESTRATOR);
    expect(item).toMatchObject({ state: "review", title: "Fix the flaky test" });
    expect(item.look?.ask).toBe("Merge #12?");
    const landed = (await engine.get(item.id)).events.findLast((e) => e.type === "state");
    expect(landed).toMatchObject({ text: "Waiting on you", detail: "The session was idle when tracked" });
    expect((await engine.adopt(fake.paseo, "manual", "")).id).toBe(item.id);
    expect((await engine.forAgent("manual"))?.id).toBe(item.id);
  });

  test("the list names an adopter by its session title once read, never its id, and never waits for it (BRO-2938)", async () => {
    const { engine, fake, repo } = await setup();
    fake.agents.set("manual", idleSession(repo));
    fake.timelines.set("manual", said("Fixed it.\n\n## Ask\n- Merge #12?"));
    fake.agents.set("orchestrator", { ...idleSession(repo), id: "orchestrator", title: "SRI Orchestrator" });
    const item = await engine.adopt(fake.paseo, "manual", "", BY_ORCHESTRATOR);
    const listed = async (paseo?: typeof fake.paseo) =>
      (await engine.list(paseo)).items.find((entry) => entry.id === item.id)?.adoptedBy;
    // The first list answers before the read lands: nothing, not the id.
    expect(await listed(fake.paseo)).toEqual({ by: null });
    await engine.adoptersSettled();
    expect(await listed(fake.paseo)).toEqual({ by: "SRI Orchestrator" });
    // Known: a list without the daemon still names it.
    expect(await listed()).toEqual({ by: "SRI Orchestrator" });
  });

  test("a daemon that never answers a name read is given up on after the claim wait, and asked again (BRO-2938)", async () => {
    const { engine, fake, repo } = await setup({}, { claimWaitMs: 20 });
    fake.agents.set("manual", idleSession(repo));
    fake.timelines.set("manual", said("Fixed it.\n\n## Ask\n- Merge #12?"));
    await engine.adopt(fake.paseo, "manual", "", BY_ORCHESTRATOR);
    const ref = fake.paseo.agents.ref;
    let reads = 0;
    fake.paseo.agents.ref = (id: string) =>
      id === "orchestrator"
        ? {
            ...ref(id),
            refresh: () => {
              reads++;
              return new Promise<never>(() => {});
            },
          }
        : ref(id);
    await engine.list(fake.paseo);
    // Bounded: the hung read is let go, so the id is not stuck behind it.
    await engine.adoptersSettled();
    tickMs(NAME_RETRY_MS);
    await engine.list(fake.paseo);
    await engine.adoptersSettled();
    expect(reads).toBe(2);
  });

  test("an adoption records its lineage and labels the session with it: its work, ticket and parent (BRO-2908)", async () => {
    const labelled: [string, Record<string, string>][] = [];
    const { engine, fake, repo } = await setup({}, { label: async (id, labels) => void labelled.push([id, labels]) });
    fake.agents.set("orchestrator", { ...idleSession(repo), id: "orchestrator", title: "SRI Orchestrator" });
    fake.timelines.set("orchestrator", said("Working."));
    const parent = await engine.adopt(fake.paseo, "orchestrator", "SRI Orchestrator");
    fake.agents.set("manual", idleSession(repo));
    fake.timelines.set("manual", said("Fixed it.\n\n## Ask\n- Merge #12?"));
    const child = await engine.adopt(fake.paseo, "manual", "STI-3508 Enroll the identity", BY_ORCHESTRATOR, {});
    expect([child.parentWork, child.ticket, parent.parentWork, parent.ticket]).toEqual([
      parent.id,
      "STI-3508",
      null,
      null,
    ]);
    await engine.labelsSettled();
    expect(labelled.at(-1)).toEqual([
      "manual",
      { "maestro.work": child.id, ticket: "STI-3508", "maestro.parent-work": parent.id },
    ]);
    // A ticket given to the verb wins over the title's.
    fake.agents.set("other", { ...idleSession(repo), id: "other", title: "BRO-1 old" });
    fake.timelines.set("other", said("Done."));
    expect((await engine.adopt(fake.paseo, "other", "", undefined, { ticket: "BRO-2908" })).ticket).toBe("BRO-2908");
  });

  test("reconcile labels a tracked session that lacks its work label: once, with a backoff after a failure (BRO-2908)", async () => {
    let fail = true;
    const calls: string[] = [];
    const { create, engine, fake } = await setup(
      {},
      {
        label: async (id) => {
          calls.push(id);
          if (fail) throw new Error("daemon busy");
        },
      },
    );
    await create();
    const list = async (seconds: number) => {
      tickMs(seconds * 1000);
      await engine.upkeep(fake.paseo);
      await engine.labelsSettled();
      return calls.length;
    };
    // First failure: asked again a minute later, not sooner; second: two minutes later.
    expect([await list(60), await list(30), await list(30), await list(90), await list(30)]).toEqual([1, 1, 2, 2, 3]);
    // Set: not asked again while it stays set; asked again once ten minutes pass and it is still missing.
    fail = false;
    expect([await list(240), await list(60), await list(9 * 60)]).toEqual([4, 4, 5]);
  });

  test("a session's own ticket label wins and is never overwritten; a closed or archived session is not labelled (BRO-2908)", async () => {
    const labelled: [string, Record<string, string>][] = [];
    const { engine, fake, repo } = await setup({}, { label: async (id, labels) => void labelled.push([id, labels]) });
    fake.agents.set("manual", { ...idleSession(repo), labels: { ticket: "STI-77" } });
    fake.timelines.set("manual", said("Done."));
    const item = await engine.adopt(fake.paseo, "manual", "BRO-1 something", BY_ORCHESTRATOR);
    await engine.labelsSettled();
    expect(item.ticket).toBe("STI-77");
    expect(labelled.at(-1)).toEqual(["manual", { "maestro.work": item.id }]);
    // Two sessions, each lacking its work label: one archived but not closed, one closed but not archived.
    const before = labelled.length;
    for (const change of [{ archivedAt: new Date(clock).toISOString() }, { status: "closed" as const }]) {
      const fresh = await setup({}, { label: async (id, labels) => void labelled.push([`fresh:${id}`, labels]) });
      await fresh.create();
      const agent = fresh.fake.agents.get("agent-1");
      if (agent) Object.assign(agent, change);
      tick(1);
      await fresh.engine.upkeep(fresh.fake.paseo);
      await fresh.engine.labelsSettled();
    }
    expect(labelled.slice(before)).toEqual([]);
  });

  test("after failures, a success resets the backoff; a labeller that throws stops nothing after it (BRO-2908)", async () => {
    let mode: "fail" | "ok" | "throw" = "fail";
    const calls: string[] = [];
    const { create, engine, fake } = await setup(
      {},
      {
        label: ((id: string) => {
          calls.push(id);
          if (mode === "throw") throw new Error("sync throw");
          return mode === "fail" ? Promise.reject(new Error("busy")) : Promise.resolve();
        }) as never,
      },
    );
    await create();
    const list = async (seconds: number) => {
      tickMs(seconds * 1000);
      await engine.upkeep(fake.paseo);
      await engine.labelsSettled();
      return calls.length;
    };
    // Three failures (1, 2, 4 minutes apart), then a success: the next ask is ten minutes after it, not four.
    expect([await list(60), await list(60), await list(120), await list(200)]).toEqual([1, 2, 3, 3]);
    mode = "ok";
    expect([await list(40), await list(240), await list(360)]).toEqual([4, 4, 5]);
    // A labeller that throws outright: logged like a failure, and the next call still runs.
    mode = "throw";
    expect(await list(600)).toBe(6);
    mode = "ok";
    expect(await list(60)).toBe(7);
  });

  test("a session with a label call in flight is not asked again until it settles (BRO-2908)", async () => {
    let release: () => void = () => {};
    const calls: string[] = [];
    const { create, engine, fake } = await setup(
      {},
      {
        label: (id) => {
          calls.push(id);
          return calls.length === 1 ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
        },
      },
    );
    await create();
    tick(1);
    await engine.upkeep(fake.paseo);
    // Long past any wait while the first call hangs: nothing more is queued for it.
    tick(30);
    await engine.upkeep(fake.paseo);
    release();
    await engine.labelsSettled();
    expect(calls).toEqual(["agent-1"]);
  });

  test("a dispatched work's ticket is read from its title when no adoption gave one (BRO-2908)", async () => {
    const { engine, fake, repo } = await setup();
    const item = await engine.create(fake.paseo, {
      title: "BRO-12 Persist run transcripts",
      brief: "x",
      repo,
      gate: "human",
      check: "",
      initiative: "hawthorne",
      dispatch: false,
    });
    expect([item.ticket, item.parentWork]).toEqual(["BRO-12", null]);
  });

  test("a parent is an open work, never the session itself or a finished one; a ticket that is not one is refused (BRO-2908)", async () => {
    const { engine, fake, repo, decide } = await setup({}, { label: async () => undefined });
    fake.agents.set("orchestrator", { ...idleSession(repo), id: "orchestrator", title: "SRI Orchestrator" });
    fake.timelines.set("orchestrator", said("Planned the arcs.\n\n## Ask\n- Start them?"));
    const self = await engine.adopt(fake.paseo, "orchestrator", "", { actor: "agent", by: "orchestrator" });
    expect(self.parentWork).toBeNull();
    await expect(
      engine.adopt(fake.paseo, "manual", "", BY_ORCHESTRATOR, { ticket: "X,maestro.work=other" }),
    ).rejects.toThrow("A ticket is a team key and a number");
    // The orchestrator's own work finished: a child it adopts after has no parent.
    expect((await decide(self.id, "approve")).state).toBe("done");
    fake.agents.set("manual", idleSession(repo));
    fake.timelines.set("manual", said("Done."));
    expect((await engine.adopt(fake.paseo, "manual", "", BY_ORCHESTRATOR)).parentWork).toBeNull();
  });

  test("an orchestrator adopting an idle arc between steps keeps it running; one it cannot read too", async () => {
    const { engine, fake, repo } = await setup();
    fake.agents.set("manual", idleSession(repo));
    fake.timelines.set("manual", said("Waiting on the background test run, then the approval route."));
    const between = await engine.adopt(fake.paseo, "manual", "", BY_ORCHESTRATOR);
    expect(between.state).toBe("running");
    expect((await engine.get(between.id)).events.filter((e) => e.type === "turn.ended")).toHaveLength(1);
    fake.agents.set("other", { ...idleSession(repo), id: "other" });
    const original = fake.paseo.agents.ref;
    fake.paseo.agents.ref = (id: string) => {
      const ref = original(id);
      return id === "other"
        ? { ...ref, timeline: { ...ref.timeline, refetch: () => Promise.reject(new Error("not loaded")) } }
        : ref;
    };
    expect((await engine.adopt(fake.paseo, "other", "", BY_ORCHESTRATOR)).state).toBe("running");
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
    await engine.upkeep(fake.paseo);
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
    await engine.upkeep(fake.paseo);
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
    await engine.upkeep(fake.paseo);
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
    await engine.upkeep(fake.paseo);
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
  await engine.upkeep(fake.paseo);
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
    await engine.upkeep(fake.paseo);
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
    await engine.upkeep(fake.paseo);
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
    await engine.upkeep(fake.paseo);
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
  test("a decision is recorded when you make it and takes effect 8s later", async () => {
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
    expect(events.slice(-2).map((event) => event.text)).toEqual(["You approved", "Took effect"]);
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
    await engine.upkeep(fake.paseo);
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
      detail: "The run went on after you decided.",
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

  test("cancel is refused while the agent asks, when made or when it comes due: no session is left waiting", async () => {
    const { create, engine, fake, timers, decide } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    // Made at the gate, before it asked: dropped when it comes due, and the work stays at the gate.
    await engine.verdict(fake.paseo, item.id, "block", "");
    await engine.onPermissionRequested({ id: "agent-1" }, { id: "p1", name: "Bash", input: { command: "ls" } });
    tickMs(UNDO_MS);
    await timers.fire();
    const after = await engine.get(item.id);
    expect(after.item.state).toBe("review");
    expect(after.item.permission).not.toBeNull();
    expect(JSON.stringify(after.events)).toContain(STOP_BEFORE_CANCEL);
    // Made while it asks: refused outright.
    await expect(decide(item.id, "block")).rejects.toThrow(STOP_BEFORE_CANCEL);
    expect(fake.archived).toEqual([]);
  });
});

describe("concurrency cap", () => {
  test("at the cap a dispatch is refused and the work stays queued", async () => {
    const { create, engine, fake } = await setup({ concurrencyCap: 1 });
    await create();
    const queued = await create({ dispatch: false });
    await expect(engine.dispatch(fake.paseo, queued.id)).rejects.toThrow(
      "At capacity: 1 of 1 slot taken (1 running). It stays queued.",
    );
    expect((await engine.get(queued.id)).item.state).toBe("proposed");
    expect(fake.created).toHaveLength(1);
    // A slot frees when the run lands at the gate.
    await endTurn(engine, fake);
    expect((await engine.dispatch(fake.paseo, queued.id)).state).toBe("running");
  });

  test("the default cap is 3; stuck work holds a slot, and stays stuck at the cap", async () => {
    const { create, engine, fake } = await setup();
    const first = await create();
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "failed", error: { message: "boom" } }, []);
    await create();
    await create();
    // The stuck run still holds its slot (BRO-2990): two more runs fill the cap of 3.
    await expect(create()).rejects.toThrow("At capacity: 3 of 3 slots taken (2 running, 1 stuck). It stays queued.");
    // Restarting the stuck run itself does not count its own slot twice, and the other two still fill it.
    await create({ dispatch: false });
    await engine.onTurnEnded({ id: "agent-2" }, { kind: "completed" }, []);
    expect((await engine.dispatch(fake.paseo, first.id)).state).toBe("running");
    expect((await engine.get(first.id)).item.state).toBe("running");
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
    expect(String(refused.reason)).toContain("At capacity: 2 of 2 slots taken (1 running, 1 starting)");
    expect(fake.created).toHaveLength(2);
  });
});

describe("archive on approve", () => {
  test("an approval archives the run's workspace; the branch stays", async () => {
    const { create, engine, fake, decide, repo } = await setup({ archiveOnApprove: true });
    const item = await create();
    cleanWorktree(repo, item.worker);
    await endTurn(engine, fake);
    expect((await decide(item.id, "approve")).state).toBe("done");
    expect(fake.archivedWorkspaces).toEqual(["ws-1"]);
    const { events } = await engine.get(item.id);
    expect(events.at(-1)?.text).toBe(`Archived the workspace. The branch ${item.worker?.branch} stays.`);
  });

  test("off by default, and never on a send back or a cancel", async () => {
    const { create, engine, fake, decide, config, repo } = await setup();
    const item = await create();
    cleanWorktree(repo, item.worker);
    await endTurn(engine, fake);
    expect((await decide(item.id, "approve")).state).toBe("done");
    expect(fake.archivedWorkspaces).toEqual([]);
    config.archiveOnApprove = true;
    const other = await create();
    cleanWorktree(repo, other.worker);
    await endTurn(engine, fake, [], "agent-2");
    await decide(other.id, "revise", "again");
    await endTurn(engine, fake, [], "agent-2");
    await decide(other.id, "block");
    expect(fake.archivedWorkspaces).toEqual([]);
  });

  test("a failed archive is a receipt and the approval stands", async () => {
    const { create, engine, fake, decide, repo } = await setup({ archiveOnApprove: true });
    const item = await create();
    cleanWorktree(repo, item.worker);
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
    cleanWorktree(repo, other.worker);
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

  test("a worktree with uncommitted changes is kept, and so is one that cannot be checked", async () => {
    const { create, engine, fake, decide, repo } = await setup({ archiveOnApprove: true });
    const dirty = await create();
    const cwd = cleanWorktree(repo, dirty.worker);
    await Bun.write(join(cwd, "notes.txt"), "not committed");
    await endTurn(engine, fake);
    expect((await decide(dirty.id, "approve")).state).toBe("done");
    expect((await engine.get(dirty.id)).events.at(-1)?.text).toBe("Kept the worktree: it has uncommitted changes.");

    // Not a repository (or git fails): nothing proves the work is committed, so it stays.
    const unknown = await create();
    await endTurn(engine, fake, [], "agent-2");
    expect((await decide(unknown.id, "approve")).state).toBe("done");
    expect((await engine.get(unknown.id)).events.at(-1)?.text).toStartWith(
      "Kept the worktree: could not check it for uncommitted changes (",
    );
    expect(fake.archivedWorkspaces).toEqual([]);
  });

  test("a worktree whose .git points at a decoy matching its files is kept: git reads the run's own entry", async () => {
    const { create, engine, fake, decide, repo } = await setup({ archiveOnApprove: true });
    const item = await create();
    const cwd = cleanWorktree(repo, item.worker);
    await Bun.write(join(cwd, "notes.txt"), "not committed\n");
    // The session's own repository, whose one commit holds exactly what the worktree holds.
    const decoy = join(dirname(repo), "decoy");
    git(dirname(repo), "init", "-q", decoy);
    await Bun.write(join(decoy, "a.txt"), "hello\n");
    await Bun.write(join(decoy, "notes.txt"), "not committed\n");
    git(decoy, "add", "-A");
    git(decoy, "commit", "-q", "-m", "decoy");
    writeFileSync(join(cwd, ".git"), `gitdir: ${join(decoy, ".git")}\n`);
    // The attack is live: git that follows the folder's .git reads the uncommitted work as clean.
    expect(git(cwd, "status", "--porcelain")).toBe("");
    await endTurn(engine, fake);
    expect((await decide(item.id, "approve")).state).toBe("done");
    expect(fake.archivedWorkspaces).toEqual([]);
    expect((await engine.get(item.id)).events.at(-1)?.text).toBe(
      "Kept the worktree: could not check it for uncommitted changes (its .git does not point at its own entry in the repository).",
    );
  });

  test("a write that lands while the worktree is read keeps it: it is read again just before the archive", async () => {
    const { create, engine, fake, decide, repo } = await setup({ archiveOnApprove: true });
    const item = await create();
    const cwd = cleanWorktree(repo, item.worker);
    await endTurn(engine, fake);
    const real = Bun.which("git");
    if (!real) throw new Error("git is not on PATH");
    // A git whose first status answers clean, and then the session writes a file.
    const bin = join(dirname(repo), "bin");
    const wrote = join(dirname(repo), "wrote");
    await Bun.write(
      join(bin, "git"),
      [
        "#!/bin/sh",
        `"${real}" "$@"`,
        "code=$?",
        `case "$*" in *status*) [ -e "${wrote}" ] || { : > "${wrote}"; echo late > "${cwd}/late.txt"; };; esac`,
        "exit $code",
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "git"), 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved ?? ""}`;
    try {
      expect((await decide(item.id, "approve")).state).toBe("done");
    } finally {
      process.env.PATH = saved;
    }
    expect(existsSync(wrote)).toBe(true);
    expect(fake.archivedWorkspaces).toEqual([]);
    expect((await engine.get(item.id)).events.at(-1)?.text).toBe("Kept the worktree: it has uncommitted changes.");
  });

  test("a session that is working again, or that cannot be asked, keeps the worktree", async () => {
    const { create, engine, fake, decide, repo } = await setup({ archiveOnApprove: true });
    const item = await create();
    cleanWorktree(repo, item.worker);
    await endTurn(engine, fake);
    // The approval applied with the session idle; it starts working again once the claim is taken.
    const describe = fake.paseo.workspaces.ref;
    fake.paseo.workspaces.ref = ((id: string) => ({
      refresh: async () => {
        const agent = fake.agents.get("agent-1");
        if (agent) agent.status = "running";
        return describe(id).refresh();
      },
    })) as unknown as typeof fake.paseo.workspaces.ref;
    expect((await decide(item.id, "approve")).state).toBe("done");
    expect((await engine.get(item.id)).events.at(-1)?.text).toBe("Kept the worktree: the session is working again.");

    const other = await create();
    cleanWorktree(repo, other.worker);
    await endTurn(engine, fake, [], "agent-2");
    const ref = fake.paseo.agents.ref;
    let asked = 0;
    // The decision and its apply each ask once; the claim's ask never comes back.
    fake.paseo.agents.ref = ((id: string) => ({
      ...ref(id),
      refresh: () => (++asked > 2 ? new Promise(() => undefined) : ref(id).refresh()),
    })) as unknown as typeof ref;
    fake.paseo.workspaces.ref = describe;
    expect((await decide(other.id, "approve")).state).toBe("done");
    expect((await engine.get(other.id)).events.at(-1)?.text).toBe(
      "Kept the worktree: could not ask whether the session is idle (Paseo did not answer within 0.2s).",
    );
    expect(fake.archivedWorkspaces).toEqual([]);
  });

  test("Paseo's record naming another folder keeps the worktree", async () => {
    const { create, engine, fake, decide, repo } = await setup({ archiveOnApprove: true });
    const item = await create();
    cleanWorktree(repo, item.worker);
    await endTurn(engine, fake);
    fake.paseo.workspaces.ref = ((_id: string) => ({
      refresh: async () => ({ workspaceDirectory: repo }),
    })) as unknown as typeof fake.paseo.workspaces.ref;
    expect((await decide(item.id, "approve")).state).toBe("done");
    expect(fake.archivedWorkspaces).toEqual([]);
    expect((await engine.get(item.id)).events.at(-1)?.text).toBe(
      "Kept the worktree: could not check it for uncommitted changes (Paseo records the workspace at another folder).",
    );
    // Naming the same folder, it archives.
    const other = await create();
    const cwd = cleanWorktree(repo, other.worker);
    await endTurn(engine, fake, [], "agent-2");
    fake.paseo.workspaces.ref = ((_id: string) => ({
      refresh: async () => ({ workspaceDirectory: cwd, projectRootPath: repo }),
    })) as unknown as typeof fake.paseo.workspaces.ref;
    expect((await decide(other.id, "approve")).state).toBe("done");
    expect(fake.archivedWorkspaces).toEqual(["ws-2"]);
  });

  test("a repository path that is a link repointed at a forged repository keeps the worktree", async () => {
    const { create, engine, fake, decide, repo } = await setup({ archiveOnApprove: true });
    const root = dirname(repo);
    // Paseo puts worktrees outside the repository, so the repository can move and leave the worktree in place.
    fake.placeWorktreesIn(join(root, "worktrees"));
    const item = await create();
    const cwd = cleanWorktree(repo, item.worker);
    const branch = item.worker?.branch ?? "";
    await Bun.write(join(cwd, "notes.txt"), "not committed\n");
    // A forged repository whose own entry names this folder on the run's branch, at a commit matching the folder.
    const forged = join(root, "forged");
    git(root, "init", "-q", forged);
    await Bun.write(join(forged, "a.txt"), "hello\n");
    await Bun.write(join(forged, "notes.txt"), "not committed\n");
    git(forged, "add", "-A");
    git(forged, "commit", "-q", "-m", "forged");
    git(forged, "worktree", "add", "-q", "-b", branch, join(root, "scratch"));
    const entry = join(forged, ".git", "worktrees", "scratch");
    writeFileSync(join(entry, "gitdir"), `${join(cwd, ".git")}\n`);
    writeFileSync(join(cwd, ".git"), `gitdir: ${entry}\n`);
    // The work's repository path becomes a link to it; Paseo's record names the same path.
    renameSync(repo, join(root, "moved"));
    symlinkSync(forged, repo);
    // The attack is live: git through the link, on that entry, reads the uncommitted work as clean.
    expect(git(cwd, "status", "--porcelain")).toBe("");
    await endTurn(engine, fake);
    expect((await decide(item.id, "approve")).state).toBe("done");
    expect(fake.archivedWorkspaces).toEqual([]);
    expect(existsSync(join(cwd, "notes.txt"))).toBe(true);
    expect((await engine.get(item.id)).events.at(-1)?.text).toBe(
      `Kept the worktree: could not check it for uncommitted changes (the repository's path goes through a symbolic link: ${repo}).`,
    );
  });

  test("Paseo's record naming another repository keeps the worktree", async () => {
    const { create, engine, fake, decide, repo } = await setup({ archiveOnApprove: true });
    const item = await create();
    cleanWorktree(repo, item.worker);
    await endTurn(engine, fake);
    const elsewhere = join(dirname(repo), "elsewhere");
    git(dirname(repo), "init", "-q", elsewhere);
    const describe = fake.paseo.workspaces.ref;
    fake.paseo.workspaces.ref = ((id: string) => ({
      refresh: async () => ({ ...(await describe(id).refresh()), projectRootPath: elsewhere }),
    })) as unknown as typeof describe;
    expect((await decide(item.id, "approve")).state).toBe("done");
    expect(fake.archivedWorkspaces).toEqual([]);
    expect((await engine.get(item.id)).events.at(-1)?.text).toBe(
      "Kept the worktree: could not check it for uncommitted changes (Paseo records the workspace as made from another repository).",
    );
  });

  test("an archive Paseo never answers releases the claim and says so", async () => {
    const { create, engine, fake, decide, repo, store } = await setup({ archiveOnApprove: true });
    const item = await create();
    cleanWorktree(repo, item.worker);
    await endTurn(engine, fake);
    fake.paseo.workspaces.archive = () => new Promise(() => undefined);
    expect((await decide(item.id, "approve")).state).toBe("done");
    expect((await engine.get(item.id)).events.at(-1)?.text).toBe(
      "Could not archive the workspace: Paseo did not answer within 0.2s. The approval stands.",
    );
    // The item's lock is free: a later change to it goes through.
    await store.mutate(item.id, () => ({ events: [] }));
  });
});

describe("stop run", () => {
  test("stopping archives the session and leaves the work stuck with the reason", async () => {
    const { create, engine, fake, repo } = await setup();
    const item = await create();
    // Nothing uncommitted in the worktree, so nothing to confirm.
    cleanWorktree(repo, item.worker);
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

  test("Stop refuses while the worktree holds work that is not committed, ignored files included; discard stops it", async () => {
    const { create, engine, fake, repo } = await setup();
    const item = await create();
    const cwd = cleanWorktree(repo, item.worker);
    mkdirSync(join(repo, ".git", "info"), { recursive: true });
    writeFileSync(join(repo, ".git", "info", "exclude"), "*.log\n");
    writeFileSync(join(cwd, "a.txt"), "edited\n");
    writeFileSync(join(cwd, "notes.txt"), "draft\n");
    writeFileSync(join(cwd, "build.log"), "ignored, and archiving deletes it too\n");
    const refusal = (paths: string) =>
      `Not stopped: the worktree has ${paths} not committed (edits, new or ignored files), and stopping archives it, which deletes them. Stop again and confirm to discard them.`;
    await expect(engine.stopRun(fake.paseo, item.id)).rejects.toThrow(refusal("3 paths"));
    // An ignored file alone is still work the archive deletes.
    git(cwd, "checkout", "--", "a.txt");
    unlinkSync(join(cwd, "notes.txt"));
    await expect(engine.stopRun(fake.paseo, item.id)).rejects.toThrow(refusal("1 path"));
    expect(fake.archived).toEqual([]);
    expect((await engine.get(item.id)).item.state).toBe("running");
    // Confirmed: it stops.
    expect(await engine.stopRun(fake.paseo, item.id, { discard: true })).toMatchObject({
      state: "blocked",
      reason: STOPPED,
    });
    expect(fake.archived).toEqual(["agent-1"]);
  });

  /**
   * Writes a file into `cwd` as the next store change begins. The first change Stop makes after its check
   * is the flip to stuck, so the write lands between the check and the archive, as a session still working would.
   */
  function writeOnNextChange(cwd: string, name: string): () => void {
    const mutate = WorkStore.prototype.mutate;
    WorkStore.prototype.mutate = async function (this: WorkStore, ...args: Parameters<WorkStore["mutate"]>) {
      WorkStore.prototype.mutate = mutate;
      writeFileSync(join(cwd, name), "written while Stop checked\n");
      return mutate.apply(this, args);
    };
    return () => {
      WorkStore.prototype.mutate = mutate;
    };
  }

  /** Counts the daemon's workspace lookups: each worktree check starts with one. */
  function countWorktreeReads(fake: ReturnType<typeof fakePaseo>): { reads: number } {
    const counter = { reads: 0 };
    const ref = fake.paseo.workspaces.ref;
    fake.paseo.workspaces.ref = ((id: string) => {
      counter.reads += 1;
      return ref(id);
    }) as typeof ref;
    return counter;
  }

  test("a write that lands between Stop's check and its archive keeps the session, and the work goes back to running", async () => {
    const { create, engine, fake, repo } = await setup();
    const item = await create();
    const cwd = cleanWorktree(repo, item.worker);
    const restore = writeOnNextChange(cwd, "late.txt");
    try {
      await expect(engine.stopRun(fake.paseo, item.id)).rejects.toThrow(
        "Not stopped: the worktree changed while Stop checked it, so nothing was stopped. Stop again, or confirm to discard whatever it holds.",
      );
    } finally {
      restore();
    }
    expect(fake.archived).toEqual([]);
    expect(existsSync(join(cwd, "late.txt"))).toBe(true);
    const { item: after, events } = await engine.get(item.id);
    expect(after.state).toBe("running");
    expect(after.worker?.agentId).toBe("agent-1");
    expect(events.at(-1)).toMatchObject({ text: "Running", detail: "The worktree changed while Stop checked it" });
    // Once the write is committed, Stop goes through.
    git(cwd, "add", "late.txt");
    git(cwd, "commit", "-q", "-m", "late");
    expect(await engine.stopRun(fake.paseo, item.id)).toMatchObject({ state: "blocked", reason: STOPPED });
    expect(fake.archived).toEqual(["agent-1"]);
  });

  test("a turn that resumes the work between Stop's flip and its claim keeps the session, and says why", async () => {
    const { create, engine, fake, repo } = await setup();
    const item = await create();
    cleanWorktree(repo, item.worker);
    // Right after Stop flips the work to stuck, and before it takes the claim, the session starts a turn.
    const mutate = WorkStore.prototype.mutate;
    WorkStore.prototype.mutate = async function (this: WorkStore, ...args: Parameters<WorkStore["mutate"]>) {
      const result = await mutate.apply(this, args);
      if (result.contract.state === "blocked") {
        WorkStore.prototype.mutate = mutate;
        await engine.onTurnStarted({ id: "agent-1" });
      }
      return result;
    };
    try {
      await expect(engine.stopRun(fake.paseo, item.id)).rejects.toThrow(
        "Not archived: the work moved to Running while Stop checked the worktree, so the session was kept.",
      );
    } finally {
      WorkStore.prototype.mutate = mutate;
    }
    expect(fake.archived).toEqual([]);
    const { item: after, events } = await engine.get(item.id);
    expect(after.state).toBe("running");
    expect(after.worker?.agentId).toBe("agent-1");
    expect(events.at(-2)).toMatchObject({ text: "Running", detail: "Resumed in the session" });
    expect(events.at(-1)?.text).toBe(
      "Did not archive session agent-1: the work moved to Running while Stop checked the worktree",
    );
    // The claim was released, and a Stop now goes through.
    expect(await engine.stopRun(fake.paseo, item.id)).toMatchObject({ state: "blocked", reason: STOPPED });
    expect(fake.archived).toEqual(["agent-1"]);
  });

  test("a clean worktree is read twice, the second time just before the archive, and stops", async () => {
    const { create, engine, fake, repo } = await setup();
    const item = await create();
    cleanWorktree(repo, item.worker);
    const counter = countWorktreeReads(fake);
    expect(await engine.stopRun(fake.paseo, item.id)).toMatchObject({ state: "blocked", reason: STOPPED });
    expect(counter.reads).toBe(2);
    expect(fake.archived).toEqual(["agent-1"]);
  });

  test("discard skips both reads: a write between them does not keep the session", async () => {
    const { create, engine, fake, repo } = await setup();
    const item = await create();
    const cwd = cleanWorktree(repo, item.worker);
    const counter = countWorktreeReads(fake);
    const restore = writeOnNextChange(cwd, "late.txt");
    try {
      expect(await engine.stopRun(fake.paseo, item.id, DISCARD)).toMatchObject({ state: "blocked", reason: STOPPED });
    } finally {
      restore();
    }
    expect(counter.reads).toBe(0);
    expect(fake.archived).toEqual(["agent-1"]);
  });

  test("a second read that cannot check keeps the session too", async () => {
    const { create, engine, fake, repo } = await setup();
    const item = await create();
    cleanWorktree(repo, item.worker);
    const ref = fake.paseo.workspaces.ref;
    let reads = 0;
    fake.paseo.workspaces.ref = ((id: string) => {
      reads += 1;
      // The second read's lookup never answers: the claim gives up at claimWaitMs.
      return reads === 1 ? ref(id) : { refresh: () => new Promise(() => undefined) };
    }) as typeof ref;
    await expect(engine.stopRun(fake.paseo, item.id)).rejects.toThrow(
      "Not stopped: the worktree could not be checked again before stopping (Paseo has no record of the workspace), so nothing was stopped.",
    );
    expect(fake.archived).toEqual([]);
    expect((await engine.get(item.id)).item.state).toBe("running");
  });

  test("an archive that does not answer under the claim gives up at claimWaitMs and puts the run back", async () => {
    const { create, engine, fake, repo } = await setup();
    const item = await create();
    cleanWorktree(repo, item.worker);
    const ref = fake.paseo.agents.ref;
    fake.paseo.agents.ref = ((id: string) => ({
      ...ref(id),
      archive: () => new Promise(() => undefined),
    })) as unknown as typeof ref;
    await expect(engine.stopRun(fake.paseo, item.id)).rejects.toThrow(
      "Could not stop the session: Paseo did not answer within 0.2s",
    );
    const { item: after } = await engine.get(item.id);
    expect(after).toMatchObject({ state: "running", reason: null });
    // The claim was released: the item still takes changes.
    await endTurn(engine, fake);
    expect((await engine.get(item.id)).item.state).toBe("review");
  });

  test("stopped work can be canceled", async () => {
    const { create, engine, fake } = await setup();
    const item = await create();
    await engine.stopRun(fake.paseo, item.id, DISCARD);
    expect((await engine.cancel(item.id)).state).toBe("canceled");
  });

  test("only a run that is working or asking can be stopped", async () => {
    const { create, engine, fake } = await setup();
    const queued = await create({ dispatch: false });
    await expect(engine.stopRun(fake.paseo, queued.id)).rejects.toThrow(NOT_STOPPABLE);
    const item = await create();
    await endTurn(engine, fake);
    // At the gate with no question pending, the session is done: nothing to stop.
    await expect(engine.stopRun(fake.paseo, item.id)).rejects.toThrow(NOT_STOPPABLE);
    expect(fake.archived).toEqual([]);
  });

  /** The bound session asks for permission, and the daemon says it is still waiting on that answer. */
  async function ask(engine: Engine, fake: ReturnType<typeof fakePaseo>, requestId = "p1") {
    await engine.onPermissionRequested(
      { id: "agent-1" },
      { id: requestId, name: "Bash", title: "Run a command", description: "rm -rf dist" },
    );
    const agent = fake.agents.get("agent-1");
    if (agent) agent.pendingPermissions = [{ id: requestId, name: "Bash" }];
  }

  test("a run paused on the agent's question stops: stuck with Stop's reason, the session archived, the question gone", async () => {
    const { create, engine, fake, repo } = await setup();
    const item = await create();
    cleanWorktree(repo, item.worker);
    await ask(engine, fake);
    expect((await engine.get(item.id)).item).toMatchObject({
      state: "review",
      phase: "asking",
      permission: { requestId: "p1" },
    });
    const counter = countWorktreeReads(fake);
    const stuck = await engine.stopRun(fake.paseo, item.id);
    expect(stuck).toMatchObject({ state: "blocked", reason: STOPPED, phase: null, permission: null });
    // The worktree guard ran as it does for a working run: once before the flip, once under the claim.
    expect(counter.reads).toBe(2);
    expect(fake.archived).toEqual(["agent-1"]);
    expect(fake.archivedWorkspaces).toEqual([]);

    // What the archive sets off (the question closing, the turn ending, the archive) only adds receipts.
    await engine.onPermissionResolved({ id: "agent-1" }, "p1");
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "canceled", reason: "archived" }, []);
    await engine.onArchived({ id: "agent-1" });
    const { item: after, events } = await engine.get(item.id);
    expect(after).toMatchObject({ state: "blocked", reason: STOPPED, phase: null, permission: null, look: null });
    const texts = events.map((event) => event.text);
    expect(texts).toContain("You stopped the run");
    // Stop ended the question: nothing answered it, and no receipt says it was.
    expect(texts).not.toContain("Permission answered");
    expect(texts.at(-1)).toBe("The session was archived");

    // Unblock starts a fresh run: the session is gone.
    expect((await engine.unblock(fake.paseo, item.id, "")).state).toBe("running");
    expect(fake.created).toHaveLength(2);
  });

  test("Stop at the question keeps the worktree guard: refused while work is not committed, still asking; discard stops it", async () => {
    const { create, engine, fake, repo } = await setup();
    const item = await create();
    const cwd = cleanWorktree(repo, item.worker);
    writeFileSync(join(cwd, "notes.txt"), "draft\n");
    await ask(engine, fake);
    await expect(engine.stopRun(fake.paseo, item.id)).rejects.toThrow(
      "Not stopped: the worktree has 1 path not committed (edits, new or ignored files)",
    );
    expect(fake.archived).toEqual([]);
    expect((await engine.get(item.id)).item).toMatchObject({ state: "review", phase: "asking" });
    expect(await engine.stopRun(fake.paseo, item.id, DISCARD)).toMatchObject({
      state: "blocked",
      reason: STOPPED,
      permission: null,
    });
    expect(fake.archived).toEqual(["agent-1"]);
  });

  test("a question answered while Stop checked the worktree turns it into a stop of the working run", async () => {
    const { create, engine, fake, repo } = await setup();
    const item = await create();
    cleanWorktree(repo, item.worker);
    await ask(engine, fake);
    // Answered in the session after Stop's first read and before its flip: the flip re-reads the item.
    const mutate = WorkStore.prototype.mutate;
    WorkStore.prototype.mutate = async function (this: WorkStore, ...args: Parameters<WorkStore["mutate"]>) {
      WorkStore.prototype.mutate = mutate;
      await engine.onPermissionResolved({ id: "agent-1" }, "p1");
      return mutate.apply(this, args);
    };
    try {
      expect(await engine.stopRun(fake.paseo, item.id)).toMatchObject({ state: "blocked", reason: STOPPED });
    } finally {
      WorkStore.prototype.mutate = mutate;
    }
    const { events } = await engine.get(item.id);
    // Each state change folds into the receipt that caused it.
    expect(events.map((event) => event.text).slice(-3)).toEqual([
      "Asked for permission",
      "Permission answered",
      "You stopped the run",
    ]);
    expect(fake.archived).toEqual(["agent-1"]);
  });

  test("a failed archive at the question puts the run back, and the next reconcile finds the question again", async () => {
    const { create, engine, fake } = await setup();
    const item = await create();
    await ask(engine, fake);
    const ref = fake.paseo.agents.ref;
    fake.paseo.agents.ref = ((id: string) => ({
      ...ref(id),
      archive: async () => {
        throw new Error("daemon busy");
      },
    })) as unknown as typeof ref;
    await expect(engine.stopRun(fake.paseo, item.id, DISCARD)).rejects.toThrow(
      "Could not stop the session: daemon busy",
    );
    fake.paseo.agents.ref = ref;
    expect((await engine.get(item.id)).item).toMatchObject({ state: "running", permission: null });
    // The session is still waiting on p1: the reconcile records the question again and parks it at the gate.
    tick(1);
    await engine.upkeep(fake.paseo);
    expect((await engine.get(item.id)).item).toMatchObject({
      state: "review",
      phase: "asking",
      permission: { requestId: "p1" },
    });
    expect(fake.archived).toEqual([]);
  });

  test("Cancel work while the agent asks is refused: it would leave the session waiting on the question", async () => {
    const { create, engine, fake, timers } = await setup();
    const item = await create();
    await ask(engine, fake);
    await expect(engine.cancel(item.id, fake.paseo)).rejects.toThrow(STOP_BEFORE_CANCEL);
    tickMs(UNDO_MS);
    await timers.fire();
    const after = (await engine.get(item.id)).item;
    expect(after).toMatchObject({ state: "review", pending: null });
    expect(after.permission).not.toBeNull();
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
    await expect(engine.stopRun(fake.paseo, item.id, DISCARD)).rejects.toThrow(
      "Could not stop the session: daemon busy",
    );
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
    expect(events.map((event) => event.text)).not.toContain("Took effect");
    expect(events.at(-1)).toMatchObject({ text: "Undone", detail: "Approve" });
  });

  test("the sweep applies a decision whose timer never ran; a list only shows it pending (BRO-2995)", async () => {
    const { create, engine, fake, config } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    await engine.verdict(fake.paseo, item.id, "approve", "");
    engine.stop();
    tickMs(UNDO_MS);
    const restarted = new Engine({ now: () => new Date(clock), config: async () => config, log: () => {} });
    const listed = (await restarted.list(fake.paseo)).items.find((entry) => entry.id === item.id);
    expect(listed).toMatchObject({ state: "review", pending: { verdict: "approve" } });
    expect(await restarted.upkeep(fake.paseo)).toBe(true);
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
    expect(await engine.stopRun(fake.paseo, item.id, DISCARD)).toMatchObject({
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

/** Holds the `nth` store scan from now open after it has read the tree, so a test can land writes in between. */
function holdScan(nth: number) {
  const original = WorkStore.prototype.scan;
  let readDone!: () => void;
  let release!: () => void;
  const read = new Promise<void>((resolve) => {
    readDone = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let count = 0;
  WorkStore.prototype.scan = async function (this: WorkStore, ...args: Parameters<WorkStore["scan"]>) {
    const result = await original.apply(this, args);
    count += 1;
    if (count === nth) {
      readDone();
      await released;
    }
    return result;
  };
  return { read, release, restore: () => (WorkStore.prototype.scan = original) };
}

describe("round 2 of review: a decision is about the result you saw", () => {
  test("approve, send back or cancel is dropped when the run went on and came back", async () => {
    const { create, engine, fake, timers } = await setup();
    const cases = [
      ["approve", "", "Approve"],
      ["revise", "Tighten it", "Send back"],
      ["block", "", "Cancel work"],
    ] as const;
    for (const [n, [verdict, note, verb]] of cases.entries()) {
      const agentId = `agent-${n + 1}`;
      const item = await create();
      await endTurn(engine, fake, [], agentId);
      await engine.verdict(fake.paseo, item.id, verdict, note);
      // The session picks up again and lands a different result at the gate before the window closes.
      await engine.onTurnStarted({ id: agentId });
      await endTurn(
        engine,
        fake,
        [{ type: "assistant_message", text: "## Decided\n- rewrote it\n## Ask\nok?" }],
        agentId,
      );
      expect((await engine.get(item.id)).item.state).toBe("review");
      tickMs(UNDO_MS);
      await timers.fire();
      const { item: after, events } = await engine.get(item.id);
      expect(after).toMatchObject({ state: "review", pending: null, look: { decided: ["rewrote it"] } });
      expect(events.at(-1)).toMatchObject({ text: `${verb} did not take effect`, detail: RUN_WENT_ON });
    }
    expect(fake.sent).toHaveLength(0);
  });

  test("a turn that ended at the gate after you decided (its start missed) drops the approval", async () => {
    const { create, engine, fake, timers } = await setup();
    const item = await create();
    const agent = fake.agents.get("agent-1");
    if (agent) agent.status = "idle";
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "completed" }, [], "turn-1");
    await engine.verdict(fake.paseo, item.id, "approve", "");
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "completed" }, [], "turn-late");
    expect((await engine.get(item.id)).events.filter((event) => event.type === "turn.ended")).toHaveLength(2);
    tickMs(UNDO_MS);
    await timers.fire();
    expect((await engine.get(item.id)).item).toMatchObject({ state: "review", pending: null });
  });

  test("a turn start alone after you decided is the run going on", async () => {
    const { create, engine, fake, timers, store } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    await engine.verdict(fake.paseo, item.id, "approve", "");
    // Every path today records a turn start with a state change; the rule does not depend on that.
    await store.mutate(item.id, () => ({
      events: [{ ts: new Date(clock).toISOString(), type: "turn.started", actor: "agent", agentId: "agent-1" }],
    }));
    tickMs(UNDO_MS);
    await timers.fire();
    const { item: after, events } = await engine.get(item.id);
    expect(after).toMatchObject({ state: "review", pending: null });
    expect(events.at(-1)).toMatchObject({ text: "Approve did not take effect", detail: RUN_WENT_ON });
  });

  test("a write torn after the state landed is completed, not reported as refused", async () => {
    const { create, engine, fake, timers, store } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    await engine.verdict(fake.paseo, item.id, "approve", "");
    // A crash between the contract write and the receipts: the file says done, the log never heard.
    await store.mutate(item.id, () => ({ patch: { state: "done" } }));
    tickMs(UNDO_MS);
    await timers.fire();
    const { item: after, events } = await engine.get(item.id);
    expect(after).toMatchObject({ state: "done", pending: null, verdict: "You approved" });
    expect(events.slice(-2).map((event) => event.text)).toEqual(["You approved", "Took effect"]);
    expect(events.map((event) => event.text)).not.toContain("Approve did not take effect");
  });

  test("a torn send back is completed, and the session still gets the note", async () => {
    const { create, engine, fake, timers, store } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    await engine.verdict(fake.paseo, item.id, "revise", "Rename the flag");
    await store.mutate(item.id, () => ({ patch: { state: "running" } }));
    tickMs(UNDO_MS);
    await timers.fire();
    expect((await engine.get(item.id)).item).toMatchObject({ state: "running", pending: null });
    expect(fake.sent.at(-1)?.text).toContain("Rename the flag");
  });

  test("an overdue decision reads as due, never as negative time", async () => {
    const { create, engine, fake } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    await engine.verdict(fake.paseo, item.id, "approve", "");
    engine.stop();
    tickMs(UNDO_MS + 5_000);
    expect((await engine.get(item.id)).item.pending).toMatchObject({ verdict: "approve", remainingMs: 0 });
  });
});

describe("round 2 of review: client, cap and stop", () => {
  test("a decision found due with no client re-arms a timer and applies once a client exists", async () => {
    const { create, engine, fake, config } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    await engine.verdict(fake.paseo, item.id, "approve", "");
    engine.stop();
    tickMs(UNDO_MS);
    let handle: Paseo | null = null;
    const timers = fakeTimers();
    const restarted = new Engine({
      now: () => new Date(clock),
      config: async () => config,
      log: () => {},
      client: () => handle,
      timer: timers.timer,
    });
    expect(await restarted.sweep()).toBe(false);
    expect(timers.live().map((timer) => timer.ms)).toEqual([CLIENT_WAIT_MS]);
    // Still no client when it fires: it waits again rather than giving up.
    await timers.fire();
    expect(timers.live().map((timer) => timer.ms)).toEqual([CLIENT_WAIT_MS]);
    handle = fake.paseo;
    await timers.fire();
    expect((await restarted.get(item.id)).item).toMatchObject({ state: "done", pending: null });
  });

  test("the cap counts a run that took its slot before this dispatch read the files", async () => {
    const { engine, fake, repo } = await setup({ concurrencyCap: 1 });
    const make = (title: string) =>
      engine.create(fake.paseo, { title, brief: "", repo, gate: "human", check: "", initiative: "", dispatch: false });
    const a = await make("First");
    const b = await make("Second");
    // A stops inside its run start, before it is recorded running.
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let startedA!: () => void;
    const insideA = new Promise<void>((resolve) => {
      startedA = resolve;
    });
    const original = fake.paseo.workspaces.create;
    let first = true;
    fake.paseo.workspaces.create = (async (options: Parameters<typeof original>[0]) => {
      const workspace = await original(options);
      if (first) {
        first = false;
        startedA();
        await gateA;
      }
      return workspace;
    }) as typeof original;
    const dispatchA = engine.dispatch(fake.paseo, a.id);
    await insideA;
    // B reads the files while A is still starting (queued on disk), then counts only after A is
    // recorded running and has let go of its slot.
    const hold = holdScan(2);
    let dispatchB!: Promise<unknown>;
    try {
      dispatchB = engine.dispatch(fake.paseo, b.id).then(
        () => "started",
        (error: Error) => error.message,
      );
      await hold.read;
    } finally {
      hold.restore();
    }
    releaseA();
    expect((await dispatchA).state).toBe("running");
    hold.release();
    // B read the files while A was still queued on disk: A is counted by its slot, as starting.
    expect(await dispatchB).toBe("At capacity: 1 of 1 slot taken (1 starting). It stays queued.");
    expect(fake.created).toHaveLength(1);
  });

  test("create at the cap returns the queued item and why, instead of an error without the id", async () => {
    const { create, engine, fake, repo } = await setup({ concurrencyCap: 1 });
    await create();
    const { item, notice } = await engine.createWork(fake.paseo, {
      title: "Later",
      brief: "",
      repo,
      gate: "human",
      check: "",
      initiative: "",
      dispatch: true,
    });
    expect(item.state).toBe("proposed");
    expect(notice).toBe(
      `Created ${item.id}, not started. At capacity: 1 of 1 slot taken (1 running). It stays queued.`,
    );
    expect(fake.created).toHaveLength(1);
  });

  test("Stop is refused while checks run: the session is done and the checks decide", async () => {
    const { create, engine, fake } = await setup();
    const item = await create({ check: "sleep 0.3" });
    await endTurn(engine, fake);
    expect((await engine.get(item.id)).item.phase).toBe("checking");
    await expect(engine.stopRun(fake.paseo, item.id)).rejects.toThrow(CHECKING);
    expect(fake.archived).toEqual([]);
    expect((await settle(engine, item.id, "review")).reason).toBeNull();
  });

  test("a stop whose run was replaced while it read is refused, and archives nothing", async () => {
    const { create, engine, fake } = await setup();
    const item = await create();
    const hold = holdNextScan();
    let stopping!: Promise<unknown>;
    try {
      stopping = engine.stopRun(fake.paseo, item.id, DISCARD).then(
        () => "stopped",
        (error: Error) => error.message,
      );
      await hold.read;
    } finally {
      hold.restore();
    }
    // Meanwhile the run failed and you started a fresh one.
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "failed", error: { message: "boom" } }, []);
    await engine.dispatch(fake.paseo, item.id);
    hold.release();
    expect(await stopping).toBe("A new run started while this one was being stopped.");
    expect(fake.archived).toEqual([]);
    expect((await engine.get(item.id)).item).toMatchObject({ state: "running", worker: { agentId: "agent-2" } });
  });

  test("a failed archive leaves alone work that moved on since the stop", async () => {
    const { create, engine, fake } = await setup();
    const item = await create();
    const ref = fake.paseo.agents.ref;
    fake.paseo.agents.ref = ((id: string) => ({
      ...ref(id),
      archive: async () => {
        // The session resumed and failed on its own before the archive gave up.
        await engine.onTurnStarted({ id });
        await engine.onTurnEnded({ id }, { kind: "failed", error: { message: "boom" } }, [], "t2");
        throw new Error("daemon busy");
      },
    })) as unknown as typeof ref;
    await expect(engine.stopRun(fake.paseo, item.id, DISCARD)).rejects.toThrow(
      "Could not stop the session: daemon busy",
    );
    const { item: after, events } = await engine.get(item.id);
    expect(after).toMatchObject({ state: "blocked", reason: "boom" });
    expect(events.at(-1)?.text).toBe("Could not archive session agent-1: daemon busy");
  });

  test("a failed archive of an earlier run never rolls back a later stop", async () => {
    const { create, engine, fake } = await setup();
    const item = await create();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const ref = fake.paseo.agents.ref;
    fake.paseo.agents.ref = ((id: string) =>
      id === "agent-1"
        ? {
            ...ref(id),
            archive: async () => {
              entered();
              await held;
              throw new Error("daemon busy");
            },
          }
        : ref(id)) as unknown as typeof ref;
    const first = engine.stopRun(fake.paseo, item.id, DISCARD).then(
      () => "stopped",
      (error: Error) => error.message,
    );
    await inside;
    // While the first archive hangs: the session is gone, you unblock (a fresh run), then stop that one too.
    const agent = fake.agents.get("agent-1");
    if (agent) agent.archivedAt = new Date(clock).toISOString();
    expect((await engine.unblock(fake.paseo, item.id, "")).worker?.agentId).toBe("agent-2");
    expect((await engine.stopRun(fake.paseo, item.id, DISCARD)).reason).toBe("You stopped the run");
    release();
    expect(await first).toBe("Could not stop the session: daemon busy");
    const { item: after, events } = await engine.get(item.id);
    expect(after).toMatchObject({ state: "blocked", reason: "You stopped the run", worker: { agentId: "agent-2" } });
    expect(events.at(-1)?.text).toBe("Could not archive session agent-1: daemon busy");
  });

  test("a cancel that finds the work just reached Needs you refuses rather than skip the window", async () => {
    const { create, engine, fake } = await setup();
    const item = await create();
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "failed", error: { message: "boom" } }, []);
    const hold = holdNextScan();
    let canceling!: Promise<unknown>;
    try {
      canceling = engine.cancel(item.id).then(
        () => "canceled",
        (error: Error) => error.message,
      );
      await hold.read;
    } finally {
      hold.restore();
    }
    // Resumed in the session and landed at the gate while the cancel was reading.
    await engine.onTurnStarted({ id: "agent-1" });
    await endTurn(engine, fake);
    hold.release();
    expect(await canceling).toBe("This work just reached Needs you. Cancel it there.");
    expect((await engine.get(item.id)).item).toMatchObject({ state: "review", pending: null });
  });
});

describe("round 3 of review", () => {
  test("a torn send back followed by a turn is dropped: the note never reaches a run that went on", async () => {
    const { create, engine, fake, timers, store } = await setup();
    const item = await create();
    await endTurn(engine, fake);
    await engine.verdict(fake.paseo, item.id, "revise", "Rename the flag");
    // The write tore after the state landed; then the session started a turn of its own.
    await store.mutate(item.id, () => ({ patch: { state: "running" } }));
    await engine.onTurnStarted({ id: "agent-1" });
    tickMs(UNDO_MS);
    await timers.fire();
    const { item: after, events } = await engine.get(item.id);
    expect(after).toMatchObject({ state: "running", pending: null });
    expect(events.at(-1)).toMatchObject({ text: "Send back did not take effect", detail: RUN_WENT_ON });
    expect(events.map((event) => event.text)).not.toContain("Took effect");
    expect(fake.sent).toHaveLength(0);
  });

  test("a torn approval followed by a turn stays closed, says the run went on, and archives nothing", async () => {
    const { create, engine, fake, timers, store, repo } = await setup({ archiveOnApprove: true });
    const item = await create();
    cleanWorktree(repo, item.worker);
    const agent = fake.agents.get("agent-1");
    if (agent) agent.status = "idle";
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "completed" }, [], "turn-1");
    await engine.verdict(fake.paseo, item.id, "approve", "");
    await store.mutate(item.id, () => ({ patch: { state: "done" } }));
    // Done cannot reopen, but the session still ended another turn after you decided.
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "completed" }, [], "turn-2");
    tickMs(UNDO_MS);
    await timers.fire();
    const { item: after, events } = await engine.get(item.id);
    expect(after).toMatchObject({ state: "done", pending: null, verdict: "You approved" });
    expect(events.slice(-4).map((event) => event.text)).toEqual([
      "You approved",
      "Turn finished",
      "Took effect",
      `${RUN_WENT_ON} Nothing else was done.`,
    ]);
    expect(fake.archivedWorkspaces).toEqual([]);
  });

  test("a torn cancel followed by a turn stays canceled and says the run went on", async () => {
    const { create, engine, fake, timers, store } = await setup();
    const item = await create();
    const agent = fake.agents.get("agent-1");
    if (agent) agent.status = "idle";
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "completed" }, [], "turn-1");
    await engine.verdict(fake.paseo, item.id, "block", "");
    await store.mutate(item.id, () => ({ patch: { state: "canceled" } }));
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "completed" }, [], "turn-2");
    tickMs(UNDO_MS);
    await timers.fire();
    const { item: after, events } = await engine.get(item.id);
    expect(after).toMatchObject({ state: "canceled", pending: null });
    expect(events.slice(-3).map((event) => event.text)).toEqual([
      "Turn finished",
      "Took effect",
      `${RUN_WENT_ON} Nothing else was done.`,
    ]);
    expect(events.map((event) => event.text)).not.toContain("Cancel work did not take effect");
  });

  test("a sweep while a timer's apply is in flight arms nothing more; one timer is left after", async () => {
    const { create, engine: first, fake, config, store } = await setup();
    const item = await create();
    await endTurn(first, fake);
    first.stop();
    let hold = false;
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const timers = fakeTimers();
    const engine = new Engine({
      now: () => new Date(clock),
      config: async () => {
        if (hold) {
          entered();
          await held;
        }
        return config;
      },
      log: () => {},
      timer: timers.timer,
    });
    await engine.verdict(fake.paseo, item.id, "approve", "");
    const { items } = await store.scan();
    // The timer fires before the clock gets there, and its apply is held open.
    hold = true;
    const firing = timers.fire();
    await inside;
    await engine.sweep(fake.paseo, items);
    expect(timers.live()).toHaveLength(0);
    hold = false;
    release();
    await firing;
    // The apply found it early and waits out the rest: exactly one timer.
    expect(timers.live().map((timer) => timer.ms)).toEqual([UNDO_MS]);
  });
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
    // The work's own choice, and Settings for the rest, as Settings stand now.
    expect(item.nextRun).toEqual({
      provider: "claude",
      isolation: "worktree",
      modeId: null,
      thinkingOptionId: "low",
      featureValues: null,
      fromSettings: ["provider", "isolation"],
      held: null,
    });
    config.modeId = "bypassPermissions";
    config.isolation = "worktree";
    const running = await engine.dispatch(fake.paseo, item.id);
    const options = fake.created[0] as { config: Record<string, unknown> };
    expect(options.config).toEqual({ provider: "claude/sonnet", modeId: "bypassPermissions", thinkingOptionId: "low" });
    expect(running.worker?.branch).toMatch(/^run\//);
    // The receipt records the mode the agent really got, wherever it came from.
    expect(running.worker).toMatchObject({ modeId: "bypassPermissions", thinkingOptionId: "low", featureValues: null });
  });

  test("a Settings mode the work did not override shows on the Queued and Stuck cards, warned, as dispatch uses it", async () => {
    const { engine, fake, repo } = await setup({ modeId: "bypassPermissions" });
    const item = await engine.create(fake.paseo, { ...draft(repo), title: "Inherits", provider: "claude/opus" });
    const shown = [(await engine.list()).items.find((entry) => entry.id === item.id), (await engine.get(item.id)).item];
    for (const wire of shown) {
      expect(wire?.nextRun).toEqual({
        provider: "claude/opus",
        isolation: "worktree",
        modeId: "bypassPermissions",
        thinkingOptionId: null,
        featureValues: null,
        fromSettings: ["isolation", "modeId"],
        held: null,
      });
      const queued = nextRunCopy(wire?.nextRun, "queued");
      expect(queued.line).toContain("mode bypassPermissions (from Settings)");
      expect(queued.warning).toContain("skips permission prompts");
    }
    await engine.dispatch(fake.paseo, item.id);
    expect((fake.created[0] as { config: Record<string, unknown> }).config).toEqual({
      provider: "claude/opus",
      modeId: "bypassPermissions",
    });
    // The session goes away: Unblock starts a new run, with the same Settings mode, and the Stuck card says so first.
    await engine.onArchived({ id: "agent-1" });
    const agent = fake.agents.get("agent-1");
    if (agent) agent.archivedAt = new Date().toISOString();
    const stuck = (await engine.get(item.id)).item;
    expect(stuck.state).toBe("blocked");
    expect(nextRunCopy(stuck.nextRun, "stuck").warning).toContain("would skip permission prompts");
    await engine.unblock(fake.paseo, item.id, "");
    expect(fake.created).toHaveLength(2);
    expect((fake.created[1] as { config: Record<string, unknown> }).config).toMatchObject({
      modeId: "bypassPermissions",
    });
  });

  test("auto_accept the work chose warns on the card, and a session may not start the work", async () => {
    const { engine, fake, repo } = await setup({ provider: "opencode/big" });
    const item = await engine.create(fake.paseo, {
      ...draft(repo),
      title: "OpenCode",
      featureValues: { auto_accept: true },
    });
    expect(nextRunCopy((await engine.get(item.id)).item.nextRun, "queued").warning).toContain(
      "skips permission prompts",
    );
    await expect(engine.dispatch(fake.paseo, item.id, { actor: "agent", by: "session-1" })).rejects.toThrow(
      MODED_BY_YOU,
    );
    expect(fake.created).toHaveLength(0);
  });

  test("a Settings mode belongs to the Settings provider; work on another provider does not inherit it", async () => {
    const { engine, fake, repo } = await setup({ provider: "claude", modeId: "bypassPermissions" });
    await engine.create(fake.paseo, { ...draft(repo), title: "Codex", provider: "codex/gpt-5.5", dispatch: true });
    await engine.create(fake.paseo, { ...draft(repo), title: "Opus", provider: "claude/opus", dispatch: true });
    const configs = fake.created.map((options) => (options as { config: Record<string, unknown> }).config);
    expect(configs).toEqual([{ provider: "codex/gpt-5.5" }, { provider: "claude/opus", modeId: "bypassPermissions" }]);
  });

  test("work a session creates carries none of the run choices: how runs start stays yours", async () => {
    // Settings' mode does not ask, so a session's run may start, in that mode, never the choices it passed.
    const { engine, fake, repo, config } = await setup({ modeId: "bypassPermissions" });
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
    expect(options.config).toEqual({ provider: "claude/sonnet", modeId: "bypassPermissions" });
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

  test("a session still starts queued work that has no mode of its own, in Settings' mode, not its own", async () => {
    const { engine, fake, repo } = await setup({ modeId: "bypassPermissions" });
    fake.addSession("session-1", { modeId: "acceptEdits" });
    const item = await engine.create(fake.paseo, { ...moded(repo), modeId: undefined });
    const running = await engine.dispatch(fake.paseo, item.id, session);
    expect(running.worker?.modeId).toBe("bypassPermissions");
  });
});

describe("who starts a run, and what holds the cap (A8, BRO-2990)", () => {
  const lane = { actor: "agent" as const, by: "lane-1" };
  const fail = (engine: Engine, agentId: string) =>
    engine.onTurnEnded({ id: agentId }, { kind: "failed", error: { message: "boom" } }, []);

  test("3 stuck runs and a 4th dispatch is refused, yours or a lane's; nothing starts", async () => {
    const { create, engine, fake } = await setup({ concurrencyCap: 3, modeId: "bypassPermissions" });
    fake.addSession("lane-1", { modeId: "bypassPermissions" });
    for (const n of [1, 2, 3]) {
      await create();
      await fail(engine, `agent-${n}`);
    }
    expect((await engine.list()).items.map((item) => item.state)).toEqual(["blocked", "blocked", "blocked"]);
    const fourth = await create({ dispatch: false });
    const full = "At capacity: 3 of 3 slots taken (3 stuck). It stays queued.";
    await expect(engine.dispatch(fake.paseo, fourth.id)).rejects.toThrow(full);
    await expect(engine.dispatch(fake.paseo, fourth.id, lane)).rejects.toThrow(full);
    expect(fake.created).toHaveLength(3);
    expect((await engine.get(fourth.id)).item.state).toBe("proposed");
  });

  test("stuck work holds its slot only while its session is there: your Stop or a session gone frees it", async () => {
    const { create, engine, fake } = await setup({ concurrencyCap: 1 });
    const next = await create({ dispatch: false });
    const full = "At capacity: 1 of 1 slot taken (1 stuck). It stays queued.";
    // A failed turn: the session is still there, waiting for a nudge, so the run keeps its slot.
    const failed = await create();
    await fail(engine, "agent-1");
    expect((await engine.get(failed.id)).item.state).toBe("blocked");
    await expect(engine.dispatch(fake.paseo, next.id)).rejects.toThrow(full);
    // Canceling the stuck work frees it; now a run you stop: Stop archives its session, and the slot frees.
    await engine.cancel(failed.id);
    const stopped = await create();
    await engine.stopRun(fake.paseo, stopped.id, { discard: true });
    expect((await engine.get(stopped.id)).item).toMatchObject({ state: "blocked" });
    expect(fake.archived).toContain("agent-2");
    const started = await engine.dispatch(fake.paseo, next.id);
    expect(started.state).toBe("running");
    // A run whose session ended under it: stuck, and its slot is free too.
    const gone = fake.agents.get("agent-3");
    if (gone) gone.status = "closed";
    await engine.upkeep(fake.paseo);
    expect((await engine.get(next.id)).item.state).toBe("blocked");
    const after = await create();
    expect(after.state).toBe("running");
  });

  test("a run stuck on a failed turn frees its slot once its session goes later: archived, or closed", async () => {
    const { create, engine, fake } = await setup({ concurrencyCap: 1 });
    const next = await create({ dispatch: false });
    const full = "At capacity: 1 of 1 slot taken (1 stuck). It stays queued.";
    // Archived in Paseo after the turn failed: the archive hook notes it, and the slot frees.
    await create();
    await fail(engine, "agent-1");
    await expect(engine.dispatch(fake.paseo, next.id)).rejects.toThrow(full);
    const archived = fake.agents.get("agent-1");
    if (archived) archived.archivedAt = "2026-09-22T09:05:00.000Z";
    await engine.onArchived({ id: "agent-1" });
    expect((await engine.dispatch(fake.paseo, next.id)).state).toBe("running");
    // `next` runs as agent-2 and fails too; then its session closes with no archive. The next look notes it.
    await fail(engine, "agent-2");
    const third = await create({ dispatch: false });
    await expect(engine.dispatch(fake.paseo, third.id)).rejects.toThrow(full);
    const closed = fake.agents.get("agent-2");
    if (closed) closed.status = "closed";
    await engine.upkeep(fake.paseo);
    expect((await engine.get(next.id)).events.some((event) => event.text === "The session has ended")).toBe(true);
    expect((await engine.dispatch(fake.paseo, third.id)).state).toBe("running");
  });

  test("a run waiting on a permission holds its slot; one landed at your gate frees it", async () => {
    const { create, engine, fake } = await setup({ concurrencyCap: 1 });
    await create();
    const asking = fake.agents.get("agent-1");
    if (asking) asking.pendingPermissions = [{ id: "perm-1", name: "Bash" }];
    await engine.onPermissionRequested({ id: "agent-1" }, { id: "perm-1", name: "Bash" } as never);
    const [first] = (await engine.list()).items;
    expect([first?.state, first?.phase]).toEqual(["review", "asking"]);
    const next = await create({ dispatch: false });
    await expect(engine.dispatch(fake.paseo, next.id)).rejects.toThrow(
      "At capacity: 1 of 1 slot taken (1 waiting on a permission). It stays queued.",
    );
    // Its turn ends with the question gone: it lands at your gate, and the slot is free.
    if (asking) asking.pendingPermissions = [];
    await endTurn(engine, fake);
    expect((await engine.dispatch(fake.paseo, next.id)).state).toBe("running");
  });

  test("your Dispatch starts work as Settings say, with the loop on and new work gated auto", async () => {
    const { engine, fake, repo } = await setup({ defaultGate: "auto", loopMinutes: 30, modeId: null });
    const item = await engine.create(fake.paseo, {
      title: "Yours to start",
      brief: "",
      repo,
      gate: "human",
      check: "",
      initiative: "",
      dispatch: false,
    });
    const running = await engine.dispatch(fake.paseo, item.id);
    expect(running.state).toBe("running");
    // You watch your own run, so Settings' mode stands, none included: no lane profile is asked for.
    expect((fake.created[0] as { config: Record<string, unknown> }).config).toEqual({ provider: "claude/sonnet" });
    expect(running.worker?.modeId).toBeNull();
    const raw = (await engine.get(item.id)).events.find((event) => event.type === "dispatched");
    expect(raw).toMatchObject({ actor: "human" });
  });

  test("a session cannot start work filed from your answer before A8; your Dispatch starts it", async () => {
    // Settings' mode does not ask, so only the work itself can make a session's start refused.
    const { engine, fake, repo } = await setup({ modeId: "bypassPermissions" });
    fake.addSession("lane-1", { modeId: "default" });
    // As the routing before A8 filed it: Maestro's, for an answer, no hold.
    const legacy = await engine.create(
      fake.paseo,
      {
        title: "Act on your answer: Ship it?",
        brief: "",
        repo,
        gate: "human",
        check: "",
        initiative: "",
        dispatch: false,
        answer: "l.yaml#A1@2026-10-06T12:00:01Z",
      },
      { actor: "maestro", via: "loop" },
    );
    await expect(engine.dispatch(fake.paseo, legacy.id, lane)).rejects.toThrow(
      "Filed from your answer before A8: start it yourself, or cancel it.",
    );
    expect(fake.created).toEqual([]);
    expect((await engine.dispatch(fake.paseo, legacy.id)).state).toBe("running");
  });

  test("a session's run takes Settings' mode when it does not ask, whatever mode the session runs in", async () => {
    const { create, engine, fake } = await setup({ modeId: "bypassPermissions" });
    fake.addSession("lane-1", { modeId: "default", title: "SRI lane" });
    const item = await create({ dispatch: false });
    const running = await engine.dispatch(fake.paseo, item.id, lane);
    expect((fake.created[0] as { config: Record<string, unknown> }).config).toEqual({
      provider: "claude/sonnet",
      modeId: "bypassPermissions",
    });
    expect(running.worker?.modeId).toBe("bypassPermissions");
  });

  test("a session cannot borrow another session's mode by naming its id (unverified until BRO-2996)", async () => {
    // Settings ask before acting; a bypass worker's id is in work.list for any session to read.
    const { create, engine, fake } = await setup({ modeId: "default" });
    fake.addSession("bypass-worker", { modeId: "bypassPermissions" });
    const item = await create({ dispatch: false });
    await expect(engine.dispatch(fake.paseo, item.id, { actor: "agent", by: "bypass-worker" })).rejects.toThrow(
      "A run nobody watches never starts in Always ask, so this one was not started: the mode in your Settings (default) asks before it acts",
    );
    expect(fake.created).toEqual([]);
    expect((await engine.get(item.id)).item.state).toBe("proposed");
  });

  test("a session's start that will be refused holds no slot while its profile is read: yours starts meanwhile", async () => {
    let release!: () => void;
    const reading = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { create, engine, fake } = await setup(
      { concurrencyCap: 1, modeId: null },
      {
        lane: async (_agentId, _paseo, config) => {
          entered();
          await reading;
          return { name: "your Settings", provider: config.provider, modeId: config.modeId };
        },
      },
    );
    const theirs = await create({ dispatch: false });
    const mine = await create({ dispatch: false });
    const refused = engine.dispatch(fake.paseo, theirs.id, lane).then(
      () => "started",
      (error: Error) => error.message,
    );
    await inside;
    // The session's start is still reading its profile: it has taken no slot, so your Dispatch at cap 1 starts.
    expect((await engine.dispatch(fake.paseo, mine.id)).state).toBe("running");
    release();
    expect(await refused).toContain("your Settings name no mode for it");
    expect(fake.created).toHaveLength(1);
  });

  test("a lane profile that cannot be read refuses the start, saying it could not be read", async () => {
    const { create, engine, fake } = await setup(
      {},
      {
        lane: async () => {
          throw new Error("Paseo did not answer within 0.2s");
        },
      },
    );
    const item = await create({ dispatch: false });
    await expect(engine.dispatch(fake.paseo, item.id, lane)).rejects.toThrow(
      "Maestro could not read its profile (Paseo did not answer within 0.2s)",
    );
    expect(fake.created).toEqual([]);
  });

  test("modeId null never means Always ask for a run nobody watches: refused before any session starts", async () => {
    const { create, engine, fake, config, repo } = await setup({ modeId: null });
    // Whatever the calling session runs in: the profile is your Settings.
    fake.addSession("lane-1", { modeId: "bypassPermissions" });
    const item = await create({ dispatch: false });
    const refusals: Array<[string, () => void, RegExp]> = [
      ["no mode in Settings", () => undefined, /your Settings name no mode for it/],
      ["a Settings mode that asks", () => (config.modeId = "default"), /asks before it acts/],
    ];
    for (const [what, arrange, why] of refusals) {
      arrange();
      for (const by of ["lane-1", null]) {
        const refused = await engine.dispatch(fake.paseo, item.id, { actor: "agent", by }).then(
          () => "started",
          (error: Error) => error.message,
        );
        expect([what, refused]).toEqual([what, expect.stringMatching(why)]);
        expect(refused).toStartWith("A run nobody watches never starts in Always ask");
      }
    }
    // Work you gave another provider: Settings' mode is the Settings provider's, so it is not this run's.
    config.modeId = "bypassPermissions";
    const codex = await engine.create(fake.paseo, {
      title: "On codex",
      brief: "",
      repo,
      gate: "human",
      check: "",
      initiative: "",
      dispatch: false,
      provider: "codex/gpt-5.5",
    });
    await expect(engine.dispatch(fake.paseo, codex.id, lane)).rejects.toThrow("the mode in your Settings is claude's");
    expect(fake.created).toEqual([]);
    expect((await engine.get(item.id)).item.state).toBe("proposed");
    // You may still start it.
    expect((await engine.dispatch(fake.paseo, item.id)).state).toBe("running");
  });
});

describe("the cap through Stop and resume (BRO-2995 mi-1)", () => {
  /** agent-1's archive, held open until the test settles it. */
  const holdArchive = (fake: ReturnType<typeof fakePaseo>) => {
    let land: (error: Error | null) => void = () => undefined;
    const held = new Promise<{ archivedAt: string }>((resolve, reject) => {
      land = (error) => (error ? reject(error) : resolve({ archivedAt: new Date(clock).toISOString() }));
    });
    const ref = fake.paseo.agents.ref;
    fake.paseo.agents.ref = (id: string) => (id === "agent-1" ? { ...ref(id), archive: () => held } : ref(id));
    return land;
  };

  test("a run being stopped keeps its slot until the archive settles; a failed archive puts it back, the cap whole", async () => {
    const { create, engine, fake } = await setup({ concurrencyCap: 1 });
    const stopped = await create();
    const next = await create({ dispatch: false });
    const land = holdArchive(fake);
    const stopping = engine.stopRun(fake.paseo, stopped.id, DISCARD);
    await settle(engine, stopped.id, "blocked");
    // Stuck by its files, which free the slot; the archive has not settled, so the run still holds it.
    await expect(engine.dispatch(fake.paseo, next.id)).rejects.toThrow(
      "At capacity: 1 of 1 slot taken (1 being stopped). It stays queued.",
    );
    land(new Error("daemon busy"));
    await expect(stopping).rejects.toThrow("Could not stop the session: daemon busy");
    expect((await engine.get(stopped.id)).item.state).toBe("running");
    await expect(engine.dispatch(fake.paseo, next.id)).rejects.toThrow("At capacity: 1 of 1 slot taken (1 running).");
    expect(fake.created).toHaveLength(1);
  });

  test("once the archive lands the slot is free", async () => {
    const { create, engine, fake } = await setup({ concurrencyCap: 1 });
    const stopped = await create();
    const next = await create({ dispatch: false });
    const land = holdArchive(fake);
    const stopping = engine.stopRun(fake.paseo, stopped.id, DISCARD);
    await settle(engine, stopped.id, "blocked");
    await expect(engine.dispatch(fake.paseo, next.id)).rejects.toThrow("(1 being stopped)");
    land(null);
    expect((await stopping).state).toBe("blocked");
    expect((await engine.dispatch(fake.paseo, next.id)).state).toBe("running");
  });

  test("a stop that begins while a dispatch reads the files is counted by that dispatch", async () => {
    let gate: Promise<void> | null = null;
    let open: () => void = () => undefined;
    let real: MaestroConfig | null = null;
    const { create, engine, fake, config } = await setup(
      { concurrencyCap: 1 },
      {
        // The first read of Settings after the gate is set waits for it: the dispatch's, after it took its slot.
        config: async () => {
          const waiting = gate;
          gate = null;
          if (waiting) await waiting;
          return real as MaestroConfig;
        },
      },
    );
    real = config;
    const stopped = await create();
    const next = await create({ dispatch: false });
    const land = holdArchive(fake);
    gate = new Promise((resolve) => {
      open = resolve;
    });
    const dispatching = engine.dispatch(fake.paseo, next.id);
    // The stop starts after the dispatch listed the runs being stopped, and is recorded before it reads the files.
    const stopping = engine.stopRun(fake.paseo, stopped.id, DISCARD);
    await settle(engine, stopped.id, "blocked");
    open();
    await expect(dispatching).rejects.toThrow("At capacity: 1 of 1 slot taken (1 being stopped).");
    land(new Error("daemon busy"));
    await expect(stopping).rejects.toThrow("Could not stop the session");
    expect((await engine.get(stopped.id)).item.state).toBe("running");
    expect(fake.created).toHaveLength(1);
  });

  test("work whose session resumes it while the cap is full runs, and the work says it is over the cap", async () => {
    const { create, engine, fake } = await setup({ concurrencyCap: 1 });
    const first = await create();
    await engine.stopRun(fake.paseo, first.id, DISCARD);
    expect(fake.archived).toEqual(["agent-1"]);
    const second = await create();
    expect(second.state).toBe("running");
    // You open the stopped session in Paseo and prompt it: its turn is under way, not Maestro's to refuse.
    const session = fake.agents.get("agent-1");
    if (session) Object.assign(session, { archivedAt: null, status: "running" });
    await engine.onTurnStarted({ id: "agent-1" });
    const { item, events } = await engine.get(first.id);
    expect(item.state).toBe("running");
    expect(events.map((event) => event.text)).toContain(
      "Resumed in the session over the cap: 2 of 1 slot taken (2 running). No run starts until one ends.",
    );
    const third = await create({ dispatch: false });
    await expect(engine.dispatch(fake.paseo, third.id)).rejects.toThrow("At capacity: 2 of 1 slot taken (2 running)");
  });

  test("continuing at your gate in the session takes a slot too: over the cap, the work says so", async () => {
    const { create, engine, fake } = await setup({ concurrencyCap: 1 });
    const first = await create();
    const session = fake.agents.get("agent-1");
    if (session) session.status = "idle";
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "completed" }, []);
    expect((await engine.get(first.id)).item.state).toBe("review");
    // At your gate with nothing pending, it holds no slot: another run starts.
    expect((await create()).state).toBe("running");
    // You reply in the first session: it runs again, one over the cap, and says so.
    await engine.onTurnStarted({ id: "agent-1" });
    const { item, events } = await engine.get(first.id);
    expect(item.state).toBe("running");
    expect(events.map((event) => event.text)).toContain(
      "Resumed in the session over the cap: 2 of 1 slot taken (2 running). No run starts until one ends.",
    );
  });

  test("a resume under the cap says nothing more than that it resumed", async () => {
    const { create, engine, fake } = await setup({ concurrencyCap: 2 });
    const first = await create();
    await engine.stopRun(fake.paseo, first.id, DISCARD);
    await create();
    const session = fake.agents.get("agent-1");
    if (session) Object.assign(session, { archivedAt: null, status: "running" });
    await engine.onTurnStarted({ id: "agent-1" });
    const { item, events } = await engine.get(first.id);
    expect(item.state).toBe("running");
    expect(events.some((event) => event.text?.startsWith("Resumed in the session over the cap"))).toBe(false);
  });

  test("unblocking work whose session had gone takes a slot: refused at the cap, as a start is", async () => {
    const { create, engine, fake } = await setup({ concurrencyCap: 1 });
    const first = await create();
    // Archived mid-run: stuck, and its slot is free.
    const session = fake.agents.get("agent-1");
    if (session) session.archivedAt = new Date(clock).toISOString();
    await engine.onArchived({ id: "agent-1" });
    expect((await engine.get(first.id)).item.state).toBe("blocked");
    const second = await create();
    expect(second.state).toBe("running");
    // The session is back (unarchived in Paseo), so Unblock would wake it: one more run than the cap.
    if (session) Object.assign(session, { archivedAt: null, status: "idle" });
    await expect(engine.unblock(fake.paseo, first.id, "go on")).rejects.toThrow(
      "At capacity: 1 of 1 slot taken (1 running).",
    );
    expect(fake.sent).toEqual([]);
    expect((await engine.get(first.id)).item.state).toBe("blocked");
    await engine.stopRun(fake.paseo, second.id, DISCARD);
    expect((await engine.unblock(fake.paseo, first.id, "go on")).state).toBe("running");
    expect(fake.sent).toEqual([{ agentId: "agent-1", text: "go on" }]);
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

describe("a finished arc closes itself once its session is archived (BRO-2861)", () => {
  const said = (text: string) => [
    { type: "user_message" as const, text: "go" },
    { type: "assistant_message" as const, text },
  ];
  /** The daemon archives the session, then its hook fires (here without the daemon's client unless given). */
  const archive = async (
    engine: Engine,
    fake: ReturnType<typeof fakePaseo>,
    hook: "none" | "bare" | "client" = "bare",
  ) => {
    const agent = fake.agents.get("agent-1");
    if (agent) agent.archivedAt = new Date(clock).toISOString();
    if (hook !== "none") await engine.onArchived({ id: "agent-1" }, hook === "client" ? fake.paseo : null);
  };

  test("CLOSED, then archived: the next sweep closes it, receipted as Maestro's, and the card says why", async () => {
    const { create, engine, fake } = await setup();
    const item = await create();
    await endTurn(engine, fake, said("Merged #12.\n\nARC-STATUS: CLOSED"));
    await archive(engine, fake);
    // The hook only notes the archive: the close is reconcile's, in the next sweep.
    expect((await engine.get(item.id)).item.state).toBe("review");
    tick(1);
    await engine.upkeep(fake.paseo);
    const { item: closed, events } = await engine.get(item.id);
    expect(closed.state).toBe("done");
    expect(closed.verdict).toBe("Its arc reported “ARC-STATUS: CLOSED” and its session was archived");
    expect(closed.closed?.by).toBe("maestro");
    expect(events.at(-1)).toMatchObject({
      type: "state",
      actor: "maestro",
      text: "Done",
      detail: "Its arc reported “ARC-STATUS: CLOSED” and its session was archived",
    });
  });

  test("its hook carrying the daemon's client closes it at once, with no sweep", async () => {
    const { create, engine, fake } = await setup();
    const item = await create();
    await endTurn(engine, fake, said("ARC-STATUS: CLOSED"));
    await archive(engine, fake, "client");
    expect((await engine.get(item.id)).item.state).toBe("done");
  });

  test("a self-closed run's workspace receipt says it stays done, not that an approval stands", async () => {
    const { create, engine, fake, repo } = await setup({ archiveOnApprove: true });
    const item = await create();
    cleanWorktree(repo, item.worker);
    await endTurn(engine, fake, said("ARC-STATUS: CLOSED"));
    fake.paseo.workspaces.archive = (async (workspaceId: string) => ({
      requestId: "r",
      workspaceId,
      archivedAt: null,
      error: "busy",
    })) as typeof fake.paseo.workspaces.archive;
    await archive(engine, fake, "client");
    const { events } = await engine.get(item.id);
    expect(events.at(-1)?.text).toBe("Could not archive the workspace: busy. It stays done.");
  });

  test("a handback from a session you adopted waits on you after its archive (BRO-2903 is only an orchestrator's)", async () => {
    const { engine, fake, repo } = await setup();
    fake.agents.set("agent-1", {
      id: "agent-1",
      cwd: repo,
      status: "running",
      workspaceId: "ws-1",
      provider: "claude",
      title: "Mine",
      archivedAt: null,
      pendingPermissions: [],
      activeTurn: null,
    });
    const item = await engine.adopt(fake.paseo, "agent-1", "");
    const agent = fake.agents.get("agent-1");
    if (agent) agent.status = "idle";
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "completed" }, said("Merged.\n\nARC-STATUS: HANDBACK 1"), "t1");
    expect((await engine.get(item.id)).item.state).toBe("review");
    await archive(engine, fake, "client");
    expect((await engine.get(item.id)).item.state).toBe("review");
  });

  test("HANDBACK, or no verdict, waits on you after the archive, as before", async () => {
    for (const text of ["Left you one.\n\nARC-STATUS: HANDBACK 1", "Done, I think.", "**ARC-STATUS:** done"]) {
      const { create, engine, fake } = await setup();
      const item = await create();
      await endTurn(engine, fake, said(text));
      await archive(engine, fake);
      tick(1);
      await engine.upkeep(fake.paseo);
      expect((await engine.get(item.id)).item.state).toBe("review");
    }
  });

  test("not archived, a finished arc still waits: the archive is half of the rule", async () => {
    const { create, engine, fake } = await setup();
    const item = await create();
    await endTurn(engine, fake, said("ARC-STATUS: DONE"));
    tick(10);
    await engine.upkeep(fake.paseo);
    expect((await engine.get(item.id)).item.state).toBe("review");
  });

  test("its archive hook missed: the daemon's archive is enough, and its note is written with the close", async () => {
    const { create, engine, fake } = await setup();
    const item = await create();
    await endTurn(engine, fake, said("ARC-STATUS: MERGED"));
    await archive(engine, fake, "none");
    tick(1);
    await engine.upkeep(fake.paseo);
    const { item: closed, events } = await engine.get(item.id);
    expect(closed).toMatchObject({
      state: "done",
      verdict: "Its arc reported “ARC-STATUS: MERGED” and its session was archived",
    });
    expect(events.map((event) => event.text)).toContain(ARCHIVED_NOTE);
  });

  test("with archive on approve, the run's workspace goes as an approval's would; off, it stays", async () => {
    for (const on of [true, false]) {
      const { create, engine, fake, repo } = await setup({ archiveOnApprove: on });
      const item = await create();
      cleanWorktree(repo, item.worker);
      await endTurn(engine, fake, said("ARC-STATUS: CLOSED"));
      await archive(engine, fake);
      tick(1);
      await engine.upkeep(fake.paseo);
      expect((await engine.get(item.id)).item.state).toBe("done");
      expect(fake.archivedWorkspaces).toEqual(on ? ["ws-1"] : []);
    }
  });

  test("a decision of yours in its undo window wins: Cancel work lands as canceled, not done", async () => {
    const { create, engine, fake, timers } = await setup();
    const item = await create();
    await endTurn(engine, fake, said("ARC-STATUS: CLOSED"));
    await engine.verdict(fake.paseo, item.id, "block", "");
    await archive(engine, fake);
    // Inside the undo window: the sweep's reconcile leaves it at the gate, your decision still pending.
    await engine.upkeep(fake.paseo);
    expect((await engine.get(item.id)).item).toMatchObject({ state: "review", pending: { verdict: "block" } });
    tickMs(UNDO_MS);
    await timers.fire();
    expect((await engine.get(item.id)).item.state).toBe("canceled");
  });
});

describe("an orchestrator archiving its child between turns closes it, not as stuck (BRO-2928)", () => {
  const said = (text: string) => [{ type: "assistant_message" as const, text }];
  const session = (repo: string) => ({
    id: "child",
    cwd: repo,
    status: "idle" as const,
    workspaceId: "ws-x",
    provider: "claude",
    title: "SRI: STI-3605 bypass per member",
    archivedAt: null as string | null,
    pendingPermissions: [],
    activeTurn: null,
  });

  test("an arc between steps, archived by its orchestrator: canceled, by Maestro, Handled for you, never done", async () => {
    const { engine, fake, repo } = await setup();
    fake.agents.set("child", session(repo));
    fake.timelines.set("child", said("Opened the PR; waiting for its checks."));
    const item = await engine.adopt(fake.paseo, "child", "", { actor: "agent", by: "orchestrator" });
    expect(item.state).toBe("running");
    const agent = fake.agents.get("child");
    if (agent) agent.archivedAt = new Date(clock).toISOString();
    await engine.onArchived({ id: "child" }, fake.paseo);
    const { item: closed } = await engine.get(item.id);
    expect([closed.state, closed.closed?.by]).toEqual(["canceled", "maestro"]);
    // The card says what happened, never "You canceled it".
    expect(closed.verdict).toBe(
      "Its session was archived between turns, after a turn that reported no error: an orchestrator's arc, closed, not stuck",
    );
    const { events } = await engine.get(item.id);
    expect(events.at(-1)).toMatchObject({
      type: "state",
      text: "Canceled",
      detail:
        "Its session was archived between turns, after a turn that reported no error: an orchestrator's arc, closed, not stuck",
    });
  });
});

describe("adopted arcs land at your gate only with something to decide (BRO-2864)", () => {
  /** An orchestrator adopting the session it just started, mid-turn, as the SRI orchestrator does. */
  async function adopted() {
    const s = await setup();
    s.fake.agents.set("arc", {
      id: "arc",
      cwd: s.repo,
      status: "running",
      updatedAt: new Date(clock).toISOString(),
      workspaceId: "ws-arc",
      provider: "claude",
      title: "SRI: STI-3492 organisation referrers (arc)",
      archivedAt: null,
      pendingPermissions: [],
      activeTurn: null,
    });
    // An orchestrator tracks the arc it started (fleet tick-prompt: `maestro track`), as the SRI orchestrator does.
    const item = await s.engine.adopt(s.fake.paseo, "arc", "", { actor: "agent", by: "orchestrator" });
    expect(item.state).toBe("running");
    const said = (text: string) => [{ type: "assistant_message" as const, text }];
    // Each end carries its provider turn id, as Paseo's hook does: without one a second end reads as a repeat.
    let turns = 0;
    const end = (text: string, outcome: Parameters<Engine["onTurnEnded"]>[1] = { kind: "completed" }) => {
      const agent = s.fake.agents.get("arc");
      if (agent) agent.status = "idle";
      return s.engine.onTurnEnded({ id: "arc" }, outcome, said(text), `turn-${++turns}`);
    };
    return { ...s, item, end };
  }

  test("its orchestrator archiving a handed-back arc closes it, receipted as the orchestrator's (BRO-2903)", async () => {
    const { engine, fake, item, end } = await adopted();
    tick(17);
    await end("Merged #2134.\n\nARC-STATUS: HANDBACK 1");
    expect((await engine.get(item.id)).item.state).toBe("review");
    const agent = fake.agents.get("arc");
    if (agent) agent.archivedAt = new Date(clock).toISOString();
    await engine.onArchived({ id: "arc" }, fake.paseo);
    const { item: closed, events } = await engine.get(item.id);
    expect(closed.state).toBe("done");
    expect(events.at(-1)).toMatchObject({
      type: "state",
      actor: "maestro",
      text: "Done",
      detail: "Its orchestrator (session orchestr) took it back and archived its session",
    });
  });

  test("its orchestrator archiving an arc whose session died closes it with the same plain receipt (BRO-2903)", async () => {
    const { engine, fake, item, store } = await adopted();
    // Landed before the handback rule (or recovered), its last words the error the session died on.
    await store.mutate(item.id, () => ({
      to: "review",
      events: [
        {
          ts: new Date(clock).toISOString(),
          type: "turn.ended",
          actor: "agent",
          agentId: "arc",
          outcome: "completed",
          error: null,
          summary: "Your organization has disabled Claude subscription access for Claude Code",
          turnId: "dead",
        },
      ],
    }));
    const agent = fake.agents.get("arc");
    if (agent) {
      agent.status = "idle";
      agent.archivedAt = new Date(clock).toISOString();
    }
    await engine.onArchived({ id: "arc" }, fake.paseo);
    const { item: after, events } = await engine.get(item.id);
    expect(after.state).toBe("done");
    expect(events.at(-1)).toMatchObject({
      type: "state",
      actor: "maestro",
      detail: "Its orchestrator (session orchestr) took it back and archived its session",
    });
  });

  test("a turn that hands nothing back is the arc between steps: it stays running, and no card is left", async () => {
    const { engine, fake, item, end } = await adopted();
    tick(17);
    await end("Engine test suite is running in the background; meanwhile typechecking the touched packages.");
    const { item: after, events } = await engine.get(item.id);
    expect(after.state).toBe("running");
    expect(events.at(-1)).toMatchObject({ type: "turn.ended", text: "Turn finished" });
    expect(after.landing ?? null).toBeNull();
    await Promise.resolve();
    expect(fake.appended).toEqual([]);
  });

  test("a verdict lands it, in ctx-core's grammar or only meaning one, and so does an ask; the card shows each", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      [
        "Merged #2134.\n\nARC-STATUS: CLOSED",
        { arc: { status: "CLOSED", line: "ARC-STATUS: CLOSED" }, closing: "Merged #2134." },
      ],
      [
        "Checks 1–6 are complete.\n\n**ARC-STATUS:** done with handback.",
        {
          ask: "It ended with “ARC-STATUS: done with handback.”. Approve to close the work, or send it back with a note.",
          arc: { status: "", line: "ARC-STATUS: done with handback." },
          closing: "Checks 1–6 are complete.",
        },
      ],
      [
        "Built it.\n\n## Ask\n- Merge #12 or hold it for the release?",
        { ask: "Merge #12 or hold it for the release?" },
      ],
      [
        "## ⛔ Blocked on you — 1 item, ~2 min\n\n| # | ask |\n|---|---|\n| 1 | Merge #12 |",
        { ask: "⛔ Blocked on you — 1 item, ~2 min", handed: "| # | ask |\n|---|---|\n| 1 | Merge #12 |" },
      ],
    ];
    for (const [text, look] of cases) {
      const { engine, item, end } = await adopted();
      tick(5);
      await end(text);
      const { item: landed } = await engine.get(item.id);
      expect(landed.state).toBe("review");
      expect(landed.look).toMatchObject(look);
    }
  });

  test("a canceled turn (a restart, or its orchestrator steering it) stays running; a failed one is stuck", async () => {
    const canceled = await adopted();
    await canceled.end("Running the live DB drill.", { kind: "canceled", reason: "interrupted" });
    expect((await canceled.engine.get(canceled.item.id)).item.state).toBe("running");
    const failed = await adopted();
    await failed.end("Running the live DB drill.", { kind: "failed", error: { message: "API overloaded" } });
    expect((await failed.engine.get(failed.item.id)).item).toMatchObject({
      state: "blocked",
      reason: "API overloaded",
    });
  });

  test("work at your gate whose session goes on without a verdict leaves the gate", async () => {
    const { engine, item, end } = await adopted();
    await end("## Ask\n- Keep the 100-company bound?");
    expect((await engine.get(item.id)).item.state).toBe("review");
    tick(3);
    await end("Rebased onto main; re-running the touched suites.");
    const { item: after, events } = await engine.get(item.id);
    expect(after.state).toBe("running");
    expect(events.at(-1)).toMatchObject({
      type: "state",
      detail: "The session kept working on its arc; it handed you nothing to decide",
    });
  });

  test("with no turn ids at all, a later turn that says something else is new: its handback lands", async () => {
    const { engine, item } = await adopted();
    const said = (text: string) => [{ type: "assistant_message" as const, text }];
    await engine.onTurnEnded({ id: "arc" }, { kind: "completed" }, said("Typechecking the touched packages."), null);
    expect((await engine.get(item.id)).item.state).toBe("running");
    // Its start hook was missed and the end carries no id: only its words tell it from a repeat.
    await engine.onTurnEnded({ id: "arc" }, { kind: "completed" }, said("Typechecking the touched packages."), null);
    expect((await engine.get(item.id)).events.filter((e) => e.type === "turn.ended")).toHaveLength(1);
    await engine.onTurnEnded({ id: "arc" }, { kind: "completed" }, said("PR open.\n\nARC-STATUS: HANDBACK 1"), null);
    expect((await engine.get(item.id)).item).toMatchObject({
      state: "review",
      look: { arc: { status: "HANDBACK", line: "ARC-STATUS: HANDBACK 1" } },
    });
  });

  test("your Send back is a task: the session's answer to your note lands, whatever it says", async () => {
    const { engine, item, end, decide } = await adopted();
    await end("## Ask\n- Keep the 100-company bound?");
    expect((await decide(item.id, "revise", "Why 100? explain")).state).toBe("running");
    tick(2);
    const answer = "100 matches the upstream page size; lowering it doubles the calls. I kept it.";
    await end(answer);
    expect((await engine.get(item.id)).item).toMatchObject({ state: "review", look: { ask: "", closing: answer } });
    // Answered, it is the arc's again: sent back to carry on, its answer lands, and the turns after it do not.
    await decide(item.id, "revise", "Use 50, then carry on with the arc");
    await end("Set it to 50.");
    expect((await engine.get(item.id)).item.state).toBe("review");
    await decide(item.id, "revise", "Good, carry on");
    await end("Carrying on: rebased, the engine suite runs in the background.");
    expect((await engine.get(item.id)).item.state).toBe("review");
    await end("Typechecking the touched packages next.");
    expect((await engine.get(item.id)).item.state).toBe("running");
  });

  test("an Unblock is a task too: the turn that answers it lands, the arc's turns after it do not", async () => {
    const { engine, fake, item, end } = await adopted();
    await end("Running the live DB drill.", { kind: "failed", error: { message: "API overloaded" } });
    expect((await engine.get(item.id)).item.state).toBe("blocked");
    expect((await engine.unblock(fake.paseo, item.id, "")).state).toBe("running");
    await end("Picked up where I stopped: the drill passes on the branch.");
    expect((await engine.get(item.id)).item.state).toBe("review");
  });

  test("after an answered Unblock, the arc's own turns stay running", async () => {
    const { engine, fake, item, end } = await adopted();
    await end("Running the live DB drill.", { kind: "failed", error: { message: "API overloaded" } });
    await engine.unblock(fake.paseo, item.id, "");
    await end("Picked up where I stopped: the drill passes on the branch.");
    expect((await engine.get(item.id)).item.state).toBe("review");
    // You leave it to its arc: the session goes on, and its next turns are the arc between steps.
    const agent = fake.agents.get("arc");
    if (agent) agent.status = "running";
    await engine.onTurnStarted({ id: "arc" });
    expect((await engine.get(item.id)).item.state).toBe("running");
    await end("Rebased onto main; re-running the touched suites.");
    await end("Typechecking the touched packages next.");
    expect((await engine.get(item.id)).item.state).toBe("running");
  });

  test("replay of STI-3492: a reload finds the arc idle mid-work, keeps it running, and does not re-read it", async () => {
    const { engine, fake, item } = await adopted();
    // 19:54 adopted; 20:11 the plugin reloads while the session waits on a background test run.
    tick(17);
    const stopped = new Date(clock).toISOString();
    const agent = fake.agents.get("arc");
    if (agent) agent.status = "idle";
    fake.setLastActivityAt("arc", stopped);
    fake.timelines.set("arc", [
      { type: "user_message", text: "Start the STI-3492 organisation-referrers arc." },
      {
        type: "assistant_message",
        text: "Adding `referrerSample` to the catalog card schema, then the app card, approval route and run bound.",
      },
    ]);
    fake.timelineEnd.set("arc", stopped);
    fake.timelineTurn.set("arc", "turn-before-reload");
    tick(1);
    await engine.upkeep(fake.paseo);
    const read = await engine.get(item.id);
    expect(read.item.state).toBe("running");
    expect(read.events.at(-1)).toMatchObject({ type: "turn.ended", ts: stopped });
    expect(fake.refetched).toEqual(["arc"]);
    // The next reconcile sees its end on record and nothing since: no second read, no second end.
    tick(1);
    await engine.upkeep(fake.paseo);
    expect(fake.refetched).toEqual(["arc"]);
    expect((await engine.get(item.id)).events).toHaveLength(read.events.length);
    expect(fake.appended).toEqual([]);
    // It works again, and its hooks are missed once more: the daemon's word that it changed reads it again, and
    // the turn that hands you something lands, as it would have live.
    tick(20);
    fake.setLastActivityAt("arc", new Date(clock).toISOString());
    fake.timelines.set("arc", [
      { type: "assistant_message", text: "PR #2134 is open.\n\n## Ask\n- Merge #2134 once its checks pass?" },
    ]);
    fake.timelineTurn.set("arc", "turn-after-restart");
    fake.timelineEnd.set("arc", new Date(clock).toISOString());
    tick(2);
    await engine.upkeep(fake.paseo);
    expect(fake.refetched).toEqual(["arc", "arc"]);
    expect((await engine.get(item.id)).item).toMatchObject({
      state: "review",
      look: { ask: "Merge #2134 once its checks pass?" },
    });
  });

  test("dispatched work keeps its contract: one task, so a run that asks nothing still lands, with its last words", async () => {
    const { create, engine, fake } = await setup();
    const item = await create();
    await endTurn(engine, fake, [{ type: "assistant_message", text: "Stored it on the Run record; tests pass." }]);
    expect((await engine.get(item.id)).item).toMatchObject({
      state: "review",
      look: { ask: "", closing: "Stored it on the Run record; tests pass." },
    });
  });
});

describe("an orchestrator's child whose branch merged after its session ended (BRO-2923)", () => {
  const ORCHESTRATOR = { actor: "agent" as const, by: "orchestrator" };
  const recorded = { git: async () => ({ branch: "feature/x", githubRepo: "acme/app" }) };
  const AFTER = "2026-09-22T10:00:00Z";
  const merged =
    (mergedAt: string, asked: string[][] = []) =>
    async (repo: string, branch: string) => {
      asked.push([repo, branch]);
      return { number: 7, mergedAt };
    };
  /** A running session in the work's repo, adopted, then archived before it finished. */
  const adoptAndArchive = async (
    { engine, fake, repo }: Awaited<ReturnType<typeof setup>>,
    origin?: { actor: "agent" | "human"; by: string | null },
  ) => {
    fake.agents.set("child", {
      id: "child",
      cwd: repo,
      status: "running",
      workspaceId: null,
      provider: "claude",
      title: "Child arc",
      archivedAt: null,
    } as never);
    const item = await engine.adopt(fake.paseo, "child", "", origin as never);
    await engine.onArchived({ id: "child" });
    return item;
  };

  test("archived between turns with a watched branch: never canceled; it closes Done when the branch merges (BRO-2928)", async () => {
    let answer: { number: number; mergedAt: string } | null = null;
    const env = await setup({}, { ...recorded, merged: async () => answer });
    const { engine, fake, repo } = env;
    fake.agents.set("child", {
      id: "child",
      cwd: repo,
      status: "idle",
      workspaceId: null,
      provider: "claude",
      title: "Child arc",
      archivedAt: null,
      pendingPermissions: [],
      activeTurn: null,
    } as never);
    fake.timelines.set("child", [{ type: "assistant_message", text: "Pushed; the PR is open." }]);
    const item = await engine.adopt(fake.paseo, "child", "", ORCHESTRATOR);
    expect(item.state).toBe("running");
    const agent = fake.agents.get("child");
    if (agent) agent.archivedAt = new Date(clock).toISOString();
    await engine.onArchived({ id: "child" }, fake.paseo);
    // No merge seen, however long: its branch may still land, so it stays stuck (gh unknown or not merged alike).
    for (const minutes of [3, 60, 24 * 60]) {
      tick(minutes);
      await engine.upkeep(fake.paseo);
      expect((await engine.get(item.id)).item.state).toBe("blocked");
    }
    // The merge comes: Done, by branchMerged's receipt.
    answer = { number: 7, mergedAt: new Date(clock).toISOString() };
    tick(1);
    await engine.upkeep(fake.paseo);
    expect((await engine.get(item.id)).item.state).toBe("done");
  });

  test("it closes Done once its branch merged, the PR as its receipt; the adoption recorded branch and repo", async () => {
    const asked: string[][] = [];
    const env = await setup({}, { ...recorded, merged: merged(AFTER, asked) });
    const item = await adoptAndArchive(env, ORCHESTRATOR);
    const bind = (await env.store.findById(item.id)).events.find((event) => event.type === "adopted");
    expect(bind && "branch" in bind ? [bind.branch, bind.githubRepo] : null).toEqual(["feature/x", "acme/app"]);
    expect((await env.engine.get(item.id)).item.state).toBe("blocked");
    await env.engine.upkeep(env.fake.paseo);
    const { item: after } = await env.engine.get(item.id);
    expect([after.state, after.verdict, asked]).toEqual([
      "done",
      "Its branch feature/x merged as acme/app#7 after it was adopted",
      [["acme/app", "feature/x"]],
    ]);
  });

  test("a child you sent back before its session died is yours: it stays Stuck though its branch merged", async () => {
    const asked: string[][] = [];
    const env = await setup({}, { ...recorded, merged: merged(AFTER, asked) });
    env.fake.agents.set("child", {
      id: "child",
      cwd: env.repo,
      status: "running",
      workspaceId: null,
      provider: "claude",
      title: "Child arc",
      archivedAt: null,
    } as never);
    const item = await env.engine.adopt(env.fake.paseo, "child", "", ORCHESTRATOR);
    await env.engine.onTurnEnded({ id: "child" }, { kind: "completed" }, [
      { type: "assistant_message", text: "## Ask\nMerge it?" },
    ] as never);
    expect((await env.engine.get(item.id)).item.state).toBe("review");
    const child = env.fake.agents.get("child");
    if (child) child.status = "idle";
    await env.decide(item.id, "revise", "Do not merge: change X first");
    await env.engine.onArchived({ id: "child" });
    await env.engine.upkeep(env.fake.paseo);
    expect([(await env.engine.get(item.id)).item.state, asked.length]).toEqual(["blocked", 0]);
  });

  test("a session you adopted is yours to close: it stays Stuck, and gh is not asked", async () => {
    const asked: string[][] = [];
    const env = await setup({}, { ...recorded, merged: merged(AFTER, asked) });
    const item = await adoptAndArchive(env);
    await env.engine.upkeep(env.fake.paseo);
    expect([(await env.engine.get(item.id)).item.state, asked.length]).toEqual(["blocked", 0]);
  });

  test("a dispatched run is yours to close: it stays Stuck, and gh is not asked", async () => {
    const asked: string[][] = [];
    const { create, engine, fake } = await setup({}, { ...recorded, merged: merged(AFTER, asked) });
    const item = await create();
    await engine.onArchived({ id: "agent-1" });
    await engine.upkeep(fake.paseo);
    expect([(await engine.get(item.id)).item.state, asked.length]).toEqual(["blocked", 0]);
  });

  test("a PR merged before the adoption is an old one on a reused branch: it stays Stuck", async () => {
    const env = await setup({}, { ...recorded, merged: merged("2026-09-01T00:00:00Z") });
    const item = await adoptAndArchive(env, ORCHESTRATOR);
    await env.engine.upkeep(env.fake.paseo);
    expect((await env.engine.get(item.id)).item.state).toBe("blocked");
  });

  test("a shared checkout or detached HEAD records no branch: it stays Stuck, and gh is not asked", async () => {
    const asked: string[][] = [];
    const env = await setup(
      {},
      { git: async () => ({ branch: null, githubRepo: "acme/app" }), merged: merged(AFTER, asked) },
    );
    const item = await adoptAndArchive(env, ORCHESTRATOR);
    await env.engine.upkeep(env.fake.paseo);
    expect([(await env.engine.get(item.id)).item.state, asked.length]).toEqual(["blocked", 0]);
  });
});
