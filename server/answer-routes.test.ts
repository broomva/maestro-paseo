import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnswersLanding } from "../shared/answers";
import type { DecisionAsk } from "../shared/fleet";
import { AnswerRouter, afterBegan, answerKey, deliveryText, readLog } from "./answer-routes";
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
function sessions(initial: Record<string, "idle" | "running" | "closed" | "archived">) {
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
  agents?: Record<string, "idle" | "running" | "closed" | "archived">;
  before?: object[];
  after?: object[];
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
  const asks: DecisionAsk[] = decisionsOf(SOURCE, LEDGER).map((ask) => ({
    ...ask,
    home:
      home === "main" ? { kind: "main", path: "/repo", branch: null } : { kind: "checkout", path: "/w", branch: "w" },
    batched: options.batched ?? false,
  }));
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
        return { controlRepo: root, main: null, all: asks, warnings: [] };
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

describe("the delivery's words", () => {
  test("the answer is quoted line by line, verbatim, with where it is written", () => {
    const text = deliveryText({ ...receipt("A1", "checkout"), answer: "Line one.\n  indented two." } as never, null);
    expect(text).toContain("> Line one.\n>   indented two.");
    expect(text).toContain("It is written in /w/.control/asks/x.");
  });
});
