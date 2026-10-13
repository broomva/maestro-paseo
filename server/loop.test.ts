import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AnswersLanding, answersNotice } from "../shared/answers";
import type { MaestroConfig, WakeEntry } from "../shared/contracts";
import { SESSIONS_START_NOTHING } from "../shared/text";
import type { RouteOutcome } from "./answer-routes";
import { attentionOf } from "./attention";
import { defaultConfig } from "./config";
import { type CreateInput, Engine, NEVER_BY_RULE, NOT_QUIET, type Timer } from "./engine";
import { LOOP, type Origin } from "./events";
import { fakePaseo } from "./fake-paseo";
import { ACTIVE_AGAIN, quietCleared, sessionActiveAt } from "./flags";
import { ALREADY_WAKING, ASK_NOT_CONNECTED, Loop, NOT_CONNECTED, QUIET_MS, SWEEP_OVERRAN } from "./loop";
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
  /** Queued work, created as you create it in Maestro (or, with `origin`, as someone else does). */
  const queue = (title: string, extra: Partial<CreateInput> = {}, origin?: Origin) =>
    engine.create(
      fake.paseo,
      {
        title,
        brief: "",
        repo,
        gate: "human",
        check: "",
        initiative: "",
        dispatch: false,
        ...extra,
      },
      origin,
    );
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
    await queue("Waits for you");
    await loop.reschedule();
    // Fired before its time (a delay longer than a timer holds): nothing runs, it arms again.
    await timers.fire();
    expect((await loop.get()).recent).toHaveLength(0);
    expect(timers.live().map((entry) => entry.ms)).toEqual([5 * 60_000]);

    tickMinutes(5);
    await timers.fire();
    const [entry] = (await loop.get()).recent;
    expect(entry).toMatchObject({ cause: "timer", wokeAt: new Date(clock).toISOString(), dispatched: [] });
    expect(timers.live().map((armed) => armed.ms)).toEqual([5 * 60_000]);

    // Turned off since it was armed: it does not wake, and nothing is armed again.
    config.loopMinutes = null;
    tickMinutes(5);
    await timers.fire();
    expect((await loop.get()).recent).toHaveLength(1);
    expect(timers.live()).toHaveLength(0);
    // Woken or not, it started nothing.
    expect(fake.created).toEqual([]);
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
  test("never starts work, whatever the gate, the state, the Settings or the cap (A8, BRO-2990)", async () => {
    // The incident's Settings (13b97ad9): new work gates auto, the loop wakes every 5 minutes, no cap.
    const { loop, queue, store, fake, engine } = await setup({
      concurrencyCap: null,
      defaultGate: "auto",
      loopMinutes: 5,
    });
    const plain = await queue("Plain");
    tickMinutes(1);
    const triggered = await queue("Triggered");
    await store.mutate(triggered.id, () => ({ to: "triggered" }));
    tickMinutes(1);
    const auto = await queue("Checks decide", { gate: "auto", check: "true" });
    tickMinutes(1);
    const bypass = await queue("Bypass", { modeId: "bypassPermissions" });
    // A spy on dispatch: the loop's engine has none to call, and nothing calls it for the loop.
    const tried: string[] = [];
    const dispatch = engine.dispatch.bind(engine);
    engine.dispatch = ((paseo, id, origin) => {
      tried.push(id);
      return dispatch(paseo, id, origin);
    }) as typeof engine.dispatch;
    const entries = [await loop.wake("manual"), await loop.wake("timer")];
    for (const entry of entries) {
      expect([entry.dispatched, entry.deferred]).toEqual([[], []]);
      expect(entry.narrative).not.toContain("Started");
    }
    // Only the work you gave a mode of its own is flagged, once: no lane may start it either.
    expect(entries.map((entry) => entry.flagged.map((flag) => flag.id))).toEqual([[bypass.id], []]);
    expect(tried).toEqual([]);
    expect(fake.created).toEqual([]);
    for (const [item, state] of [
      [plain, "proposed"],
      [triggered, "triggered"],
      [auto, "proposed"],
    ] as const) {
      const { item: wire } = await engine.get(item.id);
      // Queued, unflagged: it waits for you, a lane or the conductor, not in Needs you.
      expect([wire.state, wire.flag]).toEqual([state, null]);
    }
    expect((await engine.get(bypass.id)).item).toMatchObject({ state: "proposed", flag: { kind: "yours" } });
    // Your Dispatch still starts it.
    expect((await engine.dispatch(fake.paseo, plain.id)).state).toBe("running");
    expect(fake.created).toHaveLength(1);
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
    expect(ran.dispatched).toEqual([]);
    expect(fake.created).toEqual([]);
    const { recent, ticking } = await loop.get();
    expect(ticking).toBe(false);
    expect(recent.map((entry) => entry.tickId)).toEqual([ran.tickId, second.tickId]);
  });

  test("with no Paseo client it records that it could ask no session, and the first client runs another", async () => {
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
    // The follow-up wake asks the sessions it could not; it starts nothing.
    expect(fake.created).toEqual([]);
    expect((await loop.get()).recent.map((logged) => logged.narrative.includes(NOT_CONNECTED))).toEqual([false, true]);
    // Only once: a second client handover does not wake it again.
    await loop.connected();
    expect((await loop.get()).recent).toHaveLength(2);
  });

  // The first client can arrive while a wake that found none is still running: before the wake
  // has recorded the miss (it is still reading the work) or after (it is writing its log). Either
  // way the wake runs another once it ends, so quiet runs and answers do not wait a whole period.
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
      expect(fake.created).toEqual([]);
      const recent = (await loop.get()).recent;
      expect(
        recent.map((logged) => [logged.cause, logged.narrative.includes(NOT_CONNECTED), logged.skipped ?? null]),
      ).toEqual([
        ["timer", false, null],
        ["timer", true, null],
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
    // A quiet run is watched, not held on you (A1): said under "To watch".
    expect(entry.narrative).toEqual([
      "Woke because you asked.",
      "To watch:",
      "  Long one has been quiet 30 minutes, worth a look.",
      "Did nothing new this tick.",
      "Flagged for you:",
      "  Long one.",
    ]);
  });

  test("counts what needs you (at your gate, asking) apart from what you watch (stuck)", async () => {
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
    expect(entry.narrative.slice(0, 6)).toEqual([
      "Woke because you asked.",
      "Needs you:",
      "  1 waiting at your gate.",
      "  1 asking you a question.",
      "To watch:",
      "  1 stuck.",
    ]);
  });

  test("a wake is not a look; your Dispatch is", async () => {
    const { loop, queue, engine, fake } = await setup();
    const item = await queue("Waits for you");
    const before = (await engine.list()).scoreboard.looks;
    expect((await loop.wake("manual")).dispatched).toEqual([]);
    expect((await engine.list()).scoreboard.looks).toBe(before);
    await engine.dispatch(fake.paseo, item.id);
    expect((await engine.list()).scoreboard.looks).toBe(before + 1);
  });
});

describe("flags in Needs you", () => {
  const PROMPTS = "Start it yourself: it runs without permission prompts.";
  const FAILED = "Could not start: provider list unavailable.";

  async function raw(store: WorkStore, id: string) {
    return (await store.findById(id)).events;
  }
  const flags = async (store: WorkStore, id: string) =>
    (await raw(store, id)).filter((event) => event.type === "loop.flagged");

  test("a wake raises quiet, and yours on queued work only you may start, each one loop.flagged receipt", async () => {
    const { loop, queue, engine, fake, store } = await setup({ concurrencyCap: null });
    const running = await queue("Long one");
    await engine.dispatch(fake.paseo, running.id);
    const dispatchedAt = new Date(clock).toISOString();
    tickMinutes(1);
    // Only you may start these: a session's dispatch refuses a mode you chose, and work held for you.
    const bypass = await queue("Bypass", { modeId: "bypassPermissions" });
    const planned = await queue("Planned", { modeId: "plan" });
    const held = await queue("Held", { hold: "You chose to develop ideas-maestro.yaml I1." });
    // Anyone may start these: you as Settings say, a lane in its lane's mode. They wait unflagged.
    const plain = await queue("Plain");
    tickMinutes(33);
    const entry = await loop.wake("manual");
    expect(entry.dispatched).toEqual([]);
    expect(entry.flagged).toEqual([
      { id: running.id, title: running.title, kind: "quiet", reason: "Quiet for 34 minutes, worth a look." },
      {
        id: bypass.id,
        title: bypass.title,
        kind: "yours",
        reason: "Start it yourself: it runs without permission prompts.",
      },
      {
        id: planned.id,
        title: planned.title,
        kind: "yours",
        reason: "Start it yourself: it runs in a mode you chose.",
      },
      { id: held.id, title: held.title, kind: "yours", reason: "Start it yourself: it was filed to wait for you." },
    ]);
    expect(entry.narrative.slice(-5)).toEqual([
      "Flagged for you:",
      "  Long one.",
      "  Bypass.",
      "  Planned.",
      "  Held.",
    ]);
    const { item: wire, events } = await engine.get(running.id);
    expect(wire.flag).toEqual({ kind: "quiet", reason: "Quiet for 34 minutes, worth a look.", at: entry.wokeAt });
    expect(events.at(-1)).toEqual({
      ts: entry.wokeAt,
      type: "loop.flagged",
      actor: "maestro",
      text: "Flagged for you by the loop",
      detail: "Quiet for 34 minutes, worth a look.",
    });
    // A quiet flag keeps when the run last did anything, so its reason counts on from there.
    expect(await flags(store, running.id)).toEqual([
      {
        ts: entry.wokeAt,
        type: "loop.flagged",
        actor: "maestro",
        kind: "quiet",
        reason: "Quiet for 34 minutes, worth a look.",
        since: dispatchedAt,
      },
    ]);
    // A flag is not a change of state.
    expect(wire.state).toBe("running");
    expect((await engine.get(plain.id)).item.flag).toBeNull();
    expect((await engine.get(held.id)).item.flag?.kind).toBe("yours");
    expect(fake.created).toHaveLength(1);
  });

  test("queued work the routing before A8 filed from an answer is yours in Needs you, once; never started", async () => {
    const { loop, queue, engine, fake, store } = await setup();
    // As the old routing filed it: Maestro's, for an answer, no hold, queued at your gate.
    const stranded = await queue("Act on your answer: Ship it?", { answer: "l.yaml#A1@2026-10-06T12:00:01Z" }, LOOP);
    // Work you filed from an answer yourself (File as work) is not stranded: it is plain queued work.
    const yours = await queue("Filed by you", { answer: "l.yaml#A2@2026-10-06T12:00:02Z" });
    const entry = await loop.wake("manual");
    expect(entry.flagged).toEqual([
      {
        id: stranded.id,
        title: stranded.title,
        kind: "yours",
        reason: "Filed from your answer before A8: start it yourself, or cancel it.",
      },
    ]);
    expect((await engine.get(yours.id)).item.flag).toBeNull();
    expect((await loop.wake("manual")).flagged).toEqual([]);
    expect(await flags(store, stranded.id)).toHaveLength(1);
    expect(fake.created).toEqual([]);
  });

  test("Settings' own mode makes nothing yours: a lane's run takes its lane's mode instead", async () => {
    const { loop, queue, engine, fake } = await setup({ modeId: "bypassPermissions" });
    const plain = await queue("Plain");
    expect((await loop.wake("manual")).flagged).toEqual([]);
    expect((await engine.get(plain.id)).item.flag).toBeNull();
    // A flag an older Maestro raised for Settings' mode comes down as it is read.
    expect(await engine.flag(plain, "yours", "Start it yourself: it runs without permission prompts.")).toBe(false);
    expect(fake.created).toEqual([]);
  });

  test("three wakes in a row write one flag per work, not three", async () => {
    const { loop, queue, engine, fake, store } = await setup();
    const running = await queue("Long one");
    await engine.dispatch(fake.paseo, running.id);
    await queue("Bypass", { modeId: "bypassPermissions" });
    tickMinutes(30);
    const entries: WakeEntry[] = [];
    for (let wake = 0; wake < 3; wake += 1) {
      entries.push(await loop.wake("timer"));
      tickMinutes(1);
    }
    expect(await flags(store, running.id)).toHaveLength(1);
    expect(entries.map((entry) => entry.flagged.map((flag) => flag.kind))).toEqual([["quiet", "yours"], [], []]);
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
    // Cleared, the next wake may raise it again: the note did not make the work anyone else's to start.
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

  test("a quiet flag is raised on the run, which stays watched: neither it nor stuck work waits on you (A1)", async () => {
    const { loop, queue, engine, fake } = await setup({ concurrencyCap: null });
    const stuck = await queue("Stuck");
    await engine.dispatch(fake.paseo, stuck.id);
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "failed", error: { message: "boom" } }, []);
    const long = await queue("Long one");
    await engine.dispatch(fake.paseo, long.id);
    await queue("Plain");
    tickMinutes(30);
    await loop.wake("manual");
    const { items } = await engine.list();
    expect(items.find((item) => item.id === long.id)?.flag).toEqual({
      kind: "quiet",
      reason: "Quiet for 30 minutes, worth a look.",
      at: new Date(clock).toISOString(),
    });
    expect(items.find((item) => item.id === stuck.id)?.group).toBe("blocked");
    expect(attentionOf(items, clock).waiting).toEqual([]);
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
    // A flag an older Maestro's loop left on queued work: the loop raises none now.
    expect(await engine.flag(bypass, "yours", "Start it yourself: it runs without permission prompts.")).toBe(true);
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

describe("dispatch as Maestro (A8, BRO-2990)", () => {
  test("is refused for any work, before it takes a slot; the same work is yours to start", async () => {
    const { queue, engine, fake } = await setup({ concurrencyCap: 1 });
    const plain = await queue("Plain");
    const bypass = await queue("Bypass", { modeId: "bypassPermissions" });
    const held = await queue("Held", { hold: "You chose to develop ideas-maestro.yaml I1." });
    for (const item of [plain, bypass, held]) {
      await expect(engine.dispatch(fake.paseo, item.id, LOOP)).rejects.toThrow(NEVER_BY_RULE);
    }
    expect(fake.created).toEqual([]);
    // No refused start held the only slot: yours starts.
    expect((await engine.dispatch(fake.paseo, plain.id)).state).toBe("running");
    expect(fake.created).toHaveLength(1);
  });

  test("a session cannot start work, held for you or not; you can", async () => {
    const { queue, engine, fake } = await setup();
    const held = await queue("Held", { hold: "You chose to develop ideas-maestro.yaml I1." });
    expect(held.nextRun?.held).toBe("You chose to develop ideas-maestro.yaml I1.");
    await expect(engine.dispatch(fake.paseo, held.id, { actor: "agent", by: "a1" })).rejects.toThrow(
      SESSIONS_START_NOTHING,
    );
    expect((await engine.dispatch(fake.paseo, held.id)).state).toBe("running");
  });
});

describe("step 5: your answers, landed and routed", () => {
  const landing = (over: Partial<AnswersLanding> = {}): AnswersLanding => ({
    stage: "waiting",
    pending: 3,
    asks: [],
    pr: { number: 915, url: "https://example.invalid/pull/915" },
    conflict: null,
    error: null,
    landed: null,
    checkedAt: new Date(clock).toISOString(),
    ...over,
  });
  const routed = (id: string, status: RouteOutcome["status"]): RouteOutcome => ({
    key: `l.yaml#${id}@x`,
    ledger: "l.yaml",
    id,
    status,
    route: status === "routed" ? "delivered" : null,
    words: status === "routed" ? "Acted on: sent to the session that asked." : "waits",
  });

  test("a wake lands the batch, then routes; the entry and its words say both, Needs you first", async () => {
    const { engine, client, wakeLog, timers } = await setup();
    const order: string[] = [];
    const loop = new Loop({
      engine,
      client: () => client.paseo,
      now: () => new Date(clock),
      timer: timers.timer,
      wakeLog,
      log: () => {},
      askMs: 100,
      answers: {
        land: async () => {
          order.push("land");
          return landing();
        },
        route: async () => {
          order.push("route");
          return [routed("A1", "routed"), routed("A2", "queued")];
        },
      },
    });
    const entry = await loop.wake("manual");
    expect(order).toEqual(["land", "route"]);
    expect(entry.answers).toEqual({
      landing: landing(),
      routed: [{ ledger: "l.yaml", id: "A1", route: "delivered", words: "Acted on: sent to the session that asked." }],
      waiting: 1,
    });
    expect(entry.narrative).toEqual([
      "Woke because you asked.",
      "Needs you:",
      "  3 answers wait to land: PR #915",
      "Did:",
      "  Your answer to A1 (l.yaml): Acted on: sent to the session that asked.",
    ]);
    const [logged] = await wakeLog.recent(1);
    expect(logged?.answers?.landing?.pr?.number).toBe(915);
  });

  test("a batch that cannot take main is named, with where to settle it; a step that throws never stops the wake", async () => {
    const { engine, client, wakeLog, timers } = await setup();
    const logs: string[] = [];
    const conflicted = new Loop({
      engine,
      client: () => client.paseo,
      now: () => new Date(clock),
      timer: timers.timer,
      wakeLog,
      log: (message) => logs.push(message),
      answers: {
        land: async () =>
          landing({ stage: "conflict", pr: null, conflict: { ledgers: ["a.yaml"], path: "/state/control-answers" } }),
        route: async () => {
          throw new Error("receipts unreadable");
        },
      },
    });
    const entry = await conflicted.wake("manual");
    expect(entry.narrative).toContain(
      "  3 answers wait to land, but maestro/answers conflicts with origin/main in a.yaml. Every answer is kept. Settle it by hand in /state/control-answers.",
    );
    expect([entry.answers?.routed, entry.answers?.waiting]).toEqual([[], 0]);
    expect(logs).toContain("the loop could not route the answers: receipts unreadable");
  });

  test("a step that failed with nothing waiting is a note, never Needs you", async () => {
    const { engine, client, wakeLog, timers } = await setup();
    const offline = new Loop({
      engine,
      client: () => client.paseo,
      now: () => new Date(clock),
      timer: timers.timer,
      wakeLog,
      log: () => {},
      answers: {
        land: async () => landing({ stage: "failed", pending: 0, pr: null, error: "origin/main could not be fetched" }),
        route: async () => [],
      },
    });
    const entry = await offline.wake("manual");
    expect(entry.narrative).toEqual([
      "Woke because you asked.",
      "Could not check the answers batch: origin/main could not be fetched",
      "Did nothing new this tick.",
    ]);
    expect(answersNotice(entry.answers?.landing ?? null)).toBeNull();
  });

  test("without a control repo there is no step 5, and the entry keeps its old shape", async () => {
    const { loop } = await setup();
    const entry = await loop.wake("manual");
    expect(entry.answers).toBeUndefined();
    expect(entry.narrative).toEqual(["Woke because you asked.", "Did nothing new this tick."]);
  });
});

describe("the wake and the plugin sweep (BRO-2995)", () => {
  test("a wake runs the sweep first, then reads the work as the sweep left it; without the sweep its read changes nothing", async () => {
    const { engine, fake, client, queue, timers, wakeLog } = await setup();
    // A run whose session closed: only the sweep's reconcile moves it to stuck.
    await queue("Closed under it", { dispatch: true });
    const agent = fake.agents.get("agent-1");
    if (agent) agent.status = "closed";
    const order: string[] = [];
    const reading = {
      list: (paseo?: Paseo) => {
        order.push("list");
        return engine.list(paseo);
      },
      settings: () => engine.settings(),
      flag: engine.flag.bind(engine),
      clearQuiet: engine.clearQuiet.bind(engine),
    };
    const unswept = new Loop({ engine: reading, client: () => client.paseo, timer: timers.timer, wakeLog, askMs: 100 });
    expect((await unswept.wake("manual")).needsYou.stuck).toBe(0);
    expect((await engine.list()).items[0]?.state).toBe("running");
    order.length = 0;
    const loop = new Loop({
      engine: reading,
      client: () => client.paseo,
      timer: timers.timer,
      wakeLog,
      askMs: 100,
      sweep: {
        run: async () => {
          order.push("sweep");
          await engine.upkeep(client.paseo);
        },
      },
    });
    const entry = await loop.wake("manual");
    expect(order).toEqual(["sweep", "list"]);
    expect(entry.needsYou.stuck).toBe(1);
  });

  test("a sweep that hangs never holds the wake: two wakes in a row complete and are recorded, each saying so", async () => {
    const { engine, client, timers, wakeLog, queue } = await setup();
    await queue("Waiting in the queue");
    const runs: number[] = [];
    const logs: string[] = [];
    const loop = new Loop({
      engine,
      client: () => client.paseo,
      timer: timers.timer,
      wakeLog,
      log: (line) => logs.push(line),
      askMs: 100,
      sweepWaitMs: 20,
      // Never settles: its lease is never released, so a second run would join it.
      sweep: {
        run: () => {
          runs.push(runs.length + 1);
          return new Promise<never>(() => undefined);
        },
      },
    });
    const first = await loop.wake("manual");
    const second = await loop.wake("manual");
    for (const entry of [first, second]) {
      expect(entry.skipped).toBeUndefined();
      expect(entry.narrative).toContain(SWEEP_OVERRAN);
    }
    expect((await loop.get()).recent.map((entry) => entry.tickId)).toEqual([second.tickId, first.tickId]);
    expect(runs).toEqual([1, 2]);
    expect(logs.filter((line) => line.includes("waited"))).toHaveLength(2);
  });
});
