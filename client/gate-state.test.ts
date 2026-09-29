import { describe, expect, test } from "bun:test";
import { GateCardSchema } from "../shared/gate-card";
import { fakeWork } from "./fake-work";
import { answerTarget, cardSettled, cardView, resolution } from "./gate-state";

const permission = { requestId: "p1", title: "Run a command", detail: null };
const card = { landing: 4, agentId: "a1" };
const inSessionA = { agentId: "a1", workspaceId: "ws1" };
const inSessionB = { agentId: "b1", workspaceId: "ws1" };

describe("the gate card", () => {
  test("the current card offers the verdict while the work waits, the answer while it asks, nothing after", () => {
    expect(cardView(card, fakeWork("w", "review", inSessionA, { landing: 4 }))).toBe("deciding");
    expect(cardView(card, fakeWork("w", "review", inSessionA, { landing: 4, permission }))).toBe("asking");
    for (const state of ["running", "blocked", "done", "canceled"] as const) {
      expect(cardView(card, fakeWork("w", state, inSessionA, { landing: 4 }))).toBe("resolved");
    }
  });

  test("a card for an earlier landing is superseded, even while the work waits on you again", () => {
    expect(cardView(card, fakeWork("w", "review", inSessionA, { landing: 9 }))).toBe("superseded");
    expect(cardView(card, fakeWork("w", "review", inSessionA, { landing: 9, permission }))).toBe("superseded");
    expect(cardView(card, fakeWork("w", "done", inSessionA, { landing: 9 }))).toBe("superseded");
    expect(cardView(card, fakeWork("w", "review", inSessionA))).toBe("superseded");
  });

  test("a card left in a session the work has moved away from is superseded", () => {
    expect(cardView(card, fakeWork("w", "review", inSessionB, { landing: 4 }))).toBe("superseded");
    expect(cardView(card, fakeWork("w", "review", null, { landing: 4 }))).toBe("superseded");
  });

  test("a question is answered only in the card's own session, and only while it is still the worker", () => {
    expect(answerTarget(card, fakeWork("w", "review", inSessionA, { landing: 4, permission }))).toBe("a1");
    expect(answerTarget(card, fakeWork("w", "review", inSessionB, { landing: 4, permission }))).toBeNull();
    expect(answerTarget(card, fakeWork("w", "review", inSessionA, { landing: 9, permission }))).toBeNull();
    expect(answerTarget(card, fakeWork("w", "review", inSessionA, { landing: 4 }))).toBeNull();
  });

  test("a card stops changing once superseded or once its work is finished, and only then", () => {
    expect(cardSettled(card, fakeWork("w", "review", inSessionA, { landing: 9 }))).toBe(true);
    expect(cardSettled(card, fakeWork("w", "review", inSessionB, { landing: 4 }))).toBe(true);
    expect(cardSettled(card, fakeWork("w", "done", inSessionA, { landing: 4 }))).toBe(true);
    expect(cardSettled(card, fakeWork("w", "canceled", inSessionA, { landing: 4 }))).toBe(true);
    expect(cardSettled(card, fakeWork("w", "review", inSessionA, { landing: 4 }))).toBe(false);
    expect(cardSettled(card, fakeWork("w", "running", inSessionA, { landing: 4 }))).toBe(false);
    expect(cardSettled(card, fakeWork("w", "blocked", inSessionA, { landing: 4 }))).toBe(false);
  });

  test("a card written before landings were recorded parses, reads as superseded and answers nothing", () => {
    const legacy = GateCardSchema.parse({ workId: "w1" });
    const waiting = {
      state: "review",
      permission: { requestId: "r", title: "Bash", detail: null },
      landing: undefined,
      worker: null,
    } as const;
    expect(cardView(legacy, waiting as never)).toBe("superseded");
    expect(answerTarget(legacy, waiting as never)).toBeNull();
  });

  test("says how the work left the gate", () => {
    expect(resolution(fakeWork("w", "done", null, { verdict: "You approved" }))).toBe("You approved");
    expect(resolution(fakeWork("w", "canceled", null, { verdict: "You canceled it" }))).toBe("You canceled it");
    expect(resolution(fakeWork("w", "blocked", null, { reason: "Could not reach the session" }))).toBe(
      "Could not reach the session",
    );
    expect(resolution(fakeWork("w", "running"))).toBe("Back with the agent. A new card lands here when the run ends.");
    expect(resolution(fakeWork("w", "done"))).toBe("Closed.");
  });
});
