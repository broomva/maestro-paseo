// The timeline's sources, built from what each one keeps, pure: a Paseo
// schedule or heartbeat from the daemon's schedule file, a launchd job from
// what server/launchd.ts read, Maestro's loop from its state and wake log,
// and a fleet scope from the Fleet view's read (server/fleet.ts). Each says
// its runs in the window, its next run, and a status: failed when its newest
// run failed, missed when a run came due and did not start. The I/O is
// server/timeline.ts.

import { z } from "zod";
import type { WakeEntry } from "../shared/contracts";
import type { FleetDetail, FleetScope, TickStatus } from "../shared/fleet";
import {
  type RunStatus,
  type SourceStatus,
  TIMELINE_RUNS,
  TIMELINE_TAIL_BYTES,
  TIMELINE_UPCOMING,
  type TimelineNotice,
  type TimelineRun,
  type TimelineSource,
} from "../shared/timeline";
import { calendarCadence, calendarSpecs, dueTimes, everyWords, knownZone, parseCron } from "./cron";
import { plistName } from "./fleet";
import type { LaunchdJob } from "./launchd";
import {
  type LaunchdExit,
  type LaunchdSchedule,
  launchdRuns,
  launchdStatus,
  launchdUpcoming,
  logStamps,
  stampRuns,
} from "./launchd-model";

/** A Paseo schedule counts as missed this long after its next run was due with no run started. */
export const SCHEDULE_GRACE_MS = 10 * 60_000;
/** The loop counts as missed this long after its wake was due (or after the Mac woke, if later). */
export const LOOP_GRACE_MS = 5 * 60_000;

/** Now and the window either side of it. */
export interface Window {
  now: number;
  from: number;
  to: number;
}

const iso = (at: number) => new Date(at).toISOString();
const ms = (at: string | null | undefined) => {
  if (!at) return null;
  const parsed = Date.parse(at);
  return Number.isNaN(parsed) ? null : parsed;
};
/** A time read from someone else's file, as the wire carries it (shared/timeline.ts InstantSchema); null when it is not one. */
const instant = (at: string | null | undefined) => {
  const parsed = ms(at);
  return parsed === null ? null : iso(parsed);
};
/** A run starting this close to its due time is the run that was due. */
const DUE_SLACK_MS = 2 * 60_000;

/** The runs a window shows, newest first: begun before its end, ended (or still going) after its start. */
export function inWindow(runs: readonly TimelineRun[], window: Window): TimelineRun[] {
  return runs
    .filter((run) => {
      const start = ms(run.at) ?? 0;
      const end = run.endedAt ? (ms(run.endedAt) ?? start) : run.status === "running" ? window.now : start;
      return start <= window.now && end >= window.from;
    })
    .sort((a, b) => (ms(b.at) ?? 0) - (ms(a.at) ?? 0))
    .slice(0, TIMELINE_RUNS);
}

/** The newest run that ran (missed ones did not). */
function lastRun(runs: readonly TimelineRun[]): TimelineRun | null {
  let newest: TimelineRun | null = null;
  for (const run of runs) {
    if (run.status === "missed") continue;
    if (!newest || (ms(run.at) ?? 0) > (ms(newest.at) ?? 0)) newest = run;
  }
  return newest;
}

const needs = (status: SourceStatus) => status === "failed" || status === "missed";

/** Times `every` apart from `first` while within `to`, at most `limit`, each after `now`. */
function series(first: number, every: number, now: number, to: number, limit: number): number[] {
  const out: number[] = [];
  if (every <= 0) return out;
  let at = first;
  if (at <= now) at += Math.ceil((now - at + 1) / every) * every;
  for (; at <= to && out.length < limit; at += every) out.push(at);
  return out;
}

// ── Paseo schedules and heartbeats ───────────────────────────────────────────

/** A schedule as the Paseo daemon stores it (`<paseo home>/schedules/<id>.json`), read for what the timeline needs. */
export const StoredScheduleSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable().optional(),
  prompt: z.string().optional(),
  cadence: z.discriminatedUnion("type", [
    z.object({ type: z.literal("every"), everyMs: z.number().positive() }),
    z.object({ type: z.literal("cron"), expression: z.string().min(1), timezone: z.string().optional() }),
  ]),
  target: z.discriminatedUnion("type", [
    z.object({ type: z.literal("agent"), agentId: z.string() }),
    z.object({ type: z.literal("new-agent"), config: z.object({ cwd: z.string().optional() }).passthrough() }),
  ]),
  status: z.enum(["active", "paused", "completed"]),
  nextRunAt: z.string().nullable(),
  expiresAt: z.string().nullable().optional(),
  maxRuns: z.number().int().positive().nullable().optional(),
  runs: z
    .array(
      z.object({
        scheduledFor: z.string(),
        startedAt: z.string(),
        endedAt: z.string().nullable(),
        status: z.enum(["running", "succeeded", "failed"]),
        agentId: z.string().nullable().optional(),
        error: z.string().nullable().optional(),
      }),
    )
    .default([]),
});
export type StoredSchedule = z.infer<typeof StoredScheduleSchema>;

const PASEO_STATUS: Record<StoredSchedule["runs"][number]["status"], RunStatus> = {
  running: "running",
  succeeded: "ok",
  failed: "failed",
};

/** A name to show: the schedule's own, else its prompt's first line. */
export function scheduleName(schedule: Pick<StoredSchedule, "id" | "name" | "prompt" | "target">): string {
  const named = schedule.name?.trim();
  if (named) return named;
  const line =
    (schedule.prompt ?? "")
      .split("\n")
      .find((one) => one.trim())
      ?.trim() ?? "";
  if (line) return line.length > 60 ? `${line.slice(0, 59)}…` : line;
  return schedule.target.type === "agent" ? `Heartbeat ${schedule.id}` : `Schedule ${schedule.id}`;
}

export function scheduleCadence(cadence: StoredSchedule["cadence"]): string {
  if (cadence.type === "every") return everyWords(cadence.everyMs);
  const zone = cadence.timezone;
  if (!zone) return `cron ${cadence.expression}`;
  // Its runs to come are then not drawn: they would be guessed in the wrong zone.
  return knownZone(zone)
    ? `cron ${cadence.expression} (${zone})`
    : `cron ${cadence.expression} (${zone}, a time zone this host does not know)`;
}

/** The runs still to come: its next run, then what its cadence makes of the rest, short of its run limit and expiry. */
function scheduleUpcoming(schedule: StoredSchedule, next: number | null, window: Window): number[] {
  if (next === null) return [];
  const left = schedule.maxRuns ? schedule.maxRuns - schedule.runs.length : TIMELINE_UPCOMING;
  const until = Math.min(window.to, ms(schedule.expiresAt) ?? Number.POSITIVE_INFINITY);
  const limit = Math.max(0, Math.min(left, TIMELINE_UPCOMING));
  if (limit === 0) return [];
  const rest = (() => {
    const { cadence } = schedule;
    const after = Math.max(next, window.now);
    if (cadence.type === "every") return series(next + cadence.everyMs, cadence.everyMs, after, until, limit);
    const spec = parseCron(cadence.expression);
    if (!spec || (cadence.timezone && !knownZone(cadence.timezone))) return [];
    return dueTimes([spec], cadence.timezone, after, until, limit);
  })();
  return [...(next > window.now && next <= until ? [next] : []), ...rest].slice(0, limit);
}

/**
 * One schedule as a source, or null for a finished one with nothing in the
 * window (a one-shot that ran last week). A run going is running. Paused,
 * completed and expired are off, whatever their last run did: they will not
 * run again on their own, so a failure there is history, never a page. An
 * active one whose newest run failed is failed. It is missed when its next
 * run is SCHEDULE_GRACE_MS overdue, counted from the Mac's wake if it slept
 * through, and no run started at or after it was due (a file the daemon has
 * not yet moved on is not a miss).
 */
export function scheduleSource(
  schedule: StoredSchedule,
  window: Window,
  file: string | null,
  awakeSince: number | null,
): TimelineSource | null {
  const { now } = window;
  const kind = schedule.target.type === "agent" ? "heartbeat" : "schedule";
  const all: TimelineRun[] = schedule.runs.flatMap((run) => {
    const at = instant(run.startedAt);
    if (!at) return [];
    const detail = run.status === "failed" ? run.error?.trim() || "failed" : null;
    return [{ at, endedAt: instant(run.endedAt), status: PASEO_STATUS[run.status], exit: null, detail }];
  });
  const expired = (ms(schedule.expiresAt) ?? Number.POSITIVE_INFINITY) < now;
  const active = schedule.status === "active" && !expired;
  const nextAt = active ? ms(schedule.nextRunAt) : null;
  const newest = lastRun(all);
  const newestAt = newest ? ms(newest.at) : null;
  const failure = newest?.status === "failed" ? `Its last run failed: ${newest.detail}.`.replace(/\.\.$/, ".") : null;
  let status: SourceStatus;
  let reason: string;
  let since: string | null = null;
  const missed: TimelineRun[] = [];
  const going = all.find((run) => run.status === "running");
  if (going) {
    status = "running";
    reason = "Running now.";
    since = going.at;
  } else if (!active) {
    status = "off";
    const why =
      schedule.status === "paused"
        ? "Paused."
        : expired && schedule.status === "active"
          ? "Expired."
          : "Completed: it has no runs left.";
    reason = failure ? `${why} ${failure}` : why;
  } else if (failure && newest) {
    status = "failed";
    reason = failure;
    since = newest.at;
  } else if (
    nextAt !== null &&
    now > Math.max(nextAt, awakeSince ?? 0) + SCHEDULE_GRACE_MS &&
    !(newestAt !== null && newestAt >= nextAt - DUE_SLACK_MS)
  ) {
    status = "missed";
    reason = "Its run came due and has not started.";
    since = iso(nextAt);
    missed.push({ at: iso(nextAt), endedAt: null, status: "missed", exit: null, detail: "due, and it did not start" });
  } else {
    status = "ok";
    reason = newest ? "On schedule; its last run succeeded." : "On schedule; no run yet.";
    since = newest?.at ?? null;
  }
  const runs = inWindow([...missed, ...all], window);
  if (!active && !going && runs.length === 0 && schedule.status !== "paused") return null;
  const agentId =
    schedule.target.type === "agent"
      ? schedule.target.agentId
      : ([...schedule.runs].reverse().find((run) => run.agentId)?.agentId ?? null);
  return {
    id: `${kind}:${schedule.id}`,
    kind,
    name: scheduleName(schedule),
    cadence: scheduleCadence(schedule.cadence),
    status,
    reason,
    since,
    needsYou: needs(status),
    next: nextAt !== null ? iso(nextAt) : null,
    upcoming: scheduleUpcoming(schedule, nextAt, window).map(iso),
    runs,
    last: newest,
    where: file,
    hasLog: false,
    link: agentId ? { kind: "agent", agentId } : null,
  };
}

// ── Maestro's loop ───────────────────────────────────────────────────────────

export interface LoopNow {
  minutes: number | null;
  nextAt: string | null;
  ticking: boolean;
}

/** One wake in a line: "Started 1, left 2 alone, flagged 1.", "Did nothing new.", or why it was skipped. */
export function wakeSummary(entry: WakeEntry): string {
  if (entry.skipped) return `Skipped: ${entry.skipped}.`;
  const parts = [
    ...(entry.dispatched.length > 0 ? [`started ${entry.dispatched.length}`] : []),
    ...(entry.deferred.length > 0 ? [`left ${entry.deferred.length} alone`] : []),
    ...(entry.flagged.length > 0 ? [`flagged ${entry.flagged.length}`] : []),
    ...(entry.cleared.length > 0 ? [`cleared ${entry.cleared.length}`] : []),
  ];
  const text = parts.length > 0 ? parts.join(", ") : "did nothing new";
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/**
 * The loop as a source. Off when it has no period (its past wakes, Wake now
 * included, still show). Waking is running. A wake due LOOP_GRACE_MS ago that
 * has not run is missed: the loop's timer should have fired. A timer does
 * not count time the Mac sleeps, so after a wake it can take up to a whole
 * period to fire: the grace runs from the later of the due time and a
 * period after the wake.
 */
export function loopSource(
  loop: LoopNow,
  wakes: readonly WakeEntry[],
  window: Window,
  awakeSince: number | null,
  wakeLog: string | null,
): TimelineSource {
  const { now } = window;
  const all: TimelineRun[] = wakes.flatMap((entry) => {
    const at = instant(entry.wokeAt);
    if (!at) return [];
    return [{ at, endedAt: null, status: entry.skipped ? "skipped" : "ok", exit: null, detail: wakeSummary(entry) }];
  });
  const nextAt = loop.minutes === null ? null : ms(loop.nextAt);
  const periodMs = loop.minutes === null ? null : loop.minutes * 60_000;
  let status: SourceStatus;
  let reason: string;
  let since: string | null = null;
  const missed: TimelineRun[] = [];
  if (loop.ticking) {
    status = "running";
    reason = "Waking now.";
  } else if (loop.minutes === null) {
    status = "off";
    reason = "The loop is off; turn it on in Settings.";
  } else if (nextAt === null) {
    status = "unknown";
    reason = "On, with no wake armed yet.";
  } else if (now > Math.max(nextAt, awakeSince === null ? 0 : awakeSince + (periodMs ?? 0)) + LOOP_GRACE_MS) {
    status = "missed";
    reason = "A wake came due and has not run.";
    since = iso(nextAt);
    missed.push({ at: iso(nextAt), endedAt: null, status: "missed", exit: null, detail: "due, and it did not wake" });
  } else {
    status = "ok";
    reason = "On schedule.";
  }
  const upcoming =
    nextAt !== null && periodMs !== null && status !== "missed"
      ? [...(nextAt > now ? [nextAt] : []), ...series(nextAt + periodMs, periodMs, now, window.to, TIMELINE_UPCOMING)]
          .filter((at) => at <= window.to)
          .slice(0, TIMELINE_UPCOMING)
      : [];
  return {
    id: "loop",
    kind: "loop",
    name: "Maestro's loop",
    cadence: periodMs === null ? "off" : everyWords(periodMs),
    status,
    reason,
    since,
    needsYou: needs(status),
    next: nextAt !== null && status !== "missed" ? iso(nextAt) : null,
    upcoming: upcoming.map(iso),
    runs: inWindow([...missed, ...all], window),
    last: lastRun(all),
    where: wakeLog,
    hasLog: false,
    link: { kind: "loop" },
  };
}

// ── fleet-reconcile ──────────────────────────────────────────────────────────

const TICK_STATUS: Record<TickStatus, RunStatus> = {
  ok: "ok",
  failed: "failed",
  running: "running",
  died: "failed",
  unknown: "unknown",
};

/** The launchd label of a fleet scope's tick, from the Fleet view's own plist name: the fleet source shows those runs. */
export const fleetLabel = (scope: string) => plistName(scope).replace(/\.plist$/, "");
/** Every fleet scope's tick job starts with this. The Fleet view counts what it does, never the Timeline. */
export const FLEET_LABEL_PREFIX = fleetLabel("");

/**
 * A fleet scope as a source, from the Fleet view's read: its ticks are its
 * runs and its health is its status. It needs you as the Fleet view says
 * (its own notice, or the fleet's alert work), never counted again here.
 */
export function fleetSource(scope: FleetScope, detail: FleetDetail | null, window: Window): TimelineSource {
  const { now } = window;
  const { health } = scope;
  const all: TimelineRun[] = (detail?.ticks ?? []).flatMap((tick) => {
    const at = instant(tick.at);
    if (!at) return [];
    const words = [
      `tick ${tick.tick}`,
      ...(tick.status === "died" ? ["started and never finished"] : []),
      ...(tick.failedStep ? [`failed at ${tick.failedStep}`] : []),
      ...(tick.exit !== null && tick.exit !== 0 ? [`exit ${tick.exit}`] : []),
    ];
    return [
      {
        at,
        endedAt: instant(tick.finishedAt),
        status: TICK_STATUS[tick.status],
        exit: tick.exit,
        detail: words.join(", "),
      },
    ];
  });
  const status: SourceStatus =
    health.status === "failing"
      ? "failed"
      : health.status === "missed"
        ? "missed"
        : health.status === "off" || health.status === "unscheduled"
          ? "off"
          : scope.lastTick?.status === "running"
            ? "running"
            : "ok";
  const intervalMs = detail?.schedule.intervalMinutes ? detail.schedule.intervalMinutes * 60_000 : null;
  const lastAt = ms(scope.lastTick?.at ?? null);
  const scheduled = detail?.schedule.scheduled ?? false;
  const missed: TimelineRun[] = [];
  if (status === "missed" && lastAt !== null && intervalMs !== null) {
    missed.push({
      at: iso(lastAt + intervalMs),
      endedAt: null,
      status: "missed",
      exit: null,
      detail: "due, and no tick ran",
    });
  }
  const due = scheduled && intervalMs !== null && lastAt !== null && status !== "missed" ? lastAt + intervalMs : null;
  const upcoming =
    due !== null && intervalMs !== null
      ? [...(due > now ? [due] : []), ...series(due + intervalMs, intervalMs, now, window.to, TIMELINE_UPCOMING)]
      : [];
  return {
    id: `fleet:${scope.id}`,
    kind: "fleet",
    name: `fleet-reconcile ${scope.id}`,
    cadence: !scheduled ? "by hand only" : intervalMs !== null ? everyWords(intervalMs) : "on its schedule",
    status,
    reason: health.reason,
    since: instant(health.since),
    needsYou: health.needsYou || Boolean(health.item?.needsYou),
    next: due !== null ? iso(due) : null,
    upcoming: upcoming
      .filter((at) => at <= window.to)
      .slice(0, TIMELINE_UPCOMING)
      .map(iso),
    runs: inWindow([...missed, ...all], window),
    last: lastRun(all),
    where: detail?.stateDir ?? null,
    hasLog: false,
    link: { kind: "fleet", scope: scope.id },
  };
}

// ── launchd ──────────────────────────────────────────────────────────────────

/** How a job's plist says it runs. */
export function launchdSchedule(job: Pick<LaunchdJob, "plist" | "printed">): LaunchdSchedule {
  const interval = job.plist?.StartInterval;
  const seconds = typeof interval === "number" && interval > 0 ? interval : (job.printed?.intervalSeconds ?? null);
  const calendar = job.plist?.StartCalendarInterval;
  return {
    intervalMs: seconds !== null ? seconds * 1000 : null,
    calendar: calendar === undefined ? null : calendarSpecs(calendar),
  };
}

export function launchdCadence(job: Pick<LaunchdJob, "plist" | "printed">): string {
  const plist = job.plist ?? {};
  if (plist.StartCalendarInterval !== undefined) return calendarCadence(plist.StartCalendarInterval);
  const { intervalMs } = launchdSchedule(job);
  if (intervalMs !== null) return everyWords(intervalMs);
  if (plist.KeepAlive) return "kept running";
  if (plist.RunAtLoad) return "once, when loaded";
  return "on demand";
}

/** The end of a log, whole lines, at most TIMELINE_TAIL_BYTES. */
export function tailOf(text: string | null): string | null {
  if (!text) return null;
  const trimmed = text.replace(/\s+$/, "");
  if (trimmed.length <= TIMELINE_TAIL_BYTES) return trimmed || null;
  const cut = trimmed.slice(-TIMELINE_TAIL_BYTES);
  const line = cut.indexOf("\n");
  return line >= 0 ? cut.slice(line + 1) : cut;
}

export interface LaunchdContext {
  /** This job's run ends from the unified log. */
  exits: readonly LaunchdExit[];
  coverage: number | null;
  /**
   * How far the evidence reaches (server/launchd.ts LaunchdRead.exitsUntil,
   * else when it was read): whether a run was missed is judged at this
   * instant, never later, so an old or failed read cannot page.
   */
  judgedAt: number;
  awakeSince: number | null;
  prefix: string;
}

/**
 * One launchd job as a source. A fleet scope's tick job that is shown here
 * (the Fleet view could not be read) never needs you from the Timeline: the
 * Fleet view's own notice counts it.
 */
export function launchdSource(job: LaunchdJob, context: LaunchdContext, window: Window): TimelineSource {
  const { now } = window;
  const schedule = launchdSchedule(job);
  const all = launchdRuns({
    exits: context.exits,
    logged: stampRuns(logStamps(job.logText ?? "")),
    logWrittenAt: job.logWrittenAt,
    lastExit: job.printed?.lastExit ?? null,
    running: job.running ? { since: job.runningSince } : null,
    now,
  });
  const judged = launchdStatus({
    loaded: job.loaded,
    schedule,
    runs: all,
    now: Math.min(now, context.judgedAt),
    installedAt: job.installedAt,
    awakeSince: context.awakeSince,
    coverage: context.coverage,
  });
  const fleets = job.label.startsWith(FLEET_LABEL_PREFIX);
  const newest = all[0] ? ms(all[0].at) : null;
  const { next, upcoming } = job.loaded
    ? launchdUpcoming(schedule, judged.status === "missed" ? null : newest, now, window.to, TIMELINE_UPCOMING)
    : { next: null, upcoming: [] };
  const name = job.label.startsWith(context.prefix) ? job.label.slice(context.prefix.length) : job.label;
  return {
    id: `launchd:${job.label}`,
    kind: "launchd",
    name: name || job.label,
    cadence: launchdCadence(job),
    status: judged.status,
    reason: fleets ? `${judged.reason} The Fleet view counts it.` : judged.reason,
    since: judged.since,
    needsYou: needs(judged.status) && !fleets,
    next: next !== null ? iso(next) : null,
    upcoming: upcoming.map(iso),
    runs: inWindow([...judged.missed, ...all], window),
    last: lastRun(all),
    where: job.logPath,
    hasLog: job.logPath !== null && job.logText !== null,
    link: null,
  };
}

// ── Needs you ────────────────────────────────────────────────────────────────

/** What needs you from the timeline on its own: failed or missed, and never a fleet scope (the Fleet view counts those). */
export function timelineNotices(sources: readonly TimelineSource[]): TimelineNotice[] {
  return sources.flatMap((source) =>
    source.needsYou && source.kind !== "fleet" && (source.status === "failed" || source.status === "missed")
      ? [
          {
            id: source.id,
            kind: source.kind,
            name: source.name,
            status: source.status,
            reason: source.reason,
            since: source.since,
          },
        ]
      : [],
  );
}
