// The delegation economy (BRO-3118), pure: the `run.economy` event built from what a session used, and the summary
// of every tier's cost and pass rate over a window, computed from the work items' receipts. Nothing here reads a
// file or the clock; server/economy.ts writes the summary and the engine appends the events.

import {
  ECONOMY_BUCKETS,
  ECONOMY_DAYS,
  type EconomyBucket,
  type EconomyBucketName,
  type EconomySummary,
  type Tokens,
} from "../shared/economy";
import { higherTier, modelOfProvider, TIERS, tierOfModel, tierRank } from "../shared/tiers";
import type { RunEconomy, WorkEvent } from "./events";
import { billed, NO_TOKENS, type UsageRead } from "./usage";

/** The run a `run.economy` is about, as its dispatch or adoption receipt says. */
export interface RunBinding {
  agentId: string;
  /** The provider as dispatched: `claude/claude-sonnet-5-5`. */
  provider: string;
  /** The tier the work declared at dispatch; null when undeclared, and always on an adoption. */
  declaredTier: string | null;
  thinkingOptionId: string | null;
  /** When it was bound. */
  at: string;
}

/** The latest binding of each agent in one work's receipts, in the order the agents first appeared. */
export function bindingsOf(events: readonly WorkEvent[]): RunBinding[] {
  const bindings = new Map<string, RunBinding>();
  for (const event of events) {
    if (event.type !== "dispatched" && event.type !== "adopted") continue;
    bindings.set(event.agentId, {
      agentId: event.agentId,
      provider: event.provider,
      declaredTier: event.tier ?? null,
      thinkingOptionId: event.thinkingOptionId ?? null,
      at: event.ts,
    });
  }
  return [...bindings.values()];
}

const tokensOf = (tokens: Tokens): Tokens => ({ ...tokens });

/**
 * The `run.economy` event for one run. Its tier is the declared one, else the one its model implies. `raises` counts
 * what the run used above that tier, by tier and however a model is spelled (an alias, a dated id): the dispatched
 * model itself when its tier is above the declared one, each higher tier the main thread switched to, and each
 * subagent transcript that ran on a higher tier. A run with no tier has no baseline to be raised above.
 */
export function economyEvent(
  ts: string,
  bind: RunBinding,
  read: UsageRead,
  backfilled = false,
): Extract<WorkEvent, { type: "run.economy" }> {
  const usage = read.measured ? read.usage : null;
  const model = modelOfProvider(bind.provider) ?? usage?.mainModels[0] ?? null;
  const inferred = tierOfModel(model);
  const tier = bind.declaredTier ?? inferred;
  const base = {
    ts,
    type: "run.economy" as const,
    actor: "maestro" as const,
    agentId: bind.agentId,
    tier,
    tierSource: bind.declaredTier ? ("declared" as const) : inferred ? ("model" as const) : null,
    provider: bind.provider,
    model,
    thinkingOptionId: bind.thinkingOptionId,
  };
  const marked = backfilled ? { backfilled: true as const } : {};
  const own = tierRank(tier);
  const tierAbove = (candidate: string | null) => own >= 0 && tierRank(tierOfModel(candidate)) > own;
  // The dispatched model is itself above the tier the work declared: a raise a missing transcript cannot hide.
  const dispatchedRaise = bind.declaredTier && tierAbove(model) ? 1 : 0;
  if (!usage) {
    return {
      ...base,
      measured: false,
      ...(read.measured ? {} : { reason: read.reason }),
      tokens: { ...NO_TOKENS },
      subagentTokens: null,
      subagentModels: null,
      raises: dispatchedRaise,
      maxSubagentTier: null,
      peakContext: null,
      assistantMessages: 0,
      ...marked,
    };
  }
  const raisedFiles = (usage.subagents?.files ?? []).filter((file) => file.models.some(tierAbove)).length;
  // Tiers, not model strings: `claude/opus` and `claude-opus-5-5-20261001` are one tier, and the dispatched one is counted.
  const dispatchedTier = tierOfModel(model);
  const switched = new Set(
    usage.mainModels.flatMap((candidate) => {
      const tierOfCandidate = tierOfModel(candidate);
      return tierOfCandidate && tierOfCandidate !== dispatchedTier && tierAbove(candidate) ? [tierOfCandidate] : [];
    }),
  ).size;
  let maxSubagentTier: string | null = null;
  for (const name of Object.keys(usage.subagents?.byModel ?? {})) {
    maxSubagentTier = higherTier(maxSubagentTier, tierOfModel(name));
  }
  return {
    ...base,
    measured: true,
    tokens: tokensOf(usage.tokens),
    subagentTokens: usage.subagents ? tokensOf(usage.subagents.tokens) : null,
    subagentModels: usage.subagents ? { ...usage.subagents.byModel } : null,
    raises: dispatchedRaise + raisedFiles + switched,
    maxSubagentTier,
    peakContext: usage.peakContext,
    assistantMessages: usage.assistantMessages,
    ...marked,
  };
}

/** The agent's latest `run.economy` receipt. */
export function lastEconomy(events: readonly WorkEvent[], agentId: string): RunEconomy | null {
  const found = events.findLast((event) => event.type === "run.economy" && event.agentId === agentId);
  return found?.type === "run.economy" ? found : null;
}

/** Whether a reading says what an earlier one did: the same numbers, tier and model. Its time and `backfilled` are not numbers. */
export function sameReading(a: RunEconomy, b: RunEconomy): boolean {
  const pick = (e: RunEconomy) =>
    JSON.stringify([
      e.measured,
      e.reason ?? null,
      e.tier,
      e.tierSource,
      e.model,
      e.tokens,
      e.subagentTokens,
      e.subagentModels,
      e.raises,
      e.maxSubagentTier,
      e.peakContext,
      e.assistantMessages,
    ]);
  return pick(a) === pick(b);
}

// ── The summary ──────────────────────────────────────────────────────────────

/** One work's receipts, as the summary reads them. */
export interface EconomyWork {
  id: string;
  events: readonly WorkEvent[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface Run {
  work: string;
  agentId: string;
  /** Tier bucket: the latest reading's tier, else the dispatched tier, else the dispatched model's. */
  bucket: EconomyBucketName;
  tokens: number;
  cacheRead: number;
  unmeasured: boolean;
  raises: number;
  /** A receipt of this run is inside the window. */
  inWindow: boolean;
}

const bucketOf = (tier: string | null): EconomyBucketName =>
  tier && (TIERS as readonly string[]).includes(tier) ? (tier as EconomyBucketName) : "unknown";

const sumOf = (tokens: Tokens | null | undefined) => (tokens ? billed(tokens) : 0);

/**
 * Each run of one work: its effective tier, and what it used, from its latest reading. Receipt order. A run with no
 * reading is unmeasured, and so is one whose reading says it could not be read.
 */
function runsOf(work: EconomyWork, cutoff: number): Map<string, Run> {
  const runs = new Map<string, Run>();
  for (const event of work.events) {
    if (event.type !== "dispatched" && event.type !== "adopted" && event.type !== "run.economy") continue;
    const at = Date.parse(event.ts);
    const run = runs.get(event.agentId) ?? {
      work: work.id,
      agentId: event.agentId,
      bucket: "unknown" as EconomyBucketName,
      tokens: 0,
      cacheRead: 0,
      // Until a reading says otherwise, a run has none: unmeasured, never a measured zero.
      unmeasured: true,
      raises: 0,
      inWindow: false,
    };
    runs.set(event.agentId, run);
    if (at >= cutoff) run.inWindow = true;
    if (event.type === "run.economy") {
      run.bucket = bucketOf(event.tier);
      run.tokens = sumOf(event.tokens) + sumOf(event.subagentTokens);
      run.cacheRead = event.tokens.cacheRead + (event.subagentTokens?.cacheRead ?? 0);
      run.unmeasured = !event.measured;
      run.raises = event.raises ?? 0;
    } else if (run.bucket === "unknown") {
      // Until a reading says otherwise: what the dispatch declared, else what its model implies.
      run.bucket = bucketOf(event.tier ?? tierOfModel(modelOfProvider(event.provider)));
    }
  }
  return runs;
}

const empty = (): Acc => ({
  runs: new Set(),
  works: new Set(),
  approved: 0,
  approvedMeasured: 0,
  firstPass: 0,
  sentBack: 0,
  tokens: 0,
  cacheRead: 0,
  escalations: 0,
  raises: 0,
  raisedRuns: 0,
  unmeasured: 0,
});

interface Acc {
  runs: Set<string>;
  works: Set<string>;
  approved: number;
  /** Approvals credited to a run whose usage was read: the only ones tokens per approved divides by. */
  approvedMeasured: number;
  firstPass: number;
  sentBack: number;
  tokens: number;
  cacheRead: number;
  escalations: number;
  raises: number;
  raisedRuns: number;
  unmeasured: number;
}

function finish(acc: Acc): EconomyBucket {
  return {
    runs: acc.runs.size,
    works: acc.works.size,
    approved: acc.approved,
    sentBack: acc.sentBack,
    tokens: acc.tokens,
    cacheRead: acc.cacheRead,
    tokensPerApproved: acc.approvedMeasured > 0 ? Math.round(acc.tokens / acc.approvedMeasured) : null,
    cacheReadPerApproved: acc.approvedMeasured > 0 ? Math.round(acc.cacheRead / acc.approvedMeasured) : null,
    firstPass: acc.approved > 0 ? acc.firstPass / acc.approved : null,
    escalations: acc.escalations,
    raises: acc.raises,
    raisedRuns: acc.raisedRuns,
    unmeasured: acc.unmeasured,
  };
}

/**
 * Every tier's cost and pass rate over the last `days` days (by receipt time). The definitions are in
 * shared/economy.ts (EconomyBucketSchema), and the totals are the sum of the buckets (work counted once overall).
 * A run counts when a receipt of it falls in the window: its dispatch, adoption or reading. A verdict counts when it
 * was made in the window, and is credited to the tier of the latest run before it.
 */
export function summarizeEconomy(
  works: readonly EconomyWork[],
  now: number,
  days: number = ECONOMY_DAYS.default,
): EconomySummary {
  const cutoff = now - days * DAY_MS;
  const tiers = Object.fromEntries(ECONOMY_BUCKETS.map((name) => [name, empty()])) as Record<EconomyBucketName, Acc>;
  const totals = empty();
  const credit = (name: EconomyBucketName, apply: (acc: Acc) => void) => {
    apply(tiers[name]);
    apply(totals);
  };
  for (const work of works) {
    const runs = runsOf(work, cutoff);
    for (const run of runs.values()) {
      if (!run.inWindow) continue;
      credit(run.bucket, (acc) => {
        acc.runs.add(run.agentId);
        acc.works.add(work.id);
        acc.tokens += run.tokens;
        acc.cacheRead += run.cacheRead;
        if (run.unmeasured) acc.unmeasured += 1;
        if (run.raises > 0) {
          acc.raises += run.raises;
          acc.raisedRuns += 1;
        }
      });
    }
    // Verdicts and dispatches in order: each is credited to the run that was latest when it happened.
    const gated = work.events.some((event) => event.type === "gate" && event.verdict === "approve");
    let latest: Run | null = null;
    let previous: Run | null = null;
    let binds = 0;
    let revised = false;
    // The work is approved once: by its last approval in the window, judged as things stood at that approval.
    let approval: { run: Run; clean: boolean } | null = null;
    for (const event of work.events) {
      if (event.type === "dispatched" || event.type === "adopted") {
        const run = runs.get(event.agentId) ?? null;
        binds += 1;
        if (event.type === "dispatched" && run && previous && run.agentId !== previous.agentId) {
          const moved = tierRank(run.bucket) > tierRank(previous.bucket) && tierRank(previous.bucket) >= 0;
          if (moved && Date.parse(event.ts) >= cutoff) {
            credit(run.bucket, (acc) => {
              acc.escalations += 1;
            });
          }
        }
        latest = run;
        if (event.type === "dispatched") previous = run;
        continue;
      }
      const inWindow = Date.parse(event.ts) >= cutoff;
      if (event.type === "gate" && event.verdict === "revise") {
        revised = true;
        if (inWindow && latest) {
          credit(latest.bucket, (acc) => {
            acc.sentBack += 1;
          });
        }
      }
      // An approve verdict, or, for work no gate verdict closed (an auto gate's checks, a merged branch), its landing as done.
      const approves =
        (event.type === "gate" && event.verdict === "approve") ||
        (event.type === "state" && event.to === "done" && !gated && !revised);
      if (approves && inWindow && latest) approval = { run: latest, clean: binds === 1 && !revised };
    }
    if (approval) {
      const { run, clean } = approval;
      credit(run.bucket, (acc) => {
        acc.approved += 1;
        if (!run.unmeasured) acc.approvedMeasured += 1;
        if (clean) acc.firstPass += 1;
      });
    }
  }
  return {
    generatedAt: new Date(now).toISOString(),
    windowDays: days,
    tiers: Object.fromEntries(ECONOMY_BUCKETS.map((name) => [name, finish(tiers[name])])) as EconomySummary["tiers"],
    totals: finish(totals),
  };
}
