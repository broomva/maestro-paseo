// fleet-reconcile's hourly runs, read from the files the fleet writes: its
// config (~/.config/ctx/fleet.json), and per scope its ledger, its tick
// reports (ticks/NNNNN/report.{json,md}) and its LaunchAgent. Read-only, with
// one exception: your verdicts on the dry run's proposals, appended to
// `proposal-reviews.jsonl` beside the scope's ledger. The fleet has no verb
// that records a review, so Maestro defines this one file for the fleet to
// read (BRO-2766). Nothing here runs a fleet verb, writes the fleet's ledger,
// or changes its mode, dry run or kill switch.
//
// A file in a state dir (which the fleet's sessions can write) is opened
// without following a symlink as its last name, and must be a regular file
// with no other hard link: a link planted there can neither show another file
// on your phone nor carry your verdict into one. A FIFO is not waited on. The
// config and the LaunchAgent are yours, and are read as they are linked.
//
// A missed tick, and a tick that died, are measured in time the Mac was awake
// (AwakeClock): launchd counts StartInterval in it, so a tick comes about an
// hour of awake time after the last, however the sleeps fall (spec §5.7).

import { constants } from "node:fs";
import { type FileHandle, open, readdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { WorkItem } from "../shared/contracts";
import {
  FLEET_REPORT_BYTES,
  FLEET_TICKS,
  type FleetDetail,
  type FleetHealth,
  type FleetNotice,
  type FleetProposal,
  type FleetScope,
  type FleetTick,
  type FleetView,
  groupProposals,
  type ReviewVerdict,
} from "../shared/fleet";
import { UserError } from "./engine";
import {
  type AwakeFor,
  actProposals,
  asksOf,
  awakeAsWall,
  coverOf,
  fleetItem,
  foldLedger,
  foldReviews,
  healthOf,
  type LedgerFold,
  openAlerts,
  parseJsonLines,
  type ReportSummary,
  reviewRecord,
  SCOPE_ID,
  summarizeReport,
  tickRows,
  withReviews,
} from "./fleet-model";
import { expandHome, fleetPaths } from "./paths";

export const REVIEWS_FILE = "proposal-reviews.jsonl";
/** tick.sh leaves this in the state dir while the kill switch is off. */
export const DISABLED_NOTICE = ".disabled-notice";
/** install.sh's LaunchAgent for a scope. */
export const plistName = (scope: string) => `com.broomva.fleet-reconcile.${scope}.plist`;

/** A tick past its config budget by this much, with no exit recorded, died. */
const BUDGET_GRACE_MS = 5 * 60_000;
/** tick.sh's budget when the config gives none, or one that is not a whole number of minutes above 0. */
const DEFAULT_TICK_MINUTES = 15;
/** The ledger, a report or the review file is read up to this size; past it the read is refused, not cut. */
const READ_LIMIT = 32 * 1024 * 1024;
/** Ticks whose coordinator verbs still stand as proposals. */
const ACT_TICKS = 24;

/** The clock beats this often, and keeps a record at most this often. */
const BEAT_MS = 60_000;
/** A beat this late means the process was suspended: the Mac slept for all but a beat of it. */
const LATE_MS = 3 * BEAT_MS;
const SAMPLES_KEPT_MS = 8 * 24 * 60 * 60 * 1000;

/**
 * Time the Mac was awake between two wall-clock times, as launchd counts its
 * interval. No clock the plugin can read stops in sleep: Node's monotonic
 * clock (performance.now, hrtime) counts it on macOS, measured against
 * kern.boottime. So the clock beats once a minute on a timer that does not
 * keep the daemon alive. The daemon is suspended while the Mac sleeps, so a
 * beat that comes more than three minutes late counts one beat as awake and
 * the rest as asleep. A beat that comes on time counts all of it.
 *
 * It records (wall, awake) at each beat and each read. The awake time since a
 * wall time is read off the records around it. Before the first record (a
 * tick from before the plugin started) it counts from that record, as a lower
 * bound, and says so (`whole: false`). A reload therefore never raises a
 * false alarm, and a stall is flagged once 2 h awake have passed since. An
 * event loop held for minutes reads as sleep and counts less awake time,
 * never more.
 */
export class AwakeClock {
  private readonly samples: { wall: number; awake: number }[] = [];
  private awake = 0;
  private last: number;
  private clear: (() => void) | null = null;

  constructor(private readonly wall: () => number = Date.now) {
    this.last = wall();
    this.samples.push({ wall: this.last, awake: 0 });
  }

  /** Beats every minute until stop(), on a timer that does not keep the process alive. */
  start(every: (beat: () => void, ms: number) => () => void = defaultEvery): void {
    if (this.clear) return;
    this.clear = every(() => this.beat(), BEAT_MS);
  }

  stop(): void {
    this.clear?.();
    this.clear = null;
  }

  /** Counts the time since the last beat: all of it when on time, one beat when late (the rest asleep). */
  beat(): void {
    const now = this.wall();
    const step = now - this.last;
    if (step <= 0) return;
    this.last = now;
    this.awake += step <= LATE_MS ? step : BEAT_MS;
    const last = this.samples.at(-1);
    if (!last || now - last.wall >= BEAT_MS) this.samples.push({ wall: now, awake: this.awake });
    while (this.samples.length > 1 && now - (this.samples[0]?.wall ?? now) > SAMPLES_KEPT_MS) this.samples.shift();
  }

  /** Beats, and returns the awake milliseconds from a wall time to now. */
  read(): AwakeFor {
    this.beat();
    const now = { wall: this.last, awake: this.awake };
    const samples = [...this.samples];
    return (from) => {
      const [first] = samples;
      if (!first || from < first.wall) {
        return { ms: Math.max(0, now.awake - (first?.awake ?? now.awake)), whole: false };
      }
      let at = first;
      let next: { wall: number; awake: number } = now;
      for (let index = 0; index < samples.length; index += 1) {
        const sample = samples[index];
        if (!sample || sample.wall > from) break;
        at = sample;
        next = samples[index + 1] ?? now;
      }
      // Within one gap between records the awake share is at most a beat (a later beat would have recorded it).
      const awakeAt = at.awake + Math.min(from - at.wall, next.awake - at.awake);
      return { ms: Math.max(0, now.awake - awakeAt), whole: true };
    };
  }
}

function defaultEvery(beat: () => void, ms: number): () => void {
  const timer = setInterval(beat, ms);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Awake time counted as wall time: no sleep accounting. For a test, through MAESTRO_PASEO_FLEET_AWAKE_CLOCK=wall. */
export const wallClock = (now: () => number = Date.now) => ({ read: (): AwakeFor => awakeAsWall(now()) });

export interface FleetOptions {
  /** The fleet config, its state root and its LaunchAgents: server/paths.ts fleetPaths when not given. */
  configPath?: string;
  stateRoot?: string;
  agentsDir?: string;
  /** Maestro's work, from the files alone (no session reconcile): the fleet's asks and alerts are items in it. */
  items: () => Promise<readonly WorkItem[]>;
  /** Awake time (AwakeClock by default; wallClock when MAESTRO_PASEO_FLEET_AWAKE_CLOCK=wall). */
  clock?: { read(): AwakeFor };
  /** How the default clock beats: an unref'd setInterval, unless given. */
  every?: (beat: () => void, ms: number) => () => void;
  now?: () => number;
  log?: (message: string) => void;
}

interface ScopeConfig {
  id: string;
  stateDir: string;
  mode: string | null;
  dryRun: boolean | null;
  budgetMs: number;
}

interface ScopeRead {
  config: ScopeConfig;
  fold: LedgerFold;
  tickDirs: number[];
  schedule: { scheduled: boolean; intervalMs: number | null; at: number | null };
  disabled: boolean;
  warnings: string[];
}

type Stamp = string;
const stampOf = (info: { mtimeMs: number; size: number; ino: number }): Stamp =>
  `${info.ino}:${info.mtimeMs}:${info.size}`;
const CACHE_LIMIT = 400;

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

/**
 * Opens a regular file without following a symlink or waiting on a FIFO, and
 * hands it to `use`. A link is refused (ELOOP), a FIFO or a folder as not a
 * regular file, and ENOENT passes through for the caller to read as absent.
 */
async function withRegular<T>(
  path: string,
  flags: number,
  use: (handle: FileHandle) => Promise<T>,
  mode?: number,
  /** Yours (the config, a LaunchAgent): followed as linked, still only a regular file, never waited on. */
  own = false,
): Promise<T> {
  const handle = await open(path, flags | constants.O_NONBLOCK | (own ? 0 : constants.O_NOFOLLOW), mode);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${path} is not a regular file`);
    if (!own && info.nlink > 1) throw new Error(`${path} has another hard link`);
    return await use(handle);
  } finally {
    await handle.close();
  }
}

/** A regular file's first `limit` bytes as text, its stamp, and whether there was more. */
function readRegular(path: string, limit = READ_LIMIT, own = false) {
  return withRegular(
    path,
    constants.O_RDONLY,
    async (handle) => {
      const info = await handle.stat();
      const length = Math.min(info.size, limit);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return { text: buffer.toString("utf8", 0, bytesRead), stamp: stampOf(info), truncated: info.size > limit };
    },
    undefined,
    own,
  );
}

/** Your config and LaunchAgent are small: past this they are refused, not read. */
const OWN_LIMIT = 1024 * 1024;

/** The stamp of a regular file, without following a link; null when absent. Any other failure throws, to be said. */
async function stampAt(path: string): Promise<Stamp | null> {
  try {
    return await withRegular(path, constants.O_RDONLY, async (handle) => stampOf(await handle.stat()));
  } catch (error) {
    if (code(error) === "ENOENT") return null;
    throw error;
  }
}

export class Fleet {
  private readonly configPath: string;
  private readonly stateRoot: string;
  private readonly agentsDir: string;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly clock: { read(): AwakeFor };
  /** Distinguishes review records made in one millisecond. */
  private seq = 0;
  private stopClock: () => void = () => undefined;
  private readonly ledgers = new Map<string, { stamp: Stamp; fold: LedgerFold; bad: number }>();
  /** Each report.json read, by path, until it changes: one that would not parse is kept as its error. */
  private readonly reports = new Map<string, { stamp: Stamp; summary: ReportSummary | null; error: string | null }>();
  /** The scopes the config last named: a config caught mid-edit keeps them rather than lose the state dirs it names. */
  private lastGood: ScopeConfig[] | null = null;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: FleetOptions) {
    const paths = fleetPaths();
    this.configPath = options.configPath ?? paths.config;
    this.stateRoot = options.stateRoot ?? paths.stateRoot;
    this.agentsDir = options.agentsDir ?? paths.agents;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.log(`[maestro] ${message}`));
    if (options.clock) {
      this.clock = options.clock;
    } else if (process.env.MAESTRO_PASEO_FLEET_AWAKE_CLOCK === "wall") {
      this.clock = wallClock(this.now);
    } else {
      // Beating from the start: awake time is known from when the plugin started, whoever reads it or not.
      const clock = new AwakeClock(this.now);
      clock.start(options.every);
      this.clock = clock;
      this.stopClock = () => clock.stop();
    }
  }

  /** Stops the awake clock's beat (the plugin's cleanup). */
  stop(): void {
    this.stopClock();
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  /**
   * The scopes, from the fleet config, read as it is linked (it is yours). A
   * config that cannot be read or parsed says why (`error`) and keeps the
   * scopes it last named; with none named yet, the state dirs under the state
   * root that hold a ledger or ticks. No config at all is no error: the fleet
   * may not be installed, and the state dirs on disk are what there is.
   */
  private async scopes(): Promise<{ scopes: ScopeConfig[]; error: string | null }> {
    const fallback = async (error: string) => ({ scopes: this.lastGood ?? (await this.discovered()), error });
    let raw: string;
    try {
      const read = await readRegular(this.configPath, OWN_LIMIT, true);
      if (read.truncated) throw new Error(`it is over ${OWN_LIMIT} bytes`);
      raw = read.text;
    } catch (error) {
      if (code(error) === "ENOENT") {
        this.lastGood = null;
        return { scopes: await this.discovered(), error: null };
      }
      return fallback(`The fleet config could not be read: ${(error as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return fallback(`The fleet config (${this.configPath}) is not valid JSON.`);
    }
    const sections = (parsed as { scopes?: unknown })?.scopes;
    if (typeof sections !== "object" || sections === null || Array.isArray(sections)) {
      return fallback(`The fleet config (${this.configPath}) has no scopes.`);
    }
    const scopes: ScopeConfig[] = [];
    const left: string[] = [];
    for (const [id, value] of Object.entries(sections)) {
      if (!SCOPE_ID.test(id) || typeof value !== "object" || value === null) continue;
      const section = value as Record<string, unknown>;
      const named = typeof section.state_dir === "string" && section.state_dir ? expandHome(section.state_dir) : null;
      // A relative state dir would resolve against whichever folder a process starts in: left out, and said.
      if (named !== null && !isAbsolute(named)) {
        left.push(`${id} (state_dir ${named} is relative)`);
        continue;
      }
      const minutes = section.tick_timeout_min;
      const budget =
        typeof minutes === "number" && Number.isInteger(minutes) && minutes > 0 ? minutes : DEFAULT_TICK_MINUTES;
      scopes.push({
        id,
        stateDir: named ?? join(this.stateRoot, id),
        mode: typeof section.mode === "string" ? section.mode : null,
        dryRun: section.dry_run === undefined ? null : section.dry_run !== 0,
        budgetMs: budget * 60_000 + BUDGET_GRACE_MS,
      });
    }
    this.lastGood = scopes;
    return { scopes, error: left.length > 0 ? `Left out of the Fleet view: ${left.join("; ")}.` : null };
  }

  /** State dirs that hold a ledger or ticks: what the fleet wrote, when its config says nothing. */
  private async discovered(): Promise<ScopeConfig[]> {
    let names: string[];
    try {
      names = await readdir(this.stateRoot);
    } catch {
      return [];
    }
    const found: ScopeConfig[] = [];
    for (const id of names.sort()) {
      if (!SCOPE_ID.test(id)) continue;
      const stateDir = join(this.stateRoot, id);
      const has = await Promise.all(
        ["ledger.jsonl", "ticks"].map((name) =>
          stat(join(stateDir, name)).then(
            () => true,
            () => false,
          ),
        ),
      );
      if (has.some(Boolean)) {
        const budgetMs = DEFAULT_TICK_MINUTES * 60_000 + BUDGET_GRACE_MS;
        found.push({ id, stateDir, mode: null, dryRun: null, budgetMs });
      }
    }
    return found;
  }

  private async ledger(path: string, warnings: string[]): Promise<LedgerFold> {
    let stamp: Stamp | null;
    try {
      stamp = await stampAt(path);
    } catch (error) {
      warnings.push(`The ledger could not be read: ${(error as Error).message}`);
      return foldLedger([]);
    }
    if (stamp === null) return foldLedger([]);
    let cached = this.ledgers.get(path);
    if (cached?.stamp !== stamp) {
      try {
        const read = await readRegular(path);
        if (read.truncated) throw new Error(`it is over ${READ_LIMIT} bytes`);
        const { records, bad } = parseJsonLines(read.text);
        cached = { stamp: read.stamp, fold: foldLedger(records), bad };
        this.ledgers.set(path, cached);
      } catch (error) {
        warnings.push(`The ledger could not be read: ${(error as Error).message}`);
        return foldLedger([]);
      }
    }
    if (cached.bad > 0) warnings.push(`The ledger has ${cached.bad} line(s) that did not parse; they are left out.`);
    return cached.fold;
  }

  private reportPath(stateDir: string, tick: number, name: string): string {
    return join(stateDir, "ticks", String(tick).padStart(5, "0"), name);
  }

  private async report(scope: string, stateDir: string, tick: number, warnings: string[]) {
    const path = this.reportPath(stateDir, tick, "report.json");
    let stamp: Stamp | null;
    try {
      stamp = await stampAt(path);
    } catch (error) {
      warnings.push(`Tick ${tick}'s report.json could not be read: ${(error as Error).message}`);
      return null;
    }
    if (stamp === null) return null;
    let cached = this.reports.get(path);
    if (cached?.stamp !== stamp) {
      // A report being written reads torn: read again once it changes.
      cached = { stamp, summary: null, error: null };
      try {
        const read = await readRegular(path);
        if (read.truncated) throw new Error(`it is over ${READ_LIMIT} bytes`);
        cached.summary = summarizeReport(JSON.parse(read.text), scope, tick);
      } catch (error) {
        cached.error = `Tick ${tick}'s report.json could not be read: ${(error as Error).message}`;
      }
      if (this.reports.size >= CACHE_LIMIT) this.reports.delete(this.reports.keys().next().value as string);
      this.reports.set(path, cached);
    }
    if (cached.error) warnings.push(cached.error);
    return cached.summary;
  }

  /**
   * The scope's LaunchAgent: none (ENOENT) is not scheduled. One that cannot
   * be read is said, and counts as scheduled with no known interval, so a
   * missed tick still needs you: a read that fails must not silence it.
   */
  private async schedule(scope: string, warnings: string[]): Promise<ScopeRead["schedule"]> {
    const path = join(this.agentsDir, plistName(scope));
    try {
      const [info, read] = await Promise.all([stat(path), readRegular(path, OWN_LIMIT, true)]);
      const interval = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(read.text)?.[1];
      return { scheduled: true, intervalMs: interval ? Number(interval) * 1000 : null, at: info.mtimeMs };
    } catch (error) {
      if (code(error) === "ENOENT") return { scheduled: false, intervalMs: null, at: null };
      warnings.push(`The LaunchAgent ${plistName(scope)} could not be read: ${(error as Error).message}`);
      return { scheduled: true, intervalMs: null, at: null };
    }
  }

  private async readScope(config: ScopeConfig): Promise<ScopeRead> {
    const warnings: string[] = [];
    const [fold, tickDirs, schedule, disabled] = await Promise.all([
      this.ledger(join(config.stateDir, "ledger.jsonl"), warnings),
      readdir(join(config.stateDir, "ticks")).then(
        (names) => names.filter((name) => /^\d+$/.test(name)).map(Number),
        (error) => {
          if (code(error) !== "ENOENT")
            warnings.push(`The ticks folder could not be read: ${(error as Error).message}`);
          return [] as number[];
        },
      ),
      this.schedule(config.id, warnings),
      stat(join(config.stateDir, DISABLED_NOTICE)).then(
        () => true,
        (error) => {
          if (code(error) !== "ENOENT")
            warnings.push(`The kill switch's notice could not be read: ${(error as Error).message}`);
          return false;
        },
      ),
    ]);
    return { config, fold, tickDirs, schedule, disabled, warnings };
  }

  /** The newest report there is, searching back from the newest tick. */
  private async newestReport(read: ScopeRead, warnings: string[]): Promise<ReportSummary | null> {
    const ticks = [...new Set([...read.fold.ticks.keys(), ...read.tickDirs])].sort((a, b) => b - a);
    for (const tick of ticks.slice(0, 5)) {
      const summary = await this.report(read.config.id, read.config.stateDir, tick, warnings);
      if (summary) return summary;
    }
    return null;
  }

  private async reviews(stateDir: string, scope: string, warnings: string[]) {
    try {
      const read = await readRegular(join(stateDir, REVIEWS_FILE));
      if (read.truncated) throw new Error(`it is over ${READ_LIMIT} bytes`);
      const { records, bad } = parseJsonLines(read.text);
      if (bad > 0) warnings.push(`${REVIEWS_FILE} has ${bad} line(s) that did not parse; they are left out.`);
      return foldReviews(records, scope);
    } catch (error) {
      if (code(error) !== "ENOENT") warnings.push(`${REVIEWS_FILE} could not be read: ${(error as Error).message}`);
      return foldReviews([], scope);
    }
  }

  /**
   * The newest tick the runner started: the highest the ledger records. A
   * tick folder with no ledger record (a report run by hand under any number)
   * stands in only while the ledger holds none, dated by its report.
   */
  private async newestTick(read: ScopeRead, now: number, awake: AwakeFor): Promise<FleetTick | null> {
    const { budgetMs } = read.config;
    const started = [...read.fold.ticks.values()].filter((entry) => entry.fireAt !== null);
    const newest = started.reduce<(typeof started)[number] | null>(
      (best, entry) => (best === null || entry.tick > best.tick ? entry : best),
      null,
    );
    if (newest) {
      const only = { ...read.fold, ticks: new Map([[newest.tick, newest]]) };
      return tickRows(only, new Map(), [], now, budgetMs, 1, awake)[0] ?? null;
    }
    const dir = read.tickDirs.reduce<number | null>((best, tick) => (best === null || tick > best ? tick : best), null);
    if (dir === null) return null;
    const summary = await this.report(read.config.id, read.config.stateDir, dir, []);
    const reports = new Map(summary ? [[dir, summary]] : []);
    return tickRows(read.fold, reports, [dir], now, budgetMs, 1, awake)[0] ?? null;
  }

  /** Health and the newest tick, which every poll of the header count reads: the ledger, a few stats and a listing. */
  private async healthOf(
    read: ScopeRead,
    items: readonly WorkItem[],
    now: number,
    awake: AwakeFor,
  ): Promise<{ health: FleetHealth; latest: FleetTick | null }> {
    const latest = await this.newestTick(read, now, awake);
    const base = healthOf({
      disabled: read.disabled,
      scheduled: read.schedule.scheduled,
      intervalMs: read.schedule.intervalMs,
      scheduledAt: read.schedule.at,
      latest,
      awakeFor: awake,
      now,
    });
    const cover = coverOf(read.config.id, base.status, latest?.failedStep ?? null, base.since, items);
    const item = cover ? fleetItem(cover.item) : null;
    // A tick run by hand that failed was seen by whoever ran it: only a scheduled scope's failure needs you.
    const urgent = base.status === "missed" || (base.status === "failing" && read.schedule.scheduled);
    const counted = item !== null && (item.needsYou || cover?.answered === true);
    return { health: { ...base, item, needsYou: urgent && !counted }, latest };
  }

  /** What needs you on its own (work.attention): each scope's missed or failing tick not already in Needs you as the fleet's item. */
  async notices(items: readonly WorkItem[]): Promise<FleetNotice[]> {
    const { scopes } = await this.scopes();
    const awake = this.clock.read();
    const now = this.now();
    const reads = await Promise.all(scopes.map((scope) => this.readScope(scope)));
    const out: FleetNotice[] = [];
    for (const read of reads) {
      const { health } = await this.healthOf(read, items, now, awake);
      if (!health.needsYou || (health.status !== "missed" && health.status !== "failing")) continue;
      out.push({ scope: read.config.id, status: health.status, reason: health.notice, since: health.since });
    }
    return out;
  }

  /** Every scope's summary, and one scope in full: `scope`, else the first. */
  async get(scope?: string, ticks: number = FLEET_TICKS.default): Promise<FleetView> {
    const [{ scopes, error }, items] = await Promise.all([this.scopes(), this.options.items()]);
    const awake = this.clock.read();
    const now = this.now();
    const reads = await Promise.all(scopes.map((config) => this.readScope(config)));
    const summaries: FleetScope[] = [];
    let detail: FleetDetail | null = null;
    const chosen = reads.find((read) => read.config.id === scope) ?? reads[0];
    for (const read of reads) {
      const { id, stateDir } = read.config;
      const warnings = [...read.warnings];
      const { health, latest } = await this.healthOf(read, items, now, awake);
      const newest = await this.newestReport(read, warnings);
      const reviews = await this.reviews(stateDir, id, warnings);
      const proposals = withReviews(
        [...(newest?.proposals ?? []), ...actProposals(read.fold.dryActs, (latest?.tick ?? 0) - ACT_TICKS)],
        reviews,
      );
      const asks = asksOf(id, newest?.asksOpen ?? [], read.fold, items);
      summaries.push({
        id,
        mode: read.config.mode ?? newest?.mode ?? null,
        // What the newest tick did over what the config asks: the fleet refuses dry_run 0 without live_accepted.
        dryRun: latest?.dryRun ?? newest?.dryRun ?? read.config.dryRun,
        health,
        lastTick: latest ? { tick: latest.tick, at: latest.at, status: latest.status } : null,
        unreviewed: groupProposals(proposals).filter((group) => group.review === null).length,
        openAsks: asks.length,
      });
      if (read !== chosen) continue;
      const numbers = [...new Set([...read.fold.ticks.keys(), ...read.tickDirs])].sort((a, b) => b - a).slice(0, ticks);
      const reports = new Map<number, ReportSummary>();
      for (const tick of numbers) {
        const summary = await this.report(id, stateDir, tick, warnings);
        if (summary) reports.set(tick, summary);
      }
      detail = {
        id,
        stateDir,
        schedule: {
          scheduled: read.schedule.scheduled,
          intervalMinutes: read.schedule.intervalMs !== null ? Math.round(read.schedule.intervalMs / 60_000) : null,
        },
        ticks: tickRows(read.fold, reports, read.tickDirs, now, read.config.budgetMs, ticks, awake),
        report: newest ? await this.markdown(stateDir, newest.tick, warnings) : null,
        proposals,
        asks,
        alerts: openAlerts(id, items).map(fleetItem),
        // One file read twice (the newest report, then the tick rows) is said once.
        warnings: [...new Set(warnings)],
      };
    }
    return { scopes: summaries, detail, error };
  }

  private async markdown(stateDir: string, tick: number, warnings: string[]): Promise<FleetDetail["report"]> {
    try {
      const read = await readRegular(this.reportPath(stateDir, tick, "report.md"), FLEET_REPORT_BYTES);
      return { tick, markdown: read.text, truncated: read.truncated };
    } catch (error) {
      if (code(error) !== "ENOENT") {
        warnings.push(`Tick ${tick}'s report.md could not be read: ${(error as Error).message}`);
      }
      return null;
    }
  }

  // ── Your verdict ───────────────────────────────────────────────────────────

  /**
   * Records your verdict on proposals in the scope's review file, and returns
   * them with it: one line per key, in one append, fsynced, or none. Every key
   * must be one the fleet proposes now, else nothing is written. A key binds
   * the words you saw (session, class and action, or a verb's target and
   * text), and each line names the tick you saw them at, so a tick landing as
   * you decide changes nothing a verdict says. Writes run one at a time.
   */
  review(input: {
    scope: string;
    keys: readonly string[];
    verdict: ReviewVerdict;
    note: string;
  }): Promise<{ proposals: FleetProposal[] }> {
    const next = this.writes.catch(() => undefined).then(() => this.reviewNow(input));
    this.writes = next;
    return next;
  }

  private async reviewNow(input: {
    scope: string;
    keys: readonly string[];
    verdict: ReviewVerdict;
    note: string;
  }): Promise<{ proposals: FleetProposal[] }> {
    const { scopes } = await this.scopes();
    const config = scopes.find((scope) => scope.id === input.scope);
    if (!config) throw new UserError(`The fleet has no scope named ${input.scope}.`);
    const view = await this.get(config.id, 1);
    const detail = view.detail?.id === config.id ? view.detail : null;
    const current = new Map((detail?.proposals ?? []).map((proposal) => [proposal.key, proposal]));
    const proposals: FleetProposal[] = [];
    for (const key of new Set(input.keys)) {
      const proposal = current.get(key);
      if (!proposal) {
        throw new UserError(
          "The fleet no longer proposes this: its latest report changed. Look at the Fleet view again.",
        );
      }
      proposals.push(proposal);
    }
    // Only beside the fleet's own ledger: a config's state_dir that is not a fleet state dir gets nothing.
    const ledger = await stampAt(join(config.stateDir, "ledger.jsonl")).catch(() => null);
    if (ledger === null) {
      throw new UserError(`${config.stateDir} holds no fleet ledger, so no verdict was recorded there.`);
    }
    const at = new Date(this.now());
    const records = proposals.map((proposal) => {
      this.seq += 1;
      return reviewRecord({ scope: config.id, proposal, verdict: input.verdict, note: input.note, at, seq: this.seq });
    });
    const path = join(config.stateDir, REVIEWS_FILE);
    const flags = constants.O_RDWR | constants.O_APPEND | constants.O_CREAT;
    try {
      await withRegular(
        path,
        flags,
        async (handle) => {
          const { size } = await handle.stat();
          let lead = "";
          if (size > 0) {
            // A line torn by a crash must not join the next one.
            const last = Buffer.alloc(1);
            await handle.read(last, 0, 1, size - 1);
            lead = last[0] === 0x0a ? "" : "\n";
          }
          const lines = Buffer.from(`${lead}${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
          try {
            const { bytesWritten } = await handle.write(lines);
            if (bytesWritten !== lines.length) throw new Error(`wrote ${bytesWritten} of ${lines.length} bytes`);
            await handle.sync();
          } catch (error) {
            // All or none: lines that made it in before a short write are taken back out.
            await handle.truncate(size).catch(() => undefined);
            throw error;
          }
        },
        0o600,
      );
    } catch (error) {
      throw new UserError(
        `Your verdict was not recorded: ${REVIEWS_FILE} could not be written (${(error as Error).message}).`,
      );
    }
    const word = input.verdict === "accept" ? "accepted" : "rejected";
    this.log(`fleet ${config.id}: you ${word} ${records.length} proposal(s): "${proposals[0]?.action}"`);
    const review = { verdict: input.verdict, note: input.note.trim() || null, at: at.toISOString() };
    return { proposals: proposals.map((proposal) => ({ ...proposal, review: { ...review, tick: proposal.tick } })) };
  }
}
