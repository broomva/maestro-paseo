import { describe, expect, test } from "bun:test";
import type { EconomyBucket, EconomySummary } from "../shared/economy";
import { economyRows, partsOf, tokenWords, totalWords } from "./economy-model";

const bucket = (extra: Partial<EconomyBucket> = {}): EconomyBucket => ({
  runs: 0,
  works: 0,
  approved: 0,
  sentBack: 0,
  tokens: 0,
  cacheRead: 0,
  tokensPerApproved: null,
  cacheReadPerApproved: null,
  firstPass: null,
  escalations: 0,
  raises: 0,
  raisedRuns: 0,
  unmeasured: 0,
  ...extra,
});

const summary = (tiers: Partial<EconomySummary["tiers"]>, totals: Partial<EconomyBucket> = {}): EconomySummary => ({
  generatedAt: "2026-10-15T12:00:00.000Z",
  windowDays: 7,
  tiers: {
    mechanical: bucket(),
    standard: bucket(),
    frontier: bucket(),
    apex: bucket(),
    unknown: bucket(),
    ...tiers,
  },
  totals: bucket(totals),
});

describe("economy words", () => {
  test("tokens read as 950, 12k, 1.4M", () => {
    expect(tokenWords(950)).toBe("950");
    expect(tokenWords(1500)).toBe("1.5k");
    expect(tokenWords(12_400)).toBe("12k");
    expect(tokenWords(1_400_000)).toBe("1.4M");
  });

  test("only tiers that ran get a row, lowest first", () => {
    const rows = economyRows(summary({ frontier: bucket({ runs: 2 }), standard: bucket({ runs: 1 }) }));
    expect(rows.map((row) => row.name)).toEqual(["standard", "frontier"]);
  });

  test("a row says runs, approved, tokens per approved, first pass, escalations, raises and unmeasured", () => {
    const parts = partsOf(
      bucket({
        runs: 4,
        approved: 2,
        tokensPerApproved: 120_000,
        firstPass: 0.5,
        escalations: 1,
        raises: 3,
        raisedRuns: 2,
        unmeasured: 1,
      }),
    );
    expect(parts).toEqual([
      "4 runs",
      "2 approved",
      "120k tokens per approved",
      "50% first pass",
      "1 escalation",
      "3 raises in 2 runs",
      "1 unmeasured",
    ]);
  });

  test("nothing approved says so, and no raises says so", () => {
    expect(partsOf(bucket({ runs: 1 }))).toEqual([
      "1 run",
      "0 approved",
      "no tokens per approved yet",
      "no first pass yet",
      "0 escalations",
      "no raises",
    ]);
  });

  test("the total is one line, and an empty window says so", () => {
    expect(totalWords(summary({}))).toBe("No runs in the last 7 days.");
    expect(
      totalWords(summary({}, { runs: 3, works: 2, approved: 1, tokens: 90_000, firstPass: 1, unmeasured: 1 })),
    ).toBe("In the last 7 days: 3 runs on 2 work items · 1 approved · 90k tokens · 100% first pass · 1 unmeasured");
  });
});
