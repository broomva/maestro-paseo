// How a card leaves for Maestro (K0 step 4, BRO-3008): Open in Maestro on a card opens that session's page with
// the session's agent id as a param, a hold without a session opens its inspector on the Feed, and a verb that
// sends you somewhere (Decisions) goes through the one intent bus. Built from the plugin client's own
// `openScreen`, so it is tested with a fake (client/card-actions.test.ts).

import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SESSION_SCREEN } from "../shared/card";
import type { CardActions } from "./card-hooks";
import { MAESTRO_SCREEN } from "./integrations";
import type { MaestroIntent } from "./intent";

export function cardActions(
  client: Pick<PluginClientContext, "openScreen">,
  intent: (intent: MaestroIntent) => void,
): CardActions {
  return {
    session: (agentId) => client.openScreen({ screenId: SESSION_SCREEN, params: { agentId } }),
    hold: (key) => client.openScreen({ screenId: MAESTRO_SCREEN, params: { hold: key } }),
    maestro: () => client.openScreen({ screenId: MAESTRO_SCREEN }),
    intent,
  };
}
