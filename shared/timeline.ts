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

export const TimelineRunSchema = z.object({
  /** When it started; for a missed run, when it was due. */
  at: z.string(),
  endedAt: z.string().nullable(),
  status: z.enum(RUN_STATUS),
  /** The process exit code, when one was recorded. */
  exit: z.number().nullable(),
  /** One line on how it ended or what it did: "exit 1", "killed by SIGKILL", Paseo's error, the wake's summary. */
  detail: z.string().nullable(),
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
  since: z.string().nullable(),
  /**
   * Whether this needs you: failed or missed. A fleet scope needs you
   * through the Fleet view (its own notice, or the fleet's alert work), so
   * the timeline never counts it a second time (timelineNotices).
   */
  needsYou: z.boolean(),
  /** The next run, when one is scheduled; it may lie past the window. */
  next: z.string().nullable(),
  /** Runs still to come inside the window, soonest first, `next` among them. Capped at TIMELINE_UPCOMING. */
  upcoming: z.array(z.string()),
  /** Runs inside the window, newest first, missed ones included. Capped at TIMELINE_RUNS. */
  runs: z.array(TimelineRunSchema),
  /** The newest run there is, inside the window or before it. */
  last: TimelineRunSchema.nullable(),
  /** Where its own record lives: a log file, a schedule's folder. */
  where: z.string().nullable(),
  /** The end of its log, for a launchd job: the newest lines, up to TIMELINE_TAIL_BYTES. */
  tail: z.string().nullable(),
  link: SourceLinkSchema.nullable(),
});
export type TimelineSource = z.infer<typeof TimelineSourceSchema>;

export const TIMELINE_RUNS = 120;
export const TIMELINE_UPCOMING = 120;
export const TIMELINE_TAIL_BYTES = 2048;

export const getTimeline = defineRpc({
  name: "timeline.get",
  input: z.object({}),
  output: z.object({
    now: z.string(),
    from: z.string(),
    to: z.string(),
    sources: z.array(TimelineSourceSchema),
    /** What could not be read, in words: a source that failed, a file that did not parse. */
    warnings: z.array(z.string()),
  }),
});
export type TimelineView = z.infer<typeof getTimeline.output>;

/** A source that needs you on its own, as work.attention carries it (never a fleet scope: the Fleet view counts those). */
export const TimelineNoticeSchema = z.object({
  id: z.string(),
  kind: z.enum(SOURCE_KINDS),
  name: z.string(),
  status: z.enum(["failed", "missed"]),
  reason: z.string(),
  since: z.string().nullable(),
});
export type TimelineNotice = z.infer<typeof TimelineNoticeSchema>;
