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

/** Only the work id: the card reads the item live, so it never shows a stale state. */
export const GateCardSchema = z.object({ workId: z.string() });
export type GateCardData = z.infer<typeof GateCardSchema>;
