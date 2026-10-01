import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MaestroConfig, WakeEntry } from "../shared/contracts";
import { defaultConfig } from "./config";
import { type CreateInput, Engine, MODED_BY_YOU, PROMPT_FREE, type Timer } from "./engine";
import { LOOP } from "./events";
import { fakePaseo } from "./fake-paseo";
import { ALREADY_WAKING, AT_RUN_CAP, Loop, NOT_CONNECTED, QUIET_MS } from "./loop";
import type { Paseo } from "./runs";
import { WorkStore } from "./store";
import { WakeLog } from "./wake-log";

let clock = Date.parse("2026-09-22T09:00:00.000Z");
const tickMinutes = (minutes: number) => {
  clock += minutes * 60_000;
};

beforeEach(() => {
  clock = Date.parse("2026-09-22T09:00:00.000Z");
});

/** Timers the test fires by hand, after moving the same clock the loop reads. */
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
    live: () => armed.filter((entry) => !entry.canceled),
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
  // Real path: the repository's path may not pass through a link, and macOS's tmpdir does (/var).
  const root = await realpath(await mkdtemp(join(tmpdir(), "maestro-loop-")));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  const config: MaestroConfig = {
    ...defaultConfig(),
    workRoot: join(root, "work"),
    provider: "claude",
    modeId: null,
    isolation: "worktree",
    ...overrides,
  };
  const engine = new Engine({
    now: () => new Date(clock),
    config: async () => config,
    log: () => {},
    timer: fakeTimers().timer,
    claimWaitMs: 200,
  });
  const fake = fakePaseo();
  const client: { paseo: Paseo | null } = { paseo: fake.paseo };
  const timers = fakeTimers();
  const logs: string[] = [];
  const wakeLog = new WakeLog(join(root, "wake-log.jsonl"), (message) => logs.push(message));
  const makeLoop = () =>
    new Loop({
      engine,
      client: () => client.paseo,
      now: () => new Date(clock),
      timer: timers.timer,
      wakeLog,
      log: (message) => logs.push(message),
    });
  /** Queued work, created as you create it in Maestro. */
  const queue = (title: string, extra: Partial<CreateInput> = {}) =>
    engine.create(fake.paseo, {
      title,
      brief: "",
      repo,
      gate: "human",
      check: "",
      initiative: "",
      dispatch: false,
      ...extra,
    });
  return {
    engine,
    fake,
    client,
    config,
    timers,
    wakeLog,
    logs,
    loop: makeLoop(),
    makeLoop,
    queue,
    store: new WorkStore(config.workRoot),
  };
}

/** A logged wake that ran at `wokeAt`, for tests of how the loop reads its cadence back. */
function ranAt(wokeAt: number, extra: Partial<WakeEntry> = {}): WakeEntry {
  return {
    tickId: `t-${wokeAt}`,
    cause: "timer",
    wokeAt: new Date(wokeAt).toISOString(),
    dispatched: [],
    deferred: [],
    needsYou: { gate: 0, stuck: 0, asking: 0 },
    quiet: [],
    narrative: ["Woke on a scheduled check.", "Did nothing new this tick."],
    ...extra,
  };
}

describe("the schedule", () => {
  test("off by default: nothing is armed, and nothing starts on its own", async () => {
    const { loop, queue, fake } = await setup();
    await queue("Waits for you");
    await loop.reschedule();
    expect(await loop.get()).toEqual({ minutes: null, nextAt: null, ticking: false, recent: [] });
    expect(fake.created).toEqual([]);
  });

  test("after a restart it arms a period after the last wake the log records; overdue is now", async () => {
    const { config, timers, wakeLog, makeLoop } = await setup({ loopMinutes: 10 });
    await wakeLog.append(ranAt(clock - 4 * 60_000));
    // A wake that was skipped did not run: the cadence keys off the one that did.
    await wakeLog.append(ranAt(clock - 60_000, { skipped: ALREADY_WAKING }));
    const restarted = makeLoop();
    await restarted.reschedule();
    expect(timers.live().map((entry) => entry.ms)).toEqual([6 * 60_000]);
    expect((await restarted.get()).nextAt).toBe(new Date(clock + 6 * 60_000).toISOString());

    config.loopMinutes = 3;
    await restarted.reschedule();
    expect(timers.live().map((entry) => entry.ms)).toEqual([0]);
    expect((await restarted.get()).nextAt).toBe(new Date(clock).toISOString());
  });

  test("with no wake in the log, the first is a period from now", async () => {
    const { loop, timers } = await setup({ loopMinutes: 15 });
    await loop.reschedule();
    expect(timers.live().map((entry) => entry.ms)).toEqual([15 * 60_000]);
  });

  test("a Settings change re-arms or disarms it", async () => {
    const { loop, timers, config } = await setup();
    await loop.reschedule();
    expect(timers.live()).toHaveLength(0);
    config.loopMinutes = 5;
    await loop.reschedule();
    expect(timers.live().map((entry) => entry.ms)).toEqual([5 * 60_000]);
    config.loopMinutes = 20;
    await loop.reschedule();
    expect(timers.live().map((entry) => entry.ms)).toEqual([20 * 60_000]);
    expect((await loop.get()).nextAt).toBe(new Date(clock + 20 * 60_000).toISOString());
    config.loopMinutes = null;
    await loop.reschedule();
    expect(timers.live()).toHaveLength(0);
    expect((await loop.get()).nextAt).toBeNull();
  });

  test("the timer wakes it when due and arms the next a period later; early or turned off, it only re-arms", async () => {
    const { loop, timers, queue, fake, config } = await setup({ loopMinutes: 5 });
    await queue("Start me");
    await loop.reschedule();
    // Fired before its time (a delay longer than a timer holds): nothing runs, it arms again.
    await timers.fire();
    expect(fake.created).toHaveLength(0);
    expect(timers.live().map((entry) => entry.ms)).toEqual([5 * 60_000]);

    tickMinutes(5);
    await timers.fire();
    expect(fake.created).toHaveLength(1);
    const [entry] = (await loop.get()).recent;
    expect(entry).toMatchObject({ cause: "timer", wokeAt: new Date(clock).toISOString() });
    expect(timers.live().map((armed) => armed.ms)).toEqual([5 * 60_000]);

    // Turned off since it was armed: it does not wake, and nothing is armed again.
    await queue("Not now");
    config.loopMinutes = null;
    tickMinutes(5);
    await timers.fire();
    expect(fake.created).toHaveLength(1);
    expect(timers.live()).toHaveLength(0);
  });

  test("stop leaves nothing armed", async () => {
    const { loop, timers } = await setup({ loopMinutes: 5 });
    await loop.reschedule();
    expect(timers.live()).toHaveLength(1);
    loop.stop();
    expect(timers.live()).toHaveLength(0);
    await loop.reschedule();
    expect(timers.live()).toHaveLength(0);
  });
});

describe("a wake", () => {
  test("starts queued work in order, triggered first, up to the run cap, and defers the rest at the cap", async () => {
    const { loop, queue, store, fake, engine } = await setup({ concurrencyCap: 3 });
    // One run already holds a slot.
    await engine.dispatch(fake.paseo, (await queue("Already running")).id);
    const a = await queue("A, oldest");
    tickMinutes(1);
    const b = await queue("B");
    tickMinutes(1);
    const c = await queue("C");
    tickMinutes(1);
    const d = await queue("D, triggered");
    await store.mutate(d.id, () => ({ to: "triggered" }));
    tickMinutes(1);
    const tried: string[] = [];
    const dispatch = engine.dispatch.bind(engine);
    engine.dispatch = ((paseo, id, origin) => {
      tried.push(id);
      return dispatch(paseo, id, origin);
    }) as typeof engine.dispatch;

    const entry = await loop.wake("manual");
    expect(entry.cause).toBe("manual");
    // Once dispatch refuses at the cap, the rest of the queue is not tried.
    expect(tried).toEqual([d.id, a.id, b.id]);
    expect(entry.dispatched).toEqual([
      { id: d.id, title: d.title },
      { id: a.id, title: a.title },
    ]);
    expect(entry.deferred).toEqual([
      { id: b.id, title: b.title, reason: AT_RUN_CAP },
      { id: c.id, title: c.title, reason: AT_RUN_CAP },
    ]);
    expect(fake.created).toHaveLength(3);
    expect((await engine.get(b.id)).item.state).toBe("proposed");
    expect(entry.narrative).toEqual([
      "Woke because you asked.",
      "Did:",
      "  Started D, triggered.",
      "  Started A, oldest.",
      "Left alone:",
      "  B: at the run cap.",
      "  C: at the run cap.",
    ]);
    // The start is the loop's: recorded as Maestro's, with a byline.
    const { events } = await engine.get(a.id);
    const dispatched = events.find((event) => event.text === "Dispatched");
    expect(dispatched).toMatchObject({ actor: "maestro" });
    expect(dispatched?.detail).toContain("by the loop");
    const raw = (await store.findById(a.id)).events;
    expect(raw.find((event) => event.type === "dispatched")).toMatchObject({ actor: "maestro", via: "loop" });
    expect(raw.at(-1)).toMatchObject({ type: "state", to: "running", actor: "maestro" });
    // It is in the log, newest first.
    expect((await loop.get()).recent[0]).toEqual(entry);
  });

  test("leaves work that skips permission prompts, or carries a mode you chose, to you", async () => {
    const { loop, queue, fake } = await setup();
    const bypass = await queue("Bypass", { modeId: "bypassPermissions" });
    tickMinutes(1);
    const auto = await queue("Auto accept", { provider: "opencode", featureValues: { auto_accept: true } });
    tickMinutes(1);
    const planned = await queue("Planned", { modeId: "plan" });
    tickMinutes(1);
    const plain = await queue("Plain");
    const entry = await loop.wake("manual");
    expect(entry.dispatched).toEqual([{ id: plain.id, title: plain.title }]);
    expect(entry.deferred).toEqual([
      { id: bypass.id, title: bypass.title, reason: PROMPT_FREE },
      { id: auto.id, title: auto.title, reason: PROMPT_FREE },
      { id: planned.id, title: planned.title, reason: MODED_BY_YOU },
    ]);
    expect(entry.narrative).toContain("  Bypass: runs without permission prompts; start it yourself.");
    expect(entry.narrative).toContain(`  Planned: ${MODED_BY_YOU}`);
    expect(fake.created).toHaveLength(1);
  });

  test("a Settings mode that skips prompts keeps the loop from starting anything", async () => {
    const { loop, queue, fake } = await setup({ modeId: "bypassPermissions" });
    const plain = await queue("Plain");
    const entry = await loop.wake("manual");
    expect(entry.dispatched).toEqual([]);
    expect(entry.deferred).toEqual([{ id: plain.id, title: plain.title, reason: PROMPT_FREE }]);
    expect(fake.created).toEqual([]);
  });

  test("never starts stuck work", async () => {
    const { loop, queue, engine, fake } = await setup();
    const item = await queue("Stuck one");
    await engine.dispatch(fake.paseo, item.id);
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "failed", error: { message: "boom" } }, []);
    expect((await engine.get(item.id)).item.state).toBe("blocked");
    const entry = await loop.wake("manual");
    expect(entry.dispatched).toEqual([]);
    expect(entry.deferred).toEqual([]);
    expect(entry.needsYou.stuck).toBe(1);
    expect(fake.created).toHaveLength(1);
  });

  test("a dispatch error is the reason, and the walk goes on", async () => {
    const { loop, queue, fake } = await setup();
    const first = await queue("First");
    const second = await queue("Second", { repo: join(tmpdir(), "maestro-loop-gone") }).catch(() => null);
    expect(second).toBeNull();
    const original = fake.paseo.providers.listModels;
    let calls = 0;
    fake.paseo.providers.listModels = (async (...args: Parameters<typeof original>) => {
      calls += 1;
      if (calls === 1) throw new Error("provider list unavailable");
      return original(...args);
    }) as typeof original;
    tickMinutes(1);
    const later = await queue("Later");
    const entry = await loop.wake("manual");
    expect(entry.deferred).toEqual([
      {
        id: first.id,
        title: first.title,
        reason: "could not start: Could not start the run: provider list unavailable",
      },
    ]);
    expect(entry.dispatched).toEqual([{ id: later.id, title: later.title }]);
  });

  test("a wake asked for while one runs is recorded as skipped, not queued", async () => {
    const { loop, queue, engine, fake } = await setup();
    await queue("Once");
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const list = engine.list.bind(engine);
    engine.list = (async (...args: Parameters<typeof list>) => {
      await held;
      return list(...args);
    }) as typeof engine.list;
    const first = loop.wake("manual");
    expect((await loop.get()).ticking).toBe(true);
    const second = await loop.wake("timer");
    expect(second).toMatchObject({ cause: "timer", skipped: ALREADY_WAKING, dispatched: [], deferred: [] });
    expect(second.narrative).toEqual(["Woke on a scheduled check.", "Skipped: another check was already running."]);
    release();
    const ran = await first;
    expect(ran.dispatched).toHaveLength(1);
    expect(fake.created).toHaveLength(1);
    const { recent, ticking } = await loop.get();
    expect(ticking).toBe(false);
    expect(recent.map((entry) => entry.tickId)).toEqual([ran.tickId, second.tickId]);
  });

  test("with no Paseo client it records that it could not start work, and the first client runs another", async () => {
    const { loop, queue, client, fake, timers } = await setup({ loopMinutes: 5 });
    await queue("Waiting for Paseo");
    client.paseo = null;
    const entry = await loop.wake("timer");
    expect(entry.dispatched).toEqual([]);
    expect(entry.narrative).toEqual(["Woke on a scheduled check.", NOT_CONNECTED, "Did nothing new this tick."]);
    expect(fake.created).toEqual([]);
    expect(timers.live().map((armed) => armed.ms)).toEqual([5 * 60_000]);

    client.paseo = fake.paseo;
    await loop.connected();
    expect(fake.created).toHaveLength(1);
    expect((await loop.get()).recent.map((logged) => logged.dispatched.length)).toEqual([1, 0]);
    // Only once: a second client handover does not wake it again.
    await loop.connected();
    expect((await loop.get()).recent).toHaveLength(2);
  });

  test("names running work quiet for 30 minutes, not 29", async () => {
    const { loop, queue, engine, fake } = await setup();
    const item = await queue("Long one");
    await engine.dispatch(fake.paseo, item.id);
    tickMinutes(29);
    expect((await loop.wake("manual")).quiet).toEqual([]);
    tickMinutes(1);
    const entry = await loop.wake("manual");
    expect(QUIET_MS).toBe(30 * 60_000);
    expect(entry.quiet).toEqual([{ id: item.id, title: item.title, minutes: 30 }]);
    expect(entry.narrative).toEqual([
      "Woke because you asked.",
      "Needs you:",
      "  Long one has been quiet 30 minutes, worth a look.",
      "Did nothing new this tick.",
    ]);
  });

  test("counts what needs you: at your gate, asking, stuck", async () => {
    const { loop, queue, engine, fake } = await setup({ concurrencyCap: null });
    for (const title of ["Gate", "Asking", "Stuck"]) await engine.dispatch(fake.paseo, (await queue(title)).id);
    const gate = fake.agents.get("agent-1");
    if (gate) gate.status = "idle";
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "completed" }, []);
    const asking = fake.agents.get("agent-2");
    if (asking) asking.pendingPermissions = [{ id: "perm-1", name: "Bash" }];
    await engine.onPermissionRequested({ id: "agent-2" }, { id: "perm-1", name: "Bash" } as never);
    await engine.onTurnEnded({ id: "agent-3" }, { kind: "failed", error: { message: "boom" } }, []);
    const entry = await loop.wake("manual");
    expect(entry.needsYou).toEqual({ gate: 1, asking: 1, stuck: 1 });
    expect(entry.narrative.slice(0, 5)).toEqual([
      "Woke because you asked.",
      "Needs you:",
      "  1 waiting at your gate.",
      "  1 asking you a question.",
      "  1 stuck.",
    ]);
  });

  test("the loop's start is not a look; yours is", async () => {
    const { loop, queue, engine, fake } = await setup();
    await queue("By the loop");
    const before = (await engine.list()).scoreboard.looks;
    expect((await loop.wake("manual")).dispatched).toHaveLength(1);
    expect((await engine.list()).scoreboard.looks).toBe(before);
    await engine.dispatch(fake.paseo, (await queue("By you")).id);
    expect((await engine.list()).scoreboard.looks).toBe(before + 1);
  });
});

describe("dispatch as the loop", () => {
  test("refuses stuck, prompt-free and moded work, which you may still start", async () => {
    const { queue, engine, fake } = await setup();
    const stuck = await queue("Stuck");
    await engine.dispatch(fake.paseo, stuck.id);
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "failed", error: { message: "boom" } }, []);
    await expect(engine.dispatch(fake.paseo, stuck.id, LOOP)).rejects.toThrow("The loop starts only queued work.");
    const bypass = await queue("Bypass", { modeId: "bypassPermissions" });
    await expect(engine.dispatch(fake.paseo, bypass.id, LOOP)).rejects.toThrow(PROMPT_FREE);
    const auto = await queue("Auto", { featureValues: { auto_accept: "true" } });
    await expect(engine.dispatch(fake.paseo, auto.id, LOOP)).rejects.toThrow(PROMPT_FREE);
    const planned = await queue("Planned", { modeId: "plan" });
    await expect(engine.dispatch(fake.paseo, planned.id, LOOP)).rejects.toThrow(MODED_BY_YOU);
    expect(fake.created).toHaveLength(1);
    // The same work is yours to start.
    expect((await engine.dispatch(fake.paseo, planned.id)).state).toBe("running");
  });

  test("refuses everything while Settings start runs without prompts", async () => {
    const { queue, engine, fake } = await setup({ modeId: "bypassPermissions" });
    const plain = await queue("Plain");
    await expect(engine.dispatch(fake.paseo, plain.id, LOOP)).rejects.toThrow(PROMPT_FREE);
    expect(fake.created).toEqual([]);
  });
});
