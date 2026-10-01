// The Maestro engine on Paseo. RPCs are the human's verbs (create, dispatch,
// the gate, unblock, cancel, adopt); lifecycle hooks are the agent's side of
// the story (turns, permissions, archive). Both end in `store.mutate`, which
// validates every transition against the shared state machine. The agent
// socket offers sessions create, dispatch and adopt too, recorded under their
// own origin, and never the gate.
//
// A decision at the gate (approve, send back, cancel) is recorded when you make
// it and applies UNDO_MS later, so a slip can be undone. The pending decision is
// an event with the time it takes effect: a timer applies it, and a sweep on
// load and on every list applies anything overdue, so a restart inside the
// window still applies it. Every guard is checked again when it applies.
//
// Paseo delivers hook events live and best effort, with no replay. So every
// list also reconciles bound work against the agent's real status. Reconcile
// acts only on what it saw: each correction is guarded by the event count it
// read, so a real hook that lands first always wins, and an outcome it did
// not observe never closes work on its own.

import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { type MaestroConfig, NOT_STOPPED, type RunChoices, type WorkItem } from "../shared/contracts";
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
import { runChecks } from "./checks";
import { loadConfig } from "./config";
import {
  BY_HUMAN,
  checkOutcome,
  decisionApplied,
  eventsSince,
  lastOf,
  latestChecks,
  type Origin,
  pendingChecks,
  pendingDecision,
  pendingPermission,
  phaseOf,
  reasonOf,
  scoreboard,
  toWireEvents,
  type WorkEvent,
  workerOf,
} from "./events";
import { inspectFolder, repoRefusal } from "./folders";
import { briefOf, type RunKeys, workTitle } from "./frontmatter";
import { describePermission, type PermissionLike } from "./permissions";
import { type Paseo, startRun } from "./runs";
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
  return output.trim().slice(-8000);
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
 * counts within the stretch.
 */
export function isDuplicateEnd(events: readonly WorkEvent[], turnId: string | null): boolean {
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
  return true;
}

const QUEUE_MS = 120_000;
const INDEX_MS = 15_000;
const RECONCILE_MS = 10_000;
const MISSED_END_MS = 90_000;

/** How long a decision at the gate waits before it takes effect. */
export const UNDO_MS = 10_000;

/** The reason work you stopped is stuck. */
export const STOPPED = "You stopped the run";

/** Why work Stop flipped to stuck went back to running: its worktree changed between Stop's two reads. */
export const STOP_RACED = "The worktree changed while Stop checked it";

/** Why Stop is refused while checks run: the session is done, and the checks decide where the work lands. */
export const CHECKING = "The run already finished and its checks are running. When they report, it lands with you.";

/** Runs `run` once after `ms` and returns what cancels it. */
export type Timer = (run: () => Promise<void>, ms: number) => () => void;

const realTimer: Timer = (run, ms) => {
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

export const MODED_BY_YOU = "This work runs in a mode you chose; start it yourself.";

/** See EngineOptions.claimWaitMs. */
export const CLAIM_WAIT_MS = 30_000;

/** `work()`, or a rejection once `ms` pass: a claim never waits on the daemon for ever. */
function within<T>(work: () => Promise<T>, ms: number): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error(`Paseo did not answer within ${Math.round(ms / 100) / 10}s`)), ms);
  });
  return Promise.race([Promise.resolve().then(work), late]).finally(() => clearTimeout(handle));
}

/** Why a decision cannot be made (or, when it comes due, applied) on this item right now. */
function gateRefusal(item: StoredWork, verdict: Verdict, applying: boolean): string | null {
  if (item.contract.state !== "review") {
    return applying ? "It was no longer waiting on you." : "Only work waiting on you takes a verdict.";
  }
  if (verdict !== "block" && pendingPermission(item.events)) {
    return "The agent is waiting on a question. Answer it first.";
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

/**
 * Why this caller may not start this work, or null. You may start queued or
 * stuck work, or a run with no session recorded. A session may start only
 * queued work (restarting stuck work is unblocking, and that is yours), and
 * never work that carries a mode you chose for it: the mode is yours to use.
 */
function startRefusal(item: StoredWork, origin: Origin): string | null {
  const state = item.contract.state;
  if (origin.actor === "agent") {
    if (!isDispatchable(state)) return "A session can start only queued work. Stuck work is unblocked in Maestro.";
    // auto_accept is a mode by another name: it skips the prompts too (shared/run.ts).
    return item.contract.modeId || skipsPrompts({ featureValues: item.contract.featureValues }) ? MODED_BY_YOU : null;
  }
  if (isDispatchable(state) || state === "blocked" || (state === "running" && !workerOf(item.events))) return null;
  return "Only queued or stuck work can be dispatched.";
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
  private lastReconcile = 0;
  private readonly client: () => Paseo | null;
  private readonly timer: Timer;
  private readonly claimWaitMs: number;
  /** Pending decisions with a timer armed, by token, to the timer's cancel. */
  private readonly armed = new Map<string, () => void>();
  /** Decisions being applied right now, by token, so a timer and a sweep never apply one twice. */
  private readonly applying = new Set<string>();
  /** Dispatches that passed the capacity check and have not finished: each holds a slot. */
  private readonly admitted = new Set<string>();
  private closed = false;

  constructor(options: EngineOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.readConfig = options.config ?? (() => loadConfig());
    this.log = options.log ?? ((message) => console.log(`[maestro] ${message}`));
    this.landed = options.landed ?? (() => undefined);
    this.client = options.client ?? (() => null);
    this.timer = options.timer ?? realTimer;
    this.claimWaitMs = options.claimWaitMs ?? CLAIM_WAIT_MS;
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

  // ── Reads ──────────────────────────────────────────────────────────────────

  /**
   * All work. A read of yours (`decide`, the default) also applies decisions
   * whose undo window has closed; a session's read never does, so no session
   * can make one of your decisions land.
   */
  async list(
    paseo?: Paseo,
    options: { decide?: boolean } = {},
  ): Promise<{
    root: string;
    items: WorkItem[];
    scoreboard: ReturnType<typeof scoreboard>;
    warnings: string[];
  }> {
    const { store, config } = await this.store();
    let { items, warnings } = await store.scan();
    this.index(store, items);
    if (paseo && this.now().getTime() - this.lastReconcile > RECONCILE_MS) {
      this.lastReconcile = this.now().getTime();
      if (await this.reconcile(paseo, items)) {
        ({ items, warnings } = await store.scan());
        this.index(store, items);
      }
    }
    if (options.decide !== false && (await this.sweep(paseo, items))) {
      ({ items, warnings } = await store.scan());
      this.index(store, items);
    }
    const now = this.now();
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const wire = items.map((item) => toWire(item, now.getTime(), config));
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

  // ── Human verbs ────────────────────────────────────────────────────────────

  async create(paseo: Paseo | null, input: CreateInput, origin: Origin = BY_HUMAN): Promise<WorkItem> {
    const title = workTitle(input.title, input.brief);
    if (!title) throw new UserError("Write a brief, or at least a title.");
    if (input.gate === "auto" && !input.check.trim()) {
      throw new UserError("Letting checks decide needs a check command.");
    }
    // How runs start is yours alone: work a session creates runs as Settings say, so no
    // session can file work that dispatches with a mode that skips permissions.
    const run = origin.actor === "agent" ? undefined : runKeys(input);
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
    });
    if (input.dispatch) {
      if (!paseo) throw new UserError(`Created ${item.contract.id}, but it cannot be dispatched yet: ${NO_HANDLE}`);
      return this.dispatch(paseo, item.contract.id, origin);
    }
    return toWire(item, this.now().getTime(), config);
  }

  /**
   * Create work and, when asked, dispatch it. At the concurrency cap the work
   * is still created: it comes back queued with the reason, so the caller
   * holds its id and a retry dispatches it rather than creating it again.
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
      if (!(error instanceof AtCapacity)) throw error;
      return { item: (await this.get(item.id)).item, notice: `Created ${item.id}, not started. ${error.message}` };
    }
  }

  async dispatch(paseo: Paseo, id: string, origin: Origin = BY_HUMAN): Promise<WorkItem> {
    if (this.dispatching.has(id)) throw new UserError("This work is already being dispatched.");
    this.dispatching.add(id);
    // Take a slot before reading anything: every dispatch admitted ahead of this one is
    // counted from here, whether or not the files say it is running by the time they are read.
    const ahead = [...this.admitted];
    this.admitted.add(id);
    try {
      const { store, config } = await this.store();
      const item = await store.findById(id);
      const refusal = startRefusal(item, origin);
      if (refusal) throw new UserError(refusal);
      this.checkCapacity(item, ahead, await this.running(store), config.concurrencyCap);
      let worker: Awaited<ReturnType<typeof startRun>>;
      try {
        worker = await startRun(paseo, config, item);
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
      // With no dispatch left in flight nothing else can bind a queued agent: settle every queue now.
      if (this.dispatching.size === 0) {
        for (const agentId of [...this.queues.keys()]) await this.flush(agentId);
      }
    }
  }

  /** Ids of the work running now, as the files say. */
  private async running(store: WorkStore): Promise<Set<string>> {
    const { items } = await store.scan();
    return new Set(items.filter((other) => other.contract.state === "running").map((other) => other.contract.id));
  }

  /**
   * Refuse at the cap. Busy is what the files say is running plus every
   * dispatch that took a slot before this one did (`ahead`, read before the
   * files). A dispatch holds its slot until it ends, so past the point its run
   * is recorded running, or until it fails: each one ahead is counted by the
   * files or by its slot, since the files are read after the slot list, and a
   * run counted by both is one id, counted once.
   */
  private checkCapacity(item: StoredWork, ahead: readonly string[], running: Set<string>, cap: number | null): void {
    const busy = new Set([...running, ...ahead]);
    busy.delete(item.contract.id);
    if (cap !== null && busy.size >= cap) {
      throw new AtCapacity(
        `At capacity: ${busy.size} running. It stays ${PLAIN_VOICE[item.contract.state].label.toLowerCase()}.`,
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
   * Runs on load, on every list, and when the plugin first gets a client, so a
   * restart inside the window still applies the decision. True when any changed.
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
   * After an approval applies: archive the run's workspace, so its worktree
   * goes and its branch stays as the receipt. Best effort: a failure is a
   * receipt and never undoes the approval. Only a workspace a dispatch
   * created is Maestro's; a tracked session's, or the repository itself in
   * directory mode, is yours and stays.
   */
  private async archiveWorkspace(paseo: Paseo | null, store: WorkStore, item: StoredWork): Promise<void> {
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
    if (!paseo) return record(`Could not archive the workspace: ${NO_HANDLE} The approval stands.`);
    // The claim is the item's lock, the one every mutation of it takes, so the receipt is written after it is released.
    return record(
      await withLock(item.contract.id, () => this.archiveClaimed(paseo, item, { ...worker, workspaceId, branch })),
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
      ? `Could not archive the workspace: ${failure}. The approval stands.`
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
    return this.wake(
      paseo,
      { store, config },
      updated,
      trimmed || "Continue where you stopped. End with the Decided and Ask sections.",
    );
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
          fresh.contract.state === "running" && !workerOf(fresh.events)
            ? { to: "blocked", reason: "No session is recorded for this run" }
            : null,
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
   * Stop a running run. Paseo has no stop that keeps the session, so this
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
   * call fails, asking you to Stop again. Every daemon call under the claim
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
      if (item.contract.state !== "running") return "Only running work can be stopped.";
      // The session already finished; stopping now would only strand the checks' result.
      if (phaseOf(item.contract.state, item.events) === "checking") return CHECKING;
      return null;
    };
    const early = refusal(current);
    if (early) throw new UserError(early);
    const worker = workerOf(current.events);
    const checked = worker && !discard ? await this.stopLoss(paseo, current, worker) : null;
    if (checked && "refusal" in checked) throw new UserError(checked.refusal);
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
            const changed = await this.stopRecheck(paseo, stopped, worker, digest);
            return changed ? { changed } : { failed: await archive(true) };
          });
    if ("changed" in outcome) {
      await putBack(outcome.changed.reason, `Did not archive session ${worker.agentId}: ${outcome.changed.reason}`);
      throw new UserError(outcome.changed.message);
    }
    if (outcome.failed) {
      const { message } = outcome.failed;
      await putBack(`Could not stop the session: ${message}`, `Could not archive session ${worker.agentId}: ${message}`);
      throw new UserError(`Could not stop the session: ${message}`);
    }
    return toWire(await store.load(stopped.dir), this.now().getTime(), config);
  }

  /** Track a session that was started by hand, so its end lands at the gate. */
  async adopt(paseo: Paseo, agentId: string, title: string, origin: Origin = BY_HUMAN): Promise<WorkItem> {
    // Scan-then-create is not atomic: a retry or a second caller must not bind one session twice.
    if (this.adopting.has(agentId)) throw new UserError("This session is already being tracked.");
    this.adopting.add(agentId);
    try {
      return await this.adoptOnce(paseo, agentId, title, origin);
    } finally {
      this.adopting.delete(agentId);
    }
  }

  private async adoptOnce(paseo: Paseo, agentId: string, title: string, origin: Origin): Promise<WorkItem> {
    const { store, config } = await this.store();
    const { items } = await store.scan();
    this.index(store, items);
    const existing = items.find((item) => workerOf(item.events)?.agentId === agentId);
    if (existing) return toWire(existing, this.now().getTime(), config);
    const snapshot = await paseo.agents.ref(agentId).refresh();
    if (!snapshot) throw new UserError("That session no longer exists.");
    const agent = snapshot.agent;
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
            branch: null,
            cwd: agent.cwd,
          },
        ],
      }),
      created.dir,
    );
    this.dirs(store.root).set(agentId, running.dir);
    if (agent.status === "running") return toWire(running, this.now().getTime(), config);
    const landed = await store.mutate(
      id,
      () => ({ to: "review", reason: "The session was idle when tracked" }),
      running.dir,
    );
    return toWire(landed, this.now().getTime(), config);
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

  async onArchived(agent: HookAgent): Promise<void> {
    await this.route(agent.id, async (store, item) => {
      await store.mutate(
        item.contract.id,
        (fresh) => {
          if (workerOf(fresh.events)?.agentId !== agent.id) return null;
          const state = fresh.contract.state;
          if (state === "running") return { to: "blocked", reason: "The session was archived before it finished" };
          if (state === "review" && pendingPermission(fresh.events)) {
            return { to: "blocked", reason: "The session was archived while it was asking" };
          }
          if (isTerminal(state)) return null;
          return { events: [this.note("The session was archived")] };
        },
        item.dir,
      );
    });
  }

  private async startTurn(store: WorkStore, item: StoredWork, agentId: string): Promise<void> {
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
          return { to: "running", actor: "human", reason: "Resumed in the session", events: [event] };
        }
        return null;
      },
      item.dir,
    );
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
    options: { recovered?: boolean; seen?: number; endedAt?: string; turnId?: string | null },
  ): Promise<void> {
    let token: string | null = null;
    const updated = await store.mutate(
      item.contract.id,
      (fresh): Mutation | null => {
        if (options.seen !== undefined && fresh.events.length !== options.seen) return null;
        if (workerOf(fresh.events)?.agentId !== agentId) return null;
        // Without a turn id a repeat cannot be told from a new turn; a failure is never hidden as a repeat.
        const unidentifiedFailure = !options.turnId && outcome.kind !== "completed";
        if (!unidentifiedFailure && isDuplicateEnd(fresh.events, options.turnId ?? null)) return null;
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
        if (state !== "running") {
          // The session worked again after landing (its turn start was missed): the gate must show that turn.
          if (state === "review" && !pendingPermission(fresh.events)) {
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
        const reason = options.recovered ? "Recovered after a missed event" : null;
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

  private async reconcileOne(paseo: Paseo, store: WorkStore, item: StoredWork): Promise<boolean> {
    const state = item.contract.state;
    if (state !== "running" && state !== "review") return false;
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
    const worker = workerOf(item.events);
    if (!worker) {
      return state === "running" ? guarded({ to: "blocked", reason: "No session is recorded for this run" }) : false;
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
    const permission = pendingPermission(item.events);
    if (!agent || agent.archivedAt || agent.status === "closed") {
      if (state === "running") return guarded({ to: "blocked", reason: "The session ended before the run finished" });
      if (permission) return guarded({ to: "blocked", reason: "The session ended while it was asking" });
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
    await this.endTurn(store, item, agent.id, outcomeOf(timeline), timeline, {
      recovered: true,
      seen,
      endedAt,
      turnId: tail?.turnId ?? null,
    });
    return true;
  }
}
