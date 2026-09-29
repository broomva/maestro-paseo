// When a run lands at your gate, Maestro leaves an approval card in the
// worker's own timeline, so the verdict can be given where the work happened.
//
// The card is advisory. The engine tells `landed` after the state change and
// its receipt are written, and does not wait for it: an append that fails or
// hangs is logged and never touches the landing. Each landing is carded once.
// A landing is the state event that moved the work into review, named by its
// place in the append-only event log, which never changes. The wire carries
// the latest one (`lastLanding`), so a card can tell whether it is current.

import { GATE_CARD_KIND, GATE_CARD_VERSION, type GateCardData } from "../shared/gate-card";
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
 * The landing `after` records that `before` had not seen, as its index in the
 * event log: the work's last event moved it into review and was written after
 * `before` was read. Null for any other change, and for a change that was
 * dropped (a repeat hook hands back the item as it stood, whose last event can
 * be an old landing).
 */
export function landingOf(before: Pick<StoredWork, "events">, after: Pick<StoredWork, "events">): number | null {
  const index = after.events.length - 1;
  if (!isLanding(after.events[index])) return null;
  if (index < before.events.length) return null;
  return index;
}

export class GateCards {
  /** Per work id, the latest landing this process has carded or is carding. */
  private readonly carded = new Map<string, number>();

  constructor(
    private readonly paseo: () => Paseo | null,
    private readonly log: (message: string) => void,
  ) {}

  /** Appends the card for a new landing. Never rejects: a failure is logged and dropped. */
  async landed(before: Pick<StoredWork, "events">, after: Snapshot): Promise<void> {
    const id = after.contract.id;
    const landing = landingOf(before, after);
    if (landing === null || landing <= (this.carded.get(id) ?? -1)) return;
    // Claimed before the first await, so two reports of one landing at once still append once.
    this.carded.set(id, landing);
    const agentId = workerOf(after.events)?.agentId;
    if (!agentId) return;
    try {
      const paseo = this.paseo();
      if (!paseo) throw new Error("Maestro has no connection to Paseo yet");
      const data: GateCardData = { workId: id, landing, agentId };
      await paseo.agents.ref(agentId).timeline.append({
        type: "plugin",
        id: `${GATE_CARD_KIND}:${id}:${landing}`,
        kind: GATE_CARD_KIND,
        version: GATE_CARD_VERSION,
        data,
      });
    } catch (error) {
      this.log(`gate card for ${id} not added: ${(error as Error).message}`);
    }
  }
}
