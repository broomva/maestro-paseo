import { describe, expect, test } from "bun:test";
import type { DecisionAsk } from "../shared/fleet";
import { askHoldKey, type NeedRow } from "../shared/needs";
import { fakeWork } from "./fake-work";
import { decideApproval, planVerb, promptSession, receiptOf, settleDelay } from "./verbs";

const live = { agentId: "agent-9", workspaceId: "ws1" };
const base = { title: "T", scope: "broomva", since: "2026-10-12T10:00:00.000Z", blocksWork: true };

const approval = (heldBy: string, id = "w1"): Extract<NeedRow, { kind: "approval" }> => ({
  ...base,
  key: `work:${id}`,
  kind: "approval",
  verbs: ["deny", "allow"],
  body: { action: "gh pr merge 1", heldBy, evidence: [], after: [] },
});
const step = (key: string, where: string): Extract<NeedRow, { kind: "owner_step" }> => ({
  ...base,
  key,
  kind: "owner_step",
  verbs: ["later", "done"],
  body: { where, doneCheck: "checked", waitingSessions: 0 },
});

// Real-shaped ids: a Paseo agent id, a permission request id, and a work id are three different things.
const AGENT = "d3c2a1b0-7a54-4e0f-9b1e-5f6a7b8c9d01";
const REQ = "perm_01JABCDEF123456789XYZ";

describe("approvals go through decideApproval", () => {
  const permission = (requestId: string | undefined): Extract<NeedRow, { kind: "approval" }> => ({
    ...approval("permission"),
    session: { agentId: AGENT, name: "d3c2a1b0", waiting: true },
    body: { action: "Bash: ls", heldBy: "permission", ...(requestId ? { requestId } : {}), evidence: [], after: [] },
  });

  test("a permission prompt is approval.decide on the row's key, its exact action and the request id it shows", () => {
    const item = fakeWork("w1", "review", live);
    item.permission = { requestId: REQ } as never;
    expect(decideApproval(permission(REQ), item, true)).toEqual({
      call: "decide",
      key: "work:w1",
      allow: true,
      action: "Bash: ls",
      requestId: REQ,
      done: "Allowed",
    });
    expect(decideApproval(permission(REQ), item, false)).toMatchObject({
      call: "decide",
      allow: false,
      done: "Denied",
    });
  });

  test("a session that raised another prompt since the row was read is not approved: nothing is answered", () => {
    const item = fakeWork("w1", "review", live);
    item.permission = { requestId: "perm_01JNEWDANGEROUS000000", detail: "DANGEROUS-UNSEEN" } as never;
    const plan = decideApproval(permission(REQ), item, true);
    expect(plan.call).toBe("stale");
    expect(JSON.stringify(plan)).not.toContain("DANGEROUS");
    // The prompt cleared while the card was open: stale too, never an answer to a request that is gone.
    const cleared = fakeWork("w1", "review", live);
    expect(decideApproval(permission(REQ), cleared, true).call).toBe("stale");
  });

  test("a row from a daemon that names no request id opens the item instead of guessing one", () => {
    const item = fakeWork("w1", "review", live);
    item.permission = { requestId: REQ } as never;
    expect(decideApproval(permission(undefined), item, true)).toMatchObject({
      call: "go",
      intent: { kind: "select", id: "w1" },
    });
  });

  test("a prompt this client has not read as work still answers the prompt the row shows", () => {
    expect(decideApproval(permission(REQ), null, true)).toMatchObject({ call: "decide", requestId: REQ });
  });

  test("an action an agent asked leave for is decided by its own key; work is never approved", () => {
    const request = { ...approval("gate"), key: "approval:5d1f0c2e9a7b4c3d" };
    expect(decideApproval(request, null, true)).toEqual({
      call: "decide",
      key: "approval:5d1f0c2e9a7b4c3d",
      allow: true,
      action: "gh pr merge 1",
      done: "Allowed",
    });
    // No plan approves work: Allow never becomes a verdict.
    for (const plan of [decideApproval(request, null, true), decideApproval(permission(REQ), null, false)]) {
      expect(JSON.stringify(plan)).not.toContain("approve");
      expect(plan.call).not.toBe("verdict");
    }
    // A key of no hold has nothing to allow.
    expect(decideApproval({ ...approval("gate"), key: "ask:x" }, null, true).call).toBe("unavailable");
  });

  test("allow and deny on anything but an approval do nothing", () => {
    expect(planVerb("allow", { row: step("work:w1", "x") }).call).toBe("unavailable");
    expect(planVerb("deny", {}).call).toBe("unavailable");
  });
});

describe("the other verbs", () => {
  test("an owner step on work starts it; one with a PR opens the PR; else Decisions", () => {
    expect(planVerb("done", { row: step("work:w1", "x") })).toMatchObject({ call: "dispatch", id: "w1" });
    expect(planVerb("done", { row: step("answers:batch", "https://github.com/a/b/pull/1") })).toMatchObject({
      call: "url",
      url: "https://github.com/a/b/pull/1",
    });
    expect(planVerb("done", { row: step("answers:batch", "the console") })).toMatchObject({ call: "go" });
  });

  test("skip and not now leave the hold where it is", () => {
    expect(planVerb("skip", {}).call).toBe("stay");
    expect(planVerb("later", {}).call).toBe("stay");
  });

  test("open prefers the session, then the item", () => {
    const item = fakeWork("w1", "running", live);
    expect(planVerb("open", { item })).toMatchObject({ call: "session", agentId: "agent-9" });
    expect(planVerb("open", { item: { ...item, worker: undefined } as never })).toMatchObject({ call: "go" });
    expect(planVerb("open", {}).call).toBe("unavailable");
  });

  test("unblock only stuck work; cancel any work", () => {
    expect(planVerb("unblock", { item: fakeWork("w1", "running", live) }).call).toBe("unavailable");
    expect(planVerb("cancel", { item: fakeWork("w1", "running", live) })).toMatchObject({ call: "cancel", id: "w1" });
  });

  test("file and dismiss take a proposal's conductor key", () => {
    expect(planVerb("file", { proposal: "k1" })).toMatchObject({ call: "conductor", key: "k1", verb: "file" });
    expect(planVerb("dismiss", { proposal: "k1" })).toMatchObject({ verb: "dismiss" });
    expect(planVerb("file", {}).call).toBe("unavailable");
  });

  test("snooze quiets a notice for four hours, with its receipt; anything else is not snoozed", () => {
    expect(planVerb("snooze", { notice: { key: "work:q1" } })).toMatchObject({
      call: "snooze",
      key: "work:q1",
      done: "Snoozed for 4 h",
    });
    expect(planVerb("snooze", {}).call).toBe("unavailable");
  });

  test("continue prompts the work's session (session.prompt), and a work with no session has nothing to prompt", () => {
    const item = fakeWork("w1", "review", live);
    expect(planVerb("continue", { item })).toMatchObject({
      call: "prompt",
      agentId: "agent-9",
      key: "work:w1",
      prompt: expect.stringContaining("Continue where you stopped"),
    });
    expect(planVerb("continue", {})).toMatchObject({ call: "unavailable" });
    expect(promptSession(null, "work:w1", "Continue")).toMatchObject({ call: "unavailable" });
    expect(promptSession("agent-9", "work:w1", "Continue")).toMatchObject({ call: "prompt", agentId: "agent-9" });
  });
});

describe("receipts", () => {
  test("a receipt names its channel; an unknown channel or an empty value is no receipt", () => {
    expect(receiptOf("work:w1")).toEqual({ channel: "work", value: "w1" });
    expect(receiptOf("conductor:a:b")).toEqual({ channel: "conductor", value: "a:b" });
    // The server's ledger (and a decision at the gate): verb.undo takes it by the receipt.
    expect(receiptOf("verb:0f3c1d2e-7a54-4e0f-9b1e-5f6a7b8c9d01")).toEqual({
      channel: "verb",
      value: "0f3c1d2e-7a54-4e0f-9b1e-5f6a7b8c9d01",
    });
    expect(receiptOf("nope:x")).toBeNull();
    expect(receiptOf("work:")).toBeNull();
    expect(receiptOf("work")).toBeNull();
  });
});

describe("when a verb's effect can be read", () => {
  test("a beat after its window closes, never before, and never for a verb with no window", () => {
    const now = Date.parse("2026-10-12T09:00:00.000Z");
    expect(settleDelay("2026-10-12T09:00:08.000Z", now)).toBe(8700);
    expect(settleDelay("2026-10-12T09:00:03.000Z", now + 1000)).toBe(2700);
    // Already past: read at once (a beat after).
    expect(settleDelay("2026-10-12T08:59:00.000Z", now)).toBe(700);
    expect(settleDelay(undefined, now)).toBeNull();
    expect(settleDelay("not a time", now)).toBeNull();
  });
});

describe("an answer carries your words (J3), a prompt goes with Unblock (J4)", () => {
  const decision: DecisionAsk = {
    ledger: "claude-code-mods.yaml",
    uid: "u-1",
    id: "A3",
    hash: "0123456789abcdef",
    arc: null,
    headline: "Install the mods?",
    question: null,
    stakes: null,
    whyYou: null,
    options: [
      { id: "off", label: "Keep them off", consequence: null, reversible: true, recommended: true },
      { id: "all", label: "Install fleet-wide", consequence: null, reversible: false, recommended: false },
    ],
    fallback: null,
    blocking: true,
    askedAt: null,
    answeredAt: null,
    answer: null,
    answerOption: null,
    state: "open",
    origin: null,
    refusal: null,
    home: { kind: "main", path: "/ctl", branch: null },
    batched: false,
    waiting: true,
  };
  const row: Extract<NeedRow, { kind: "ask" }> = {
    ...base,
    key: askHoldKey(decision),
    kind: "ask",
    verbs: ["answer", "skip"],
    body: { why: "", cost: "", options: [], goesTo: "origin/main" },
  };

  test("an option and your words are one answer, the words trimmed", () => {
    expect(planVerb("answer", { row, ask: decision }, "off", "  after the release \n")).toMatchObject({
      call: "answer",
      option: "off",
      note: "after the release",
      done: "Answered: Keep them off",
    });
  });

  test("your words alone are an answer too: no option is claimed for them", () => {
    expect(planVerb("answer", { row, ask: decision }, undefined, "same vendor for now")).toMatchObject({
      call: "answer",
      option: null,
      note: "same vendor for now",
      done: "Answered in your words",
    });
  });

  test("nothing chosen and nothing said opens Decisions: no empty answer is ever sent", () => {
    for (const words of ["", "   "])
      expect(planVerb("answer", { row, ask: decision }, undefined, words)).toMatchObject({ call: "go" });
    expect(planVerb("answer", { row, ask: decision }, "missing", "")).toMatchObject({ call: "go" });
  });

  test("an option that cannot be undone takes Decisions' deliberate confirm, with or without words", () => {
    expect(planVerb("answer", { row, ask: decision }, "all", "yes")).toMatchObject({ call: "go" });
  });

  test("what you chose and typed goes to Decisions with the answer it confirms, never lost on the way", () => {
    expect(planVerb("answer", { row, ask: decision }, "all", " the whole fleet ")).toMatchObject({
      call: "go",
      draft: { chosen: "all", note: "the whole fleet" },
    });
    // Nothing chosen and nothing said carries nothing; neither does an ask this client has not read.
    expect(planVerb("answer", { row, ask: decision }, undefined, "")).not.toHaveProperty("draft");
    expect(planVerb("answer", { row }, "off", "x")).not.toHaveProperty("draft");
  });

  test("an answer with no ask this client has read opens Decisions: it never guesses the ledger", () => {
    expect(planVerb("answer", { row }, "off", "x")).toMatchObject({ call: "go" });
  });

  test("Unblock sends the prompt you typed into the session, trimmed", () => {
    const stuck = fakeWork("w1", "blocked", live);
    expect(planVerb("unblock", { item: stuck }, undefined, " retry with --force ")).toMatchObject({
      call: "unblock",
      id: "w1",
      note: "retry with --force",
    });
    expect(planVerb("unblock", { item: stuck })).toMatchObject({ call: "unblock", note: "" });
  });
});

describe("a due initiative review is answered through the adapter (B2, J8)", () => {
  const reviewRow: Extract<NeedRow, { kind: "ask" }> = {
    ...base,
    key: "review:skene",
    kind: "ask",
    verbs: ["answer", "skip"],
    body: {
      why: "Its review date, 2026-10-07, has passed.",
      cost: "",
      options: [],
      goesTo: ".control/initiatives/skene.yaml",
      initiative: "skene",
      date: "2026-10-07",
      intent: "an agentic workspace",
      since: [],
      hanging: { work: 3, asks: 1 },
    },
  };

  test("keep, park and close are the review's answer, for the date you read, with your words", () => {
    for (const answer of ["keep", "park", "close"] as const)
      expect(planVerb("answer", { row: reviewRow }, answer, " next week ")).toMatchObject({
        call: "review",
        id: "skene",
        date: "2026-10-07",
        answer,
        note: "next week",
      });
  });

  test("with nothing chosen, or an answer that is not one of the three, it opens Initiatives instead of guessing", () => {
    expect(planVerb("answer", { row: reviewRow })).toMatchObject({ call: "go", intent: { kind: "initiatives" } });
    expect(planVerb("answer", { row: reviewRow }, "develop")).toMatchObject({ call: "go" });
  });
});
