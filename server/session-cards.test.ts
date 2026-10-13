import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeWork } from "../client/fake-work";
import { CARD_KIND, CARD_VERSION, CardSchema, cardId } from "../shared/card";
import type { MaestroConfig, WorkItem } from "../shared/contracts";
import { type NeedRow, workKey } from "../shared/needs";
import { defaultConfig } from "./config";
import { Engine, UNDO_MS } from "./engine";
import type { WorkEvent } from "./events";
import { fakePaseo } from "./fake-paseo";
import { needsOf, type OpenApproval } from "./needs";
import {
  APPEND_MS,
  CARD_ATTEMPTS,
  cardsDue,
  type Landing,
  landingOf,
  lastLanding,
  reasonVersion,
  SessionCards,
  STUCK_CARD_MS,
} from "./session-cards";

let clock = Date.parse("2026-09-29T09:00:00.000Z");
beforeEach(() => {
  clock = Date.parse("2026-09-29T09:00:00.000Z");
});

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

// Real id spaces (docs/design/next/worker-brief.md): a Paseo agent id, the Claude session it runs and the work
// are three different ids. A fixture that used one id for all three would test the mirror, not the code.
const AGENT = "6f1c2e0a-93b4-4d7e-8a15-2c9d0b7e41aa";
const OTHER_AGENT = "b3d9a7f2-0c51-4e8a-9f6d-71e2a4c85b03";
const WORK = "w-20261012-ledger-1f3a";
const worker = { agentId: AGENT, workspaceId: "ws-5d2" };

describe("which cards are due (cardsDue)", () => {
  const NOW = Date.parse("2026-10-12T15:00:00.000Z");
  const holdOf = (items: WorkItem[], approvals: OpenApproval[] = []): NeedRow[] =>
    needsOf({ items, asks: [], reviews: [], landing: null, workspace: "broomva", approvals }, NOW).rows;
  const none = new Map<string, Landing>();

  test("a permission prompt is an approval card in the session that is paused on it, versioned by its request", () => {
    const item = fakeWork(WORK, "review", worker, {
      permission: { requestId: "req-7c1", title: "Run a command", detail: "gh pr merge 933" },
    });
    const due = cardsDue({ holds: holdOf([item]), items: [item], landings: none, now: NOW });
    expect(due).toEqual([{ agentId: AGENT, card: { kind: "approval", key: `work:${WORK}`, version: "req-7c1" } }]);
  });

  test("an action an agent asked leave for is carded in the session that asked, under its own key", () => {
    const asked: OpenApproval = {
      id: "e4a1c0",
      at: "2026-10-12T09:00:00.000Z",
      agentId: OTHER_AGENT,
      action: "gh pr merge 933 --squash @ ce73104",
      heldBy: "gate",
      title: "Merge #933",
      scope: "broomva",
      evidence: [],
      after: [],
    };
    const due = cardsDue({ holds: holdOf([], [asked]), items: [], landings: none, now: NOW });
    expect(due).toEqual([
      { agentId: OTHER_AGENT, card: { kind: "approval", key: "approval:e4a1c0", version: "approval:e4a1c0" } },
    ]);
  });

  test("an owner step that names a session is carded there; one that names none (queued work) is not", () => {
    const yours = fakeWork("w-yours", "proposed", null, {
      flag: { kind: "yours", reason: "Only you may start it.", at: "2026-10-12T12:00:00.000Z" },
    });
    expect(cardsDue({ holds: holdOf([yours]), items: [yours], landings: none, now: NOW })).toEqual([]);
    const row: NeedRow = {
      ...holdOf([yours])[0],
      session: { agentId: AGENT, name: "6f1c2e0a", waiting: true },
    } as NeedRow;
    expect(cardsDue({ holds: [row], items: [], landings: none, now: NOW })).toEqual([
      { agentId: AGENT, card: { kind: "owner_step", key: "work:w-yours", version: "2026-10-12T12:00:00.000Z" } },
    ]);
  });

  test("finished work is carded only for a landing seen live, still current, in its own session, and held by nothing", () => {
    const landed = fakeWork(WORK, "review", worker, { landing: 4, permission: null });
    const seen = new Map<string, Landing>([[WORK, { landing: 4, agentId: AGENT }]]);
    expect(cardsDue({ holds: [], items: [landed], landings: seen, now: NOW })).toEqual([
      { agentId: AGENT, card: { kind: "finished", key: workKey(WORK), version: "4" } },
    ]);
    // Work that landed before this process saw it is never carded (a restart does not card the whole gate).
    expect(cardsDue({ holds: [], items: [landed], landings: none, now: NOW })).toEqual([]);
    // A later landing, a session that is no longer the worker, and a permission prompt each take the card away.
    expect(cardsDue({ holds: [], items: [{ ...landed, landing: 6 }], landings: seen, now: NOW })).toEqual([]);
    const moved = { ...landed, worker: { ...landed.worker, agentId: OTHER_AGENT } } as WorkItem;
    expect(cardsDue({ holds: [], items: [moved], landings: seen, now: NOW })).toEqual([]);
    const asking = { ...landed, permission: { requestId: "r", title: "Run", detail: null } };
    const holds = holdOf([asking]);
    const due = cardsDue({ holds, items: [asking], landings: seen, now: NOW });
    expect(due.map((entry) => entry.card.kind)).toEqual(["approval"]);
  });

  test("work that stopped a moment ago is a health card; one that stopped long ago is Health's, not a card", () => {
    const fresh = fakeWork(WORK, "blocked", worker, {
      reason: "Session ended mid-turn",
      updatedAt: "2026-10-12T14:55:00.000Z",
    });
    const old = fakeWork("w-old", "blocked", worker, {
      reason: "Session ended mid-turn",
      updatedAt: new Date(NOW - STUCK_CARD_MS - 1000).toISOString(),
    });
    const due = cardsDue({ holds: [], items: [fresh, old], landings: none, now: NOW });
    expect(due).toEqual([
      {
        agentId: AGENT,
        card: { kind: "health", key: workKey(WORK), version: reasonVersion("Session ended mid-turn") },
      },
    ]);
    // The same cause is the same card however often the work is written; another cause is another card.
    expect(reasonVersion("a")).toBe(reasonVersion("a"));
    expect(reasonVersion("a")).not.toBe(reasonVersion("b"));
  });
});

async function setup(options: { settleMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "maestro-session-cards-"));
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
  };
  const fake = fakePaseo();
  const logs: string[] = [];
  const log = (message: string) => logs.push(message);
  /** One plugin process: an engine and its cards. A second call is the plugin after a restart. */
  const boot = () => {
    // The cards read as the daemon does: the holds needs.list projects, and the work as the store has it.
    const hold: { engine: Engine | null } = { engine: null };
    const cards = new SessionCards(
      () => fake.paseo,
      {
        work: async () => (await (hold.engine as Engine).list()).items,
        holds: async () =>
          needsOf(
            {
              items: (await (hold.engine as Engine).list()).items,
              asks: [],
              reviews: [],
              landing: null,
              workspace: "broomva",
            },
            Date.now(),
          ).rows,
      },
      log,
      { settleMs: options.settleMs ?? 60_000, appendMs: 300 },
    );
    const engine = new Engine({
      now: () => new Date(clock),
      config: async () => config,
      log,
      landed: (before, after) => cards.landed(before, after),
      // The undo window is run out by hand below (decide), on this test's clock.
      timer: () => () => undefined,
    });
    hold.engine = engine;
    return { engine, cards };
  };
  const first = boot();
  const create = (extra: Partial<{ gate: "human" | "auto"; check: string }> = {}, on: Engine = first.engine) =>
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
    on: Engine = first.engine,
    outcome: Parameters<Engine["onTurnEnded"]>[1] = { kind: "completed" },
    turnId: string | null = null,
  ) => {
    const agent = fake.agents.get("agent-1");
    if (agent) agent.status = "idle";
    await on.onTurnEnded({ id: "agent-1" }, outcome, [], turnId);
  };
  const decide = async (id: string, verdict: "revise" | "block", note = "") => {
    await first.engine.verdict(fake.paseo, id, verdict, note);
    clock += UNDO_MS;
    await first.engine.sweep(fake.paseo);
    return (await first.engine.get(id)).item;
  };
  return { ...first, boot, fake, logs, create, endTurn, decide };
}

describe("the cards in the session's own timeline", () => {
  test("a run that lands at your gate leaves one finished card in its own session once the pass has looked", async () => {
    const { create, endTurn, fake, cards } = await setup();
    const item = await create();
    // A landing with a prompt held at it is the approval's card, never a second finished one: see below.
    await endTurn();
    await cards.reconcile();
    const landing = fake.appended.filter((entry) => String(entry.item.id).includes(":finished:"));
    expect(landing.map((entry) => entry.agentId)).toEqual(["agent-1"]);
    expect(landing[0]?.item).toMatchObject({ type: "plugin", kind: CARD_KIND, version: CARD_VERSION });
    const data = CardSchema.parse(landing[0]?.item.data);
    expect(data).toEqual({ kind: "finished", key: workKey(item.id), version: expect.stringMatching(/^\d+$/) });
    expect(landing[0]?.item.id).toBe(cardId(data));
  });

  test("a landing is carded once however many passes look, and again after a restart (the id replaces it)", async () => {
    const { create, endTurn, fake, cards, boot } = await setup();
    await create();
    await endTurn();
    await cards.reconcile();
    await cards.reconcile();
    await cards.reconcile();
    expect(fake.appended).toHaveLength(1);
    // A restarted plugin has seen no landing live, so it cards no finished work again; a hold would be (below).
    const restarted = boot();
    await restarted.cards.reconcile();
    expect(fake.appended).toHaveLength(1);
  });

  test("a prompt held at the landing is carded as the approval, and no finished card is added beside it", async () => {
    const { create, endTurn, fake, cards, engine } = await setup();
    const item = await create();
    await endTurn();
    await engine.onPermissionRequested(
      { id: "agent-1" },
      { id: "p1", name: "Bash", title: "Run a command", description: "gh pr merge 933" },
    );
    await cards.reconcile();
    expect(fake.appended.map((entry) => entry.item.data)).toEqual([
      { kind: "approval", key: workKey(item.id), version: "p1" },
    ]);
    expect(fake.appended[0]?.agentId).toBe("agent-1");
    // The hold is carded again after a restart (a restart loses nothing it could not read back by key).
    const { cards: later } = await setupLike(fake, engine);
    await later.reconcile();
    expect(fake.appended.map((entry) => entry.item.id)).toEqual([
      cardId({ kind: "approval", key: workKey(item.id), version: "p1" }),
      cardId({ kind: "approval", key: workKey(item.id), version: "p1" }),
    ]);
  });

  test("each landing gets its own card: sent back and landed again is a second one", async () => {
    const { create, endTurn, fake, decide, cards } = await setup();
    const item = await create();
    await endTurn();
    await cards.reconcile();
    await decide(item.id, "revise", "Add a replay test");
    clock += 60_000;
    await endTurn();
    await cards.reconcile();
    const versions = fake.appended.map((entry) => (entry.item.data as { version: string }).version);
    expect(versions).toHaveLength(2);
    expect(Number(versions[1])).toBeGreaterThan(Number(versions[0]));
    expect(new Set(fake.appended.map((entry) => String(entry.item.id))).size).toBe(2);
  });

  test("a landing that went on before the pass looked is not carded: it is no longer the latest", async () => {
    const { create, endTurn, fake, decide, cards } = await setup();
    const item = await create();
    await endTurn();
    await decide(item.id, "revise", "Add a replay test");
    clock += 60_000;
    await endTurn();
    await cards.reconcile();
    expect(fake.appended).toHaveLength(1);
  });

  test("a landing is carded by itself a moment after it, the settle, with no pass asked for", async () => {
    const { create, endTurn, fake } = await setup({ settleMs: 20 });
    await create();
    await endTurn();
    expect(fake.appended).toHaveLength(0);
    for (let i = 0; i < 50 && fake.appended.length === 0; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.appended).toHaveLength(1);
  });

  test("work that closes itself leaves no card", async () => {
    const passing = await setup();
    const done = await passing.create({ gate: "auto", check: "true" });
    await passing.endTurn();
    for (let i = 0; i < 100 && (await passing.engine.get(done.id)).item.state !== "done"; i += 1)
      await new Promise((r) => setTimeout(r, 20));
    await passing.cards.reconcile();
    expect(passing.fake.appended).toEqual([]);
  });

  test("an append that fails is logged and tried on the next pass, three times, and the landing stands", async () => {
    const { create, endTurn, fake, engine, logs, cards } = await setup();
    fake.setAppend("throw");
    const item = await create();
    await endTurn();
    for (let pass = 0; pass < CARD_ATTEMPTS + 2; pass += 1) await cards.reconcile();
    const { item: landed, events } = await engine.get(item.id);
    expect(landed.state).toBe("review");
    expect(events.at(-1)?.text).toBe("Waiting on you");
    expect(fake.appended).toHaveLength(CARD_ATTEMPTS);
    expect(logs.some((line) => line.includes("not added to agent-1: agent is not loaded"))).toBe(true);
    // A daemon that comes back is not asked for a card it was let go of; a new raise is another card.
    fake.setAppend("ok");
    await cards.reconcile();
    expect(fake.appended).toHaveLength(CARD_ATTEMPTS);
  });

  test("an append that never answers is given up on, not waited for: the pass ends and the landing stands", async () => {
    const { create, endTurn, fake, engine, cards } = await setup();
    fake.setAppend("hang");
    const item = await create();
    const ended = await Promise.race([
      endTurn().then(() => "ended"),
      new Promise((resolve) => setTimeout(() => resolve("held"), 500)),
    ]);
    expect(ended).toBe("ended");
    const pass = await Promise.race([
      cards.reconcile().then(() => "ended"),
      new Promise((resolve) => setTimeout(() => resolve("held"), APPEND_MS)),
    ]);
    expect(pass).toBe("ended");
    expect((await engine.get(item.id)).item.state).toBe("review");
  });

  test("a source that cannot be read costs the pass, logged, and the next one reads again", async () => {
    const fake = fakePaseo();
    const logs: string[] = [];
    let failing = true;
    const asked: OpenApproval = {
      id: "e4a1c0",
      at: "2026-10-12T09:00:00.000Z",
      agentId: AGENT,
      action: "git push origin main",
      heldBy: "gate",
      title: "Push",
      scope: "broomva",
      evidence: [],
      after: [],
    };
    const cards = new SessionCards(
      () => fake.paseo,
      {
        holds: async () => {
          if (failing) throw new Error("the needs read failed");
          return needsOf(
            { items: [], asks: [], reviews: [], landing: null, workspace: "w", approvals: [asked] },
            Date.now(),
          ).rows;
        },
        work: async () => [],
      },
      (line) => logs.push(line),
      { settleMs: 0 },
    );
    await cards.reconcile();
    expect(fake.appended).toEqual([]);
    expect(logs).toEqual(["session cards: reading what to card: the needs read failed"]);
    failing = false;
    await cards.reconcile();
    expect(fake.appended.map((entry) => [entry.agentId, entry.item.id])).toEqual([
      [AGENT, cardId({ kind: "approval", key: "approval:e4a1c0", version: "approval:e4a1c0" })],
    ]);
  });

  test("nothing is added while the plugin has no client", async () => {
    const cards = new SessionCards(
      () => null,
      { holds: async () => [], work: async () => [] },
      () => undefined,
      {
        settleMs: 0,
      },
    );
    await cards.reconcile();
  });

  test("a landed callback that throws is the engine's to log: a card never holds the landing", async () => {
    const { create, endTurn, engine } = await setup();
    const item = await create();
    await endTurn();
    expect((await engine.get(item.id)).item.state).toBe("review");
  });
});

/** A second plugin process on the same daemon and engine: the cards after a restart. */
async function setupLike(fake: ReturnType<typeof fakePaseo>, engine: Engine) {
  const cards = new SessionCards(
    () => fake.paseo,
    {
      work: async () => (await engine.list()).items,
      holds: async () =>
        needsOf(
          { items: (await engine.list()).items, asks: [], reviews: [], landing: null, workspace: "broomva" },
          Date.now(),
        ).rows,
    },
    () => undefined,
    { settleMs: 0 },
  );
  return { cards };
}

describe("landingOf and lastLanding", () => {
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
    ({ contract: { id }, events }) as unknown as Parameters<SessionCards["landed"]>[1];

  test("a landing is a move into review written after the item was read", () => {
    const before = work([bound]);
    expect(landingOf(before, work([bound, ended, toReview]))).toBe(2);
    expect(landingOf(before, work([bound, ended, toBlocked]))).toBeNull();
    expect(landingOf(before, work([bound, toReview, ended]))).toBeNull();
    // The change was dropped: the last event is a landing the caller had already read.
    const seen = work([bound, ended, toReview]);
    expect(landingOf(seen, seen)).toBeNull();
  });

  test("the latest landing is the last move into review, whatever came after it", () => {
    expect(lastLanding(work([bound]).events)).toBeNull();
    expect(lastLanding(work([bound, ended, toReview, ended, toBlocked]).events)).toBe(2);
    expect(lastLanding(work([bound, ended, toReview, ended, toReview]).events)).toBe(4);
  });
});
