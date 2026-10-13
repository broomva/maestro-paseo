// The cards Maestro leaves in a session's own timeline (BRO-3008, K0–K1): where you act from a push. A push opens
// the session that asked, so that session carries the card: the exact action or question, the verbs, and Open in
// Maestro. The inbox session holds only a digest (server/inbox.ts).
//
// What is raised, and when:
//   - a hold that names a session (an approval, an ask, an owner step): every pass, from needs.list's own rows, so a
//     hold raised while the daemon was down, or whose row was lost with it, is carded again (the id is the raise's
//     own, so a card appended again replaces itself);
//   - finished work: when a run lands at your gate and, after a short settle, nothing holds it (a permission prompt
//     raised with the landing is the approval's card, not a second one);
//   - stuck work: work that stopped within the last quarter hour, in the session it stopped in.
//
// A card is advisory and carries only {kind, key, version} (shared/card.ts): it reads the hold live. An append that
// fails is logged and tried again on the next pass, three times, never touching the landing or the sweep.
// Cards are never added to a session Maestro does not track, because only a hold, a landing or stuck work names one.

import { CARD_KIND, CARD_VERSION, type CardData, cardId, holdCard } from "../shared/card";
import type { WorkItem } from "../shared/contracts";
import { type NeedRow, workKey } from "../shared/needs";
import { type WorkEvent, workerOf } from "./events";
import type { Paseo } from "./runs";
import type { StoredWork } from "./store";

type Snapshot = Pick<StoredWork, "contract" | "events">;

const isLanding = (event: WorkEvent | undefined): boolean => event?.type === "state" && event.to === "review";

/** The index of the latest move into review, or null if the work never landed. */
export function lastLanding(events: readonly WorkEvent[]): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (isLanding(events[index])) return index;
  }
  return null;
}

/**
 * The landing `after` records that `before` had not seen, as its index in the event log: the work's last event moved
 * it into review and was written after `before` was read. Null for any other change, and for a change that was
 * dropped (a repeat hook hands back the item as it stood, whose last event can be an old landing).
 */
export function landingOf(before: Pick<StoredWork, "events">, after: Pick<StoredWork, "events">): number | null {
  const index = after.events.length - 1;
  if (!isLanding(after.events[index])) return null;
  if (index < before.events.length) return null;
  return index;
}

/** How long a stop stays worth a card: what stopped long ago is Health's to show, not a session's to be told. */
export const STUCK_CARD_MS = 15 * 60_000;
/** How long a landing waits before it is carded, so a prompt raised with it is seen first and carded as the approval. */
export const SETTLE_MS = 2_000;
/** How many times a card is tried, across passes, before it is let go (a session that is gone refuses every one). */
export const CARD_ATTEMPTS = 3;

/** How long one append may take before the pass stops waiting for it and counts it failed. */
export const APPEND_MS = 10_000;

/** What a card reads from the daemon: the holds as needs.list has them, and the work as the store has it. */
export interface CardSources {
  holds(): Promise<NeedRow[]>;
  work(): Promise<WorkItem[]>;
}

/** A landing seen live, and the session it landed in. */
export interface Landing {
  landing: number;
  agentId: string;
}

export interface Due {
  agentId: string;
  card: CardData;
}

/** A short stable word for a stop's reason, so one cause is one card however often the work is written. */
export function reasonVersion(reason: string | null): string {
  let hash = 0x811c9dc5;
  for (const char of reason ?? "") hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

/**
 * Every card due now, each with its session. Pure: a hold that names a session; a landing seen live, still at the
 * gate on that landing, in the session it landed in and held by nothing; work that stopped within STUCK_CARD_MS.
 */
export function cardsDue(input: {
  holds: readonly NeedRow[];
  items: readonly WorkItem[];
  landings: ReadonlyMap<string, Landing>;
  now: number;
}): Due[] {
  const due: Due[] = [];
  const held = new Set(input.holds.map((row) => row.key));
  for (const row of input.holds) {
    const card = holdCard(row);
    if (card) due.push(card);
  }
  const byId = new Map(input.items.map((item) => [item.id, item]));
  for (const [id, seen] of input.landings) {
    const item = byId.get(id);
    if (item?.state !== "review" || item.landing !== seen.landing) continue;
    if (item.worker?.agentId !== seen.agentId || item.permission || held.has(workKey(id))) continue;
    due.push({ agentId: seen.agentId, card: { kind: "finished", key: workKey(id), version: String(seen.landing) } });
  }
  for (const item of input.items) {
    if (item.state !== "blocked" || !item.worker) continue;
    if (input.now - Date.parse(item.updatedAt) > STUCK_CARD_MS) continue;
    due.push({
      agentId: item.worker.agentId,
      card: { kind: "health", key: workKey(item.id), version: reasonVersion(item.reason) },
    });
  }
  return due;
}

/** `work`'s answer, or a rejection once `ms` passes first: a daemon that never answers holds up nothing. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Paseo has not answered in ${ms / 1000} s; not waiting`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export interface SessionCardOptions {
  now?: () => number;
  settleMs?: number;
  appendMs?: number;
}

export class SessionCards {
  /** Per card id, how many times appending it has failed; `CARD_ATTEMPTS` is a card let go, 0 a card left. */
  private readonly tried = new Map<string, number>();
  /** Per work id, the latest landing seen live: the only finished card that is raised. */
  private readonly landings = new Map<string, Landing>();
  private running: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly now: () => number;
  private readonly settleMs: number;
  private readonly appendMs: number;

  constructor(
    private readonly paseo: () => Paseo | null,
    private readonly sources: CardSources,
    private readonly log: (message: string) => void,
    options: SessionCardOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.settleMs = options.settleMs ?? SETTLE_MS;
    this.appendMs = options.appendMs ?? APPEND_MS;
  }

  /** The engine's word that work changed: a landing is noted and carded after the settle. Never rejects. */
  async landed(before: Pick<StoredWork, "events">, after: Snapshot): Promise<void> {
    const landing = landingOf(before, after);
    if (landing === null) return;
    const agentId = workerOf(after.events)?.agentId;
    if (!agentId) return;
    this.landings.set(after.contract.id, { landing, agentId });
    this.nudge();
  }

  /** Something that raises a card happened (a prompt, a request, a landing): look soon, once for a burst. */
  nudge(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reconcile();
    }, this.settleMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * One pass: every card due that has not been left, appended to its session. One pass at a time; one asked for
   * while another runs follows it. Never rejects: a source that cannot be read is logged and the pass is skipped.
   */
  reconcile(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.pass().finally(() => {
      this.running = null;
      if (this.again && !this.stopped) {
        this.again = false;
        void this.reconcile();
      }
    });
    return this.running;
  }

  private async pass(): Promise<void> {
    const paseo = this.paseo();
    if (!paseo) return;
    let holds: NeedRow[];
    let items: WorkItem[];
    try {
      [holds, items] = await Promise.all([this.sources.holds(), this.sources.work()]);
    } catch (error) {
      this.log(`session cards: reading what to card: ${(error as Error).message}`);
      return;
    }
    this.forget(items);
    const due = cardsDue({ holds, items, landings: this.landings, now: this.now() });
    for (const { agentId, card } of due) {
      const id = cardId(card);
      const failed = this.tried.get(id) ?? 0;
      if (failed === -1 || failed >= CARD_ATTEMPTS) continue;
      // Claimed before the append, so a pass that starts meanwhile (it cannot: one at a time) still leaves it once.
      this.tried.set(id, -1);
      try {
        await within(
          paseo.agents.ref(agentId).timeline.append({
            type: "plugin",
            id,
            kind: CARD_KIND,
            version: CARD_VERSION,
            data: card,
          }),
          this.appendMs,
        );
        if (card.kind === "finished") this.landings.delete(card.key.slice("work:".length));
      } catch (error) {
        this.tried.set(id, failed + 1);
        this.log(`card ${id} not added to ${agentId}: ${(error as Error).message}`);
      }
    }
  }

  /** A landing whose work has gone on (a new run, a verdict, a close) is not carded: it is no longer the latest. */
  private forget(items: readonly WorkItem[]): void {
    const byId = new Map(items.map((item) => [item.id, item]));
    for (const [id, seen] of this.landings) {
      const item = byId.get(id);
      if (item?.state !== "review" || item.landing !== seen.landing) this.landings.delete(id);
    }
  }
}
