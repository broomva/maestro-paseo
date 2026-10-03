// RPC contracts for the Timeline view: every scheduled thing on one time
// axis, the past day and the next. Four kinds of source feed it: Paseo's
// schedules and heartbeats, the broomva launchd jobs, Maestro's own loop,
// and fleet-reconcile's ticks (read through the Fleet view, server/fleet.ts).
// Each source has its runs in the window, its next run, and a status; a run
// that failed or was missed is flagged, and while it is the source's latest
// word the source needs you. Read-only: nothing here starts, stops or
// changes a schedule. Plain Zod values: this module is compiled into both
// bundles.

import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** The window either side of now. */
export const TIMELINE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Where a source comes from: a Paseo schedule that starts a new agent
 * (`schedule`), a Paseo heartbeat that prompts an existing one (`heartbeat`),
 * a launchd job (`launchd`), Maestro's loop (`loop`), or a fleet-reconcile
 * scope's ticks (`fleet`).
 */
export const SOURCE_KINDS = ["schedule", "heartbeat", "launchd", "loop", "fleet"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * One run:
 * - `ok`: it finished, and its exit (or Paseo's own word) says it worked;
 * - `failed`: it finished and failed (a non-zero exit, a signal, or Paseo's `failed`);
 * - `running`: it started and has not finished;
 * - `missed`: it was due and never started (drawn at the time it was due);
 * - `skipped`: it was asked for and did not run, by design (a loop wake while another ran);
 * - `unknown`: it ran, and nothing recorded how it ended.
 */
export const RUN_STATUS = ["ok", "failed", "running", "missed", "skipped", "unknown"] as const;
export type RunStatus = (typeof RUN_STATUS)[number];

/**
 * A source now: `ok` (on time, its latest run worked), `running`, `failed`
 * (its latest run failed), `missed` (a run came due and did not start),
 * `off` (nothing will run: paused, unloaded, completed, or turned off), or
 * `unknown` (nothing read says either way).
 */
export const SOURCE_STATUS = ["ok", "running", "failed", "missed", "off", "unknown"] as const;
export type SourceStatus = (typeof SOURCE_STATUS)[number];

/** An instant on the wire: always an ISO string in UTC, as the server writes every one (`toISOString`). */
export const InstantSchema = z.iso.datetime();

export const TimelineRunSchema = z.object({
  /** When it started; for a missed run, when it was due. */
  at: InstantSchema,
  endedAt: InstantSchema.nullable(),
  status: z.enum(RUN_STATUS),
  /** The process exit code, when one was recorded. */
  exit: z.number().nullable(),
  /** One line on how it ended or what it did: "exit 1", "killed by SIGKILL", Paseo's error, the wake's summary. */
  detail: z.string().nullable(),
  /** The Paseo session the run started or prompted (schedule and heartbeat runs): what tapping the run opens. */
  agentId: z.string().optional(),
  /** The workspace Paseo ran it in, when it recorded one. */
  workspaceId: z.string().optional(),
  /** The start of the run's last message, as Paseo kept it (up to RUN_OUTPUT_CHARS). */
  output: z.string().optional(),
  /** A fleet run's tick: what tapping it opens in the Fleet view. */
  tick: z.number().int().optional(),
});
export type TimelineRun = z.infer<typeof TimelineRunSchema>;

/** What a source has to open from the timeline: the fleet scope, the loop's panel, or the run's Paseo session. */
export const SourceLinkSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fleet"), scope: z.string() }),
  z.object({ kind: z.literal("loop") }),
  z.object({ kind: z.literal("agent"), agentId: z.string() }),
]);
export type SourceLink = z.infer<typeof SourceLinkSchema>;

export const TimelineSourceSchema = z.object({
  /** Stable across reads: `launchd:com.broomva.kg-lint`, `schedule:63cc3450`, `loop`, `fleet:broomva`. */
  id: z.string(),
  kind: z.enum(SOURCE_KINDS),
  name: z.string(),
  /** How often it runs, in words: "every 15 minutes", "Sundays at 02:30", "cron 0 9 * * * (America/Bogota)". */
  cadence: z.string(),
  status: z.enum(SOURCE_STATUS),
  /** The status in one sentence. */
  reason: z.string(),
  /** When the status began: the failed run's start, the missed run's due time. */
  since: InstantSchema.nullable(),
  /**
   * Whether this needs you: failed or missed. A fleet scope needs you
   * through the Fleet view (its own notice, or the fleet's alert work), so
   * the timeline never counts it a second time (timelineNotices).
   */
  needsYou: z.boolean(),
  /** The next run, when one is scheduled; it may lie past the window. */
  next: InstantSchema.nullable(),
  /** Runs still to come inside the window, soonest first, `next` among them. Capped at TIMELINE_UPCOMING. */
  upcoming: z.array(InstantSchema),
  /** Runs inside the window, newest first, missed ones included. Capped at TIMELINE_RUNS. */
  runs: z.array(TimelineRunSchema),
  /** More runs fell in the window than TIMELINE_RUNS: the oldest are not sent, nor drawn. */
  runsCut: z.boolean(),
  /** The newest run there is, inside the window or before it. */
  last: TimelineRunSchema.nullable(),
  /** Where its own record lives: a launchd job's log, a schedule's file, the loop's wake log. */
  where: z.string().nullable(),
  /** Whether timeline.log has a log end to show for it (a launchd job with a log). */
  hasLog: z.boolean(),
  link: SourceLinkSchema.nullable(),
});
export type TimelineSource = z.infer<typeof TimelineSourceSchema>;

/** Enough for a run every five minutes across the past day. */
export const TIMELINE_RUNS = 300;
export const TIMELINE_UPCOMING = 300;
export const TIMELINE_TAIL_BYTES = 2048;
/** A run's output is sent up to this many characters: every open client polls the timeline. */
export const RUN_OUTPUT_CHARS = 280;

export const getTimeline = defineRpc({
  name: "timeline.get",
  input: z.object({}),
  output: z.object({
    now: InstantSchema,
    from: InstantSchema,
    to: InstantSchema,
    sources: z.array(TimelineSourceSchema),
    /** What could not be read, in words: a source that failed, a file that did not parse. */
    warnings: z.array(z.string()),
  }),
});
export type TimelineView = z.infer<typeof getTimeline.output>;

/**
 * The end of a launchd job's log, asked for when you open its row: kept out
 * of timeline.get, which every open client polls, so a log's lines travel
 * only to the one who looks. `tail` is null when the job has no log to read.
 */
export const getTimelineLog = defineRpc({
  name: "timeline.log",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ path: z.string().nullable(), tail: z.string().nullable() }),
});

/** A source that needs you on its own, as work.attention carries it (never a fleet scope: the Fleet view counts those). */
export const TimelineNoticeSchema = z.object({
  id: z.string(),
  kind: z.enum(SOURCE_KINDS),
  name: z.string(),
  status: z.enum(["failed", "missed"]),
  /** Without a running span, so the header count's read changes only when what needs you does. */
  reason: z.string(),
  since: InstantSchema.nullable(),
});
export type TimelineNotice = z.infer<typeof TimelineNoticeSchema>;
