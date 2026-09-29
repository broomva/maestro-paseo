// The per-item event log (`_events.jsonl`) and everything derived from it.
// The log is the receipt: every state change, run, check and human decision
// is one line. Nothing here is a percentage, and nothing is stored twice:
// the worker, the look at the gate and the scoreboard are all computed.

import type { CheckResult, Look, Permission, Scoreboard, WeekDay, WorkEventWire, Worker } from "../shared/contracts";
import type { OrchState, Verdict } from "../shared/states";

export type Actor = "human" | "agent" | "maestro";

/**
 * Who asked for a change: you, in Maestro's own surfaces, or a session through
 * the agent socket (`by` is its agent id when it said). Only the first counts
 * as a look: a session starting work is not you stepping in.
 */
export type Origin = { actor: "human" } | { actor: "agent"; by: string | null };

export const BY_HUMAN: Origin = { actor: "human" };

interface Base {
  ts: string;
}

export type WorkEvent = Base &
  (
    | ({ type: "created" } & Origin)
    | ({
        type: "dispatched" | "adopted";
        agentId: string;
        workspaceId: string | null;
        provider: string;
        branch: string | null;
        cwd: string | null;
      } & Origin)
    | { type: "turn.started"; actor: "agent"; agentId: string }
    | {
        type: "turn.ended";
        actor: "agent";
        agentId: string;
        outcome: "completed" | "failed" | "canceled";
        error: string | null;
        summary: string;
        turnId?: string | null;
      }
    | {
        type: "permission.asked";
        actor: "agent";
        agentId: string;
        requestId: string;
        title: string;
        detail: string | null;
      }
    | { type: "permission.resolved"; actor: "human"; agentId: string; requestId: string }
    | { type: "checks.started"; actor: "maestro"; token: string; recovered?: boolean; endedAt?: string }
    | { type: "checks.finished"; actor: "maestro"; token: string; results: CheckResult[] }
    | { type: "state"; actor: Actor; from: OrchState; to: OrchState; reason: string | null }
    // A decision at the gate is recorded when you make it and applied when its undo
    // window closes. The applied `gate` carries the token of the decision it applies;
    // a `gate` without one is a decision recorded before the window existed.
    | { type: "gate"; actor: "human"; verdict: Verdict; note: string; token?: string }
    | { type: "gate.pending"; actor: "human"; verdict: Verdict; note: string; token: string; effectiveAt: string }
    | { type: "gate.undone"; actor: "human"; verdict: Verdict; token: string }
    | { type: "gate.dropped"; actor: "maestro"; verdict: Verdict; token: string; reason: string }
    | { type: "unblocked"; actor: "human"; note: string }
    | { type: "stopped"; actor: "human"; agentId: string | null }
    | { type: "note"; actor: Actor; text: string }
  );

export type WorkEventType = WorkEvent["type"];

export function parseEvents(source: string): { events: WorkEvent[]; bad: number } {
  const events: WorkEvent[] = [];
  let bad = 0;
  for (const line of source.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as WorkEvent;
      if (typeof value?.ts === "string" && typeof value?.type === "string") events.push(value);
      else bad += 1;
    } catch {
      bad += 1;
    }
  }
  return { events, bad };
}

export function lastOf<T extends WorkEventType>(
  events: readonly WorkEvent[],
  ...types: T[]
): Extract<WorkEvent, { type: T }> | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event && (types as string[]).includes(event.type)) return event as Extract<WorkEvent, { type: T }>;
  }
  return null;
}

function indexOfEvent(events: readonly WorkEvent[], event: WorkEvent | null): number {
  return event ? events.lastIndexOf(event) : -1;
}

/** The session currently (or most recently) bound to this work. */
export function workerOf(events: readonly WorkEvent[]): Worker | null {
  const bind = lastOf(events, "dispatched", "adopted");
  if (!bind) return null;
  return {
    agentId: bind.agentId,
    workspaceId: bind.workspaceId,
    provider: bind.provider,
    branch: bind.branch,
    cwd: bind.cwd,
  };
}

/** A permission the bound agent asked for that nothing has answered yet. */
export function pendingPermission(events: readonly WorkEvent[]): Permission | null {
  const asked = lastOf(events, "permission.asked");
  if (!asked) return null;
  const after = events.slice(indexOfEvent(events, asked) + 1);
  const answered = after.some(
    (event) =>
      (event.type === "permission.resolved" && event.requestId === asked.requestId) ||
      event.type === "turn.ended" ||
      event.type === "dispatched",
  );
  return answered ? null : { requestId: asked.requestId, title: asked.title, detail: asked.detail };
}

export interface PendingDecision {
  token: string;
  verdict: Verdict;
  note: string;
  decidedAt: string;
  effectiveAt: string;
}

/**
 * The decision at the gate that has not taken effect: the latest one made,
 * unless it was applied, undone, or dropped since. A decision cannot be made
 * while another is pending, so only the latest can be.
 */
export function pendingDecision(events: readonly WorkEvent[]): PendingDecision | null {
  const made = lastOf(events, "gate.pending");
  if (!made) return null;
  const settled = events
    .slice(indexOfEvent(events, made) + 1)
    .some(
      (event) =>
        (event.type === "gate" || event.type === "gate.undone" || event.type === "gate.dropped") &&
        event.token === made.token,
    );
  if (settled) return null;
  return {
    token: made.token,
    verdict: made.verdict,
    note: made.note,
    decidedAt: made.ts,
    effectiveAt: made.effectiveAt,
  };
}

/** The events recorded after the decision with this token was made. */
export function eventsSince(events: readonly WorkEvent[], token: string): WorkEvent[] {
  const made = events.findIndex((event) => event.type === "gate.pending" && event.token === token);
  return made < 0 ? [] : events.slice(made + 1);
}

/** Whether the latest decision made at the gate has taken effect. */
export function decisionApplied(events: readonly WorkEvent[]): boolean {
  const made = lastOf(events, "gate.pending");
  return made !== null && events.some((event) => event.type === "gate" && event.token === made.token);
}

/** A checks run that started and has not reported. */
export function pendingChecks(events: readonly WorkEvent[]): string | null {
  const started = lastOf(events, "checks.started");
  if (!started) return null;
  const finished = events
    .slice(indexOfEvent(events, started) + 1)
    .some((event) => event.type === "checks.finished" && event.token === started.token);
  return finished ? null : started.token;
}

export function phaseOf(state: OrchState, events: readonly WorkEvent[]): "working" | "checking" | "asking" | null {
  if (state === "running") return pendingChecks(events) ? "checking" : "working";
  if (state === "review" && pendingPermission(events)) return "asking";
  return null;
}

export function latestChecks(events: readonly WorkEvent[]): CheckResult[] {
  return lastOf(events, "checks.finished")?.results ?? [];
}

export function checkOutcome(results: readonly CheckResult[]): "passed" | "failed" | "none" {
  const required = results.filter((result) => result.required);
  if (required.length === 0) return "none";
  return required.every((result) => result.ok) ? "passed" : "failed";
}

export function reasonOf(state: OrchState, events: readonly WorkEvent[]): string | null {
  if (state !== "blocked") return null;
  const moved = [...events].reverse().find((event) => event.type === "state" && event.to === "blocked");
  return moved && moved.type === "state" ? moved.reason : null;
}

export function verdictOf(state: OrchState, events: readonly WorkEvent[]): string | null {
  const results = latestChecks(events);
  const failed = results.filter((result) => !result.ok).length;
  const checks =
    results.length === 0
      ? null
      : failed === 0
        ? `${results.length === 1 ? "Check" : `All ${results.length} checks`} passed`
        : `${failed} of ${results.length} ${results.length === 1 ? "check" : "checks"} failed`;
  if (state === "done") {
    const gate = lastOf(events, "gate");
    return gate?.verdict === "approve" ? (checks ? `${checks} · you approved` : "You approved") : checks;
  }
  if (state === "canceled") return "You canceled it";
  return checks;
}

// ── Durations ────────────────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return "under a minute";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${minutes}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

function ms(ts: string): number {
  return Date.parse(ts);
}

/** Periods this work spent running, from its state changes. */
export function runningIntervals(events: readonly WorkEvent[], now: number): Array<[number, number]> {
  const intervals: Array<[number, number]> = [];
  let open: number | null = null;
  for (const event of events) {
    if (event.type !== "state") continue;
    if (event.to === "running" && open === null) open = ms(event.ts);
    else if (event.to !== "running" && open !== null) {
      intervals.push([open, ms(event.ts)]);
      open = null;
    }
  }
  if (open !== null) intervals.push([open, now]);
  return intervals;
}

// ── The look at the gate ─────────────────────────────────────────────────────

/** Pull a Markdown section ("## Decided") out of the agent's final message. */
export function section(text: string, heading: string): string | null {
  const pattern = new RegExp(`^#{1,4}\\s*${heading}\\s*:?\\s*$([\\s\\S]*?)(?=^#{1,4}\\s|(?![\\s\\S]))`, "im");
  const match = pattern.exec(text);
  const body = match?.[1]?.trim();
  return body ? body : null;
}

export function bullets(text: string): string[] {
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .trim(),
    )
    .filter((line) => line.length > 0)
    .slice(0, 5);
}

export function lookOf(state: OrchState, events: readonly WorkEvent[], now: number): Look | null {
  if (state !== "review") return null;
  const permission = pendingPermission(events);
  const bind = lastOf(events, "dispatched", "adopted");
  const start = bind ? ms(bind.ts) : null;
  const intervals = runningIntervals(start === null ? events : events.filter((e) => ms(e.ts) >= start), now);
  const ranMs = intervals.reduce((sum, [a, b]) => sum + (b - a), 0);
  const turns = events.filter((e) => e.type === "turn.ended" && (start === null || ms(e.ts) >= start)).length;
  const ran = [
    `${formatDuration(ranMs)} unsupervised`,
    `${turns} ${turns === 1 ? "turn" : "turns"}`,
    permission ? "paused on a question" : "ran to the gate",
  ].join(" · ");
  if (permission) {
    return {
      ran,
      decided: [],
      ask: permission.detail ? `${permission.title}: ${permission.detail}` : permission.title,
    };
  }
  const summary = lastOf(events, "turn.ended")?.summary ?? "";
  const decided = section(summary, "Decided");
  const ask = section(summary, "Ask");
  return {
    ran,
    decided: decided ? bullets(decided) : [],
    ask: ask ? bullets(ask).join(" ") : "Approve to close it, or send it back with a note.",
  };
}

// ── Receipts for the detail view ─────────────────────────────────────────────

const STATE_WORDS: Partial<Record<OrchState, string>> = {
  running: "Running",
  review: "Waiting on you",
  blocked: "Stuck",
  done: "Done",
  canceled: "Canceled",
};

function shorten(text: string, max = 280): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The message before its Decided/Ask sections, without Markdown markers. */
export function plainSummary(summary: string): string {
  const cut = summary.search(/^#{1,4}\s*(Decided|Ask)\b/im);
  return (cut >= 0 ? summary.slice(0, cut) : summary)
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

/** Events whose own receipt already says why the state that follows them changed. */
const CAUSES = new Set<WorkEventType>([
  "dispatched",
  "adopted",
  "gate",
  "unblocked",
  "stopped",
  "permission.asked",
  "permission.resolved",
]);

/** How each gate verdict reads: the button, the pending receipt, the applied receipt. */
export const DECISION_WORDS: Record<Verdict, { verb: string; doing: string; done: string }> = {
  approve: { verb: "Approve", doing: "Approving", done: "You approved" },
  revise: { verb: "Send back", doing: "Sending it back", done: "You sent it back" },
  block: { verb: "Cancel work", doing: "Canceling", done: "You canceled it" },
};

/**
 * The receipts a person reads. A state change right after the event that
 * caused it adds nothing ("Permission answered", then "Running: Permission
 * answered"), so it is folded into its cause.
 */
export function toWireEvents(events: readonly WorkEvent[]): WorkEventWire[] {
  const out: WorkEventWire[] = [];
  // Decisions that were applied, undone or dropped: their countdown is over, so they read as made.
  const settled = new Set(
    events.flatMap((event) =>
      event.type === "gate" || event.type === "gate.undone" || event.type === "gate.dropped" ? [event.token] : [],
    ),
  );
  events.forEach((event, index) => {
    const previous = events[index - 1];
    if (event.type === "state" && previous && CAUSES.has(previous.type)) return;
    const wire = toWireEvent(event, event.type === "gate.pending" && settled.has(event.token));
    if (wire) out.push(wire);
  });
  return out;
}

/** Names the session behind a change it asked for; a change you made needs no byline. */
function byline(origin: Origin): string | null {
  if (origin.actor === "human") return null;
  return origin.by ? `by session ${origin.by.slice(0, 8)}` : "by a session";
}

/** One receipt. `settled`: for a decision, whether it was applied, undone or dropped since. */
export function toWireEvent(event: WorkEvent, settled = false): WorkEventWire | null {
  const base = { ts: event.ts, actor: event.actor };
  switch (event.type) {
    case "created":
      return { ...base, type: event.type, text: "Created", detail: byline(event) };
    case "dispatched":
      return {
        ...base,
        type: event.type,
        text: "Dispatched",
        detail: [event.provider, event.branch ? `on ${event.branch}` : null, byline(event)].filter(Boolean).join(" "),
      };
    case "adopted":
      return {
        ...base,
        type: event.type,
        text: "Tracked an existing session",
        detail: [event.provider, byline(event)].filter(Boolean).join(" "),
      };
    case "turn.started":
      return null;
    case "turn.ended":
      return {
        ...base,
        type: event.type,
        text:
          event.outcome === "completed" ? "Turn finished" : event.outcome === "failed" ? "Turn failed" : "Turn stopped",
        detail: event.error ?? (event.summary ? shorten(plainSummary(event.summary)) : null),
      };
    case "permission.asked":
      return { ...base, type: event.type, text: "Asked for permission", detail: event.title };
    case "permission.resolved":
      return { ...base, type: event.type, text: "Permission answered", detail: null };
    case "checks.started":
      return { ...base, type: event.type, text: "Running checks", detail: null };
    case "checks.finished": {
      const failed = event.results.filter((r) => !r.ok).length;
      return {
        ...base,
        type: event.type,
        text: failed === 0 ? "Checks passed" : "Checks failed",
        detail: event.results
          .map((r) => `${r.name} ${r.ok ? "passed" : r.timedOut ? "timed out" : "failed"}`)
          .join(" · "),
      };
    }
    case "state": {
      const word = STATE_WORDS[event.to];
      return word ? { ...base, type: event.type, text: word, detail: event.reason } : null;
    }
    case "gate":
      // A decision made in the undo window was already receipted when you made it; this is when it landed.
      if (event.token) return { ...base, type: event.type, text: "Took effect", detail: null };
      return { ...base, type: event.type, text: DECISION_WORDS[event.verdict].done, detail: event.note || null };
    case "gate.pending": {
      if (settled)
        return { ...base, type: event.type, text: DECISION_WORDS[event.verdict].done, detail: event.note || null };
      const seconds = Math.max(0, Math.round((ms(event.effectiveAt) - ms(event.ts)) / 1000));
      return {
        ...base,
        type: event.type,
        text: `${DECISION_WORDS[event.verdict].doing} in ${seconds}s`,
        detail: event.note || null,
      };
    }
    case "gate.undone":
      return { ...base, type: event.type, text: "Undone", detail: DECISION_WORDS[event.verdict].verb };
    case "gate.dropped":
      return {
        ...base,
        type: event.type,
        text: `${DECISION_WORDS[event.verdict].verb} did not take effect`,
        detail: event.reason,
      };
    case "stopped":
      return { ...base, type: event.type, text: "You stopped the run", detail: null };
    case "unblocked":
      return { ...base, type: event.type, text: "You unblocked it", detail: event.note || null };
    case "note":
      return { ...base, type: event.type, text: event.text, detail: null };
  }
}

// ── The scoreboard: unsupervised hours today ─────────────────────────────────

const HUMAN_LOOKS = new Set<WorkEventType>([
  "gate",
  "gate.pending",
  "unblocked",
  "stopped",
  "dispatched",
  "adopted",
  "permission.resolved",
]);

/**
 * A look is you stepping in. A decision counts when you make it, so the `gate`
 * that applies it later (it carries the decision's token) is not a second look,
 * and undoing it inside the window takes nothing back.
 */
function isLook(event: WorkEvent): boolean {
  if (event.actor !== "human" || !HUMAN_LOOKS.has(event.type)) return false;
  return !(event.type === "gate" && event.token);
}

function merge(intervals: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** One local day, from its midnight to the next (23 or 25 hours when the clocks change). */
function dayBoard(
  logs: ReadonlyArray<readonly WorkEvent[]>,
  now: number,
  dayStart: number,
  end?: number,
): Omit<Scoreboard, "week" | "weekByInitiative"> {
  const dayEnd = end ?? dayStart + 24 * 60 * 60 * 1000;
  const clipped = merge(
    logs
      .flatMap((events) => runningIntervals(events, now))
      .map(([a, b]): [number, number] => [Math.max(a, dayStart), Math.min(b, dayEnd)])
      .filter(([a, b]) => b > a),
  );
  const span = dayEnd - dayStart;
  const unsupervisedMs = clipped.reduce((sum, [a, b]) => sum + (b - a), 0);
  const longestRunMs = clipped.reduce((max, [a, b]) => Math.max(max, b - a), 0);
  const notches = logs
    .flatMap((events) => events.filter(isLook))
    .map((e) => ms(e.ts))
    .filter((t) => t >= dayStart && t < dayEnd)
    .sort((a, b) => a - b);
  return {
    unsupervisedMs,
    looks: notches.length,
    longestRunMs,
    live: clipped.some(([, b]) => b >= now),
    segments: clipped.map(([a, b]) => ({
      start: (a - dayStart) / span,
      width: (b - a) / span,
      live: b >= now,
    })),
    notches: notches.map((t) => (t - dayStart) / span),
  };
}

// ── The week behind today ────────────────────────────────────────────────────

/** The same local time of day, `days` calendar days away: from a midnight, the midnight that many days off. */
export function shiftDays(at: number, days: number): number {
  const date = new Date(at);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

/** The local calendar day holding `at`, as YYYY-MM-DD. */
export function localDate(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Today's scoreboard and the week behind it: the last seven local days, today
 * last. Every day is scored by the same rules from the same logs. `dayStart`
 * is today's local midnight; `initiatives` names each log's initiative (null
 * for none), in the order of `logs`.
 */
export function scoreboard(
  logs: ReadonlyArray<readonly WorkEvent[]>,
  now: number,
  dayStart: number,
  initiatives: ReadonlyArray<string | null> = [],
): Scoreboard {
  const week: WeekDay[] = [];
  for (let back = 6; back >= 0; back -= 1) {
    const start = shiftDays(dayStart, -back);
    const day = dayBoard(logs, now, start, shiftDays(dayStart, 1 - back));
    week.push({
      date: localDate(start),
      unsupervisedMs: day.unsupervisedMs,
      looks: day.looks,
      longestRunMs: day.longestRunMs,
    });
  }
  const tomorrow = shiftDays(dayStart, 1);
  return {
    ...dayBoard(logs, now, dayStart, tomorrow),
    week,
    weekByInitiative: byInitiative(logs, initiatives, now, shiftDays(dayStart, -6), tomorrow),
  };
}

/** Running time per initiative in [from, to), overlapping runs counted once within each; most first. */
function byInitiative(
  logs: ReadonlyArray<readonly WorkEvent[]>,
  initiatives: ReadonlyArray<string | null>,
  now: number,
  from: number,
  to: number,
): Array<{ initiative: string | null; unsupervisedMs: number }> {
  const intervals = new Map<string | null, Array<[number, number]>>();
  logs.forEach((events, index) => {
    const initiative = initiatives[index] ?? null;
    const list = intervals.get(initiative) ?? [];
    list.push(...runningIntervals(events, now));
    intervals.set(initiative, list);
  });
  return [...intervals]
    .map(([initiative, list]) => ({
      initiative,
      unsupervisedMs: merge(
        list.map(([a, b]): [number, number] => [Math.max(a, from), Math.min(b, to)]).filter(([a, b]) => b > a),
      ).reduce((sum, [a, b]) => sum + (b - a), 0),
    }))
    .filter((entry) => entry.unsupervisedMs > 0)
    .sort(
      (a, b) =>
        b.unsupervisedMs - a.unsupervisedMs ||
        // On a tie, named initiatives by name, and work outside any last.
        Number(a.initiative === null) - Number(b.initiative === null) ||
        (a.initiative ?? "").localeCompare(b.initiative ?? ""),
    );
}
