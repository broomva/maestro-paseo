// The Maestro engine on Paseo. RPCs are the human's verbs (create, dispatch,
// the gate, unblock, cancel, adopt); lifecycle hooks are the agent's side of
// the story (turns, permissions, archive). Both end in `store.mutate`, which
// validates every transition against the shared state machine. The agent
// socket offers sessions create, dispatch and adopt too, recorded under their
// own origin, and never the gate.
//
// A decision at the gate (approve, send back, cancel) is recorded when you make
// it and applies UNDO_MS later, so a slip can be undone. The pending decision is
// an event with the time it takes effect: a timer applies it, and the plugin
// sweep (upkeep, server/sweep.ts), from load on, applies anything overdue, so
// a restart inside the window still applies it. Every guard is checked again
// when it applies.
//
// Paseo delivers hook events live and best effort, with no replay. So the
// plugin sweep also reconciles bound work against the agent's real status, on
// its own cadence: no read does (BRO-2995). Reconcile acts only on what it
// saw: each correction is guarded by the event count it read, so a real hook
// that lands first always wins, and an outcome it did not observe never
// closes work on its own.

import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { type FlagKind, type MaestroConfig, NOT_STOPPED, type RunChoices, type WorkItem } from "../shared/contracts";
import { skipsPrompts } from "../shared/run";
import {
  GROUP_ORDER,
  isDispatchable,
  isTerminal,
  landingState,
  PLAIN_VOICE,
  type Verdict,
  verdictTarget,
} from "../shared/states";
import { TICKET, ticketOf } from "../shared/text";
import { UNDO_MS } from "../shared/undo";
import { adopterNames } from "./adopter-names";
import {
  ARCHIVED_BETWEEN_TURNS,
  archivedBetweenTurns,
  branchMerged,
  gitOf,
  type MergedPr,
  mergedPrs,
  watchedBranch,
} from "./branch-merge";
import { runChecks } from "./checks";
import { loadConfig } from "./config";
import {
  ARCHIVED_NOTE,
  adopterClosed,
  archivedByOrchestrator,
  archivedSince,
  BY_HUMAN,
  checkOutcome,
  closedItself,
  decisionApplied,
  eventsSince,
  type FlaggedEvent,
  finishedArc,
  flagOf,
  handsBack,
  keptSummary,
  lastOf,
  latestChecks,
  lineageOf,
  type Origin,
  onItsOwnArc,
  pendingChecks,
  pendingDecision,
  pendingPermission,
  phaseOf,
  reasonOf,
  SESSION_ENDED_NOTE,
  scoreboard,
  sessionGoneSince,
  toWireEvents,
  type WorkEvent,
  workerOf,
} from "./events";
import { ACTIVE_AGAIN, flagStands, quietCleared } from "./flags";
import { inspectFolder, repoRefusal } from "./folders";
import { briefOf, type RunKeys, workTitle } from "./frontmatter";
import { type LabelAgent, WORK_LABELS, workLabels } from "./labels";
import { describePermission, type PermissionLike } from "./permissions";
import {
  FILED_BEFORE_A8,
  filedBeforeA8,
  HELD_FOR_YOU,
  type LaneProfile,
  MODED_BY_YOU,
  type Paseo,
  runSettings,
  settingsLane,
  startRun,
  unattendedRefusal,
  WORK_LABEL,
} from "./runs";
import { type Mutation, placement, type StoredWork, WorkStore, withLock } from "./store";
import { toWire } from "./wire";
import { type WorktreeStatus, worktreeStatus } from "./worktree";

/** Why a verb that starts or reads a session cannot run: the plugin has not been handed a Paseo client yet. */
export const NO_HANDLE =
  "Maestro has no connection to Paseo yet. It gets one with the first agent event after the plugin starts: start or message any session, then retry.";

export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

/** A dispatch refused at the concurrency cap. The work is unchanged: it stays queued (or stuck). */
export class AtCapacity extends UserError {}

/** A run nobody would watch, refused for its lane profile (runs.ts unattendedRefusal). The work stays queued. */
export class Unwatched extends UserError {}

/**
 * Why a run holds one of the cap's slots (BRO-2990): the cap counts every run
 * that still has its session, and a run being stopped until its archive
 * settles (BRO-2995 mi-1).
 */
export type Slot = "running" | "asking" | "stuck" | "starting" | "stopping";

const SLOT_WORDS: Record<Slot, string> = {
  running: "running",
  asking: "waiting on a permission",
  stuck: "stuck",
  starting: "starting",
  stopping: "being stopped",
};

/** "3 of 3 slots taken (1 running, 2 stuck)": what holds the cap's slots, in the order a person reads them. */
export function capacityWords(busy: ReadonlyMap<string, Slot>, cap: number): string {
  const counts = new Map<Slot, number>();
  for (const slot of busy.values()) counts.set(slot, (counts.get(slot) ?? 0) + 1);
  const parts = (Object.keys(SLOT_WORDS) as Slot[])
    .filter((slot) => counts.has(slot))
    .map((slot) => `${counts.get(slot)} ${SLOT_WORDS[slot]}`);
  return `${busy.size} of ${cap} ${cap === 1 ? "slot" : "slots"} taken (${parts.join(", ")})`;
}

/**
 * Why a run holds one of the cap's slots as its files say, or null when it
 * holds none: running, waiting on a permission (at the gate with a question
 * pending), or stuck while its session is still there (not SESSION_GONE, and
 * not gone since).
 */
function slotOf(item: StoredWork): Slot | null {
  const state = item.contract.state;
  if (state === "running") return "running";
  if (state === "blocked") {
    const gone = SESSION_GONE.has(reasonOf(state, item.events) ?? "") || sessionGoneSince(item.events);
    return gone ? null : "stuck";
  }
  return phaseOf(state, item.events) === "asking" ? "asking" : null;
}

/** Said on work whose session resumed it while the cap was full: a turn under way is the session's to take (mi-1). */
export const RESUMED_OVER_CAP = "Resumed in the session over the cap";

/** Why work adopted from an idle session is at your gate: its last turn handed you something (adoptOnce). */
export const IDLE_WHEN_TRACKED = "The session was idle when tracked";

/**
 * The agent's text since the last user message. Consecutive assistant items
 * are chunks of one message and join as-is; a tool call or anything else
 * between them ends a message, so the next one starts a new paragraph.
 * Without that break a final "## Decided" heading lands mid-line.
 */
export function latestOutputText(timeline: readonly AgentTimelineItem[]): string {
  let output = "";
  let broken = false;
  for (const item of timeline) {
    if (item.type === "user_message") {
      output = "";
      broken = false;
    } else if (item.type === "assistant_message") {
      if (broken && output) output += "\n\n";
      output += item.text;
      broken = false;
    } else {
      broken = true;
    }
  }
  return keptSummary(output);
}

interface HookAgent {
  id: string;
}

/** A change applied to one work item, given its store. */
type ItemChange = (store: WorkStore, item: StoredWork) => Promise<void>;

type Outcome =
  | { kind: "completed" }
  | { kind: "failed"; error: { message: string } }
  | { kind: "canceled"; reason: string };

/** The outcome a timeline shows for its latest turn: an error item after the last prompt means it failed. */
export function outcomeOf(timeline: readonly AgentTimelineItem[]): Outcome {
  // Only an error that ends the turn fails it; one the agent recovered from does not.
  const last = timeline.at(-1);
  return last?.type === "error" ? { kind: "failed", error: { message: last.message } } : { kind: "completed" };
}

/**
 * Whether a turn end repeats one already recorded in the current running
 * stretch (since the last move to running): the same provider turn id, or an
 * end with no turn start after it. A late hook after a recovered end is the
 * case this catches. Turn ids repeat after a session reopens, so an id only
 * counts within the stretch. Without two ids to compare, `summary` decides
 * when it says anything: a repeat reports the same turn, so the same last
 * words, and an end that says something else is a new turn whose start was
 * missed (an adopted arc between turns writes no state event to start a new
 * stretch).
 */
export function isDuplicateEnd(events: readonly WorkEvent[], turnId: string | null, summary?: string): boolean {
  let lastRun = -1;
  events.forEach((event, index) => {
    if (event.type === "state" && event.to === "running") lastRun = index;
  });
  let lastEnd: Extract<WorkEvent, { type: "turn.ended" }> | null = null;
  let lastEndIndex = -1;
  let lastStart = -1;
  for (let index = lastRun + 1; index < events.length; index += 1) {
    const event = events[index];
    if (event?.type === "turn.started") lastStart = index;
    else if (event?.type === "turn.ended") {
      if (turnId && event.turnId === turnId) return true;
      lastEnd = event;
      lastEndIndex = index;
    }
  }
  if (!lastEnd || lastEndIndex < lastStart) return false;
  // Both carry ids and they differ: a new turn whose start hook was missed, not a repeat.
  if (turnId && lastEnd.turnId) return false;
  // Empty last words are no evidence of a new turn (a hook may carry no timeline): only different words are.
  return !summary || summary === lastEnd.summary;
}

const QUEUE_MS = 120_000;
const INDEX_MS = 15_000;
const MISSED_END_MS = 90_000;
/** Why adopted work left your gate: its session went on with its arc, handing you nothing (engine.ts endTurn). */
const KEPT_WORKING = "The session kept working on its arc; it handed you nothing to decide";

/** How long a decision at the gate waits before it takes effect: the shared undo window. */
export { UNDO_MS };

/** The reason work you stopped is stuck. */
export const STOPPED = "You stopped the run";

/** Why work is Stuck when its session is gone: archived or ended mid-run or mid-question, or never recorded. */
export const ARCHIVED_MID_RUN = "The session was archived before it finished";
export const ARCHIVED_ASKING = "The session was archived while it was asking";
export const ENDED_MID_RUN = "The session ended before the run finished";
export const ENDED_ASKING = "The session ended while it was asking";
export const NO_SESSION = "No session is recorded for this run";

/**
 * The Stuck reasons that say the run's session is gone, your Stop included
 * (it archives the session): such a run holds no slot of the cap (BRO-2990).
 * Any other Stuck run (a failed or canceled turn, an error, a send that did
 * not land) still has its session, and holds one until you unblock or cancel
 * it, or its session goes later (sessionGoneSince: the archive hook, or the
 * reconcile that finds it closed or unknown). A reason not listed here
 * counts, so a renamed one errs toward the cap.
 */
export const SESSION_GONE: ReadonlySet<string> = new Set([
  STOPPED,
  ARCHIVED_MID_RUN,
  ARCHIVED_ASKING,
  ENDED_MID_RUN,
  ENDED_ASKING,
  NO_SESSION,
]);

/** Why work Stop flipped to stuck went back to running: its worktree changed between Stop's two reads. */
export const STOP_RACED = "The worktree changed while Stop checked it";

/**
 * Why work Stop flipped to stuck is no longer that stop, read under the claim
 * just before the archive, or null when it still is: stuck, with Stop's reason,
 * for the same session. A turn that started meanwhile (the session resumed),
 * an Unblock, or a fresh run all move it, and the session is then not Stop's
 * to archive.
 */
function stopMoved(item: StoredWork | null, agentId: string): string | null {
  if (!item) return "the work could not be read again";
  if (workerOf(item.events)?.agentId !== agentId) return "a new run started";
  const state = item.contract.state;
  if (state !== "blocked") return `the work moved to ${PLAIN_VOICE[state].label}`;
  if (reasonOf("blocked", item.events) !== STOPPED) return "the work is stuck for another reason";
  return null;
}

/** Why Leave it running is refused: only a running run with the loop's quiet flag on it is left running. */
export const NOT_QUIET = "Only a run the loop flagged as quiet can be left running.";

/** Why Stop is refused while checks run: the session is done, and the checks decide where the work lands. */
export const CHECKING = "The run already finished and its checks are running. When they report, it lands with you.";

/** Why Stop is refused outside a live run: only a session that is working, or asking you something, has anything to stop. */
export const NOT_STOPPABLE = "Only a run that is working, or asking you something, can be stopped.";

/** Runs `run` once after `ms` and returns what cancels it. */
export type Timer = (run: () => Promise<void>, ms: number) => () => void;

export const realTimer: Timer = (run, ms) => {
  const handle = setTimeout(() => void run(), ms);
  // The decision is on disk: a timer alone never keeps the process up, and the load sweep applies it after a restart.
  handle.unref?.();
  return () => clearTimeout(handle);
};

export interface EngineOptions {
  now?: () => Date;
  /** Told after a run's end or its checks are written, with the item before and after; not awaited (server/gate-card.ts). */
  landed?: (before: StoredWork, after: StoredWork) => unknown;
  config?: () => Promise<MaestroConfig>;
  log?: (message: string) => void;
  /** The daemon client once the plugin has one. A decision that comes due with nothing else in hand uses it. */
  client?: () => Paseo | null;
  /** Schedules the undo window. Tests pass their own, driven by the same clock as `now`. */
  timer?: Timer;
  /** The longest one daemon call made while holding an item's claim may take. Tests pass a short one. */
  claimWaitMs?: number;
  /** A worktree's branch and remote, read when work is bound (server/branch-merge.ts gitOf). Tests pass their own. */
  git?: (cwd: string | null) => Promise<{ branch: string | null; githubRepo: string | null }>;
  /** A branch's merged PR as known now, asked in the background (server/branch-merge.ts mergedPrs). Tests pass their own. */
  merged?: (repo: string, branch: string) => Promise<MergedPr | null>;
  /** Sets labels on a session: the plugin passes server/labels.ts paseoLabel (the paseo CLI); absent, nothing is labelled. */
  label?: LabelAgent;
  /**
   * The profile a run nobody watches starts with, for the session that asked
   * for it (runs.ts LaneProfile). Absent: your Settings, whoever asked
   * (settingsLane), since the socket does not verify its caller yet: the seam
   * BRO-2996 verifies the caller against, and BRO-2989 reads lanes.yaml in.
   */
  lane?: (agentId: string | null, paseo: Paseo, config: MaestroConfig) => Promise<LaneProfile | null>;
}

/** What work.create takes: the work, where it runs, how it is judged, and optionally how its runs start. */
export type CreateInput = RunChoices & {
  /** Blank takes the brief's first line. */
  title?: string;
  brief: string;
  repo: string;
  gate: "human" | "auto";
  check: string;
  initiative: string;
  dispatch: boolean;
  /** Why only you start it (`hold`): set by Maestro itself, never by an RPC's input. */
  hold?: string;
  /** The idea it was filed for (`<ledger>#<id>`): set by Maestro itself, never by an RPC's input. */
  idea?: string;
  /** The answer it was filed for (server/answer-routes.ts): set by Maestro itself, never by an RPC's input. */
  answer?: string;
};

/** Only the run choices that were made: an absent one means Settings at dispatch. */
function runKeys(input: RunChoices): RunKeys {
  const keys: RunKeys = {};
  if (input.provider?.trim()) keys.provider = input.provider.trim();
  if (input.isolation) keys.isolation = input.isolation;
  if (input.modeId?.trim()) keys.modeId = input.modeId.trim();
  if (input.thinkingOptionId?.trim()) keys.thinkingOptionId = input.thinkingOptionId.trim();
  if (input.featureValues && Object.keys(input.featureValues).length > 0) keys.featureValues = input.featureValues;
  return keys;
}

// Who must start a run lives beside how it starts (server/runs.ts); tests read it here.
export { MODED_BY_YOU, PROMPT_FREE } from "./runs";

/** See EngineOptions.claimWaitMs. */
export const CLAIM_WAIT_MS = 30_000;

/** A session's labels, once set, are asked for again after this long if they are gone (BRO-2908). */
export const LABEL_AGAIN_MS = 10 * 60_000;
/** After a failed label call, the first wait before asking again; it doubles per failure, up to LABEL_AGAIN_MS. */
export const LABEL_RETRY_MS = 60_000;

/** `work()`, or a rejection once `ms` pass: a claim, or a wake, never waits on the daemon for ever. */
export function within<T>(work: () => Promise<T>, ms: number): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error(`Paseo did not answer within ${Math.round(ms / 100) / 10}s`)), ms);
  });
  return Promise.race([Promise.resolve().then(work), late]).finally(() => clearTimeout(handle));
}

/**
 * Why Cancel is refused while the agent asks: canceling closes the work but
 * leaves the session alive, its turn waiting on a question nobody would see.
 * Stop archives the session; the work can be canceled from Stuck after.
 */
export const STOP_BEFORE_CANCEL = "The agent is asking you something. Stop the run first, then cancel the work.";

/** Why a decision cannot be made (or, when it comes due, applied) on this item right now. */
function gateRefusal(item: StoredWork, verdict: Verdict, applying: boolean): string | null {
  if (item.contract.state !== "review") {
    return applying ? "It was no longer waiting on you." : "Only work waiting on you takes a verdict.";
  }
  if (pendingPermission(item.events)) {
    return verdict === "block" ? STOP_BEFORE_CANCEL : "The agent is waiting on a question. Answer it first.";
  }
  if (verdict === "revise" && !workerOf(item.events)) return "There is no session to send this back to.";
  return null;
}

const ALREADY_PENDING = "A decision is already waiting to take effect. Undo it first to change it.";

/** Why a decision is dropped when the run moved after it was made: you decided on a result that is no longer the one there. */
export const RUN_WENT_ON = "The run went on after you decided.";

/** Events that mean the run moved: any state change, or a turn starting or ending. */
const WENT_ON: ReadonlySet<WorkEvent["type"]> = new Set(["state", "turn.started", "turn.ended"]);

/** How often a decision that is due, and needs a client to apply, looks again for one. */
export const CLIENT_WAIT_MS = 5_000;

type ApplyOutcome = "applied" | "dropped" | "early" | "waiting" | "settled";

/** Why Maestro itself never starts a run (owner answer A8, BRO-2990). */
export const NEVER_BY_RULE =
  "Maestro never starts work by a rule of its own: you start it with Dispatch, or a lane or the conductor does.";

/**
 * Why this caller may not start this work, or null. You may start queued or
 * stuck work, or a run with no session recorded. A session may start only
 * queued work (restarting stuck work is unblocking, and that is yours), and
 * never work that carries a mode you chose for it: the mode is yours to use,
 * nor work held for you (`hold`). Its run is one nobody watches, so dispatch
 * also needs its lane profile's mode (unattendedRefusal).
 * Maestro itself (the loop, answer routing) starts nothing (A8): it queues.
 */
function startRefusal(item: StoredWork, origin: Origin): string | null {
  const state = item.contract.state;
  switch (origin.actor) {
    case "agent":
      if (!isDispatchable(state)) return "A session can start only queued work. Stuck work is unblocked in Maestro.";
      if (item.contract.hold) return HELD_FOR_YOU;
      // Filed from your answer before A8 (runs.ts filedBeforeA8): yours, as held work is.
      if (filedBeforeA8(item)) return FILED_BEFORE_A8;
      // auto_accept is a mode by another name: it skips the prompts too (shared/run.ts).
      return item.contract.modeId || skipsPrompts({ featureValues: item.contract.featureValues }) ? MODED_BY_YOU : null;
    case "maestro":
      return NEVER_BY_RULE;
    case "human":
      if (isDispatchable(state) || state === "blocked" || (state === "running" && !workerOf(item.events))) return null;
      return "Only queued or stuck work can be dispatched.";
  }
}

export class Engine {
  private readonly now: () => Date;
  private readonly readConfig: () => Promise<MaestroConfig>;
  private readonly log: (message: string) => void;
  private readonly landed: NonNullable<EngineOptions["landed"]>;
  private readonly dispatching = new Set<string>();
  /** Sessions being tracked right now, so two calls at once cannot make two items for one session. */
  private readonly adopting = new Set<string>();
  private readonly activeChecks = new Set<string>();
  private readonly checkRuns = new Map<string, AbortController>();
  /** Hook events for an agent that is not bound yet, in arrival order. */
  private readonly queues = new Map<string, { at: number; runs: Array<() => Promise<unknown>> }>();
  /**
   * Per work root, agent id to work folder: every scan and every binding adds
   * to it and nothing clears it, so a scan that started before a binding was
   * written can never erase that binding. An entry is dropped only when its
   * folder turns out to hold a different session.
   */
  private readonly agentDirs = new Map<string, Map<string, string>>();
  private readonly indexedAt = new Map<string, number>();
  private readonly draining = new Set<string>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly abort = new AbortController();
  /** Per agent, the daemon's `updatedAt` when reconcile last read its timeline for a missed end. */
  private readonly readAt = new Map<string, string>();
  /** An adopter's session title by its agent id, read in the background (BRO-2938). */
  private readonly adopterName: ReturnType<typeof adopterNames>;
  private readonly client: () => Paseo | null;
  private readonly timer: Timer;
  private readonly claimWaitMs: number;
  private readonly gitOf: (cwd: string | null) => Promise<{ branch: string | null; githubRepo: string | null }>;
  private readonly merged: (repo: string, branch: string) => Promise<MergedPr | null>;
  private readonly label: LabelAgent;
  /** Each session's labels as Maestro last asked for them: when, and how many asks in a row failed. */
  private readonly labelled = new Map<string, { key: string; at: number; failures: number; flying: boolean }>();
  /** Label calls run one at a time: each is a paseo CLI process (server/labels.ts). */
  private labelQueue: Promise<void> = Promise.resolve();
  /** Pending decisions with a timer armed, by token, to the timer's cancel. */
  private readonly armed = new Map<string, () => void>();
  /** Decisions being applied right now, by token, so a timer and a sweep never apply one twice. */
  private readonly applying = new Set<string>();
  /** Dispatches that passed the capacity check and have not finished: each holds a slot. */
  private readonly admitted = new Set<string>();
  /**
   * Runs being stopped, until the archive settles (mi-1): Stop records the run
   * stuck before it archives, which frees its slot by the files, and a failed
   * archive puts it back to running. Each keeps its slot meanwhile.
   */
  private readonly stopping = new Set<string>();
  /**
   * One per capacity check in flight: every run being stopped at any time
   * since that check began reading. A stop that starts after the check read
   * its list, or ends before the check reads the files, is still counted.
   */
  private readonly stopWatch = new Set<Set<string>>();
  private readonly lane: NonNullable<EngineOptions["lane"]>;
  private closed = false;

  constructor(options: EngineOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.adopterName = adopterNames(() => this.now().getTime());
    this.readConfig = options.config ?? (() => loadConfig());
    this.log = options.log ?? ((message) => console.log(`[maestro] ${message}`));
    this.landed = options.landed ?? (() => undefined);
    this.client = options.client ?? (() => null);
    this.timer = options.timer ?? realTimer;
    this.claimWaitMs = options.claimWaitMs ?? CLAIM_WAIT_MS;
    this.gitOf = options.git ?? gitOf;
    this.merged = options.merged ?? mergedPrs(undefined, undefined, this.log);
    // No label unless one is passed: index.server.ts passes the paseo CLI, so no test can label a real session.
    this.label = options.label ?? (async () => undefined);
    this.lane = options.lane ?? (async (_agentId, _paseo, config) => settingsLane(config));
  }

  /**
   * Labels a work's session with its work, and its ticket and parent where the
   * session has none of its own (BRO-2908): the harness registry is Paseo, so a
   * session can be found from there as well as from here. A label the session
   * already carries is never overwritten (an orchestrator's `ticket` stays).
   * Never awaited by a verb and never fatal. Asked once per value: again after
   * LABEL_AGAIN_MS once set (reconcile asks only when the work label is gone,
   * so a removed work label comes back; a removed ticket or parent label does
   * not), after a growing backoff when it failed, never while a call is in
   * flight. Calls run one at a time, and every one settles the queue.
   */
  private labelSession(
    agentId: string,
    work: { id: string; ticket?: string | null; parentWork?: string | null },
    has: Readonly<Record<string, string>> = {},
  ): void {
    const wanted = workLabels(work);
    const labels = Object.fromEntries(Object.entries(wanted).filter(([key]) => key === WORK_LABEL || !has[key]));
    const key = JSON.stringify(labels);
    const last = this.labelled.get(agentId);
    if (last?.flying) return;
    if (last?.key === key) {
      const wait =
        last.failures === 0 ? LABEL_AGAIN_MS : Math.min(LABEL_RETRY_MS * 2 ** (last.failures - 1), LABEL_AGAIN_MS);
      if (this.now().getTime() - last.at < wait) return;
    }
    const failures = last?.key === key ? last.failures : 0;
    const entry = { key, at: this.now().getTime(), failures, flying: true };
    this.labelled.set(agentId, entry);
    this.labelQueue = this.labelQueue.then(async () => {
      try {
        await this.label(agentId, labels);
        entry.failures = 0;
      } catch (error) {
        entry.failures = failures + 1;
        this.log(`labelling session ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        // Stamped when it settles, so a long queue never asks the same session twice.
        entry.at = this.now().getTime();
        entry.flying = false;
      }
    });
  }

  /** For a test: waits for the label calls asked for so far. */
  labelsSettled(): Promise<void> {
    return this.labelQueue;
  }

  /** The settings runs start from, as this engine reads them. */
  settings(): Promise<MaestroConfig> {
    return this.readConfig();
  }

  /** The plugin is shutting down: stop check runs and clear every undo timer. Pending decisions stay on disk. */
  stop(): void {
    this.closed = true;
    this.abort.abort();
    for (const cancel of this.armed.values()) cancel();
    this.armed.clear();
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  private async store(): Promise<{ store: WorkStore; config: MaestroConfig }> {
    const config = await this.readConfig();
    return { store: new WorkStore(config.workRoot, this.now), config };
  }

  private tokens = 0;

  /** Unique per check run, even for two turn ends stamped in the same millisecond. */
  private checkToken(agentId: string, ts: string): string {
    this.tokens += 1;
    return `${agentId}:${ts}:${process.pid}.${this.tokens}`;
  }

  /** Tells `landed` about a change without letting it throw into, or hold up, the caller. */
  private tellLanded(before: StoredWork, after: StoredWork): void {
    void Promise.resolve()
      .then(() => this.landed(before, after))
      .catch((error) => this.log(`landing hook failed for ${after.contract.id}: ${(error as Error).message}`));
  }

  private note(text: string): WorkEvent {
    return { ts: this.stamp(), type: "note", actor: "maestro", text };
  }

  // ── The agent index ────────────────────────────────────────────────────────

  private dirs(root: string): Map<string, string> {
    let dirs = this.agentDirs.get(root);
    if (!dirs) {
      dirs = new Map();
      this.agentDirs.set(root, dirs);
    }
    return dirs;
  }

  private knows(agentId: string): boolean {
    for (const dirs of this.agentDirs.values()) if (dirs.has(agentId)) return true;
    return false;
  }

  private index(store: WorkStore, items: readonly StoredWork[]): void {
    const dirs = this.dirs(store.root);
    for (const item of items) {
      const worker = workerOf(item.events);
      if (worker) dirs.set(worker.agentId, item.dir);
    }
    this.indexedAt.set(store.root, Date.now());
  }

  /** The item in `dir`, read now, if its current session is this agent. */
  private async loadBound(store: WorkStore, dir: string, agentId: string): Promise<StoredWork | null> {
    const item = await store.load(dir).catch(() => null);
    if (item && workerOf(item.events)?.agentId === agentId) return item;
    return null;
  }

  /**
   * The work whose most recent run is this agent. Known agents load their one
   * folder; unknown ones trigger a scan at most every few seconds, so hooks
   * from agents Maestro does not track stay cheap.
   */
  private async findByAgent(store: WorkStore, agentId: string): Promise<StoredWork | null> {
    const dirs = this.dirs(store.root);
    const dir = dirs.get(agentId);
    if (dir) {
      const item = await this.loadBound(store, dir, agentId);
      if (item) return item;
      if (dirs.get(agentId) === dir) dirs.delete(agentId);
    }
    const fresh = Date.now() - (this.indexedAt.get(store.root) ?? 0) < INDEX_MS;
    if (fresh && this.dispatching.size === 0) return null;
    const { items } = await store.scan();
    this.index(store, items);
    const found = dirs.get(agentId);
    return found ? this.loadBound(store, found, agentId) : null;
  }

  /**
   * An adoption records its orchestrator by agent id (agent-socket.ts origin):
   * the list says its session title instead, as far as it is known now. The
   * read happens in the background (adopter-names.ts), so no list waits on it.
   */
  private namedAdopters(wire: WorkItem[], paseo?: Paseo): WorkItem[] {
    const read = paseo
      ? async (id: string) => {
          const snapshot = await within(() => paseo.agents.ref(id).refresh(), this.claimWaitMs);
          return snapshot?.agent.title ?? null;
        }
      : undefined;
    return wire.map((item) =>
      item.adoptedBy?.by ? { ...item, adoptedBy: { by: this.adopterName(item.adoptedBy.by, read) } } : item,
    );
  }

  /** For a test: waits for the adopter names being read. */
  adoptersSettled(): Promise<void> {
    return this.adopterName.settled();
  }

  // ── Reads ──────────────────────────────────────────────────────────────────
  //
  // Reads are queries (BRO-2995): no read writes a file, sends, creates or
  // archives a session, or arms a timer that will. A poll's rate is therefore
  // irrelevant to what happens; keeping the work true to Paseo and applying
  // decisions that came due is the plugin sweep's (upkeep, server/sweep.ts).

  /** All work, as the files say now. The client, when given, only names adopters (a read, in the background). */
  async list(paseo?: Paseo): Promise<{
    root: string;
    items: WorkItem[];
    scoreboard: ReturnType<typeof scoreboard>;
    warnings: string[];
  }> {
    const { store, config } = await this.store();
    const { items, warnings } = await store.scan();
    this.index(store, items);
    const now = this.now();
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const wire = this.namedAdopters(
      items.map((item) => toWire(item, now.getTime(), config)),
      paseo,
    );
    wire.sort(
      (a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || b.updatedAt.localeCompare(a.updatedAt),
    );
    return {
      root: store.root,
      items: wire,
      scoreboard: scoreboard(
        items.map((item) => item.events),
        now.getTime(),
        dayStart.getTime(),
        items.map((item) => placement(item.rel).initiative),
      ),
      warnings,
    };
  }

  /**
   * The plugin sweep's work on the store (server/sweep.ts), the one place
   * outside a hook or a verb that writes it: reconcile every bound run with
   * Paseo when there is a client, then apply the decisions whose undo window
   * has closed (arming a timer for the rest). True when any work changed.
   */
  async upkeep(paseo: Paseo | null): Promise<boolean> {
    const { store } = await this.store();
    let { items } = await store.scan();
    this.index(store, items);
    let changed = false;
    if (paseo && (await this.reconcile(paseo, items))) {
      changed = true;
      ({ items } = await store.scan());
      this.index(store, items);
    }
    if (await this.sweep(paseo, items)) changed = true;
    return changed;
  }

  /** The work filed for each idea (Contract.idea, `<ledger>#<id>`): the first found, by id, wins. */
  async developed(): Promise<Map<string, { id: string; title: string; path: string }>> {
    const { store } = await this.store();
    const { items } = await store.scan();
    const found = new Map<string, { id: string; title: string; path: string }>();
    for (const item of [...items].sort((a, b) => a.contract.id.localeCompare(b.contract.id))) {
      const idea = item.contract.idea;
      if (idea && !found.has(idea)) found.set(idea, { id: item.contract.id, title: item.title, path: item.rel });
    }
    return found;
  }

  /** The work filed for each answer (Contract.answer): the first found, by id, wins. */
  async answered(): Promise<Map<string, { id: string; title: string; path: string }>> {
    const { store } = await this.store();
    const { items } = await store.scan();
    const found = new Map<string, { id: string; title: string; path: string }>();
    for (const item of [...items].sort((a, b) => a.contract.id.localeCompare(b.contract.id))) {
      const answer = item.contract.answer;
      if (answer && !found.has(answer)) found.set(answer, { id: item.contract.id, title: item.title, path: item.rel });
    }
    return found;
  }

  async get(id: string) {
    const { store, config } = await this.store();
    const item = await store.findById(id);
    return {
      item: toWire(item, this.now().getTime(), config),
      brief: briefOf(item.work.body),
      events: toWireEvents(item.events),
      checkResults: latestChecks(item.events),
    };
  }

  async forAgent(agentId: string): Promise<WorkItem | null> {
    const { store, config } = await this.store();
    const item = await this.findByAgent(store, agentId);
    return item ? toWire(item, this.now().getTime(), config) : null;
  }

  // ── The loop's flags ───────────────────────────────────────────────────────

  /**
   * Put work in Needs you for the loop (server/flags.ts): one `loop.flagged`
   * event, no state change, written under the work's lock. Only while the
   * reason still stands on the work as its files are now, and only when its
   * current flag is not already of this kind, so a wake every minute adds
   * nothing. Returns whether it wrote one. `since` (quiet only): when the
   * run last did anything, so the reason keeps counting from there.
   */
  async flag(item: Pick<WorkItem, "id" | "path">, kind: FlagKind, reason: string, since?: string): Promise<boolean> {
    const { store, config } = await this.store();
    let wrote = false;
    await store.mutate(
      item.id,
      (fresh) => {
        if (flagOf(fresh.events)?.kind === kind) return null;
        if (!flagStands(kind, fresh, this.now().getTime(), config)) return null;
        wrote = true;
        const flagged: FlaggedEvent = {
          ts: this.stamp(),
          type: "loop.flagged",
          actor: "maestro",
          kind,
          reason,
          ...(since ? { since } : {}),
        };
        return { events: [flagged] };
      },
      join(store.root, item.path),
    );
    return wrote;
  }

  /**
   * Take a quiet flag down for the loop: its session last did anything at
   * `activeAt` (the daemon's word), which is since the flag's `since` and
   * within QUIET_MS (server/flags.ts quietCleared). One `flag.cleared`
   * receipt by Maestro, written under the work's lock, only while the work is
   * still running with a quiet flag, so a wake that raced a turn's end or your
   * Leave it running adds nothing. Not a look, and not activity: the quiet
   * clock still counts from the run's last event. Returns whether it wrote one.
   */
  async clearQuiet(item: Pick<WorkItem, "id" | "path">, activeAt: number): Promise<boolean> {
    const { store } = await this.store();
    let wrote = false;
    await store.mutate(
      item.id,
      (fresh) => {
        const flag = flagOf(fresh.events);
        if (fresh.contract.state !== "running" || !flag) return null;
        if (!quietCleared(flag, fresh.events, fresh.mtime, activeAt, this.now().getTime())) return null;
        wrote = true;
        return {
          events: [{ ts: this.stamp(), type: "flag.cleared", actor: "maestro", kind: flag.kind, reason: ACTIVE_AGAIN }],
        };
      },
      join(store.root, item.path),
    );
    return wrote;
  }

  /**
   * You looked at a run the loop flagged as quiet and left it running: your
   * receipt, which clears the flag (flagOf) and restarts the quiet clock from
   * now (lastActivityOf), so the loop flags it again only after another
   * QUIET_MS with nothing from Maestro or its session. Checked under the
   * work's lock: refused unless it is still running with a quiet flag.
   */
  async leaveRunning(id: string): Promise<WorkItem> {
    const { store, config } = await this.store();
    const current = await store.findById(id);
    const updated = await store.mutate(
      id,
      (fresh) => {
        const flag = flagOf(fresh.events);
        if (fresh.contract.state !== "running" || flag?.kind !== "quiet") throw new UserError(NOT_QUIET);
        return {
          events: [{ ts: this.stamp(), type: "flag.dismissed", actor: "human", kind: flag.kind, reason: flag.reason }],
        };
      },
      current.dir,
    );
    return toWire(updated, this.now().getTime(), config);
  }

  // ── Human verbs ────────────────────────────────────────────────────────────

  async create(paseo: Paseo | null, input: CreateInput, origin: Origin = BY_HUMAN): Promise<WorkItem> {
    const title = workTitle(input.title, input.brief);
    if (!title) throw new UserError("Write a brief, or at least a title.");
    if (input.gate === "auto" && !input.check.trim()) {
      throw new UserError("Letting checks decide needs a check command.");
    }
    // How runs start is yours alone: work anyone else creates carries no run choices, so its runs start as
    // your Settings say, and a run nobody watches only in a Settings mode that does not ask (unattendedRefusal).
    const run = origin.actor === "human" ? runKeys(input) : undefined;
    const folder = await inspectFolder(input.repo);
    const repo = folder.path;
    if (!isAbsolute(repo)) throw new UserError("Use an absolute path for the repository.");
    if (!folder.directory) throw new UserError(`No folder at ${repo}.`);
    const { store, config } = await this.store();
    const refusal = await repoRefusal(repo, config.workRoot);
    if (refusal) throw new UserError(refusal);
    if ((run?.isolation ?? config.isolation) === "worktree" && !folder.git) {
      throw new UserError(
        `${repo} is not a git repository, and each run gets a new worktree. Choose a repository, or run in the folder itself.`,
      );
    }
    const item = await store.create({
      title,
      brief: input.brief,
      repo,
      gate: input.gate,
      check: input.check,
      initiative: input.initiative,
      now: this.now(),
      origin,
      run,
      hold: input.hold,
      idea: input.idea,
      answer: input.answer,
    });
    if (input.dispatch) {
      if (!paseo) throw new UserError(`Created ${item.contract.id}, but it cannot be dispatched yet: ${NO_HANDLE}`);
      return this.dispatch(paseo, item.contract.id, origin);
    }
    return toWire(item, this.now().getTime(), config);
  }

  /**
   * Create work and, when asked, dispatch it. At the concurrency cap, or when
   * a session's run would have nobody watching it in a mode that asks
   * (Unwatched), the work is still created: it comes back queued with the
   * reason, so the caller holds its id and a retry dispatches it rather than
   * creating it again.
   */
  async createWork(
    paseo: Paseo | null,
    input: Parameters<Engine["create"]>[1],
    origin: Origin = BY_HUMAN,
  ): Promise<{ item: WorkItem; notice: string | null }> {
    const item = await this.create(paseo, { ...input, dispatch: false }, origin);
    if (!input.dispatch) return { item, notice: null };
    if (!paseo) throw new UserError(`Created ${item.id}, but it cannot be dispatched yet: ${NO_HANDLE}`);
    try {
      return { item: await this.dispatch(paseo, item.id, origin), notice: null };
    } catch (error) {
      if (!(error instanceof AtCapacity || error instanceof Unwatched)) throw error;
      return { item: (await this.get(item.id)).item, notice: `Created ${item.id}, not started. ${error.message}` };
    }
  }

  async dispatch(paseo: Paseo, id: string, origin: Origin = BY_HUMAN): Promise<WorkItem> {
    // Maestro itself starts nothing (A8): refused before it takes a slot or reads a file.
    if (origin.actor === "maestro") throw new UserError(NEVER_BY_RULE);
    if (this.dispatching.has(id)) throw new UserError("This work is already being dispatched.");
    this.dispatching.add(id);
    let ahead: string[] = [];
    let stops: Set<string> | null = null;
    try {
      // A session's run is one nobody watches: it takes its profile's mode, and never Always ask (A8). Read
      // and judged before it takes a slot, so a start that is refused never holds one while the profile is read.
      const lane = origin.actor === "agent" ? await this.unwatchedLane(paseo, id, origin.by) : null;
      // Take a slot before reading the files: every dispatch admitted ahead of this one is
      // counted from here, whether or not the files say it holds a slot by the time they are read.
      ahead = [...this.admitted];
      this.admitted.add(id);
      stops = this.watchStops();
      const { store, config } = await this.store();
      const item = await store.findById(id);
      const refusal = startRefusal(item, origin);
      if (refusal) throw new UserError(refusal);
      this.checkCapacity(item, ahead, await this.occupied(store), config.concurrencyCap, stops);
      let worker: Awaited<ReturnType<typeof startRun>>;
      try {
        worker = await startRun(paseo, config, item, lane);
      } catch (error) {
        const message = (error as Error).message;
        await store.mutate(id, () => ({ events: [this.note(`Dispatch failed: ${message}`)] }), item.dir);
        throw new UserError(`Could not start the run: ${message}`);
      }
      let bound: StoredWork;
      try {
        // Re-check under the lock: the work may have been canceled or resumed while the run started.
        bound = await store.mutate(
          id,
          (fresh) => {
            if (startRefusal(fresh, origin)) throw new UserError("The work changed while the run was starting.");
            return {
              to: "running",
              actor: origin.actor,
              events: [{ ts: this.stamp(), type: "dispatched", ...worker, ...origin }],
            };
          },
          item.dir,
        );
      } catch (error) {
        // Never leave an agent running for work that does not record it.
        this.queues.delete(worker.agentId);
        const archived = await paseo.agents
          .ref(worker.agentId)
          .archive()
          .then(() => true)
          .catch(() => false);
        // Only a workspace this dispatch created is ours to archive; in directory mode it is the user's own.
        const workspaceId = worker.branch ? worker.workspaceId : null;
        if (workspaceId) {
          // Best effort: a failed cleanup must never replace the error that caused it.
          await Promise.resolve()
            .then(() => paseo.workspaces.archive(workspaceId))
            .catch(() => undefined);
        }
        await store
          .mutate(
            id,
            () => ({
              events: [
                this.note(
                  `${archived ? "Archived" : "Could not archive"} session ${worker.agentId}: ${(error as Error).message}`,
                ),
              ],
            }),
            item.dir,
          )
          .catch(() => undefined);
        throw error instanceof UserError ? error : new UserError((error as Error).message);
      }
      this.dirs(store.root).set(worker.agentId, bound.dir);
      await this.flush(worker.agentId);
      return toWire(await store.fresh(id, bound.dir), this.now().getTime(), config);
    } finally {
      this.dispatching.delete(id);
      this.admitted.delete(id);
      if (stops) this.stopWatch.delete(stops);
      // With no dispatch left in flight nothing else can bind a queued agent: settle every queue now.
      if (this.dispatching.size === 0) {
        for (const agentId of [...this.queues.keys()]) await this.flush(agentId);
      }
    }
  }

  /**
   * The profile a session's run starts with, or why it may not start: the
   * work's own refusal first (a session starts only queued work, never yours
   * to start), then unattendedRefusal (Unwatched). Read before any slot.
   */
  private async unwatchedLane(paseo: Paseo, id: string, agentId: string | null): Promise<LaneProfile> {
    const { store, config } = await this.store();
    const item = await store.findById(id);
    const refusal = startRefusal(item, { actor: "agent", by: agentId });
    if (refusal) throw new UserError(refusal);
    const read = await this.laneOf(agentId, paseo, config);
    const unattended = unattendedRefusal(read.lane, runSettings(config, item).selection, read.error);
    if (unattended || !read.lane) throw new Unwatched(unattended ?? "A run nobody watches has no profile.");
    return read.lane;
  }

  /** The profile of a run a session asked for, bounded; one that cannot be read is none, and says why. */
  private async laneOf(
    agentId: string | null,
    paseo: Paseo,
    config: MaestroConfig,
  ): Promise<{ lane: LaneProfile | null; error: string | null }> {
    try {
      return { lane: await within(() => this.lane(agentId, paseo, config), this.claimWaitMs), error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`reading the lane profile of ${agentId ?? "an unnamed session"}: ${message}`);
      return { lane: null, error: message };
    }
  }

  /**
   * The work whose run holds a slot now, as the files say, by why (BRO-2990):
   * running, waiting on a permission (at the gate with a question pending), or
   * stuck while its session is still there (SESSION_GONE). A run that stopped
   * to ask, or stopped on a failed turn, still has its session; one that landed
   * at your gate with nothing pending, ended, lost its session, or that you
   * stopped frees its slot.
   */
  private async occupied(store: WorkStore): Promise<Map<string, Slot>> {
    const { items } = await store.scan();
    const held = new Map<string, Slot>();
    for (const other of items) {
      const slot = slotOf(other);
      if (slot) held.set(other.contract.id, slot);
    }
    return held;
  }

  /** Watch the stops from now on, for one capacity check: the runs being stopped now, and every one that starts. */
  private watchStops(): Set<string> {
    const stops = new Set(this.stopping);
    this.stopWatch.add(stops);
    return stops;
  }

  /** A run being stopped keeps its slot until `release` (mi-1). */
  private holdStop(id: string): () => void {
    this.stopping.add(id);
    for (const watch of this.stopWatch) watch.add(id);
    return () => this.stopping.delete(id);
  }

  /**
   * What holds the cap's slots now, besides `item`: the files (occupied), every
   * dispatch admitted, and every run being stopped. For a resume that cannot be
   * refused (startTurn), so it is only said.
   */
  private async busyNow(store: WorkStore, item: StoredWork): Promise<Map<string, Slot>> {
    const busy = new Map<string, Slot>([...this.admitted].map((id) => [id, "starting"]));
    for (const id of this.stopping) busy.set(id, "stopping");
    for (const [id, slot] of await this.occupied(store)) busy.set(id, slot);
    busy.delete(item.contract.id);
    return busy;
  }

  /**
   * Refuse at the cap. Busy is every run the files say holds a slot (occupied)
   * plus every dispatch that took a slot before this one did (`ahead`, read
   * before the files). A dispatch holds its slot until it ends, so past the
   * point its run is recorded running, or until it fails: each one ahead is
   * counted by the files or by its slot, since the files are read after the
   * slot list, and a run counted by both is one id, counted once. A run being
   * stopped (`stopping`, watched from before the files are read) holds its
   * slot until its archive settles, whatever the files say meanwhile.
   */
  private checkCapacity(
    item: StoredWork,
    ahead: readonly string[],
    occupied: ReadonlyMap<string, Slot>,
    cap: number | null,
    stopping: ReadonlySet<string> = new Set(),
  ): void {
    const busy = new Map<string, Slot>(ahead.map((id) => [id, "starting"]));
    for (const id of stopping) busy.set(id, "stopping");
    for (const [id, slot] of occupied) busy.set(id, slot);
    busy.delete(item.contract.id);
    if (cap !== null && busy.size >= cap) {
      throw new AtCapacity(
        `At capacity: ${capacityWords(busy, cap)}. It stays ${PLAIN_VOICE[item.contract.state].label.toLowerCase()}.`,
      );
    }
  }

  /** Refuse a decision while the session is visibly working again: the result is not final. */
  private async assertIdle(paseo: Paseo | undefined, item: StoredWork): Promise<void> {
    const worker = workerOf(item.events);
    if (!paseo || !worker) return;
    const snapshot = await paseo.agents
      .ref(worker.agentId)
      .refresh()
      .catch(() => null);
    if (snapshot?.agent.status === "running") {
      throw new UserError("The session is working again. Wait for it to stop, then decide.");
    }
  }

  /**
   * Record a decision at the gate. It takes effect UNDO_MS later, unless it is
   * undone first; every guard here is checked again when it applies. The look
   * counts now, when you decide.
   */
  async verdict(paseo: Paseo | null | undefined, id: string, verdict: Verdict, note: string): Promise<WorkItem> {
    const { store, config } = await this.store();
    const trimmed = note.trim();
    if (verdict === "revise" && !trimmed) throw new UserError("Say what should change before sending it back.");
    const current = await store.findById(id);
    const early = gateRefusal(current, verdict, false) ?? (pendingDecision(current.events) ? ALREADY_PENDING : null);
    if (early) throw new UserError(early);
    if (verdict !== "block") await this.assertIdle(paseo ?? undefined, current);
    const token = randomUUID();
    const decided = this.now();
    const effectiveAt = new Date(decided.getTime() + UNDO_MS).toISOString();
    const updated = await store.mutate(
      id,
      (item) => {
        const refusal = gateRefusal(item, verdict, false) ?? (pendingDecision(item.events) ? ALREADY_PENDING : null);
        if (refusal) throw new UserError(refusal);
        return {
          events: [
            {
              ts: decided.toISOString(),
              type: "gate.pending",
              actor: "human",
              verdict,
              note: trimmed,
              token,
              effectiveAt,
            },
          ],
        };
      },
      current.dir,
    );
    this.arm(id, token, effectiveAt, paseo ?? null, updated.dir);
    return toWire(updated, this.now().getTime(), config);
  }

  /** Take back a decision that has not taken effect yet. */
  async undo(id: string): Promise<WorkItem> {
    const { store, config } = await this.store();
    const current = await store.findById(id);
    let token: string | null = null;
    const updated = await store.mutate(
      id,
      (item) => {
        const pending = pendingDecision(item.events);
        if (!pending) {
          throw new UserError(
            decisionApplied(item.events)
              ? "Too late to undo: it already took effect."
              : "There is no decision waiting to take effect.",
          );
        }
        token = pending.token;
        return {
          events: [
            { ts: this.stamp(), type: "gate.undone", actor: "human", verdict: pending.verdict, token: pending.token },
          ],
        };
      },
      current.dir,
    );
    if (token) this.disarm(token);
    return toWire(updated, this.now().getTime(), config);
  }

  /**
   * Apply every decision whose window has closed, and arm a timer for the rest.
   * Runs in every sweep (upkeep), the first one at load, so a restart inside the
   * window still applies the decision. Never from a read. True when any changed.
   */
  async sweep(paseo?: Paseo | null, items?: readonly StoredWork[]): Promise<boolean> {
    const all = items ?? (await (await this.store()).store.scan()).items;
    let changed = false;
    for (const item of all) {
      const pending = pendingDecision(item.events);
      if (!pending) continue;
      const id = item.contract.id;
      if (Date.parse(pending.effectiveAt) > this.now().getTime()) {
        this.arm(id, pending.token, pending.effectiveAt, paseo ?? null, item.dir);
        continue;
      }
      const outcome = await this.applyPending(paseo ?? null, id, pending.token, item.dir).catch((error) => {
        this.log(`applying the decision on ${id}: ${(error as Error).message}`);
        return "settled" as const;
      });
      // Due but no client yet: try again on a timer, so it never hangs on a sweep that may not come.
      if (outcome === "waiting")
        this.arm(id, pending.token, pending.effectiveAt, paseo ?? null, item.dir, CLIENT_WAIT_MS);
      if (outcome === "applied" || outcome === "dropped") changed = true;
    }
    return changed;
  }

  /** Apply the decision when its window closes, or after `delay` when given (waiting for a client). */
  private arm(id: string, token: string, effectiveAt: string, paseo: Paseo | null, dir: string, delay?: number): void {
    if (this.closed || this.armed.has(token)) return;
    const wait = delay ?? Math.max(0, Date.parse(effectiveAt) - this.now().getTime());
    const cancel = this.timer(async () => {
      const outcome = await this.applyPending(paseo, id, token, dir).catch((error) => {
        this.log(`applying the decision on ${id}: ${(error as Error).message}`);
        return "settled" as const;
      });
      // Armed until its apply settles, so a sweep meanwhile never arms a second timer for it.
      if (this.armed.get(token) === cancel) this.armed.delete(token);
      // Fired before the clock reached it: wait out the rest.
      if (outcome === "early") this.arm(id, token, effectiveAt, paseo, dir);
      if (outcome === "waiting") this.arm(id, token, effectiveAt, paseo, dir, CLIENT_WAIT_MS);
    }, wait);
    this.armed.set(token, cancel);
  }

  private disarm(token: string): void {
    this.armed.get(token)?.();
    this.armed.delete(token);
  }

  /**
   * Apply one pending decision once it is due, re-checking every guard. A
   * decision is about the result you saw: if the run moved at all after you
   * decided (a state change or a turn), it is dropped, as is one a guard
   * refuses now, each with a receipt that says why. Approve and send back ask
   * the session whether it is working again, so without a client they wait
   * for one rather than skip the question.
   */
  private async applyPending(given: Paseo | null, id: string, token: string, dir?: string): Promise<ApplyOutcome> {
    if (this.applying.has(token)) return "settled";
    this.applying.add(token);
    try {
      const { store, config } = await this.store();
      const current = await this.locate(store, id, dir);
      const pending = pendingDecision(current.events);
      if (pending?.token !== token) return "settled";
      if (Date.parse(pending.effectiveAt) > this.now().getTime()) return "early";
      const { verdict, note } = pending;
      const target = verdictTarget(verdict);
      // Read the client now, not when the sweep or timer began: one may have arrived since.
      const paseo = given ?? this.client();
      if (verdict !== "block" && !paseo) return "waiting";
      const busy =
        verdict === "block" || !paseo
          ? null
          : await this.assertIdle(paseo, current).then(
              () => null,
              (error) => (error as Error).message,
            );
      let outcome = "settled" as ApplyOutcome;
      /** Whether the decision's follow-through (waking the session, archiving) is still owed. */
      let followThrough = true;
      const updated = await store.mutate(
        id,
        (item): Mutation | null => {
          // Undone (or applied elsewhere) while the session was being asked.
          if (pendingDecision(item.events)?.token !== token) return null;
          const since = eventsSince(item.events, token);
          const wentOn = since.some((event) => WENT_ON.has(event.type));
          const applied: WorkEvent = { ts: this.stamp(), type: "gate", actor: "human", verdict, note, token };
          const receipts: WorkEvent[] = [
            applied,
            { ts: applied.ts, type: "state", actor: "human", from: "review", to: target, reason: null },
          ];
          // The state landed and its receipts did not (a write torn by a crash, which also lost the
          // follow-through). With nothing since, finish it: record it and follow through.
          const landed = item.contract.state === target && !since.some((event) => event.type === "state");
          if (landed && !wentOn) {
            outcome = "applied";
            return { events: receipts };
          }
          // The run went on after a torn write. A closed state cannot be reopened, so the receipts say it
          // closed, and nothing else is done. A send back's note is never delivered to a run that moved on.
          if (landed && isTerminal(target)) {
            outcome = "applied";
            followThrough = false;
            return { events: [...receipts, this.note(`${RUN_WENT_ON} Nothing else was done.`)] };
          }
          const reason = wentOn ? RUN_WENT_ON : (busy ?? gateRefusal(item, verdict, true));
          if (reason) {
            outcome = "dropped";
            return { events: [{ ts: this.stamp(), type: "gate.dropped", actor: "maestro", verdict, token, reason }] };
          }
          outcome = "applied";
          return {
            to: target,
            actor: "human",
            ctx: { verdict },
            reason: verdict === "revise" ? "Sent back with a note" : null,
            events: [applied],
          };
        },
        current.dir,
      );
      if (outcome !== "applied" || !followThrough) return outcome;
      if (verdict === "revise" && paseo) {
        await this.wake(
          paseo,
          { store, config },
          updated,
          `Changes requested before this is done:\n\n${note}\n\nMake the changes, commit them, and end with the Decided and Ask sections again.`,
        );
      }
      if (verdict === "approve" && config.archiveOnApprove) await this.archiveWorkspace(paseo, store, updated);
      return "applied";
    } finally {
      this.applying.delete(token);
    }
  }

  /** The item from its known folder when it is still there, otherwise by scanning. */
  private async locate(store: WorkStore, id: string, dir?: string): Promise<StoredWork> {
    if (dir) {
      const item = await store.load(dir).catch(() => null);
      if (item?.contract.id === id) return item;
    }
    return store.findById(id);
  }

  /**
   * After an approval applies, or work closed itself (finishedArc): archive
   * the run's workspace, so its worktree goes and its branch stays as the
   * receipt. Best effort: a failure is a receipt and never undoes the close;
   * `stands` says what stands, in the receipt's words. Only a workspace a dispatch
   * created is Maestro's; a tracked session's, or the repository itself in
   * directory mode, is yours and stays.
   */
  private async archiveWorkspace(
    paseo: Paseo | null,
    store: WorkStore,
    item: StoredWork,
    stands = "The approval stands.",
  ): Promise<void> {
    const worker = workerOf(item.events);
    if (!worker) return;
    const record = (text: string) =>
      store
        .mutate(item.contract.id, () => ({ events: [this.note(text)] }), item.dir)
        .then(
          () => undefined,
          (error) => this.log(`recording the archive on ${item.contract.id}: ${(error as Error).message}`),
        );
    const { workspaceId, branch } = worker;
    if (!branch || !workspaceId) return record("Kept the workspace: Maestro did not create it.");
    if (!paseo) return record(`Could not archive the workspace: ${NO_HANDLE} ${stands}`);
    // The claim is the item's lock, the one every mutation of it takes, so the receipt is written after it is released.
    return record(
      await withLock(item.contract.id, () =>
        this.archiveClaimed(paseo, item, { ...worker, workspaceId, branch }, stands),
      ),
    );
  }

  /**
   * Archive a run's worktree only if it is clean, read twice under the
   * item's claim; the receipt it returns says what happened and why.
   *
   * The claim is the item's lock: while it is held every change Maestro
   * makes to this item's files (a decision, a hook's receipt, a dispatch's
   * binding) waits. It does not stop the session or a person typing into it,
   * so under it, twice: the session must be idle, and the worktree, read
   * with git pinned to the run's own entry in the repository
   * (server/worktree.ts), must be clean. The second read is the last thing
   * before the archive, and anything different from the first (a new file,
   * a commit) keeps the worktree. Every daemon call under the claim gives up
   * after claimWaitMs, so a daemon that never answers cannot hold it.
   *
   * The race that remains: a write that lands after the second read returns
   * and before Paseo has removed the files (one daemon round trip, plus the
   * removal) is lost with them. Nothing here can close it: the read is git's
   * and the removal is Paseo's, and no lock both of them honour exists. An
   * archive that gives up at claimWaitMs may still land later, which widens
   * that window by as long. A process the session left running in the
   * background is not a turn, so the idle check does not see it; only the
   * two reads do.
   */
  private async archiveClaimed(
    paseo: Paseo,
    item: StoredWork,
    { agentId, workspaceId, branch, cwd }: { agentId: string; workspaceId: string; branch: string; cwd: string | null },
    stands: string,
  ): Promise<string> {
    const repo = item.contract.repo;
    const cannot = (why: string) => `Kept the worktree: could not check it for uncommitted changes (${why}).`;
    if (!cwd) return cannot("no worktree folder is recorded");
    if (!repo) return cannot("the work names no repository");
    const recorded = await this.recorded(paseo, workspaceId, cwd);
    if ("error" in recorded) return cannot(recorded.error);
    const { projectRoot } = recorded;
    /** A digest of a clean worktree read while the session was idle, or the receipt that keeps it. */
    const read = async (): Promise<{ digest: string } | { keep: string }> => {
      const snapshot = await within(() => paseo.agents.ref(agentId).refresh(), this.claimWaitMs).then(
        (value) => ({ value }),
        (error: Error) => ({ error: error.message }),
      );
      if ("error" in snapshot)
        return { keep: `Kept the worktree: could not ask whether the session is idle (${snapshot.error}).` };
      if (snapshot.value?.agent.status === "running")
        return { keep: "Kept the worktree: the session is working again." };
      const status = await worktreeStatus({ repo, cwd, branch, projectRoot });
      if ("error" in status) return { keep: cannot(status.error) };
      if (status.dirty) return { keep: "Kept the worktree: it has uncommitted changes." };
      return { digest: status.digest };
    };
    const first = await read();
    if ("keep" in first) return first.keep;
    // Re-verify, immediately before the archive: the first read may have raced a write.
    const second = await read();
    if ("keep" in second) return second.keep;
    if (second.digest !== first.digest) return "Kept the worktree: it changed while it was being checked.";
    const failure = await within(() => paseo.workspaces.archive(workspaceId), this.claimWaitMs).then(
      (result) => result?.error ?? null,
      (error) => (error instanceof Error ? error.message : String(error)),
    );
    return failure
      ? `Could not archive the workspace: ${failure}. ${stands}`
      : `Archived the workspace. The branch ${branch} stays.`;
  }

  /**
   * Paseo's record of a workspace Maestro made: it must name the folder
   * Maestro recorded, and it says which repository the workspace was made
   * from. The daemon's record, not the work's, so the session cannot write it.
   */
  private async recorded(
    paseo: Paseo,
    workspaceId: string,
    cwd: string,
  ): Promise<{ projectRoot: string } | { error: string }> {
    const described = await within(() => paseo.workspaces.ref(workspaceId).refresh(), this.claimWaitMs).catch(
      () => null,
    );
    if (!described) return { error: "Paseo has no record of the workspace" };
    const directory = described.workspaceDirectory;
    if (directory && (await realpath(directory).catch(() => directory)) !== (await realpath(cwd).catch(() => cwd))) {
      return { error: "Paseo records the workspace at another folder" };
    }
    if (!described.projectRootPath) return { error: "Paseo records no repository for the workspace" };
    return { projectRoot: described.projectRootPath };
  }

  /**
   * Read a run's worktree for Stop, ignored files included (archiving deletes
   * them too). Null when the folder is not one Maestro made (a tracked
   * session's, or the repository itself in directory mode), which archiving
   * leaves alone, so there is nothing to read.
   */
  private async stopRead(
    paseo: Paseo,
    item: StoredWork,
    worker: NonNullable<ReturnType<typeof workerOf>>,
  ): Promise<WorktreeStatus | null> {
    const { workspaceId, branch, cwd } = worker;
    if (!branch || !workspaceId) return null;
    const repo = item.contract.repo;
    if (!cwd) return { error: "no worktree folder is recorded" };
    if (!repo) return { error: "the work names no repository" };
    const recorded = await this.recorded(paseo, workspaceId, cwd);
    if ("error" in recorded) return recorded;
    return worktreeStatus({ repo, cwd, branch, projectRoot: recorded.projectRoot }, 10_000, { ignored: true });
  }

  /**
   * Whether Stop may archive a run's session: the digest of a clean worktree
   * (compared again just before the archive), null when there is nothing to
   * read, or why it must not: the worktree holds work that is not committed
   * (edits, new files, ignored files: archiving deletes them all), or it
   * cannot be checked.
   */
  private async stopLoss(
    paseo: Paseo,
    item: StoredWork,
    worker: NonNullable<ReturnType<typeof workerOf>>,
  ): Promise<{ digest: string } | { refusal: string } | null> {
    const status = await this.stopRead(paseo, item, worker);
    if (!status) return null;
    if ("error" in status) {
      return {
        refusal: `${NOT_STOPPED} the worktree could not be checked for work that is not committed (${status.error}), and stopping archives it. Stop again and confirm to discard whatever it holds.`,
      };
    }
    if (status.count === 0) return { digest: status.digest };
    const paths = status.count === 1 ? "1 path" : `${status.count} paths`;
    return {
      refusal: `${NOT_STOPPED} the worktree has ${paths} not committed (edits, new or ignored files), and stopping archives it, which deletes them. Stop again and confirm to discard them.`,
    };
  }

  /**
   * Stop's second read, under the item's claim, just before the archive:
   * null when the worktree is still clean and the same as the first read
   * found it, otherwise why the session is kept.
   */
  private async stopRecheck(
    paseo: Paseo,
    item: StoredWork,
    worker: NonNullable<ReturnType<typeof workerOf>>,
    digest: string,
  ): Promise<{ reason: string; message: string } | null> {
    const status = await this.stopRead(paseo, item, worker);
    if (status && "error" in status) {
      return {
        reason: "The worktree could not be checked again before stopping",
        message: `${NOT_STOPPED} the worktree could not be checked again before stopping (${status.error}), so nothing was stopped. Stop again, or confirm to discard whatever it holds.`,
      };
    }
    if (status && !status.dirty && status.digest === digest) return null;
    return {
      reason: STOP_RACED,
      message: `${NOT_STOPPED} the worktree changed while Stop checked it, so nothing was stopped. Stop again, or confirm to discard whatever it holds.`,
    };
  }

  async unblock(paseo: Paseo, id: string, note: string): Promise<WorkItem> {
    if (this.dispatching.has(id)) throw new UserError("A run is already starting for this work.");
    const { store, config } = await this.store();
    const item = await store.findById(id);
    if (item.contract.state !== "blocked") throw new UserError("Only stuck work can be unblocked.");
    const worker = workerOf(item.events);
    const alive = worker
      ? await paseo.agents
          .ref(worker.agentId)
          .refresh()
          .catch(() => null)
      : null;
    if (!alive || alive.agent.archivedAt || alive.agent.status === "closed") return this.dispatch(paseo, id);
    const trimmed = note.trim();
    // A run whose session had gone held no slot, and unblocking it takes one: it passes the cap as a start does (mi-1).
    const takes = slotOf(item) === null;
    const ahead = takes ? [...this.admitted] : [];
    if (takes) this.admitted.add(id);
    const stops = takes ? this.watchStops() : null;
    try {
      if (stops) this.checkCapacity(item, ahead, await this.occupied(store), config.concurrencyCap, stops);
      const updated = await store.mutate(
        id,
        (fresh) => {
          if (fresh.contract.state !== "blocked") throw new UserError("Only stuck work can be unblocked.");
          return {
            to: "running",
            actor: "human",
            reason: "Unblocked",
            events: [{ ts: this.stamp(), type: "unblocked", actor: "human", note: trimmed }],
          };
        },
        item.dir,
      );
      return await this.wake(
        paseo,
        { store, config },
        updated,
        trimmed || "Continue where you stopped. End with the Decided and Ask sections.",
      );
    } finally {
      if (takes) this.admitted.delete(id);
      if (stops) this.stopWatch.delete(stops);
    }
  }

  /**
   * Cancel work. At the gate that is a decision like approve, so it waits out
   * the undo window; queued or stuck work closes now.
   */
  async cancel(id: string, paseo?: Paseo | null): Promise<WorkItem> {
    if (this.dispatching.has(id)) throw new UserError("A run is starting for this work. Cancel it once it is running.");
    const { store, config } = await this.store();
    const current = await store.findById(id);
    if (current.contract.state === "review") return this.verdict(paseo, id, "block", "");
    const unbound = current.contract.state === "running" && !workerOf(current.events);
    if (unbound) {
      // A run with no recorded session has nothing to stop: move it through Stuck so it can close.
      await store.mutate(
        id,
        (fresh) =>
          fresh.contract.state === "running" && !workerOf(fresh.events) ? { to: "blocked", reason: NO_SESSION } : null,
        current.dir,
      );
    }
    const updated = await store.mutate(
      id,
      (item) => {
        const state = item.contract.state;
        if (isTerminal(state)) return null;
        if (state === "running") throw new UserError("Stop the run first, then cancel the work.");
        // It reached the gate after this call looked: canceling there waits out the undo window.
        if (state === "review") throw new UserError("This work just reached Needs you. Cancel it there.");
        return { to: "canceled", actor: "human" };
      },
      current.dir,
    );
    return toWire(updated, this.now().getTime(), config);
  }

  /**
   * Stop a running run, or one paused at the gate on the agent's question
   * (review with a permission pending: the session is alive and waiting, so
   * there is something to stop). Stopping a question moves the work from
   * review to stuck, a move the transition table allows (shared/states.ts),
   * and the `stopped` receipt ends the question (pendingPermission), so the
   * card stops offering Allow and Deny. If the archive then fails, the work
   * goes back to running like any other stop, and the next reconcile finds
   * the session still asking and moves it to the gate again.
   *
   * Paseo has no stop that keeps the session, so this
   * archives it; the branch and its commits stay. Work in the worktree that is
   * not committed would go with it, so Stop refuses, saying how much, unless
   * `discard` says to go ahead (see stopLoss). The work is stuck with the
   * reason recorded first, so hooks the archive sets off (a stopped turn, the
   * archive itself) find it already stuck and only add their receipts. If the
   * archive fails, the session may still be working: the work goes back to
   * running with the reason, and the call fails.
   *
   * The worktree is read twice, as archiveClaimed reads it. The first read
   * comes before the flip to stuck. The second runs under the item's claim
   * (the lock every change Maestro makes to this item takes) and is the last
   * thing before the archive: if it is not clean, or differs from the first
   * in any way, nothing is archived, the work goes back to running, and the
   * call fails, asking you to Stop again. Under the same claim, before that
   * read, the item is read too: if it is no longer stuck with Stop's reason
   * for the same session (a turn started, so the session resumed it; an
   * Unblock; a fresh run), nothing is archived, a note says why, and the call
   * fails with "Not archived:". Every daemon call under the claim
   * gives up after claimWaitMs, the archive included; one that gives up
   * counts as a failed archive. `discard` skips both reads.
   *
   * The race that remains: a write that lands after the second read returns
   * and before Paseo has removed the files (one daemon round trip, plus the
   * removal) is lost with them. Nothing here can close it: the read is git's
   * and the removal is Paseo's, and no lock both of them honour exists. An
   * archive that gives up at claimWaitMs may still land later, which widens
   * that window by as long, and leaves the work running with a session that
   * is gone (the archived hook then moves it to stuck).
   */
  async stopRun(paseo: Paseo, id: string, { discard = false }: { discard?: boolean } = {}): Promise<WorkItem> {
    if (this.dispatching.has(id)) throw new UserError("A run is starting for this work. Stop it once it is running.");
    const { store, config } = await this.store();
    const current = await store.findById(id);
    const refusal = (item: StoredWork): string | null => {
      const phase = phaseOf(item.contract.state, item.events);
      // The session already finished; stopping now would only strand the checks' result.
      if (phase === "checking") return CHECKING;
      // Working, or paused on its question at the gate: either way the session is alive, and Stop archives it.
      if (phase !== "working" && phase !== "asking") return NOT_STOPPABLE;
      return null;
    };
    const early = refusal(current);
    if (early) throw new UserError(early);
    const worker = workerOf(current.events);
    const checked = worker && !discard ? await this.stopLoss(paseo, current, worker) : null;
    if (checked && "refusal" in checked) throw new UserError(checked.refusal);
    // Held from before the run is recorded stuck until its archive settles: a failed archive puts it back (mi-1).
    const release = this.holdStop(id);
    try {
      return await this.stopHeld(paseo, store, config, current, worker, checked, refusal);
    } finally {
      release();
    }
  }

  /** Stop, from recording the run stuck to its archive, while the run holds its slot (stopRun). */
  private async stopHeld(
    paseo: Paseo,
    store: WorkStore,
    config: MaestroConfig,
    current: StoredWork,
    worker: ReturnType<typeof workerOf>,
    checked: { digest: string } | { refusal: string } | null,
    refusal: (item: StoredWork) => string | null,
  ): Promise<WorkItem> {
    const id = current.contract.id;
    const stopped = await store.mutate(
      id,
      (item) => {
        const late = refusal(item);
        if (late) throw new UserError(late);
        if (workerOf(item.events)?.agentId !== worker?.agentId) {
          throw new UserError("A new run started while this one was being stopped.");
        }
        return {
          to: "blocked",
          actor: "human",
          reason: STOPPED,
          events: [{ ts: this.stamp(), type: "stopped", actor: "human", agentId: worker?.agentId ?? null }],
        };
      },
      current.dir,
    );
    if (!worker) return toWire(stopped, this.now().getTime(), config);
    /** Put the work back to running when it is still the stop this call made; otherwise only say so. */
    const putBack = (reason: string, note: string) =>
      store
        .mutate(
          id,
          (item) =>
            item.contract.state === "blocked" &&
            reasonOf("blocked", item.events) === STOPPED &&
            workerOf(item.events)?.agentId === worker.agentId
              ? { to: "running", reason }
              : { events: [this.note(note)] },
          stopped.dir,
        )
        .catch(() => undefined);
    /** Archive the session; under the claim, bounded by claimWaitMs. Null when it was archived. */
    const archive = (claimed: boolean) => {
      const call = () => paseo.agents.ref(worker.agentId).archive();
      return (claimed ? within(call, this.claimWaitMs) : call()).then(
        () => null,
        (error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }),
      );
    };
    const digest = checked && "digest" in checked ? checked.digest : null;
    // Nothing was read (discard, or a folder archiving leaves alone): nothing to re-verify, so no claim.
    // Otherwise the claim is the item's lock, the one every mutation of it takes, so nothing inside it mutates.
    const outcome =
      digest === null
        ? { failed: await archive(false) }
        : await withLock(id, async () => {
            // The item first, read and not mutated: mutate takes this same lock, and so does load, which
            // waits for it. fresh is the raw read for code holding the lock. It must still be this stop.
            const moved = stopMoved(await store.fresh(id, stopped.dir).catch(() => null), worker.agentId);
            if (moved) return { moved };
            const changed = await this.stopRecheck(paseo, stopped, worker, digest);
            return changed ? { changed } : { failed: await archive(true) };
          });
    if ("moved" in outcome) {
      // The work is not this stop any more, so there is nothing to put back: only say what happened.
      const why = `${outcome.moved} while Stop checked the worktree`;
      await store
        .mutate(id, () => ({ events: [this.note(`Did not archive session ${worker.agentId}: ${why}`)] }), stopped.dir)
        .catch(() => undefined);
      throw new UserError(`Not archived: ${why}, so the session was kept.`);
    }
    if ("changed" in outcome) {
      await putBack(outcome.changed.reason, `Did not archive session ${worker.agentId}: ${outcome.changed.reason}`);
      throw new UserError(outcome.changed.message);
    }
    if (outcome.failed) {
      const { message } = outcome.failed;
      await putBack(
        `Could not stop the session: ${message}`,
        `Could not archive session ${worker.agentId}: ${message}`,
      );
      throw new UserError(`Could not stop the session: ${message}`);
    }
    return toWire(await store.load(stopped.dir), this.now().getTime(), config);
  }

  /**
   * Track a session that is already running. Adopted by you, its end lands at the gate; adopted by an agent (an
   * orchestrator tracking its arc), only a turn that hands you something does (events.ts onItsOwnArc).
   */
  async adopt(
    paseo: Paseo,
    agentId: string,
    title: string,
    origin: Origin = BY_HUMAN,
    given: { ticket?: string } = {},
  ): Promise<WorkItem> {
    // Scan-then-create is not atomic: a retry or a second caller must not bind one session twice.
    if (this.adopting.has(agentId)) throw new UserError("This session is already being tracked.");
    this.adopting.add(agentId);
    try {
      if (given.ticket !== undefined && !TICKET.test(given.ticket.trim())) {
        throw new UserError("A ticket is a team key and a number, like BRO-2908.");
      }
      return await this.adoptOnce(paseo, agentId, title, origin, given);
    } finally {
      this.adopting.delete(agentId);
    }
  }

  private async adoptOnce(
    paseo: Paseo,
    agentId: string,
    title: string,
    origin: Origin,
    given: { ticket?: string },
  ): Promise<WorkItem> {
    const { store, config } = await this.store();
    const { items } = await store.scan();
    this.index(store, items);
    const existing = items.find((item) => workerOf(item.events)?.agentId === agentId);
    if (existing) return toWire(existing, this.now().getTime(), config);
    const snapshot = await paseo.agents.ref(agentId).refresh();
    if (!snapshot) throw new UserError("That session no longer exists.");
    const agent = snapshot.agent;
    // Read while the worktree exists: by the time its session ends, the worktree may be gone (BRO-2923).
    const bound = await this.gitOf(agent.cwd).catch(() => ({ branch: null, githubRepo: null }));
    const created = await store.create({
      title: title.trim() || agent.title || `Session ${agentId.slice(0, 8)}`,
      brief: "",
      repo: agent.cwd,
      gate: "human",
      check: "",
      initiative: "",
      now: this.now(),
      origin,
    });
    const id = created.contract.id;
    // The lineage (BRO-2908): an orchestrator that adopts runs as work of its own, which becomes this one's parent.
    // Only an open work is a parent: a finished one is history, not the arc this one belongs to. A session that
    // tracks itself has none: this work is not bound to it yet, and one already bound returned above.
    const adopter = origin.actor === "agent" && origin.by ? await this.forAgent(origin.by).catch(() => null) : null;
    const parentWork = adopter && !isTerminal(adopter.state) ? adopter.id : null;
    const own = agent.labels?.[WORK_LABELS.ticket];
    const ticket =
      given.ticket?.trim() ||
      (own && TICKET.test(own) ? own : null) ||
      ticketOf(created.title) ||
      ticketOf(agent.title);
    const running = await store.mutate(
      id,
      () => ({
        to: "running",
        actor: origin.actor,
        events: [
          {
            ts: this.stamp(),
            type: "adopted",
            ...origin,
            agentId,
            workspaceId: agent.workspaceId ?? null,
            provider: agent.provider,
            branch: bound.branch,
            githubRepo: bound.githubRepo,
            cwd: agent.cwd,
            parentWork,
            ticket,
          },
        ],
      }),
      created.dir,
    );
    this.dirs(store.root).set(agentId, running.dir);
    this.labelSession(agentId, { id, ticket, parentWork }, agent.labels ?? {});
    if (agent.status === "running") return toWire(running, this.now().getTime(), config);
    // Idle when tracked: its last turn decides, by the one landing rule every turn end goes through (endTurn).
    // An arc that handed you something lands; one between steps stays running. Unreadable now: it stays
    // running and reconcile reads it later, as it does any missed end.
    const page = await paseo.agents
      .ref(agentId)
      .timeline.refetch({ direction: "tail", limit: 60 })
      .catch(() => null);
    if (!page) return toWire(running, this.now().getTime(), config);
    const timeline = page.entries.map((entry) => entry.item);
    this.readAt.set(agentId, agent.updatedAt);
    await this.endTurn(store, running, agentId, outcomeOf(timeline), timeline, {
      landedReason: IDLE_WHEN_TRACKED,
      turnId: page.entries.at(-1)?.turnId ?? null,
    });
    return toWire(await store.load(running.dir), this.now().getTime(), config);
  }

  /** Prompt the session of work that just moved to running; a failed send parks it as stuck. */
  private async wake(
    paseo: Paseo,
    { store, config }: { store: WorkStore; config: MaestroConfig },
    item: StoredWork,
    text: string,
  ): Promise<WorkItem> {
    const worker = workerOf(item.events);
    try {
      if (!worker) throw new Error("no session is bound");
      await paseo.agents.ref(worker.agentId).send(text);
      return toWire(item, this.now().getTime(), config);
    } catch (error) {
      const reason = `Could not reach the session: ${(error as Error).message}`;
      const stuck = await store.mutate(
        item.contract.id,
        (fresh) => (fresh.contract.state === "running" ? { to: "blocked", reason } : null),
        item.dir,
      );
      return toWire(stuck, this.now().getTime(), config);
    }
  }

  // ── Lifecycle hooks ────────────────────────────────────────────────────────
  //
  // Each hook resolves the work bound to its agent, then applies an item-level
  // change. Reconcile applies the same item-level changes to the item it read,
  // never by looking the agent up again.

  private prune(): void {
    for (const [agentId, entry] of this.queues) {
      if (Date.now() - entry.at > QUEUE_MS && !this.draining.has(agentId)) this.queues.delete(agentId);
    }
  }

  /** Runs `run` against the work bound to this agent; false when no work is. */
  private async deliver(agentId: string, run: ItemChange): Promise<boolean> {
    const { store } = await this.store();
    const item = await this.findByAgent(store, agentId);
    if (!item) return false;
    await run(store, item);
    return true;
  }

  /**
   * Delivers one hook event in order. A dispatch records its binding after
   * Paseo returns the agent, and the first turn can start before that, so
   * events for an unknown agent wait in a queue while a dispatch is in
   * flight. Anything that arrives while a queue exists joins it, so a live
   * event never overtakes one still waiting, and a queue is drained as soon as
   * its agent is bound or no dispatch is left that could bind it.
   */
  /**
   * One ordered chain per agent: an event waits for the previous event of the
   * same agent to finish, so a slow lookup can never let a turn end overtake
   * its own turn start.
   */
  private async route(agentId: string, run: ItemChange): Promise<void> {
    const previous = this.chains.get(agentId) ?? Promise.resolve();
    const current = previous.then(() => this.routeNow(agentId, run));
    const settled = current.catch(() => undefined);
    this.chains.set(agentId, settled);
    try {
      await current;
    } finally {
      if (this.chains.get(agentId) === settled) this.chains.delete(agentId);
    }
  }

  private async routeNow(agentId: string, run: ItemChange): Promise<void> {
    this.prune();
    const waiting = this.queues.get(agentId);
    if (waiting) {
      waiting.runs.push(() => this.deliver(agentId, run));
      if (this.knows(agentId) || this.dispatching.size === 0) await this.flush(agentId);
      return;
    }
    if (await this.deliver(agentId, run)) return;
    if (this.dispatching.size === 0) return;
    const entry = this.queues.get(agentId) ?? { at: Date.now(), runs: [] };
    entry.runs.push(() => this.deliver(agentId, run));
    this.queues.set(agentId, entry);
    // The binding may have landed while this event looked for it; drain now.
    if (this.knows(agentId)) await this.flush(agentId);
  }

  /** Drains one agent's queue in order. One drain per agent: a second caller leaves new events to it. */
  private async flush(agentId: string): Promise<void> {
    if (this.draining.has(agentId)) return;
    const entry = this.queues.get(agentId);
    if (!entry) return;
    this.draining.add(agentId);
    try {
      for (let next = entry.runs.shift(); next; next = entry.runs.shift()) {
        await next().catch((error) => this.log(`replay failed for ${agentId}: ${(error as Error).message}`));
      }
      this.queues.delete(agentId);
    } finally {
      this.draining.delete(agentId);
    }
  }

  async onTurnStarted(agent: HookAgent): Promise<void> {
    await this.route(agent.id, (store, item) => this.startTurn(store, item, agent.id));
  }

  async onTurnEnded(
    agent: HookAgent,
    outcome: Outcome,
    timeline: readonly AgentTimelineItem[],
    turnId: string | null = null,
  ): Promise<void> {
    await this.route(agent.id, (store, item) => this.endTurn(store, item, agent.id, outcome, timeline, { turnId }));
  }

  async onPermissionRequested(agent: HookAgent, request: PermissionLike & { id: string }): Promise<void> {
    await this.route(agent.id, (store, item) => this.askPermission(store, item, agent.id, request));
  }

  async onPermissionResolved(agent: HookAgent, requestId: string): Promise<void> {
    await this.route(agent.id, (store, item) => this.resolvePermission(store, item, agent.id, requestId));
  }

  /**
   * The session was archived: the work notes it (or stops, if it was mid-run
   * or asking). With the daemon's client, the item is reconciled at once, so
   * a finished arc closes now (finishedArc), not on whoever lists next.
   */
  async onArchived(agent: HookAgent, paseo: Paseo | null = null): Promise<void> {
    await this.route(agent.id, async (store, item) => {
      await store.mutate(
        item.contract.id,
        (fresh) => {
          if (workerOf(fresh.events)?.agentId !== agent.id) return null;
          const state = fresh.contract.state;
          if (state === "running") return { to: "blocked", reason: ARCHIVED_MID_RUN };
          if (state === "review" && pendingPermission(fresh.events)) {
            return { to: "blocked", reason: ARCHIVED_ASKING };
          }
          if (isTerminal(state)) return null;
          // A finished arc at your gate closes in the reconcile below (finishedArc), which can follow through.
          return { events: [this.note(ARCHIVED_NOTE)] };
        },
        item.dir,
      );
      if (paseo) await this.reconcileOne(paseo, store, await store.findById(item.contract.id));
    });
  }

  private async startTurn(store: WorkStore, item: StoredWork, agentId: string): Promise<void> {
    // Stuck work whose session had gone held no slot, and resuming takes one. The turn is under way, so it is not
    // Maestro's to refuse: the cap is checked, and a resume that takes it over is said on the work (mi-1).
    const over = item.contract.state === "blocked" && slotOf(item) === null ? await this.overCap(store, item) : null;
    await store.mutate(
      item.contract.id,
      (fresh) => {
        if (workerOf(fresh.events)?.agentId !== agentId) return null;
        const event: WorkEvent = { ts: this.stamp(), type: "turn.started", actor: "agent", agentId };
        const state = fresh.contract.state;
        if (state === "running") return { events: [event] };
        if (state === "review" && !pendingPermission(fresh.events)) {
          return { to: "running", actor: "human", reason: "You continued the session", events: [event] };
        }
        if (state === "blocked") {
          const said = over && slotOf(fresh) === null ? [this.note(over)] : [];
          return { to: "running", actor: "human", reason: "Resumed in the session", events: [event, ...said] };
        }
        return null;
      },
      item.dir,
    );
  }

  /** RESUMED_OVER_CAP with what holds the slots once `item` runs again, when that is over the cap; else null. */
  private async overCap(store: WorkStore, item: StoredWork): Promise<string | null> {
    const cap = (await this.readConfig()).concurrencyCap;
    if (cap === null) return null;
    const busy = await this.busyNow(store, item);
    if (busy.size < cap) return null;
    busy.set(item.contract.id, "running");
    const words = `${RESUMED_OVER_CAP}: ${capacityWords(busy, cap)}. No run starts until one ends.`;
    this.log(`${item.contract.id}: ${words}`);
    return words;
  }

  /**
   * A turn ended. `recovered` marks an end reconcile inferred rather than
   * observed; `seen` is the event count reconcile read, and the change is
   * dropped if anything was recorded since. A repeat of an end already
   * recorded (a late hook after recovery) changes nothing.
   */
  private async endTurn(
    store: WorkStore,
    item: StoredWork,
    agentId: string,
    outcome: Outcome,
    timeline: readonly AgentTimelineItem[],
    options: { recovered?: boolean; seen?: number; endedAt?: string; turnId?: string | null; landedReason?: string },
  ): Promise<void> {
    let token: string | null = null;
    const updated = await store.mutate(
      item.contract.id,
      (fresh): Mutation | null => {
        if (options.seen !== undefined && fresh.events.length !== options.seen) return null;
        if (workerOf(fresh.events)?.agentId !== agentId) return null;
        // Without a turn id a repeat cannot be told from a new turn; a failure is never hidden as a repeat.
        const unidentifiedFailure = !options.turnId && outcome.kind !== "completed";
        if (!unidentifiedFailure && isDuplicateEnd(fresh.events, options.turnId ?? null, latestOutputText(timeline))) {
          return null;
        }
        const at = options.endedAt ?? this.stamp();
        const ended: WorkEvent = {
          ts: at,
          type: "turn.ended",
          actor: "agent",
          agentId,
          outcome: outcome.kind,
          error: outcome.kind === "failed" ? outcome.error.message : null,
          summary: latestOutputText(timeline),
          turnId: options.turnId ?? null,
        };
        const state = fresh.contract.state;
        // A session Maestro adopted runs its own arc over many turns: a turn that hands you nothing (handsBack:
        // no verdict, no ask) is the arc between steps, not work at your gate. It stays running, and the loop
        // names it if it goes quiet. One that failed still stops it: that is something to look at. A turn
        // answering your note is a task, not the arc (onItsOwnArc), so it lands whatever it says.
        const between = onItsOwnArc(fresh.events) && outcome.kind !== "failed" && !handsBack(ended.summary);
        if (state !== "running") {
          // The session worked again after landing (its turn start was missed): the gate must show that turn.
          if (state === "review" && !pendingPermission(fresh.events)) {
            if (between) return { at, to: "running", actor: "agent", reason: KEPT_WORKING, events: [ended] };
            if (outcome.kind === "failed") {
              return { at, to: "blocked", reason: outcome.error.message, events: [ended] };
            }
            if (outcome.kind === "canceled") {
              return { at, to: "blocked", reason: "Stopped before finishing", events: [ended] };
            }
            if (fresh.contract.checks.length > 0) {
              token = this.checkToken(agentId, ended.ts);
              return {
                stateFirst: true,
                to: "running",
                actor: "agent",
                reason: "The session kept working; checking again",
                events: [ended, { ts: this.stamp(), type: "checks.started", actor: "maestro", token }],
              };
            }
          }
          return { events: [ended] };
        }
        if (between) return { events: [ended] };
        if (outcome.kind === "failed") return { at, to: "blocked", reason: outcome.error.message, events: [ended] };
        if (outcome.kind === "canceled") {
          return { at, to: "blocked", reason: "Stopped before finishing", events: [ended] };
        }
        if (fresh.contract.checks.length > 0) {
          token = this.checkToken(agentId, ended.ts);
          const started: WorkEvent = {
            ts: this.stamp(),
            type: "checks.started",
            actor: "maestro",
            token,
            ...(options.recovered ? { recovered: true, endedAt: at } : {}),
          };
          return { events: [ended, started] };
        }
        const reason = options.landedReason ?? (options.recovered ? "Recovered after a missed event" : null);
        return { at, to: landingState(fresh.contract.gate, "none"), reason, events: [ended] };
      },
      item.dir,
    );
    this.tellLanded(item, updated);
    if (token) void this.runChecksFor(store, updated, token);
  }

  private async askPermission(
    store: WorkStore,
    item: StoredWork,
    agentId: string,
    request: PermissionLike & { id: string },
  ): Promise<void> {
    await store.mutate(
      item.contract.id,
      (fresh) => {
        if (workerOf(fresh.events)?.agentId !== agentId) return null;
        if (pendingPermission(fresh.events)?.requestId === request.id) return null;
        const { title, detail } = describePermission(request, workerOf(fresh.events)?.cwd ?? null);
        const asked: WorkEvent = {
          ts: this.stamp(),
          type: "permission.asked",
          actor: "agent",
          agentId,
          requestId: request.id,
          title,
          detail,
        };
        if (fresh.contract.state !== "running") return { events: [asked] };
        return { to: "review", actor: "agent", reason: "Asked for permission", events: [asked] };
      },
      item.dir,
    );
  }

  private async resolvePermission(
    store: WorkStore,
    item: StoredWork,
    agentId: string,
    requestId: string,
  ): Promise<void> {
    await store.mutate(
      item.contract.id,
      (fresh) => {
        if (pendingPermission(fresh.events)?.requestId !== requestId) return null;
        const resolved: WorkEvent = {
          ts: this.stamp(),
          type: "permission.resolved",
          actor: "human",
          agentId,
          requestId,
        };
        if (fresh.contract.state === "review") {
          return { to: "running", actor: "human", reason: "Permission answered", events: [resolved] };
        }
        return { events: [resolved] };
      },
      item.dir,
    );
  }

  // ── Checks ─────────────────────────────────────────────────────────────────

  private async runChecksFor(store: WorkStore, item: StoredWork, token: string): Promise<void> {
    if (this.activeChecks.has(token)) return;
    this.activeChecks.add(token);
    // One check run per item: a newer run stops the older one, whose result would be discarded anyway,
    // so two test runs never share a worktree.
    const id = item.contract.id;
    this.checkRuns.get(id)?.abort();
    const run = new AbortController();
    this.checkRuns.set(id, run);
    try {
      const cwd = workerOf(item.events)?.cwd ?? item.contract.repo;
      const signal = AbortSignal.any([this.abort.signal, run.signal]);
      const results = cwd ? await runChecks(item.contract.checks, cwd, signal) : [];
      if (signal.aborted) return;
      const after = await store.mutate(
        item.contract.id,
        (fresh): Mutation | null => {
          if (pendingChecks(fresh.events) !== token) return null;
          const finished: WorkEvent = { ts: this.stamp(), type: "checks.finished", actor: "maestro", token, results };
          const started = fresh.events.findIndex((event) => event.type === "checks.started" && event.token === token);
          const startedEvent = fresh.events[started];
          const recovered = startedEvent?.type === "checks.started" && startedEvent.recovered === true;
          const endedAt = startedEvent?.type === "checks.started" ? startedEvent.endedAt : undefined;
          // Use the recovered stop time only if nothing moved the work since; a later move would make it negative.
          const lastState = lastOf(fresh.events, "state");
          const stamp =
            recovered && endedAt && (!lastState || Date.parse(endedAt) >= Date.parse(lastState.ts))
              ? endedAt
              : undefined;
          const newerTurn = fresh.events.slice(started + 1).some((event) => event.type === "turn.started");
          if (fresh.contract.state !== "running" || newerTurn) return { events: [finished] };
          const outcome = cwd ? checkOutcome(results) : "none";
          const target = landingState(fresh.contract.gate, outcome);
          // An end reconcile inferred closes nothing by itself, and its running time ends when the agent stopped.
          if (recovered && target === "done") {
            return {
              at: stamp,
              to: "review",
              reason: "Recovered after a missed event; the checks passed",
              events: [finished],
            };
          }
          return {
            at: stamp,
            to: target,
            reason: outcome === "failed" ? "Checks failed" : null,
            ctx: { checksPassed: outcome === "passed" },
            events: [finished],
          };
        },
        item.dir,
      );
      this.tellLanded(item, after);
    } catch (error) {
      this.log(`checks failed to run for ${item.contract.id}: ${(error as Error).message}`);
    } finally {
      this.activeChecks.delete(token);
      if (this.checkRuns.get(id) === run) this.checkRuns.delete(id);
    }
  }

  // ── Reconciliation ─────────────────────────────────────────────────────────

  /** Returns true when any item changed. */
  async reconcile(paseo: Paseo, items: readonly StoredWork[]): Promise<boolean> {
    const { store } = await this.store();
    const results = await Promise.all(
      items.map((item) =>
        this.reconcileOne(paseo, store, item).catch((error) => {
          this.log(`reconcile ${item.contract.id}: ${(error as Error).message}`);
          return false;
        }),
      ),
    );
    return results.some(Boolean);
  }

  /**
   * An orchestrator's child, Stuck only because its session ended unfinished,
   * closes Done when the branch recorded at its adoption merged after that
   * (server/branch-merge.ts). The receipt says only what was seen: which PR
   * merged, and that it was after the adoption. The lookup never waits on gh: it answers what is known and asks
   * in the background, so a later reconcile acts on it.
   */
  private async closeIfBranchMerged(
    item: StoredWork,
    guarded: (change: Mutation) => Promise<boolean>,
  ): Promise<boolean> {
    const now = this.now().getTime();
    const watched = watchedBranch(item.events, now);
    if (!watched) return false;
    const merged = await this.merged(watched.repo, watched.branch).catch(() => null);
    const close = branchMerged(item.events, merged, now);
    if (!close) return false;
    return guarded({
      to: "done",
      actor: "maestro",
      ctx: { branchMerged: true },
      reason: `Its branch ${close.branch} merged as ${close.repo}#${close.number} after it was adopted`,
    });
  }

  /**
   * A stuck run's session that has gone since it got stuck (closed, or unknown
   * to the daemon; the archive hook notes an archive itself): noted once, so
   * the run frees its slot of the cap (occupied, BRO-2990). A session that
   * cannot be asked is left as it is: it keeps the slot.
   */
  private async noteSessionGone(
    paseo: Paseo,
    item: StoredWork,
    guarded: (change: Mutation) => Promise<boolean>,
  ): Promise<boolean> {
    const worker = workerOf(item.events);
    if (!worker || sessionGoneSince(item.events)) return false;
    if (SESSION_GONE.has(reasonOf("blocked", item.events) ?? "")) return false;
    const snapshot = await paseo.agents
      .ref(worker.agentId)
      .refresh()
      .catch(() => undefined);
    if (snapshot === undefined) return false;
    const agent = snapshot?.agent;
    if (agent && !agent.archivedAt && agent.status !== "closed") return false;
    return guarded({ events: [this.note(agent?.archivedAt ? ARCHIVED_NOTE : SESSION_ENDED_NOTE)] });
  }

  private async reconcileOne(paseo: Paseo, store: WorkStore, item: StoredWork): Promise<boolean> {
    const state = item.contract.state;
    if (state !== "running" && state !== "review" && state !== "blocked") return false;
    const seen = item.events.length;
    /** Apply a change only if nothing was recorded since this item was read. */
    const guarded = async (change: Mutation): Promise<boolean> => {
      let applied = false;
      await store.mutate(
        item.contract.id,
        (fresh) => {
          if (fresh.events.length !== seen || fresh.contract.state !== state) return null;
          applied = true;
          return change;
        },
        item.dir,
      );
      return applied;
    };
    if (state === "blocked") {
      if (await this.closeIfBranchMerged(item, guarded)) return true;
      // Archived between turns (BRO-2928): an orchestrator's arc that ended, not stuck. Canceled, never done.
      const now = this.now().getTime();
      if (!archivedBetweenTurns(item.events, now)) return this.noteSessionGone(paseo, item, guarded);
      // One whose branch is watched stays with branchMerged, which closes it Done if the branch merges within
      // WATCH_STUCK_MS: a pushed branch may still land, and a canceled card is never looked at again.
      if (watchedBranch(item.events, now)) return false;
      return guarded({ to: "canceled", actor: "maestro", reason: ARCHIVED_BETWEEN_TURNS });
    }
    const worker = workerOf(item.events);
    if (!worker) {
      return state === "running" ? guarded({ to: "blocked", reason: NO_SESSION }) : false;
    }
    const phase = phaseOf(state, item.events);
    const token = pendingChecks(item.events);
    if (phase === "checking" && token) {
      if (!this.activeChecks.has(token)) void this.runChecksFor(store, item, token);
      return false;
    }
    let snapshot: Awaited<ReturnType<ReturnType<Paseo["agents"]["ref"]>["refresh"]>>;
    try {
      snapshot = await paseo.agents.ref(worker.agentId).refresh();
    } catch {
      return false;
    }
    const agent = snapshot?.agent;
    // Backfill (BRO-2908): a live session tracked before adoptions were labelled, or whose label was removed, gets it.
    if (agent && !agent.archivedAt && agent.status !== "closed" && agent.labels?.[WORK_LABEL] !== item.contract.id) {
      const lineage = lineageOf(item.events);
      this.labelSession(
        worker.agentId,
        { id: item.contract.id, parentWork: lineage.parentWork, ticket: lineage.ticket ?? ticketOf(item.title) },
        agent.labels ?? {},
      );
    }
    const permission = pendingPermission(item.events);
    if (!agent || agent.archivedAt || agent.status === "closed") {
      if (state === "running") return guarded({ to: "blocked", reason: ENDED_MID_RUN });
      if (permission) return guarded({ to: "blocked", reason: ENDED_ASKING });
      // A finished arc at your gate closes itself here, and only here (finishedArc): archived, by its hook's
      // note or as the daemon now says (a missed hook, whose note is written with it).
      if (state === "review") {
        const archived = agent?.archivedAt && !archivedSince(item.events) ? [this.note(ARCHIVED_NOTE)] : [];
        const seen = [...item.events, ...archived];
        const line = finishedArc(seen);
        // An orchestrator's child leaves your gate once the orchestrator took it back and archived it (BRO-2903).
        const adopter = line ? null : adopterClosed(seen);
        if (line || adopter !== null) {
          const closed = await guarded({
            to: "done",
            actor: "maestro",
            ctx: line ? { arcFinished: true } : { adopterClosed: true },
            reason: line ? closedItself(line) : archivedByOrchestrator(adopter ?? ""),
            events: archived,
          });
          // As an approval would: the workspace a run created goes when Settings says archive on approve.
          const { config } = await this.store();
          if (closed && config.archiveOnApprove) {
            await this.archiveWorkspace(paseo, store, await store.findById(item.contract.id), "It stays done.");
          }
          return closed;
        }
      }
      return false;
    }
    if (state === "review") {
      if (permission && !agent.pendingPermissions.some((p) => p.id === permission.requestId)) {
        await this.resolvePermission(store, item, agent.id, permission.requestId);
        return true;
      }
      if (!permission && agent.status === "running") {
        return guarded({ to: "running", actor: "agent", reason: "The session is working again" });
      }
      return false;
    }
    const first = agent.pendingPermissions[0];
    if (first) {
      await this.askPermission(store, item, agent.id, first);
      return true;
    }
    if (agent.status === "error") {
      return guarded({ to: "blocked", reason: agent.lastError ?? "The session hit an error" });
    }
    if (agent.status !== "idle" || agent.activeTurn) return false;
    const last = lastOf(item.events, "dispatched", "adopted", "state", "turn.started");
    const since = last ? this.now().getTime() - Date.parse(last.ts) : Number.POSITIVE_INFINITY;
    if (since <= MISSED_END_MS) return false;
    // Its end is on record and the daemon reports nothing new of its session since this process last read
    // it: an adopted arc between turns (endTurn kept it running), not a missed end. Reading again would
    // change nothing; any change of the session's (a turn whose hooks were missed too) reads it again.
    if (isDuplicateEnd(item.events, null) && this.readAt.get(agent.id) === agent.updatedAt) return false;
    // The end was missed. Read what happened instead of assuming it went well; if it cannot be read, try later.
    const page = await paseo.agents
      .ref(agent.id)
      .timeline.refetch({ direction: "tail", limit: 60 })
      .catch(() => null);
    if (!page) return false;
    const timeline = page.entries.map((entry) => entry.item);
    // Stamp the recovered end when the agent really stopped, so unsupervised time is not inflated.
    const tail = page.entries.at(-1);
    const lastSeen = last ? Date.parse(last.ts) : 0;
    const endedAt =
      tail?.timestamp && Date.parse(tail.timestamp) >= lastSeen ? new Date(tail.timestamp).toISOString() : undefined;
    this.readAt.set(agent.id, agent.updatedAt);
    await this.endTurn(store, item, agent.id, outcomeOf(timeline), timeline, {
      recovered: true,
      seen,
      endedAt,
      turnId: tail?.turnId ?? null,
    });
    return true;
  }
}
