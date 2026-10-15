// The economy summary on disk (BRO-3118): the workspace coordinator reads `economy.json` to route work by tier, so it
// is written whole through a temp file and a rename (server/atomic.ts), never half. It is rewritten whenever a
// `run.economy` receipt is added, and otherwise at most once a minute, so a quiet daemon keeps the file's window
// current without writing on every sweep.
//
// Writing it means scanning every work item, so the writes are coalesced: one scan at a time, at most one every
// ECONOMY_SCAN_MS, and a request that comes inside that interval or while a scan runs is answered by one trailing
// scan at its end, so the last reading always lands without a scan per turn.

import { ECONOMY_DAYS, type EconomySummary } from "../shared/economy";
import { writeFileAtomic } from "./atomic";
import { type EconomyWork, summarizeEconomy } from "./economy-model";

/** How long an unforced write waits after the last successful one. */
export const ECONOMY_REFRESH_MS = 60_000;

/** The least time between two scans of the work items, however many readings ask for one. */
export const ECONOMY_SCAN_MS = 30_000;

/** Runs `run` after `ms`; the function it returns cancels it. */
export type EconomyTimer = (run: () => void, ms: number) => () => void;

const realTimer: EconomyTimer = (run, ms) => {
  const handle = setTimeout(run, ms);
  // A timer alone never keeps the process up: the next reading, or the sweep, asks again.
  handle.unref?.();
  return () => clearTimeout(handle);
};

type Works = () => Promise<readonly EconomyWork[]>;

export interface EconomyFileOptions {
  path: string;
  windowDays?: number;
  now?: () => Date;
  refreshMs?: number;
  scanMs?: number;
  timer?: EconomyTimer;
  log?: (message: string) => void;
}

export class EconomyFile {
  readonly path: string;
  readonly windowDays: number;
  private readonly now: () => Date;
  private readonly refreshMs: number;
  private readonly scanMs: number;
  private readonly timer: EconomyTimer;
  private readonly log: (message: string) => void;
  /** When the last write succeeded. */
  private wroteAt = Number.NEGATIVE_INFINITY;
  /** When the last scan began: a scan is claimed when it starts, so two callers a moment apart scan once. */
  private scannedAt = Number.NEGATIVE_INFINITY;
  private flight: Promise<EconomySummary | null> | null = null;
  /** A request arrived while a scan ran: its reading may be newer than what that scan read. */
  private dirty = false;
  private latest: Works | null = null;
  private cancelTrailing: (() => void) | null = null;

  constructor(options: EconomyFileOptions) {
    this.path = options.path;
    this.windowDays = options.windowDays ?? ECONOMY_DAYS.default;
    this.now = options.now ?? (() => new Date());
    this.refreshMs = options.refreshMs ?? ECONOMY_REFRESH_MS;
    this.scanMs = options.scanMs ?? ECONOMY_SCAN_MS;
    this.timer = options.timer ?? realTimer;
    this.log = options.log ?? (() => undefined);
  }

  /**
   * Ask for the summary of `works` to be written. `force`: a receipt was just added; otherwise only when the last
   * write is a minute old. Returns the summary this call wrote, or null when it did not (not time, or coalesced into
   * a scan already running or one that will trail it).
   */
  write(works: Works, force: boolean): Promise<EconomySummary | null> {
    if (!force && this.now().getTime() - this.wroteAt < this.refreshMs) return Promise.resolve(null);
    this.latest = works;
    if (this.flight) {
      this.dirty = true;
      return Promise.resolve(null);
    }
    const wait = this.scannedAt + this.scanMs - this.now().getTime();
    if (wait > 0) {
      this.cancelTrailing ??= this.timer(() => {
        this.cancelTrailing = null;
        this.trail();
      }, wait);
      return Promise.resolve(null);
    }
    return this.scan(works);
  }

  /** For a test: waits for the scan in flight, and the one that trails it when a request came meanwhile. */
  async settled(): Promise<void> {
    while (this.flight) await this.flight.catch(() => undefined);
  }

  /** Cancel the trailing scan: the plugin is shutting down. */
  stop(): void {
    this.cancelTrailing?.();
    this.cancelTrailing = null;
  }

  private trail(): void {
    const works = this.latest;
    if (!works) return;
    if (this.flight) {
      this.dirty = true;
      return;
    }
    this.scan(works).catch((error) => this.log(`economy.json: ${(error as Error).message}`));
  }

  private scan(works: Works): Promise<EconomySummary | null> {
    const at = this.now().getTime();
    this.scannedAt = at;
    this.dirty = false;
    const flight = (async () => {
      const summary = summarizeEconomy(await works(), at, this.windowDays);
      await writeFileAtomic(this.path, `${JSON.stringify(summary, null, 2)}\n`);
      // Only a write that landed counts as one.
      this.wroteAt = at;
      return summary;
    })().finally(() => {
      this.flight = null;
      if (this.dirty) this.write(this.latest ?? works, true).catch(() => undefined);
    });
    this.flight = flight;
    return flight;
  }
}
