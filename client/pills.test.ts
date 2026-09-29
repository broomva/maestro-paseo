import { describe, expect, test } from "bun:test";
import type { Attention } from "../shared/contracts";
import type { OrchState } from "../shared/states";
import { pillFace, pillLabel, pillSpecs } from "./pills";

const session = (workId: string, state: OrchState, agentId: string, workspaceId: string | null) =>
  ({ workId, title: `Work ${workId}`, state, agentId, workspaceId }) satisfies Attention["sessions"][number];

describe("the composer pill", () => {
  test("each listed session gets one, keyed by workspace and agent", () => {
    const specs = pillSpecs([session("w1", "review", "a1", "ws1"), session("w3", "running", "a3", "ws1")]);
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
    expect(pillSpecs([session("w1", "running", "a1", null)]).size).toBe(0);
  });

  test("when two items name one session, the first listed (attention first) wins", () => {
    const specs = pillSpecs([session("needs", "review", "a1", "ws1"), session("older", "done", "a1", "ws1")]);
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
