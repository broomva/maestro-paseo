// Cancel for queued work, Stop (with discard), Unblock and Leave it running: each waits the 8 s window with a
// receipt and an Undo, is refused at the call when it cannot work, and is checked again when it applies (BRO-2999, B4).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MaestroConfig } from "../shared/contracts";
import { UNDO_MS } from "../shared/undo";
import { defaultConfig } from "./config";
import { Engine, type Timer } from "./engine";
import { fakePaseo } from "./fake-paseo";
import { OwnerVerbs } from "./owner-verbs";
import { WorkStore } from "./store";
import { registerWorkVerbs, workVerbHandlers } from "./verb-specs";

let clock = Date.parse("2026-10-12T09:00:00.000Z");
const tickMs = (ms: number) => {
  clock += ms;
};

function fakeTimers() {
  const armed: Array<{ run: () => Promise<void>; canceled: boolean }> = [];
  const timer: Timer = (run) => {
    const entry = { run, canceled: false };
    armed.push(entry);
    return () => {
      entry.canceled = true;
    };
  };
  return {
    timer,
    fire: async () => {
      for (const entry of armed.splice(0)) if (!entry.canceled) await entry.run();
    },
  };
}

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

beforeEach(() => {
  clock = Date.parse("2026-10-12T09:00:00.000Z");
});

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "maestro-work-verbs-")));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  const config: MaestroConfig = { ...defaultConfig(), workRoot: join(root, "work"), provider: "claude", modeId: null };
  const timers = fakeTimers();
  const now = () => new Date(clock);
  const engine = new Engine({
    now,
    config: async () => config,
    log: () => {},
    timer: timers.timer,
    claimWaitMs: 200,
    git: async () => ({ branch: null, githubRepo: null }),
    merged: async () => null,
  });
  const fake = fakePaseo({ now });
  const verbs = new OwnerVerbs({ path: join(root, "verbs.jsonl"), now, timer: timers.timer, client: () => fake.paseo });
  registerWorkVerbs({ verbs, engine });
  const work = workVerbHandlers({ verbs, engine });
  const create = (dispatch: boolean) =>
    engine.create(fake.paseo, {
      title: "Persist run transcripts",
      brief: "",
      repo,
      gate: "human",
      check: "",
      initiative: "",
      dispatch,
    });
  /** Let the window close and the ledger apply what is due. */
  const wait = async () => {
    tickMs(UNDO_MS);
    await timers.fire();
  };
  return { engine, fake, verbs, work, create, wait, timers };
}

describe("cancel for work that is not at your gate", () => {
  test("it waits 8 s, with a receipt, and then closes the work", async () => {
    const { engine, work, create, verbs, wait } = await setup();
    const queued = await create(false);
    const made = await work.cancel(queued.id);
    if (!made) throw new Error("expected a receipt");
    expect(made.appliesAt).toBe(new Date(clock + UNDO_MS).toISOString());
    expect(made.item.state).toBe("proposed");
    tickMs(UNDO_MS - 1);
    expect((await engine.get(queued.id)).item.state).toBe("proposed");
    await wait();
    expect((await engine.get(queued.id)).item.state).toBe("canceled");
    expect((await verbs.list()).recent).toMatchObject([
      { receipt: made.receipt, outcome: "applied", verb: "work.cancel" },
    ]);
  });

  test("Undo inside the window leaves it queued", async () => {
    const { engine, work, create, verbs, wait } = await setup();
    const queued = await create(false);
    const made = await work.cancel(queued.id);
    await verbs.undo(made?.receipt ?? "");
    await wait();
    expect((await engine.get(queued.id)).item.state).toBe("proposed");
    // And it can be canceled again, since the first was undone.
    expect(await work.cancel(queued.id)).not.toBeNull();
  });

  test("work at your gate keeps its own window, and a run is refused at the call", async () => {
    const { engine, work, create, fake } = await setup();
    const running = await create(true);
    await expect(work.cancel(running.id)).rejects.toThrow("Stop the run first");
    const agent = fake.agents.get("agent-1");
    if (agent) agent.status = "idle";
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "completed" }, []);
    // At the gate it is a decision of its own (Engine.verdict), not the ledger's.
    expect(await work.cancel(running.id)).toBeNull();
  });

  test("work that reached your gate during the window is not canceled behind your back", async () => {
    const { engine, work, create, fake, verbs, wait } = await setup();
    const stuck = await create(true);
    await engine.stopRun(fake.paseo, stuck.id, { discard: true });
    const made = await work.cancel(stuck.id);
    expect(made).not.toBeNull();
    // The session is brought back and lands at the gate before the window closes.
    await engine.unblock(fake.paseo, stuck.id, "go on");
    const agent = fake.agents.get("agent-2") ?? fake.agents.get("agent-1");
    if (agent) agent.status = "idle";
    await engine.onTurnEnded({ id: agent?.id ?? "agent-1" }, { kind: "completed" }, []);
    expect((await engine.get(stuck.id)).item.state).toBe("review");
    await wait();
    expect((await engine.get(stuck.id)).item.state).toBe("review");
    expect((await verbs.list()).recent[0]).toMatchObject({ outcome: "dropped" });
  });
});

describe("stop, with and without discard", () => {
  test("the refusal for work not committed is at the call, and a discard waits the window, then stops", async () => {
    const { engine, work, create, fake, wait } = await setup();
    const running = await create(true);
    // Its folder is no git worktree, so nothing proves stopping loses nothing: refused, then confirmed.
    await expect(work.stop(running.id, false)).rejects.toThrow("Not stopped:");
    expect(fake.archived).toEqual([]);
    const made = await work.stop(running.id, true);
    expect(made.item.state).toBe("running");
    expect(fake.archived).toEqual([]);
    await wait();
    expect(fake.archived).toEqual(["agent-1"]);
    expect((await engine.get(running.id)).item).toMatchObject({ state: "blocked", reason: "You stopped the run" });
  });

  test("Undo inside the window leaves the run running", async () => {
    const { engine, work, create, fake, verbs, wait } = await setup();
    const running = await create(true);
    const made = await work.stop(running.id, true);
    await verbs.undo(made.receipt);
    await wait();
    expect(fake.archived).toEqual([]);
    expect((await engine.get(running.id)).item.state).toBe("running");
  });

  test("a run that already finished is refused at the call", async () => {
    const { work, create } = await setup();
    const queued = await create(false);
    await expect(work.stop(queued.id, true)).rejects.toThrow("Only a run that is working");
  });
});

describe("unblock and leave it running", () => {
  test("Unblock waits the window, then sends the session on; Undo keeps it stuck", async () => {
    const { engine, work, create, fake, verbs, wait } = await setup();
    const running = await create(true);
    await engine.stopRun(fake.paseo, running.id, { discard: true });
    const first = await work.unblock(running.id, "carry on");
    await verbs.undo(first.receipt);
    await wait();
    expect((await engine.get(running.id)).item.state).toBe("blocked");
    await work.unblock(running.id, "carry on");
    await wait();
    expect((await engine.get(running.id)).item.state).toBe("running");
    await expect(work.unblock(running.id, "again")).rejects.toThrow("Only stuck work can be unblocked.");
  });

  test("Leave it running waits the window, then writes your receipt and clears the flag", async () => {
    const { engine, work, create, wait } = await setup();
    const running = await create(true);
    const store = new WorkStore((await engine.settings()).workRoot);
    const found = await store.findById(running.id);
    await store.mutate(
      running.id,
      () => ({
        events: [
          {
            ts: new Date(clock).toISOString(),
            type: "loop.flagged",
            actor: "maestro",
            kind: "quiet",
            reason: "Quiet for 40 minutes.",
          },
        ],
      }),
      found.dir,
    );
    expect((await engine.get(running.id)).item.flag).toMatchObject({ kind: "quiet" });
    await work.leaveRunning(running.id);
    expect((await engine.get(running.id)).item.flag).toMatchObject({ kind: "quiet" });
    await wait();
    expect((await engine.get(running.id)).item.flag).toBeNull();
  });

  test("Leave it running is refused unless the loop flagged it quiet", async () => {
    const { work, create } = await setup();
    const running = await create(true);
    await expect(work.leaveRunning(running.id)).rejects.toThrow("flagged as quiet");
  });
});
