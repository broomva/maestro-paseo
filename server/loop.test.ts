import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MaestroConfig, WakeEntry } from "../shared/contracts";
import { attentionOf } from "./attention";
import { defaultConfig } from "./config";
import { type CreateInput, Engine, MODED_BY_YOU, NOT_QUIET, PROMPT_FREE, type Timer } from "./engine";
import { LOOP } from "./events";
import { fakePaseo } from "./fake-paseo";
import { ACTIVE_AGAIN, quietCleared, sessionActiveAt } from "./flags";
import { ALREADY_WAKING, ASK_NOT_CONNECTED, AT_RUN_CAP, FAILED_BEFORE, Loop, NOT_CONNECTED, QUIET_MS } from "./loop";
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
  // Sessions are stamped by the same clock, so one that does nothing is as quiet as its work.
  const fake = fakePaseo({ now: () => new Date(clock) });
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
      askMs: 100,
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
    unasked: [],
    flagged: [],
    cleared: [],
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

  test("after the cap, work the loop never starts keeps its own reason, not the cap's", async () => {
    const { loop, queue, fake } = await setup({ concurrencyCap: 1 });
    const first = await queue("First");
    tickMinutes(1);
    const second = await queue("Second");
    tickMinutes(1);
    const bypass = await queue("Bypass", { modeId: "bypassPermissions" });
    tickMinutes(1);
    const planned = await queue("Planned", { modeId: "plan" });
    tickMinutes(1);
    const third = await queue("Third");
    const entry = await loop.wake("manual");
    expect(entry.dispatched).toEqual([{ id: first.id, title: first.title }]);
    expect(entry.deferred).toEqual([
      { id: second.id, title: second.title, reason: AT_RUN_CAP },
      { id: bypass.id, title: bypass.title, reason: PROMPT_FREE },
      { id: planned.id, title: planned.title, reason: MODED_BY_YOU },
      { id: third.id, title: third.title, reason: AT_RUN_CAP },
    ]);
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
        reason: "could not start: provider list unavailable",
      },
    ]);
    expect(entry.dispatched).toEqual([{ id: later.id, title: later.title }]);
    // The narrative says it once, too.
    expect(entry.narrative).toContain("  First: could not start: provider list unavailable.");
    expect(entry.narrative.join("\n")).not.toContain("Could not start the run");
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

  // The first client can arrive while a wake that found none is still running: before the wake
  // has recorded the miss (it is still reading the work) or after (it is writing its log). Either
  // way the wake runs another once it ends, so the queue does not wait a whole period.
  for (const when of ["while it reads the work", "while it writes its log"] as const) {
    test(`a client that arrives ${when}, during a wake that found none, gets a follow-up wake`, async () => {
      const { loop, queue, client, fake, engine, wakeLog } = await setup({ loopMinutes: 5 });
      await queue("Waiting for Paseo");
      client.paseo = null;
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached: () => void = () => undefined;
      const atHold = new Promise<void>((resolve) => {
        reached = resolve;
      });
      if (when === "while it reads the work") {
        const list = engine.list.bind(engine);
        engine.list = (async (...args: Parameters<typeof list>) => {
          reached();
          await held;
          return list(...args);
        }) as typeof engine.list;
      } else {
        const append = wakeLog.append.bind(wakeLog);
        let first = true;
        wakeLog.append = (entry: WakeEntry) => {
          if (!first) return append(entry);
          first = false;
          reached();
          return held.then(() => append(entry));
        };
      }
      const missed = loop.wake("timer");
      await atHold;
      client.paseo = fake.paseo;
      const arrived = loop.connected();
      release();
      const entry = await missed;
      expect(entry.narrative).toContain(NOT_CONNECTED);
      await arrived;
      expect(fake.created).toHaveLength(1);
      const recent = (await loop.get()).recent;
      expect(recent.map((logged) => [logged.cause, logged.dispatched.length, logged.skipped ?? null])).toEqual([
        ["timer", 1, null],
        ["timer", 0, null],
      ]);
    });
  }

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
      "Flagged for you:",
      "  Long one.",
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

describe("flags in Needs you", () => {
  const PROMPTS = "Start it yourself: it runs without permission prompts.";
  const MODED = "Start it yourself: it runs in a mode you chose.";
  const FAILED = "Could not start: provider list unavailable.";

  /** Make the next `times` starts fail the way a provider outage does. */
  function failStarts(fake: ReturnType<typeof fakePaseo>, times = 1) {
    const original = fake.paseo.providers.listModels;
    let calls = 0;
    fake.paseo.providers.listModels = (async (...args: Parameters<typeof original>) => {
      calls += 1;
      if (calls <= times) throw new Error("provider list unavailable");
      return original(...args);
    }) as typeof original;
  }

  async function raw(store: WorkStore, id: string) {
    return (await store.findById(id)).events;
  }
  const flags = async (store: WorkStore, id: string) =>
    (await raw(store, id)).filter((event) => event.type === "loop.flagged");

  test("each kind is raised, as one loop.flagged event that reads as a receipt", async () => {
    const { loop, queue, engine, fake, store } = await setup({ concurrencyCap: null });
    const running = await queue("Long one");
    await engine.dispatch(fake.paseo, running.id);
    const dispatchedAt = new Date(clock).toISOString();
    tickMinutes(1);
    const bypass = await queue("Bypass", { modeId: "bypassPermissions" });
    tickMinutes(1);
    const planned = await queue("Planned", { modeId: "plan" });
    tickMinutes(1);
    const broken = await queue("Broken");
    tickMinutes(1);
    const capped = await queue("Plain");
    failStarts(fake);
    tickMinutes(30);
    const entry = await loop.wake("manual");
    expect(entry.dispatched).toEqual([{ id: capped.id, title: capped.title }]);
    expect(entry.flagged).toEqual([
      { id: running.id, title: running.title, kind: "quiet", reason: "Quiet for 34 minutes, worth a look." },
      { id: bypass.id, title: bypass.title, kind: "yours", reason: PROMPTS },
      { id: planned.id, title: planned.title, kind: "yours", reason: MODED },
      { id: broken.id, title: broken.title, kind: "failed", reason: FAILED },
    ]);
    expect(entry.narrative.slice(-5)).toEqual([
      "Flagged for you:",
      "  Long one.",
      "  Bypass.",
      "  Planned.",
      "  Broken.",
    ]);
    // On the work: the flag, when the loop raised it, and a receipt by Maestro.
    for (const [item, kind, reason] of [
      [running, "quiet", "Quiet for 34 minutes, worth a look."],
      [bypass, "yours", PROMPTS],
      [planned, "yours", MODED],
      [broken, "failed", FAILED],
    ] as const) {
      const { item: wire, events } = await engine.get(item.id);
      expect(wire.flag).toEqual({ kind, reason, at: entry.wokeAt });
      expect(events.at(-1)).toEqual({
        ts: entry.wokeAt,
        type: "loop.flagged",
        actor: "maestro",
        text: "Flagged for you by the loop",
        detail: reason,
      });
      // A quiet flag keeps when the run last did anything, so its reason counts on from there.
      const since = kind === "quiet" ? { since: dispatchedAt } : {};
      expect(await flags(store, item.id)).toEqual([
        { ts: entry.wokeAt, type: "loop.flagged", actor: "maestro", kind, reason, ...since },
      ]);
      // A flag is not a change of state.
      expect(wire.state).toBe(item.id === running.id ? "running" : "proposed");
    }
    // Started work and work deferred at the run cap are not flagged.
    expect((await engine.get(capped.id)).item.flag).toBeNull();
  });

  test("deferred at the run cap is not flagged: it starts when a slot frees", async () => {
    const { loop, queue, engine, fake } = await setup({ concurrencyCap: 1 });
    await engine.dispatch(fake.paseo, (await queue("Holds the slot")).id);
    const waiting = await queue("Waits for a slot");
    const entry = await loop.wake("manual");
    expect(entry.deferred).toEqual([{ id: waiting.id, title: waiting.title, reason: AT_RUN_CAP }]);
    expect(entry.flagged).toEqual([]);
    expect((await engine.get(waiting.id)).item.flag).toBeNull();
  });

  test("three wakes in a row write one flag per work, not three", async () => {
    const { loop, queue, engine, fake, store } = await setup();
    const running = await queue("Long one");
    await engine.dispatch(fake.paseo, running.id);
    const bypass = await queue("Bypass", { modeId: "bypassPermissions" });
    tickMinutes(1);
    const broken = await queue("Broken");
    failStarts(fake);
    tickMinutes(30);
    const entries: WakeEntry[] = [];
    for (let wake = 0; wake < 3; wake += 1) {
      entries.push(await loop.wake("timer"));
      tickMinutes(1);
    }
    for (const item of [running, bypass, broken]) expect(await flags(store, item.id)).toHaveLength(1);
    expect(entries.map((entry) => entry.flagged.map((flag) => flag.kind))).toEqual([
      ["quiet", "yours", "failed"],
      [],
      [],
    ]);
    // The start that failed is not tried again while its flag stands: one failure note, not one a wake.
    const notes = (await raw(store, broken.id)).filter((event) => event.type === "note");
    expect(notes).toHaveLength(1);
    expect(entries[2]?.deferred).toContainEqual({ id: broken.id, title: broken.title, reason: FAILED_BEFORE });
    expect(fake.created).toHaveLength(1);
  });

  test("anything else that happens to the work clears it: your dispatch, a turn, a cancel, a note", async () => {
    const { loop, queue, engine, fake, store } = await setup({ concurrencyCap: null });
    const running = await queue("Long one");
    await engine.dispatch(fake.paseo, running.id);
    const dispatchMe = await queue("Dispatch me", { modeId: "bypassPermissions" });
    const cancelMe = await queue("Cancel me", { modeId: "bypassPermissions" });
    const noteMe = await queue("Note me", { modeId: "bypassPermissions" });
    tickMinutes(30);
    await loop.wake("manual");
    for (const item of [running, dispatchMe, cancelMe, noteMe]) {
      expect((await engine.get(item.id)).item.flag).not.toBeNull();
    }
    await engine.onTurnStarted({ id: "agent-1" });
    expect((await engine.get(running.id)).item.flag).toBeNull();
    await engine.dispatch(fake.paseo, dispatchMe.id);
    expect((await engine.get(dispatchMe.id)).item.flag).toBeNull();
    await engine.cancel(cancelMe.id);
    expect((await engine.get(cancelMe.id)).item.flag).toBeNull();
    await store.mutate(noteMe.id, () => ({
      events: [{ ts: new Date(clock).toISOString(), type: "note", actor: "human", text: "Later" }],
    }));
    expect((await engine.get(noteMe.id)).item.flag).toBeNull();
    // Cleared, the next wake may raise it again: the note did not make the work the loop's.
    const again = await loop.wake("manual");
    expect(again.flagged).toEqual([{ id: noteMe.id, title: noteMe.title, kind: "yours", reason: PROMPTS }]);
  });

  test("the quiet clock ignores the loop's own flags, so a flag never resets it", async () => {
    const { loop, queue, engine, fake, store } = await setup();
    const item = await queue("Long one");
    await engine.dispatch(fake.paseo, item.id);
    const before = (await engine.get(item.id)).item;
    tickMinutes(30);
    expect((await loop.wake("manual")).flagged.map((flag) => flag.kind)).toEqual(["quiet"]);
    tickMinutes(1);
    const next = await loop.wake("manual");
    expect(next.quiet).toEqual([{ id: item.id, title: item.title, minutes: 31 }]);
    expect(next.flagged).toEqual([]);
    const after = (await engine.get(item.id)).item;
    // The flag is not activity: the work's times still point at its dispatch, and the reason counts on.
    expect(after.lastEventAt).toBe(before.lastEventAt);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.flag?.reason).toBe("Quiet for 31 minutes, worth a look.");
    expect(await flags(store, item.id)).toHaveLength(1);
  });

  test("is never written on work that moved after the wake read it", async () => {
    const { queue, engine, fake, store } = await setup();
    const item = await queue("Bypass", { modeId: "bypassPermissions" });
    const read = (await engine.get(item.id)).item;
    await engine.dispatch(fake.paseo, item.id);
    expect(await engine.flag(read, "yours", PROMPTS)).toBe(false);
    expect(await engine.flag(read, "failed", FAILED)).toBe(false);
    expect(await flags(store, item.id)).toEqual([]);
    // Running, but not quiet yet.
    expect(await engine.flag(read, "quiet", "Quiet for 0 minutes, worth a look.")).toBe(false);
    tickMinutes(30);
    expect(await engine.flag(read, "quiet", "Quiet for 30 minutes, worth a look.")).toBe(true);
  });

  test("a yours flag comes down when Settings hand the work back to the loop, which then starts it", async () => {
    const { loop, queue, engine, fake, config } = await setup({ modeId: "bypassPermissions" });
    const item = await queue("Plain");
    expect((await loop.wake("manual")).flagged.map((flag) => flag.kind)).toEqual(["yours"]);
    config.modeId = null;
    expect((await engine.get(item.id)).item.flag).toBeNull();
    const entry = await loop.wake("manual");
    expect(entry.dispatched).toEqual([{ id: item.id, title: item.title }]);
    expect(fake.created).toHaveLength(1);
  });

  test("work.attention lists flagged work after the work at your gate or stuck", async () => {
    const { loop, queue, engine, fake } = await setup({ concurrencyCap: null });
    const stuck = await queue("Stuck");
    await engine.dispatch(fake.paseo, stuck.id);
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "failed", error: { message: "boom" } }, []);
    const bypass = await queue("Bypass", { modeId: "bypassPermissions" });
    await queue("Plain");
    await loop.wake("manual");
    const { waiting } = attentionOf((await engine.list()).items, clock);
    expect(waiting).toEqual([
      { id: stuck.id, group: "blocked", flag: null },
      { id: bypass.id, group: "queued", flag: { kind: "yours", reason: PROMPTS, at: new Date(clock).toISOString() } },
    ]);
  });
});

describe("quiet asks the session", () => {
  const minutesAgo = (minutes: number) => new Date(clock - minutes * 60_000);

  test("a long turn still at work is not quiet: its session's own activity says so", async () => {
    const { loop, queue, engine, fake } = await setup();
    const item = await queue("Long turn");
    await engine.dispatch(fake.paseo, item.id);
    tickMinutes(45);
    // No event in Maestro for 45 minutes: the turn started and has not ended. The session wrote 2 minutes ago.
    fake.setLastActivityAt("agent-1", minutesAgo(2));
    fake.refreshed.length = 0;
    const entry = await loop.wake("timer");
    expect(fake.refreshed).toContain("agent-1");
    expect(entry.quiet).toEqual([]);
    expect(entry.flagged).toEqual([]);
    expect(entry.unasked).toEqual([]);
    expect(entry.narrative.join("\n")).not.toContain("quiet");
    expect((await engine.get(item.id)).item.flag).toBeNull();
  });

  test("a run idle by both clocks is quiet, counted from the later of the two", async () => {
    const { loop, queue, engine, fake } = await setup();
    const item = await queue("Idle one");
    await engine.dispatch(fake.paseo, item.id);
    tickMinutes(10);
    fake.setLastActivityAt("agent-1", new Date(clock));
    tickMinutes(35);
    const entry = await loop.wake("timer");
    // Maestro's events say 45 minutes; the session last did something 35 minutes ago.
    expect(entry.quiet).toEqual([{ id: item.id, title: item.title, minutes: 35 }]);
    expect(entry.flagged).toEqual([
      { id: item.id, title: item.title, kind: "quiet", reason: "Quiet for 35 minutes, worth a look." },
    ]);
    tickMinutes(2);
    expect((await engine.get(item.id)).item.flag?.reason).toBe("Quiet for 37 minutes, worth a look.");
  });

  test("a session that cannot be asked is not flagged quiet, and the wake says why", async () => {
    const { loop, queue, engine, fake } = await setup();
    const item = await queue("Long one");
    await engine.dispatch(fake.paseo, item.id);
    tickMinutes(45);
    const ref = fake.paseo.agents.ref;
    fake.paseo.agents.ref = ((id: string) => ({
      ...ref(id),
      refresh: () => Promise.reject(new Error("daemon busy")),
    })) as unknown as typeof ref;
    const entry = await loop.wake("timer");
    expect(entry.quiet).toEqual([]);
    expect(entry.flagged).toEqual([]);
    expect(entry.unasked).toEqual([{ id: item.id, title: item.title, reason: "daemon busy" }]);
    expect(entry.narrative).toEqual([
      "Woke on a scheduled check.",
      "Could not ask the session, so quiet was neither flagged nor cleared:",
      "  Long one: daemon busy.",
      "Did nothing new this tick.",
    ]);
    expect((await engine.get(item.id)).item.flag).toBeNull();
  });

  test("a session that never answers is given up on, bounded, and not flagged", async () => {
    const { loop, queue, engine, fake } = await setup();
    const item = await queue("Long one");
    await engine.dispatch(fake.paseo, item.id);
    tickMinutes(45);
    // A read now reconciles; the wake's own read, at the same time, does not, so only its question hangs.
    await engine.list(fake.paseo);
    const ref = fake.paseo.agents.ref;
    fake.paseo.agents.ref = ((id: string) => ({
      ...ref(id),
      refresh: () => new Promise(() => undefined),
    })) as unknown as typeof ref;
    const entry = await loop.wake("timer");
    expect(entry.unasked).toEqual([{ id: item.id, title: item.title, reason: "Paseo did not answer within 0.1s" }]);
    expect(entry.flagged).toEqual([]);
  });

  test("with no Paseo client there is no session to ask, so nothing is flagged quiet", async () => {
    const { loop, queue, engine, fake, client } = await setup();
    const item = await queue("Long one");
    await engine.dispatch(fake.paseo, item.id);
    tickMinutes(45);
    client.paseo = null;
    const entry = await loop.wake("manual");
    expect(entry.unasked).toEqual([{ id: item.id, title: item.title, reason: ASK_NOT_CONNECTED }]);
    expect(entry.flagged).toEqual([]);
    expect(entry.narrative).toContain(NOT_CONNECTED);
  });

  describe("a quiet flag comes down when its session works again", () => {
    /** A run flagged quiet 30 minutes after its dispatch, with nothing from Maestro or its session since. */
    async function flaggedQuiet(setupResult: Awaited<ReturnType<typeof setup>>) {
      const { loop, queue, engine, fake } = setupResult;
      const item = await queue("Long turn");
      await engine.dispatch(fake.paseo, item.id);
      tickMinutes(30);
      expect((await loop.wake("timer")).flagged.map((flag) => flag.kind)).toEqual(["quiet"]);
      return { item, before: (await engine.get(item.id)).item };
    }
    const raw = async (store: WorkStore, id: string) => (await store.findById(id)).events;
    const askFails = (fake: ReturnType<typeof fakePaseo>, refresh: () => Promise<unknown>) => {
      const ref = fake.paseo.agents.ref;
      fake.paseo.agents.ref = ((id: string) => ({ ...ref(id), refresh })) as unknown as typeof ref;
    };

    test("a session at work again mid-turn: the next wake takes the flag down, as the loop's receipt", async () => {
      const ctx = await setup();
      const { loop, engine, fake, store } = ctx;
      const { item, before } = await flaggedQuiet(ctx);
      tickMinutes(5);
      // The turn is still open, so Maestro hears nothing: only the session's own activity moves.
      fake.setLastActivityAt("agent-1", minutesAgo(1));
      const entry = await loop.wake("timer");
      expect(entry.cleared).toEqual([{ id: item.id, title: item.title }]);
      expect(entry.quiet).toEqual([]);
      expect(entry.flagged).toEqual([]);
      expect(entry.unasked).toEqual([]);
      expect(entry.narrative.slice(-2)).toEqual(["Cleared:", "  Long turn is active again."]);
      const { item: wire, events } = await engine.get(item.id);
      expect(wire).toMatchObject({ state: "running", flag: null });
      expect(events.at(-1)).toEqual({
        ts: entry.wokeAt,
        type: "flag.cleared",
        actor: "maestro",
        text: "The loop took its flag down",
        detail: ACTIVE_AGAIN,
      });
      expect((await raw(store, item.id)).at(-1)).toEqual({
        ts: entry.wokeAt,
        type: "flag.cleared",
        actor: "maestro",
        kind: "quiet",
        reason: ACTIVE_AGAIN,
      });
      // Cleared, it is no longer in Needs you; the work's times still point at its dispatch.
      expect(attentionOf((await engine.list()).items, clock).waiting).toEqual([]);
      expect([wire.lastEventAt, wire.updatedAt]).toEqual([before.lastEventAt, before.updatedAt]);
      // A wake after it adds nothing: the flag is down and the session is not quiet.
      const count = (await raw(store, item.id)).length;
      tickMinutes(1);
      expect((await loop.wake("timer")).cleared).toEqual([]);
      expect(await raw(store, item.id)).toHaveLength(count);
    });

    test("a snapshot that cannot be read leaves the flag, and the wake says why", async () => {
      const ctx = await setup();
      const { loop, engine, fake, store, client } = ctx;
      const { item } = await flaggedQuiet(ctx);
      tickMinutes(5);
      // Had it been read, this would take the flag down.
      fake.setLastActivityAt("agent-1", minutesAgo(1));
      const count = (await raw(store, item.id)).length;
      for (const [refresh, reason] of [
        [() => Promise.reject(new Error("daemon busy")), "daemon busy"],
        [() => Promise.resolve(null), "Paseo has no record of the session"],
        [() => Promise.resolve({ agent: {} }), "the session did not say when it last worked"],
      ] as const) {
        askFails(fake, refresh);
        const entry = await loop.wake("timer");
        expect(entry.cleared).toEqual([]);
        expect(entry.unasked).toEqual([{ id: item.id, title: item.title, reason }]);
        expect(entry.narrative).toContain("Could not ask the session, so quiet was neither flagged nor cleared:");
        expect((await engine.get(item.id)).item.flag?.kind).toBe("quiet");
      }
      client.paseo = null;
      const unconnected = await loop.wake("timer");
      expect(unconnected.unasked).toEqual([{ id: item.id, title: item.title, reason: ASK_NOT_CONNECTED }]);
      expect(unconnected.cleared).toEqual([]);
      expect((await engine.get(item.id)).item.flag?.kind).toBe("quiet");
      expect(await raw(store, item.id)).toHaveLength(count);
    });

    test("a session still idle keeps the flag, and wakes add no event: no second flag, no clear", async () => {
      const ctx = await setup();
      const { loop, engine, store } = ctx;
      const { item } = await flaggedQuiet(ctx);
      const count = (await raw(store, item.id)).length;
      for (const minutes of [35, 40]) {
        tickMinutes(5);
        const entry = await loop.wake("timer");
        expect(entry.quiet).toEqual([{ id: item.id, title: item.title, minutes }]);
        expect(entry.flagged).toEqual([]);
        expect(entry.cleared).toEqual([]);
      }
      expect((await engine.get(item.id)).item.flag?.reason).toBe("Quiet for 40 minutes, worth a look.");
      expect(await raw(store, item.id)).toHaveLength(count);
    });

    test("the loop's clear is not a look; your Leave it running is", async () => {
      const ctx = await setup();
      const { loop, engine, fake } = ctx;
      const { item } = await flaggedQuiet(ctx);
      const looks = (await engine.list()).scoreboard.looks;
      tickMinutes(5);
      fake.setLastActivityAt("agent-1", minutesAgo(1));
      expect((await loop.wake("timer")).cleared).toEqual([{ id: item.id, title: item.title }]);
      expect((await engine.list()).scoreboard.looks).toBe(looks);
      expect((await engine.get(item.id)).item.flag).toBeNull();
    });

    test("is never written on work that moved after the wake read it, nor twice", async () => {
      const ctx = await setup();
      const { engine, store } = ctx;
      const { item, before } = await flaggedQuiet(ctx);
      tickMinutes(5);
      const active = clock - 60_000;
      // A turn ended meanwhile: the flag is already down, so there is nothing to clear.
      await engine.onTurnStarted({ id: "agent-1" });
      const count = (await raw(store, item.id)).length;
      expect(await engine.clearQuiet(before, active)).toBe(false);
      expect(await raw(store, item.id)).toHaveLength(count);
      // Flagged again, it clears once; a second call finds no flag.
      tickMinutes(30);
      expect(await engine.flag(before, "quiet", "Quiet for 30 minutes, worth a look.")).toBe(true);
      expect(await engine.clearQuiet(before, clock - 60_000)).toBe(true);
      expect(await engine.clearQuiet(before, clock - 60_000)).toBe(false);
      expect((await raw(store, item.id)).filter((event) => event.type === "flag.cleared")).toHaveLength(1);
    });

    test("quietCleared: active since the flag's since, and within the threshold, for a quiet flag only", () => {
      const now = Date.parse("2026-09-22T10:00:00.000Z");
      const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
      const flag = (since?: string, kind: "quiet" | "yours" = "quiet") =>
        ({
          ts: at(0),
          type: "loop.flagged",
          actor: "maestro",
          kind,
          reason: "x",
          ...(since ? { since } : {}),
        }) as const;
      const ms = (minutesAgo: number) => now - minutesAgo * 60_000;
      expect(quietCleared(flag(at(10)), [], at(60), ms(5), now)).toBe(true);
      // Not since the flag's since: the session's last work is what the flag already counted.
      expect(quietCleared(flag(at(10)), [], at(60), ms(10), now)).toBe(false);
      expect(quietCleared(flag(at(10)), [], at(60), ms(12), now)).toBe(false);
      // Since, but quiet again by now.
      expect(quietCleared(flag(at(40)), [], at(60), ms(30), now)).toBe(false);
      // A flag raised before it kept since counts from the work's last event, as its reason does.
      const events = [{ ts: at(20), type: "note", actor: "human", text: "x" } as const];
      expect(quietCleared(flag(), events, at(60), ms(19), now)).toBe(true);
      expect(quietCleared(flag(), events, at(60), ms(21), now)).toBe(false);
      expect(quietCleared(flag(at(10), "yours"), [], at(60), ms(5), now)).toBe(false);
    });

    test("the quiet clock ignores the clear: the run is flagged again 30 minutes after its session last worked", async () => {
      const ctx = await setup();
      const { loop, engine, fake } = ctx;
      const { item, before } = await flaggedQuiet(ctx);
      tickMinutes(5);
      fake.setLastActivityAt("agent-1", minutesAgo(1));
      expect((await loop.wake("timer")).cleared).toHaveLength(1);
      const after = (await engine.get(item.id)).item;
      expect([after.lastEventAt, after.updatedAt]).toEqual([before.lastEventAt, before.updatedAt]);
      // The session last worked at minute 34 and the clear was written at 35: at 64 it is quiet by both clocks.
      tickMinutes(29);
      const again = await loop.wake("timer");
      expect(again.quiet).toEqual([{ id: item.id, title: item.title, minutes: 30 }]);
      expect(again.flagged).toEqual([
        { id: item.id, title: item.title, kind: "quiet", reason: "Quiet for 30 minutes, worth a look." },
      ]);
    });
  });

  test("the session's activity is read from lastActivityAt when the snapshot names it, else updatedAt", () => {
    const at = "2026-09-22T09:00:00.000Z";
    expect(sessionActiveAt({ updatedAt: at })).toBe(Date.parse(at));
    expect(sessionActiveAt({ lastActivityAt: at, updatedAt: "2026-09-22T08:00:00.000Z" })).toBe(Date.parse(at));
    expect(sessionActiveAt({ lastActivityAt: "garbage", updatedAt: at })).toBe(Date.parse(at));
    expect(sessionActiveAt({})).toBeNull();
    expect(sessionActiveAt({ updatedAt: 12 })).toBeNull();
  });
});

describe("the loop and you, for the last slot", () => {
  /** Holds the first run start inside startRun (after its slot is taken) until released. */
  function holdFirstStart(fake: ReturnType<typeof fakePaseo>) {
    const original = fake.paseo.providers.listModels;
    let entered!: () => void;
    let release!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    fake.paseo.providers.listModels = (async (...args: Parameters<typeof original>) => {
      calls += 1;
      if (calls === 1) {
        entered();
        await released;
      }
      return original(...args);
    }) as typeof original;
    return { inside, release };
  }

  test("the loop's start holds the slot: yours is refused at the cap, and exactly one starts", async () => {
    const { loop, queue, engine, fake } = await setup({ concurrencyCap: 1 });
    const loops = await queue("For the loop");
    tickMinutes(1);
    const yours = await queue("For you");
    const hold = holdFirstStart(fake);
    const waking = loop.wake("manual");
    await hold.inside;
    const mine = await engine.dispatch(fake.paseo, yours.id).then(
      () => "started",
      (error: Error) => error.message,
    );
    hold.release();
    const entry = await waking;
    expect(mine).toBe("At capacity: 1 running. It stays queued.");
    expect(entry.dispatched).toEqual([{ id: loops.id, title: loops.title }]);
    expect(entry.deferred).toEqual([{ id: yours.id, title: yours.title, reason: AT_RUN_CAP }]);
    expect(fake.created).toHaveLength(1);
    expect((await engine.get(loops.id)).item.state).toBe("running");
    expect((await engine.get(yours.id)).item.state).toBe("proposed");
  });

  test("your start holds the slot: the loop defers at the cap, and exactly one starts", async () => {
    const { loop, queue, engine, fake } = await setup({ concurrencyCap: 1 });
    const loops = await queue("For the loop");
    tickMinutes(1);
    const yours = await queue("For you");
    const hold = holdFirstStart(fake);
    const mine = engine.dispatch(fake.paseo, yours.id);
    await hold.inside;
    const waking = loop.wake("manual");
    // The wake reads, walks and defers while your start is still in flight.
    const entry = await waking;
    hold.release();
    expect((await mine).state).toBe("running");
    expect(entry.dispatched).toEqual([]);
    expect(entry.deferred).toEqual([
      { id: loops.id, title: loops.title, reason: AT_RUN_CAP },
      { id: yours.id, title: yours.title, reason: AT_RUN_CAP },
    ]);
    expect(fake.created).toHaveLength(1);
    expect((await engine.get(loops.id)).item.state).toBe("proposed");
  });
});

describe("Leave it running", () => {
  test("clears a quiet flag as your receipt, a look, and the quiet clock counts from it", async () => {
    const { loop, queue, engine, fake } = await setup();
    const item = await queue("Long one");
    await engine.dispatch(fake.paseo, item.id);
    tickMinutes(30);
    expect((await loop.wake("timer")).flagged.map((flag) => flag.kind)).toEqual(["quiet"]);
    const looks = (await engine.list()).scoreboard.looks;
    tickMinutes(5);
    const left = await engine.leaveRunning(item.id);
    expect(left).toMatchObject({ state: "running", flag: null });
    const { events } = await engine.get(item.id);
    expect(events.at(-1)).toEqual({
      ts: new Date(clock).toISOString(),
      type: "flag.dismissed",
      actor: "human",
      text: "You left it running",
      detail: "Quiet for 30 minutes, worth a look.",
    });
    expect((await engine.list()).scoreboard.looks).toBe(looks + 1);
    // The session stays as quiet as it was: only your receipt moved the clock.
    tickMinutes(29);
    expect((await loop.wake("timer")).quiet).toEqual([]);
    tickMinutes(1);
    const again = await loop.wake("timer");
    expect(again.quiet).toEqual([{ id: item.id, title: item.title, minutes: 30 }]);
    expect(again.flagged.map((flag) => flag.kind)).toEqual(["quiet"]);
  });

  test("is refused on anything but a running run flagged quiet, and changes nothing", async () => {
    const { loop, queue, engine, fake, store } = await setup();
    const bypass = await queue("Bypass", { modeId: "bypassPermissions" });
    const running = await queue("Running");
    await engine.dispatch(fake.paseo, running.id);
    await loop.wake("manual");
    expect((await engine.get(bypass.id)).item.flag?.kind).toBe("yours");
    // A flag you clear by acting (dispatch or cancel) has no dismiss; a run that is not quiet has nothing to dismiss.
    for (const id of [bypass.id, running.id]) {
      const before = (await store.findById(id)).events.length;
      await expect(engine.leaveRunning(id)).rejects.toThrow(NOT_QUIET);
      expect((await store.findById(id)).events).toHaveLength(before);
    }
    tickMinutes(30);
    await loop.wake("manual");
    await engine.leaveRunning(running.id);
    // Once left running, it is not flagged any more: a second press is refused.
    await expect(engine.leaveRunning(running.id)).rejects.toThrow(NOT_QUIET);
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
