// Owner answer A8 (BRO-2990): the plugin never starts work by a rule of its
// own. This replays Paseo session 13b97ad9 (2026-10-09 14:29Z), where six
// answers whose askers were gone became six sessions nobody watched: answer
// routing filed each as queued work (server/answer-routes.ts), and the loop's
// next wake started all six (server/loop.ts) under defaultGate auto, with a
// cap that counted only running work. The same wake now starts nothing, and
// each answer waits for the conductor as a lane.assign candidate.

import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MaestroConfig } from "../shared/contracts";
import type { DecisionAsk } from "../shared/fleet";
import { AnswerRouter } from "./answer-routes";
import { defaultConfig } from "./config";
import { decisionsOf } from "./control-asks";
import { Engine } from "./engine";
import { fakePaseo } from "./fake-paseo";
import { Loop } from "./loop";
import { WakeLog } from "./wake-log";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const LEDGER = "bro-9001-burst.yaml";
const IDS = ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"] as const;

/** Six asks, each answered with an option that changes something (no status_quo), none owner-only, no driver. */
const SOURCE = `arc: bro-9001
asks:
${IDS.map(
  (id, at) => `  - id: ${id}
    headline: "Change ${id}?"
    question: "Should ${id} change?"
    class: decision
    options:
      - { id: change, label: Change, consequence: It changes., reversible: true, recommended: true }
      - { id: keep, label: Keep, consequence: Nothing changes., reversible: true, status_quo: true }
    answer: "Change: It changes."
    answer_option: change
    answered_at: "2026-10-09T14:29:0${at}Z"
    asked_at: "2026-10-09T13:0${at}:00Z"
    origin: { agent_id: asker-${at + 1}, cwd: /nowhere }`,
).join("\n")}
`;

async function burst() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "maestro-a8-")));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  // The owner's live Settings on 10-09: new work gates auto, the loop wakes every 30 minutes, cap 3, no mode.
  const config: MaestroConfig = {
    ...defaultConfig(),
    workRoot: join(root, "work"),
    provider: "claude",
    modeId: null,
    isolation: "worktree",
    concurrencyCap: 3,
    defaultGate: "auto",
    loopMinutes: 30,
  };
  const clock = Date.parse("2026-10-09T14:29:47.000Z");
  const engine = new Engine({ now: () => new Date(clock), config: async () => config, log: () => {} });
  const fake = fakePaseo({ now: () => new Date(clock) });
  // Every asker is gone: their sessions were archived before the answers came.
  for (const [at] of IDS.entries()) {
    fake.addSession(`asker-${at + 1}`, { modeId: "default" });
    const asker = fake.agents.get(`asker-${at + 1}`);
    if (asker) asker.archivedAt = "2026-10-09T14:00:00.000Z";
  }
  const asks: DecisionAsk[] = decisionsOf(SOURCE, LEDGER).map((ask) => ({
    ...ask,
    home: { kind: "checkout", path: "/w", branch: "w" },
    batched: false,
  }));
  const receipts = join(root, "asks.jsonl");
  const lines = [
    { kind: "routing.began", actor: "maestro", at: "2026-10-09T08:00:00.000Z" },
    ...asks.map((ask) => ({
      kind: "ask.answered",
      actor: "human",
      at: ask.answeredAt,
      home: "/w/.control/asks/x",
      homeKind: "checkout",
      ledger: LEDGER,
      uid: null,
      id: ask.id,
      originAgentId: ask.origin?.agentId ?? null,
      answerOption: "change",
      answer: "Change: It changes.",
    })),
  ];
  await writeFile(receipts, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  const router = new AnswerRouter({
    receipts,
    asks: { read: async () => ({ controlRepo: root, main: { sha: "f00", fetchedAt: null }, all: asks, warnings: [] }) },
    engine,
    client: () => fake.paseo,
    controlRepo: root,
    now: () => clock,
  });
  const loop = new Loop({
    engine,
    client: () => fake.paseo,
    now: () => new Date(clock),
    wakeLog: new WakeLog(join(root, "wake-log.jsonl"), () => undefined),
    log: () => undefined,
    askMs: 100,
    answers: {
      land: async () => ({
        stage: "none",
        pending: 0,
        asks: [],
        pr: null,
        conflict: null,
        error: null,
        landed: null,
        checkedAt: new Date(clock).toISOString(),
      }),
      route: () => router.route(),
    },
  });
  // Work you queued yourself earlier, plain: the wake must not start it either.
  const yours = await engine.create(fake.paseo, {
    title: "Queued by you",
    brief: "",
    repo,
    gate: "human",
    check: "",
    initiative: "",
    dispatch: false,
  });
  return { engine, fake, router, loop, asks, yours };
}

test("13b97ad9 replayed: six answers whose askers are gone start nothing and queue six conductor candidates", async () => {
  const { engine, fake, router, loop, asks, yours } = await burst();
  const entry = await loop.wake("timer");

  // Zero starts: no session was created, and the wake says it started nothing.
  expect(fake.created).toEqual([]);
  expect([entry.dispatched, entry.deferred]).toEqual([[], []]);
  // No answer became work: the only item is the one you queued, still queued.
  const { items } = await engine.list();
  expect(items.map((item) => [item.id, item.state])).toEqual([[yours.id, "proposed"]]);
  expect((await engine.answered()).size).toBe(0);

  // Six candidates for the conductor, one per answer, each carrying the ask, the answer and pointers.
  const candidates = await router.candidates();
  expect(candidates.map((candidate) => [candidate.for, candidate.ask.id, candidate.answer.option])).toEqual(
    IDS.map((id) => ["lane.assign", id, "change"]),
  );
  for (const [at, candidate] of candidates.entries()) {
    expect(candidate.pointers).toMatchObject({ askedBy: `asker-${at + 1}`, homeKind: "checkout", initiative: null });
    expect(candidate.answer.words).toBe("Change: It changes.");
  }
  expect(entry.answers?.routed.map((routed) => [routed.id, routed.route])).toEqual(IDS.map((id) => [id, "conductor"]));
  // Decisions shows each waiting "for the conductor", never as acted on.
  const cards = await router.fates(asks, null);
  expect(cards.map((card) => card.fate?.stage)).toEqual(IDS.map(() => "conductor"));
  expect(cards[0]?.fate?.words).toStartWith("For the conductor:");

  // The next wake routes nothing again and still starts nothing.
  const next = await loop.wake("timer");
  expect([next.dispatched, next.answers?.routed ?? []]).toEqual([[], []]);
  expect(fake.created).toEqual([]);
  expect(await router.candidates()).toHaveLength(6);

  // Your own Dispatch still starts work.
  expect((await engine.dispatch(fake.paseo, yours.id)).state).toBe("running");
  expect(fake.created).toHaveLength(1);
});
