import { describe, expect, test } from "bun:test";
import { createWork } from "./contracts";

const base = { brief: "Trim the cache", repo: "/repo", gate: "human", check: "", initiative: "", dispatch: false };

describe("work.create input", () => {
  test("the title is optional: absent or blank, the server names the work from the brief", () => {
    expect(createWork.input.safeParse(base).success).toBe(true);
    expect(createWork.input.safeParse({ ...base, title: "" }).success).toBe(true);
  });

  test("run choices are optional, trimmed, and simple", () => {
    const parsed = createWork.input.parse({
      ...base,
      provider: " claude/opus ",
      isolation: "directory",
      modeId: "bypassPermissions",
      thinkingOptionId: "xhigh",
      featureValues: { fast_mode: true, effort: "max", tier: null, budget: 2 },
    });
    expect(parsed).toMatchObject({ provider: "claude/opus", isolation: "directory" });
    expect(createWork.input.safeParse({ ...base, isolation: "sandbox" }).success).toBe(false);
    expect(createWork.input.safeParse({ ...base, modeId: "  " }).success).toBe(false);
    expect(createWork.input.safeParse({ ...base, featureValues: { fast: { on: true } } }).success).toBe(false);
    expect(createWork.input.safeParse({ ...base, featureValues: { fast: [true] } }).success).toBe(false);
  });
});
