import type { PluginClientContext } from "@getpaseo/plugin/client";
import { WorkPanel } from "./client/agent-panel";
import { createPillContent, PILL_ICONS } from "./client/composer-pill";
import { createGateCard } from "./client/gate-card";
import { opener, startIntegrations } from "./client/integrations";
import { requestIntent } from "./client/intent";
import { MaestroSurface } from "./client/plane";
import { MaestroSettings } from "./client/settings";
import { adoptAgent } from "./shared/contracts";
import { GATE_CARD_KIND, GATE_CARD_VERSION, GateCardSchema } from "./shared/gate-card";
import { BROOMVA_DARK, BROOMVA_LIGHT } from "./shared/theme";

export default function contribute(client: PluginClientContext) {
  client.addTheme(BROOMVA_LIGHT);
  client.addTheme(BROOMVA_DARK);

  client.addSurface("maestro", MaestroSurface);
  client.addSidebarItem({ id: "maestro", title: "Maestro", icon: "LayoutDashboard", surface: "maestro" });
  client.addSettingsScreen({ id: "maestro", title: "Maestro", icon: "LayoutDashboard", Component: MaestroSettings });

  client.addWorkspacePanel({
    id: "work",
    title: "Work",
    icon: "LayoutDashboard",
    context: "agent",
    Component: WorkPanel,
  });

  client.addCommandCenterItem({
    id: "open-maestro",
    title: "Open Maestro",
    icon: "LayoutDashboard",
    keywords: ["work", "gate", "needs you"],
    context: "global",
    onSelect: ({ openSurface }) => openSurface("maestro"),
  });
  client.addCommandCenterItem({
    id: "new-work",
    title: "New Maestro work",
    icon: "Plus",
    keywords: ["work", "dispatch", "brief", "task"],
    context: "global",
    onSelect: ({ openSurface }) => {
      requestIntent({ kind: "new" });
      openSurface("maestro");
    },
  });
  client.addCommandCenterItem({
    id: "needs-you",
    title: "What needs you in Maestro",
    icon: "Inbox",
    keywords: ["gate", "review", "approve", "needs you"],
    context: "global",
    onSelect: ({ openSurface }) => {
      requestIntent({ kind: "filter", group: "review" });
      openSurface("maestro");
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

  const open = opener(client);

  // The card a run leaves in its session when it lands at your gate (server/gate-card.ts).
  client.addTimelineRenderer({
    kind: GATE_CARD_KIND,
    version: GATE_CARD_VERSION,
    schema: GateCardSchema,
    Component: createGateCard(open),
  });

  // The header count in every workspace and a pill beside every tracked session's composer.
  const integrations = startIntegrations(client, {
    pillIcon: (state) => PILL_ICONS[state],
    PillContent: createPillContent(open),
  });

  return () => {
    integrations.stop();
  };
}
