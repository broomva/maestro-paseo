import { describe, expect, test } from "bun:test";
import { groupOf, IllegalTransitionError, landingState, ORCH_STATES, transition, verdictTarget } from "./states";

describe("transition", () => {
  test("gated work reaches done only through an approve verdict", () => {
    expect(transition("review", "done", { gate: "human", verdict: "approve" })).toBe("done");
    // An arc that reported itself finished and was archived closes gated work too; nothing else does.
    expect(transition("review", "done", { gate: "human", arcFinished: true })).toBe("done");
    expect(() => transition("review", "done", { gate: "human" })).toThrow(IllegalTransitionError);
    expect(() => transition("review", "done", { gate: "human", verdict: "revise" })).toThrow(IllegalTransitionError);
    expect(() => transition("review", "done", { gate: "human" })).toThrow(IllegalTransitionError);
    expect(() => transition("review", "done", { gate: "human", verdict: "revise" })).toThrow(IllegalTransitionError);
  });

  test("a run closes itself only under gate:auto with passing checks", () => {
    expect(transition("running", "done", { gate: "auto", checksPassed: true })).toBe("done");
    expect(() => transition("running", "done", { gate: "human", checksPassed: true })).toThrow(IllegalTransitionError);
    expect(() => transition("running", "done", { gate: "auto", checksPassed: false })).toThrow(IllegalTransitionError);
    expect(() => transition("running", "done", { gate: "auto" })).toThrow(IllegalTransitionError);
  });

  test("terminal states have no way out", () => {
    for (const to of ORCH_STATES) {
      expect(() => transition("done", to, { gate: "human", verdict: "approve" })).toThrow(IllegalTransitionError);
      expect(() => transition("canceled", to, { gate: "human" })).toThrow(IllegalTransitionError);
    }
  });

  test("running work cannot be canceled directly", () => {
    expect(() => transition("running", "canceled", { gate: "human" })).toThrow(IllegalTransitionError);
  });
});

describe("landingState", () => {
  test("human gate always lands at review, whatever the checks say", () => {
    expect(landingState("human", "passed")).toBe("review");
    expect(landingState("human", "failed")).toBe("review");
    expect(landingState("human", "none")).toBe("review");
  });

  test("auto gate follows the checks, and never closes without one", () => {
    expect(landingState("auto", "passed")).toBe("done");
    expect(landingState("auto", "failed")).toBe("blocked");
    expect(landingState("auto", "none")).toBe("review");
  });
});

test("verdicts and groups", () => {
  expect(verdictTarget("approve")).toBe("done");
  expect(verdictTarget("revise")).toBe("running");
  expect(verdictTarget("block")).toBe("canceled");
  expect(groupOf("triggered")).toBe("queued");
  expect(groupOf("canceled")).toBe("done");
  expect(groupOf("review")).toBe("review");
});
