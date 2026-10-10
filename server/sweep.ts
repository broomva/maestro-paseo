// The plugin sweep (BRO-2995): the one place outside a hook or a verb where
// Maestro writes on its own. Reads are queries: work.list, work.attention,
// loops.get and every view they reach write nothing, send nothing, create or
// archive no session, however often they are polled. What a read used to do
// on the side is done here instead, on the sweep's own cadence:
//   - the work kept true to Paseo (Engine.upkeep): a turn end missed while the
//     plugin was down recovered, a session gone moving its run to stuck, a
//     permission answered elsewhere, a branch that merged; and the decisions
//     at your gate whose undo window closed applied;
//   - the loops' drift recorded (Loops.sweep), their ledgers fetched first;
//   - the control repo's origin/main fetched for the asks (WorkspaceAsks.fetchDue);
//   - the ledger locks this process left behind cleared (Fleet.sweepLocks).
// So a poll's rate is irrelevant to what happens.
//
// Always on while the plugin runs, every SWEEP_MS, whether or not anyone
// looks, and apart from the loop's period in Settings: the loop's wake runs a
// sweep first (server/loop.ts), so what it reads is current. One sweep runs
// at a time (the lease): a sweep asked for while another runs is the next
// one, started once that one ends and shared by everyone who asked meanwhile,
// so it reads what came since (a client that just arrived, say). A step in
// the background (a fetch, the loops' whole view) is started by the sweep and
// not waited for, so a slow network or launchd read never holds up the work;
// it runs one at a time, and a sweep that finds it still running leaves it.
// A step that fails is logged and never keeps the others from running. It
// starts nothing (A8): no step dispatches.

import { realTimer, type Timer } from "./engine";
import type { Paseo } from "./runs";

/** How often the sweep runs on its own. */
export const SWEEP_MS = 30_000;

/** One of the sweep's steps, by name for the log. It may throw: the sweep says so and goes on. */
export interface SweepStep {
  name: string;
  run(paseo: Paseo | null): Promise<unknown>;
  /** Started and not waited for; never two at once. */
  background?: boolean;
}

/**
 * What one sweep did with each step: ran it (`done`, or `failed` and why),
 * or, in the background, `started` it, or left it `running` from before.
 */
export interface SweepRun {
  at: string;
  connected: boolean;
  steps: Array<{ name: string; outcome: "done" | "failed" | "started" | "running"; error: string | null }>;
}

export interface SweepOptions {
  steps: readonly SweepStep[];
  /** The daemon client once the plugin has one. */
  client: () => Paseo | null;
  /** The cadence; SWEEP_MS unless a test or the environment says otherwise. */
  everyMs?: number;
  timer?: Timer;
  now?: () => Date;
  log?: (message: string) => void;
  /** After each sweep, not awaited: the loop's catch-up for a wake that had no client (Loop.connected). */
  after?: (run: SweepRun) => void;
}

/** The cadence from MAESTRO_PASEO_SWEEP_SECONDS (a dogfood's or a test's), else SWEEP_MS. */
export function sweepEvery(env: NodeJS.ProcessEnv = process.env): number {
  const seconds = Number(env.MAESTRO_PASEO_SWEEP_SECONDS);
  return Number.isFinite(seconds) && seconds >= 1 ? Math.round(seconds * 1000) : SWEEP_MS;
}

/**
 * How often the sweep may fetch origin/main (the asks', the loops ledger's), from
 * MAESTRO_PASEO_FETCH_SECONDS (0: every sweep, for a test that must see any fetch
 * a read makes); undefined keeps each fetcher's own 5 minutes.
 */
export function fetchEvery(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.MAESTRO_PASEO_FETCH_SECONDS?.trim();
  const seconds = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}

export class Sweep {
  private readonly steps: readonly SweepStep[];
  private readonly client: () => Paseo | null;
  private readonly everyMs: number;
  private readonly timer: Timer;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private readonly after: SweepOptions["after"];
  /** The lease: the sweep running now. */
  private running: Promise<SweepRun> | null = null;
  /** The sweep after it, once: every sweep asked for while one runs. */
  private next: Promise<SweepRun> | null = null;
  /** The background steps running now, by name. */
  private readonly flying = new Map<string, Promise<void>>();
  private cancel: (() => void) | null = null;
  private started = false;
  private stopped = false;

  constructor(options: SweepOptions) {
    this.steps = options.steps;
    this.client = options.client;
    this.everyMs = options.everyMs ?? SWEEP_MS;
    this.timer = options.timer ?? realTimer;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((message) => console.log(`[maestro] ${message}`));
    this.after = options.after;
  }

  /** Sweep now, then every `everyMs` after each sweep ends, until stop(). */
  start(): void {
    if (this.stopped || this.started) return;
    this.started = true;
    void this.cycle();
  }

  /** The plugin is shutting down: no further sweep is armed. One already running finishes. */
  stop(): void {
    this.stopped = true;
    this.cancel?.();
    this.cancel = null;
  }

  /** Sweep now, under the lease: while one runs, the one after it. Never throws. */
  run(): Promise<SweepRun> {
    const running = this.running;
    if (running) {
      this.next ??= running.then(() => {
        this.next = null;
        return this.run();
      });
      return this.next;
    }
    const started = this.sweep().finally(() => {
      if (this.running === started) this.running = null;
    });
    this.running = started;
    return started;
  }

  /** One sweep, then the next armed `everyMs` after it ends. */
  private async cycle(): Promise<void> {
    await this.run();
    if (this.stopped) return;
    const cancel = this.timer(() => {
      if (this.cancel !== cancel) return Promise.resolve();
      this.cancel = null;
      return this.cycle();
    }, this.everyMs);
    this.cancel = cancel;
  }

  private async sweep(): Promise<SweepRun> {
    // The client as it is now: one may have arrived since the last sweep.
    const paseo = this.client();
    const run: SweepRun = { at: this.now().toISOString(), connected: Boolean(paseo), steps: [] };
    for (const step of this.steps) {
      if (step.background) {
        if (this.flying.has(step.name)) {
          run.steps.push({ name: step.name, outcome: "running", error: null });
          continue;
        }
        const flying = this.attempt(step, paseo).then(() => {
          this.flying.delete(step.name);
        });
        this.flying.set(step.name, flying);
        run.steps.push({ name: step.name, outcome: "started", error: null });
        continue;
      }
      const error = await this.attempt(step, paseo);
      run.steps.push({ name: step.name, outcome: error === null ? "done" : "failed", error });
    }
    if (this.after) {
      try {
        this.after(run);
      } catch (error) {
        this.log(`sweep: after a sweep: ${(error as Error).message}`);
      }
    }
    return run;
  }

  /** For a test: waits for the background steps running now. */
  async settled(): Promise<void> {
    await Promise.all(this.flying.values());
  }

  /** Runs one step: why it failed, said in the log, or null. */
  private async attempt(step: SweepStep, paseo: Paseo | null): Promise<string | null> {
    try {
      await step.run(paseo);
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`sweep: ${step.name} failed: ${message}`);
      return message;
    }
  }
}
