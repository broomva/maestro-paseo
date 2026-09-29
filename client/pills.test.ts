import { describe, expect, test } from "bun:test";
import { fakeWork } from "./fake-work";
import { pillFace, pillLabel, pillSpecs } from "./pills";

describe("the composer pill", () => {
  test("only sessions that are some work's worker get one, keyed by workspace and agent", () => {
    const specs = pillSpecs([
      fakeWork("w1", "review", { agentId: "a1", workspaceId: "ws1" }),
      fakeWork("w2", "proposed"),
      fakeWork("w3", "running", { agentId: "a3", workspaceId: "ws1" }),
    ]);
    expect([...specs.keys()]).toEqual(["ws1/a1", "ws1/a3"]);
    expect(specs.get("ws1/a1")).toEqual({
      workspaceId: "ws1",
      agentId: "a1",
      workId: "w1",
      state: "review",
      title: "Work w1",
    });
  });

  test("a session with no known workspace gets none", () => {
    expect(pillSpecs([fakeWork("w1", "running", { agentId: "a1", workspaceId: null })]).size).toBe(0);
  });

  test("when two items name one session, the first listed (attention first) wins", () => {
    const specs = pillSpecs([
      fakeWork("needs", "review", { agentId: "a1", workspaceId: "ws1" }),
      fakeWork("older", "done", { agentId: "a1", workspaceId: "ws1" }),
    ]);
    expect(specs.get("ws1/a1")?.workId).toBe("needs");
  });

  test("is labelled in plain voice, and canceled work is not called done", () => {
    expect(pillLabel("review")).toBe("Needs you");
    expect(pillLabel("running")).toBe("Running");
    expect(pillLabel("blocked")).toBe("Stuck");
    expect(pillLabel("triggered")).toBe("Queued");
    expect(pillLabel("done")).toBe("Done");
    expect(pillLabel("canceled")).toBe("Canceled");
    expect(
      pillFace({ workspaceId: "ws1", agentId: "a1", workId: "w1", state: "blocked", title: "Fix the flaky test" }),
    ).toEqual({ title: "Maestro: Fix the flaky test", label: "Stuck" });
  });
});
