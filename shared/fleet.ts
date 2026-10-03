// RPC contracts for the Fleet view: fleet-reconcile's hourly runs per scope,
// their reports, the dry run's proposals with your verdict on each, and the
// fleet's asks and alerts as the Maestro work it raised for them. Served to
// Maestro's own surfaces only, never on the agent socket: a verdict is yours.
// Plain Zod values: this module is compiled into both bundles.

import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { GROUP_ORDER, ORCH_STATES } from "./states";

/**
 * How a scope's tick is doing:
 * - `ok`: it ticks on time and the latest tick passed (or is running);
 * - `failing`: the latest tick failed, or started and never finished;
 * - `missed`: it is scheduled, and no tick has started for longer than the
 *   threshold (FLEET_MISSED_MS, or two of its intervals if longer) of time
 *   the Mac was awake, as launchd counts its interval (server/fleet.ts
 *   AwakeClock);
 * - `off`: the fleet's kill switch is off, so no tick runs, by your choice;
 * - `unscheduled`: no LaunchAgent runs it: ticks happen only by hand.
 */
export const FLEET_HEALTH = ["ok", "failing", "missed", "off", "unscheduled"] as const;
export type FleetHealthStatus = (typeof FLEET_HEALTH)[number];

/** No tick for this long, on a scheduled scope, puts it in Needs you. */
export const FLEET_MISSED_MS = 2 * 60 * 60 * 1000;

/**
 * One tick, as its ledger records say: `ok` (exit 0), `failed` (exit 1),
 * `running` (started, within its time budget), `died` (started, never
 * finished, past its budget), `unknown` (no exit code recorded: ticks from
 * before the ledger kept one, or a report with no ledger record).
 */
export const TICK_STATUS = ["ok", "failed", "running", "died", "unknown"] as const;
export type TickStatus = (typeof TICK_STATUS)[number];

/** Your verdict on one proposal. A later verdict on the same proposal replaces it. */
export const REVIEW_VERDICTS = ["accept", "reject"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export const REVIEW_NOTE_CHARS = 1000;
/** Keys one verdict may cover: a group's sessions. */
export const REVIEW_KEYS_MAX = 500;

/** The fleet's spec's class table (§5.4), for class counts whose report names none. */
export const FLEET_CLASSES: Record<string, string> = {
  "1": "out of scope",
  "2": "dead: limit",
  "3": "waiting at a prompt",
  "4": "error",
  "5": "running",
  "6": "hung",
  "7": "blocked on the owner",
  "8": "closed",
  "9": "stalled",
  "9a": "idle, recent",
  "10": "unmanaged",
  unknown: "unknown",
};

/** A Maestro work item the fleet raised (an ask batch or an alert), as the Fleet view links it. */
export const FleetItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  state: z.enum(ORCH_STATES),
  group: z.enum(GROUP_ORDER),
  /** Whether it is in Needs you now (shared/needs-you.ts). */
  needsYou: z.boolean(),
});
export type FleetItem = z.infer<typeof FleetItemSchema>;

export const FleetHealthSchema = z.object({
  status: z.enum(FLEET_HEALTH),
  /** In words, one sentence, with how long when it matters. */
  reason: z.string(),
  /** The same, without a running span: what a notice says (FleetNoticeSchema). */
  notice: z.string(),
  /** When the condition began: the last tick's start for `missed`, the failing tick's for `failing`. */
  since: z.string().nullable(),
  /** The fleet's own open alert item for this condition, when it raised one. */
  item: FleetItemSchema.nullable(),
  /**
   * Whether this needs you on its own: a missed tick, or a failing one on a
   * scheduled scope, and not already in Needs you as the fleet's alert item
   * (`item`; then it is counted once, there) nor answered there since it
   * began (`item` done or canceled after `since`).
   */
  needsYou: z.boolean(),
});
export type FleetHealth = z.infer<typeof FleetHealthSchema>;

export const ClassCountSchema = z.object({ id: z.string(), name: z.string(), count: z.number() });
export type ClassCount = z.infer<typeof ClassCountSchema>;

export const FleetTickSchema = z.object({
  tick: z.number().int(),
  /** When it started (its tick_fire record, else its report's time). */
  at: z.string().nullable(),
  finishedAt: z.string().nullable(),
  status: z.enum(TICK_STATUS),
  exit: z.number().nullable(),
  /** Each step's exit code, as the tick wrote them: `recover=0 observe=0 report=0 ...`. */
  steps: z.string().nullable(),
  /** The first step that failed, as tick.sh names it in its alert (`tick-<step>`). */
  failedStep: z.string().nullable(),
  dryRun: z.boolean().nullable(),
  /** From its report; null when the tick wrote none. */
  mode: z.string().nullable(),
  classCounts: z.array(ClassCountSchema).nullable(),
  openAsks: z.number().nullable(),
  proposals: z.number().nullable(),
});
export type FleetTick = z.infer<typeof FleetTickSchema>;

export const FleetReviewSchema = z.object({
  verdict: z.enum(REVIEW_VERDICTS),
  note: z.string().nullable(),
  at: z.string(),
  /** The tick whose proposal you reviewed. */
  tick: z.number().nullable(),
});
export type FleetReview = z.infer<typeof FleetReviewSchema>;

/**
 * One thing the fleet would do, not done: a `would do` other than nothing in
 * its latest report (`report`, phase 1), or a verb its coordinator logged
 * under dry run (`act`, phase 2). `key` is stable across ticks while the
 * proposal stays the same, so one verdict holds for every tick that repeats it.
 */
export const FleetProposalSchema = z.object({
  key: z.string(),
  source: z.enum(["report", "act"]),
  tick: z.number().nullable(),
  at: z.string().nullable(),
  /** What it would do, in the fleet's words. */
  action: z.string(),
  /** The session it is about (report proposals). */
  session: z
    .object({
      id: z.string(),
      short: z.string(),
      name: z.string().nullable(),
      kind: z.string().nullable(),
      status: z.string().nullable(),
      cwd: z.string().nullable(),
      branch: z.string().nullable(),
      /** Its Paseo agent, when it is one (the report's `paseo_agent`): what Open in Paseo opens. */
      agentId: z.string().nullable(),
    })
    .nullable(),
  classId: z.string().nullable(),
  className: z.string().nullable(),
  evidence: z.string().nullable(),
  /** The coordinator's verb (act proposals): mail, spawn, label or resume. */
  verb: z.string().nullable(),
  review: FleetReviewSchema.nullable(),
});
export type FleetProposal = z.infer<typeof FleetProposalSchema>;

/** A session a fleet ask is about (a `prompt:<session>:…` key), and its Paseo agent when it is one. */
export const AskSessionSchema = z.object({
  id: z.string(),
  short: z.string(),
  name: z.string().nullable(),
  agentId: z.string().nullable(),
});
export type AskSession = z.infer<typeof AskSessionSchema>;

export const FleetAskSchema = z.object({
  id: z.string(),
  key: z.string(),
  question: z.string(),
  class: z.string().nullable(),
  /** The class's name in the fleet's table (FLEET_CLASSES), when the class is one of its numbers. */
  className: z.string().nullable(),
  firstTick: z.number().nullable(),
  session: AskSessionSchema.nullable(),
  /** The batch that carries it now (its ledger intent id), and the Maestro work raised for that batch. */
  batch: z.string().nullable(),
  item: FleetItemSchema.nullable(),
});
export type FleetAsk = z.infer<typeof FleetAskSchema>;

export const DecisionOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  consequence: z.string().nullable(),
  /** null when the ledger does not say. */
  reversible: z.boolean().nullable(),
  recommended: z.boolean(),
});
export type DecisionOption = z.infer<typeof DecisionOptionSchema>;

/**
 * A decision ask in a `.control/asks` ledger in the fleet's own registered
 * root (`<state dir>/.control/asks`, the control interface spec §5.6), with
 * its decision layer: what it costs while it waits, why it is yours, the
 * options and what each does, and what happens if you say nothing.
 */
export const DecisionAskSchema = z.object({
  /** The ledger's file name in the root. */
  ledger: z.string(),
  /** Its identity (§5.2); asks from before v2 have none and go by `id`. */
  uid: z.string().nullable(),
  id: z.string(),
  arc: z.string().nullable(),
  headline: z.string().nullable(),
  question: z.string().nullable(),
  stakes: z.string().nullable(),
  whyYou: z.string().nullable(),
  options: z.array(DecisionOptionSchema),
  /** What happens if you stay silent (`default`). */
  fallback: z.string().nullable(),
  blocking: z.boolean(),
  askedAt: z.string().nullable(),
  answeredAt: z.string().nullable(),
  answer: z.string().nullable(),
  answerOption: z.string().nullable(),
  state: z.enum(["open", "answered", "archived"]),
  /** The session that asked, when the ask is stamped with one. */
  origin: z.object({ agentId: z.string(), cwd: z.string().nullable() }).nullable(),
  /** Why it cannot be answered here, in words (an id collision); null when it can. */
  refusal: z.string().nullable(),
});
export type DecisionAsk = z.infer<typeof DecisionAskSchema>;

export const FleetScopeSchema = z.object({
  id: z.string(),
  /** The config's mode (`report` or `act`) and whether it runs dry. */
  mode: z.string().nullable(),
  dryRun: z.boolean().nullable(),
  health: FleetHealthSchema,
  lastTick: z.object({ tick: z.number(), at: z.string().nullable(), status: z.enum(TICK_STATUS) }).nullable(),
  /** Groups of proposals (groupProposals) still waiting on your verdict. */
  unreviewed: z.number(),
  openAsks: z.number(),
});
export type FleetScope = z.infer<typeof FleetScopeSchema>;

export const FleetDetailSchema = z.object({
  id: z.string(),
  stateDir: z.string(),
  schedule: z.object({ scheduled: z.boolean(), intervalMinutes: z.number().nullable() }),
  /** Newest first. */
  ticks: z.array(FleetTickSchema),
  report: z.object({ tick: z.number(), markdown: z.string(), truncated: z.boolean() }).nullable(),
  proposals: z.array(FleetProposalSchema),
  asks: z.array(FleetAskSchema),
  /** Decision asks in the fleet's own ask root: the open ones, then the latest answered. */
  decisions: z.array(DecisionAskSchema),
  /** That root, where a decision ask's answer is written. */
  askRoot: z.string(),
  /** The fleet's alert items for this scope that are not done or canceled. */
  alerts: z.array(FleetItemSchema),
  /** Files that could not be read, in words. */
  warnings: z.array(z.string()),
});
export type FleetDetail = z.infer<typeof FleetDetailSchema>;

export const FLEET_TICKS = { min: 1, max: 100, default: 24 } as const;
/** report.md is read up to this many bytes. */
export const FLEET_REPORT_BYTES = 128 * 1024;

export const getFleet = defineRpc({
  name: "fleet.get",
  input: z.object({
    /** The scope to read in full; none: the first. */
    scope: z.string().optional(),
    ticks: z.number().int().min(FLEET_TICKS.min).max(FLEET_TICKS.max).default(FLEET_TICKS.default),
  }),
  output: z.object({
    scopes: z.array(FleetScopeSchema),
    detail: FleetDetailSchema.nullable(),
    /** The fleet config could not be read: why, in words. Scopes then come from the state dirs. */
    error: z.string().nullable(),
  }),
});
export type FleetView = z.infer<typeof getFleet.output>;

/** A tick's log section is read up to this much of its end. */
export const TICK_LOG_BYTES = 4096;

/**
 * One tick opened: its report and what its runner logged, asked for when you
 * open its row, so a report and a log travel only to the one who looks.
 */
export const getFleetTick = defineRpc({
  name: "fleet.tick",
  input: z.object({ scope: z.string().min(1), tick: z.number().int().min(0) }),
  output: z.object({
    tick: z.number(),
    /** That tick's own report.md, when it wrote one. */
    report: z.object({ markdown: z.string(), truncated: z.boolean() }).nullable(),
    /** That tick's lines in tick.log, from its start line to its done line (the end of them past TICK_LOG_BYTES). */
    log: z.object({ path: z.string(), text: z.string(), truncated: z.boolean() }).nullable(),
  }),
});
export type FleetTickDetail = z.infer<typeof getFleetTick.output>;

export const ANSWER_NOTE_CHARS = 2000;

/**
 * Your answer to a decision ask in the fleet's ask root, written into its
 * ledger under the shared lock (server/control-asks.ts): the option you chose,
 * your words, or both. Yours alone: never on the agent socket.
 */
export const answerAsk = defineRpc({
  name: "ask.answer",
  input: z.object({
    scope: z.string().min(1),
    ledger: z.string().min(1),
    uid: z.string().min(1).nullable(),
    id: z.string().min(1),
    option: z.string().min(1).nullable(),
    note: z.string().max(ANSWER_NOTE_CHARS).default(""),
  }),
  output: z.object({ ask: DecisionAskSchema }),
});

/**
 * Your verdict on proposals, written to the scope's review file: one line per
 * key, all in one append, or none when any key is no longer proposed. Each key
 * binds the proposal's words (proposalKey), so a verdict cannot land on words
 * you did not see. Yours alone: never on the agent socket.
 */
export const reviewProposal = defineRpc({
  name: "fleet.review",
  input: z.object({
    scope: z.string().min(1),
    keys: z.array(z.string().min(1)).min(1).max(REVIEW_KEYS_MAX),
    verdict: z.enum(REVIEW_VERDICTS),
    note: z.string().max(REVIEW_NOTE_CHARS).default(""),
  }),
  output: z.object({ proposals: z.array(FleetProposalSchema) }),
});

/**
 * Proposals that read the same and stand the same with you, grouped: one
 * class and one action across many sessions, not yet reviewed (or given one
 * verdict and note), is one decision made once for all of them. A session
 * you judged differently stands in a group of its own, so a verdict on a
 * group never overwrites one you gave a single session. A coordinator verb
 * stands alone: its words name one target. Groups keep the fleet's order,
 * the ones still waiting on you first within each action.
 */
export interface ProposalGroup {
  key: string;
  action: string;
  classId: string | null;
  className: string | null;
  source: FleetProposal["source"];
  proposals: FleetProposal[];
  /** The verdict every proposal in the group has (the newest), or null when none has one. */
  review: FleetReview | null;
}

export function groupProposals(proposals: readonly FleetProposal[]): ProposalGroup[] {
  const groups = new Map<string, ProposalGroup & { order: number; rank: number }>();
  const actions = new Map<string, number>();
  for (const proposal of proposals) {
    const what = proposal.source === "act" ? proposal.key : `${proposal.classId ?? ""}:${proposal.action}`;
    const order = actions.get(what) ?? actions.size;
    actions.set(what, order);
    const stands = proposal.review ? `${proposal.review.verdict}:${proposal.review.note ?? ""}` : "";
    const key = `${proposal.source}:${what}:${stands}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        action: proposal.action,
        classId: proposal.classId,
        className: proposal.className,
        source: proposal.source,
        proposals: [],
        review: null,
        order,
        // Waiting first, then accepted, then rejected: deciding a waiting card leaves an accepted one in its
        // place, so a second tap lands on a button that is done, never on a rejection it would overwrite.
        rank: proposal.review ? (proposal.review.verdict === "accept" ? 1 : 2) : 0,
      };
      groups.set(key, group);
    }
    group.proposals.push(proposal);
    if (proposal.review && (!group.review || proposal.review.at > group.review.at)) group.review = proposal.review;
  }
  return [...groups.values()]
    .sort((a, b) => a.order - b.order || a.rank - b.rank)
    .map(({ order: _order, rank: _rank, ...group }) => group);
}

/**
 * A scope's tick that needs you on its own (FleetHealth.needsYou), as
 * work.attention carries it. Its words hold still while the condition lasts
 * (no running span: the client says how long from `since`), so the header
 * count's poller can see nothing changed and slow down.
 */
export const FleetNoticeSchema = z.object({
  scope: z.string(),
  /** `blind`: missed ticks cannot be judged, the Mac's awake time unreadable (server/fleet.ts AwakeClock). */
  status: z.enum(["missed", "failing", "blind"]),
  reason: z.string(),
  since: z.string().nullable(),
});
export type FleetNotice = z.infer<typeof FleetNoticeSchema>;
