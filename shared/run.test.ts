import { describe, expect, test } from "bun:test";
import { describeRun, runTerms } from "./run";

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
