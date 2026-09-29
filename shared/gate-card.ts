// The approval card Maestro leaves in a worker's timeline when its run lands
// at your gate. The daemon appends it (server/gate-card.ts) and the app draws
// it (client/gate-card.tsx); both read the kind, version and data shape here.
//
// The kind is a contribution id to the Paseo app, which accepts only
// lowercase letters, digits and dashes: "maestro.gate" would stop the whole
// client bundle from loading. Items are already scoped to this plugin.

import { z } from "zod";

export const GATE_CARD_KIND = "maestro-gate";
export const GATE_CARD_VERSION = 1;

/**
 * The work, which landing the card was left for (the index of the state event
 * that moved it into review) and the session it was left in. The card reads
 * the item live; only the card for the current landing, in the current
 * worker's session, offers a verb.
 */
export const GateCardSchema = z.object({
  workId: z.string(),
  landing: z.number().int().nonnegative(),
  agentId: z.string(),
});
export type GateCardData = z.infer<typeof GateCardSchema>;
