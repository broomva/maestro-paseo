import { describe, expect, test } from "bun:test";
import { fakeWork } from "./fake-work";
import { gateMode, resolution } from "./gate-state";

const permission = { requestId: "p1", title: "Run a command", detail: null };

describe("the gate card", () => {
  test("offers the verdict while the work waits on you, the answer while it asks, and nothing once it has left", () => {
    expect(gateMode(fakeWork("w", "review"))).toBe("deciding");
    expect(gateMode(fakeWork("w", "review", null, { permission }))).toBe("asking");
    for (const state of ["running", "blocked", "done", "canceled", "proposed"] as const) {
      expect(gateMode(fakeWork("w", state))).toBe("resolved");
    }
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
