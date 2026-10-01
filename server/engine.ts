// The Maestro engine on Paseo. RPCs are the human's verbs (create, dispatch,
// the gate, unblock, cancel, adopt); lifecycle hooks are the agent's side of
// the story (turns, permissions, archive). Both end in `store.mutate`, which
// validates every transition against the shared state machine. The agent
// socket offers sessions create, dispatch and adopt too, recorded under their
// own origin, and never the gate.
//
// Paseo delivers hook events live and best effort, with no replay. So every
// list also reconciles bound work against the agent's real status. Reconcile
// acts only on what it saw: each correction is guarded by the event count it
// read, so a real hook that lands first always wins, and an outcome it did
// not observe never closes work on its own.

import { isAbsolute } from "node:path";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { MaestroConfig, RunChoices, WorkItem } from "../shared/contracts";
import { skipsPrompts } from "../shared/run";
import { GROUP_ORDER, isDispatchable, isTerminal, landingState, type Verdict } from "../shared/states";
import { runChecks } from "./checks";
import { loadConfig } from "./config";
import {
  BY_HUMAN,
  checkOutcome,
  lastOf,
  latestChecks,
  type Origin,
  pendingChecks,
  pendingPermission,
  phaseOf,
  scoreboard,
  toWireEvents,
  type WorkEvent,
  workerOf,
} from "./events";
import { inspectFolder, repoRefusal } from "./folders";
import { briefOf, type RunKeys, workTitle } from "./frontmatter";
import { describePermission, type PermissionLike } from "./permissions";
import { type Paseo, startRun } from "./runs";
import { type Mutation, placement, type StoredWork, WorkStore } from "./store";
import { toWire } from "./wire";

/** Why a verb that starts or reads a session cannot run: the plugin has not been handed a Paseo client yet. */
export const NO_HANDLE =
  "Maestro has no connection to Paseo yet. It gets one with the first agent event after the plugin starts: start or message any session, then retry.";

export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

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

export interface EngineOptions {
  now?: () => Date;
  /** Told after a run's end or its checks are written, with the item before and after; not awaited (server/gate-card.ts). */
  landed?: (before: StoredWork, after: StoredWork) => unknown;
  config?: () => Promise<MaestroConfig>;
  log?: (message: string) => void;
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

  constructor(options: EngineOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.readConfig = options.config ?? (() => loadConfig());
    this.log = options.log ?? ((message) => console.log(`[maestro] ${message}`));
    this.landed = options.landed ?? (() => undefined);
  }

  /** The settings runs start from, as this engine reads them. */
  settings(): Promise<MaestroConfig> {
    return this.readConfig();
  }

  stop(): void {
    this.abort.abort();
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

  async list(paseo?: Paseo): Promise<{
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

  async dispatch(paseo: Paseo, id: string, origin: Origin = BY_HUMAN): Promise<WorkItem> {
    if (this.dispatching.has(id)) throw new UserError("This work is already being dispatched.");
    this.dispatching.add(id);
    try {
      const { store, config } = await this.store();
      const item = await store.findById(id);
      const refusal = startRefusal(item, origin);
      if (refusal) throw new UserError(refusal);
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
      // With no dispatch left in flight nothing else can bind a queued agent: settle every queue now.
      if (this.dispatching.size === 0) {
        for (const agentId of [...this.queues.keys()]) await this.flush(agentId);
      }
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

  async verdict(paseo: Paseo | undefined, id: string, verdict: Verdict, note: string): Promise<WorkItem> {
    const { store, config } = await this.store();
    const trimmed = note.trim();
    if (verdict === "revise" && !trimmed) throw new UserError("Say what should change before sending it back.");
    const current = await store.findById(id);
    if (current.contract.state !== "review") throw new UserError("Only work waiting on you takes a verdict.");
    if (verdict !== "block") await this.assertIdle(paseo, current);
    const updated = await store.mutate(
      id,
      (item) => {
        if (item.contract.state !== "review") throw new UserError("Only work waiting on you takes a verdict.");
        if (verdict !== "block" && pendingPermission(item.events)) {
          throw new UserError("The agent is waiting on a question. Answer it first.");
        }
        if (verdict === "revise" && !workerOf(item.events)) {
          throw new UserError("There is no session to send this back to.");
        }
        return {
          to: verdict === "approve" ? "done" : verdict === "revise" ? "running" : "canceled",
          actor: "human",
          ctx: { verdict },
          reason: verdict === "revise" ? "Sent back with a note" : null,
          events: [{ ts: this.stamp(), type: "gate", actor: "human", verdict, note: trimmed }],
        };
      },
      current.dir,
    );
    if (verdict !== "revise" || !paseo) return toWire(updated, this.now().getTime(), config);
    return this.wake(
      paseo,
      { store, config },
      updated,
      `Changes requested before this is done:\n\n${trimmed}\n\nMake the changes, commit them, and end with the Decided and Ask sections again.`,
    );
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

  async cancel(id: string): Promise<WorkItem> {
    if (this.dispatching.has(id)) throw new UserError("A run is starting for this work. Cancel it once it is running.");
    const { store, config } = await this.store();
    const current = await store.findById(id);
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
        if (state === "running") throw new UserError("Stop the session first, then cancel the work.");
        return {
          to: "canceled",
          actor: "human",
          events:
            state === "review" ? [{ ts: this.stamp(), type: "gate", actor: "human", verdict: "block", note: "" }] : [],
        };
      },
      current.dir,
    );
    return toWire(updated, this.now().getTime(), config);
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
