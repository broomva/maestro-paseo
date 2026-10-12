import { afterAll, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askKey } from "../client/decisions-model";
import { fakeWork } from "../client/fake-work";
import type { AnswersLanding } from "../shared/answers";
import type { WorkItem } from "../shared/contracts";
import type { DecisionAsk } from "../shared/fleet";
import type { Initiative } from "../shared/initiatives";
import { askHoldKey, holdOf, NEED_KINDS, type NeedRow, NeedRowSchema } from "../shared/needs";
import {
  answersNeed,
  closerOf,
  firstSeenMemory,
  HANDLED_MS,
  handledOf,
  type NeedSources,
  needsOf,
  type OpenApproval,
  reviewNeed,
  sortNeeds,
  summaryOf,
  workNeed,
} from "./needs";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const NOW = Date.parse("2026-10-10T15:00:00.000Z");
const A1KEY = 'ask:["origin/main","bro-3001.yaml",null,"A1"]';
const A2KEY = 'ask:["origin/main","bro-3001.yaml",null,"A2"]';
const live = { agentId: "agent-1234567890", workspaceId: "ws1" };

const ask = (id: string, extra: Partial<DecisionAsk> = {}): DecisionAsk => ({
  ledger: "bro-3001.yaml",
  uid: null,
  id,
  hash: "0123456789abcdef",
  arc: null,
  headline: `Ask ${id}?`,
  question: null,
  stakes: null,
  whyYou: null,
  options: [],
  fallback: null,
  blocking: false,
  askedAt: "2026-10-10T10:00:00.000Z",
  answeredAt: null,
  answer: null,
  answerOption: null,
  state: "open",
  origin: null,
  refusal: null,
  home: { kind: "main", path: "/ctl", branch: null },
  batched: false,
  waiting: false,
  ...extra,
});

const initiative = (id: string, extra: Partial<Initiative> = {}): Initiative => ({
  id,
  file: `${id}.yaml`,
  home: { kind: "main", path: "/ctl", branch: null },
  error: null,
  title: `Initiative ${id}`,
  quote: "Ship the thing.",
  intentSource: null,
  summary: null,
  status: "active",
  stated: null,
  reviewBy: "2026-10-08",
  wake: null,
  nextAction: "Land the PR",
  driver: "sri-orchestrator",
  waitingOn: [],
  linear: [],
  prs: [],
  repos: [],
  sessions: [],
  asks: [],
  exit: null,
  closedAt: null,
  outcome: null,
  stale: { kind: "overdue", date: "2026-10-08" },
  local: [],
  ideas: { open: 0, triaged: 0 },
  ...extra,
});

const landing = (extra: Partial<AnswersLanding> = {}): AnswersLanding => ({
  stage: "waiting",
  pending: 2,
  asks: [],
  pr: { number: 915, url: "https://github.com/broomva/workspace/pull/915" },
  conflict: null,
  error: null,
  landed: null,
  checkedAt: "2026-10-10T14:00:00.000Z",
  ...extra,
});

const flag = (kind: "yours" | "failed" | "quiet") => ({
  kind,
  reason: `Flagged ${kind}.`,
  at: "2026-10-10T12:00:00.000Z",
});

/** An action a session asked leave for, waiting since 09:00 (approval.request). */
const asked = (id = "gate"): OpenApproval => ({
  id,
  at: "2026-10-10T09:00:00.000Z",
  agentId: "agent-12",
  action: "gh pr merge 933 --squash @ ce73104",
  heldBy: "gate",
  title: "Merge #933",
  scope: "broomva",
  evidence: [],
  after: [],
});

const sources = (extra: Partial<NeedSources> = {}): NeedSources => ({
  items: [],
  asks: [],
  reviews: [],
  landing: null,
  workspace: "broomva",
  ...extra,
});

/** Work in every state, and every kind of flag. */
function everyState(): WorkItem[] {
  return [
    // Finished and waiting at the gate, nothing held: watched, never a need (A1, BRO-2999).
    fakeWork("gate", "review", live, { updatedAt: "2026-10-10T09:00:00.000Z", permission: null }),
    fakeWork("perm", "review", live, {
      updatedAt: "2026-10-10T11:00:00.000Z",
      permission: { requestId: "r1", title: "Run bash", detail: "git push" },
    }),
    fakeWork("stuck", "blocked", live, { reason: "Stopped before finishing" }),
    fakeWork("quiet", "running", live, { flag: flag("quiet") }),
    fakeWork("run", "running", live),
    fakeWork("queued", "proposed"),
    fakeWork("yours", "proposed", null, { flag: flag("yours") }),
    fakeWork("failed", "proposed", null, { flag: flag("failed") }),
    fakeWork("done", "done", null, { closed: { by: "you", at: "2026-10-10T13:00:00.000Z" } }),
    fakeWork("canceled", "canceled"),
  ];
}

describe("needs.list's kinds (owner answer A1)", () => {
  test("a held action is an approval; only you may start it is an owner step; nothing else is a need", () => {
    const rows = everyState().map((item) => workNeed(item));
    const byKey = new Map(rows.filter((row): row is NeedRow => row !== null).map((row) => [row.key, row]));
    // Work that finished and waits at the gate holds nothing: work is never asked to be approved (A1).
    expect([...byKey.keys()].sort()).toEqual(["work:failed", "work:perm", "work:yours"]);
    expect(byKey.has("work:gate")).toBe(false);

    const perm = byKey.get("work:perm");
    if (perm?.kind !== "approval") throw new Error("not an approval");
    expect(perm.body.heldBy).toBe("permission");
    expect(perm.body.action).toBe("Run bash: git push");
    expect(perm.verbs).toEqual(["allow", "deny"]);
    expect(perm.session).toEqual({ agentId: live.agentId, name: "agent-12", waiting: true });
    expect(perm.blocksWork).toBe(true);
    // The row names the prompt it shows, so an answer can only be to that one.
    expect(perm.body.requestId).toBe("r1");

    const yours = byKey.get("work:yours");
    if (yours?.kind !== "owner_step") throw new Error("not an owner step");
    expect(yours.verbs).toEqual(["done", "later"]);
    expect(yours.since).toBe("2026-10-10T12:00:00.000Z");
    expect(yours.body.doneCheck).toContain("Flagged yours.");
    expect(byKey.get("work:failed")?.kind).toBe("owner_step");
  });

  test("stuck work, a quiet run and an open ask that does not wait are watched, never needs", () => {
    const { rows } = needsOf(
      sources({
        items: [fakeWork("stuck", "blocked", live), fakeWork("quiet", "running", live, { flag: flag("quiet") })],
        asks: [
          ask("calm", { options: [{ id: "a", label: "A", consequence: null, reversible: true, recommended: true }] }),
        ],
      }),
      NOW,
    );
    expect(rows).toEqual([]);
  });

  test("an ask that waits on you is an ask: blocking holds work, an irreversible recommendation does not", () => {
    const blocking = ask("A1", { blocking: true, whyYou: "It is yours.", stakes: "A day of work." });
    const oneWay = ask("A2", {
      options: [
        { id: "go", label: "Go", consequence: "Ships it.", reversible: false, recommended: true },
        { id: "wait", label: "Wait", consequence: null, reversible: true, recommended: false },
      ],
    });
    const { rows } = needsOf(sources({ asks: [blocking, oneWay, ask("A3", { state: "answered" })] }), NOW);
    expect(rows.map((row) => [row.key, row.kind, row.blocksWork])).toEqual([
      [A1KEY, "ask", true],
      [A2KEY, "ask", false],
    ]);
    const [first, second] = rows;
    if (first?.kind !== "ask" || second?.kind !== "ask") throw new Error("not asks");
    expect(first.body).toEqual({
      why: "It is yours.",
      cost: "A day of work.",
      options: [],
      goesTo: "origin/main, through Maestro's answers batch",
    });
    expect(second.body.recommended).toBe("go");
    expect(second.body.options).toEqual([
      { id: "go", label: "Go", consequence: "Ships it." },
      { id: "wait", label: "Wait", consequence: null },
    ]);
    expect(first.verbs).toEqual(["answer", "skip"]);
  });

  test("a fleet root's ask belongs to its scope, and one ask read twice is one hold", () => {
    const fleetAsk = ask("F1", {
      blocking: true,
      scope: "sri",
      ledger: "fleet-sri.yaml",
      home: { kind: "root", path: "/state/sri/.control/asks", branch: null },
    });
    const { rows, summary } = needsOf(sources({ asks: [fleetAsk, { ...fleetAsk }] }), NOW);
    expect(rows).toHaveLength(1);
    expect(summary.total).toBe(1);
    expect(rows[0]?.scope).toBe("sri");
    expect(rows[0]?.key).toBe(askHoldKey(fleetAsk));
    if (rows[0]?.kind !== "ask") throw new Error("not an ask");
    expect(rows[0].body.goesTo).toBe("the fleet's own ledger for sri");
  });

  test("an answer that waits for the conductor is not a need: the conductor gives it to a lane (BRO-2990)", () => {
    const waiting = ask("C1", {
      state: "answered",
      answerOption: "go",
      answeredAt: "2026-10-10T08:00:00.000Z",
      fate: {
        stage: "conductor",
        words: "Waits for the conductor.",
        route: "conductor",
        pr: null,
        work: null,
        agentId: null,
        key: "k1",
        pending: null,
      },
    });
    expect(needsOf(sources({ asks: [waiting] }), NOW).rows).toEqual([]);
  });

  describe("one permission prompt is one hold (fleet-reconcile's prompt ask)", () => {
    // The real shape: the work names the Paseo agent; fleet-reconcile's key names the Claude session
    // (`prompt:<session_id>:<tag>`, fleetlib report.py), and its report says which agent that session is.
    const AGENT = "b76446da-2c1e-4f0b-9a3d-5e8c7a1b2f60";
    const SESSION = "51ba8cdf-7d24-4e9a-8b16-0c3f2e9d4a71";
    const prompt = (session: string, id = `fleet-broomva-${session.slice(0, 8)}`) =>
      ask(id, {
        headline: `Session act-on-your-answer (${session.slice(0, 8)}) is waiting at a prompt: listing: status waiting, waitingFor 'permission prompt'. The fleet never approves prompts.`,
        blocking: true,
        scope: "broomva",
        ledger: "fleet-broomva.yaml",
        home: { kind: "root", path: "/state/broomva/.control/asks", branch: null },
        options: [{ id: "ack", label: "Acknowledge", consequence: null, reversible: true, recommended: true }],
        promptSession: session,
      });
    const paused = (id: string, agentId: string) =>
      fakeWork(
        id,
        "review",
        { agentId, workspaceId: "ws1" },
        {
          permission: { requestId: `r-${id}`, title: "Bash", detail: "git push" },
        },
      );

    test("the work's agent and the ask's Claude session are one prompt: it counts once, as the approval", () => {
      const needs = needsOf(
        sources({ items: [paused("p", AGENT)], asks: [prompt(SESSION)], sessionAgents: new Map([[SESSION, AGENT]]) }),
        NOW,
      );
      expect(needs.summary).toMatchObject({ total: 1, byKind: { ask: 0, approval: 1, owner_step: 0 } });
      expect(needs.rows[0]?.key).toBe("work:p");
      // Without the fleet's word on who the session is, the two ids never meet: both stand.
      expect(needsOf(sources({ items: [paused("p", AGENT)], asks: [prompt(SESSION)] }), NOW).summary.total).toBe(2);
    });

    test("a session Maestro does not track, one the report does not name, and another session's prompt all count", () => {
      const other = "9d04b252-a1bf-477c-a01f-10c1bb23ad9a";
      const untracked = "d5f59267-6330-45fb-98c9-e339c098e448";
      const unnamed = "4ca336e1-f891-444b-bf12-cb0ccc4d2737";
      const needs = needsOf(
        sources({
          items: [paused("p", AGENT)],
          asks: [prompt(SESSION), prompt(other), prompt(untracked), prompt(unnamed)],
          sessionAgents: new Map([
            [SESSION, AGENT],
            [other, "aaaaaaaa-0000-4000-8000-000000000002"],
            [untracked, "aaaaaaaa-0000-4000-8000-000000000003"],
          ]),
        }),
        NOW,
      );
      expect(needs.summary.byKind).toEqual({ ask: 3, approval: 1, owner_step: 0 });
      expect(
        needs.rows
          .filter((row) => row.kind === "ask")
          .map((row) => row.title.slice(28, 36))
          .sort(),
      ).toEqual([other, untracked, unnamed].map((id) => id.slice(0, 8)).sort());
    });

    test("finished work holds no prompt, so the session's prompt ask is the only hold and still counts", () => {
      const finished = fakeWork("g", "review", { agentId: AGENT, workspaceId: "ws1" }, { permission: null });
      const needs = needsOf(
        sources({ items: [finished], asks: [prompt(SESSION)], sessionAgents: new Map([[SESSION, AGENT]]) }),
        NOW,
      );
      expect(needs.summary.byKind).toEqual({ ask: 1, approval: 0, owner_step: 0 });
    });

    test("a key that already names the agent meets it directly; an ask that is not a prompt is never dropped", () => {
      expect(needsOf(sources({ items: [paused("p", AGENT)], asks: [prompt(AGENT)] }), NOW).summary.total).toBe(1);
      const own = ask("own", { blocking: true, origin: { agentId: AGENT, cwd: null } });
      const needs = needsOf(
        sources({ items: [paused("p", AGENT)], asks: [own], sessionAgents: new Map([[SESSION, AGENT]]) }),
        NOW,
      );
      expect(needs.summary.total).toBe(2);
    });
  });

  test("an approval waits from when it reached your gate, not from its last note", () => {
    const row = workNeed(
      fakeWork("g", "review", live, { landedAt: "2026-10-10T09:00:00.000Z", updatedAt: "2026-10-10T14:00:00.000Z" }),
    );
    expect(row?.since).toBe("2026-10-10T09:00:00.000Z");
    // From an older daemon, with no landing time: its last change.
    expect(workNeed(fakeWork("o", "review", live, { updatedAt: "2026-10-10T14:00:00.000Z" }))?.since).toBe(
      "2026-10-10T14:00:00.000Z",
    );
  });

  test("the wire says when work reached your gate: its move into review, which a later note does not move", async () => {
    const { WorkStore } = await import("./store");
    const { toWire } = await import("./wire");
    const { defaultConfig } = await import("./config");
    const root = await mkdtemp(join(tmpdir(), "maestro-needs-"));
    roots.push(root);
    const config = { ...defaultConfig(), workRoot: join(root, "work"), provider: "claude", modeId: null };
    const store = new WorkStore(config.workRoot, () => new Date(NOW));
    const item = await store.create({
      title: "Landed",
      brief: "",
      repo: root,
      gate: "human",
      check: "",
      initiative: "",
    });
    const workFile = join(item.dir, "_work.md");
    await writeFile(workFile, (await readFile(workFile, "utf8")).replace(/^state: \w+$/m, "state: review"));
    const event = (ts: string, extra: object) => `${JSON.stringify({ ts, ...extra })}\n`;
    await appendFile(
      join(item.dir, "_events.jsonl"),
      event("2026-10-10T09:00:00.000Z", {
        type: "state",
        actor: "agent",
        from: "running",
        to: "review",
        reason: null,
      }) +
        // The session asked to run a command as it landed: a held action, so a hold.
        event("2026-10-10T09:00:00.000Z", {
          type: "permission.asked",
          actor: "agent",
          agentId: "a",
          requestId: "r",
          title: "Run",
          detail: "ls",
        }) +
        event("2026-10-10T14:00:00.000Z", { type: "note", actor: "maestro", text: "A remark" }),
    );
    const wire = toWire(await store.load(item.dir), NOW, config);
    expect(wire.landedAt).toBe("2026-10-10T09:00:00.000Z");
    expect(wire.updatedAt).toBe("2026-10-10T14:00:00.000Z");
    expect(workNeed(wire)?.since).toBe("2026-10-10T09:00:00.000Z");
  });

  test("the prompt's session is read from the ledger as fleet-reconcile writes it", async () => {
    const { decisionsOf } = await import("./control-asks");
    const [prompt, plain] = decisionsOf(
      [
        "asks:",
        '  - id: "fleet-broomva-5e59e6c987aa"',
        '    uid: "fleet-broomva-5e59e6c987aa"',
        "    headline: \"Session x (10b2b212) is waiting at a prompt: listing: status waiting, waitingFor 'permission prompt'.\"",
        "    blocking: true",
        '    options: [{"id": "ack", "label": "Acknowledge", "reversible": true, "recommended": true}]',
        '    fleet: {"scope": "broomva", "key": "prompt:10b2b212-66f6-4164-8fde-20a2bc92dd50:5bc8f7aa", "class": "3"}',
        '  - id: "fleet-broomva-other"',
        "    headline: Something else",
        "    blocking: true",
        '    fleet: {"scope": "broomva", "key": "alert:tick-observe"}',
      ].join("\n"),
      "fleet-broomva.yaml",
    );
    expect(prompt?.promptSession).toBe("10b2b212-66f6-4164-8fde-20a2bc92dd50");
    expect(plain?.promptSession).toBeNull();
  });

  test("an idea filed for an initiative is a proposal, watched (A1), even when it would wait", () => {
    const idea = ask("I1", {
      blocking: true,
      idea: { initiative: "skene", idea: "A stage", source: null, evidence: null, wake: null },
    });
    expect(needsOf(sources({ asks: [idea] }), NOW).rows).toEqual([]);
  });

  test("an undated ask and the answers batch wait from when they were first seen, which holds still", () => {
    const seenAt = new Map<string, string>();
    const seen = (key: string, now: number) => {
      if (!seenAt.has(key)) seenAt.set(key, new Date(now).toISOString());
      return seenAt.get(key) as string;
    };
    const input = sources({ asks: [ask("U1", { blocking: true, askedAt: null })], landing: landing() });
    const first = needsOf(input, NOW, undefined, seen);
    const later = needsOf(
      { ...input, landing: landing({ checkedAt: "2026-10-10T14:59:00.000Z" }) },
      NOW + 60_000,
      undefined,
      seen,
    );
    expect(later).toEqual(first);
    expect(first.rows.map((row) => row.since)).toEqual([new Date(NOW).toISOString(), new Date(NOW).toISOString()]);
  });

  test("first-seen times hold across reads, survive a read that missed a source, and go once their hold goes", () => {
    const seen = firstSeenMemory();
    const first = seen.at("ask:u1", NOW);
    expect(seen.at("ask:u1", NOW + 60_000)).toBe(first);
    // A read that could not read every source forgets nothing: the ask is still waiting, only unread.
    seen.keep([], false);
    expect(seen.at("ask:u1", NOW + 120_000)).toBe(first);
    // A complete read without it: it went; when it comes back, it waits from then.
    seen.keep([], true);
    expect(seen.at("ask:u1", NOW + 180_000)).toBe(new Date(NOW + 180_000).toISOString());
  });

  test("a due initiative review is an ask with a review body (B2)", () => {
    const items = [
      fakeWork("w1", "running", live, { initiative: "skene" }),
      fakeWork("w2", "done", null, { initiative: "skene" }),
    ];
    const asks = [ask("I1", { initiative: "skene" }), ask("I2", { initiative: "other" })];
    const row = reviewNeed(
      initiative("skene", { waitingOn: [{ kind: "pr", ref: "skene#4", note: "review", ledger: null, askId: null }] }),
      items,
      asks,
      "broomva",
    );
    if (row?.kind !== "ask" || !("initiative" in row.body)) throw new Error("not a review");
    expect(row.key).toBe("review:skene");
    expect(row.blocksWork).toBe(false);
    expect(row.body.initiative).toBe("skene");
    expect(row.body.intent).toBe("Ship the thing.");
    expect(row.body.hanging).toEqual({ work: 1, asks: 1, driver: "sri-orchestrator" });
    expect(row.body.since).toEqual(["Next action: Land the PR", "Waiting on pr skene#4: review"]);
    expect(row.body.options.map((option) => option.id)).toEqual(["keep", "park", "close"]);
    expect(row.body.why).toBe("Its review date, 2026-10-08, has passed.");
    expect(reviewNeed(initiative("calm", { stale: null }), items, asks, "broomva")).toBeNull();
    // The wire parses it as a review, not as an ask that drops the review's fields.
    const parsed = NeedRowSchema.parse(row);
    expect(parsed.body).toEqual(row.body);
  });

  test("the answers batch is an owner step while it waits to land or stopped; never when nothing waits", () => {
    const row = answersNeed(landing(), "broomva");
    if (row?.kind !== "owner_step") throw new Error("not an owner step");
    expect(row.key).toBe("answers:batch");
    expect(row.title).toBe("2 answers wait to land: PR #915");
    expect(row.body.where).toBe("https://github.com/broomva/workspace/pull/915");
    expect(answersNeed(landing({ stage: "none", pending: 0 }), "broomva")).toBeNull();
    expect(answersNeed(landing({ stage: "failed", pending: 0, error: "offline" }), "broomva")).toBeNull();
    expect(answersNeed(null, "broomva")).toBeNull();
    const conflict = answersNeed(
      landing({ stage: "conflict", conflict: { ledgers: ["a.yaml"], path: "/ctl/.answers" } }),
      "broomva",
    );
    expect(conflict?.kind).toBe("owner_step");
  });
});

describe("a held action while your decision waits out its window (BRO-2999)", () => {
  const pending = (key: string) =>
    new Map([[key, { receipt: "r1", label: "Allowed Run bash: git push", appliesAt: "2026-10-10T15:00:08.000Z" }]]);

  test("the approval says so, with the receipt Undo takes; every other hold is untouched", () => {
    const needs = needsOf(sources({ items: everyState(), approvals: [asked()], pending: pending("work:perm") }), NOW);
    const perm = needs.rows.find((row) => row.key === "work:perm");
    if (perm?.kind !== "approval") throw new Error("not an approval");
    expect(perm.body.pending).toEqual({
      receipt: "r1",
      label: "Allowed Run bash: git push",
      appliesAt: "2026-10-10T15:00:08.000Z",
    });
    const request = needs.rows.find((row) => row.key === "approval:gate");
    if (request?.kind !== "approval") throw new Error("not an approval");
    expect(request.body.pending).toBeUndefined();
    // A decision on a request counts down the same way, and neither leaves needs.list until it takes effect.
    const both = needsOf(sources({ approvals: [asked()], pending: pending("approval:gate") }), NOW);
    expect(both.rows).toHaveLength(1);
    expect(both.rows[0]?.kind === "approval" && both.rows[0].body.pending?.receipt).toBe("r1");
  });

  test("work that finished and waits at the gate holds nothing, however long it waits", () => {
    const finished = fakeWork("f", "review", live, { permission: null, updatedAt: "2026-10-01T00:00:00.000Z" });
    expect(workNeed(finished)).toBeNull();
    expect(needsOf(sources({ items: [finished] }), NOW).summary.total).toBe(0);
  });
});

describe("deck order and the summary", () => {
  const rowsOfEveryKind = () =>
    needsOf(
      sources({
        items: everyState(),
        approvals: [asked()],
        asks: [ask("A1", { blocking: true, askedAt: "2026-10-09T10:00:00.000Z" }), ask("A2", { blocking: true })],
        reviews: [initiative("skene")],
        landing: landing(),
      }),
      NOW,
    ).rows;

  test("what blocks work first, then the longest waiting, ties broken by key", () => {
    expect(rowsOfEveryKind().map((row) => row.key)).toEqual([
      A1KEY, // blocks; waiting since 10-09 10:00
      "approval:gate", // 10-10 09:00
      A2KEY, // 10:00
      "work:perm", // 11:00
      "work:failed", // 12:00, and its key before work:yours'
      "work:yours", // 12:00
      "answers:batch", // 14:00
      "review:skene", // holds no work: last, though it waits longest (10-08)
    ]);
  });

  test("an earlier timed default goes ahead of an older ask with none", () => {
    const base = needsOf(sources({ asks: [ask("old", { blocking: true, askedAt: "2026-10-01T00:00:00.000Z" })] }), NOW)
      .rows[0] as NeedRow;
    const timed = { ...base, key: "ask:timed", since: "2026-10-10T00:00:00.000Z" } as NeedRow;
    if (timed.kind !== "ask") throw new Error("not an ask");
    timed.body = { ...timed.body, default: { option: "a", appliesAt: "2026-10-10T16:00:00.000Z" } };
    expect(sortNeeds([base, timed]).map((row) => row.key)).toEqual(["ask:timed", base.key]);
  });

  test("the order is the same for every order of equal inputs (invariant 3)", () => {
    const rows = rowsOfEveryKind();
    const expected = rows.map((row) => row.key);
    let seed = 7;
    for (let round = 0; round < 50; round += 1) {
      const shuffled = [...rows].sort(() => {
        seed = (seed * 16807) % 2147483647;
        return (seed % 3) - 1;
      });
      expect(sortNeeds(shuffled).map((row) => row.key)).toEqual(expected);
    }
  });

  test("total == rows.length == Σ byKind, and oldest names the longest waiting", () => {
    const rows = rowsOfEveryKind();
    const summary = summaryOf(rows);
    expect(summary.total).toBe(rows.length);
    expect(NEED_KINDS.reduce((sum, kind) => sum + summary.byKind[kind], 0)).toBe(rows.length);
    expect(summary.byKind).toEqual({ ask: 3, approval: 2, owner_step: 3 });
    expect(summary.oldest).toEqual({ key: "review:skene", since: new Date("2026-10-08T00:00:00").toISOString() });
    expect(summaryOf([])).toEqual({ total: 0, byKind: { ask: 0, approval: 0, owner_step: 0 } });
  });

  test("a kind narrows the rows, and the summary then describes exactly those", () => {
    const held = { items: everyState(), approvals: [asked()], asks: [ask("A1", { blocking: true })] };
    const all = needsOf(sources(held), NOW);
    const approvals = needsOf(sources(held), NOW, "approval");
    expect(approvals.rows.map((row) => row.key)).toEqual(
      all.rows.filter((row) => row.kind === "approval").map((row) => row.key),
    );
    expect(approvals.summary).toEqual({
      total: 2,
      byKind: { ask: 0, approval: 2, owner_step: 0 },
      oldest: { key: "approval:gate", since: "2026-10-10T09:00:00.000Z" },
    });
  });

  test("every row parses on the wire, and the projection never changes what it is handed", () => {
    const items = everyState();
    const asks = [ask("A1", { blocking: true })];
    const input = sources({ items, asks, reviews: [initiative("skene")], landing: landing() });
    const before = JSON.stringify(input);
    const { rows } = needsOf(input, NOW);
    for (const row of rows) expect(NeedRowSchema.parse(row)).toEqual(row);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("hold keys", () => {
  test("each key names its hold, and an ask's carries the identity Decisions opens it by", () => {
    const one = ask("A1", { uid: "bro-3001-a1", home: { kind: "checkout", path: "/wt/a:b", branch: "x" } });
    expect(holdOf(askHoldKey(one))).toEqual({ kind: "ask", askKey: askKey(one) });
    expect(holdOf("work:abc-1")).toEqual({ kind: "work", id: "abc-1" });
    expect(holdOf("review:skene")).toEqual({ kind: "review", initiative: "skene" });
    expect(holdOf("answers:batch")).toEqual({ kind: "answers" });
    expect(holdOf("nonsense")).toBeNull();
    expect(holdOf("work:")).toBeNull();
    expect(holdOf("fleet:x")).toBeNull();
  });
});

describe("handled.list", () => {
  const dayStart = Date.parse("2026-10-10T05:00:00.000Z");
  const closed = (id: string, by: "you" | "maestro", at: string, extra: Partial<WorkItem> = {}) =>
    fakeWork(id, "done", null, { closed: { by, at }, ...extra });

  test("who closed it: you, the gates, its orchestrator, or Maestro", () => {
    expect(closerOf(closed("a", "you", "2026-10-10T10:00:00.000Z"))).toBe("you");
    expect(
      closerOf(
        closed("b", "maestro", "2026-10-10T10:00:00.000Z", {
          adoptedBy: { by: "SRI" },
          verdict: "Its branch run/x merged as broomva/x#4 after it was adopted",
        }),
      ),
    ).toBe("gates");
    expect(
      closerOf(closed("c", "maestro", "2026-10-10T10:00:00.000Z", { gate: "auto", verdict: "All 2 checks passed" })),
    ).toBe("gates");
    // Auto gate, but closed on other evidence (its checks failed, its arc finished): Maestro's, not the gates'.
    expect(
      closerOf(
        closed("c2", "maestro", "2026-10-10T10:00:00.000Z", {
          gate: "auto",
          verdict: "1 of 2 checks failed · its arc reported itself finished",
        }),
      ),
    ).toBe("maestro");
    expect(closerOf(closed("c3", "maestro", "2026-10-10T10:00:00.000Z", { gate: "auto" }))).toBe("maestro");
    expect(closerOf(closed("d", "maestro", "2026-10-10T10:00:00.000Z", { adoptedBy: { by: "SRI" } }))).toBe(
      "orchestrator",
    );
    expect(closerOf(closed("e", "maestro", "2026-10-10T10:00:00.000Z"))).toBe("maestro");
    expect(closerOf(fakeWork("f", "running"))).toBeNull();
  });

  test("the last week, newest first, with today's counts", () => {
    const items = [
      closed("old", "maestro", new Date(NOW - HANDLED_MS - 1).toISOString()),
      closed("yesterday", "maestro", "2026-10-09T20:00:00.000Z", { adoptedBy: { by: "SRI" }, verdict: "Finished" }),
      closed("mine", "you", "2026-10-10T09:00:00.000Z", { verdict: "You approved" }),
      closed("gated", "maestro", "2026-10-10T11:00:00.000Z", { gate: "auto", verdict: "All 2 checks passed" }),
      fakeWork("open", "running", live),
    ];
    // A ledger that writes only the day: today's local day, not UTC's (in UTC-5, UTC midnight is yesterday).
    // In the owner's zone (bun test runs in UTC, where a bare day's two midnights coincide).
    const zone = process.env.TZ;
    process.env.TZ = "America/Bogota";
    try {
      const local = new Date(NOW);
      local.setHours(0, 0, 0, 0);
      const bogotaDay = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
      const dayOnly = [ask("day-only", { state: "answered", answeredAt: bogotaDay })];
      expect(handledOf([], dayOnly, NOW, local.getTime()).today.asksAnswered).toBe(1);
    } finally {
      // bun test runs in UTC with TZ unset; deleting it would fall back to the machine's zone for every later test.
      process.env.TZ = zone ?? "Etc/UTC";
    }
    const asks = [
      ask("today", { state: "answered", answeredAt: "2026-10-10T08:00:00.000Z" }),
      ask("before", { state: "answered", answeredAt: "2026-10-09T08:00:00.000Z" }),
      ask("open"),
    ];
    const handled = handledOf(items, asks, NOW, dayStart);
    expect(handled.rows).toEqual([
      {
        key: "work:gated",
        title: "Work gated",
        closedBy: "gates",
        reason: "All 2 checks passed",
        at: "2026-10-10T11:00:00.000Z",
      },
      { key: "work:mine", title: "Work mine", closedBy: "you", reason: "You approved", at: "2026-10-10T09:00:00.000Z" },
      {
        key: "work:yesterday",
        title: "Work yesterday",
        closedBy: "orchestrator",
        reason: "SRI: Finished",
        at: "2026-10-09T20:00:00.000Z",
      },
    ]);
    expect(handled.today).toEqual({ closedForYou: 1, byYou: 1, asksAnswered: 1 });
  });
});
