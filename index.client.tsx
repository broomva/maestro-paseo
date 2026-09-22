import type { PluginClientContext } from "@getpaseo/plugin/client";
import { WorkPanel } from "./client/agent-panel";
import { MaestroSurface } from "./client/plane";
import { MaestroSettings } from "./client/settings";
import { adoptAgent } from "./shared/contracts";
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

  return () => {};
}
