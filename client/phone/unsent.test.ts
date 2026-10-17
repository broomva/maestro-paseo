// BRO-3180 C: what became of an answer that got no reply, from fresh reads only (client/phone/unsent.ts).
import { describe, expect, test } from "bun:test";
import type { DecisionAsk } from "../../shared/fleet";
import { askHoldKey } from "../../shared/needs";
import type { PendingVerb, SettledVerb } from "../../shared/verbs";
import { askRefOf, draftKey, sweepDrafts } from "./resume";
import { fateOf, gotNoReply, isSettled, SKEW_MS, settledText, type Unsent, unsentLine } from "./unsent";

const AT = Date.parse("2026-10-17T12:00:00Z");
const home = { kind: "main" as const, path: "/Users/me/broomva", branch: null };
const ask = (extra: Partial<DecisionAsk> = {}) =>
  ({ ledger: "l.yaml", uid: "u1", id: "A1", hash: "h1", state: "open", home, ...extra }) as DecisionAsk;
const unsent: Unsent = { at: AT, hash: "h1", key: askHoldKey(ask()), error: "Transport not connected" };
const pendingVerb = (extra: Partial<PendingVerb> = {}): PendingVerb => ({
  receipt: "r1",
  verb: "ask.answer",
  key: unsent.key,
  label: "Answered",
  at: new Date(AT + 1_000).toISOString(),
  appliesAt: new Date(AT + 9_000).toISOString(),
  remainingMs: 5_000,
  ...extra,
});
const settledVerb = (outcome: SettledVerb["outcome"], extra: Partial<SettledVerb> = {}): SettledVerb => ({
  receipt: "r1",
  verb: "ask.answer",
  key: unsent.key,
  label: "Answered",
  at: new Date(AT + 1_000).toISOString(),
  settledAt: new Date(AT + 9_000).toISOString(),
  outcome,
  detail: "",
  ...extra,
});
const none = { pending: [], recent: [] };

describe("what counts as no reply", () => {
  test("the transport's own failures got no reply", () => {
    for (const text of [
      "Transport not connected (status: disconnected)",
      "Timed out waiting for connection to send message",
      "Connection lost before message could be sent",
      "Connection lost",
    ])
      expect(gotNoReply(new Error(text))).toBe(true);
  });
  test("a server refusal is a reply, by its requestType or its message", () => {
    expect(gotNoReply(Object.assign(new Error("stale"), { requestType: "plugin.rpc.invoke.request" }))).toBe(false);
    expect(gotNoReply(new Error("stale requestType=plugin.rpc.invoke.request code=x"))).toBe(false);
    expect(gotNoReply(Object.assign(new Error("bad input"), { name: "ZodError" }))).toBe(false);
  });
});

describe("the fate of an unsent answer", () => {
  test("no fresh verbs.list concludes nothing", () => {
    expect(fateOf(unsent, ask(), null)).toEqual({ kind: "unknown" });
  });
  test("a pending verb on its key: it reached the Mac", () => {
    expect(fateOf(unsent, ask(), { pending: [pendingVerb()], recent: [] })).toEqual({
      kind: "pending",
      remainingMs: 5_000,
    });
  });
  test("an applied verb: it went through, even with the ask missing from the read", () => {
    expect(fateOf(unsent, undefined, { pending: [], recent: [settledVerb("applied")] })).toEqual({ kind: "applied" });
  });
  test("undone or dropped, on the same revision: offered again", () => {
    for (const outcome of ["undone", "dropped"] as const)
      expect(fateOf(unsent, ask(), { pending: [], recent: [settledVerb(outcome)] })).toEqual({ kind: "undone" });
  });
  test("undone on a changed ask is still 'changed' (two taps)", () => {
    expect(fateOf(unsent, ask({ hash: "h2" }), { pending: [], recent: [settledVerb("dropped")] })).toEqual({
      kind: "changed",
    });
  });
  test("no verb, open, same hash: not sent; changed hash: changed; closed: closed", () => {
    expect(fateOf(unsent, ask(), none)).toEqual({ kind: "not-sent" });
    expect(fateOf(unsent, ask({ hash: "h2" }), none)).toEqual({ kind: "changed" });
    expect(fateOf(unsent, ask({ state: "answered" }), none)).toEqual({ kind: "closed" });
  });
  test("absence from the read concludes nothing", () => {
    expect(fateOf(unsent, undefined, none)).toEqual({ kind: "unknown" });
  });
  test("a verb from before the send, past the skew, or on another key, is not this answer's", () => {
    const early = new Date(AT - SKEW_MS - 1).toISOString();
    expect(fateOf(unsent, ask(), { pending: [pendingVerb({ at: early })], recent: [] })).toEqual({ kind: "not-sent" });
    expect(fateOf(unsent, ask(), { pending: [pendingVerb({ key: "ask:other" })], recent: [] })).toEqual({
      kind: "not-sent",
    });
    expect(fateOf(unsent, ask(), { pending: [pendingVerb({ verb: "work.verdict" })], recent: [] })).toEqual({
      kind: "not-sent",
    });
  });
  test("within the skew, a verb stamped a little before the phone's send is this answer's", () => {
    const skewed = new Date(AT - SKEW_MS + 1_000).toISOString();
    expect(fateOf(unsent, ask(), { pending: [pendingVerb({ at: skewed })], recent: [] }).kind).toBe("pending");
  });
});

describe("what is said", () => {
  test("spent fates are said once and leave no line; the rest keep a line", () => {
    for (const fate of [{ kind: "pending", remainingMs: 3_000 }, { kind: "applied" }, { kind: "closed" }] as const) {
      expect(isSettled(fate)).toBe(true);
      expect(unsentLine(fate)).toBeNull();
      expect(settledText(fate, "T")).toBeTruthy();
    }
    for (const fate of [{ kind: "undone" }, { kind: "not-sent" }, { kind: "changed" }, { kind: "unknown" }] as const) {
      expect(isSettled(fate)).toBe(false);
      expect(unsentLine(fate)).toBeTruthy();
      expect(settledText(fate, "T")).toBeNull();
    }
  });
  test("a match is 'an answer', never 'your answer': verbs.list does not say who sent it", () => {
    expect(settledText({ kind: "applied" }, "T")).toStartWith("An answer");
  });
});

test("B's sweep leaves a draft carrying an unsent answer to the resolution, even on a closed ask", () => {
  const ref = askRefOf(ask());
  const draft = { ask: ref, hash: "h1", chosen: "off", words: "", at: AT, unsent };
  const read = { asks: [ask({ state: "answered" })], fresh: true, warnings: 0 };
  expect(sweepDrafts({ [draftKey(ref)]: draft }, read, AT + 1_000)[draftKey(ref)]).toEqual(draft);
  const { unsent: _spent, ...plain } = draft;
  expect(sweepDrafts({ [draftKey(ref)]: plain }, read, AT + 1_000)[draftKey(ref)]).toBeUndefined();
});
