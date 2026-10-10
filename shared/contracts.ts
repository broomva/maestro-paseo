// RPC contracts between the Maestro surfaces and the daemon-side work store.
// Plain Zod values only: this module is compiled into both bundles.

import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { AnswersLandingSchema, AnswersNoticeSchema, ROUTES } from "./answers";
import { AskNoticeSchema, FleetNoticeSchema } from "./fleet";
import { InitiativeNoticeSchema } from "./initiatives";
import { LoopNoticeSchema } from "./loops";
import { GATE_MODES, GROUP_ORDER, KINDS, ORCH_STATES, VERDICTS } from "./states";
import { TICKET } from "./text";
import { TimelineNoticeSchema } from "./timeline";

/** Bounds on what a work may pass to a provider as feature values. */
export const ISOLATIONS = ["worktree", "directory"] as const;

export const FEATURE_LIMITS = { keys: 32, chars: 200 } as const;

/** A provider feature's value: a toggle is a boolean, a select is an option id or null. */
export const FeatureValueSchema = z.union([z.string().max(FEATURE_LIMITS.chars), z.number(), z.boolean(), z.null()]);
export type FeatureValue = z.infer<typeof FeatureValueSchema>;
export const FeatureValuesSchema = z
  .record(z.string().min(1).max(FEATURE_LIMITS.chars), FeatureValueSchema)
  .refine((values) => Object.keys(values).length <= FEATURE_LIMITS.keys, {
    message: `At most ${FEATURE_LIMITS.keys} feature values`,
  });
export type FeatureValues = z.infer<typeof FeatureValuesSchema>;

export const WorkerSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string().nullable(),
  provider: z.string(),
  branch: z.string().nullable(),
  cwd: z.string().nullable(),
  /** How the run was started, beyond the provider; absent on runs recorded before these were kept. */
  modeId: z.string().nullable().optional(),
  thinkingOptionId: z.string().nullable().optional(),
  featureValues: FeatureValuesSchema.nullable().optional(),
  /** The same, in words: `claude/opus (mode bypassPermissions, thinking high)`. */
  startedWith: z.string().optional(),
});
export type Worker = z.infer<typeof WorkerSchema>;

/** What the human sees at the gate: receipts, never a percentage. */
export const LookSchema = z.object({
  ran: z.string(),
  decided: z.array(z.string()),
  /** What it asks of you in its own words; empty when it asked nothing (the card then says what the verbs do). */
  ask: z.string(),
  /**
   * The arc's own verdict, when the last turn's text ends one the workspace's
   * way: its last line that starts exactly `ARC-STATUS: WORD` (ctx-core's
   * grammar), the word, and the line as written. Absent from an older daemon.
   */
  arc: z.object({ status: z.string(), line: z.string() }).nullable().optional(),
  /** With an arc verdict, the block of text just above that line, verbatim: what the arc left you. */
  closing: z.string().nullable().optional(),
  /** The session it ran in was archived after it reached the gate. */
  archived: z.boolean().optional(),
  /** What it handed you, verbatim: the body of its `## ⛔ Blocked on you` block (a table, as the handback skill writes it). */
  handed: z.string().nullable().optional(),
});
export type Look = z.infer<typeof LookSchema>;

export const PermissionSchema = z.object({
  requestId: z.string(),
  title: z.string(),
  detail: z.string().nullable(),
});
export type Permission = z.infer<typeof PermissionSchema>;

export const CheckSpecSchema = z.object({ name: z.string(), run: z.string() });
export type CheckSpec = z.infer<typeof CheckSpecSchema>;

export const CheckResultSchema = z.object({
  name: z.string(),
  run: z.string(),
  required: z.boolean(),
  ok: z.boolean(),
  exit: z.number().nullable(),
  durationMs: z.number(),
  timedOut: z.boolean(),
  tail: z.string(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const PHASES = ["working", "checking", "asking"] as const;

/** Lines added and removed in a run's workspace, as Paseo reports them. */
export const DiffStatSchema = z.object({ additions: z.number(), deletions: z.number() });
export type DiffStat = z.infer<typeof DiffStatSchema>;

/** The run choices Settings can fill when a work leaves them unset. Thinking and features are the work's alone. */
export const SETTINGS_FIELDS = ["provider", "isolation", "modeId"] as const;

export const NextRunSchema = z.object({
  /** `provider` or `provider/model`; a bare provider takes its default model at dispatch. */
  provider: z.string(),
  isolation: z.enum(ISOLATIONS),
  modeId: z.string().nullable(),
  thinkingOptionId: z.string().nullable(),
  featureValues: FeatureValuesSchema.nullable(),
  /** The fields above that came from Settings because the work left them unset. */
  fromSettings: z.array(z.enum(SETTINGS_FIELDS)),
  /**
   * Why only you start this work (`hold` in _work.md, or, for queued work the
   * routing before A8 filed from an answer, that), or null: absent from an older daemon.
   */
  held: z.string().nullable().optional(),
});
export type NextRun = z.infer<typeof NextRunSchema>;

/**
 * A decision at the gate that has not taken effect yet. It applies when the
 * undo window closes, unless it is undone first.
 */
export const PendingSchema = z.object({
  verdict: z.enum(VERDICTS),
  note: z.string(),
  decidedAt: z.string(),
  effectiveAt: z.string(),
  /** Time left in the undo window when this was read; 0 once it is due. */
  remainingMs: z.number(),
});
export type Pending = z.infer<typeof PendingSchema>;

/**
 * Why the loop put work in Needs you, raised by a wake: a run quiet for 30
 * minutes or more (`quiet`). Since the loop stopped starting work (A8,
 * BRO-2990) it raises no other kind; `yours` (queued work it left to you) and
 * `failed` (a start it tried that failed) stay so older flags still read.
 */
export const FLAG_KINDS = ["yours", "failed", "quiet"] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];

/** The loop's current flag on a work: its kind, the reason in words, and when the loop raised it. */
export const FlagSchema = z.object({ kind: z.enum(FLAG_KINDS), reason: z.string(), at: z.string() });
export type Flag = z.infer<typeof FlagSchema>;

export const WorkItemSchema = z.object({
  id: z.string(),
  path: z.string(),
  title: z.string(),
  kind: z.enum(KINDS),
  state: z.enum(ORCH_STATES),
  group: z.enum(GROUP_ORDER),
  gate: z.enum(GATE_MODES),
  owner: z.string().nullable(),
  initiative: z.string().nullable(),
  project: z.string().nullable(),
  repo: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastEventAt: z.string().nullable(),
  phase: z.enum(PHASES).nullable(),
  worker: WorkerSchema.nullable(),
  /** The run's workspace diff stat, read best effort by work.list and work.get; null when unknown. */
  changed: DiffStatSchema.nullable().optional(),
  reason: z.string().nullable(),
  verdict: z.string().nullable(),
  look: LookSchema.nullable(),
  permission: PermissionSchema.nullable(),
  checks: z.array(CheckSpecSchema),
  /**
   * How the next run would start: the work's choices with Settings filling the
   * rest, computed by the same function dispatch uses (server/runs.ts
   * runSettings). Absent only on items built without Settings, such as test fixtures.
   */
  nextRun: NextRunSchema.nullable().optional(),
  /** The latest move into review, as its index in the event log; kept after the work leaves review. */
  landing: z.number().int().optional(),
  pending: PendingSchema.nullable(),
  /**
   * The loop's flag: this work needs you though it is not at your gate or
   * stuck. Null once anything else happens to the work (server/events.ts flagOf).
   */
  flag: FlagSchema.nullable(),
  /**
   * How a person reads it (shared/fleet-item.ts fleetHeading): the title with
   * a fleet-reconcile marker dropped (an old `1 ask (tick 7)` title becomes its
   * first ask), and for fleet work where it came from. `title` stays raw: the
   * fleet finds its items by the marker. Absent from older daemons.
   */
  /** Who closed finished work and when (server/events.ts closedOf); absent from an older daemon. */
  closed: z
    .object({ by: z.enum(["you", "maestro"]), at: z.string() })
    .nullable()
    .optional(),
  /**
   * The agent that adopted it, an orchestrator. work.list names it by its session title (null when unknown);
   * elsewhere `by` is the agent id the receipt holds. Absent from an older daemon.
   */
  adoptedBy: z.object({ by: z.string().nullable() }).nullable().optional(),
  /** The work the adopting session runs as, when Maestro tracks it (BRO-2908); absent from an older daemon. */
  parentWork: z.string().nullable().optional(),
  /** The ticket it is for: given when it was adopted, else read from its title; absent from an older daemon. */
  ticket: z.string().nullable().optional(),
  display: z
    .object({
      title: z.string(),
      fleet: z.object({ scope: z.string(), what: z.string(), tick: z.string().nullable() }).nullable(),
    })
    .optional(),
});
export type WorkItem = z.infer<typeof WorkItemSchema>;

export const ACTORS = ["human", "agent", "maestro"] as const;

export const WorkEventSchema = z.object({
  ts: z.string(),
  type: z.string(),
  actor: z.enum(ACTORS),
  text: z.string(),
  detail: z.string().nullable(),
});
export type WorkEventWire = z.infer<typeof WorkEventSchema>;

export const WeekDaySchema = z.object({
  /** The local calendar day, YYYY-MM-DD. */
  date: z.string(),
  unsupervisedMs: z.number(),
  looks: z.number(),
  longestRunMs: z.number(),
});
export type WeekDay = z.infer<typeof WeekDaySchema>;

export const ScoreboardSchema = z.object({
  unsupervisedMs: z.number(),
  looks: z.number(),
  longestRunMs: z.number(),
  live: z.boolean(),
  /** Fractions of the local day, 0 to 1. */
  segments: z.array(z.object({ start: z.number(), width: z.number(), live: z.boolean() })),
  notches: z.array(z.number()),
  /** The last seven local days, oldest first and today last, scored by the same rules as today. */
  week: z.array(WeekDaySchema).default([]),
  /** Unsupervised time this week per initiative (null: work outside any), most first. */
  weekByInitiative: z.array(z.object({ initiative: z.string().nullable(), unsupervisedMs: z.number() })).default([]),
});
export type Scoreboard = z.infer<typeof ScoreboardSchema>;

const CAP = "The concurrency cap is a whole number of runs, 1 or more, or empty for no cap";
/** The longest period the loop takes, in minutes: one day. */
export const LOOP_MAX_MINUTES = 1440;
const LOOP_EVERY = `The loop wakes every whole number of minutes from 1 to ${LOOP_MAX_MINUTES} (a day), or empty for off`;

export const ConfigSchema = z.object({
  workRoot: z.string().min(1),
  provider: z.string().min(1),
  modeId: z.string().nullable(),
  isolation: z.enum(ISOLATIONS),
  /** Runs that may work at once; null for no cap. A dispatch at the cap is refused and the work stays queued. */
  concurrencyCap: z.number().int(CAP).positive(CAP).nullable(),
  /** Archive a run's workspace when its approval applies, so the worktree goes; the branch stays. */
  archiveOnApprove: z.boolean(),
  /** The gate new work gets when the form does not say. */
  defaultGate: z.enum(GATE_MODES),
  /**
   * How often the loop (server/loop.ts) wakes to flag quiet runs and act on
   * your answers, in minutes; null for off. It never starts work (A8,
   * BRO-2990). Off by default, so it is yours to turn on. At most a day, so
   * the next wake is always a time a timer can hold.
   */
  loopMinutes: z.number().int(LOOP_EVERY).positive(LOOP_EVERY).max(LOOP_MAX_MINUTES, LOOP_EVERY).nullable(),
});
export type MaestroConfig = z.infer<typeof ConfigSchema>;

const ItemResult = z.object({ item: WorkItemSchema });
const ById = z.object({ id: z.string().min(1) });

export const listWork = defineRpc({
  name: "work.list",
  input: z.object({}),
  output: z.object({
    root: z.string(),
    items: z.array(WorkItemSchema),
    scoreboard: ScoreboardSchema,
    warnings: z.array(z.string()),
  }),
});

export const getWork = defineRpc({
  name: "work.get",
  input: ById,
  output: z.object({
    item: WorkItemSchema,
    brief: z.string(),
    events: z.array(WorkEventSchema),
    checkResults: z.array(CheckResultSchema),
  }),
});

export type Isolation = (typeof ISOLATIONS)[number];

/**
 * How one work item's runs start, chosen in the composer. Every field is
 * optional: an absent one means the Settings value at dispatch time.
 */
export const RunChoicesSchema = z.object({
  isolation: z.enum(ISOLATIONS).optional(),
  /** `provider` or `provider/model`, as Settings takes it. */
  provider: z.string().trim().min(1).optional(),
  modeId: z.string().trim().min(1).optional(),
  thinkingOptionId: z.string().trim().min(1).optional(),
  featureValues: FeatureValuesSchema.optional(),
});
export type RunChoices = z.infer<typeof RunChoicesSchema>;

export const createWork = defineRpc({
  name: "work.create",
  input: RunChoicesSchema.extend({
    /** Optional: a blank title takes the brief's first line. */
    title: z.string().optional(),
    brief: z.string(),
    repo: z.string().trim().min(1, "Choose where the work runs"),
    /** Omitted: the configured default gate. */
    gate: z.enum(GATE_MODES).optional(),
    check: z.string(),
    initiative: z.string(),
    dispatch: z.boolean(),
  }),
  /** `notice`: why work asked to dispatch was created but not started (the concurrency cap). */
  output: ItemResult.extend({ notice: z.string().nullable() }),
});

/** A folder as the daemon sees it: `~` expanded, and whether runs can branch from it. */
export const inspectFolder = defineRpc({
  name: "folder.inspect",
  input: z.object({ path: z.string() }),
  output: z.object({ path: z.string(), directory: z.boolean(), git: z.boolean() }),
});

export const dispatchWork = defineRpc({ name: "work.dispatch", input: ById, output: ItemResult });

export const decideWork = defineRpc({
  name: "work.verdict",
  input: z.object({ id: z.string().min(1), verdict: z.enum(VERDICTS), note: z.string() }),
  output: ItemResult,
});

export const unblockWork = defineRpc({
  name: "work.unblock",
  input: z.object({ id: z.string().min(1), note: z.string() }),
  output: ItemResult,
});

export const cancelWork = defineRpc({ name: "work.cancel", input: ById, output: ItemResult });

/** Take back a decision at the gate before it takes effect. */
export const undoWork = defineRpc({ name: "work.undo", input: ById, output: ItemResult });

/**
 * Stop a running run, or one paused on the agent's question: its session is archived and the
 * work is stuck, with the branch kept.
 * Refused, with a message that starts NOT_STOPPED, while the run's worktree holds work that
 * is not committed; `discard: true` stops it anyway, once you have confirmed that loss.
 */
export const stopWork = defineRpc({
  name: "work.stop",
  input: ById.extend({ discard: z.boolean().optional() }),
  output: ItemResult,
});

/** How a Stop refused because it would delete work that is not committed begins. */
export const NOT_STOPPED = "Not stopped:";

/**
 * Leave a run the loop flagged as quiet running: yours alone, never on the
 * agent socket. It writes your receipt, which clears the flag and restarts the
 * quiet clock from now. Refused unless the work is running with a quiet flag.
 * A `yours` or `failed` flag clears when you act on the work (dispatch, cancel).
 */
export const leaveRunning = defineRpc({ name: "work.leave-running", input: ById, output: ItemResult });

export const adoptAgent = defineRpc({
  name: "work.adopt",
  input: z.object({
    agentId: z.string().min(1),
    title: z.string(),
    ticket: z.string().regex(TICKET, "A ticket is a team key and a number, like BRO-2908").optional(),
  }),
  output: ItemResult,
});

export const workForAgent = defineRpc({
  name: "work.for-agent",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({ item: WorkItemSchema.nullable() }),
});

export const getConfig = defineRpc({
  name: "config.get",
  input: z.object({}),
  output: ConfigSchema,
});

export const setConfig = defineRpc({
  name: "config.set",
  input: ConfigSchema,
  output: ConfigSchema,
});

/**
 * What the header count and the composer pills show, read from the work files
 * alone: it never reconciles against sessions, so polling it costs no agent
 * round trips. `waiting` is the work that needs you: at your gate or stuck
 * first, then work the loop flagged (`flag`, null for the others); `sessions`
 * are the workers of work that is live or changed in the last day; `fleet`
 * are fleet scopes whose tick is missed or failing and needs you on its own
 * (shared/fleet.ts FleetHealth.needsYou); `timeline` are the other scheduled
 * sources whose run failed or was missed (shared/timeline.ts); `asks` are
 * decision asks that wait on you (blocking, or recommending what cannot be
 * undone); `initiatives` are initiatives past their review date or parked
 * ones whose wake date came (shared/initiatives.ts). The header count counts all five.
 */
export const attentionWork = defineRpc({
  name: "work.attention",
  input: z.object({}),
  output: z.object({
    waiting: z.array(z.object({ id: z.string(), group: z.enum(GROUP_ORDER), flag: FlagSchema.nullable() })),
    sessions: z.array(
      z.object({
        workId: z.string(),
        title: z.string(),
        state: z.enum(ORCH_STATES),
        agentId: z.string(),
        workspaceId: z.string().nullable(),
      }),
    ),
    /** Absent from a daemon older than the fleet notices. */
    fleet: z.array(FleetNoticeSchema).optional(),
    /** Scheduled sources whose run failed or was missed (shared/timeline.ts); absent from a daemon older than the timeline. */
    timeline: z.array(TimelineNoticeSchema).optional(),
    /** Decision asks waiting on you (shared/fleet.ts isWaiting), the workspace's and each fleet root's; absent from an older daemon. */
    asks: z.array(AskNoticeSchema).optional(),
    /** Initiatives past their review date, or parked ones whose wake date came (shared/initiatives.ts); absent from an older daemon. */
    initiatives: z.array(InitiativeNoticeSchema).optional(),
    /** The answers batch, while answers wait to land or it cannot take main (shared/answers.ts); absent from an older daemon. */
    answers: z.array(AnswersNoticeSchema).optional(),
    /** Loop drift that needs you, each with its pinned fix (shared/loops.ts loopNeeds()); absent from an older daemon. */
    loops: z.array(LoopNoticeSchema).optional(),
  }),
});
export type Attention = z.infer<typeof attentionWork.output>;

// ── The loop ─────────────────────────────────────────────────────────────────

const Named = z.object({ id: z.string(), title: z.string() });

/**
 * One wake of the loop, as its log keeps it: why it woke, what needs you,
 * which runs have gone quiet, the flags it raised in Needs you, and what
 * became of your answers. `dispatched` and `deferred` (what it started, what
 * it left alone and why) stay empty since the loop stopped starting work (A8,
 * BRO-2990), kept so older entries still read. `narrative` is the same in plain words,
 * one line each. A wake asked for while another ran is `skipped` (the
 * reason), with empty lists and zero counts: read `skipped` first.
 */
export const WakeEntrySchema = z.object({
  tickId: z.string(),
  cause: z.enum(["timer", "manual"]),
  wokeAt: z.string(),
  dispatched: z.array(Named),
  deferred: z.array(Named.extend({ reason: z.string() })),
  /** At your gate (a result to judge), stuck, and asking a question. */
  needsYou: z.object({ gate: z.number(), stuck: z.number(), asking: z.number() }),
  /**
   * Running work with nothing new for 30 minutes or more, by Maestro's events
   * and by its session's own activity; `minutes` counts from the later of the two.
   */
  quiet: z.array(Named.extend({ minutes: z.number() })),
  /**
   * Running work quiet by Maestro's events, or flagged quiet, whose session
   * could not be asked how recently it worked (`reason`), so its quiet was
   * neither flagged nor cleared. Absent on entries written before the
   * session was asked.
   */
  unasked: z.array(Named.extend({ reason: z.string() })).default([]),
  /**
   * The flags this wake raised: only those it wrote, so a work already
   * flagged the same way is not listed again. Absent on entries written
   * before flags existed.
   */
  flagged: z.array(Named.extend({ kind: z.enum(FLAG_KINDS), reason: z.string() })).default([]),
  /**
   * Running work whose quiet flag this wake took down: its session, asked,
   * had worked since the flag was raised and within the quiet threshold.
   * Absent on entries written before the loop cleared flags.
   */
  cleared: z.array(Named).default([]),
  /**
   * The answers step (server/answers-landing.ts, server/answer-routes.ts):
   * the batch as this wake left it, and each answer it routed. Null when
   * Maestro reads no control repo; absent on entries written before it.
   */
  answers: z
    .object({
      landing: AnswersLandingSchema.nullable(),
      routed: z.array(z.object({ ledger: z.string(), id: z.string(), route: z.enum(ROUTES), words: z.string() })),
      /** Answers due to be routed that wait: a session at work, or not landed yet. */
      waiting: z.number().int().min(0),
    })
    .nullable()
    .optional(),
  narrative: z.array(z.string()),
  skipped: z.string().optional(),
});
export type WakeEntry = z.infer<typeof WakeEntrySchema>;

/** The loop now: every how many minutes (null: off), its next wake, whether one is running, and the newest wakes first. */
export const getLoop = defineRpc({
  name: "loop.get",
  input: z.object({}),
  output: z.object({
    minutes: z.number().nullable(),
    nextAt: z.string().nullable(),
    ticking: z.boolean(),
    recent: z.array(WakeEntrySchema),
  }),
});

/** Wake the loop now. Returns this wake's entry, or a skipped one when a wake is already running. */
export const wakeLoop = defineRpc({ name: "loop.wake", input: z.object({}), output: WakeEntrySchema });
