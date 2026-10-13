// What sits beside a deck's title (M1: "Needs you  [All v] [Present]"): the workspace filter and presence, each a
// 30 pt chip with the same menu the desktop header opens (client/home-header.tsx). The workspace and presence
// stay in the deck's header, in thumb reach, so there is no title menu (M1).

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { PresenceMenu, WorkspaceMenu } from "../home-header";
import type { WorkspaceOption } from "../home-model";
import { Dot, TABULAR } from "../kit/parts";
import { kitOf } from "../kit/tokens";
import { type PresenceRead, presenceFace } from "../presence";
import { focusRing } from "../ui";

type Menu = "workspace" | "presence" | null;

function Chip({
  theme,
  label,
  accessibilityLabel,
  lead,
  expanded,
  ok,
  onPress,
}: {
  theme: PluginTheme;
  label: string;
  accessibilityLabel: string;
  lead: ReactNode;
  expanded: boolean;
  ok?: boolean;
  onPress: () => void;
}) {
  const kit = kitOf(theme);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ expanded }}
      onPress={onPress}
      hitSlop={{ top: 7, bottom: 7 }}
      style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({
        ...focusRing(theme, focused),
        height: 30,
        paddingHorizontal: 10,
        borderRadius: 9999,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        backgroundColor: ok ? `${kit.ok}1a` : kit.control,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      {lead}
      <Text style={{ color: ok ? kit.ok : kit.fg, fontSize: 13, fontWeight: ok ? "600" : "500", ...TABULAR }}>
        {label}
      </Text>
      <Icon name="ChevronDown" size={12} color={ok ? kit.ok : kit.muted} />
    </Pressable>
  );
}

export function DeckHeader({
  theme,
  workspaces,
  workspace,
  onWorkspace,
  presence,
  width,
  onSettings,
}: {
  theme: PluginTheme;
  workspaces: readonly WorkspaceOption[];
  workspace: string | null;
  onWorkspace: (id: string | null) => void;
  presence: PresenceRead;
  /** The room the menus have: a phone's width less its margins. */
  width: number;
  /** Settings, from the presence menu's foot (M11): the screen opens its own card. */
  onSettings?: () => void;
}) {
  const kit = kitOf(theme);
  const [menu, setMenu] = useState<Menu>(null);
  const face = presenceFace(presence);
  const toggle = (next: Exclude<Menu, null>) => setMenu((now) => (now === next ? null : next));
  const room = Math.max(240, Math.min(356, width));
  return (
    <View style={{ flexDirection: "row", gap: 6, zIndex: 40 }}>
      <Chip
        theme={theme}
        label={workspace ?? "All"}
        accessibilityLabel={`Workspace: ${workspace ?? "all workspaces"}. Change workspace`}
        lead={<Icon name="Layers" size={13} color={kit.muted} />}
        expanded={menu === "workspace"}
        onPress={() => toggle("workspace")}
      />
      <Chip
        theme={theme}
        label={face.label}
        accessibilityLabel={`Presence: ${face.label}. Change presence`}
        lead={<Dot color={face.tone === "ok" ? kit.ok : face.tone === "warn" ? kit.warn : kit.muted} size={7} />}
        ok={face.tone === "ok"}
        expanded={menu === "presence"}
        onPress={() => toggle("presence")}
      />
      {menu === "workspace" ? (
        <WorkspaceMenu
          theme={theme}
          options={workspaces}
          value={workspace}
          width={room}
          onChoose={(id) => {
            onWorkspace(id);
            setMenu(null);
          }}
        />
      ) : null}
      {menu === "presence" ? (
        <PresenceMenu
          theme={theme}
          presence={presence}
          width={room}
          onSettings={
            onSettings
              ? () => {
                  setMenu(null);
                  onSettings();
                }
              : undefined
          }
        />
      ) : null}
    </View>
  );
}
