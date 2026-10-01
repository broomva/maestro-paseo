import { describe, expect, test } from "bun:test";
import type { NextRun } from "./contracts";
import { describeRun, nextRunCopy, runTerms, skipsPrompts } from "./run";

describe("how a run was started, in words", () => {
  test("the provider, then each choice that shaped the run", () => {
    expect(
      describeRun({
        provider: "claude/opus",
        modeId: "bypassPermissions",
        thinkingOptionId: "xhigh",
        featureValues: { fast_mode: true, plan: false, effort: "max", tier: null },
      }),
    ).toBe("claude/opus (mode bypassPermissions, thinking xhigh, fast_mode on, plan off, effort max, tier unset)");
  });

  test("a run with no choices beyond the provider, or an older receipt, is the provider alone", () => {
    expect(describeRun({ provider: "codex/gpt-5.5" })).toBe("codex/gpt-5.5");
    expect(describeRun({ provider: "claude", modeId: null, thinkingOptionId: null, featureValues: null })).toBe(
      "claude",
    );
    expect(runTerms({ featureValues: {} })).toEqual([]);
  });
});

const next = (extra: Partial<NextRun> = {}): NextRun => ({
  provider: "claude",
  isolation: "worktree",
  modeId: null,
  thinkingOptionId: null,
  featureValues: null,
  fromSettings: [],
  ...extra,
});

describe("what skips permission prompts", () => {
  test("Claude's bypassPermissions and Codex's full-access", () => {
    expect(skipsPrompts({ modeId: "bypassPermissions" })).toBe(true);
    expect(skipsPrompts({ modeId: "full-access" })).toBe(true);
    expect(skipsPrompts({ modeId: "acceptEdits" })).toBe(false);
    expect(skipsPrompts({ modeId: null, featureValues: null })).toBe(false);
  });

  test("OpenCode's and ACP's auto_accept, on as true or as \"true\"; off, or another feature, does not", () => {
    expect(skipsPrompts({ featureValues: { auto_accept: true } })).toBe(true);
    expect(skipsPrompts({ modeId: "build", featureValues: { auto_accept: "true" } })).toBe(true);
    expect(skipsPrompts({ featureValues: { auto_accept: false } })).toBe(false);
    expect(skipsPrompts({ featureValues: { fast_mode: true } })).toBe(false);
  });
});

describe("the card line before a verb that can start a run", () => {
  test("names every choice, marks what Settings filled, and warns when the run skips prompts", () => {
    const queued = nextRunCopy(
      next({ modeId: "bypassPermissions", thinkingOptionId: "low", fromSettings: ["provider", "isolation", "modeId"] }),
      "queued",
    );
    expect(queued.line).toBe(
      "Queued. Dispatching starts an agent in a fresh worktree on its own run branch (from Settings). " +
        "Runs with claude (from Settings): mode bypassPermissions (from Settings), thinking low.",
    );
    expect(queued.warning).toBe(
      "This run skips permission prompts: it can edit files and run commands without asking.",
    );
  });

  test("the Stuck card says Unblock may start a new run, and warns for it", () => {
    const stuck = nextRunCopy(
      next({ provider: "opencode/big", isolation: "directory", featureValues: { auto_accept: true } }),
      "stuck",
    );
    expect(stuck.line).toBe(
      "If the session is gone, Unblock starts a new run in the repository itself, with opencode/big: auto_accept on.",
    );
    expect(stuck.warning).toContain("would skip permission prompts");
  });

  test("is quiet for a run that asks, and plain when the work chose everything", () => {
    const asks = nextRunCopy(next({ provider: "claude/opus", modeId: "acceptEdits" }), "queued");
    expect(asks).toEqual({
      line: "Queued. Dispatching starts an agent in a fresh worktree on its own run branch. Runs with claude/opus: mode acceptEdits.",
      warning: null,
    });
    expect(nextRunCopy(undefined, "stuck").warning).toBeNull();
  });
});
