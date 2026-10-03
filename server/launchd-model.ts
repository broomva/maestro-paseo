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

/**
 * Run ends, unloads and the stretch they prove are kept this long, together
 * (server/launchd.ts): a week and a day, the furthest back a miss is looked for.
 */
export const EVIDENCE_MS = 8 * 24 * 60 * 60_000;

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
  /**
   * The system's reason, when it ended the run itself: `OS_REASON_JETSAM` and
   * `JETSAM_REASON_MEMORY_*` (memory), `OS_REASON_RUNNINGBOARD` (terminated),
   * or `JETSAM_REASON_MEMORY_IDLE_EXIT`, the one that is no failure: an idle
   * job let go.
   */
  reason: string | null;
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

/**
 * An instant for `log show --start`, in UTC with its offset written: no time
 * zone of the daemon's, and no hour the clocks going back makes twice.
 */
export function logStartArg(at: number): string {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}+0000`;
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
    reason: exit ? null : (/\b((?:OS|JETSAM)_REASON_[A-Z_]+)/.exec(message)?.[1] ?? null),
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

/**
 * An unload launchd logged, `bootout initiated by: …` on the job's own
 * subsystem or `removing service: <label>` on its domain: the job was not
 * loaded from then until it was loaded again.
 */
export interface LaunchdUnload {
  label: string;
  at: number;
}

/** Every unload in a `log show --style ndjson` stream; anything else is skipped. */
export function parseUnloads(text: string): LaunchdUnload[] {
  const unloads: LaunchdUnload[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: { subsystem?: unknown; eventMessage?: unknown; timestamp?: unknown };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof event.subsystem !== "string" || typeof event.eventMessage !== "string") continue;
    const at = typeof event.timestamp === "string" ? logTime(event.timestamp) : null;
    if (at === null) continue;
    const own = /^gui\/\d+\/(\S+?)(?: \[\d+\])?$/.exec(event.subsystem);
    const removed = /^removing service: (\S+)$/.exec(event.eventMessage);
    if (own?.[1] && event.eventMessage.startsWith("bootout initiated")) unloads.push({ label: own[1], at });
    else if (/^gui\/\d+ \[\d+\]$/.test(event.subsystem) && removed?.[1]) unloads.push({ label: removed[1], at });
  }
  return unloads;
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

/** The one way the system ends a run that is not a failure: it let an idle job go. */
const IDLE_EXIT = "JETSAM_REASON_MEMORY_IDLE_EXIT";
const IDLE_DETAIL = "ended by the system when idle";
const STOPPED_DETAIL = "stopped by launchd (SIGTERM)";

function exitStatus(
  exit: number | null,
  signal: string | null,
  byLaunchd = false,
  reason: string | null = null,
): RunStatus {
  if (exit === 0) return "ok";
  if (stoppedByLaunchd(signal, byLaunchd) || reason === IDLE_EXIT) return "unknown";
  if (exit !== null || signal !== null || reason !== null) return "failed";
  return "unknown";
}

export function exitDetail(
  exit: number | null,
  signal: string | null,
  byLaunchd = false,
  reason: string | null = null,
): string | null {
  if (stoppedByLaunchd(signal, byLaunchd)) return STOPPED_DETAIL;
  if (signal) return `killed by ${signal}`;
  if (reason === IDLE_EXIT) return IDLE_DETAIL;
  if (reason === "OS_REASON_JETSAM" || reason?.startsWith("JETSAM_REASON_MEMORY")) {
    return `killed by the system for memory (${reason})`;
  }
  if (reason) return `ended by the system (${reason})`;
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
  // `recorded`: launchd logged how it ended (an exit, a signal, a reason), so its status is never second-guessed.
  const runs: (TimelineRun & { start: number; end: number; recorded: boolean })[] = evidence.exits.map((exit) => {
    const start = exit.endedAt - (exit.ranMs ?? 0);
    return {
      at: iso(start),
      endedAt: iso(exit.endedAt),
      status: exitStatus(exit.exit, exit.signal, exit.byLaunchd, exit.reason),
      exit: exit.exit,
      detail: exitDetail(exit.exit, exit.signal, exit.byLaunchd, exit.reason),
      start,
      end: exit.endedAt,
      recorded: true,
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
      recorded: false,
    });
  }
  // A fold, not a spread: eight days of a job that runs every few seconds is more arguments than a call takes.
  const newestEnd = runs.reduce((latest, run) => Math.max(latest, run.end), Number.NEGATIVE_INFINITY);
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
      recorded: false,
    });
  }
  runs.sort((a, b) => b.start - a.start);
  // launchd's last exit code is the newest run's: it fills that run's exit when no other record did.
  const [newest] = runs;
  if (newest && !newest.recorded && newest.exit === null && newest.status === "unknown" && evidence.lastExit !== null) {
    newest.exit = evidence.lastExit;
    newest.status = exitStatus(evidence.lastExit, null);
    newest.detail = `exit ${evidence.lastExit}${newest.detail ? `, ${newest.detail}` : ""}`;
  }
  const out: TimelineRun[] = runs.map(({ start: _start, end: _end, recorded: _recorded, ...run }) => run);
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
 * The stretch of time the unified log is proven to have held, unbroken,
 * whose run ends the reader still keeps (server/launchd.ts LaunchdRead.seen):
 * inside it, a run that ended would be among them; outside it, nothing is
 * known.
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
  /** The first read that saw the job loaded (server/launchd.ts LaunchdJob.loadedSince): no miss is judged before it. */
  loadedSince: number | null;
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
 * the part of `seen` after the newest run's end and after a read first saw
 * the job loaded counts: launchd folds runs a sleep or a long run skipped into one.
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
    // Judged only inside what the log saw, after the newest run ended and since a read saw it loaded.
    const back = to - EVIDENCE_MS;
    const from = Math.max(seen.from, newestEnd ?? seen.from, input.loadedSince ?? to, back);
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
              : `Runs came due since ${sinceLast ? "its last run" : "the unified log begins"} and none ran.`,
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
    // Not judged is not on time: a run came due after the newest one ended, before judging could start.
    const blindFrom = Math.max(newestEnd ?? seen.from, back);
    if (from > blindFrom) {
      const blind = schedule.calendar
        ? (dueTimes(schedule.calendar, undefined, blindFrom + MATCH_SLACK_MS, Math.min(from, to), 1)[0] ?? null)
        : schedule.intervalMs !== null &&
            awakeBetween(input.awake, blindFrom, to) > 2 * schedule.intervalMs + INTERVAL_GRACE_MS
          ? blindFrom + schedule.intervalMs
          : null;
      if (blind !== null) {
        return {
          status: "unknown",
          reason: "A run came due before this could see whether it ran: not known until its next one.",
          since: iso(blind),
          missed: [],
        };
      }
    }
  }
  if (!newest) return { status: "unknown", reason: "No run seen yet.", since: null, missed: [] };
  if (newest.status === "unknown") {
    return {
      status: "unknown",
      reason:
        newest.detail === STOPPED_DETAIL
          ? "launchd stopped its last run (SIGTERM)."
          : newest.detail === IDLE_DETAIL
            ? "The system let its last run go when idle."
            : "Its last run's exit was not recorded.",
      since: newest.at,
      missed: [],
    };
  }
  return {
    status: "ok",
    reason: !seen
      ? "Its last run passed; whether one was missed since cannot be told until the unified log reads."
      : (input.loadedSince ?? seen.to) >= seen.to
        ? "Its last run passed; whether one is missed is told from the next due time on."
        : "On schedule; its last run passed.",
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
