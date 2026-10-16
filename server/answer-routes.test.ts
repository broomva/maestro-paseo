import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnswersLanding } from "../shared/answers";
import type { DecisionAsk } from "../shared/fleet";
import { UNDO_MS } from "../shared/undo";
import {
  AnswerRouter,
  afterBegan,
  answerKey,
  arcAskers,
  askFor,
  candidateWork,
  conductorCandidate,
  deliveryText,
  FOR_THE_CONDUCTOR,
  ownerOnly,
  type Relay,
  readLog,
  relayText,
  routedWork,
} from "./answer-routes";
import { decisionsOf } from "./control-asks";
import type { Paseo } from "./runs";

const LEDGER = "bro-9000-routes.yaml";
const SOURCE = `arc: bro-9000
initiative: maestro
asks:
  - id: A1
    headline: "Ship it?"
    question: "Ship the landing step now?"
    stakes: "Answers strand until it ships."
    options:
      - { id: ship, label: Ship, consequence: It ships., reversible: true, recommended: true }
      - { id: hold, label: Hold, consequence: Nothing changes., reversible: true, status_quo: true }
    answer: "Ship: It ships.\\nAnd tell me when it lands."
    answer_option: ship
    answered_at: "2026-10-06T12:00:00Z"
    origin: { agent_id: agent-1, cwd: /nowhere }
  - id: A2
    headline: "Hold it?"
    options:
      - { id: ship, label: Ship, consequence: It ships., reversible: true, recommended: true }
      - { id: hold, label: Hold, consequence: Nothing changes., reversible: true, status_quo: true }
    answer: "Hold: Nothing changes."
    answer_option: hold
    answered_at: "2026-10-06T12:00:00Z"
  - id: A3
    headline: "Develop the idea?"
    class: idea
    initiative: maestro
    idea: "An idea"
    options:
      - { id: develop, label: Develop, consequence: Work., reversible: true, recommended: true }
      - { id: park, label: Park, consequence: Later., reversible: true }
      - { id: kill, label: Kill, consequence: Gone., reversible: true }
    answer: "Park: Later."
    answer_option: park
    answered_at: "2026-10-06T12:00:00Z"
`;

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const receipt = (id: string, homeKind: "main" | "checkout", extra: Record<string, unknown> = {}) => ({
  kind: "ask.answered",
  actor: "human",
  at: `2026-10-06T12:00:0${id.slice(-1)}Z`,
  home: homeKind === "main" ? "/repo/answers/.control/asks/x" : "/w/.control/asks/x",
  homeKind,
  ledger: LEDGER,
  uid: null,
  id,
  originAgentId: null,
  answerOption: null,
  answer: null,
  ...extra,
});

/** A session double: each agent's status, what was sent, and how often it was asked. */
function sessions(initial: Record<string, "idle" | "running" | "closed" | "archived" | "error">) {
  const status = new Map(Object.entries(initial));
  const sent: { agentId: string; text: string }[] = [];
  const paseo = {
    agents: {
      ref: (agentId: string) => ({
        refresh: async () => {
          const state = status.get(agentId);
          if (!state) return null;
          return {
            agent: {
              id: agentId,
              status: state === "archived" ? "idle" : state,
              archivedAt: state === "archived" ? "2026-10-06T00:00:00Z" : null,
              activeTurn: null,
              pendingPermissions: [],
            },
          };
        },
        send: async (text: string) => {
          sent.push({ agentId, text });
        },
      }),
    },
  } as unknown as Paseo;
  return { paseo, status, sent };
}

async function setup(options: {
  home?: "main" | "checkout";
  batched?: boolean;
  agents?: Record<string, "idle" | "running" | "closed" | "archived" | "error">;
  before?: object[];
  after?: object[];
  /** The asks as the workspace reads them, changed for one test. */
  asksAre?: (asks: DecisionAsk[]) => DecisionAsk[];
  /** The initiative's driver as the plugin resolves it. */
  driver?: (initiative: string) => Relay | null;
  /** Paseo has not connected yet. */
  noPaseo?: boolean;
  /** The clock, when not 13:00 on the receipts' day. */
  nowIs?: string;
}) {
  const root = await mkdtemp(join(tmpdir(), "maestro-routes-"));
  roots.push(root);
  const receipts = join(root, "asks.jsonl");
  const lines = [
    ...(options.before ?? []),
    ...(options.after ? [{ kind: "routing.began", at: "2026-10-06T11:59:00.500Z" }] : []),
  ];
  lines.push(...(options.after ?? []));
  await writeFile(receipts, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  const home = options.home ?? "checkout";
  const read: DecisionAsk[] = decisionsOf(SOURCE, LEDGER).map((ask) => ({
    ...ask,
    home:
      home === "main" ? { kind: "main", path: "/repo", branch: null } : { kind: "checkout", path: "/w", branch: "w" },
    batched: options.batched ?? false,
  }));
  const asks = options.asksAre ? options.asksAre(read) : read;
  let reads = 0;
  const created: Record<string, unknown>[] = [];
  const filed = new Map<string, { id: string; title: string; path: string }>();
  const engine = {
    answered: async () => filed,
    create: async (_paseo: unknown, input: Record<string, unknown>) => {
      created.push(input);
      const item = { id: `work-${created.length}`, title: String(input.title), path: "p" };
      filed.set(String(input.answer), item);
      return item;
    },
  };
  const { paseo, status, sent } = sessions(options.agents ?? {});
  const drivers: string[] = [];
  const clock = { at: options.nowIs ?? "2026-10-06T13:00:00Z" };
  // A router over the same receipts and doubles: a fresh one is Maestro after a restart.
  // A decision's undo window: armed here, fired by hand after the test moves the clock.
  const armed: Array<{ run: () => Promise<void>; canceled: boolean }> = [];
  const timer = (run: () => Promise<void>) => {
    const entry = { run, canceled: false };
    armed.push(entry);
    return () => {
      entry.canceled = true;
    };
  };
  const fire = async () => {
    for (const entry of armed.splice(0)) if (!entry.canceled) await entry.run();
  };
  const routerOf = () =>
    new AnswerRouter({
      timer,
      receipts,
      asks: {
        read: async () => {
          reads += 1;
          return { controlRepo: root, main: { sha: "f00", fetchedAt: null }, all: asks, warnings: [] };
        },
      },
      engine: engine as never,
      client: () => (options.noPaseo ? null : paseo),
      controlRepo: root,
      now: () => Date.parse(clock.at),
      driver: options.driver
        ? async (initiative) => {
            drivers.push(initiative);
            return options.driver?.(initiative) ?? null;
          }
        : undefined,
    });
  const router = routerOf();
  const log = async () => readLog(await readFile(receipts, "utf8"));
  return {
    root,
    receipts,
    asks,
    router,
    routerOf,
    clock,
    created,
    filed,
    status,
    sent,
    drivers,
    log,
    fire,
    armed,
    reads: () => reads,
  };
}

describe("the receipt log", () => {
  test("answers before routing began, and those of a fleet root, are never due", () => {
    const log = readLog(
      [
        JSON.stringify(receipt("A1", "checkout")),
        JSON.stringify({ ...receipt("A2", "checkout"), homeKind: "root" }),
        JSON.stringify({ kind: "routing.began", at: "2026-10-06T12:00:00.000Z" }),
        JSON.stringify(receipt("A2", "main")),
        "not json",
        JSON.stringify({ kind: "ask.routed", key: "k", route: "none" }),
      ].join("\n"),
    );
    expect([log.answered.map((entry) => entry.id), log.began, [...log.routed.keys()]]).toEqual([
      ["A1", "A2"],
      "2026-10-06T12:00:00.000Z",
      ["k"],
    ]);
  });

  test("routing began by time, to the second, never by where its line fell", () => {
    const began = "2026-10-06T12:00:05.700Z";
    expect(afterBegan({ at: "2026-10-06T12:00:04Z" }, began)).toBe(false);
    // Answered in the very second routing began (its time has no finer part): after.
    expect(afterBegan({ at: "2026-10-06T12:00:05Z" }, began)).toBe(true);
    expect(afterBegan({ at: "2026-10-06T12:00:06Z" }, began)).toBe(true);
    expect(afterBegan({ at: null }, began)).toBe(false);
    expect(afterBegan({ at: "2026-10-06T12:00:06Z" }, null)).toBe(false);
  });
});

describe("routing an answer", () => {
  test("begin marks once; an answer given before it is never routed, and says so", async () => {
    const { router, log, sent, created } = await setup({
      before: [receipt("A1", "checkout")],
      agents: { "agent-1": "idle" },
    });
    await router.begin();
    await router.begin();
    expect((await log()).began).toBe("2026-10-06T13:00:00.000Z");
    expect(await router.route()).toEqual([]);
    expect([sent, created]).toEqual([[], []]);
    const [fated] = await router.fates(
      decisionsOf(SOURCE, LEDGER).filter((ask) => ask.id === "A1"),
      null,
    );
    expect(fated?.fate?.stage).toBe("before");
  });

  test("the session that asked, idle: sent your answer verbatim, once", async () => {
    const answered = receipt("A1", "checkout", {
      originAgentId: "agent-1",
      answerOption: "ship",
      answer: "Ship: It ships.\nAnd tell me when it lands.",
    });
    const { router, sent, log, created } = await setup({ after: [answered], agents: { "agent-1": "idle" } });
    const [outcome] = await router.route();
    expect([outcome?.status, outcome?.route]).toEqual(["routed", "delivered"]);
    expect(sent.map((entry) => entry.agentId)).toEqual(["agent-1"]);
    expect(sent[0]?.text).toContain("> Ship: It ships.\n> And tell me when it lands.");
    expect(created).toEqual([]);
    const routed = (await log()).routed.get(answerKey(answered as never));
    expect([routed?.route, routed?.agentId]).toEqual(["delivered", "agent-1"]);
    // Routed once: a second pass sends nothing.
    expect(await router.route()).toEqual([]);
    expect(sent.length).toBe(1);
  });

  test("the session at work: the delivery waits, never interrupting; its turn's end delivers it", async () => {
    const answered = receipt("A1", "checkout", { originAgentId: "agent-1", answerOption: "ship", answer: "Ship." });
    const { router, sent, status, log, reads } = await setup({ after: [answered], agents: { "agent-1": "running" } });
    const [waiting] = await router.route();
    expect([waiting?.status, sent.length, (await log()).routed.size]).toEqual(["queued", 0, 0]);
    const [fated] = await router.fates(
      decisionsOf(SOURCE, LEDGER)
        .filter((ask) => ask.id === "A1")
        .map((ask) => ({ ...ask, home: { kind: "checkout" as const, path: "/w", branch: "w" } })),
      null,
    );
    expect([fated?.fate?.stage, fated?.fate?.words]).toEqual([
      "unrouted",
      "Written in /w (w). The session that asked is at work; your answer goes to it when it is idle.",
    ]);
    // Another session's turn ends: this answer is not its own, and nothing is read.
    const before = reads();
    expect(await router.route({ agentId: "agent-9" })).toEqual([]);
    expect(reads()).toBe(before);
    status.set("agent-1", "idle");
    const [delivered] = await router.route({ agentId: "agent-1" });
    expect([delivered?.route, sent.length]).toEqual(["delivered", 1]);
  });

  test("an answer whose home is main waits to land; once it has, it is routed", async () => {
    const answered = receipt("A1", "main", { originAgentId: "agent-1", answerOption: "ship", answer: "Ship." });
    const first = await setup({ home: "main", batched: true, after: [answered], agents: { "agent-1": "idle" } });
    const [waiting] = await first.router.route();
    expect([waiting?.status, first.sent.length]).toEqual(["unlanded", 0]);
    const landing: AnswersLanding = {
      stage: "waiting",
      pending: 1,
      asks: [],
      pr: { number: 915, url: "u" },
      conflict: null,
      error: null,
      landed: null,
      checkedAt: "x",
    };
    const [fated] = await first.router.fates(
      first.asks.filter((ask) => ask.id === "A1"),
      landing,
    );
    expect([fated?.fate?.stage, fated?.fate?.words, fated?.fate?.pr?.number]).toEqual([
      "unlanded",
      "Waits to land: PR #915.",
      915,
    ]);
    const landed = await setup({ home: "main", batched: false, after: [answered], agents: { "agent-1": "idle" } });
    const [routed] = await landed.router.route();
    expect([routed?.route, landed.sent[0]?.text.includes("on origin/main")]).toEqual(["delivered", true]);
  });

  test("the session gone, no one on its arc: a lane.assign candidate for the conductor, never work, once (A8)", async () => {
    const answered = receipt("A1", "checkout", { originAgentId: "agent-1", answerOption: "ship", answer: "Ship." });
    const { router, created, sent, log, root, asks } = await setup({
      after: [answered],
      agents: { "agent-1": "archived" },
    });
    const [outcome] = await router.route();
    expect([outcome?.status, outcome?.route, sent.length, created.length]).toEqual(["routed", "conductor", 0, 0]);
    expect(outcome?.words).toBe(FOR_THE_CONDUCTOR);
    const routed = (await log()).routed.get(answerKey(answered as never));
    expect([routed?.route, routed?.work, routed?.agentId]).toEqual(["conductor", null, "agent-1"]);
    expect(routed?.reason).toContain("Nothing was started.");
    // The ask, your answer verbatim, and where to look: what lane.assign needs.
    expect(routed?.candidate).toEqual({
      for: "lane.assign",
      ask: {
        ledger: LEDGER,
        uid: null,
        id: "A1",
        headline: "Ship it?",
        question: "Ship the landing step now?",
        stakes: "Answers strand until it ships.",
        options: [
          { id: "ship", label: "Ship", consequence: "It ships." },
          { id: "hold", label: "Hold", consequence: "Nothing changes." },
        ],
      },
      answer: { option: "ship", words: "Ship.", at: answered.at },
      pointers: {
        key: answerKey(answered as never),
        home: answered.home,
        homeKind: "checkout",
        askedBy: "agent-1",
        // The asker's folder is gone, so a lane works in the control repo.
        repo: root,
        initiative: "maestro",
      },
    });
    expect(await router.candidates()).toEqual([routed?.candidate as never]);
    // Routed once: a later pass does nothing, and files nothing.
    expect(await router.route()).toEqual([]);
    expect(created.length).toBe(0);
    // Decisions says it waits for the conductor, as a waiting stage, never as acted.
    const [card] = await router.fates(
      asks.filter((ask) => ask.id === "A1"),
      null,
    );
    expect([card?.fate?.stage, card?.fate?.route, card?.fate?.words]).toEqual([
      "conductor",
      "conductor",
      FOR_THE_CONDUCTOR,
    ]);
  });

  test("filed before its receipt was written (a crash between): the item stands, none is filed again", async () => {
    const answered = receipt("A1", "checkout", { answerOption: "ship", answer: "Ship." });
    const { router, created, filed } = await setup({ after: [answered] });
    filed.set(answerKey(answered as never), { id: "work-old", title: "Old", path: "p" });
    const [outcome] = await router.route();
    expect([outcome?.route, created.length]).toEqual(["work", 0]);
  });

  test("an option the ledger marks status_quo needs no work; nor does an idea's answer", async () => {
    const hold = receipt("A2", "checkout", { answerOption: "hold", answer: "Hold: Nothing changes." });
    const park = receipt("A3", "checkout", { answerOption: "park", answer: "Park: Later." });
    const { router, created, log } = await setup({ after: [hold, park] });
    const outcomes = await router.route();
    expect(outcomes.map((outcome) => [outcome.id, outcome.route])).toEqual([
      ["A2", "none"],
      ["A3", "none"],
    ]);
    expect(created).toEqual([]);
    expect((await log()).routed.get(answerKey(hold as never))?.reason).toBe(
      '"Hold" keeps things as they are (the ledger marks it status_quo), so no work was filed.',
    );
  });
});

describe("round 1 (P20)", () => {
  test("an answer given at startup, whose line lands before routing's own mark, is still routed", async () => {
    const { router, receipts, sent } = await setup({ agents: { "agent-1": "idle" } });
    // The answer is appended first (13:00:00, the router's own clock second), then begin marks.
    const answered = receipt("A1", "checkout", {
      at: "2026-10-06T13:00:00Z",
      originAgentId: "agent-1",
      answerOption: "ship",
      answer: "Ship: It ships.\nAnd tell me when it lands.",
    });
    await writeFile(receipts, `${JSON.stringify(answered)}\n`);
    await router.begin();
    const [outcome] = await router.route();
    expect([outcome?.route, sent.length]).toEqual(["delivered", 1]);
  });

  test("an ask closed another way where it lives: your answer is superseded, never acted on, never done", async () => {
    // The ledger records "ship" for A1; this answer took "hold".
    const answered = receipt("A1", "main", {
      originAgentId: "agent-1",
      answerOption: "hold",
      answer: "Hold: Nothing changes.",
    });
    const { router, sent, created, asks, log } = await setup({
      home: "main",
      after: [answered],
      agents: { "agent-1": "idle" },
    });
    const [outcome] = await router.route();
    expect([outcome?.route, sent.length, created.length]).toEqual(["superseded", 0, 0]);
    expect((await log()).routed.get(answerKey(answered as never))?.reason).toBe(
      'The ask records another outcome in origin/main: "Ship: It ships.", and that one stands; yours is kept in its receipt.',
    );
    const [fated] = await router.fates(
      asks.filter((ask) => ask.id === "A1"),
      null,
    );
    expect([fated?.fate?.stage, fated?.fate?.route]).toEqual(["superseded", "superseded"]);
  });
});

describe("round 1, Strata B (P20)", () => {
  test("an answer still in the batch says it waits to land, even one given before routing began", async () => {
    const early = receipt("A1", "main", { at: "2026-10-06T11:00:00Z", answerOption: "ship", answer: "Ship." });
    const { router, asks } = await setup({ home: "main", batched: true, before: [early], after: [] });
    const landing: AnswersLanding = {
      stage: "waiting",
      pending: 1,
      asks: [],
      pr: { number: 914, url: "u" },
      conflict: null,
      error: null,
      landed: null,
      checkedAt: "x",
    };
    const [fated] = await router.fates(
      asks.filter((ask) => ask.id === "A1"),
      landing,
    );
    expect([fated?.fate?.stage, fated?.fate?.words]).toEqual([
      "unlanded",
      "Waits to land: PR #914. Answered before Maestro acted on answers, so nothing here acts on it once it lands.",
    ]);
  });

  test("a session stopped on an error is not mid-turn: it is told", async () => {
    const answered = receipt("A1", "checkout", { originAgentId: "agent-1", answerOption: "ship", answer: "Ship." });
    const { router, sent } = await setup({ after: [answered], agents: { "agent-1": "error" } });
    const [outcome] = await router.route();
    expect([outcome?.route, sent.length]).toEqual(["delivered", 1]);
  });

  test("an ask archived with another outcome is superseded; archived still holding yours is acted on; open again waits", async () => {
    const answered = receipt("A1", "main", { answerOption: "ship", answer: "Ship." });
    const archived = await setup({
      home: "main",
      after: [answered],
      asksAre: (asks) =>
        asks.map((ask) => (ask.id === "A1" ? { ...ask, state: "archived" as const, answerOption: "hold" } : ask)),
    });
    const [gone] = await archived.router.route();
    expect([gone?.route, archived.created.length]).toEqual(["superseded", 0]);
    expect((await archived.log()).routed.get(answerKey(answered as never))?.reason).toContain("(archived)");
    // Archived after your answer landed, still holding it: your answer stands, and is acted on.
    const kept = await setup({
      home: "main",
      after: [answered],
      asksAre: (asks) => asks.map((ask) => (ask.id === "A1" ? { ...ask, state: "archived" as const } : ask)),
    });
    const [acted] = await kept.router.route();
    expect([acted?.route, kept.created.length]).toEqual(["conductor", 0]);
    const reopened = await setup({
      home: "main",
      after: [answered],
      asksAre: (asks) =>
        asks.map((ask) =>
          ask.id === "A1"
            ? {
                ...ask,
                state: "open" as const,
                answer: null,
                answerOption: null,
                home: { kind: "checkout" as const, path: "/w", branch: "w" },
              }
            : ask,
        ),
    });
    const [waits] = await reopened.router.route();
    expect([waits?.status, waits?.words, (await reopened.log()).routed.size]).toEqual([
      "unlanded",
      "It reads open in /w (w) now; Maestro acts on your answer once it is there.",
      0,
    ]);
  });

  test("an ask no ledger holds by its name is a stop for you (held work), never superseded; one unreadable waits", async () => {
    const answered = receipt("A1", "main", { answerOption: "ship", answer: "Ship." });
    const removed = await setup({
      home: "main",
      after: [answered],
      asksAre: (asks) => asks.filter((ask) => ask.id !== "A1"),
    });
    const [stopped] = await removed.router.route();
    // Not guessed removed: a stop for you, as held work the loop flags in Needs you.
    expect([stopped?.route, removed.created.length]).toEqual(["work", 1]);
    expect(String(removed.created[0]?.hold)).toContain(
      `No ledger holds the ask A1 in ${LEDGER} now (moved, renamed or removed: Maestro does not guess which).`,
    );
    const unread = await setup({ home: "main", after: [answered], asksAre: () => [] });
    const reads = unread.router as unknown as { options: { asks: { read: () => Promise<unknown> } } };
    const original = reads.options.asks.read;
    reads.options.asks.read = async () => ({
      ...((await original()) as object),
      warnings: [`The ask ledger ${LEDGER} on origin/main could not be read: bad`],
    });
    const [waits] = await unread.router.route();
    expect([waits?.status, (await unread.log()).routed.size]).toEqual(["unlanded", 0]);
  });

  test("round 3: a read that failed whole (no main read) is no evidence: answers wait, none is retired", async () => {
    const answered = receipt("A1", "main", { answerOption: "ship", answer: "Ship." });
    const failed = await setup({ home: "main", after: [answered], asksAre: () => [] });
    const reads = failed.router as unknown as { options: { asks: { read: () => Promise<unknown> } } };
    reads.options.asks.read = async () => ({ controlRepo: "/r", main: null, all: [], warnings: [] });
    const [waits] = await failed.router.route();
    expect([waits?.status, (await failed.log()).routed.size]).toEqual(["unlanded", 0]);
  });

  test("round 4: an ask main holds under a uid stamped since is not removed: the answer waits", async () => {
    const answered = receipt("A1", "main", { answerOption: "ship", answer: "Ship." });
    const { router, log } = await setup({
      home: "main",
      after: [answered],
      asksAre: (asks) => asks.map((ask) => (ask.id === "A1" ? { ...ask, uid: "u-1", state: "open" as const } : ask)),
    });
    const [waits] = await router.route();
    expect([waits?.status, (await log()).routed.size]).toEqual(["unlanded", 0]);
  });

  test("round 4: a card's fate reads the receipt at its own home, not a later one for its handle elsewhere", async () => {
    const atHome = receipt("A1", "checkout", { at: "2026-10-06T12:00:01Z", answerOption: "ship", answer: "Ship." });
    const elsewhere = {
      ...receipt("A1", "checkout", { at: "2026-10-06T12:00:09Z", answerOption: "ship", answer: "Ship." }),
      home: "/x/.control/asks/x",
    };
    const { router, asks } = await setup({ after: [atHome, elsewhere] });
    await writeFile(
      router["options" as never]["receipts" as never],
      `${await readFile(router["options" as never]["receipts" as never], "utf8")}${JSON.stringify({ kind: "ask.routed", actor: "maestro", at: "x", key: answerKey(atHome as never), ledger: LEDGER, uid: null, id: "A1", route: "delivered", agentId: "a", work: null, reason: "r" })}\n`,
    );
    const [fated] = await router.fates(
      asks.filter((ask) => ask.id === "A1"),
      null,
    );
    expect(fated?.fate?.route).toBe("delivered");
  });

  test("a held stop filed before its receipt was written (a crash between) is not filed again", async () => {
    const answered = receipt("A1", "main", { answerOption: "ship", answer: "Ship." });
    const { router, created, filed } = await setup({ home: "main", after: [answered], asksAre: () => [] });
    filed.set(answerKey(answered as never), { id: "work-held", title: "Held", path: "p" });
    const [outcome] = await router.route();
    expect([outcome?.route, created.length]).toEqual(["work", 0]);
  });

  test("the ask a receipt answered is the one at its own home, not another of its handle", () => {
    const [mine] = decisionsOf(SOURCE, LEDGER);
    const main = {
      ...(mine as DecisionAsk),
      headline: "main's",
      home: { kind: "main" as const, path: "/repo", branch: null },
    };
    const checkout = {
      ...(mine as DecisionAsk),
      headline: "the checkout's",
      home: { kind: "checkout" as const, path: "/w", branch: "w" },
    };
    const other = {
      ...(mine as DecisionAsk),
      headline: "another checkout's",
      home: { kind: "checkout" as const, path: "/x", branch: "x" },
    };
    const all = [main, other, checkout];
    expect(askFor(all, receipt("A1", "checkout") as never)?.headline).toBe("the checkout's");
    expect(askFor(all, receipt("A1", "main") as never)?.headline).toBe("main's");
    // A checkout gone since: main's copy stands in.
    expect(askFor(all, { ...receipt("A1", "checkout"), home: "/gone/.control/asks/x" } as never)?.headline).toBe(
      "main's",
    );
  });

  test("an ask answered twice: only the latest answer is acted on; the earlier is superseded", async () => {
    const first = receipt("A1", "checkout", { at: "2026-10-06T12:00:01Z", answerOption: "ship", answer: "Ship." });
    const second = receipt("A1", "checkout", {
      at: "2026-10-06T12:00:09Z",
      answerOption: "ship",
      answer: "Ship: It ships.\nAnd tell me when it lands.",
    });
    const { router, created } = await setup({ after: [first, second] });
    const outcomes = await router.route();
    expect(outcomes.map((outcome) => outcome.route)).toEqual(["superseded", "conductor"]);
    expect(created.length).toBe(0);
  });

  test("two passes at once (a wake, a turn's end, an answer) route an answer once", async () => {
    const answered = receipt("A1", "checkout", { originAgentId: "agent-1", answerOption: "ship", answer: "Ship." });
    const { router, sent, log } = await setup({ after: [answered], agents: { "agent-1": "idle" } });
    await Promise.all([router.route(), router.route({ agentId: "agent-1" }), router.route()]);
    expect([sent.length, (await log()).routed.size]).toEqual([1, 1]);
  });
});

describe("the delivery's words", () => {
  test("the answer is quoted line by line, verbatim, with where it is written", () => {
    const text = deliveryText({ ...receipt("A1", "checkout"), answer: "Line one.\n  indented two." } as never, null);
    expect(text).toContain("> Line one.\n>   indented two.");
    expect(text).toContain("It is written in /w/.control/asks/x.");
  });
});

describe("your note and an Other answer reach the asking side, labelled (BRO-3146)", () => {
  const [a1] = decisionsOf(SOURCE, LEDGER);
  const noted = receipt("A1", "checkout", {
    answerOption: "ship",
    answer: "Ship: It ships.\nOnly after the demo.",
    answerNote: "Only after the demo.",
  });
  const other = receipt("A1", "checkout", { answer: "Ask Legal first.", answerOther: "Ask Legal first." });

  test("the receipt log carries the note and the Other answer; one written before them reads null", () => {
    const log = readLog(
      [JSON.stringify(noted), JSON.stringify(other), JSON.stringify(receipt("A2", "main"))].join("\n"),
    );
    expect(log.answered.map((entry) => [entry.answerNote, entry.answerOther])).toEqual([
      ["Only after the demo.", null],
      [null, "Ask Legal first."],
      [null, null],
    ]);
  });

  test("the session that asked gets the option and the note on their own lines, after the verbatim answer", () => {
    const text = deliveryText(readLog(JSON.stringify(noted)).answered[0] as never, a1 ?? null);
    expect(text).toContain("> Ship: It ships.\n> Only after the demo.");
    expect(text).toContain('- Option taken: ship ("Ship")');
    expect(text).toContain("- Note (read before acting; it may narrow the choice): Only after the demo.");
  });

  test("an Other answer says no option was taken, and gives the words as the decision", () => {
    const text = deliveryText(readLog(JSON.stringify(other)).answered[0] as never, a1 ?? null);
    expect(text).toContain("- Option taken: none of them. This is an Other answer");
    expect(text).toContain("- Other: Ask Legal first.");
    expect(text).not.toContain("- Note");
  });

  test("a relay, routed work, and a conductor candidate carry them too", () => {
    const entry = readLog(JSON.stringify(noted)).answered[0] as never;
    if (!a1) throw new Error("no A1");
    expect(relayText(entry, a1, "Its asker is gone.", "a peer")).toContain("- Note (read before acting");
    expect(routedWork(entry, a1, "Its asker is gone.").brief).toContain('- Option taken: ship ("Ship")');
    const candidate = conductorCandidate(readLog(JSON.stringify(other)).answered[0] as never, a1, null, "/repo");
    expect([candidate.answer.other, candidate.answer.note]).toEqual(["Ask Legal first.", undefined]);
    expect(candidateWork(candidate).brief).toContain("- Other: Ask Legal first.");
  });

  test("an answer from before BRO-3146 reads exactly as it did: no parts block", () => {
    const old = receipt("A1", "checkout", { answerOption: null, answer: "Hold it." });
    expect(deliveryText(old as never, a1 ?? null)).not.toContain("In parts:");
  });
});

describe("an answer its asker cannot take (BRO-2918, BRO-2910)", () => {
  // A2 names no asker; A1, in the same ledger, was asked by agent-1. A2's hold is made a real change here.
  const unmarked = (asks: DecisionAsk[]) =>
    asks.map((ask) =>
      ask.id === "A2" ? { ...ask, options: ask.options.map((option) => ({ ...option, statusQuo: false })) } : ask,
    );
  const ownerOnlyA = (id: string) => (asks: DecisionAsk[]) =>
    unmarked(asks).map((ask) =>
      ask.id === id ? { ...ask, audit: { class: "authority", gates: [], withheld: 0 } } : ask,
    ) as DecisionAsk[];
  const hold = () => receipt("A2", "checkout", { answerOption: "hold", answer: "Hold: Nothing changes." });

  test("named nowhere: it goes to the arc's other asker, idle, with why; nothing is filed", async () => {
    const answered = hold();
    const { router, created, sent, log } = await setup({
      after: [answered],
      agents: { "agent-1": "idle" },
      asksAre: unmarked,
    });
    const [outcome] = await router.route();
    expect([outcome?.route, created.length, sent.map((s) => s.agentId)]).toEqual(["relayed", 0, ["agent-1"]]);
    expect(sent[0]?.text).toContain(`It comes to you as the session that asked A1 in ${LEDGER}.`);
    expect(sent[0]?.text).toContain("> Hold: Nothing changes.");
    const routed = (await log()).routed.get(answerKey(answered as never));
    expect([routed?.route, routed?.agentId]).toEqual(["relayed", "agent-1"]);
  });

  test("the arc's asker at work: the answer waits for it, never filed past it", async () => {
    const { router, created, sent } = await setup({
      after: [hold()],
      agents: { "agent-1": "running" },
      asksAre: unmarked,
    });
    const [outcome] = await router.route();
    expect([outcome?.status, outcome?.route, created.length, sent.length]).toEqual(["queued", null, 0, 0]);
  });

  test("the arc's asker gone too: the initiative's driver takes it; with no driver, the conductor", async () => {
    const driven = await setup({
      after: [hold()],
      agents: { "agent-1": "archived", "agent-d": "idle" },
      asksAre: unmarked,
      driver: (initiative) => (initiative === "maestro" ? { agentId: "agent-d", as: "the driver" } : null),
    });
    const [relayed] = await driven.router.route();
    expect([relayed?.route, driven.sent.map((s) => s.agentId), driven.created.length]).toEqual([
      "relayed",
      ["agent-d"],
      0,
    ]);
    const undriven = await setup({ after: [hold()], agents: { "agent-1": "archived" }, asksAre: unmarked });
    const [queued] = await undriven.router.route();
    expect([queued?.route, undriven.created.length]).toEqual(["conductor", 0]);
  });

  test("owner-only with its asker gone: held work for you, never relayed, never started", async () => {
    const { router, created, sent } = await setup({
      after: [hold()],
      agents: { "agent-1": "idle" },
      asksAre: ownerOnlyA("A2"),
    });
    const [outcome] = await router.route();
    expect([outcome?.route, sent.length, created.length]).toEqual(["work", 0, 1]);
    const input = created[0] as Record<string, unknown>;
    expect([input.dispatch, input.gate, input.initiative, Boolean(input.hold)]).toEqual([
      false,
      "human",
      "maestro",
      true,
    ]);
  });

  test("owner-only to its live asker: delivered, saying the act stays the owner's", async () => {
    const answered = receipt("A1", "checkout", { originAgentId: "agent-1", answerOption: "ship", answer: "Ship." });
    const { router, sent } = await setup({
      after: [answered],
      agents: { "agent-1": "idle" },
      asksAre: ownerOnlyA("A1"),
    });
    const [outcome] = await router.route();
    expect(outcome?.route).toBe("delivered");
    expect(sent[0]?.text).toContain("the owner-only act itself stays the owner's");
  });
});

describe("who else may take an answer", () => {
  const ask = (id: string, agentId: string | null, askedAt: string | null, path = "/w") =>
    ({
      ledger: LEDGER,
      id,
      askedAt,
      origin: agentId ? { agentId, cwd: null } : null,
      home: { kind: "checkout", path, branch: "w" },
    }) as unknown as DecisionAsk;

  test("the ledger's other askers, newest first, once each, never itself, never another home's", () => {
    const own = ask("A1", "agent-1", "2026-10-06T10:00:00Z");
    const all = [
      own,
      ask("A2", "agent-2", "2026-10-06T09:00:00Z"),
      ask("A3", "agent-3", "2026-10-06T11:00:00Z"),
      ask("A4", "agent-2", "2026-10-06T08:00:00Z"),
      ask("A5", "agent-1", "2026-10-06T12:00:00Z"),
      ask("A6", "agent-6", "2026-10-06T13:00:00Z", "/elsewhere"),
      { ...ask("A7", "agent-7", "2026-10-06T14:00:00Z"), ledger: "other.yaml" } as DecisionAsk,
    ];
    expect(arcAskers(all, own).map((relay) => relay.agentId)).toEqual(["agent-3", "agent-2"]);
  });

  test("owner-only: authority or credential class, or a why_you that says so; nothing else", () => {
    const of = (audit: string | null, whyYou: string | null) =>
      ({ audit: audit ? { class: audit, gates: [], withheld: 0 } : null, whyYou }) as unknown as DecisionAsk;
    expect([
      ownerOnly(of("authority", null)),
      ownerOnly(of("credential", null)),
      ownerOnly(of(null, "Admin merges are owner-only.")),
      ownerOnly(of("decision", "You set the direction.")),
      ownerOnly(null),
    ]).toEqual([true, true, true, false, false]);
  });
});

describe("an answer its asker cannot take, round 1 (P20)", () => {
  const unmarked = (asks: DecisionAsk[]) =>
    asks.map((ask) =>
      ask.id === "A2" ? { ...ask, options: ask.options.map((option) => ({ ...option, statusQuo: false })) } : ask,
    );
  const hold = (extra: Record<string, unknown> = {}) =>
    receipt("A2", "checkout", { answerOption: "hold", answer: "Hold: Nothing changes.", ...extra });
  const driverD = (initiative: string) => (initiative === "maestro" ? { agentId: "agent-d", as: "the driver" } : null);

  test("an idle asker on the arc is chosen before the driver, which is never looked up", async () => {
    const { router, sent, drivers } = await setup({
      after: [hold()],
      agents: { "agent-1": "idle", "agent-d": "idle" },
      asksAre: unmarked,
      driver: driverD,
    });
    await router.route();
    expect([sent.map((s) => s.agentId), drivers]).toEqual([["agent-1"], []]);
  });

  test("the driver is asked for the ask's own initiative", async () => {
    const { router, drivers } = await setup({
      after: [hold()],
      agents: { "agent-1": "archived" },
      asksAre: unmarked,
      driver: driverD,
    });
    await router.route();
    expect(drivers).toEqual(["maestro"]);
  });

  test("Paseo not connected: waits when the arc has someone to ask; the conductor's when it has no one", async () => {
    const waits = await setup({ after: [hold()], asksAre: unmarked, noPaseo: true });
    const [waited] = await waits.router.route();
    expect([waited?.status, waits.created.length]).toEqual(["queued", 0]);
    const alone = (asks: DecisionAsk[]) =>
      unmarked(asks).map((ask) => ({ ...ask, origin: null, initiative: null })) as DecisionAsk[];
    const queues = await setup({ after: [hold()], asksAre: alone, noPaseo: true });
    const [queued] = await queues.router.route();
    expect([queued?.route, queues.created.length]).toEqual(["conductor", 0]);
  });

  test("an asker at work is waited on for RELAY_WAIT_MS from when it first was, then passed over", async () => {
    const { router, clock, sent, log } = await setup({
      after: [hold()],
      agents: { "agent-1": "running", "agent-d": "idle" },
      asksAre: unmarked,
      driver: driverD,
      // Routed 4 h after it was answered (a slow landing): the clock starts at the first wait, not the answer.
      nowIs: "2026-10-06T16:00:00Z",
    });
    const [first] = await router.route();
    expect([first?.status, sent.length]).toEqual(["queued", 0]);
    clock.at = "2026-10-06T17:59:59Z";
    const [still] = await router.route();
    expect([still?.status, sent.length]).toEqual(["queued", 0]);
    clock.at = "2026-10-06T18:00:00Z";
    const [moved] = await router.route();
    expect([moved?.route, sent.map((s) => s.agentId)]).toEqual(["relayed", ["agent-d"]]);
    expect([...((await log()).waiting.get(answerKey(hold() as never))?.since.keys() ?? [])]).toEqual(["agent-1"]);
  });

  test("a relay waiting on a session at work is delivered when that session's turn ends", async () => {
    const answered = hold();
    const { router, status, sent } = await setup({
      after: [answered],
      agents: { "agent-1": "running" },
      asksAre: unmarked,
    });
    await router.route();
    status.set("agent-1", "idle");
    const [outcome] = await router.route({ agentId: "agent-1" });
    expect([outcome?.route, sent.map((s) => s.agentId)]).toEqual(["relayed", ["agent-1"]]);
  });

  test("owner-only with a status_quo answer needs nothing, held or otherwise", async () => {
    const authority = (asks: DecisionAsk[]) =>
      asks.map((ask) =>
        ask.id === "A2" ? { ...ask, audit: { class: "authority", gates: [], withheld: 0 } } : ask,
      ) as DecisionAsk[];
    const { router, created } = await setup({ after: [hold()], asksAre: authority });
    const [outcome] = await router.route();
    expect([outcome?.route, created.length]).toEqual(["none", 0]);
  });

  test("held owner-only work runs in the control repo, and its brief says not to perform the act", async () => {
    const authority = (asks: DecisionAsk[]) =>
      unmarked(asks).map((ask) =>
        ask.id === "A2" ? { ...ask, audit: { class: "authority", gates: [], withheld: 0 } } : ask,
      ) as DecisionAsk[];
    const { router, created, root } = await setup({ after: [hold()], asksAre: authority });
    await router.route();
    const input = created[0] as Record<string, unknown>;
    expect([input.repo, String(input.brief).includes("do not perform the act")]).toEqual([root, true]);
  });

  test("a checkout ask no read holds: held for you, never startable work", async () => {
    const answered = receipt("A9", "checkout", { answerOption: "ship", answer: "Ship." });
    const { router, created } = await setup({ after: [answered] });
    const [outcome] = await router.route();
    expect([outcome?.route, created.length, Boolean((created[0] as Record<string, unknown>)?.hold)]).toEqual([
      "work",
      1,
      true,
    ]);
  });

  test("a fleet scope's ask has no arc askers, and is no arc asker", () => {
    const ask = (id: string, agentId: string, scope: string | null) =>
      ({
        ledger: LEDGER,
        id,
        askedAt: null,
        scope,
        origin: { agentId, cwd: null },
        home: { kind: "checkout", path: "/w", branch: "w" },
      }) as unknown as DecisionAsk;
    const all = [ask("A1", "agent-1", null), ask("A2", "agent-2", "sri"), ask("A3", "agent-3", null)];
    expect([
      arcAskers(all, all[0] as DecisionAsk).map((r) => r.agentId),
      arcAskers(all, all[1] as DecisionAsk),
    ]).toEqual([["agent-3"], []]);
  });
});

test("an asker of the same ledger at the same path but another kind of home is another copy, not the arc", () => {
  const at = (id: string, agentId: string, kind: "main" | "checkout") =>
    ({
      ledger: LEDGER,
      id,
      askedAt: null,
      scope: null,
      origin: { agentId, cwd: null },
      home: { kind, path: "/repo", branch: null },
    }) as unknown as DecisionAsk;
  const own = at("A1", "agent-1", "checkout");
  expect(
    arcAskers([own, at("A2", "agent-2", "main"), at("A3", "agent-3", "checkout")], own).map((r) => r.agentId),
  ).toEqual(["agent-3"]);
});

describe("an answer its asker cannot take, round 2 (P20)", () => {
  const unmarked = (asks: DecisionAsk[]) =>
    asks.map((ask) =>
      ask.id === "A2" ? { ...ask, options: ask.options.map((option) => ({ ...option, statusQuo: false })) } : ask,
    );
  const hold = () => receipt("A2", "checkout", { answerOption: "hold", answer: "Hold: Nothing changes." });

  test("after a restart, the waited-on session's turn end still delivers the relay", async () => {
    const { router, routerOf, status, sent } = await setup({
      after: [hold()],
      agents: { "agent-1": "running" },
      asksAre: unmarked,
    });
    await router.route();
    status.set("agent-1", "idle");
    const [outcome] = await routerOf().route({ agentId: "agent-1" });
    expect([outcome?.route, sent.map((s) => s.agentId)]).toEqual(["relayed", ["agent-1"]]);
  });

  test("owner-only: authority, credential and external, in any case", () => {
    const of = (kind: string) =>
      ({ audit: { class: kind, gates: [], withheld: 0 }, whyYou: null }) as unknown as DecisionAsk;
    expect(["Authority", "CREDENTIAL", "external", "decision", "artifact"].map((kind) => ownerOnly(of(kind)))).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  test("an unreadable checkout ask, its asker idle: delivered, saying its class is unknown", async () => {
    const answered = receipt("A9", "checkout", { originAgentId: "agent-1", answerOption: "ship", answer: "Ship." });
    const { router, sent } = await setup({ after: [answered], agents: { "agent-1": "idle" } });
    const [outcome] = await router.route();
    expect([outcome?.route, sent[0]?.text.includes("whether it is owner-only is unknown")]).toEqual([
      "delivered",
      true,
    ]);
  });

  test("held owner-only work runs in the control repo even when the asker's folder is a live repo", async () => {
    const authority = (asks: DecisionAsk[]) =>
      unmarked(asks).map((ask) =>
        ask.id === "A2"
          ? {
              ...ask,
              audit: { class: "authority", gates: [], withheld: 0 },
              origin: { agentId: "agent-2", cwd: process.cwd() },
            }
          : ask,
      ) as DecisionAsk[];
    const { router, created, root } = await setup({ after: [hold()], asksAre: authority });
    await router.route();
    expect((created[0] as Record<string, unknown>).repo).toBe(root);
  });
});

test("a relay's patience runs from its first ask.waiting line, even if two passes wrote one", () => {
  const line = (on: string, at: string) => JSON.stringify({ kind: "ask.waiting", key: "k", on, at });
  const log = readLog(
    [
      line("agent-1", "2026-10-06T12:00:00Z"),
      line("agent-1", "2026-10-06T13:00:00Z"),
      line("agent-d", "2026-10-06T14:00:00Z"),
    ].join("\n"),
  );
  const waiting = log.waiting.get("k");
  expect([waiting?.since.get("agent-1"), waiting?.on]).toEqual(["2026-10-06T12:00:00Z", "agent-d"]);
});

describe("an answer its asker cannot take, round 3 (P20)", () => {
  const unmarked = (asks: DecisionAsk[]) =>
    asks.map((ask) =>
      ask.id === "A2" ? { ...ask, options: ask.options.map((option) => ({ ...option, statusQuo: false })) } : ask,
    );
  const hold = () => receipt("A2", "checkout", { answerOption: "hold", answer: "Hold: Nothing changes." });

  test("many passes on a session at work write one ask.waiting line for it", async () => {
    const { router, receipts } = await setup({ after: [hold()], agents: { "agent-1": "running" }, asksAre: unmarked });
    for (let pass = 0; pass < 5; pass += 1) await router.route();
    const lines = (await readFile(receipts, "utf8")).split("\n").filter((line) => line.includes('"ask.waiting"'));
    expect(lines.length).toBe(1);
  });

  test("an ask.waiting line whose time does not parse is skipped", () => {
    const log = readLog(JSON.stringify({ kind: "ask.waiting", key: "k", on: "agent-1", at: "garbage" }));
    expect(log.waiting.has("k")).toBe(false);
  });

  test("once the wait moved on, the first session's turn end still delivers it", async () => {
    const { router, clock, status, sent } = await setup({
      after: [hold()],
      agents: { "agent-1": "running", "agent-d": "running" },
      asksAre: unmarked,
      driver: (initiative) => (initiative === "maestro" ? { agentId: "agent-d", as: "the driver" } : null),
    });
    await router.route();
    clock.at = "2026-10-06T15:00:01Z";
    await router.route();
    status.set("agent-1", "idle");
    const [outcome] = await router.route({ agentId: "agent-1" });
    expect([outcome?.route, sent.map((s) => s.agentId)]).toEqual(["relayed", ["agent-1"]]);
  });
});

describe("your decision on an answer for the conductor (BRO-2990)", () => {
  const gone = () => receipt("A1", "checkout", { originAgentId: "agent-1", answerOption: "ship", answer: "Ship." });
  const conductorAnswer = async () => {
    const answered = gone();
    const routing = await setup({ after: [answered], agents: { "agent-1": "archived" } });
    const [outcome] = await routing.router.route();
    expect(outcome?.route).toBe("conductor");
    return { ...routing, answered, key: answerKey(answered as never) };
  };
  const later = (clock: { at: string }, ms: number) => {
    clock.at = new Date(Date.parse(clock.at) + ms).toISOString();
  };

  test("file as work: written now, applied UNDO_MS later as queued work, never dispatched; it leaves the conductor", async () => {
    const { router, key, clock, created, fire, log, asks, root } = await conductorAnswer();
    const pending = await router.decide(key, "file");
    expect(pending).toMatchObject({ verb: "file", appliesAt: new Date(Date.parse(clock.at) + UNDO_MS).toISOString() });
    // In its undo window: nothing is filed yet, the conductor no longer gets it, and the card says it waits.
    expect(created).toEqual([]);
    expect(await router.candidates()).toEqual([]);
    const [waiting] = await router.fates(
      asks.filter((ask) => ask.id === "A1"),
      null,
    );
    expect([waiting?.fate?.stage, waiting?.fate?.pending?.verb, waiting?.fate?.key]).toEqual([
      "conductor",
      "file",
      key,
    ]);
    later(clock, UNDO_MS);
    await fire();
    expect(created).toHaveLength(1);
    const input = created[0] as Record<string, unknown>;
    expect([input.gate, input.dispatch, input.answer, input.initiative, input.check, input.repo]).toEqual([
      "human",
      false,
      key,
      "maestro",
      "",
      root,
    ]);
    expect(String(input.title)).toBe("Act on your answer: Ship it?");
    expect(String(input.brief)).toContain("> Ship.");
    expect(String(input.brief)).toContain("- Ship: It ships. (your answer)");
    expect(String(input.brief)).toContain("The session that asked: agent-1 (gone)");
    const decision = (await log()).decisions.get(pending.receipt);
    expect(decision?.closed?.work).toEqual({ id: "work-1", title: "Act on your answer: Ship it?" });
    const [filed] = await router.fates(
      asks.filter((ask) => ask.id === "A1"),
      null,
    );
    expect([filed?.fate?.stage, filed?.fate?.words]).toEqual([
      "acted",
      'Acted on: you filed it as work, "Act on your answer: Ship it?".',
    ]);
    expect(await router.candidates()).toEqual([]);
    await expect(router.decide(key, "dismiss")).rejects.toThrow("already filed as work or dismissed");
  });

  test("dismiss: a receipt that closes it once its window closes; nothing is filed", async () => {
    const { router, key, clock, created, fire, asks } = await conductorAnswer();
    await router.decide(key, "dismiss");
    later(clock, UNDO_MS);
    await fire();
    expect(created).toEqual([]);
    expect(await router.candidates()).toEqual([]);
    const [card] = await router.fates(
      asks.filter((ask) => ask.id === "A1"),
      null,
    );
    expect([card?.fate?.stage, card?.fate?.words]).toEqual([
      "acted",
      "Dismissed by you: nothing follows from it, and the conductor will not get it.",
    ]);
  });

  test("undo in the window takes it back: nothing happens, and it waits for the conductor again; after, too late", async () => {
    const { router, key, clock, created, fire, asks } = await conductorAnswer();
    const first = await router.decide(key, "file");
    await expect(router.decide(key, "dismiss")).rejects.toThrow("already waits to take effect");
    expect(await router.undo(first.receipt)).toEqual({ undone: true });
    later(clock, UNDO_MS);
    await fire();
    expect(created).toEqual([]);
    expect((await router.candidates()).map((candidate) => candidate.ask.id)).toEqual(["A1"]);
    const [card] = await router.fates(
      asks.filter((ask) => ask.id === "A1"),
      null,
    );
    expect([card?.fate?.stage, card?.fate?.pending]).toEqual(["conductor", null]);
    // A new decision, left to run out: its undo comes too late.
    const second = await router.decide(key, "dismiss");
    later(clock, UNDO_MS);
    await expect(router.undo(second.receipt)).rejects.toThrow("Its undo window has closed");
    await expect(router.decide("nope", "file")).rejects.toThrow("does not wait for the conductor");
  });

  test("a stopped router never applies a pending decision; the router that resumes after it applies it once", async () => {
    const { router, routerOf, key, clock, created, armed } = await conductorAnswer();
    await router.decide(key, "file");
    // A reload inside the undo window: the old router is stopped, and its timer is cleared.
    router.stop();
    expect(armed.every((entry) => entry.canceled)).toBe(true);
    later(clock, UNDO_MS + 1);
    // Even a timer that fires anyway applies nothing on a stopped router.
    for (const entry of armed) await entry.run();
    expect(created).toEqual([]);
    // The new router resumes and applies it, once; the old one, fired again, still applies nothing.
    await routerOf().resume();
    for (const entry of armed) await entry.run();
    await routerOf().resume();
    expect(created).toHaveLength(1);
  });

  test("a restart keeps your decision: a fresh router applies the due one when it resumes", async () => {
    const { router, routerOf, key, clock, created } = await conductorAnswer();
    await router.decide(key, "file");
    later(clock, UNDO_MS + 1);
    // Maestro restarted before the timer fired: the decision is in the receipts, and resume applies it.
    await routerOf().resume();
    expect(created).toHaveLength(1);
    expect(await routerOf().candidates()).toEqual([]);
  });
});
