import { describe, expect, test } from "bun:test";
import type { Tokens } from "../shared/economy";
import { bindingsOf, economyEvent, lastEconomy, sameReading, summarizeEconomy } from "./economy-model";
import type { WorkEvent } from "./events";
import { parseTranscriptUsage, type UsageRead } from "./usage";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const day = (back: number, hour = 0) => new Date(NOW - back * 86_400_000 + hour * 3_600_000).toISOString();
const tokens = (input: number, output = 0, cacheRead = 0, cacheCreation = 0): Tokens => ({
  input,
  output,
  cacheRead,
  cacheCreation,
});

type Ev = WorkEvent;
const dispatched = (ts: string, agentId: string, provider: string, tier?: string | null): Ev => ({
  ts,
  type: "dispatched",
  actor: "human",
  agentId,
  workspaceId: null,
  provider,
  branch: null,
  cwd: null,
  ...(tier === undefined ? {} : { tier }),
});
const adopted = (ts: string, agentId: string, provider: string): Ev => ({
  ts,
  type: "adopted",
  actor: "agent",
  by: null,
  agentId,
  workspaceId: null,
  provider,
  branch: null,
  cwd: null,
  tier: null,
});
const economy = (
  ts: string,
  agentId: string,
  tier: string | null,
  used: Partial<{ tokens: Tokens; sub: Tokens | null; measured: boolean; raises: number }> = {},
): Ev => ({
  ts,
  type: "run.economy",
  actor: "maestro",
  agentId,
  tier,
  tierSource: tier ? "declared" : null,
  provider: "claude/claude-sonnet-5-5",
  model: "claude-sonnet-5-5",
  thinkingOptionId: null,
  measured: used.measured ?? true,
  tokens: used.tokens ?? tokens(0),
  subagentTokens: used.sub ?? null,
  subagentModels: null,
  raises: used.raises ?? 0,
  maxSubagentTier: null,
  peakContext: null,
  assistantMessages: 1,
});
const gate = (ts: string, verdict: "approve" | "revise" | "block"): Ev => ({
  ts,
  type: "gate",
  actor: "human",
  verdict,
  note: "",
});

const SONNET = "claude/claude-sonnet-5-5";
const OPUS = "claude/claude-opus-5-5";

describe("economyEvent", () => {
  const bind = { agentId: "a1", provider: SONNET, declaredTier: null, thinkingOptionId: "high", at: day(0) };
  const read = (main: string, subagents: Record<string, string> | null = null): UsageRead => ({
    measured: true,
    usage: parseTranscriptUsage(main, subagents),
  });
  const message = (id: string, model: string, usage = { input_tokens: 1, output_tokens: 1 }, sidechain = false) =>
    JSON.stringify({ type: "assistant", isSidechain: sidechain, message: { id, model, usage } });

  test("the tier is the declared one, else the model's, else none", () => {
    expect(economyEvent(day(0), { ...bind, declaredTier: "frontier" }, read("")).tierSource).toBe("declared");
    const inferred = economyEvent(day(0), bind, read(""));
    expect(inferred).toMatchObject({
      tier: "standard",
      tierSource: "model",
      model: "claude-sonnet-5-5",
      provider: SONNET,
    });
    const codex = economyEvent(
      day(0),
      { ...bind, provider: "codex/gpt-5.5" },
      { measured: false, reason: "codex transcript not read" },
    );
    expect(codex).toMatchObject({ tier: null, tierSource: null, measured: false, reason: "codex transcript not read" });
    expect(codex.tokens).toEqual(tokens(0));
    expect(codex.subagentTokens).toBeNull();
    expect(codex.subagentModels).toBeNull();
    expect(codex.raises).toBe(0);
  });

  test("a bare provider takes its model from what the transcript ran on", () => {
    const event = economyEvent(day(0), { ...bind, provider: "claude" }, read(message("m", "claude-opus-5-5")));
    expect(event).toMatchObject({ model: "claude-opus-5-5", tier: "frontier", tierSource: "model" });
  });

  test("a subagent on a higher tier is a raise; the same or a lower tier is not", () => {
    const sub = (model: string) => ({
      "agent-1.jsonl": message("s", model, { input_tokens: 4, output_tokens: 6 }, true),
    });
    const higher = economyEvent(day(0), bind, read(message("m", "claude-sonnet-5-5"), sub("claude-opus-5-5")));
    expect(higher.raises).toBe(1);
    expect(higher.maxSubagentTier).toBe("frontier");
    expect(higher.subagentModels).toEqual({ "claude-opus-5-5": 10 });
    const same = economyEvent(day(0), bind, read(message("m", "claude-sonnet-5-5"), sub("claude-sonnet-5-5")));
    expect(same.raises).toBe(0);
    expect(same.maxSubagentTier).toBe("standard");
    const lower = economyEvent(day(0), bind, read(message("m", "claude-sonnet-5-5"), sub("claude-haiku-5")));
    expect(lower.raises).toBe(0);
    expect(lower.maxSubagentTier).toBe("mechanical");
  });

  test("raises count subagent transcripts, not their messages", () => {
    const opus = (id: string) => message(id, "claude-opus-5-5", { input_tokens: 1, output_tokens: 1 }, true);
    const event = economyEvent(
      day(0),
      bind,
      read(message("m", "claude-sonnet-5-5"), {
        "one.jsonl": [opus("a"), opus("b"), opus("c")].join("\n"),
        "two.jsonl": opus("z"),
      }),
    );
    expect(event.raises).toBe(2);
  });

  test("raises are measured against the declared tier when there is one", () => {
    const sub = { "x.jsonl": message("s", "claude-opus-5-5", undefined, true) };
    const declaredHigh = economyEvent(
      day(0),
      { ...bind, declaredTier: "frontier" },
      read(message("m", "claude-sonnet-5-5"), sub),
    );
    expect(declaredHigh.raises).toBe(0);
  });

  test("a main thread that switched to a higher model is a raise; one without a baseline has none", () => {
    const text = [
      message("a", "claude-sonnet-5-5"),
      message("b", "claude-opus-5-5"),
      message("c", "claude-opus-5-5"),
    ].join("\n");
    expect(economyEvent(day(0), bind, read(text)).raises).toBe(1);
    const none = economyEvent(day(0), { ...bind, provider: "codex/gpt-5.5" }, read(text));
    expect(none.raises).toBe(0);
  });

  test("a backfilled reading says so", () => {
    expect(economyEvent(day(0), bind, read(""), true).backfilled).toBe(true);
    expect(economyEvent(day(0), bind, read("")).backfilled).toBeUndefined();
  });

  test("a reading with the same numbers is the same reading, whenever it was taken", () => {
    const a = economyEvent(day(1), bind, read(message("m", "claude-sonnet-5-5")));
    const b = economyEvent(day(0), bind, read(message("m", "claude-sonnet-5-5")), true);
    expect(sameReading(a, b)).toBe(true);
    const c = economyEvent(
      day(0),
      bind,
      read([message("m", "claude-sonnet-5-5"), message("n", "claude-sonnet-5-5")].join("\n")),
    );
    expect(sameReading(a, c)).toBe(false);
  });

  test("the latest reading of an agent, and each agent's latest binding", () => {
    const events = [
      dispatched(day(2), "a1", SONNET),
      economy(day(2, 1), "a1", "standard"),
      economy(day(1), "a2", "standard"),
      economy(day(0), "a1", "standard", { raises: 1 }),
    ];
    expect(lastEconomy(events, "a1")).toMatchObject({ raises: 1 });
    expect(lastEconomy(events, "a3")).toBeNull();
    expect(bindingsOf(events)).toEqual([
      { agentId: "a1", provider: SONNET, declaredTier: null, thinkingOptionId: null, at: day(2) },
    ]);
  });
});

describe("summarizeEconomy", () => {
  const sum = (works: Array<{ id: string; events: Ev[] }>, days?: number) => summarizeEconomy(works, NOW, days);

  test("buckets are the four tiers and unknown, each with every key, and the totals", () => {
    const summary = sum([]);
    expect(Object.keys(summary.tiers)).toEqual(["mechanical", "standard", "frontier", "apex", "unknown"]);
    expect(summary).toMatchObject({ windowDays: 7, generatedAt: new Date(NOW).toISOString() });
    expect(summary.totals).toEqual({
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
    });
  });

  test("a run's tier is its latest reading's, else the dispatch's, else its model's, else unknown", () => {
    const summary = sum([
      { id: "w1", events: [dispatched(day(1), "a1", OPUS), economy(day(1, 1), "a1", "standard")] },
      { id: "w2", events: [dispatched(day(1), "a2", OPUS, "mechanical")] },
      { id: "w3", events: [dispatched(day(1), "a3", OPUS)] },
      { id: "w4", events: [dispatched(day(1), "a4", "codex/gpt-5.5")] },
      { id: "w5", events: [adopted(day(1), "a5", "claude")] },
    ]);
    expect(summary.tiers.standard.runs).toBe(1);
    expect(summary.tiers.mechanical.runs).toBe(1);
    expect(summary.tiers.frontier.runs).toBe(1);
    expect(summary.tiers.unknown.runs).toBe(2);
    expect(summary.totals.runs).toBe(5);
    expect(summary.totals.works).toBe(5);
  });

  test("an approval is credited to the tier of the latest run before it, and tokens per approved divides by it", () => {
    const works = [
      {
        id: "w1",
        events: [
          dispatched(day(2), "a1", SONNET, "standard"),
          economy(day(2, 1), "a1", "standard", { tokens: tokens(100, 200, 5000, 300), sub: tokens(10, 20, 1000, 30) }),
          gate(day(1), "approve"),
        ],
      },
      {
        id: "w2",
        events: [
          dispatched(day(2), "a2", SONNET, "standard"),
          economy(day(2, 1), "a2", "standard", { tokens: tokens(50, 50, 1000, 100) }),
          gate(day(1), "approve"),
        ],
      },
    ];
    const standard = sum(works).tiers.standard;
    expect(standard.approved).toBe(2);
    // (100+200+300 + 10+20+30) + (50+50+100) = 660 + 200
    expect(standard.tokens).toBe(860);
    expect(standard.cacheRead).toBe(7000);
    expect(standard.tokensPerApproved).toBe(430);
    expect(standard.cacheReadPerApproved).toBe(3500);
    expect(sum(works).tiers.frontier.approved).toBe(0);
    expect(sum(works).tiers.frontier.tokensPerApproved).toBeNull();
  });

  test("an approval after a run on another tier is that tier's: the latest run before it", () => {
    const summary = sum([
      {
        id: "w1",
        events: [
          dispatched(day(3), "a1", SONNET, "standard"),
          gate(day(3, 5), "revise"),
          dispatched(day(2), "a2", OPUS, "frontier"),
          gate(day(1), "approve"),
        ],
      },
    ]);
    expect(summary.tiers.standard).toMatchObject({ approved: 0, sentBack: 1 });
    expect(summary.tiers.frontier).toMatchObject({ approved: 1, sentBack: 0 });
  });

  test("first pass is approved work with one dispatch and no send-back, over approved", () => {
    const clean = (id: string) => ({
      id,
      events: [dispatched(day(2), `a-${id}`, SONNET, "standard"), gate(day(1), "approve")],
    });
    const sentBack = {
      id: "sb",
      events: [dispatched(day(2), "a-sb", SONNET, "standard"), gate(day(1, 2), "revise"), gate(day(1), "approve")],
    };
    const twice = {
      id: "tw",
      events: [
        dispatched(day(3), "a-tw1", SONNET, "standard"),
        dispatched(day(2), "a-tw2", SONNET, "standard"),
        gate(day(1), "approve"),
      ],
    };
    const standard = sum([clean("c1"), clean("c2"), sentBack, twice]).tiers.standard;
    expect(standard.approved).toBe(4);
    expect(standard.firstPass).toBe(0.5);
    expect(standard.sentBack).toBe(1);
    expect(sum([]).tiers.standard.firstPass).toBeNull();
  });

  test("an escalation is a later dispatch on a higher tier, credited to the tier it moved to", () => {
    const up = {
      id: "up",
      events: [dispatched(day(3), "u1", SONNET, "standard"), dispatched(day(2), "u2", OPUS, "frontier")],
    };
    const down = {
      id: "down",
      events: [dispatched(day(3), "d1", OPUS, "frontier"), dispatched(day(2), "d2", SONNET, "standard")],
    };
    const same = {
      id: "same",
      events: [dispatched(day(3), "s1", SONNET, "standard"), dispatched(day(2), "s2", SONNET, "standard")],
    };
    const summary = sum([up, down, same]);
    expect(summary.tiers.frontier.escalations).toBe(1);
    expect(summary.tiers.standard.escalations).toBe(0);
    expect(summary.totals.escalations).toBe(1);
  });

  test("raises and raised runs are summed from each run's latest reading; unmeasured runs are counted", () => {
    const summary = sum([
      {
        id: "w1",
        events: [
          dispatched(day(1), "a1", SONNET, "standard"),
          economy(day(1, 1), "a1", "standard", { raises: 1 }),
          economy(day(0), "a1", "standard", { raises: 3 }),
        ],
      },
      {
        id: "w2",
        events: [dispatched(day(1), "a2", SONNET, "standard"), economy(day(1, 1), "a2", "standard", { raises: 0 })],
      },
      {
        id: "w3",
        events: [dispatched(day(1), "a3", "codex/gpt-5.5"), economy(day(1, 1), "a3", null, { measured: false })],
      },
    ]);
    expect(summary.tiers.standard).toMatchObject({ runs: 2, raises: 3, raisedRuns: 1, unmeasured: 0 });
    expect(summary.tiers.unknown).toMatchObject({ runs: 1, unmeasured: 1 });
    expect(summary.totals).toMatchObject({ raises: 3, raisedRuns: 1, unmeasured: 1 });
  });

  test("only the last N days count, by receipt time", () => {
    const works = [
      { id: "old", events: [dispatched(day(9), "o1", SONNET, "standard"), gate(day(8), "approve")] },
      { id: "new", events: [dispatched(day(2), "n1", SONNET, "standard"), gate(day(1), "approve")] },
    ];
    expect(sum(works).tiers.standard).toMatchObject({ runs: 1, works: 1, approved: 1 });
    const wide = sum(works, 30);
    expect(wide.windowDays).toBe(30);
    expect(wide.tiers.standard).toMatchObject({ runs: 2, works: 2, approved: 2 });
    // A run dispatched before the window whose reading is inside it still counts.
    const reading = sum([
      { id: "w", events: [dispatched(day(9), "r1", SONNET, "standard"), economy(day(1), "r1", "standard")] },
    ]);
    expect(reading.tiers.standard.runs).toBe(1);
    // An approval before the window is not counted.
    const stale = sum([{ id: "w", events: [dispatched(day(9), "r1", SONNET, "standard"), gate(day(8), "approve")] }]);
    expect(stale.tiers.standard.approved).toBe(0);
  });
});
