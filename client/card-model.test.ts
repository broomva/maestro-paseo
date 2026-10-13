// What a card says, from what it reads (BRO-3008, K1). Every state of every kind, and the rules that keep it
// honest: a failed read is "couldn't read", never "nothing pending" or "resolved"; a card is only current for its
// own raise; a decision anywhere shows as the same undo window; and ids that are not the card's never bind.
//
// Fixtures use real id spaces: a Paseo agent id, the Claude session it runs and the work are three different ids
// (worker-brief.md, #56: a fixture that used one id for all three tested the mirror).

import { describe, expect, test } from "bun:test";
import { needsOf, type OpenApproval } from "../server/needs";
import type { CardData } from "../shared/card";
import type { WorkItem } from "../shared/contracts";
import type { NeedRow, Needs } from "../shared/needs";
import type { PendingVerb, SettledVerb } from "../shared/verbs";
import {
  CARD_VERBS,
  type CardState,
  cardLive,
  cardState,
  cardVerbs,
  DIGEST_ROWS,
  digestOf,
  digestWords,
  GONE_ELSEWHERE,
  HELD_ELSEWHERE,
  holdState,
  type Ledger,
  MOVED_ELSEWHERE,
  openTarget,
  type Read,
  resolution,
  SUPERSEDED,
  SUPERSEDED_HOLD,
  workState,
} from "./card-model";
import { fakeWork } from "./fake-work";

const AGENT = "6f1c2e0a-93b4-4d7e-8a15-2c9d0b7e41aa";
const OTHER_AGENT = "b3d9a7f2-0c51-4e8a-9f6d-71e2a4c85b03";
const CLAUDE_SESSION = "0d4e8c11-52aa-47b9-9c3e-aa6f01d2b7c4";
const WORK = "w-20261012-ledger-1f3a";
const NOW = Date.parse("2026-10-12T15:00:00.000Z");
const worker = { agentId: AGENT, workspaceId: "ws-5d2" };

const ok = <T>(value: T): Read<T> => ({ status: "ok", value });
const loading = { status: "loading" } as const;
const failed = (message: string): Read<never> => ({ status: "error", message });
const noLedger: Ledger = { pending: [], recent: [] };

const needsRead = (items: WorkItem[], approvals: OpenApproval[] = []): Needs =>
  needsOf({ items, asks: [], reviews: [], landing: null, workspace: "broomva", approvals }, NOW);

const permission = { requestId: "req-7c1", title: "Run a command", detail: "gh pr merge 933" };
const asking = fakeWork(WORK, "review", worker, { permission, landing: 4 });
const approvalCard: CardData = { kind: "approval", key: `work:${WORK}`, version: "req-7c1" };

const pending = (extra: Partial<PendingVerb> = {}): PendingVerb => ({
  receipt: "r-1",
  verb: "approval.decide",
  key: `work:${WORK}`,
  label: "Allowed Run a command: gh pr merge 933",
  at: "2026-10-12T14:59:55.000Z",
  appliesAt: "2026-10-12T15:00:03.000Z",
  remainingMs: 8000,
  ...extra,
});
const settled = (extra: Partial<SettledVerb> = {}): SettledVerb => ({
  receipt: "r-1",
  verb: "approval.decide",
  key: `work:${WORK}`,
  label: "Allowed Run a command: gh pr merge 933",
  at: "2026-10-12T14:59:55.000Z",
  settledAt: "2026-10-12T15:00:03.000Z",
  outcome: "applied",
  detail: "Answered the prompt.",
  ...extra,
});

describe("an approval card", () => {
  test("pending: the hold stands, as of the read, with its row (the text and the ids come from one read)", () => {
    const state = holdState({ card: approvalCard, needs: ok(needsRead([asking])), ledger: ok(noLedger) });
    expect(state.phase).toBe("open");
    if (state.phase !== "open") return;
    expect(state.row?.kind).toBe("approval");
    if (state.row?.kind !== "approval") return;
    // The action the card shows and the request id a verb sends are the same row's: the binding is the read's.
    expect(state.row.body.action).toBe("Run a command: gh pr merge 933");
    expect(state.row.body.requestId).toBe("req-7c1");
  });

  test("undo window: any decision of yours on its key, from the card or from J1, is the same window and the same Undo", () => {
    const state = holdState({
      card: approvalCard,
      needs: ok(needsRead([asking])),
      ledger: ok({ ...noLedger, pending: [pending()] }),
    });
    expect(state).toEqual({
      phase: "undo",
      receipt: "r-1",
      label: "Allowed Run a command: gh pr merge 933",
      appliesAt: "2026-10-12T15:00:03.000Z",
    });
    // A decision on another hold is not this card's window.
    const other = holdState({
      card: approvalCard,
      needs: ok(needsRead([asking])),
      ledger: ok({ ...noLedger, pending: [pending({ key: "work:w-other" })] }),
    });
    expect(other.phase).toBe("open");
    // Nor is another verb on the same work: a Continue is not a decision on the action.
    const prompt = holdState({
      card: approvalCard,
      needs: ok(needsRead([asking])),
      ledger: ok({ ...noLedger, pending: [pending({ verb: "session.prompt" })] }),
    });
    expect(prompt.phase).toBe("open");
  });

  test("a hold that has left needs.list while your decision still waits keeps its Undo: the window is not over", () => {
    const state = holdState({
      card: approvalCard,
      needs: ok(needsRead([])),
      ledger: ok({ ...noLedger, pending: [pending()] }),
    });
    expect(state.phase).toBe("undo");
  });

  test("receipt: it left the holds after your Allow took effect, and says what happened", () => {
    const state = holdState({
      card: approvalCard,
      needs: ok(needsRead([])),
      ledger: ok({ ...noLedger, recent: [settled()] }),
    });
    expect(state).toEqual({
      phase: "receipt",
      words: "Allowed Run a command: gh pr merge 933 · took effect",
      at: "2026-10-12T15:00:03.000Z",
      tone: "ok",
    });
  });

  test("a decision that was dropped is a receipt in a warm tone, never a done one", () => {
    const state = holdState({
      card: approvalCard,
      needs: ok(needsRead([])),
      ledger: ok({
        ...noLedger,
        recent: [settled({ outcome: "dropped", detail: "The session now asks for something else." })],
      }),
    });
    expect(state).toMatchObject({ phase: "receipt", tone: "warn" });
    expect(state.phase === "receipt" && state.words).toContain("dropped: The session now asks for something else.");
  });

  test("resolved elsewhere: gone from needs.list with no receipt of ours (answered on Paseo's own prompt, say)", () => {
    expect(holdState({ card: approvalCard, needs: ok(needsRead([])), ledger: ok(noLedger) })).toEqual({
      phase: "resolved",
      words: GONE_ELSEWHERE,
    });
    // An undone decision left no change, so it is not a receipt either.
    const undone = holdState({
      card: approvalCard,
      needs: ok(needsRead([])),
      ledger: ok({ ...noLedger, recent: [settled({ outcome: "undone" })] }),
    });
    expect(undone.phase).toBe("resolved");
  });

  test("a card for an earlier prompt is superseded when the session has asked another: no verb on a newer hold", () => {
    const next = fakeWork(WORK, "review", worker, { permission: { ...permission, requestId: "req-9d2" }, landing: 4 });
    const state = holdState({ card: approvalCard, needs: ok(needsRead([next])), ledger: ok(noLedger) });
    expect(state).toEqual({ phase: "superseded", words: SUPERSEDED_HOLD });
    expect(cardLive(state)).toBe(false);
  });

  test("an action an agent asked leave for is read by its own key, versioned by the key", () => {
    const asked: OpenApproval = {
      id: "e4a1c0",
      at: "2026-10-12T09:00:00.000Z",
      agentId: OTHER_AGENT,
      action: "git push origin main @ ce73104",
      heldBy: "gate",
      title: "Push main",
      scope: "broomva",
      evidence: [],
      after: [],
    };
    const card: CardData = { kind: "approval", key: "approval:e4a1c0", version: "approval:e4a1c0" };
    expect(holdState({ card, needs: ok(needsRead([], [asked])), ledger: ok(noLedger) }).phase).toBe("open");
    expect(holdState({ card, needs: ok(needsRead([])), ledger: ok(noLedger) }).phase).toBe("resolved");
  });
});

describe("a failed read is never 'nothing pending' or 'resolved'", () => {
  test("a needs read that failed is unread, with the reason, and offers nothing", () => {
    const state = holdState({ card: approvalCard, needs: failed("daemon unreachable"), ledger: ok(noLedger) });
    expect(state).toEqual({ phase: "unread", words: "Couldn't read what needs you: daemon unreachable" });
    expect(cardLive(state)).toBe(true);
  });

  test("a hold missing because its source was not read is unread, not resolved", () => {
    const read: Needs = { ...needsRead([]), unread: ["work"] };
    const state = holdState({ card: approvalCard, needs: ok(read), ledger: ok(noLedger) });
    expect(state.phase).toBe("unread");
    // The same missing hold with the work read is resolved: only a read source can say a hold went.
    expect(holdState({ card: approvalCard, needs: ok(needsRead([])), ledger: ok(noLedger) }).phase).toBe("resolved");
    // A source that failed which this hold does not come from costs it nothing.
    const asks: Needs = { ...needsRead([]), unread: ["asks"] };
    expect(holdState({ card: approvalCard, needs: ok(asks), ledger: ok(noLedger) }).phase).toBe("resolved");
  });

  test("a ledger that failed hides a decision already waiting, so a hold is not offered blind", () => {
    const state = holdState({
      card: approvalCard,
      needs: ok(needsRead([asking])),
      ledger: failed("verbs.list timed out"),
    });
    expect(state).toEqual({ phase: "unread", words: "Couldn't read your decisions: verbs.list timed out" });
  });

  test("loading is loading: neither a verb nor a verdict", () => {
    expect(holdState({ card: approvalCard, needs: loading, ledger: ok(noLedger) })).toEqual({ phase: "loading" });
    expect(holdState({ card: approvalCard, needs: ok(needsRead([asking])), ledger: loading })).toEqual({
      phase: "loading",
    });
  });
});

describe("an ask card and an owner step card", () => {
  const yours = fakeWork("w-yours", "proposed", null, {
    flag: { kind: "yours", reason: "Only you may start it.", at: "2026-10-12T12:00:00.000Z" },
  });
  const ask = (state: Partial<NeedRow> = {}): NeedRow =>
    ({
      kind: "ask",
      key: 'ask:["origin/main","bro-3001.yaml",null,"A1"]',
      title: "Install the three Claude Code mods fleet-wide?",
      scope: "broomva",
      session: { agentId: AGENT, name: "6f1c2e0a", waiting: true },
      since: "2026-10-12T13:00:00.000Z",
      blocksWork: true,
      verbs: ["answer", "skip"],
      body: { why: "", cost: "", options: [], goesTo: "origin/main" },
      ...state,
    }) as NeedRow;
  const askCard: CardData = { kind: "ask", key: ask().key, version: "2026-10-12T13:00:00.000Z" };
  const read = (rows: NeedRow[], unread?: Needs["unread"]): Needs => ({
    rows,
    summary: { total: rows.length, byKind: { ask: rows.length, approval: 0, owner_step: 0 } },
    ...(unread ? { unread } : {}),
  });

  test("an ask is open while its row stands at its own raise, and an answer in its window is the undo state", () => {
    expect(holdState({ card: askCard, needs: ok(read([ask()])), ledger: ok(noLedger) }).phase).toBe("open");
    const window = holdState({
      card: askCard,
      needs: ok(read([ask()])),
      ledger: ok({
        ...noLedger,
        pending: [pending({ verb: "ask.answer", key: askCard.key, label: "Answered Install the mods" })],
      }),
    });
    expect(window).toMatchObject({ phase: "undo", label: "Answered Install the mods" });
  });

  test("an ask answered elsewhere collapses: gone with its source read says so, and an unread source does not", () => {
    expect(holdState({ card: askCard, needs: ok(read([])), ledger: ok(noLedger) }).phase).toBe("resolved");
    expect(holdState({ card: askCard, needs: ok(read([], ["asks"])), ledger: ok(noLedger) }).phase).toBe("unread");
  });

  test("an ask that came back later (a new first-seen time) is a newer hold: the older card is superseded", () => {
    const again = ask({ since: "2026-10-12T14:30:00.000Z" });
    expect(holdState({ card: askCard, needs: ok(read([again])), ledger: ok(noLedger) })).toMatchObject({
      phase: "superseded",
    });
  });

  test("an owner step reads by its work key and its flag's time; its Done is not a ledger verb, so it has no undo", () => {
    const rows = needsRead([yours]).rows;
    const row = rows[0] as NeedRow;
    const card: CardData = { kind: "owner_step", key: "work:w-yours", version: row.since };
    expect(holdState({ card, needs: ok({ ...needsRead([yours]) }), ledger: ok(noLedger) }).phase).toBe("open");
    expect(CARD_VERBS.owner_step).toEqual([]);
    expect(holdState({ card, needs: ok(needsRead([])), ledger: ok(noLedger) }).phase).toBe("resolved");
  });
});

describe("a finished card", () => {
  const landed = fakeWork(WORK, "review", worker, { landing: 4, permission: null });
  const card: CardData = { kind: "finished", key: `work:${WORK}`, version: "4" };
  const state = (item: WorkItem, ledger: Ledger = noLedger, host: string | null = AGENT) =>
    workState({ card, host, work: ok(item), ledger: ok(ledger) });

  test("open while the work is at the gate on this landing, in the session the card is in", () => {
    expect(state(landed)).toEqual({ phase: "open", row: null, item: landed });
  });

  test("a later run, or a session that is no longer the worker, makes it superseded with nothing to offer", () => {
    expect(state({ ...landed, landing: 6 })).toEqual({ phase: "superseded", words: SUPERSEDED });
    expect(state(landed, noLedger, OTHER_AGENT)).toEqual({ phase: "superseded", words: MOVED_ELSEWHERE });
    // A card of an earlier build with no landing reads as old, not as current.
    expect(
      workState({ card: { ...card, version: "" }, host: AGENT, work: ok(landed), ledger: ok(noLedger) }).phase,
    ).toBe("superseded");
  });

  test("asking permission now it is held: the approval's card has the verbs", () => {
    expect(state({ ...landed, permission })).toEqual({ phase: "held", words: HELD_ELSEWHERE });
  });

  test("Continue in its window is the undo state; once it took effect the work is back with the agent and it says so", () => {
    expect(
      state(landed, {
        ...noLedger,
        pending: [pending({ verb: "session.prompt", key: card.key, label: "Sent: continue" })],
      }).phase,
    ).toBe("undo");
    const back = state(
      { ...landed, state: "running" },
      { ...noLedger, recent: [settled({ verb: "session.prompt", key: card.key, label: "Sent: continue" })] },
    );
    expect(back).toMatchObject({ phase: "receipt", words: "Sent: continue · took effect" });
    // With no verb of yours, it says how it left.
    expect(state({ ...landed, state: "done", verdict: "Merged by the gates." })).toEqual({
      phase: "resolved",
      words: "Merged by the gates.",
    });
  });

  test("a work read that failed is unread", () => {
    expect(workState({ card, host: AGENT, work: failed("no such work"), ledger: ok(noLedger) }).phase).toBe("unread");
  });
});

describe("a health card", () => {
  const stuck = fakeWork(WORK, "blocked", worker, { reason: "Session ended mid-turn" });
  const card: CardData = { kind: "health", key: `work:${WORK}`, version: "5c3a99e1" };

  test("stuck work is open for as long as it is stuck, whichever raise made the card", () => {
    expect(workState({ card, host: AGENT, work: ok(stuck), ledger: ok(noLedger) }).phase).toBe("open");
    expect(
      workState({ card: { ...card, version: "other" }, host: AGENT, work: ok(stuck), ledger: ok(noLedger) }).phase,
    ).toBe("open");
  });

  test("Unblock in its window is the undo state; after it, the work is going again and the receipt says so", () => {
    const unblock = pending({ verb: "work.unblock", key: card.key, label: "Unblocked Work w" });
    expect(
      workState({ card, host: AGENT, work: ok(stuck), ledger: ok({ ...noLedger, pending: [unblock] }) }).phase,
    ).toBe("undo");
    const after = workState({
      card,
      host: AGENT,
      work: ok({ ...stuck, state: "running" }),
      ledger: ok({
        ...noLedger,
        recent: [settled({ verb: "work.unblock", key: card.key, label: "Unblocked Work w" })],
      }),
    });
    expect(after).toMatchObject({ phase: "receipt", words: "Unblocked Work w · took effect" });
  });

  test("a snooze of the stuck notice that took effect quiets the card for its four hours, not the work", () => {
    const quiet = settled({ verb: "notice.snooze", key: card.key, label: "Snoozed Work w for 4 h" });
    const at = Date.parse(quiet.settledAt);
    const state = (now: number, ledger: Ledger = { ...noLedger, recent: [quiet] }) =>
      workState({ card, host: AGENT, work: ok(stuck), ledger: ok(ledger), now });
    expect(state(at + 60_000)).toMatchObject({ phase: "receipt", words: "Snoozed Work w for 4 h · took effect" });
    // The notice comes back when the time is up, and the card with it.
    expect(state(at + 4 * 3_600_000 + 1).phase).toBe("open");
    // Its window is the undo state like any other verb's.
    const waiting = {
      ...noLedger,
      pending: [pending({ verb: "notice.snooze", key: card.key, label: "Snoozed Work w for 4 h" })],
    };
    expect(state(at, waiting).phase).toBe("undo");
  });

  test("cardState sends each kind to its own reading", () => {
    const needs = ok(needsRead([asking]));
    expect(cardState({ card, host: AGENT, needs, ledger: ok(noLedger), work: ok(stuck) }).phase).toBe("open");
    expect(cardState({ card: approvalCard, host: AGENT, needs, ledger: ok(noLedger), work: loading }).phase).toBe(
      "open",
    );
  });
});

describe("the verbs a card offers", () => {
  const states = (kind: CardData["kind"]) => cardVerbs(kind, null).map((verb) => verb.id);

  test("at most two verbs on every kind, and Approve is never one of them", () => {
    for (const kind of ["approval", "ask", "owner_step", "finished", "health", "digest"] as const) {
      expect(cardVerbs(kind, null).length).toBeLessThanOrEqual(2);
      expect(states(kind)).not.toContain("approve");
    }
    expect(states("approval")).toEqual(["allow", "deny"]);
    expect(states("health")).toEqual(["unblock", "snooze"]);
    expect(states("finished")).toEqual(["continue", "course"]);
    expect(states("digest")).toEqual([]);
  });

  test("an approval's primary names what it allows", () => {
    const merge = needsRead([
      fakeWork(WORK, "review", worker, { permission: { requestId: "r", title: "gh pr merge 933", detail: null } }),
    ]).rows[0] as NeedRow;
    expect(cardVerbs("approval", merge).find((verb) => verb.primary)?.label).toBe("Allow merge");
  });

  test("a verb the ledger does not hold for a kind is not its window: each kind answers for its own", () => {
    expect(CARD_VERBS.approval).toEqual(["approval.decide"]);
    expect(CARD_VERBS.ask).toEqual(["ask.answer"]);
    expect(CARD_VERBS.finished).toContain("session.prompt");
    expect(CARD_VERBS.health).toContain("work.unblock");
  });
});

describe("the inbox digest", () => {
  const rowsOf = (n: number): NeedRow[] =>
    needsRead(
      Array.from({ length: n }, (_, at) =>
        fakeWork(
          `w-${at}`,
          "review",
          { agentId: `${AGENT.slice(0, 28)}${String(at).padStart(8, "0")}`, workspaceId: null },
          { permission, landing: 2 },
        ),
      ),
    ).rows;
  const digest: CardData = { kind: "digest", key: `work:${WORK}`, version: "inbox-1" };
  const state = (n: number, work: Read<WorkItem> | null = null) =>
    digestOf({
      card: digest,
      needs: ok({ rows: rowsOf(n), summary: needsRead([]).summary }),
      work,
    });

  test("it says how many need you, names the first few and counts the rest", () => {
    const three = state(3);
    expect(three).toMatchObject({ phase: "rows", total: 3, words: "3 things need you", more: 0 });
    const five = state(5);
    expect(five).toMatchObject({ phase: "rows", total: 5, more: 5 - DIGEST_ROWS });
    expect(five.phase === "rows" && five.rows).toHaveLength(DIGEST_ROWS);
    expect(digestWords(1)).toBe("1 thing needs you");
    expect(digestWords(0)).toBe("Nothing needs you now");
  });

  test("each row opens its own session: the agent that asked", () => {
    const one = state(1);
    expect(one.phase === "rows" && one.rows[0]?.agentId).toMatch(/^6f1c2e0a-93b4-4d7e-8a15-2c9d/);
    expect(one.phase === "rows" && one.rows[0]?.agentId).not.toBe(CLAUDE_SESSION);
  });

  test("the landing it came with is listed first when it holds nothing, but never counted", () => {
    const landed = fakeWork(WORK, "review", worker, { landing: 4, permission: null });
    const named = state(0, ok(landed));
    expect(named).toMatchObject({ phase: "rows", total: 0, words: "Nothing needs you now" });
    expect(named.phase === "rows" && named.rows.map((row) => [row.kind, row.agentId])).toEqual([["finished", AGENT]]);
    // A landing that the work has gone on from is not listed.
    expect(
      state(0, ok({ ...landed, state: "running" })).phase === "rows" &&
        (state(0, ok({ ...landed, state: "running" })) as { rows: unknown[] }).rows,
    ).toEqual([]);
  });

  test("a needs read that failed is unread, never 'Nothing needs you now'", () => {
    const state = digestOf({ card: digest, needs: failed("socket closed"), work: null });
    expect(state).toEqual({ phase: "unread", words: "Couldn't read what needs you: socket closed" });
  });
});

describe("Open in Maestro", () => {
  test("a card in a session opens that session's page; a hold that names a session opens it; with none, the hold", () => {
    const row = needsRead([asking]).rows[0] as NeedRow;
    expect(openTarget(approvalCard, AGENT, row, null)).toEqual({ to: "session", agentId: AGENT });
    expect(openTarget(approvalCard, null, row, null)).toEqual({ to: "session", agentId: AGENT });
    expect(openTarget({ ...approvalCard, key: "work:w-x" }, null, null, null)).toEqual({ to: "hold", key: "work:w-x" });
    const tracked = fakeWork(WORK, "blocked", { agentId: OTHER_AGENT, workspaceId: null });
    expect(openTarget({ ...approvalCard, kind: "health" }, null, null, tracked)).toEqual({
      to: "session",
      agentId: OTHER_AGENT,
    });
  });
});

describe("resolution words and liveness", () => {
  test("how work left, in a sentence", () => {
    expect(resolution({ state: "done", verdict: null, reason: null })).toBe("Closed.");
    expect(resolution({ state: "canceled", verdict: "Canceled by you.", reason: null })).toBe("Canceled by you.");
    expect(resolution({ state: "blocked", verdict: null, reason: null })).toBe("The run stopped without a reason.");
    expect(resolution({ state: "running", verdict: null, reason: null })).toContain("Back with the agent");
  });

  test("a card that has settled stops asking; one that can still change keeps reading", () => {
    const live: CardState[] = [
      { phase: "loading" },
      { phase: "unread", words: "x" },
      { phase: "open", row: null, item: null },
    ];
    for (const state of live) expect(cardLive(state)).toBe(true);
    const settledStates: CardState[] = [
      { phase: "receipt", words: "x", at: "", tone: "ok" },
      { phase: "resolved", words: "x" },
      { phase: "superseded", words: "x" },
      { phase: "held", words: "x" },
    ];
    for (const state of settledStates) expect(cardLive(state)).toBe(false);
  });
});
