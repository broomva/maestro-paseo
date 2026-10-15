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

const done = (ts: string, actor: "human" | "maestro" = "maestro"): Ev => ({
  ts,
  type: "state",
  actor,
  from: "review",
  to: "done",
  reason: null,
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

  test("raises compare tiers, not model strings: an alias and a dated id are one tier", () => {
    const aliasBind = { ...bind, provider: "claude/opus" };
    // Dispatched on the `opus` alias, the transcript says the dated id: same tier, no switch.
    const same = economyEvent(day(0), aliasBind, read(message("m", "claude-opus-5-5-20261001")));
    expect(same.raises).toBe(0);
    expect(same.tier).toBe("frontier");
    // A sonnet run that switches to opus under any spelling is one raise, however many spellings it used.
    const text = [
      message("a", "claude-sonnet-5-5"),
      message("b", "claude-opus-5-5"),
      message("c", "claude-opus-5-5-20261001"),
      message("d", "opus"),
    ].join("\n");
    expect(economyEvent(day(0), bind, read(text)).raises).toBe(1);
    // A switch to a lower tier is not a raise.
    expect(economyEvent(day(0), aliasBind, read(message("a", "claude-haiku-5-5"))).raises).toBe(0);
  });

  test("a run whose dispatched model is above its declared tier is a raise, with or without a transcript", () => {
    const declared = { ...bind, provider: "claude/opus", declaredTier: "standard" };
    const measuredRun = economyEvent(day(0), declared, read(message("m", "claude-opus-5-5-20261001")));
    // The dispatched model is the raise; the main thread running on it is not a second one.
    expect(measuredRun.raises).toBe(1);
    expect(measuredRun.tier).toBe("standard");
    const lost = economyEvent(day(0), declared, { measured: false, reason: "transcript not found" });
    expect(lost.raises).toBe(1);
    // A declared tier at or above the model is none.
    expect(economyEvent(day(0), { ...declared, declaredTier: "frontier" }, read("")).raises).toBe(0);
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

  test("a run with no reading is unmeasured, not a measured zero: it adds no tokens and no approvals to the ratio", () => {
    const works = [
      {
        id: "read",
        events: [
          dispatched(day(2), "a1", SONNET, "standard"),
          economy(day(2, 1), "a1", "standard", { tokens: tokens(100, 100, 0, 100) }),
          gate(day(1), "approve"),
        ],
      },
      {
        id: "never-read",
        events: [dispatched(day(2), "a2", SONNET, "standard"), gate(day(1), "approve")],
      },
      { id: "adopted-never-read", events: [adopted(day(2), "a3", "claude/claude-sonnet-5-5")] },
    ];
    const standard = sum(works).tiers.standard;
    expect(standard).toMatchObject({ runs: 3, approved: 2, unmeasured: 2, tokens: 300 });
    // 300 tokens over the one approval whose run was read, not over two.
    expect(standard.tokensPerApproved).toBe(300);
    // Only unread approvals: no ratio at all.
    const none = sum([works[1] as (typeof works)[number]]).tiers.standard;
    expect(none).toMatchObject({ approved: 1, unmeasured: 1, tokens: 0, tokensPerApproved: null });
    expect(none.cacheReadPerApproved).toBeNull();
    // A reading that says it could not read is unmeasured too, as before.
    const said = sum([
      {
        id: "w",
        events: [
          dispatched(day(1), "a9", SONNET, "standard"),
          economy(day(1, 1), "a9", "standard", { measured: false }),
        ],
      },
    ]);
    expect(said.tiers.standard.unmeasured).toBe(1);
  });

  test("the totals are the sum of the buckets, escalations too: one per re-dispatch that moved up", () => {
    const climbing = {
      id: "climbing",
      events: [
        dispatched(day(5), "c1", "claude/claude-haiku-5-5", "mechanical"),
        dispatched(day(4), "c2", SONNET, "standard"),
        dispatched(day(3), "c3", OPUS, "frontier"),
        dispatched(day(2), "c4", OPUS, "frontier"),
      ],
    };
    const jump = {
      id: "jump",
      events: [dispatched(day(5), "j1", SONNET, "standard"), dispatched(day(4), "j2", OPUS, "frontier")],
    };
    const summary = sum([climbing, jump]);
    // The first work escalated twice (standard, then frontier), the second once (frontier): three events.
    expect(summary.tiers.standard.escalations).toBe(1);
    expect(summary.tiers.frontier.escalations).toBe(2);
    expect(summary.totals.escalations).toBe(3);
    for (const key of [
      "runs",
      "approved",
      "sentBack",
      "tokens",
      "cacheRead",
      "escalations",
      "raises",
      "raisedRuns",
      "unmeasured",
    ] as const) {
      const buckets = Object.values(summary.tiers).reduce((total, bucket) => total + bucket[key], 0);
      expect(summary.totals[key]).toBe(buckets);
    }
  });

  test("work that lands done without a gate verdict is approved; one sent back first is approved but not a first pass", () => {
    const auto = { id: "auto", events: [dispatched(day(2), "a1", SONNET, "standard"), done(day(1))] };
    const merged = {
      id: "merged",
      events: [adopted(day(2), "m1", SONNET), done(day(1))],
    };
    const revised = {
      id: "revised",
      events: [dispatched(day(3), "r1", SONNET, "standard"), gate(day(2), "revise"), done(day(1))],
    };
    const gatedOnce = {
      id: "gated",
      events: [dispatched(day(2), "g1", SONNET, "standard"), gate(day(1, 1), "approve"), done(day(1), "human")],
    };
    const standard = sum([auto, merged, revised, gatedOnce]).tiers.standard;
    // All four; the gate's own landing is not a second approval of the gated one.
    expect(standard.approved).toBe(4);
    expect(standard.sentBack).toBe(1);
    // The revised one is no first pass.
    expect(standard.firstPass).toBe(3 / 4);
    // An approval before the window is not counted, nor a done that long ago.
    expect(
      sum([{ id: "old", events: [dispatched(day(12), "o1", SONNET, "standard"), done(day(10))] }]).tiers.standard
        .approved,
    ).toBe(0);
  });

  test("an approval of a run from before the window counts as approved but not toward tokens per approved", () => {
    const old = {
      id: "old-run",
      events: [
        dispatched(day(12), "o1", SONNET, "standard"),
        economy(day(11), "o1", "standard", { tokens: tokens(900, 0, 0, 0) }),
        gate(day(1), "approve"),
      ],
    };
    const inside = {
      id: "inside",
      events: [
        dispatched(day(2), "i1", SONNET, "standard"),
        economy(day(2, 1), "i1", "standard", { tokens: tokens(300) }),
        gate(day(1), "approve"),
      ],
    };
    // Only the old run's approval: it is approved, its run is not in the window, and there is no ratio.
    const alone = sum([old]).tiers.standard;
    expect(alone).toMatchObject({ runs: 0, approved: 1, tokens: 0, tokensPerApproved: null });
    expect(alone.cacheReadPerApproved).toBeNull();
    // Beside a run inside the window: the 300 tokens are divided by the one approval they belong to, not two.
    const both = sum([old, inside]).tiers.standard;
    expect(both).toMatchObject({ runs: 1, approved: 2, tokens: 300, tokensPerApproved: 300 });
    expect(both.firstPass).toBe(1);
  });

  test("first pass is judged at the approval: a run or a send-back after it does not undo it, an adoption before it does", () => {
    const later = {
      id: "later",
      events: [
        dispatched(day(4), "l1", SONNET, "standard"),
        gate(day(3), "approve"),
        // Reopened and run again after the approval: the first approval was still a first pass.
        dispatched(day(2), "l2", SONNET, "standard"),
      ],
    };
    const adoptedFirst = {
      id: "adopted-first",
      events: [adopted(day(4), "af1", SONNET), dispatched(day(3), "af2", SONNET, "standard"), gate(day(2), "approve")],
    };
    const sentBackLater = {
      id: "sent-back-later",
      events: [dispatched(day(4), "s1", SONNET, "standard"), gate(day(3), "approve"), gate(day(1), "revise")],
    };
    const standard = sum([later, adoptedFirst, sentBackLater]).tiers.standard;
    expect(standard.approved).toBe(3);
    expect(standard.firstPass).toBeCloseTo(2 / 3);
  });
});
