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
//      (leftToYou), which keeps its own reason after the cap as before it;
//   4. counts what needs you, and names running work quiet for 30 minutes;
//   5. writes one wake-log entry (server/wake-log.ts) that says all of it.
// It never stops, sends back or decides anything: those stay yours.
//
// Off unless Settings give it a period (loopMinutes). The next wake is due a
// period after the last one the log records, so a restart keeps the cadence.
// One wake runs at a time; one asked for meanwhile is recorded as skipped,
// never queued. With no Paseo client yet (the plugin gets one with its first
// handler or hook), a wake records that it could not start work, and the
// first client to arrive runs another, after that wake ends when it arrives
// while the wake is still running.

import { randomUUID } from "node:crypto";
import type { WakeEntry, WorkItem } from "../shared/contracts";
import { isDispatchable } from "../shared/states";
import { AtCapacity, type Engine, leftToYou, realTimer, type Timer, UserError } from "./engine";
import { LOOP } from "./events";
import type { Paseo } from "./runs";
import { WakeLog } from "./wake-log";

/** Running work with no event for this long is named in the wake log as worth a look. */
export const QUIET_MS = 30 * 60_000;

/** Why queued work was left: dispatch refused it at the run cap, so the rest of the queue waits too. */
export const AT_RUN_CAP = "at the run cap";

/** Why a wake started nothing: the plugin has no Paseo client yet. */
export const NOT_CONNECTED =
  "Could not start work: Paseo has not connected to Maestro yet. It connects with the first agent event, or when you open Maestro.";

/** Why a wake was skipped. */
export const ALREADY_WAKING = "another check was already running";

/** How many entries loop.get returns. */
export const RECENT = 20;

/** The longest delay a timer holds (setTimeout's limit); a later wake is armed again when it fires. */
const MAX_DELAY_MS = 2 ** 31 - 1;

type Cause = WakeEntry["cause"];
type Named = { id: string; title: string };

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
}

const minutes = (count: number) => (count === 1 ? "1 minute" : `${count} minutes`);

/** A reason as the end of a sentence: a full stop unless it already ends in one. */
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

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
    ...entry.quiet.map((run) => `${run.title} has been quiet ${minutes(run.minutes)}, worth a look.`),
  ];
  if (needs.length > 0) lines.push("Needs you:", ...needs.map((line) => `  ${line}`));
  if (entry.dispatched.length > 0) {
    lines.push("Did:", ...entry.dispatched.map((work) => `  Started ${work.title}.`));
  } else {
    lines.push("Did nothing new this tick.");
  }
  if (entry.deferred.length > 0) {
    lines.push("Left alone:", ...entry.deferred.map((work) => `  ${work.title}: ${sentence(work.reason)}`));
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
    for (const item of items) {
      if (item.state === "review") {
        if (item.phase === "asking") entry.needsYou.asking += 1;
        else entry.needsYou.gate += 1;
      } else if (item.state === "blocked") {
        entry.needsYou.stuck += 1;
      } else if (item.state === "running") {
        const silent = now - Date.parse(item.lastEventAt ?? item.updatedAt);
        if (silent >= QUIET_MS) entry.quiet.push({ ...named(item), minutes: Math.floor(silent / 60_000) });
      }
    }
    if (!paseo) {
      this.missedClient = cause === "timer";
      notes.push(NOT_CONNECTED);
    } else {
      this.missedClient = false;
      await this.startQueued(paseo, items, entry);
    }
    entry.narrative = narrate(entry, notes);
    return entry;
  }

  /**
   * Walk the queue in order: leave alone what is yours to start, start the
   * rest until dispatch says the cap is reached, then defer the rest "at the
   * run cap". What is yours keeps its own reason after the cap too: the loop
   * never starts it, so the cap is not why it waits.
   */
  private async startQueued(paseo: Paseo, items: readonly WorkItem[], entry: WakeEntry): Promise<void> {
    const queue = items.filter((item) => isDispatchable(item.state)).sort(queueOrder);
    let capped = false;
    for (const item of queue) {
      const left = item.nextRun ? leftToYou(item.nextRun) : null;
      if (left) {
        entry.deferred.push({ ...named(item), reason: left });
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
        entry.deferred.push({ ...named(item), reason: `could not start: ${message}` });
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
