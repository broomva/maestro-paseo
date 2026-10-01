// RPC contracts between the Maestro surfaces and the daemon-side work store.
// Plain Zod values only: this module is compiled into both bundles.

import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { GATE_MODES, GROUP_ORDER, KINDS, ORCH_STATES, VERDICTS } from "./states";

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
  ask: z.string(),
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
   * How often the loop (server/loop.ts) wakes to start queued work, in
   * minutes; null for off. Off by default: the loop starts work on its own,
   * so it is yours to turn on. At most a day, so the next wake is always a
   * time a timer can hold.
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
 * Stop a running run: its session is archived and the work is stuck, with the branch kept.
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

export const adoptAgent = defineRpc({
  name: "work.adopt",
  input: z.object({ agentId: z.string().min(1), title: z.string() }),
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
 * round trips. `waiting` is the work at your gate or stuck; `sessions` are the
 * workers of work that is live or changed in the last day.
 */
export const attentionWork = defineRpc({
  name: "work.attention",
  input: z.object({}),
  output: z.object({
    waiting: z.array(z.object({ id: z.string(), group: z.enum(GROUP_ORDER) })),
    sessions: z.array(
      z.object({
        workId: z.string(),
        title: z.string(),
        state: z.enum(ORCH_STATES),
        agentId: z.string(),
        workspaceId: z.string().nullable(),
      }),
    ),
  }),
});
export type Attention = z.infer<typeof attentionWork.output>;

// ── The loop ─────────────────────────────────────────────────────────────────

const Named = z.object({ id: z.string(), title: z.string() });

/**
 * One wake of the loop, as its log keeps it: why it woke, what it started,
 * what it left alone and why, what needs you, and which runs have gone quiet.
 * `narrative` is the same in plain words, one line each. A wake asked for
 * while another ran is `skipped` (the reason), with empty lists and zero
 * counts: read `skipped` first.
 */
export const WakeEntrySchema = z.object({
  tickId: z.string(),
  cause: z.enum(["timer", "manual"]),
  wokeAt: z.string(),
  dispatched: z.array(Named),
  deferred: z.array(Named.extend({ reason: z.string() })),
  /** At your gate (a result to judge), stuck, and asking a question. */
  needsYou: z.object({ gate: z.number(), stuck: z.number(), asking: z.number() }),
  /** Running work with no event for 30 minutes or more. */
  quiet: z.array(Named.extend({ minutes: z.number() })),
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
