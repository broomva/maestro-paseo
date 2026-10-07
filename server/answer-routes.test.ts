import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnswersLanding } from "../shared/answers";
import type { DecisionAsk } from "../shared/fleet";
import { AnswerRouter, afterBegan, answerKey, askFor, deliveryText, readLog } from "./answer-routes";
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
  const router = new AnswerRouter({
    receipts,
    asks: {
      read: async () => {
        reads += 1;
        return { controlRepo: root, main: { sha: "f00", fetchedAt: null }, all: asks, warnings: [] };
      },
    },
    engine: engine as never,
    client: () => paseo,
    controlRepo: root,
    now: () => Date.parse("2026-10-06T13:00:00Z"),
  });
  const log = async () => readLog(await readFile(receipts, "utf8"));
  return { root, receipts, asks, router, created, filed, status, sent, log, reads: () => reads };
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

  test("the session gone: queued work at your gate, in the ask's initiative, filed once", async () => {
    const answered = receipt("A1", "checkout", { originAgentId: "agent-1", answerOption: "ship", answer: "Ship." });
    const { router, created, sent, log } = await setup({ after: [answered], agents: { "agent-1": "archived" } });
    const [outcome] = await router.route();
    expect([outcome?.route, sent.length]).toEqual(["work", 0]);
    expect(created.length).toBe(1);
    const input = created[0] as Record<string, unknown>;
    expect([input.gate, input.dispatch, input.initiative, input.answer, input.check]).toEqual([
      "human",
      false,
      "maestro",
      answerKey(answered as never),
      "",
    ]);
    expect(String(input.title)).toBe("Act on your answer: Ship it?");
    expect(String(input.brief)).toContain("> Ship.");
    expect(String(input.brief)).toContain("- Ship: It ships. (your answer)");
    expect((await log()).routed.get(answerKey(answered as never))?.work).toEqual({
      id: "work-1",
      title: "Act on your answer: Ship it?",
    });
    expect(await router.route()).toEqual([]);
    expect(created.length).toBe(1);
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

  test("an ask archived where it lives is superseded; one open there again waits, never superseded", async () => {
    const answered = receipt("A1", "main", { answerOption: "ship", answer: "Ship." });
    const archived = await setup({
      home: "main",
      after: [answered],
      asksAre: (asks) => asks.map((ask) => (ask.id === "A1" ? { ...ask, state: "archived" as const } : ask)),
    });
    const [gone] = await archived.router.route();
    expect([gone?.route, archived.created.length]).toEqual(["superseded", 0]);
    expect((await archived.log()).routed.get(answerKey(answered as never))?.reason).toContain("(archived)");
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

  test("an ask removed from main after it landed is superseded; one in a ledger that could not be read waits", async () => {
    const answered = receipt("A1", "main", { answerOption: "ship", answer: "Ship." });
    const removed = await setup({
      home: "main",
      after: [answered],
      asksAre: (asks) => asks.filter((ask) => ask.id !== "A1"),
    });
    const [gone] = await removed.router.route();
    expect([gone?.route, removed.created.length]).toEqual(["superseded", 0]);
    expect((await removed.log()).routed.get(answerKey(answered as never))?.reason).toBe(
      `No ledger holds the ask now: it was removed from ${LEDGER}, and that stands; yours is kept in its receipt.`,
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
    expect(outcomes.map((outcome) => outcome.route)).toEqual(["superseded", "work"]);
    expect(created.length).toBe(1);
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
