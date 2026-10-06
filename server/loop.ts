// The loop: Maestro waking on a schedule to start queued work. It ports the
// behaviour of the reference Maestro's tick (apps/maestro, runtime tick/tick.ts
// and orchestrator/policy.ts), not its code. Each wake:
//   1. reads the work through the engine's list, which reconciles bound work
//      with Paseo and applies decisions whose undo window has closed;
//   2. walks the Queued group, triggered first, then the rest, each oldest
//      first (the longest since its last change);
//   3. leaves alone, with the reason, work whose next run would skip
//      permission prompts or carries a mode you gave it (engine leftToYou),
//      and starts the rest through the engine's dispatch as the loop, so the
//      run cap, the folder checks and the start refusal are dispatch's own.
//      The first refusal at the cap defers it and the rest of the queue "at
//      the run cap", except work the loop would never start whatever the cap
//      (leftToYou), which keeps its own reason after the cap as before it.
//      Work whose start the loop tried and that failed is not tried again
//      while that flag stands: it is yours until something happens to it;
//   4. counts what needs you, and names running work quiet for 30 minutes:
//      Maestro sees only turn boundaries, so work quiet by its events is
//      quiet only if its session, asked (bounded, ASK_MS), has done nothing
//      for as long; when the session cannot be asked it is not flagged, and
//      the entry says why (`unasked`). A run already flagged quiet is asked
//      too: a session at work again mid-turn sends Maestro no event, so the
//      loop takes that flag down itself (`cleared`), and leaves it when the
//      session cannot be asked;
//   5. lands your answers and acts on them (BRO-2827): the answers batch on
//      maestro/answers is brought up to origin/main, pushed, and carried by
//      one PR, gated like any other and never merged by Maestro; once it has
//      landed the branch is levelled with main (server/answers-landing.ts).
//      Then each answer where it belongs, landed or in its checkout, is
//      routed once: to the session that asked when it is idle, else, when
//      that session is gone, as queued work at your gate (server/answer-
//      routes.ts). A batch that cannot take main is kept whole and named in
//      Needs you. It decides no ask: the answers are yours;
//   6. flags, in Maestro's Needs you, what it leaves to you, what it could
//      not start, and what has gone quiet (server/flags.ts): one event per
//      work, and none while the same flag already stands;
//   7. writes one wake-log entry (server/wake-log.ts) that says all of it.
// While the loop is off, a quiet flag stands until the next event on the work.
// It never stops, sends back or decides anything: those stay yours. Being
// deferred at the run cap is not flagged: that work starts when a slot frees.
//
// Off unless Settings give it a period (loopMinutes). The next wake is due a
// period after the last one the log records, so a restart keeps the cadence.
// One wake runs at a time; one asked for meanwhile is recorded as skipped,
// never queued. With no Paseo client yet (the plugin gets one with its first
// handler or hook), a wake records that it could not start work, and the
// first client to arrive runs another, after that wake ends when it arrives
// while the wake is still running.

import { randomUUID } from "node:crypto";
import { type AnswersLanding, landingWords } from "../shared/answers";
import type { FlagKind, WakeEntry, WorkItem } from "../shared/contracts";
import { isDispatchable } from "../shared/states";
import type { RouteOutcome } from "./answer-routes";
import { AtCapacity, type Engine, leftToYou, realTimer, type Timer, UserError, within } from "./engine";
import { LOOP } from "./events";
import {
  failedReason,
  minutesWords,
  QUIET_MS,
  quietReason,
  sentence,
  sessionActiveAt,
  startError,
  yoursReason,
} from "./flags";
import type { Paseo } from "./runs";
import { WakeLog } from "./wake-log";

export { QUIET_MS };

/** Why queued work was left: the loop tried to start it before and could not, and flagged it for you. */
export const FAILED_BEFORE = "it could not start before; start it yourself";

/** Why queued work was left: dispatch refused it at the run cap, so the rest of the queue waits too. */
export const AT_RUN_CAP = "at the run cap";

/** Why a wake started nothing: the plugin has no Paseo client yet. */
export const NOT_CONNECTED =
  "Could not start work: Paseo has not connected to Maestro yet. It connects with the first agent event, or when you open Maestro.";

/** Why a wake was skipped. */
export const ALREADY_WAKING = "another check was already running";

/** How many entries loop.get returns. */
export const RECENT = 20;

/** The longest a wake waits for a session to say when it last worked. */
export const ASK_MS = 10_000;

/** Why a session could not be asked: the plugin has no Paseo client yet. */
export const ASK_NOT_CONNECTED = "Paseo has not connected to Maestro yet";

/** The longest delay a timer holds (setTimeout's limit); a later wake is armed again when it fires. */
const MAX_DELAY_MS = 2 ** 31 - 1;

type Cause = WakeEntry["cause"];
type Named = { id: string; title: string };
/** A flag this wake means to raise, written once the walk is done; `since` for quiet (Engine.flag). */
type Raise = { item: WorkItem; kind: FlagKind; reason: string; since?: string };
/** Running work quiet by Maestro's events (flagged quiet or not), and when it last did anything by them. */
type Silent = { item: WorkItem; last: number };
/** A run flagged quiet whose session has worked again, and when it last did (the daemon's word). */
type Clear = { item: WorkItem; activeAt: number };

/** Step 5's two halves (server/answers-landing.ts, server/answer-routes.ts); neither throws. */
export interface AnswersStep {
  land(): Promise<AnswersLanding>;
  route(): Promise<RouteOutcome[]>;
}

export interface LoopOptions {
  engine: Engine;
  /** The daemon client once the plugin has one. */
  client: () => Paseo | null;
  now?: () => Date;
  /** Schedules the next wake. Tests pass their own, driven by the same clock as `now`. */
  timer?: Timer;
  /** The wake log; defaults to `wake-log.jsonl` beside the config. */
  wakeLog?: WakeLog;
  log?: (message: string) => void;
  /** How long a wake waits for one session to say when it last worked; tests pass a short one. */
  askMs?: number;
  /** Step 5, when Maestro reads a control repo. */
  answers?: AnswersStep;
}

/**
 * The wake in plain words: why it woke, anything that kept it from working,
 * what needs you, what it did, and what it left alone and why. A wake that
 * did nothing still says so.
 */
export function narrate(entry: Omit<WakeEntry, "narrative" | "tickId" | "wokeAt">, notes: readonly string[]): string[] {
  const lines = [entry.cause === "timer" ? "Woke on a scheduled check." : "Woke because you asked.", ...notes];
  if (entry.skipped) return [...lines, `Skipped: ${sentence(entry.skipped)}`];
  const { gate, asking, stuck } = entry.needsYou;
  const needs = [
    ...(gate > 0 ? [`${gate} waiting at your gate.`] : []),
    ...(asking > 0 ? [`${asking} asking you a question.`] : []),
    ...(stuck > 0 ? [`${stuck} stuck.`] : []),
    ...entry.quiet.map((run) => `${run.title} has been quiet ${minutesWords(run.minutes)}, worth a look.`),
  ];
  const landing = entry.answers?.landing ? landingWords(entry.answers.landing) : null;
  if (landing) needs.push(landing);
  if (needs.length > 0) lines.push("Needs you:", ...needs.map((line) => `  ${line}`));
  if (entry.unasked.length > 0) {
    lines.push(
      "Could not ask the session, so quiet was neither flagged nor cleared:",
      ...entry.unasked.map((run) => `  ${run.title}: ${sentence(run.reason)}`),
    );
  }
  const routed = entry.answers?.routed ?? [];
  if (entry.dispatched.length > 0 || routed.length > 0) {
    lines.push(
      "Did:",
      ...entry.dispatched.map((work) => `  Started ${work.title}.`),
      ...routed.map((answer) => `  Your answer to ${answer.id} (${answer.ledger}): ${answer.words}`),
    );
  } else {
    lines.push("Did nothing new this tick.");
  }
  if (entry.deferred.length > 0) {
    lines.push("Left alone:", ...entry.deferred.map((work) => `  ${work.title}: ${sentence(work.reason)}`));
  }
  if (entry.flagged.length > 0) {
    lines.push("Flagged for you:", ...entry.flagged.map((work) => `  ${sentence(work.title)}`));
  }
  if (entry.cleared.length > 0) {
    lines.push("Cleared:", ...entry.cleared.map((work) => `  ${work.title} is active again.`));
  }
  return lines;
}

/** Triggered work first, then the rest of the Queued group; within each, the longest since its last change first. */
export function queueOrder(a: WorkItem, b: WorkItem): number {
  return (
    Number(b.state === "triggered") - Number(a.state === "triggered") ||
    a.updatedAt.localeCompare(b.updatedAt) ||
    a.id.localeCompare(b.id)
  );
}

export class Loop {
  private readonly engine: Engine;
  private readonly client: () => Paseo | null;
  private readonly now: () => Date;
  private readonly timer: Timer;
  private readonly wakeLog: WakeLog;
  private readonly log: (message: string) => void;
  private readonly askMs: number;
  private readonly answers: AnswersStep | null;
  private cancel: (() => void) | null = null;
  private nextAt: Date | null = null;
  /** The lease: true while a wake runs. Set before the wake's first await, so two can never both run. */
  private ticking = false;
  private stopped = false;
  /** The newest wake this process ran, so a log that could not be written never makes the next one due at once. */
  private lastWoke: number | null = null;
  /** Bumped by each reschedule; one overtaken while it reads arms nothing. */
  private generation = 0;
  /** A scheduled wake found no client: the first client to arrive runs another. */
  private missedClient = false;
  /**
   * A client arrived while a wake was running. That wake may have read the
   * client before it arrived and not yet recorded the miss, so it settles this
   * when it ends: another wake if it missed, nothing if not.
   */
  private arrivedMidWake: { promise: Promise<void>; resolve: () => void } | null = null;

  constructor(options: LoopOptions) {
    this.engine = options.engine;
    this.client = options.client;
    this.now = options.now ?? (() => new Date());
    this.timer = options.timer ?? realTimer;
    this.log = options.log ?? ((message) => console.log(`[maestro] ${message}`));
    this.wakeLog = options.wakeLog ?? new WakeLog(undefined, this.log);
    this.askMs = options.askMs ?? ASK_MS;
    this.answers = options.answers ?? null;
  }

  /** The loop now: its period (null: off), the next wake, whether one is running, the newest wakes first. */
  async get(): Promise<{ minutes: number | null; nextAt: string | null; ticking: boolean; recent: WakeEntry[] }> {
    const [settings, recent] = await Promise.all([this.engine.settings(), this.wakeLog.recent(RECENT)]);
    const minutes = settings.loopMinutes;
    return {
      minutes,
      nextAt: minutes !== null && this.nextAt ? this.nextAt.toISOString() : null,
      ticking: this.ticking,
      recent,
    };
  }

  /**
   * Arm the next wake from Settings and the log: a period after the last
   * wake that ran, or now if that is past; a period from now when the log
   * has none. Off disarms. Called at start, after every wake, and whenever
   * Settings are saved. Never throws.
   */
  async reschedule(): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    let period: number | null;
    try {
      period = (await this.engine.settings()).loopMinutes;
    } catch (error) {
      this.log(`the loop could not read Settings, so its schedule is unchanged: ${(error as Error).message}`);
      return;
    }
    const last = period === null ? null : await this.lastWokeAt();
    if (generation !== this.generation || this.stopped) return;
    this.disarm();
    if (period === null) return;
    const now = this.now().getTime();
    const due = last === null ? now + period * 60_000 : Math.max(now, last + period * 60_000);
    this.arm(new Date(due));
  }

  /** The plugin is shutting down: no further wake is armed. A wake already running finishes. */
  stop(): void {
    this.stopped = true;
    this.generation += 1;
    this.disarm();
  }

  /**
   * The plugin has its first Paseo client. A scheduled wake that had none
   * started nothing: run one now. While a wake runs, the answer waits for it
   * to end, since it may yet record that it found no client; the promise
   * settles once the follow-up wake, if any, has run.
   */
  connected(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.ticking) {
      if (!this.arrivedMidWake) {
        let resolve: () => void = () => undefined;
        const promise = new Promise<void>((done) => {
          resolve = done;
        });
        this.arrivedMidWake = { promise, resolve };
      }
      return this.arrivedMidWake.promise;
    }
    if (!this.missedClient) return Promise.resolve();
    this.missedClient = false;
    return this.onTimer(null);
  }

  /**
   * Wake now. Returns this wake's entry, or, when another wake is running,
   * an entry recorded as skipped. Never throws for what it finds: a failure to
   * read the work or to start one is in the entry.
   */
  async wake(cause: Cause): Promise<WakeEntry> {
    if (this.ticking) {
      const skipped: WakeEntry = {
        ...this.blank(cause),
        skipped: ALREADY_WAKING,
        narrative: [],
      };
      skipped.narrative = narrate(skipped, []);
      await this.record(skipped);
      return skipped;
    }
    this.ticking = true;
    try {
      const entry = await this.tick(cause);
      this.lastWoke = Date.parse(entry.wokeAt);
      await this.record(entry);
      return entry;
    } finally {
      this.ticking = false;
      await this.reschedule();
      const arrived = this.arrivedMidWake;
      this.arrivedMidWake = null;
      // Not awaited: the wake that ran answers now; the follow-up settles the client's own promise.
      if (arrived) void this.connected().then(arrived.resolve, arrived.resolve);
    }
  }

  private blank(cause: Cause): WakeEntry {
    return {
      tickId: randomUUID(),
      cause,
      wokeAt: this.now().toISOString(),
      dispatched: [],
      deferred: [],
      needsYou: { gate: 0, stuck: 0, asking: 0 },
      quiet: [],
      unasked: [],
      flagged: [],
      cleared: [],
      narrative: [],
    };
  }

  private async tick(cause: Cause): Promise<WakeEntry> {
    const entry = this.blank(cause);
    const notes: string[] = [];
    const paseo = this.client();
    let items: WorkItem[] = [];
    try {
      items = (await this.engine.list(paseo ?? undefined)).items;
    } catch (error) {
      notes.push(`Could not read the work: ${(error as Error).message}`);
      entry.narrative = narrate(entry, notes);
      return entry;
    }
    const now = Date.parse(entry.wokeAt);
    const raise: Raise[] = [];
    const clear: Clear[] = [];
    const silent: Silent[] = [];
    for (const item of items) {
      if (item.state === "review") {
        if (item.phase === "asking") entry.needsYou.asking += 1;
        else entry.needsYou.gate += 1;
      } else if (item.state === "blocked") {
        entry.needsYou.stuck += 1;
      } else if (item.state === "running") {
        // lastEventAt skips the loop's own flags and clears (server/wire.ts), so neither resets this clock.
        // A run flagged quiet is here too: its flag stands only while no other event follows it.
        const last = Date.parse(item.lastEventAt ?? item.updatedAt);
        if (now - last >= QUIET_MS) silent.push({ item, last });
      }
    }
    await this.askQuiet(paseo, silent, now, entry, raise, clear);
    if (!paseo) {
      this.missedClient = cause === "timer";
      notes.push(NOT_CONNECTED);
    } else {
      this.missedClient = false;
      await this.startQueued(paseo, items, entry, raise);
    }
    await this.landAndRoute(entry);
    await this.raiseFlags(raise, entry);
    await this.clearFlags(clear, entry);
    entry.narrative = narrate(entry, notes);
    return entry;
  }

  /**
   * Of the running work quiet by Maestro's events, name and flag the runs
   * whose sessions have done nothing for as long. Maestro hears only turn
   * boundaries, so a long turn still at work has no event for a while: its
   * session's own activity (sessionActiveAt) says it is not quiet. Quiet
   * counts from the later of the two. A session that cannot be asked is not
   * flagged, and the entry says why. A run flagged quiet whose session has
   * worked within QUIET_MS goes on `clear`; one whose session cannot be asked
   * keeps its flag.
   */
  private async askQuiet(
    paseo: Paseo | null,
    silent: readonly Silent[],
    now: number,
    entry: WakeEntry,
    raise: Raise[],
    clear: Clear[],
  ): Promise<void> {
    const asked = await Promise.all(
      silent.map(async (run) => ({ ...run, session: await this.askSession(paseo, run.item) })),
    );
    for (const { item, last, session } of asked) {
      if ("error" in session) {
        entry.unasked.push({ ...named(item), reason: session.error });
        continue;
      }
      if (item.flag?.kind === "quiet" && now - session.at < QUIET_MS) {
        clear.push({ item, activeAt: session.at });
        continue;
      }
      const since = Math.max(last, session.at);
      const quiet = now - since;
      if (quiet < QUIET_MS) continue;
      entry.quiet.push({ ...named(item), minutes: Math.floor(quiet / 60_000) });
      raise.push({ item, kind: "quiet", reason: quietReason(quiet), since: new Date(since).toISOString() });
    }
  }

  /** When the run's session last did anything, as the daemon says, or why it could not be asked. */
  private async askSession(paseo: Paseo | null, item: WorkItem): Promise<{ at: number } | { error: string }> {
    if (!paseo) return { error: ASK_NOT_CONNECTED };
    const agentId = item.worker?.agentId;
    if (!agentId) return { error: "no session is recorded for the run" };
    try {
      const snapshot = await within(() => paseo.agents.ref(agentId).refresh(), this.askMs);
      if (!snapshot) return { error: "Paseo has no record of the session" };
      const at = sessionActiveAt(snapshot.agent);
      return at === null ? { error: "the session did not say when it last worked" } : { at };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Step 5: the answers batch, then the answers due. Each half says what it
   * could not do in what it returns, so neither keeps the wake from the rest.
   */
  private async landAndRoute(entry: WakeEntry): Promise<void> {
    if (!this.answers) return;
    const landing = await this.answers.land().catch((error) => {
      this.log(`the loop could not land the answers: ${(error as Error).message}`);
      return null;
    });
    const outcomes = await this.answers.route().catch((error) => {
      this.log(`the loop could not route the answers: ${(error as Error).message}`);
      return [] as RouteOutcome[];
    });
    entry.answers = {
      landing,
      routed: outcomes.flatMap((outcome) =>
        outcome.status === "routed" && outcome.route
          ? [{ ledger: outcome.ledger, id: outcome.id, route: outcome.route, words: outcome.words }]
          : [],
      ),
      waiting: outcomes.filter((outcome) => outcome.status !== "routed").length,
    };
  }

  /** Write the flags this wake raised; the engine writes each only when the work's current flag is another kind. */
  private async raiseFlags(raise: readonly Raise[], entry: WakeEntry): Promise<void> {
    for (const { item, kind, reason, since } of raise) {
      try {
        if (await this.engine.flag(item, kind, reason, since)) entry.flagged.push({ ...named(item), kind, reason });
      } catch (error) {
        this.log(`the loop could not flag ${item.id}: ${(error as Error).message}`);
      }
    }
  }

  /** Take down the quiet flags whose sessions worked again; the engine writes each only while it still stands. */
  private async clearFlags(clear: readonly Clear[], entry: WakeEntry): Promise<void> {
    for (const { item, activeAt } of clear) {
      try {
        if (await this.engine.clearQuiet(item, activeAt)) entry.cleared.push(named(item));
      } catch (error) {
        this.log(`the loop could not clear the flag on ${item.id}: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Walk the queue in order: leave alone what is yours to start, start the
   * rest until dispatch says the cap is reached, then defer the rest "at the
   * run cap". What is yours keeps its own reason after the cap too: the loop
   * never starts it, so the cap is not why it waits. The same holds for work
   * it could not start before, while that flag stands. What it leaves to you
   * and what fails to start go on `raise`.
   */
  private async startQueued(paseo: Paseo, items: readonly WorkItem[], entry: WakeEntry, raise: Raise[]): Promise<void> {
    const queue = items.filter((item) => isDispatchable(item.state)).sort(queueOrder);
    let capped = false;
    for (const item of queue) {
      const left = item.nextRun ? leftToYou(item.nextRun) : null;
      if (left) {
        entry.deferred.push({ ...named(item), reason: left });
        raise.push({ item, kind: "yours", reason: yoursReason(left) });
        continue;
      }
      // Tried before and flagged for you: not tried again until something happens to the work.
      if (item.flag?.kind === "failed") {
        entry.deferred.push({ ...named(item), reason: FAILED_BEFORE });
        continue;
      }
      if (capped) {
        entry.deferred.push({ ...named(item), reason: AT_RUN_CAP });
        continue;
      }
      try {
        await this.engine.dispatch(paseo, item.id, LOOP);
        entry.dispatched.push(named(item));
      } catch (error) {
        if (error instanceof AtCapacity) {
          capped = true;
          entry.deferred.push({ ...named(item), reason: AT_RUN_CAP });
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (!(error instanceof UserError)) this.log(`the loop could not start ${item.id}: ${message}`);
        // Dispatch's own "Could not start the run:" is not said twice: "could not start: <why>".
        entry.deferred.push({ ...named(item), reason: `could not start: ${startError(message)}` });
        raise.push({ item, kind: "failed", reason: failedReason(message) });
      }
    }
  }

  private async record(entry: WakeEntry): Promise<void> {
    await this.wakeLog.append(entry).catch((error) => {
      this.log(`the loop could not write its wake log: ${(error as Error).message}`);
    });
  }

  /** When the last wake that ran woke: the log's newest, or this process's own if that is later. */
  private async lastWokeAt(): Promise<number | null> {
    const logged = await this.wakeLog.lastRun().then(
      (entry) => (entry ? Date.parse(entry.wokeAt) : null),
      (error) => {
        this.log(`the loop could not read its wake log: ${(error as Error).message}`);
        return null;
      },
    );
    const times = [logged, this.lastWoke].filter((at): at is number => at !== null && Number.isFinite(at));
    return times.length > 0 ? Math.max(...times) : null;
  }

  private arm(at: Date): void {
    this.nextAt = at;
    const delay = Math.min(MAX_DELAY_MS, Math.max(0, at.getTime() - this.now().getTime()));
    const cancel = this.timer(() => {
      if (this.cancel !== cancel) return Promise.resolve();
      this.cancel = null;
      return this.onTimer(at);
    }, delay);
    this.cancel = cancel;
  }

  private disarm(): void {
    this.cancel?.();
    this.cancel = null;
    this.nextAt = null;
  }

  /** A scheduled wake came due (`at`), or a client arrived after one that had none (null). */
  private async onTimer(at: Date | null): Promise<void> {
    if (this.stopped) return;
    const on = await this.engine.settings().then(
      (settings) => settings.loopMinutes !== null,
      () => false,
    );
    // Turned off since it was armed, or fired before its time (a delay longer than a timer holds): arm again.
    if (!on || (at && this.now().getTime() < at.getTime())) {
      await this.reschedule();
      return;
    }
    await this.wake("timer").catch((error) => this.log(`the loop's wake failed: ${(error as Error).message}`));
  }
}

function named(item: WorkItem): Named {
  return { id: item.id, title: item.title };
}
