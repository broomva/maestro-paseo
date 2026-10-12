import { describe, expect, test } from "bun:test";
import type { NeedRow } from "../shared/needs";
import { fakeWork } from "./fake-work";
import { decideApproval, planVerb, promptSession, receiptOf } from "./verbs";

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

  test("a permission prompt is answered on the session, by the request id the row shows", () => {
    const item = fakeWork("w1", "review", live);
    item.permission = { requestId: REQ } as never;
    expect(decideApproval(permission(REQ), item, true)).toMatchObject({
      call: "permission",
      agentId: AGENT,
      requestId: REQ,
      allow: true,
    });
    expect(decideApproval(permission(REQ), item, false)).toMatchObject({ call: "permission", allow: false });
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
    expect(decideApproval(permission(REQ), null, true)).toMatchObject({ call: "permission", requestId: REQ });
  });

  test("a hold at Maestro's gate is a verdict: Allow approves, Deny sends it back", () => {
    expect(decideApproval(approval("gate"), null, true)).toMatchObject({ call: "verdict", verdict: "approve" });
    expect(decideApproval(approval("gate"), null, false)).toMatchObject({ call: "verdict", verdict: "revise" });
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

  test("snooze and continue say which ticket brings them", () => {
    expect(planVerb("snooze", {})).toMatchObject({ call: "unavailable", why: expect.stringContaining("BRO-3036") });
    expect(promptSession("work:w1", "Continue")).toMatchObject({ call: "unavailable" });
  });
});

describe("receipts", () => {
  test("a receipt names its channel; an unknown channel or an empty value is no receipt", () => {
    expect(receiptOf("work:w1")).toEqual({ channel: "work", value: "w1" });
    expect(receiptOf("conductor:a:b")).toEqual({ channel: "conductor", value: "a:b" });
    expect(receiptOf("nope:x")).toBeNull();
    expect(receiptOf("work:")).toBeNull();
    expect(receiptOf("work")).toBeNull();
  });
});
