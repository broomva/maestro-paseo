import { describe, expect, test } from "bun:test";
import type { Timer } from "./engine";
import type { Paseo } from "./runs";
import { SWEEP_MS, Sweep, type SweepStep, sweepEvery } from "./sweep";

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

/** A step whose every run waits until the test lets it end. */
function heldStep(name: string, background = false) {
  const calls: Array<Paseo | null> = [];
  const waiting: Array<() => void> = [];
  const step: SweepStep = {
    name,
    background,
    run: (paseo) => {
      calls.push(paseo);
      return new Promise<void>((resolve) => waiting.push(resolve));
    },
  };
  const release = () => {
    for (const done of waiting.splice(0)) done();
  };
  return { step, calls, release };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const client = { id: "client" } as unknown as Paseo;

describe("the plugin sweep (BRO-2995)", () => {
  test("one sweep at a time: one asked for meanwhile is the next, shared, and reads the client as it is then", async () => {
    let paseo: Paseo | null = null;
    const work = heldStep("the work");
    const sweep = new Sweep({ steps: [work.step], client: () => paseo, log: () => undefined });
    const first = sweep.run();
    await flush();
    expect(work.calls).toEqual([null]);
    // A client arrives mid-sweep; two ask for a sweep: both get the one after, which has it.
    paseo = client;
    const second = sweep.run();
    const third = sweep.run();
    expect(second).toBe(third);
    await flush();
    expect(work.calls).toHaveLength(1);
    work.release();
    expect((await first).connected).toBe(false);
    await flush();
    expect(work.calls).toEqual([null, client]);
    work.release();
    expect(await second).toMatchObject({ connected: true, steps: [{ name: "the work", outcome: "done" }] });
    expect(work.calls).toHaveLength(2);
  });

  test("a background step is started, not waited for, and never two at once", async () => {
    const work: string[] = [];
    const slow = heldStep("the loops' drift", true);
    const sweep = new Sweep({
      steps: [{ name: "the work", run: async () => void work.push("ran") }, slow.step],
      client: () => client,
      log: () => undefined,
    });
    const first = await sweep.run();
    expect(first.steps).toEqual([
      { name: "the work", outcome: "done", error: null },
      { name: "the loops' drift", outcome: "started", error: null },
    ]);
    const second = await sweep.run();
    expect(second.steps[1]).toEqual({ name: "the loops' drift", outcome: "running", error: null });
    expect(work).toEqual(["ran", "ran"]);
    expect(slow.calls).toHaveLength(1);
    slow.release();
    await sweep.settled();
    expect((await sweep.run()).steps[1]?.outcome).toBe("started");
    expect(slow.calls).toHaveLength(2);
    slow.release();
    await sweep.settled();
  });

  test("a step that fails is logged and keeps no other from running", async () => {
    const logged: string[] = [];
    const ran: string[] = [];
    const sweep = new Sweep({
      steps: [
        { name: "the work", run: async () => Promise.reject(new Error("store unreadable")) },
        { name: "the asks", background: true, run: async () => Promise.reject(new Error("offline")) },
        { name: "the locks", run: async () => void ran.push("locks") },
      ],
      client: () => null,
      log: (line) => logged.push(line),
    });
    const run = await sweep.run();
    await sweep.settled();
    expect(run.steps.map((step) => [step.name, step.outcome, step.error])).toEqual([
      ["the work", "failed", "store unreadable"],
      ["the asks", "started", null],
      ["the locks", "done", null],
    ]);
    expect(ran).toEqual(["locks"]);
    expect(logged).toEqual(["sweep: the work failed: store unreadable", "sweep: the asks failed: offline"]);
  });

  test("it sweeps at once on start, then every period after each sweep ends, until stopped", async () => {
    const timers = fakeTimers();
    const runs: string[] = [];
    const after: boolean[] = [];
    const sweep = new Sweep({
      steps: [{ name: "the work", run: async () => void runs.push("swept") }],
      client: () => client,
      everyMs: 45_000,
      timer: timers.timer,
      log: () => undefined,
      after: (run) => after.push(run.connected),
    });
    sweep.start();
    sweep.start();
    await flush();
    expect(runs).toEqual(["swept"]);
    expect(timers.live().map((entry) => entry.ms)).toEqual([45_000]);
    await timers.fire();
    expect(runs).toEqual(["swept", "swept"]);
    expect(timers.live().map((entry) => entry.ms)).toEqual([45_000]);
    expect(after).toEqual([true, true]);
    sweep.stop();
    expect(timers.live()).toEqual([]);
    await timers.fire();
    expect(runs).toHaveLength(2);
  });

  test("its period: SWEEP_MS, or MAESTRO_PASEO_SWEEP_SECONDS when that is a number of seconds", () => {
    expect(SWEEP_MS).toBe(30_000);
    expect(sweepEvery({})).toBe(SWEEP_MS);
    expect(sweepEvery({ MAESTRO_PASEO_SWEEP_SECONDS: "120" })).toBe(120_000);
    expect(sweepEvery({ MAESTRO_PASEO_SWEEP_SECONDS: "0" })).toBe(SWEEP_MS);
    expect(sweepEvery({ MAESTRO_PASEO_SWEEP_SECONDS: "soon" })).toBe(SWEEP_MS);
  });
});
