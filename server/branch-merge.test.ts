import { describe, expect, test } from "bun:test";
import { IllegalTransitionError, transition } from "../shared/states";
import { branchMerged, MERGED_EVERY_MS, mergedPrs, repoOf } from "./branch-merge";
import type { WorkEvent } from "./events";

const bind = (branch: string | null): WorkEvent =>
  ({
    ts: "2026-10-08T00:00:00Z",
    type: "adopted",
    actor: "agent",
    agentId: "a",
    workspaceId: null,
    provider: "claude",
    branch,
    cwd: "/w",
    remote: "https://github.com/acme/app.git",
  }) as WorkEvent;
const blocked = (reason: string): WorkEvent =>
  ({
    ts: "2026-10-08T01:00:00Z",
    type: "state",
    actor: "maestro",
    from: "running",
    to: "blocked",
    reason,
  }) as WorkEvent;
const ENDED = "The session was archived before it finished";
const PR = { number: 9, mergedAt: "2026-10-08T00:30:00Z" };

describe("the evidence a branch merged", () => {
  test("repoOf reads GitHub https and ssh remotes, and nothing else", () => {
    expect(
      [
        "https://github.com/acme/app.git",
        "git@github.com:acme/app.git",
        "https://github.com/acme/app",
        "https://gitlab.com/acme/app.git",
        null,
      ].map(repoOf),
    ).toEqual(["acme/app", "acme/app", "acme/app", null, null]);
  });

  test("it closes only work its session left unfinished, untouched since, with a branch merged after the bind", () => {
    const base = [bind("feature/x"), blocked(ENDED)];
    expect(branchMerged(base, PR)).toEqual({ branch: "feature/x", number: 9 });
    expect(branchMerged([bind("feature/x"), blocked("rate limited")], PR)).toBeNull();
    expect(branchMerged([bind(null), blocked(ENDED)], PR)).toBeNull();
    expect(branchMerged(base, { number: 9, mergedAt: "2026-10-07T23:00:00Z" })).toBeNull();
    expect(branchMerged(base, null)).toBeNull();
    const touched = [...base, { ts: "2026-10-08T02:00:00Z", type: "note", actor: "human", text: "mine" } as WorkEvent];
    expect(branchMerged(touched, PR)).toBeNull();
  });

  /** A gh double: merged PRs by head branch, and the branches some PR targets as its base. */
  const gh = (merged: Record<string, unknown[]>, bases: string[]) => {
    const calls: string[][] = [];
    const run = async (args: readonly string[]) => {
      calls.push([...args]);
      const at = (flag: string) => args[args.indexOf(flag) + 1] ?? "";
      if (args.includes("--base")) return JSON.stringify(bases.includes(at("--base")) ? [{ number: 1 }] : []);
      return JSON.stringify(merged[at("--head")] ?? []);
    };
    return { run, calls };
  };

  test("lookups are cached per repo and branch for MERGED_EVERY_MS", async () => {
    let at = 0;
    const { run, calls } = gh({ "feature/x": [{ number: 9, mergedAt: PR.mergedAt }] }, []);
    const lookup = mergedPrs(run, () => at);
    await lookup("acme/app", "feature/x");
    await lookup("acme/app", "feature/x");
    at = MERGED_EVERY_MS;
    expect([await lookup("acme/app", "feature/x"), calls.length]).toEqual([PR, 4]);
  });

  test("a branch some PR targets as its base (dev, main) never counts, though its promotions merged", async () => {
    const { run } = gh(
      { dev: [{ number: 3, mergedAt: PR.mergedAt }], "feature/x": [{ number: 9, mergedAt: PR.mergedAt }] },
      ["dev"],
    );
    const lookup = mergedPrs(run, () => 0);
    expect([await lookup("acme/app", "dev"), await lookup("acme/app", "feature/x")]).toEqual([null, PR]);
  });

  test("blocked work closes Done only with branchMerged", () => {
    expect(transition("blocked", "done", { gate: "human", branchMerged: true })).toBe("done");
    expect(() => transition("blocked", "done", { gate: "human" })).toThrow(IllegalTransitionError);
  });
});
