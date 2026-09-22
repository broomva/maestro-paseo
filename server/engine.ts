// The Maestro engine on Paseo. RPCs are the human's verbs (create, dispatch,
// the gate, unblock, cancel, adopt); lifecycle hooks are the agent's side of
// the story (turns, permissions, archive). Both end in `store.mutate`, which
// validates every transition against the shared state machine.
//
// Paseo delivers hook events live and best effort, with no replay. So every
// list also reconciles bound work against the agent's real status, which
// recovers anything missed while the plugin was stopped.

import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { MaestroConfig, WorkEventWire, WorkItem } from "../shared/contracts";
import { GROUP_ORDER, isDispatchable, isTerminal, landingState, type Verdict } from "../shared/states";
import { runChecks } from "./checks";
import { loadConfig } from "./config";
import {
  checkOutcome,
  latestChecks,
  pendingChecks,
  pendingPermission,
  phaseOf,
  scoreboard,
  toWireEvent,
  type WorkEvent,
  workerOf,
} from "./events";
import { briefOf } from "./frontmatter";
import { describePermission, type PermissionLike } from "./permissions";
import { type Paseo, startRun } from "./runs";
import { type StoredWork, WorkStore } from "./store";
import { toWire } from "./wire";

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

type Outcome =
  | { kind: "completed" }
  | { kind: "failed"; error: { message: string } }
  | { kind: "canceled"; reason: string };

const BUFFER_MS = 120_000;
const RECONCILE_MS = 10_000;
const MISSED_END_MS = 90_000;

export interface EngineOptions {
  now?: () => Date;
  config?: () => Promise<MaestroConfig>;
  log?: (message: string) => void;
}

export class Engine {
  private readonly now: () => Date;
  private readonly readConfig: () => Promise<MaestroConfig>;
  private readonly log: (message: string) => void;
  private readonly dispatching = new Set<string>();
  private readonly activeChecks = new Set<string>();
  private readonly buffered = new Map<string, { at: number; run: Array<() => Promise<void>> }>();
  private readonly abort = new AbortController();
  private lastReconcile = 0;

  constructor(options: EngineOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.readConfig = options.config ?? (() => loadConfig());
    this.log = options.log ?? ((message) => console.log(`[maestro] ${message}`));
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

  // ── Reads ──────────────────────────────────────────────────────────────────

  async list(paseo?: Paseo): Promise<{
    root: string;
    items: WorkItem[];
    scoreboard: ReturnType<typeof scoreboard>;
    warnings: string[];
  }> {
    const { store } = await this.store();
    let { items, warnings } = await store.scan();
    if (paseo && this.now().getTime() - this.lastReconcile > RECONCILE_MS) {
      this.lastReconcile = this.now().getTime();
      if (await this.reconcile(paseo, items)) ({ items, warnings } = await store.scan());
    }
    const now = this.now();
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const wire = items.map((item) => toWire(item, now.getTime()));
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
      ),
      warnings,
    };
  }

  async get(id: string) {
    const { store } = await this.store();
    const item = await store.findById(id);
    return {
      item: toWire(item, this.now().getTime()),
      brief: briefOf(item.work.body),
      events: item.events.map(toWireEvent).filter((event): event is WorkEventWire => event !== null),
      checkResults: latestChecks(item.events),
    };
  }

  async forAgent(agentId: string): Promise<WorkItem | null> {
    const { store } = await this.store();
    const item = await store.findByAgent(agentId);
    return item ? toWire(item, this.now().getTime()) : null;
  }

  // ── Human verbs ────────────────────────────────────────────────────────────

  async create(
    paseo: Paseo,
    input: {
      title: string;
      brief: string;
      repo: string;
      gate: "human" | "auto";
      check: string;
      initiative: string;
      dispatch: boolean;
    },
  ): Promise<WorkItem> {
    if (input.gate === "auto" && !input.check.trim()) {
      throw new UserError("Letting checks decide needs a check command.");
    }
    const { store } = await this.store();
    const { stat } = await import("node:fs/promises");
    const repo = input.repo.trim();
    const info = await stat(repo).catch(() => null);
    if (!info?.isDirectory()) throw new UserError(`No folder at ${repo}.`);
    const item = await store.create({ ...input, repo, now: this.now() });
    if (input.dispatch) return this.dispatch(paseo, item.contract.id);
    return toWire(item, this.now().getTime());
  }

  async dispatch(paseo: Paseo, id: string): Promise<WorkItem> {
    const { store, config } = await this.store();
    const item = await store.findById(id);
    const state = item.contract.state;
    if (!isDispatchable(state) && state !== "blocked") {
      throw new UserError("Only queued or stuck work can be dispatched.");
    }
    if (this.dispatching.has(id)) throw new UserError("This work is already being dispatched.");
    this.dispatching.add(id);
    try {
      let worker: Awaited<ReturnType<typeof startRun>>;
      try {
        worker = await startRun(paseo, config, item);
      } catch (error) {
        const message = (error as Error).message;
        await store.mutate(id, () => ({
          events: [{ ts: this.stamp(), type: "note", actor: "maestro", text: `Dispatch failed: ${message}` }],
        }));
        throw new UserError(`Could not start the run: ${message}`);
      }
      const updated = await store.mutate(id, () => ({
        to: "running",
        actor: "human",
        events: [{ ts: this.stamp(), type: "dispatched", actor: "human", ...worker }],
      }));
      await this.flush(worker.agentId);
      return toWire(updated, this.now().getTime());
    } finally {
      this.dispatching.delete(id);
    }
  }

  async verdict(paseo: Paseo, id: string, verdict: Verdict, note: string): Promise<WorkItem> {
    const { store } = await this.store();
    const trimmed = note.trim();
    if (verdict === "revise" && !trimmed) throw new UserError("Say what should change before sending it back.");
    const updated = await store.mutate(id, (item) => {
      if (item.contract.state !== "review") throw new UserError("Only work waiting on you takes a verdict.");
      if (verdict !== "block" && pendingPermission(item.events)) {
        throw new UserError("The agent is waiting on a question. Answer it first.");
      }
      if (verdict === "revise" && !workerOf(item.events))
        throw new UserError("There is no session to send this back to.");
      return {
        to: verdict === "approve" ? "done" : verdict === "revise" ? "running" : "canceled",
        actor: "human",
        ctx: { verdict },
        reason: verdict === "revise" ? "Sent back with a note" : null,
        events: [{ ts: this.stamp(), type: "gate", actor: "human", verdict, note: trimmed }],
      };
    });
    if (verdict !== "revise") return toWire(updated, this.now().getTime());
    return this.wake(
      paseo,
      store,
      updated,
      `Changes requested before this is done:\n\n${trimmed}\n\nMake the changes, commit them, and end with the Decided and Ask sections again.`,
    );
  }

  async unblock(paseo: Paseo, id: string, note: string): Promise<WorkItem> {
    const { store } = await this.store();
    const item = await store.findById(id);
    if (item.contract.state !== "blocked") throw new UserError("Only stuck work can be unblocked.");
    const worker = workerOf(item.events);
    const alive = worker
      ? await paseo.agents
          .ref(worker.agentId)
          .refresh()
          .catch(() => null)
      : null;
    if (!alive || alive.agent.archivedAt) return this.dispatch(paseo, id);
    const trimmed = note.trim();
    const updated = await store.mutate(id, () => ({
      to: "running",
      actor: "human",
      reason: "Unblocked",
      events: [{ ts: this.stamp(), type: "unblocked", actor: "human", note: trimmed }],
    }));
    return this.wake(
      paseo,
      store,
      updated,
      trimmed || "Continue where you stopped. End with the Decided and Ask sections.",
    );
  }

  async cancel(id: string): Promise<WorkItem> {
    const { store } = await this.store();
    const updated = await store.mutate(id, (item) => {
      const state = item.contract.state;
      if (isTerminal(state)) return null;
      if (state === "running") throw new UserError("Stop the session first, then cancel the work.");
      return {
        to: "canceled",
        actor: "human",
        events:
          state === "review" ? [{ ts: this.stamp(), type: "gate", actor: "human", verdict: "block", note: "" }] : [],
      };
    });
    return toWire(updated, this.now().getTime());
  }

  /** Track a session that was started by hand, so its end lands at the gate. */
  async adopt(paseo: Paseo, agentId: string, title: string): Promise<WorkItem> {
    const { store } = await this.store();
    const existing = await store.findByAgent(agentId);
    if (existing) return toWire(existing, this.now().getTime());
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
    });
    const id = created.contract.id;
    const running = await store.mutate(id, () => ({
      to: "running",
      actor: "human",
      events: [
        {
          ts: this.stamp(),
          type: "adopted",
          actor: "human",
          agentId,
          workspaceId: agent.workspaceId ?? null,
          provider: agent.provider,
          branch: null,
          cwd: agent.cwd,
        },
      ],
    }));
    if (agent.status === "running") return toWire(running, this.now().getTime());
    const landed = await store.mutate(id, () => ({ to: "review", reason: "The session was idle when tracked" }));
    return toWire(landed, this.now().getTime());
  }

  /** Move work back to running and prompt its session; a failed send parks it as stuck. */
  private async wake(paseo: Paseo, store: WorkStore, item: StoredWork, text: string): Promise<WorkItem> {
    const worker = workerOf(item.events);
    try {
      if (!worker) throw new Error("no session is bound");
      await paseo.agents.ref(worker.agentId).send(text);
      return toWire(item, this.now().getTime());
    } catch (error) {
      const reason = `Could not reach the session: ${(error as Error).message}`;
      const stuck = await store.mutate(item.contract.id, (fresh) =>
        fresh.contract.state === "running" ? { to: "blocked", reason } : null,
      );
      return toWire(stuck, this.now().getTime());
    }
  }

  // ── Lifecycle hooks ────────────────────────────────────────────────────────

  private async route(agentId: string, run: (item: StoredWork, store: WorkStore) => Promise<void>): Promise<void> {
    const { store } = await this.store();
    const item = await store.findByAgent(agentId);
    if (item) {
      await run(item, store);
      return;
    }
    // A dispatch records its binding after Paseo returns the agent; the first
    // turn can start before that. Hold events for unknown agents briefly.
    if (this.dispatching.size === 0) return;
    const entry = this.buffered.get(agentId) ?? { at: Date.now(), run: [] };
    entry.run.push(() => this.route(agentId, run));
    this.buffered.set(agentId, entry);
  }

  private async flush(agentId: string): Promise<void> {
    const entry = this.buffered.get(agentId);
    this.buffered.delete(agentId);
    for (const [id, stale] of this.buffered) {
      if (Date.now() - stale.at > BUFFER_MS) this.buffered.delete(id);
    }
    for (const run of entry?.run ?? []) {
      await run().catch((error) => this.log(`replay failed for ${agentId}: ${(error as Error).message}`));
    }
  }

  async onTurnStarted(agent: HookAgent): Promise<void> {
    await this.route(agent.id, async (item, store) => {
      await store.mutate(item.contract.id, (fresh) => {
        const event: WorkEvent = { ts: this.stamp(), type: "turn.started", actor: "agent", agentId: agent.id };
        const state = fresh.contract.state;
        if (state === "running") return { events: [event] };
        if (state === "review" && !pendingPermission(fresh.events)) {
          return { to: "running", actor: "human", reason: "You continued the session", events: [event] };
        }
        if (state === "blocked")
          return { to: "running", actor: "human", reason: "Resumed in the session", events: [event] };
        return null;
      });
    });
  }

  async onTurnEnded(agent: HookAgent, outcome: Outcome, timeline: readonly AgentTimelineItem[]): Promise<void> {
    await this.route(agent.id, async (item, store) => {
      let token: string | null = null;
      const updated = await store.mutate(item.contract.id, (fresh) => {
        const ended: WorkEvent = {
          ts: this.stamp(),
          type: "turn.ended",
          actor: "agent",
          agentId: agent.id,
          outcome: outcome.kind,
          error: outcome.kind === "failed" ? outcome.error.message : null,
          summary: latestOutputText(timeline),
        };
        if (fresh.contract.state !== "running") return { events: [ended] };
        if (outcome.kind === "failed") return { to: "blocked", reason: outcome.error.message, events: [ended] };
        if (outcome.kind === "canceled") return { to: "blocked", reason: "Stopped before finishing", events: [ended] };
        if (fresh.contract.checks.length > 0) {
          token = `${agent.id}:${ended.ts}`;
          return { events: [ended, { ts: this.stamp(), type: "checks.started", actor: "maestro", token }] };
        }
        return { to: landingState(fresh.contract.gate, "none"), events: [ended] };
      });
      if (token) void this.runChecksFor(store, updated, token);
    });
  }

  async onPermissionRequested(agent: HookAgent, request: PermissionLike & { id: string }): Promise<void> {
    await this.route(agent.id, async (item, store) => {
      await store.mutate(item.contract.id, (fresh) => {
        if (pendingPermission(fresh.events)?.requestId === request.id) return null;
        const { title, detail } = describePermission(request, workerOf(fresh.events)?.cwd ?? null);
        const asked: WorkEvent = {
          ts: this.stamp(),
          type: "permission.asked",
          actor: "agent",
          agentId: agent.id,
          requestId: request.id,
          title,
          detail,
        };
        if (fresh.contract.state !== "running") return { events: [asked] };
        return { to: "review", actor: "agent", reason: "Asked for permission", events: [asked] };
      });
    });
  }

  async onPermissionResolved(agent: HookAgent, requestId: string): Promise<void> {
    await this.route(agent.id, async (item, store) => {
      await store.mutate(item.contract.id, (fresh) => {
        const pending = pendingPermission(fresh.events);
        const resolved: WorkEvent = {
          ts: this.stamp(),
          type: "permission.resolved",
          actor: "human",
          agentId: agent.id,
          requestId,
        };
        if (pending?.requestId !== requestId) return null;
        if (fresh.contract.state === "review") {
          return { to: "running", actor: "human", reason: "Permission answered", events: [resolved] };
        }
        return { events: [resolved] };
      });
    });
  }

  async onArchived(agent: HookAgent): Promise<void> {
    await this.route(agent.id, async (item, store) => {
      await store.mutate(item.contract.id, (fresh) => {
        if (fresh.contract.state === "running")
          return { to: "blocked", reason: "The session was archived before it finished" };
        if (isTerminal(fresh.contract.state)) return null;
        return { events: [{ ts: this.stamp(), type: "note", actor: "maestro", text: "The session was archived" }] };
      });
    });
  }

  // ── Checks ─────────────────────────────────────────────────────────────────

  private async runChecksFor(store: WorkStore, item: StoredWork, token: string): Promise<void> {
    if (this.activeChecks.has(token)) return;
    this.activeChecks.add(token);
    try {
      const cwd = workerOf(item.events)?.cwd ?? item.contract.repo;
      const results = cwd ? await runChecks(item.contract.checks, cwd, this.abort.signal) : [];
      if (this.abort.signal.aborted) return;
      await store.mutate(item.contract.id, (fresh) => {
        if (pendingChecks(fresh.events) !== token) return null;
        const finished: WorkEvent = { ts: this.stamp(), type: "checks.finished", actor: "maestro", token, results };
        const started = fresh.events.findIndex((event) => event.type === "checks.started" && event.token === token);
        const newerTurn = fresh.events.slice(started + 1).some((event) => event.type === "turn.started");
        if (fresh.contract.state !== "running" || newerTurn) return { events: [finished] };
        const outcome = cwd ? checkOutcome(results) : "none";
        return {
          to: landingState(fresh.contract.gate, outcome),
          reason: outcome === "failed" ? "Checks failed" : null,
          ctx: { checksPassed: outcome === "passed" },
          events: [finished],
        };
      });
    } catch (error) {
      this.log(`checks failed to run for ${item.contract.id}: ${(error as Error).message}`);
    } finally {
      this.activeChecks.delete(token);
    }
  }

  // ── Reconciliation ─────────────────────────────────────────────────────────

  /** Returns true when any item changed. */
  async reconcile(paseo: Paseo, items: readonly StoredWork[]): Promise<boolean> {
    let changed = false;
    const { store } = await this.store();
    for (const item of items) {
      const state = item.contract.state;
      const worker = workerOf(item.events);
      if (!worker || (state !== "running" && state !== "review")) continue;
      const phase = phaseOf(state, item.events);
      if (state === "review" && phase !== "asking") continue;
      const token = pendingChecks(item.events);
      if (phase === "checking" && token) {
        if (!this.activeChecks.has(token)) void this.runChecksFor(store, item, token);
        continue;
      }
      let snapshot: Awaited<ReturnType<ReturnType<Paseo["agents"]["ref"]>["refresh"]>>;
      try {
        snapshot = await paseo.agents.ref(worker.agentId).refresh();
      } catch {
        continue;
      }
      const agent = snapshot?.agent;
      try {
        if (!agent || agent.archivedAt) {
          if (state === "running") {
            await store.mutate(item.contract.id, (fresh) =>
              fresh.contract.state === "running" ? { to: "blocked", reason: "The session is gone" } : null,
            );
            changed = true;
          }
          continue;
        }
        const permission = pendingPermission(item.events);
        if (state === "review" && permission && !agent.pendingPermissions.some((p) => p.id === permission.requestId)) {
          await this.onPermissionResolved({ id: agent.id }, permission.requestId);
          changed = true;
          continue;
        }
        if (state !== "running") continue;
        const first = agent.pendingPermissions[0];
        if (first) {
          await this.onPermissionRequested({ id: agent.id }, first);
          changed = true;
        } else if (agent.status === "error") {
          await store.mutate(item.contract.id, (fresh) =>
            fresh.contract.state === "running"
              ? { to: "blocked", reason: agent.lastError ?? "The session hit an error" }
              : null,
          );
          changed = true;
        } else if (agent.status === "idle" && !agent.activeTurn) {
          const bound = [...item.events]
            .reverse()
            .find((e) => e.type === "dispatched" || e.type === "adopted" || e.type === "state");
          const since = bound ? this.now().getTime() - Date.parse(bound.ts) : Number.POSITIVE_INFINITY;
          if (since > MISSED_END_MS) {
            await this.onTurnEnded({ id: agent.id }, { kind: "completed" }, []);
            changed = true;
          }
        }
      } catch (error) {
        this.log(`reconcile ${item.contract.id}: ${(error as Error).message}`);
      }
    }
    return changed;
  }
}
