// The Timeline view's read: every scheduled thing on one axis, the past day
// and the next (shared/timeline.ts). Four kinds of source:
// - Paseo's schedules and heartbeats, from the daemon's own schedule files
//   (`<paseo home>/schedules/*.json`): the plugin API has no schedule verb,
//   and the plugin runs on the daemon's host as the same user;
// - the broomva launchd jobs (server/launchd.ts);
// - Maestro's loop, its state and its wake log (server/loop.ts);
// - fleet-reconcile's ticks, through the Fleet view's own read
//   (server/fleet.ts), so the fleet's files have one reader. Its launchd
//   job is shown there, as the scope, not twice.
// Read-only. The launchd read costs seconds, so it is kept: a minute for the
// view, five for the header count, which never waits on it.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WakeEntry } from "../shared/contracts";
import type { FleetDetail, FleetView } from "../shared/fleet";
import { TIMELINE_WINDOW_MS, type TimelineNotice, type TimelineSource, type TimelineView } from "../shared/timeline";
import type { AwakeFor } from "./fleet-model";
import type { LaunchdRead } from "./launchd";
import {
  fleetLabel,
  fleetSource,
  type LoopNow,
  launchdSource,
  loopSource,
  StoredScheduleSchema,
  scheduleSource,
  tailOf,
  timelineNotices,
  type Window,
} from "./timeline-model";

/** The view reads launchd again once its last read is this old. */
export const LAUNCHD_VIEW_MS = 60_000;
/** The header count's notices read launchd again once its last read is this old. */
export const LAUNCHD_NOTICE_MS = 5 * 60_000;
/** A view computed this recently is served as it is: several clients polling read once. */
export const VIEW_MS = 10_000;
/** The header count waits this long for a read before it answers with the last one. */
export const NOTICE_WAIT_MS = 2_000;
/** Fleet ticks read per scope: two days of hourly ticks. */
const FLEET_TICKS = 50;

export interface TimelineOptions {
  /** The launchd reader; null on a host without launchd. */
  launchd: { read(): Promise<LaunchdRead> } | null;
  /** The label prefix the launchd reader keeps, which the timeline drops from names. */
  launchdPrefix?: string;
  schedulesDir: string;
  loop: () => Promise<LoopNow>;
  /** The wake log's entries, any order. */
  wakes: () => Promise<readonly WakeEntry[]>;
  wakeLogPath?: string | null;
  /** The Fleet view's read; null when there is none. */
  fleet: { get(scope?: string, ticks?: number): Promise<FleetView> } | null;
  /**
   * Awake time: the plugin's one clock, shared with the Fleet view
   * (server/fleet.ts AwakeClock). Required: wall time would count every
   * night's sleep as time the jobs could have run.
   */
  clock: { read(): AwakeFor };
  now?: () => number;
  log?: (message: string) => void;
}

const order: Record<TimelineSource["kind"], number> = { fleet: 0, launchd: 1, schedule: 2, heartbeat: 3, loop: 4 };

export class Timeline {
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private launchd: { at: number; read: LaunchdRead } | null = null;
  /** The last view, when it was computed, and when the launchd read it was built on was taken (null: none). */
  private computed: { at: number; view: TimelineView; launchdAt: number | null } | null = null;
  /** The compute in flight, and the launchd age it accepts: a caller wanting fresher waits for its own. */
  private computing: { maxAgeMs: number; view: Promise<TimelineView> } | null = null;
  /** The warning last logged, so a poll does not repeat it. */
  private logged = "";

  constructor(private readonly options: TimelineOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.log(`[maestro] ${message}`));
  }

  /** The view now, launchd read within the last minute. */
  get(): Promise<TimelineView> {
    return this.view(LAUNCHD_VIEW_MS);
  }

  /**
   * What needs you on its own (work.attention): the failed and missed
   * sources, never a fleet scope. It waits NOTICE_WAIT_MS at most for a
   * read, then answers with the last view (none: nothing yet), so the
   * header count is never held up by launchd.
   */
  async notices(): Promise<TimelineNotice[]> {
    const reading = this.view(LAUNCHD_NOTICE_MS).catch(() => null);
    const timeout = new Promise<null>((done) => {
      setTimeout(() => done(null), NOTICE_WAIT_MS).unref?.();
    });
    const waited = await Promise.race([reading, timeout]);
    const view = waited ?? this.computed?.view ?? null;
    return view ? timelineNotices(view.sources) : [];
  }

  /** The end of a launchd job's log (timeline.log), from the latest read; a source with no log has none. */
  async logOf(id: string): Promise<{ path: string | null; tail: string | null }> {
    if (!this.launchd) await this.readLaunchd(LAUNCHD_VIEW_MS, []);
    const job = this.launchd?.read.jobs.find((one) => `launchd:${one.label}` === id);
    return { path: job?.logPath ?? null, tail: tailOf(job?.logText ?? null) };
  }

  private view(launchdMaxAgeMs: number): Promise<TimelineView> {
    const now = this.now();
    const last = this.computed;
    // Fresh enough means the read this view was built on, not a newer one taken since.
    const launchdFresh = !this.options.launchd || (last?.launchdAt != null && now - last.launchdAt < launchdMaxAgeMs);
    if (last && now - last.at < VIEW_MS && launchdFresh) return Promise.resolve(last.view);
    const running = this.computing;
    // One in flight that accepts launchd at least as fresh as this caller wants answers it too.
    if (running && running.maxAgeMs <= launchdMaxAgeMs) return running.view;
    // Else this caller's compute runs after it, so two never read at once and neither answers the other's freshness.
    const view = (running?.view.catch(() => undefined) ?? Promise.resolve())
      .then(() => this.compute(launchdMaxAgeMs))
      .finally(() => {
        if (this.computing?.view === view) this.computing = null;
      });
    this.computing = { maxAgeMs: launchdMaxAgeMs, view };
    return view;
  }

  /** The latest launchd read, read again once older than `maxAgeMs`; a read that fails keeps the last, said in `warnings`. */
  private async readLaunchd(maxAgeMs: number, warnings: string[]): Promise<LaunchdRead | null> {
    const reader = this.options.launchd;
    if (!reader) return null;
    if (!this.launchd || this.now() - this.launchd.at >= maxAgeMs) {
      try {
        this.launchd = { at: this.now(), read: await reader.read() };
      } catch (error) {
        warnings.push(`launchd could not be read: ${(error as Error).message}`);
      }
    }
    return this.launchd?.read ?? null;
  }

  private async compute(launchdMaxAgeMs: number): Promise<TimelineView> {
    const warnings: string[] = [];
    const launchd = await this.readLaunchd(launchdMaxAgeMs, warnings);
    const launchdAt = this.launchd?.at ?? null;
    const now = this.now();
    const window: Window = { now, from: now - TIMELINE_WINDOW_MS, to: now + TIMELINE_WINDOW_MS };
    const awake = this.options.clock.read();
    const [schedules, loop, fleet] = await Promise.all([
      this.schedules(window, awake, warnings),
      this.loop(window, awake, warnings),
      this.fleet(window, warnings),
    ]);
    const fleetScopes = new Set(fleet.map((source) => source.id.slice("fleet:".length)));
    const prefix = this.options.launchdPrefix ?? "com.broomva.";
    // A miss is judged only inside what the unified log is proven to have held (server/launchd.ts).
    const seen = launchd?.seen ? { from: launchd.seen.from, to: Math.min(launchd.seen.to, now) } : null;
    if (launchd && now - launchd.readAt > 2 * LAUNCHD_NOTICE_MS) {
      warnings.push(
        "launchd has not been read for a while; its rows show the last read, and nothing since is called missed.",
      );
    }
    const jobs = (launchd?.jobs ?? [])
      // A fleet scope's tick job is the scope: its ticks are richer than launchd's run ends.
      .filter((job) => ![...fleetScopes].some((scope) => job.label === fleetLabel(scope)))
      .map((job) =>
        launchdSource(
          job,
          {
            exits: (launchd?.exits ?? []).filter((exit) => exit.label === job.label),
            seen,
            awake,
            prefix,
          },
          window,
        ),
      );
    warnings.push(...(launchd?.warnings ?? []));
    const sources = [...fleet, ...jobs, ...schedules, ...(loop ? [loop] : [])].sort(
      (a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name),
    );
    const said = warnings.join("\n");
    if (said && said !== this.logged) this.log(`timeline: ${warnings.join("; ")}`);
    this.logged = said;
    const view: TimelineView = {
      now: new Date(now).toISOString(),
      from: new Date(window.from).toISOString(),
      to: new Date(window.to).toISOString(),
      sources,
      warnings,
    };
    this.computed = { at: this.now(), view, launchdAt };
    return view;
  }

  private async schedules(window: Window, awake: AwakeFor, warnings: string[]): Promise<TimelineSource[]> {
    const dir = this.options.schedulesDir;
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        warnings.push(`Paseo's schedules could not be read: ${(error as Error).message}`);
      }
      return [];
    }
    const sources: TimelineSource[] = [];
    for (const name of names) {
      const path = join(dir, name);
      let value: unknown;
      try {
        value = JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        // The daemon rewrites these files; one caught mid-write reads next time.
        warnings.push(`Paseo schedule ${name} could not be read: ${(error as Error).message}`);
        continue;
      }
      const parsed = StoredScheduleSchema.safeParse(value);
      if (!parsed.success) {
        warnings.push(`Paseo schedule ${name} is in a shape the timeline does not read.`);
        continue;
      }
      const source = scheduleSource(parsed.data, window, path, awake);
      if (source) sources.push(source);
    }
    return sources;
  }

  private async loop(window: Window, awake: AwakeFor, warnings: string[]): Promise<TimelineSource | null> {
    try {
      const [state, wakes] = await Promise.all([this.options.loop(), this.options.wakes()]);
      return loopSource(state, wakes, window, awake, this.options.wakeLogPath ?? null);
    } catch (error) {
      warnings.push(`Maestro's loop could not be read: ${(error as Error).message}`);
      return null;
    }
  }

  private async fleet(window: Window, warnings: string[]): Promise<TimelineSource[]> {
    const reader = this.options.fleet;
    if (!reader) return [];
    try {
      const first = await reader.get(undefined, FLEET_TICKS);
      if (first.error) warnings.push(first.error);
      const details = new Map<string, FleetDetail>();
      if (first.detail) details.set(first.detail.id, first.detail);
      for (const scope of first.scopes) {
        if (details.has(scope.id)) continue;
        const read = await reader.get(scope.id, FLEET_TICKS);
        if (read.detail) details.set(read.detail.id, read.detail);
      }
      return first.scopes.map((scope) => fleetSource(scope, details.get(scope.id) ?? null, window));
    } catch (error) {
      warnings.push(`The fleet could not be read: ${(error as Error).message}`);
      return [];
    }
  }
}
