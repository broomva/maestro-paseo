import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
});
