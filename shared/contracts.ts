// RPC contracts between the Maestro surfaces and the daemon-side work store.
// Plain Zod values only: this module is compiled into both bundles.

import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { GATE_MODES, GROUP_ORDER, KINDS, ORCH_STATES, VERDICTS } from "./states";

export const WorkerSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string().nullable(),
  provider: z.string(),
  branch: z.string().nullable(),
  cwd: z.string().nullable(),
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

export const ISOLATIONS = ["worktree", "directory"] as const;

const CAP = "The concurrency cap is a whole number of runs, 1 or more, or empty for no cap";

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

export const createWork = defineRpc({
  name: "work.create",
  input: z.object({
    title: z.string().trim().min(1, "Give the work a title"),
    brief: z.string(),
    repo: z.string().trim().min(1, "Choose where the work runs"),
    /** Omitted: the configured default gate. */
    gate: z.enum(GATE_MODES).optional(),
    check: z.string(),
    initiative: z.string(),
    dispatch: z.boolean(),
  }),
  output: ItemResult,
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

/** Stop a running run: its session is archived and the work is stuck, with the branch kept. */
export const stopWork = defineRpc({ name: "work.stop", input: ById, output: ItemResult });

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
