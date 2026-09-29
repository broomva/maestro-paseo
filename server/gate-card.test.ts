import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerTarget, cardView } from "../client/gate-state";
import type { MaestroConfig } from "../shared/contracts";
import { GATE_CARD_KIND, GATE_CARD_VERSION, type GateCardData, GateCardSchema } from "../shared/gate-card";
import { Engine, type EngineOptions } from "./engine";
import type { WorkEvent } from "./events";
import { fakePaseo } from "./fake-paseo";
import { GateCards, landingOf, lastLanding } from "./gate-card";
import type { Paseo } from "./runs";

let clock = Date.parse("2026-09-29T09:00:00.000Z");
beforeEach(() => {
  clock = Date.parse("2026-09-29T09:00:00.000Z");
});

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup(options: { landed?: EngineOptions["landed"] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "maestro-gate-card-"));
  roots.push(root);
  const repo = join(root, "repo");
  // A git repository as far as Maestro checks: runs branch a worktree from it.
  await mkdir(join(repo, ".git"), { recursive: true });
  const config: MaestroConfig = {
    workRoot: join(root, "work"),
    provider: "claude",
    modeId: null,
    isolation: "worktree",
  };
  const fake = fakePaseo();
  const logs: string[] = [];
  const log = (message: string) => logs.push(message);
  /** One plugin process: an engine and its gate cards. A second call is the plugin after a restart. */
  const boot = (landed?: EngineOptions["landed"]) => {
    const cards = new GateCards(() => fake.paseo, log);
    return new Engine({
      now: () => new Date(clock),
      config: async () => config,
      log,
      landed: landed ?? ((before, after) => cards.landed(before, after)),
    });
  };
  const engine = boot(options.landed);
  const create = (extra: Partial<{ gate: "human" | "auto"; check: string }> = {}, on: Engine = engine) =>
    on.create(fake.paseo, {
      title: "Persist run transcripts",
      brief: "Store it on the Run record.",
      repo,
      gate: extra.gate ?? "human",
      check: extra.check ?? "",
      initiative: "",
      dispatch: true,
    });
  const endTurn = async (
    on: Engine = engine,
    outcome: Parameters<Engine["onTurnEnded"]>[1] = { kind: "completed" },
    turnId: string | null = null,
  ) => {
    const agent = fake.agents.get("agent-1");
    if (agent) agent.status = "idle";
    await on.onTurnEnded({ id: "agent-1" }, outcome, [], turnId);
  };
  const settle = async (id: string, want: string) => {
    for (let i = 0; i < 100; i += 1) {
      const { item } = await engine.get(id);
      if (item.state === want) return item;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`never reached ${want}`);
  };
  return { engine, boot, fake, logs, create, endTurn, settle };
}

describe("the gate card in the worker's timeline", () => {
  test("a run that lands at your gate leaves one card in its own session", async () => {
    const { create, endTurn, fake } = await setup();
    const item = await create();
    await endTurn();
    await flush();
    expect(fake.appended).toEqual([
      {
        agentId: "agent-1",
        item: {
          type: "plugin",
          id: expect.stringContaining(item.id),
          kind: GATE_CARD_KIND,
          version: GATE_CARD_VERSION,
          data: { workId: item.id, landing: expect.any(Number), agentId: "agent-1" },
        },
      },
    ]);
  });

  test("the card names its landing, and the wire says which landing is current", async () => {
    const { create, endTurn, fake, engine } = await setup();
    const item = await create();
    expect((await engine.get(item.id)).item.landing).toBeUndefined();
    await endTurn();
    await flush();
    const card = GateCardSchema.parse(fake.appended[0]?.item.data);
    expect(fake.appended[0]?.item.id).toBe(`${GATE_CARD_KIND}:${item.id}:${card.landing}`);
    const landed = (await engine.get(item.id)).item;
    expect(landed.landing).toBe(card.landing);
    expect(cardView(card, landed)).toBe("deciding");
    // Approved, the work has left the gate: the same card now says how, and offers nothing.
    const done = await engine.verdict(fake.paseo, item.id, "approve", "");
    expect(done.landing).toBe(card.landing);
    expect(cardView(card, done)).toBe("resolved");
  });

  test("after Send back and a new landing, the older card offers no verbs and the new one does", async () => {
    const { create, endTurn, fake, engine } = await setup();
    const item = await create();
    await endTurn();
    await engine.verdict(fake.paseo, item.id, "revise", "Add a replay test");
    clock += 60_000;
    await endTurn();
    await flush();
    const [older, newer] = fake.appended.map((entry) => GateCardSchema.parse(entry.item.data)) as [
      GateCardData,
      GateCardData,
    ];
    const current = (await engine.get(item.id)).item;
    expect(current.state).toBe("review");
    expect(newer.landing ?? -1).toBeGreaterThan(older.landing ?? -1);
    expect(cardView(older, current)).toBe("superseded");
    expect(cardView(newer, current)).toBe("deciding");
  });

  test("a card in session A, after the work moved to session B, offers nothing and cannot answer B's question", async () => {
    const { create, endTurn, fake, engine } = await setup();
    const item = await create();
    await endTurn();
    await flush();
    const cardA = GateCardSchema.parse(fake.appended[0]?.item.data);
    expect(cardA.agentId).toBe("agent-1");
    // Session A is continued after landing and its turn fails: the work is stuck, and a dispatch moves it to session B.
    await engine.onTurnStarted({ id: "agent-1" });
    await engine.onTurnEnded({ id: "agent-1" }, { kind: "failed", error: { message: "crashed" } }, [], "t2");
    expect((await engine.get(item.id)).item.state).toBe("blocked");
    await engine.dispatch(fake.paseo, item.id);
    await engine.onPermissionRequested(
      { id: "agent-2" },
      { id: "p1", name: "Bash", title: "Run a command", description: "rm -rf dist" },
    );
    const asking = (await engine.get(item.id)).item;
    expect(asking).toMatchObject({ state: "review", worker: { agentId: "agent-2" }, permission: { requestId: "p1" } });
    expect(cardView(cardA, asking)).toBe("superseded");
    expect(answerTarget(cardA, asking)).toBeNull();
    // Even a card naming B's current landing answers only for its own session.
    expect(answerTarget({ landing: asking.landing ?? -1, agentId: "agent-1" }, asking)).toBeNull();
    expect(answerTarget({ landing: asking.landing ?? -1, agentId: "agent-2" }, asking)).toBe("agent-2");
  });

  test("a landed callback that throws at once is logged, and the checks still start", async () => {
    const { create, endTurn, settle, logs } = await setup({
      landed: () => {
        throw new Error("boom");
      },
    });
    const item = await create({ check: "true" });
    await endTurn();
    await settle(item.id, "review");
    expect(logs.some((line) => line.includes(`landing hook failed for ${item.id}: boom`))).toBe(true);
  });

  test("with checks, an append that never answers does not hold the checks run open", async () => {
    const { create, endTurn, fake, engine, settle } = await setup();
    const runs: Promise<void>[] = [];
    const spy = engine as unknown as { runChecksFor: (...args: unknown[]) => Promise<void> };
    const original = spy.runChecksFor.bind(engine);
    spy.runChecksFor = (...args) => {
      const run = original(...args);
      runs.push(run);
      return run;
    };
    fake.setAppend("hang");
    const item = await create({ check: "true" });
    await endTurn();
    await settle(item.id, "review");
    await flush();
    expect(fake.appended).toHaveLength(1);
    expect(runs).toHaveLength(1);
    const finished = await Promise.race([
      Promise.all(runs).then(() => "finished"),
      new Promise((resolve) => setTimeout(() => resolve("held"), 500)),
    ]);
    expect(finished).toBe("finished");
  });

  test("a repeat of the same turn end adds no second card", async () => {
    const { create, endTurn, fake, engine } = await setup();
    await create();
    await endTurn(engine, { kind: "completed" }, "t1");
    await endTurn(engine, { kind: "completed" }, "t1");
    await flush();
    expect(fake.appended).toHaveLength(1);
  });

  test("after a restart, a repeat end still adds no card: the landing was already there when it was read", async () => {
    const { create, endTurn, fake, boot } = await setup();
    await create();
    await endTurn(undefined, { kind: "completed" }, "t1");
    await flush();
    const restarted = boot();
    await endTurn(restarted, { kind: "completed" }, "t1");
    await flush();
    expect(fake.appended).toHaveLength(1);
  });

  test("with checks, the card comes when the checks land the run, not at the turn end", async () => {
    const { create, endTurn, fake, settle } = await setup();
    const item = await create({ check: "true" });
    await endTurn();
    expect(fake.appended).toHaveLength(0);
    await settle(item.id, "review");
    await flush();
    expect(fake.appended).toHaveLength(1);
    expect(fake.appended[0]?.item.data).toMatchObject({ workId: item.id, agentId: "agent-1" });
  });

  test("work that closes itself or gets stuck leaves no card", async () => {
    const passing = await setup();
    const done = await passing.create({ gate: "auto", check: "true" });
    await passing.endTurn();
    await passing.settle(done.id, "done");
    const failing = await setup();
    const stuck = await failing.create({ gate: "auto", check: "exit 1" });
    await failing.endTurn();
    await failing.settle(stuck.id, "blocked");
    const crashed = await setup();
    await crashed.create();
    await crashed.endTurn(undefined, { kind: "failed", error: { message: "boom" } });
    await flush();
    expect([...passing.fake.appended, ...failing.fake.appended, ...crashed.fake.appended]).toEqual([]);
  });

  test("each landing gets its own card: sent back and landed again is a second one", async () => {
    const { create, endTurn, fake, engine } = await setup();
    const item = await create();
    await endTurn();
    await engine.verdict(fake.paseo, item.id, "revise", "Add a replay test");
    clock += 60_000;
    await endTurn();
    await flush();
    expect(fake.appended).toHaveLength(2);
    const ids = fake.appended.map((entry) => entry.item.id);
    expect(new Set(ids).size).toBe(2);
  });

  test("an append that fails is logged, and the landing stands", async () => {
    const { create, endTurn, fake, engine, logs } = await setup();
    fake.setAppend("throw");
    const item = await create();
    await endTurn();
    await flush();
    const { item: landed, events } = await engine.get(item.id);
    expect(landed.state).toBe("review");
    expect(events.at(-1)?.text).toBe("Waiting on you");
    expect(fake.appended).toHaveLength(1);
    expect(logs.some((line) => line.includes(`gate card for ${item.id} not added: agent is not loaded`))).toBe(true);
  });

  test("an append that never answers does not hold up the landing", async () => {
    const { create, endTurn, fake, engine } = await setup();
    fake.setAppend("hang");
    const item = await create();
    const ended = await Promise.race([
      endTurn().then(() => "ended"),
      new Promise((resolve) => setTimeout(() => resolve("held"), 500)),
    ]);
    expect(ended).toBe("ended");
    expect((await engine.get(item.id)).item.state).toBe("review");
    expect(fake.appended).toHaveLength(1);
  });
});

describe("landingOf and GateCards", () => {
  const ts = "2026-09-29T09:00:00.000Z";
  const bound: WorkEvent = {
    ts,
    type: "dispatched",
    actor: "human",
    agentId: "agent-9",
    workspaceId: "ws-9",
    provider: "claude",
    branch: null,
    cwd: null,
  };
  const ended: WorkEvent = {
    ts,
    type: "turn.ended",
    actor: "agent",
    agentId: "agent-9",
    outcome: "completed",
    error: null,
    summary: "",
  };
  const toReview: WorkEvent = { ts, type: "state", actor: "maestro", from: "running", to: "review", reason: null };
  const toBlocked: WorkEvent = { ts, type: "state", actor: "maestro", from: "running", to: "blocked", reason: "x" };
  const work = (events: WorkEvent[], id = "w1") =>
    ({ contract: { id }, events }) as unknown as Parameters<GateCards["landed"]>[1];

  test("a landing is a move into review written after the item was read", () => {
    const before = work([bound]);
    expect(landingOf(before, work([bound, ended, toReview]))).toBe(2);
    expect(landingOf(before, work([bound, ended, toBlocked]))).toBeNull();
    expect(landingOf(before, work([bound, toReview, ended]))).toBeNull();
    // The change was dropped: the last event is a landing the caller had already read.
    const seen = work([bound, ended, toReview]);
    expect(landingOf(seen, seen)).toBeNull();
  });

  function cardsWith(paseo: Paseo | null) {
    const logs: string[] = [];
    return {
      cards: new GateCards(
        () => paseo,
        (line) => logs.push(line),
      ),
      logs,
    };
  }

  test("one landing reported twice is carded once, and an older one after a newer one not at all", async () => {
    const fake = fakePaseo();
    const { cards } = cardsWith(fake.paseo);
    const before = work([bound]);
    const first = work([bound, ended, toReview]);
    await cards.landed(before, first);
    await cards.landed(before, first);
    expect(fake.appended).toHaveLength(1);
    await cards.landed(before, work([bound, ended, toReview, ended, toReview]));
    expect(fake.appended).toHaveLength(2);
    await cards.landed(before, first);
    expect(fake.appended).toHaveLength(2);
    expect(fake.appended.map((entry) => entry.item.id)).toEqual([`${GATE_CARD_KIND}:w1:2`, `${GATE_CARD_KIND}:w1:4`]);
  });

  test("two reports of one landing at once still append once", async () => {
    const fake = fakePaseo();
    const { cards } = cardsWith(fake.paseo);
    const before = work([bound]);
    const after = work([bound, ended, toReview]);
    await Promise.all([cards.landed(before, after), cards.landed(before, after)]);
    expect(fake.appended).toHaveLength(1);
    expect(fake.appended[0]?.item.data).toEqual({ workId: "w1", landing: 2, agentId: "agent-9" });
  });

  test("the latest landing is the last move into review, whatever came after it", () => {
    expect(lastLanding(work([bound]).events)).toBeNull();
    expect(lastLanding(work([bound, ended, toReview, ended, toBlocked]).events)).toBe(2);
    expect(lastLanding(work([bound, ended, toReview, ended, toReview]).events)).toBe(4);
  });

  test("work with no session has nowhere to put a card", async () => {
    const fake = fakePaseo();
    const { cards } = cardsWith(fake.paseo);
    await cards.landed(work([]), work([ended, toReview]));
    expect(fake.appended).toHaveLength(0);
  });

  test("with no Paseo connection yet, or an append that fails, it logs and never rejects", async () => {
    const offline = cardsWith(null);
    await expect(offline.cards.landed(work([bound]), work([bound, ended, toReview]))).resolves.toBeUndefined();
    expect(offline.logs).toEqual(["gate card for w1 not added: Maestro has no connection to Paseo yet"]);
    const fake = fakePaseo();
    fake.setAppend("throw");
    const failing = cardsWith(fake.paseo);
    await expect(failing.cards.landed(work([bound]), work([bound, ended, toReview]))).resolves.toBeUndefined();
    expect(failing.logs).toEqual(["gate card for w1 not added: agent is not loaded"]);
  });
});
