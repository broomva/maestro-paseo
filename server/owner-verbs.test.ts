import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UNDO_MS } from "../shared/undo";
import { type Timer, UserError } from "./engine";
import { OwnerVerbs } from "./owner-verbs";
import type { Paseo } from "./runs";

let clock = Date.parse("2026-10-12T09:00:00.000Z");
const tickMs = (ms: number) => {
  clock += ms;
};

/** Timers the test fires by hand, after moving the same clock the ledger reads. */
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

async function setup(options: { client?: () => Paseo | null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "maestro-verbs-"));
  roots.push(root);
  const path = join(root, "verbs.jsonl");
  const timers = fakeTimers();
  const did: string[] = [];
  const build = (client = options.client) =>
    new OwnerVerbs({ path, now: () => new Date(clock), timer: timers.timer, client });
  const verbs = build();
  verbs.register<{ what: string }>("work.cancel", {
    apply: async ({ what }) => {
      did.push(what);
      if (what === "moved") throw new UserError("It moved on.");
      return `Canceled ${what}`;
    },
  });
  return { verbs, timers, did, path, build };
}

beforeEach(() => {
  clock = Date.parse("2026-10-12T09:00:00.000Z");
});

describe("the owner-verb ledger", () => {
  test("a verb records, waits out the window, applies, and leaves a receipt", async () => {
    const { verbs, timers, did, path } = await setup();
    const made = await verbs.schedule("work.cancel", { key: "work:a", label: "Canceled a", args: { what: "a" } });
    expect(made.appliesAt).toBe(new Date(clock + UNDO_MS).toISOString());
    expect(did).toEqual([]);
    expect((await verbs.list()).pending).toMatchObject([
      { receipt: made.receipt, verb: "work.cancel", key: "work:a", label: "Canceled a", remainingMs: UNDO_MS },
    ]);
    // Not before the window closes: a timer that fires early waits out the rest.
    tickMs(UNDO_MS - 1);
    await timers.fire();
    expect(did).toEqual([]);
    expect(timers.live()).toHaveLength(1);
    tickMs(1);
    await timers.fire();
    expect(did).toEqual(["a"]);
    const { pending, recent } = await verbs.list();
    expect(pending).toEqual([]);
    expect(recent).toMatchObject([
      { receipt: made.receipt, outcome: "applied", detail: "Canceled a", label: "Canceled a" },
    ]);
    expect(await readFile(path, "utf8")).toContain('"kind":"verb.applied"');
  });

  test("undo inside the window takes it back, and nothing is applied when the timer fires", async () => {
    const { verbs, timers, did } = await setup();
    const made = await verbs.schedule("work.cancel", { key: "work:a", label: "Canceled a", args: { what: "a" } });
    tickMs(UNDO_MS - 1000);
    expect(await verbs.undo(made.receipt)).toEqual({ undone: true });
    tickMs(1000);
    await timers.fire();
    expect(did).toEqual([]);
    expect((await verbs.list()).recent).toMatchObject([{ outcome: "undone", detail: "You undid it." }]);
    // Idempotent for a verb already undone.
    expect(await verbs.undo(made.receipt)).toEqual({ undone: true });
  });

  test("undo after it took effect is too late", async () => {
    const { verbs, timers } = await setup();
    const made = await verbs.schedule("work.cancel", { key: "work:a", label: "Canceled a", args: { what: "a" } });
    tickMs(UNDO_MS);
    await timers.fire();
    await expect(verbs.undo(made.receipt)).rejects.toThrow("Too late to undo");
    await expect(verbs.undo("nope")).rejects.toThrow("no such decision");
  });

  test("a second verb on the same thing waits for the first; a different key does not", async () => {
    const { verbs } = await setup();
    await verbs.schedule("work.cancel", { key: "work:a", label: "Canceled a", args: { what: "a" } });
    await expect(
      verbs.schedule("work.cancel", { key: "work:a", label: "Canceled a", args: { what: "a" } }),
    ).rejects.toThrow("Undo it first");
    await verbs.schedule("work.cancel", { key: "work:b", label: "Canceled b", args: { what: "b" } });
    expect((await verbs.list()).pending).toHaveLength(2);
  });

  test("a verb whose thing moved is dropped, with the reason in its receipt", async () => {
    const { verbs, timers } = await setup();
    await verbs.schedule("work.cancel", { key: "work:m", label: "Canceled m", args: { what: "moved" } });
    tickMs(UNDO_MS);
    await timers.fire();
    expect((await verbs.list()).recent).toMatchObject([{ outcome: "dropped", detail: "It moved on." }]);
  });

  test("a refusal at the call records nothing", async () => {
    const { verbs, path } = await setup();
    verbs.register<{ ok: boolean }>("work.stop", {
      check: async ({ ok }) => {
        if (!ok) throw new UserError("Only a run that is working can be stopped.");
      },
      apply: async () => "Stopped",
    });
    await expect(verbs.schedule("work.stop", { key: "work:a", label: "Stopped", args: { ok: false } })).rejects.toThrow(
      "Only a run that is working",
    );
    expect(await readFile(path, "utf8").catch(() => "")).toBe("");
  });

  test("a verb that supersedes replaces the pending one on its key", async () => {
    const { verbs, timers } = await setup();
    const applied: string[] = [];
    verbs.register<{ n: number }>("config.set", {
      supersedes: true,
      apply: async ({ n }) => {
        applied.push(String(n));
        return "Saved";
      },
    });
    const first = await verbs.schedule("config.set", { key: "config", label: "Saved Settings", args: { n: 1 } });
    tickMs(1000);
    const second = await verbs.schedule("config.set", { key: "config", label: "Saved Settings", args: { n: 2 } });
    const { pending, recent } = await verbs.list();
    expect(pending.map((verb) => verb.receipt)).toEqual([second.receipt]);
    expect(recent).toMatchObject([{ receipt: first.receipt, outcome: "undone", detail: "Replaced by a newer one." }]);
    tickMs(UNDO_MS);
    await timers.fire();
    expect(applied).toEqual(["2"]);
  });

  test("a restart inside the window still applies it, once; one overdue applies at the first sweep", async () => {
    const { verbs, timers, did, build } = await setup();
    await verbs.schedule("work.cancel", { key: "work:a", label: "Canceled a", args: { what: "a" } });
    verbs.stop();
    // The plugin restarts 3 s in: a new ledger arms the rest of the window.
    tickMs(3000);
    const restarted = build();
    restarted.register<{ what: string }>("work.cancel", {
      apply: async ({ what }) => {
        did.push(`again:${what}`);
        return "Canceled";
      },
    });
    expect(await restarted.resume()).toBe(false);
    expect(timers.live().filter((entry) => !entry.canceled).length).toBeGreaterThan(0);
    tickMs(UNDO_MS);
    // Overdue by the time the sweep comes: applied there, never twice.
    expect(await restarted.resume()).toBe(true);
    expect(await restarted.resume()).toBe(false);
    await timers.fire();
    expect(did).toEqual(["again:a"]);
  });

  test("a verb that needs the client waits for one, then applies", async () => {
    let client: Paseo | null = null;
    const { verbs, timers } = await setup({ client: () => client });
    const sent: string[] = [];
    verbs.register<{ text: string }>("session.prompt", {
      client: true,
      apply: async ({ text }, paseo) => {
        if (!paseo) throw new Error("no client");
        sent.push(text);
        return "Sent";
      },
    });
    await verbs.schedule("session.prompt", { key: "agent-1", label: "Sent", args: { text: "continue" } });
    tickMs(UNDO_MS);
    await timers.fire();
    expect(sent).toEqual([]);
    expect((await verbs.list()).pending).toHaveLength(1);
    client = {} as Paseo;
    await timers.fire();
    expect(sent).toEqual(["continue"]);
    expect((await verbs.list()).pending).toEqual([]);
  });

  test("receipts older than a day leave the list; the file keeps them", async () => {
    const { verbs, timers, path } = await setup();
    await verbs.schedule("work.cancel", { key: "work:a", label: "Canceled a", args: { what: "a" } });
    tickMs(UNDO_MS);
    await timers.fire();
    tickMs(25 * 60 * 60 * 1000);
    expect((await verbs.list()).recent).toEqual([]);
    expect(await readFile(path, "utf8")).toContain("verb.applied");
  });

  test("the window's timer and the sweep reaching a due verb together apply it exactly once, at any offset", async () => {
    for (let offset = 0; offset < 12; offset += 1) {
      for (const first of ["timer", "sweep"] as const) {
        const { verbs, timers, path } = await setup();
        let runs = 0;
        verbs.register<{ n: number }>("loop.wake", {
          apply: async () => {
            runs += 1;
            // A slow apply keeps the race open for whoever comes second.
            await new Promise((resolve) => setTimeout(resolve, 2));
            return "Woke";
          },
        });
        await verbs.schedule("loop.wake", { key: "loop", label: "Woke", args: { n: 1 } });
        tickMs(UNDO_MS);
        const lag = async () => {
          for (let tick = 0; tick < offset; tick += 1) await Promise.resolve();
        };
        const timer = async () => timers.fire();
        const sweep = async () => verbs.resume();
        const [one, two] = first === "timer" ? [timer, sweep] : [sweep, timer];
        const later = async () => {
          await lag();
          return two();
        };
        await Promise.all([one(), later()]);
        expect({ offset, first, runs }).toEqual({ offset, first, runs: 1 });
        const lines = (await readFile(path, "utf8")).trim().split("\n");
        expect(lines.filter((line) => line.includes("verb.applied"))).toHaveLength(1);
      }
    }
  });

  test("an undo that arrives while the verb is taking effect is too late, and the verb is applied once", async () => {
    const { verbs, timers } = await setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let runs = 0;
    verbs.register<{ n: number }>("loop.wake", {
      apply: async () => {
        runs += 1;
        entered();
        await held;
        return "Woke";
      },
    });
    const made = await verbs.schedule("loop.wake", { key: "loop", label: "Woke", args: { n: 1 } });
    tickMs(UNDO_MS);
    const firing = timers.fire();
    await inside;
    await expect(verbs.undo(made.receipt)).rejects.toThrow("it is taking effect");
    release();
    await firing;
    expect(runs).toBe(1);
    expect((await verbs.list()).recent).toMatchObject([{ outcome: "applied" }]);
  });

  test("an undo written by another process after this one read the verb, before it applied, stops it", async () => {
    const { verbs, timers, build } = await setup();
    // This daemon's ledger reads the verb as due, then waits; a second daemon undoes it meanwhile.
    class Slow extends OwnerVerbs {
      gate: Promise<void> | null = null;
      reads = 0;
      protected override async read() {
        const entries = await super.read();
        this.reads += 1;
        if (this.reads === 1 && this.gate) await this.gate;
        return entries;
      }
    }
    const slow = new Slow({
      path: (verbs as unknown as { path: string }).path,
      now: () => new Date(clock),
      timer: timers.timer,
    });
    let runs = 0;
    slow.register<{ n: number }>("loop.wake", {
      apply: async () => {
        runs += 1;
        return "Woke";
      },
    });
    const made = await slow.schedule("loop.wake", { key: "loop", label: "Woke", args: { n: 1 } });
    tickMs(UNDO_MS);
    let open!: () => void;
    slow.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    slow.reads = 0;
    const firing = timers.fire();
    // The other daemon (a reload that overlapped this one) takes the verb back while the first read is held.
    await build().undo(made.receipt);
    open();
    await firing;
    expect(runs).toBe(0);
    expect((await verbs.list()).recent).toMatchObject([{ outcome: "undone" }]);
  });

  test("a line torn by a crash stays a line of its own: the next record is not lost with it", async () => {
    const { verbs, path, build } = await setup();
    const made = await verbs.schedule("work.cancel", { key: "work:a", label: "Canceled a", args: { what: "a" } });
    // The process died mid-append: a fragment with no newline ends the file.
    await appendFile(path, '{"kind":"verb.undo');
    expect(await verbs.undo(made.receipt)).toEqual({ undone: true });
    // A restart reads the undo, so the verb is not applied behind your back.
    const restarted = build();
    let runs = 0;
    restarted.register<{ what: string }>("work.cancel", {
      apply: async () => {
        runs += 1;
        return "Canceled";
      },
    });
    tickMs(UNDO_MS);
    expect(await restarted.resume()).toBe(false);
    expect(runs).toBe(0);
    expect((await restarted.list()).recent).toMatchObject([{ receipt: made.receipt, outcome: "undone" }]);
  });
});
