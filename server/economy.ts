// The economy summary on disk (BRO-3118): the workspace coordinator reads `economy.json` to route work by tier, so it
// is written whole through a temp file and a rename (server/atomic.ts), never half. It is rewritten whenever a
// `run.economy` receipt is added, and otherwise at most once a minute, so a quiet daemon keeps the file's window
// current without writing on every sweep.

import { ECONOMY_DAYS, type EconomySummary } from "../shared/economy";
import { writeFileAtomic } from "./atomic";
import { type EconomyWork, summarizeEconomy } from "./economy-model";

/** How long an unforced write waits after the last one. */
export const ECONOMY_REFRESH_MS = 60_000;

export interface EconomyFileOptions {
  path: string;
  windowDays?: number;
  now?: () => Date;
  refreshMs?: number;
}

export class EconomyFile {
  readonly path: string;
  readonly windowDays: number;
  private readonly now: () => Date;
  private readonly refreshMs: number;
  private wroteAt = Number.NEGATIVE_INFINITY;

  constructor(options: EconomyFileOptions) {
    this.path = options.path;
    this.windowDays = options.windowDays ?? ECONOMY_DAYS.default;
    this.now = options.now ?? (() => new Date());
    this.refreshMs = options.refreshMs ?? ECONOMY_REFRESH_MS;
  }

  /**
   * Write the summary of `works`. `force`: a receipt was just added, so write now; otherwise only when the last
   * write is a minute old. Returns the summary written, or null when it was not time.
   */
  async write(works: () => Promise<readonly EconomyWork[]>, force: boolean): Promise<EconomySummary | null> {
    const at = this.now().getTime();
    if (!force && at - this.wroteAt < this.refreshMs) return null;
    // Claimed before the read, so two callers a moment apart write once.
    this.wroteAt = at;
    const summary = summarizeEconomy(await works(), at, this.windowDays);
    await writeFileAtomic(this.path, `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  }
}
