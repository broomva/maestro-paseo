// The broomva launchd jobs as the timeline reads them, pure: what
// `launchctl list` and `launchctl print` say, the run ends macOS's unified
// log keeps for each job, and the timestamps in the job's own log. The I/O
// is server/launchd.ts.
//
// launchd itself keeps no run history: `print` gives the last exit code and
// a run count since the job was loaded, nothing more. The unified log keeps
// one line per run end, "exited due to exit(0), ran for 26ms", for as far
// back as the Mac retains it (about a day). A job's own log adds the runs
// it stamped (`[2026-10-02T07:00:01Z] ...`) and when it last wrote. A run is
// known from the unified log when it can be, else from the job's log, and
// launchd's last exit code is given to the newest run only.

import type { RunStatus, SourceStatus, TimelineRun } from "../shared/timeline";
import { type CronSpec, dueTimes } from "./cron";
import { type AwakeFor, span } from "./fleet-model";

/**
 * Awake milliseconds between two wall-clock times, from the plugin's awake
 * clock (server/fleet.ts AwakeClock): what launchd counts for StartInterval,
 * and the only time in which a job could have run. Before the clock's first
 * record it counts from that record, so it is a lower bound, never more.
 */
export function awakeBetween(awake: AwakeFor, from: number, to: number): number {
  if (to <= from) return 0;
  return Math.max(0, awake(from).ms - awake(to).ms);
}

/** A run counts as missed this long after its interval would have fired twice. */
export const INTERVAL_GRACE_MS = 5 * 60_000;
/** A calendar run counts as missed this long, in awake time, after it was due (launchd runs one the Mac slept through at wake). */
export const CALENDAR_GRACE_MS = 30 * 60_000;
/** A run starting this close to a due time, or this close to a run seen elsewhere, is the same run. */
export const MATCH_SLACK_MS = 2 * 60_000;
/** Stamps in a job's log this far apart begin a new run. */
export const STAMP_GAP_MS = 5 * 60_000;

// ── launchctl ────────────────────────────────────────────────────────────────

export interface ListedJob {
  label: string;
  pid: number | null;
  /** The last exit status `list` shows: a negative number is a signal. */
  status: number | null;
}

/** `launchctl list`, the jobs whose label starts with `prefix`. */
export function parseList(text: string, prefix: string): ListedJob[] {
  const jobs: ListedJob[] = [];
  for (const line of text.split("\n")) {
    // PID, last exit status, label: tab-separated, and a label has no spaces.
    const [pid = "", status = "", label = ""] = line.trim().split(/\s+/);
    if (!label.startsWith(prefix)) continue;
    jobs.push({
      label,
      pid: /^\d+$/.test(pid) ? Number(pid) : null,
      status: /^-?\d+$/.test(status) ? Number(status) : null,
    });
  }
  return jobs;
}

export interface PrintedJob {
  /** The plist launchd loaded it from. */
  path: string | null;
  state: string | null;
  pid: number | null;
  /** Null when it never exited since it was loaded. */
  lastExit: number | null;
  stdout: string | null;
  intervalSeconds: number | null;
}

/** `launchctl print gui/<uid>/<label>`: its top-level keys, read as text (the format has no machine form). */
export function parsePrint(text: string): PrintedJob {
  const keys = new Map<string, string>();
  for (const line of text.split("\n")) {
    // Top-level keys sit one tab in; nested blocks sit deeper.
    const match = /^\t([a-z][a-z ]*?) = (.*)$/.exec(line);
    if (match?.[1] && match[2] !== undefined && !keys.has(match[1])) keys.set(match[1], match[2].trim());
  }
  const whole = (key: string) => {
    const match = /^(-?\d+)/.exec(keys.get(key) ?? "");
    return match?.[1] ? Number(match[1]) : null;
  };
  const interval = /^(\d+) seconds?$/.exec(keys.get("run interval") ?? "");
  return {
    path: keys.get("path") ?? null,
    state: keys.get("state") ?? null,
    pid: whole("pid"),
    lastExit: whole("last exit code"),
    stdout: keys.get("stdout path") ?? null,
    intervalSeconds: interval?.[1] ? Number(interval[1]) : null,
  };
}

/** `ps -o etime=`: `[[dd-]hh:]mm:ss` as milliseconds, or null. */
export function elapsedMs(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!match) return null;
  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  return (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

// ── The unified log ──────────────────────────────────────────────────────────

/** One run end, as launchd logged it. */
export interface LaunchdExit {
  label: string;
  pid: number | null;
  endedAt: number;
  /** The exit code, when it exited rather than being killed. */
  exit: number | null;
  /** The signal that ended it, when one did. */
  signal: string | null;
  /** launchd itself sent the signal: a job stopped at logout or unload, not one that failed. */
  byLaunchd: boolean;
  ranMs: number | null;
}

/** The log's own timestamp, `2026-10-01 21:55:17.002063-0500`, as epoch milliseconds. */
export function logTime(text: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?([+-]\d{2}):?(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const [, date, time, fraction = "", zoneHours, zoneMinutes] = match;
  const at = Date.parse(`${date}T${time}${fraction.slice(0, 4)}${zoneHours}:${zoneMinutes}`);
  return Number.isNaN(at) ? null : at;
}

/** A local wall-clock time for `log show --start`, which reads its argument in the Mac's own zone. */
export function logStartArg(at: number): string {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/**
 * One `log show --style ndjson` line, when it is a run end of a job in the
 * `gui/<uid>` domain: its subsystem names the job (`gui/501/com.broomva.x
 * [1234]`), its message how it ended.
 */
export function parseExitLine(line: string): LaunchdExit | null {
  let event: { subsystem?: unknown; eventMessage?: unknown; timestamp?: unknown };
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof event.subsystem !== "string" || typeof event.eventMessage !== "string") return null;
  if (typeof event.timestamp !== "string") return null;
  const job = /^gui\/\d+\/(\S+)(?: \[(\d+)\])?$/.exec(event.subsystem);
  const message = event.eventMessage;
  if (!job?.[1] || !message.startsWith("exited")) return null;
  const endedAt = logTime(event.timestamp);
  if (endedAt === null) return null;
  const exit = /exit\((-?\d+)\)/.exec(message);
  const signal = /\b(SIG[A-Z0-9]+)\b/.exec(message);
  const ran = /ran for (\d+)ms/.exec(message);
  return {
    label: job[1],
    pid: job[2] ? Number(job[2]) : null,
    endedAt,
    exit: exit?.[1] !== undefined ? Number(exit[1]) : null,
    signal: exit ? null : (signal?.[1] ?? null),
    byLaunchd: !exit && /sent by launchd\[/.test(message),
    ranMs: ran?.[1] ? Number(ran[1]) : null,
  };
}

/** Every run end in a `log show --style ndjson` stream, oldest first; a line that is not one is skipped. */
export function parseExits(text: string): LaunchdExit[] {
  const exits: LaunchdExit[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    const exit = parseExitLine(line);
    if (exit) exits.push(exit);
  }
  return exits.sort((a, b) => a.endedAt - b.endedAt);
}

/** The same run end read twice (an incremental read overlaps the last) is one. */
export const exitKey = (exit: LaunchdExit) => `${exit.label}:${exit.pid ?? ""}:${exit.endedAt}`;

// ── The job's own log ────────────────────────────────────────────────────────

/** The UTC stamps a log carries (`2026-10-02T07:00:01Z`, bracketed or at a line's start), oldest first. */
export function logStamps(text: string): number[] {
  const stamps: number[] = [];
  for (const match of text.matchAll(/(?:^|\[)(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/gm)) {
    const at = Date.parse(match[1] ?? "");
    if (!Number.isNaN(at)) stamps.push(at);
  }
  return stamps.sort((a, b) => a - b);
}

/** Stamps grouped into runs: a gap of STAMP_GAP_MS or more begins the next. */
export function stampRuns(stamps: readonly number[]): { start: number; end: number }[] {
  const runs: { start: number; end: number }[] = [];
  for (const at of stamps) {
    const last = runs[runs.length - 1];
    if (last && at - last.end < STAMP_GAP_MS) last.end = at;
    else runs.push({ start: at, end: at });
  }
  return runs;
}

// ── Runs ─────────────────────────────────────────────────────────────────────

const iso = (at: number) => new Date(at).toISOString();

/** SIGTERM from launchd stops a job (logout, unload): it is not the job failing, and not a pass either. */
const stoppedByLaunchd = (signal: string | null, byLaunchd: boolean) => byLaunchd && signal === "SIGTERM";

function exitStatus(exit: number | null, signal: string | null, byLaunchd = false): RunStatus {
  if (exit === 0) return "ok";
  if (stoppedByLaunchd(signal, byLaunchd)) return "unknown";
  if (exit !== null || signal !== null) return "failed";
  return "unknown";
}

export function exitDetail(exit: number | null, signal: string | null, byLaunchd = false): string | null {
  if (stoppedByLaunchd(signal, byLaunchd)) return "stopped by launchd (SIGTERM)";
  if (signal) return `killed by ${signal}`;
  if (exit !== null) return `exit ${exit}`;
  return null;
}

export interface LaunchdEvidence {
  /** This job's run ends from the unified log. */
  exits: readonly LaunchdExit[];
  /** The runs its own log stamped. */
  logged: readonly { start: number; end: number }[];
  /** When its log was last written, if it holds anything. */
  logWrittenAt: number | null;
  /** launchd's last exit code since the job was loaded: the newest run's. */
  lastExit: number | null;
  /** A run going now, and when it started when that is known. */
  running: { since: number | null } | null;
  now: number;
}

/**
 * Every run the evidence shows, newest first. What the job's log says about
 * a run still going (its stamps, its last write) is that run, not a finished
 * one, and a stamp from the future is a clock or a log gone wrong: neither is
 * counted as a run.
 */
export function launchdRuns(evidence: LaunchdEvidence): TimelineRun[] {
  const runs: (TimelineRun & { start: number; end: number })[] = evidence.exits.map((exit) => {
    const start = exit.endedAt - (exit.ranMs ?? 0);
    return {
      at: iso(start),
      endedAt: iso(exit.endedAt),
      status: exitStatus(exit.exit, exit.signal, exit.byLaunchd),
      exit: exit.exit,
      detail: exitDetail(exit.exit, exit.signal, exit.byLaunchd),
      start,
      end: exit.endedAt,
    };
  });
  const seen = (start: number, end: number) =>
    runs.some((run) => run.start - MATCH_SLACK_MS <= end && start <= run.end + MATCH_SLACK_MS);
  const goingSince = evidence.running?.since ?? null;
  const thisRun = (at: number) => goingSince !== null && at >= goingSince - MATCH_SLACK_MS;
  for (const stamped of evidence.logged) {
    if (stamped.start > evidence.now + MATCH_SLACK_MS || thisRun(stamped.end)) continue;
    if (seen(stamped.start, stamped.end)) continue;
    runs.push({
      at: iso(stamped.start),
      endedAt: iso(stamped.end),
      status: "unknown",
      exit: null,
      detail: "from its log",
      start: stamped.start,
      end: stamped.end,
    });
  }
  const newestEnd = Math.max(-Infinity, ...runs.map((run) => run.end));
  const written = evidence.logWrittenAt;
  if (written !== null && written > newestEnd + MATCH_SLACK_MS && !thisRun(written) && written <= evidence.now) {
    runs.push({
      at: iso(written),
      endedAt: iso(written),
      status: "unknown",
      exit: null,
      detail: "its log was last written then",
      start: written,
      end: written,
    });
  }
  runs.sort((a, b) => b.start - a.start);
  // launchd's last exit code is the newest run's: it fills that run's exit when no other record did.
  const [newest] = runs;
  if (newest && newest.exit === null && newest.status === "unknown" && evidence.lastExit !== null) {
    newest.exit = evidence.lastExit;
    newest.status = exitStatus(evidence.lastExit, null);
    newest.detail = `exit ${evidence.lastExit}${newest.detail ? `, ${newest.detail}` : ""}`;
  }
  const out: TimelineRun[] = runs.map(({ start: _start, end: _end, ...run }) => run);
  if (evidence.running) {
    const since = evidence.running.since ?? evidence.now;
    out.unshift({ at: iso(since), endedAt: null, status: "running", exit: null, detail: null });
  }
  return out;
}

// ── Status ───────────────────────────────────────────────────────────────────

export interface LaunchdSchedule {
  intervalMs: number | null;
  calendar: readonly CronSpec[] | null;
}

/**
 * The stretch of time the unified log was read over: from as far back as it
 * reaches to where the last good read of it ended. Inside it, no run end is
 * evidence that no run ended; outside it, it is nothing.
 */
export interface Seen {
  from: number;
  to: number;
}

export interface LaunchdStatusInput {
  loaded: boolean;
  schedule: LaunchdSchedule;
  /** Every known run, newest first (launchdRuns). */
  runs: readonly TimelineRun[];
  /**
   * What the unified log saw, or null when it has not been read: a run is
   * called missed only if it came due inside this stretch, so a read that
   * failed (first or later) or is old never pages.
   */
  seen: Seen | null;
  /** When the job's plist was written: it cannot have missed a run due before it existed. */
  installedAt: number | null;
  /** Awake time (server/fleet.ts AwakeClock): launchd fires nothing while the Mac sleeps. */
  awake: AwakeFor;
}

export interface Judged {
  status: SourceStatus;
  reason: string;
  since: string | null;
  /** Runs that came due and did not start, newest first, drawn where they were due. */
  missed: TimelineRun[];
}

const missedRun = (at: number): TimelineRun => ({
  at: iso(at),
  endedAt: null,
  status: "missed",
  exit: null,
  detail: "due, and it did not run",
});

const MISSED_SHOWN = 24;

/**
 * A job now. Not loaded is off. A run going is running. A newest run that
 * failed is failed. Otherwise it is missed when a run came due inside what
 * the unified log saw (`seen`) and did not start: on an interval, no run for
 * two intervals and a grace of awake time; on a calendar, a due time with
 * its grace of awake time gone (one the Mac slept through runs at wake). Only
 * the part of `seen` after the newest run's end and after the plist was
 * written counts: launchd folds runs a sleep or a long run skipped into one.
 * A newest run whose exit nobody recorded is unknown, never on time.
 */
export function launchdStatus(input: LaunchdStatusInput): Judged {
  const { runs, schedule, seen } = input;
  if (!input.loaded) return { status: "off", reason: "Not loaded: launchd will not run it.", since: null, missed: [] };
  const going = runs.find((run) => run.status === "running");
  if (going) return { status: "running", reason: "Running now.", since: going.at, missed: [] };
  const newest = runs[0] ?? null;
  const newestEnd = newest ? Date.parse(newest.endedAt ?? newest.at) : null;
  if (newest?.status === "failed") {
    return {
      status: "failed",
      reason: `Its last run failed${newest.detail ? `: ${newest.detail}` : ""}.`,
      since: newest.at,
      missed: [],
    };
  }
  if (seen) {
    const { to } = seen;
    // Inside what the log saw, after the newest run ended and the plist was written, and at most a week back.
    const from = Math.max(seen.from, newestEnd ?? seen.from, input.installedAt ?? seen.from, to - 8 * 86_400_000);
    const sinceLast = newestEnd !== null && newestEnd >= seen.from;
    if (schedule.calendar) {
      const due = dueTimes(schedule.calendar, undefined, from + MATCH_SLACK_MS, to, 1440 * 2).filter(
        (at) => awakeBetween(input.awake, at, to) > CALENDAR_GRACE_MS,
      );
      const [first] = due;
      if (first !== undefined) {
        return {
          status: "missed",
          reason:
            due.length === 1
              ? "A run came due and it has not run."
              : `${due.length} runs came due since ${sinceLast ? "its last run" : "the unified log begins"} and none ran.`,
          since: iso(first),
          missed: due.slice(-MISSED_SHOWN).reverse().map(missedRun),
        };
      }
    }
    if (schedule.intervalMs !== null) {
      if (awakeBetween(input.awake, from, to) > 2 * schedule.intervalMs + INTERVAL_GRACE_MS) {
        // Due an interval after it; in wall time, where no sleep fell between.
        const dueAt = from + schedule.intervalMs;
        return {
          status: "missed",
          reason: sinceLast
            ? `No run since its last; it runs every ${span(schedule.intervalMs)}.`
            : `No run seen in the unified log; it runs every ${span(schedule.intervalMs)}.`,
          since: iso(dueAt),
          missed: [missedRun(dueAt)],
        };
      }
    }
  }
  if (!newest) return { status: "unknown", reason: "No run seen yet.", since: null, missed: [] };
  if (newest.status === "unknown") {
    return {
      status: "unknown",
      reason: newest.detail?.startsWith("stopped by launchd")
        ? "launchd stopped its last run (SIGTERM)."
        : "Its last run's exit was not recorded.",
      since: newest.at,
      missed: [],
    };
  }
  return {
    status: "ok",
    reason: seen
      ? "On schedule; its last run passed."
      : "Its last run passed; whether one was missed since cannot be told until the unified log reads.",
    since: newest.at,
    missed: [],
  };
}

/** The runs still to come within `to`, soonest first: from the calendar, or an interval after the newest run. */
export function launchdUpcoming(
  schedule: LaunchdSchedule,
  newestStart: number | null,
  now: number,
  to: number,
  limit: number,
): { next: number | null; upcoming: number[] } {
  if (schedule.calendar) {
    const upcoming = dueTimes(schedule.calendar, undefined, now, to, limit);
    // A weekly job's next run can lie past the window: look a week and a day ahead for it.
    const next = upcoming[0] ?? dueTimes(schedule.calendar, undefined, now, now + 8 * 86_400_000, 1)[0] ?? null;
    return { next, upcoming };
  }
  if (schedule.intervalMs !== null && newestStart !== null) {
    const due = newestStart + schedule.intervalMs;
    // Overdue past its grace: missed (launchdStatus), and when it runs next is not known.
    if (due < now && now - due > schedule.intervalMs + INTERVAL_GRACE_MS) return { next: null, upcoming: [] };
    const upcoming: number[] = [];
    let at = due;
    while (at < now) at += schedule.intervalMs;
    for (; at <= to && upcoming.length < limit; at += schedule.intervalMs) upcoming.push(at);
    // A run a little late is due now: `next` is its due time, already past.
    return { next: due < now ? due : (upcoming[0] ?? at), upcoming };
  }
  return { next: null, upcoming: [] };
}
