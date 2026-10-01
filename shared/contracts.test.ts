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
    expect(createWork.input.safeParse({ ...base, featureValues: { "": true } }).success).toBe(false);
    expect(createWork.input.safeParse({ ...base, featureValues: { budget: Number.POSITIVE_INFINITY } }).success).toBe(
      false,
    );
  });

  test("feature values are bounded: 32 of them, 200 characters each", () => {
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, n) => [`f${n}`, true]));
    const ok = (featureValues: unknown) => createWork.input.safeParse({ ...base, featureValues }).success;
    expect(ok(many)).toBe(false);
    expect(ok(Object.fromEntries(Object.entries(many).slice(0, 32)))).toBe(true);
    expect(ok({ effort: "x".repeat(201) })).toBe(false);
    expect(ok({ effort: "x".repeat(200) })).toBe(true);
    expect(ok({ ["k".repeat(201)]: true })).toBe(false);
  });
});
