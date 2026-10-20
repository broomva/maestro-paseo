import { describe, expect, test } from "bun:test";
import { higherTier, isTier, modelOfProvider, tierOfModel, tierRank } from "./tiers";

describe("tierOfModel", () => {
  const table: Array<[string | null, string | null]> = [
    ["claude-haiku-5", "mechanical"],
    ["claude-sonnet-5-5", "standard"],
    ["claude-opus-5-5", "frontier"],
    ["claude-opus-5-5[1m]", "frontier"],
    ["claude-fable-1", "apex"],
    ["CLAUDE-SONNET-5-5", "standard"],
    ["gpt-5.5", null],
    ["antigravity", null],
    ["inbox", null],
    ["", null],
    [null, null],
  ];
  for (const [model, tier] of table) {
    test(`${JSON.stringify(model)} is ${tier}`, () => expect(tierOfModel(model)).toBe(tier as never));
  }
});

describe("tiers", () => {
  test("only the four names are tiers", () => {
    expect(["mechanical", "standard", "frontier", "apex"].every(isTier)).toBe(true);
    expect(isTier("Standard")).toBe(false);
    expect(isTier(null)).toBe(false);
  });
  test("rank orders mechanical < standard < frontier < apex, and an unknown is below all", () => {
    expect(tierRank("mechanical")).toBeLessThan(tierRank("standard"));
    expect(tierRank("standard")).toBeLessThan(tierRank("frontier"));
    expect(tierRank("frontier")).toBeLessThan(tierRank("apex"));
    expect(tierRank(null)).toBeLessThan(tierRank("mechanical"));
  });
  test("higherTier keeps the known one", () => {
    expect(higherTier(null, "standard")).toBe("standard");
    expect(higherTier("frontier", "standard")).toBe("frontier");
    expect(higherTier("standard", null)).toBe("standard");
  });
  test("modelOfProvider reads provider/model", () => {
    expect(modelOfProvider("claude/claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(modelOfProvider("claude")).toBeNull();
    expect(modelOfProvider(null)).toBeNull();
  });
});
