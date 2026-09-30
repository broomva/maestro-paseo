import { describe, expect, test } from "bun:test";
import { describeRun, queuedRunLine, runTerms } from "./run";

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

describe("the Queued card's run line", () => {
  test("names every choice and warns when the mode skips permission prompts", () => {
    const bypass = queuedRunLine({ provider: "claude/opus", modeId: "bypassPermissions", thinkingOptionId: "high" });
    expect(bypass.line).toBe("Runs with claude/opus (mode bypassPermissions, thinking high).");
    expect(bypass.warning).toContain("skips permission prompts");
    expect(queuedRunLine({ modeId: "full-access" }).warning).not.toBeNull();
  });

  test("is quiet for a mode that asks, and for work left to Settings", () => {
    expect(queuedRunLine({ modeId: "acceptEdits" }).warning).toBeNull();
    expect(queuedRunLine({ modeId: "acceptEdits" }).line).toBe("Runs with the Settings provider (mode acceptEdits).");
    expect(queuedRunLine(null)).toEqual({ line: "Runs with your Settings defaults.", warning: null });
  });
});
