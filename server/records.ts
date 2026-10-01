// The record, read-only: History across all work, the files in one work
// folder, and each run's changed line. Served to Maestro's own surfaces only;
// none of it is on the agent socket.
//
// Reads go through WorkStore.scan, the same path work.list takes, so an item
// that is mid-change is read once the change has finished, never half-written.

import type { MaestroConfig, WorkItem } from "../shared/contracts";
import { HISTORY_CAP, HISTORY_DAYS, type HistoryEvent, type WorkFile } from "../shared/records";
import { ChangedCache } from "./changed";
import { shiftDays, toWireEvents } from "./events";
import { listFiles, readText } from "./files";
import type { Paseo } from "./runs";
import { placement, type StoredWork, WorkStore } from "./store";

/** Receipts from every item since `since`, newest first, at most `cap` of them. */
export function historyOf(
  items: readonly StoredWork[],
  since: number,
  cap: number = HISTORY_CAP,
): { events: HistoryEvent[]; capped: boolean } {
  const events: HistoryEvent[] = [];
  for (const item of items) {
    const { initiative, project } = placement(item.rel);
    // Newest first within the item too, so receipts stamped in the same millisecond keep their order.
    for (const event of toWireEvents(item.events).reverse()) {
      const at = Date.parse(event.ts);
      if (!(at >= since)) continue;
      events.push({ ...event, itemId: item.contract.id, title: item.title, initiative, project });
    }
  }
  // A stable sort: equal times keep the newest-first order they were pushed in.
  events.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  return { events: events.slice(0, cap), capped: events.length > cap };
}

export class Records {
  readonly changed: ChangedCache;
  private readonly now: () => Date;

  constructor(
    private readonly config: () => Promise<MaestroConfig>,
    options: { now?: () => Date; changed?: ChangedCache } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.changed = options.changed ?? new ChangedCache();
  }

  private async store(): Promise<WorkStore> {
    return new WorkStore((await this.config()).workRoot, this.now);
  }

  /** The last `days` local days of receipts across all work, today included. */
  async history(days: number = HISTORY_DAYS.default): Promise<{ events: HistoryEvent[]; capped: boolean }> {
    const span = Math.min(HISTORY_DAYS.max, Math.max(HISTORY_DAYS.min, Math.trunc(days) || HISTORY_DAYS.default));
    const today = new Date(this.now());
    today.setHours(0, 0, 0, 0);
    const { items } = await (await this.store()).scan();
    return historyOf(items, shiftDays(today.getTime(), 1 - span));
  }

  async files(id: string): Promise<{ files: WorkFile[] }> {
    const item = await (await this.store()).findById(id);
    return { files: await listFiles(item.dir) };
  }

  async file(id: string, name: string): Promise<{ name: string; text: string; truncated: boolean }> {
    const item = await (await this.store()).findById(id);
    return readText(item.dir, name);
  }

  /** work.list with each item's changed line filled in. Never fails or slows the list. */
  async withChanged<T extends { items: WorkItem[] }>(paseo: Paseo | null | undefined, list: T): Promise<T> {
    return { ...list, items: await this.changed.fill(paseo, list.items) };
  }

  /** work.get with the item's changed line filled in, from the same read as the list. */
  async withChangedItem<T extends { item: WorkItem }>(paseo: Paseo | null | undefined, detail: T): Promise<T> {
    const [item] = await this.changed.fill(paseo, [detail.item]);
    return item ? { ...detail, item } : detail;
  }
}
