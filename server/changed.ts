// The changed line, read on the server. Paseo hands its client state to
// workspace panels but not to plugin surfaces, so a card on the Maestro surface
// cannot read a workspace's diff stat itself. The server reads every workspace
// once (Paseo's workspace list carries the stat) and each run looks up its own.
//
// Best effort, by design: one read serves every item for TTL_MS; a read that
// fails leaves every stat unknown (null) for that stretch; a read slower than
// WAIT_MS never holds up the list, which goes out with what is known and the
// read lands for the next one. Nothing here can fail or slow a list.

import type { DiffStat, WorkItem } from "../shared/contracts";
import type { Paseo } from "./runs";

export const TTL_MS = 15_000;
/** The longest a list waits on a read before it answers without it. */
export const WAIT_MS = 750;
/** A read still running after this is abandoned, so the next list can start another. */
export const GIVE_UP_MS = 10_000;
const PAGE = 200;
const MAX_PAGES = 10;

type Stats = ReadonlyMap<string, DiffStat | null>;
type Workspaces = Pick<Paseo["workspaces"], "list">;

export interface ChangedOptions {
  now?: () => number;
  ttlMs?: number;
  waitMs?: number;
  giveUpMs?: number;
}

export class ChangedCache {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly waitMs: number;
  private readonly giveUpMs: number;
  private stats: Stats | null = null;
  private readAt = Number.NEGATIVE_INFINITY;
  private reading: Promise<Stats> | null = null;
  private client: Workspaces | null = null;
  /** Daemon reads started, for tests and the log. */
  reads = 0;

  constructor(options: ChangedOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? TTL_MS;
    this.waitMs = options.waitMs ?? WAIT_MS;
    this.giveUpMs = options.giveUpMs ?? GIVE_UP_MS;
  }

  /** Every workspace's stat, from the last read when it is fresh. Never throws. */
  async read(paseo?: { workspaces: Workspaces } | null): Promise<Stats | null> {
    if (paseo?.workspaces) this.client = paseo.workspaces;
    if (this.stats && this.now() - this.readAt < this.ttlMs) return this.stats;
    const client = this.client;
    if (!client) return null;
    if (!this.reading) {
      const reading = this.fetch(client).finally(() => {
        if (this.reading === reading) this.reading = null;
      });
      this.reading = reading;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.waitMs);
    });
    try {
      // Slower than the wait: answer with the last read, however old, rather than hold the list.
      return (await Promise.race([this.reading, late])) ?? this.stats;
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetch(client: Workspaces): Promise<Stats> {
    this.reads += 1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const giveUp = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("workspace read timed out")), this.giveUpMs);
    });
    let stats: Stats;
    try {
      stats = await Promise.race([this.pages(client), giveUp]);
    } catch {
      // Unknown, not zero: every stat reads null until the next read.
      stats = new Map();
    } finally {
      clearTimeout(timer);
    }
    this.stats = stats;
    this.readAt = this.now();
    return stats;
  }

  private async pages(client: Workspaces): Promise<Stats> {
    const stats = new Map<string, DiffStat | null>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await client.list({ page: { limit: PAGE, ...(cursor ? { cursor } : {}) } });
      for (const entry of result.entries ?? []) {
        const stat = entry.diffStat;
        stats.set(
          entry.id,
          stat && Number.isFinite(stat.additions) && Number.isFinite(stat.deletions)
            ? { additions: stat.additions, deletions: stat.deletions }
            : null,
        );
      }
      cursor = result.pageInfo?.nextCursor ?? undefined;
      if (!cursor) break;
    }
    return stats;
  }

  /** Each item with `changed` set from its run's workspace: null when that is unknown. */
  async fill<T extends Pick<WorkItem, "worker">>(
    paseo: { workspaces: Workspaces } | null | undefined,
    items: readonly T[],
  ): Promise<Array<T & { changed: DiffStat | null }>> {
    const stats = await this.read(paseo).catch(() => null);
    return items.map((item) => {
      const id = item.worker?.workspaceId;
      return { ...item, changed: (id && stats?.get(id)) || null };
    });
  }
}
