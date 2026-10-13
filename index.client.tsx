import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createWorkPanel } from "./client/agent-panel";
import { cardActions } from "./client/card-actions";
import { createPillContent, PILL_ICONS } from "./client/composer-pill";
import { MAESTRO_SCREEN, opener, startIntegrations } from "./client/integrations";
import { requestIntent } from "./client/intent";
import { KitGalleryScreen } from "./client/kit/gallery";
import { MaestroSurface } from "./client/plane";
import { createLegacyCard, createSessionCard } from "./client/session-card";
import { createSessionScreen, sessionTitle } from "./client/session-screen";
import { MaestroSettings } from "./client/settings";
import { linkSettingsOf } from "./client/settings-link";
import {
  CARD_KIND,
  CARD_VERSION,
  CardSchema,
  GATE_CARD_KIND,
  GATE_CARD_VERSION,
  GateCardSchema,
  SESSION_SCREEN,
} from "./shared/card";
import { adoptAgent } from "./shared/contracts";
import { KIT_SCREEN } from "./shared/kit";
import { BROOMVA_DARK, BROOMVA_LIGHT } from "./shared/theme";

export default function contribute(client: PluginClientContext) {
  client.addTheme(BROOMVA_LIGHT);
  client.addTheme(BROOMVA_DARK);

  client.addScreen({ id: MAESTRO_SCREEN, title: "Maestro", Component: MaestroSurface });
  // The J/M component gallery (BRO-3034): no sidebar row or command, reached by its route, and off unless
  // the daemon runs with MAESTRO_KIT_GALLERY=1 (shared/kit.ts).
  client.addScreen({ id: KIT_SCREEN, title: "Maestro kit", Component: KitGalleryScreen });
  // Kept on the 0.8 call on purpose: the host routes a legacy sidebar item to /sidebar/<id> and heads the
  // screen with this item's title and icon. addSidebarHeaderItem routes to /surface/<id> and drops the icon.
  client.addSidebarItem({ id: "maestro", title: "Maestro", icon: "LayoutDashboard", surface: MAESTRO_SCREEN });
  client.addSettingsScreen({ id: "maestro", title: "Maestro", icon: "LayoutDashboard", Component: MaestroSettings });
  // The loop's panel opens Settings, which only this context can do, and only on a host that has the call (client/settings-link.ts).
  const unlinkSettings = linkSettingsOf(client, "maestro");

  // How anything outside the Maestro surface opens it: the intent, and the surface with it.
  const open = opener(client);

  client.addWorkspacePanel({
    id: "work",
    title: "Work",
    icon: "LayoutDashboard",
    context: "agent",
    Component: createWorkPanel(open),
  });

  client.addCommandCenterItem({
    id: "open-maestro",
    title: "Open Maestro",
    icon: "LayoutDashboard",
    keywords: ["work", "gate", "needs you"],
    context: "global",
    onSelect: ({ openScreen }) => openScreen({ screenId: MAESTRO_SCREEN }),
  });
  client.addCommandCenterItem({
    id: "new-work",
    title: "New Maestro work",
    icon: "Plus",
    keywords: ["work", "dispatch", "brief", "task"],
    context: "global",
    onSelect: ({ openScreen }) => {
      requestIntent({ kind: "new" });
      openScreen({ screenId: MAESTRO_SCREEN });
    },
  });
  client.addCommandCenterItem({
    id: "needs-you",
    title: "What needs you in Maestro",
    icon: "Inbox",
    keywords: ["gate", "review", "approve", "needs you"],
    context: "global",
    onSelect: ({ openScreen }) => {
      requestIntent({ kind: "filter", group: "review" });
      openScreen({ screenId: MAESTRO_SCREEN });
    },
  });
  client.addCommandCenterItem({
    id: "track-session",
    title: "Track this session in Maestro",
    icon: "ListPlus",
    keywords: ["work", "adopt"],
    context: "agent",
    async onSelect({ agent, rpc, openPanel }) {
      await rpc(adoptAgent, { agentId: agent.id, title: agent.title ?? "" });
      openPanel("work");
    },
  });
  client.addSlashCommand({
    name: "maestro",
    description: "Track this session as Maestro work",
    argumentHint: "[title]",
    context: "agent",
    async onSubmit({ args, agent, rpc, openPanel }) {
      await rpc(adoptAgent, { agentId: agent.id, title: args || agent.title || "" });
      openPanel("work");
    },
  });

  // Open in Maestro on a card: K2, the page for that one session (`params.agentId`).
  const actions = cardActions(client, open);
  client.addScreen({ id: SESSION_SCREEN, title: sessionTitle, Component: createSessionScreen(actions) });

  // The cards Maestro leaves in a session (server/session-cards.ts, K1): where you act from a push.
  client.addTimelineRenderer({
    kind: CARD_KIND,
    version: CARD_VERSION,
    schema: CardSchema,
    Component: createSessionCard(actions),
  });
  // Sessions keep their timelines: the gate card of an earlier build still renders, as the finished card it was.
  client.addTimelineRenderer({
    kind: GATE_CARD_KIND,
    version: GATE_CARD_VERSION,
    schema: GateCardSchema,
    Component: createLegacyCard(actions),
  });

  // The header count in every workspace and a pill beside every tracked session's composer.
  const integrations = startIntegrations(client, {
    pillIcon: (state) => PILL_ICONS[state],
    PillContent: createPillContent(open),
  });

  return () => {
    integrations.stop();
    unlinkSettings();
  };
}
