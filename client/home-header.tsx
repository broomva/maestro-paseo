// Maestro's own top header (J1, V1, P1; BRO-3035): the segmented tabs with their counts, the workspace
// menu, the presence pill and its menu, the next wake, search and New work. It sits inside Paseo's frame
// (R0), on every tab. The counts come from home-model.ts homeBadges and nothing here adds one.

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useState } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { runningOf } from "../shared/needs-you";
import type { TabBadge } from "./header-count";
import { HOME_TABS, type HomeTab, homeBadges, type WorkspaceOption, wakeChip, workspaceOptions } from "./home-model";
import { useLoop, useNeeds, useNotices, useWorkList } from "./hooks";
import { frostLook } from "./kit/assumptions";
import { Dot, MONO, TABULAR } from "./kit/parts";
import { type Kit, kitOf } from "./kit/tokens";
import {
  PRESENCE_FOR,
  PRESENCE_SIGNALS,
  PRESENCE_STATES,
  type PresenceRead,
  presenceFace,
  usePresence,
} from "./presence";
import { settingsOpener } from "./settings-link";
import { CHOICE_ROLE, focusRing, webAria } from "./ui";
import { useTick } from "./use-tick";

type Menu = "workspace" | "presence" | null;

const FIELD_HEIGHT = 36;

function badgeColor(kit: Kit, tab: HomeTab, badge: TabBadge): string {
  if (tab === "health") return kit.warn;
  if (tab === "work") return kit.muted;
  return badge.warn ? kit.needs : kit.muted;
}

function Tab({
  theme,
  tab,
  icon,
  label,
  badge,
  selected,
  onPress,
}: {
  theme: PluginTheme;
  tab: HomeTab;
  icon: string;
  label: string;
  badge: TabBadge | null;
  selected: boolean;
  onPress: () => void;
}) {
  const kit = kitOf(theme);
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      aria-selected={selected}
      accessibilityLabel={badge ? `${label}, ${badge.label}` : label}
      onPress={onPress}
      style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({
        ...focusRing(theme, focused),
        height: FIELD_HEIGHT - 6,
        paddingHorizontal: 8,
        borderRadius: 10,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        backgroundColor: selected ? kit.bg : "transparent",
        borderWidth: selected ? 1 : 0,
        borderColor: kit.hairline,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Icon name={icon} size={14} color={selected ? kit.fg : kit.muted} />
      <Text style={{ color: selected ? kit.fg : kit.fg2, fontSize: 13.5, fontWeight: selected ? "600" : "500" }}>
        {label}
      </Text>
      {badge ? (
        <Text style={{ color: badgeColor(kit, tab, badge), fontSize: 12, fontWeight: "700", ...TABULAR }}>
          {badge.count}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** A control in the header's right group: a pill with an icon or dot, a word and, for a menu, a chevron. */
function HeaderPill({
  theme,
  label,
  accessibilityLabel,
  lead,
  chevron,
  tone,
  expanded,
  onPress,
}: {
  theme: PluginTheme;
  label: string;
  accessibilityLabel: string;
  lead: ReactNode;
  chevron?: boolean;
  tone?: "ok" | "plain";
  expanded?: boolean;
  onPress: () => void;
}) {
  const kit = kitOf(theme);
  const ok = tone === "ok";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ expanded: expanded ?? false }}
      aria-expanded={expanded ?? false}
      onPress={onPress}
      style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({
        ...focusRing(theme, focused),
        height: FIELD_HEIGHT,
        paddingHorizontal: 10,
        borderRadius: 9999,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        borderWidth: 1,
        borderColor: ok ? kit.ok : kit.hairline,
        backgroundColor: ok ? `${kit.ok}1a` : kit.bg,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      {lead}
      <Text style={{ color: ok ? kit.ok : kit.fg, fontSize: 13.5, fontWeight: ok ? "600" : "500", ...TABULAR }}>
        {label}
      </Text>
      {chevron ? <Icon name="ChevronDown" size={13} color={ok ? kit.ok : kit.muted} /> : null}
    </Pressable>
  );
}

function Popover({ theme, children, width }: { theme: PluginTheme; children: ReactNode; width: number }) {
  const kit = kitOf(theme);
  return (
    <View
      accessibilityRole="menu"
      style={{
        position: "absolute",
        top: FIELD_HEIGHT + 8,
        right: 0,
        width,
        zIndex: 40,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: kit.hairline,
        backgroundColor: kit.bg,
        padding: 8,
        shadowColor: "#0c101a",
        shadowOpacity: kit.dark ? 0.5 : 0.14,
        shadowRadius: 28,
        shadowOffset: { width: 0, height: 10 },
      }}
    >
      {children}
    </View>
  );
}

export function WorkspaceMenu({
  theme,
  options,
  value,
  onChoose,
  width = 280,
}: {
  theme: PluginTheme;
  options: readonly WorkspaceOption[];
  value: string | null;
  onChoose: (id: string | null) => void;
  /** The popover's width: a phone gives it the room it has. */
  width?: number;
}) {
  const kit = kitOf(theme);
  return (
    <Popover theme={theme} width={width}>
      {options.map((option) => {
        const chosen = option.id === value;
        return (
          <Pressable
            key={option.id ?? "all"}
            role={CHOICE_ROLE}
            accessibilityLabel={option.label}
            accessibilityState={{ checked: chosen }}
            {...webAria({ "aria-checked": chosen })}
            onPress={() => onChoose(option.id)}
            style={({ pressed }: { pressed: boolean }) => ({
              minHeight: 36,
              paddingHorizontal: 10,
              borderRadius: 10,
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              backgroundColor: chosen || pressed ? kit.sunken : "transparent",
            })}
          >
            <Text
              style={{ flex: 1, color: kit.fg, fontSize: 13.5, fontWeight: chosen ? "600" : "400" }}
              numberOfLines={1}
            >
              {option.label}
            </Text>
            {option.holds > 0 ? (
              <Text style={{ color: kit.needs, fontSize: 12, fontWeight: "600", ...TABULAR }}>{option.holds}</Text>
            ) : null}
            {chosen ? <Icon name="Check" size={14} color={kit.fg} /> : null}
          </Pressable>
        );
      })}
    </Popover>
  );
}

/** P1: the presence menu. States are shown as the design has them; none is chosen until presence.set exists (BRO-2987). */
export function PresenceMenu({
  theme,
  presence,
  width = 356,
  onSettings,
}: {
  theme: PluginTheme;
  presence: PresenceRead;
  width?: number;
  /** Where Settings opens when the screen has its own (the phone's M11 card); else the host's Settings screen. */
  onSettings?: () => void;
}) {
  const kit = kitOf(theme);
  const openSettings = onSettings ?? settingsOpener();
  const tone = { present: kit.ok, away: kit.warn, off: kit.muted } as const;
  return (
    <Popover theme={theme} width={width}>
      <View style={{ padding: 8, gap: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text accessibilityRole="header" style={{ flex: 1, color: kit.fg, fontSize: 15, fontWeight: "600" }}>
            Presence
          </Text>
          <Text style={{ color: kit.muted, fontSize: 12 }}>
            {presence.from === "signals" ? "from signals" : "manual"}
          </Text>
        </View>
        {PRESENCE_STATES.map((entry) => {
          const chosen = entry.id === presence.state;
          return (
            <Pressable
              key={entry.id}
              role={CHOICE_ROLE}
              accessibilityLabel={`${entry.label}: ${entry.line}`}
              accessibilityState={{ checked: chosen, disabled: !presence.settable }}
              {...webAria({ "aria-checked": chosen })}
              disabled={!presence.settable}
              style={{
                flexDirection: "row",
                gap: 10,
                padding: 10,
                borderRadius: 12,
                backgroundColor: chosen ? kit.sunken : "transparent",
              }}
            >
              <View style={{ paddingTop: 6 }}>
                <Dot color={tone[entry.id]} size={8} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: kit.fg, fontSize: 14.5, fontWeight: "600" }}>{entry.label}</Text>
                <Text style={{ color: kit.muted, fontSize: 12.5, lineHeight: 17 }}>{entry.line}</Text>
              </View>
              {chosen ? <Icon name="Check" size={15} color={kit.fg} /> : null}
            </Pressable>
          );
        })}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ color: kit.muted, fontSize: 12 }}>For</Text>
          <View
            style={{ flex: 1, flexDirection: "row", padding: 2, borderRadius: 10, backgroundColor: kit.sunken, gap: 2 }}
          >
            {PRESENCE_FOR.map((entry, at) => (
              <View
                key={entry}
                style={{
                  flex: 1,
                  height: 28,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 8,
                  backgroundColor: at === PRESENCE_FOR.length - 1 ? kit.bg : "transparent",
                }}
              >
                <Text style={{ color: kit.fg2, fontSize: 12 }}>{entry}</Text>
              </View>
            ))}
          </View>
        </View>
        {presence.settable ? null : (
          <Text style={{ color: kit.warn, fontSize: 12, lineHeight: 16 }}>
            Choosing a state lands with BRO-2987. Until then Maestro reads you as present, from signals.
          </Text>
        )}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ flex: 1, color: kit.muted, fontSize: 12, lineHeight: 16 }}>{PRESENCE_SIGNALS}</Text>
          {openSettings ? (
            <Pressable accessibilityRole="link" accessibilityLabel="Settings" onPress={openSettings}>
              <Text style={{ color: kit.info, fontSize: 12.5, fontWeight: "500" }}>Settings ›</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </Popover>
  );
}

export interface HomeHeaderProps {
  theme: PluginTheme;
  tab: HomeTab;
  onTab: (tab: HomeTab) => void;
  badges: Record<HomeTab, TabBadge | null>;
  workspaces: readonly WorkspaceOption[];
  workspace: string | null;
  onWorkspace: (id: string | null) => void;
  /** Whether the workspace menu applies to this tab (the Feed's holds and rows; the other tabs keep their own scope). */
  workspaceApplies: boolean;
  presence: PresenceRead;
  /** The next wake as a few words ("18 min"); pressing it opens the loop's panel. */
  wake: string;
  wakeOpen: boolean;
  onWake: () => void;
  query: string;
  onQuery: (query: string) => void;
  onNew: () => void;
}

export function HomeHeader(props: HomeHeaderProps) {
  const { theme, presence } = props;
  const kit = kitOf(theme);
  const [menu, setMenu] = useState<Menu>(null);
  const toggle = (next: Exclude<Menu, null>) => setMenu((now) => (now === next ? null : next));
  const face = presenceFace(presence);
  const faceColor = face.tone === "ok" ? kit.ok : face.tone === "warn" ? kit.warn : kit.muted;
  const chosenWorkspace = props.workspaces.find((option) => option.id === props.workspace);
  const frosted = frostLook(Platform.OS) === "frost";
  return (
    <View
      accessibilityRole="header"
      testID="home-header"
      style={{
        zIndex: 30,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: kit.hairline,
        backgroundColor: kit.dark ? "rgba(24, 26, 32, 0.78)" : "rgba(255, 255, 255, 0.78)",
        ...(frosted ? ({ backdropFilter: "blur(18px) saturate(1.4)" } as object) : null),
        paddingVertical: 8,
        paddingHorizontal: 8,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
      }}
    >
      {menu ? (
        <Pressable
          accessibilityLabel="Close the menu"
          onPress={() => setMenu(null)}
          style={{ position: "absolute", top: -400, left: -2000, right: -2000, height: 4000, zIndex: 35 }}
        />
      ) : null}
      <View
        accessibilityRole="tablist"
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 2,
          padding: 3,
          borderRadius: 13,
          backgroundColor: kit.sunken,
        }}
      >
        {HOME_TABS.map((entry) => (
          <Tab
            key={entry.id}
            theme={theme}
            tab={entry.id}
            icon={entry.icon}
            label={entry.label}
            badge={props.badges[entry.id]}
            selected={entry.id === props.tab}
            onPress={() => {
              setMenu(null);
              props.onTab(entry.id);
            }}
          />
        ))}
      </View>
      <View style={{ flexGrow: 1, flexBasis: 0, minWidth: 0 }} />
      {props.workspaceApplies ? (
        <View style={{ zIndex: 38 }}>
          <HeaderPill
            theme={theme}
            label={chosenWorkspace?.label ?? "All workspaces"}
            accessibilityLabel={`Workspace: ${chosenWorkspace?.label ?? "all workspaces"}`}
            lead={<Icon name="Layers" size={14} color={kit.muted} />}
            chevron
            expanded={menu === "workspace"}
            onPress={() => toggle("workspace")}
          />
          {menu === "workspace" ? (
            <WorkspaceMenu
              theme={theme}
              options={props.workspaces}
              value={props.workspace}
              onChoose={(id) => {
                props.onWorkspace(id);
                setMenu(null);
              }}
            />
          ) : null}
        </View>
      ) : null}
      <View style={{ zIndex: 38 }}>
        <HeaderPill
          theme={theme}
          label={face.label}
          accessibilityLabel={`Presence: ${face.label}`}
          lead={<Dot color={faceColor} size={7} />}
          tone={face.tone === "ok" ? "ok" : "plain"}
          chevron
          expanded={menu === "presence"}
          onPress={() => toggle("presence")}
        />
        {menu === "presence" ? <PresenceMenu theme={theme} presence={presence} /> : null}
      </View>
      <HeaderPill
        theme={theme}
        label={props.wake}
        accessibilityLabel={`Next wake: ${props.wake}. ${props.wakeOpen ? "Hide" : "Show"} the loop`}
        lead={<Icon name="Timer" size={14} color={kit.muted} />}
        expanded={props.wakeOpen}
        onPress={props.onWake}
      />
      <View
        style={{
          flexGrow: 1,
          flexShrink: 1,
          flexBasis: 100,
          minWidth: 100,
          maxWidth: 240,
          height: FIELD_HEIGHT,
          borderRadius: 9999,
          borderWidth: 1,
          borderColor: kit.hairline,
          backgroundColor: kit.bg,
          paddingHorizontal: 12,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
        }}
      >
        <Icon name="Search" size={14} color={kit.muted} />
        <TextInput
          value={props.query}
          onChangeText={props.onQuery}
          placeholder="Search"
          placeholderTextColor={kit.muted}
          accessibilityLabel="Search work, ticket or branch"
          autoCorrect={false}
          autoCapitalize="none"
          style={{ flex: 1, color: kit.fg, fontSize: 13.5, paddingVertical: 0, outlineStyle: "none" } as object}
        />
        {props.query ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Clear the search" onPress={() => props.onQuery("")}>
            <Icon name="X" size={14} color={kit.muted} />
          </Pressable>
        ) : (
          <Text style={{ color: kit.muted, fontSize: 11, fontFamily: MONO }}>⌘F</Text>
        )}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New work"
        onPress={props.onNew}
        style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({
          ...focusRing(theme, focused),
          height: FIELD_HEIGHT,
          paddingHorizontal: 14,
          borderRadius: 9999,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          backgroundColor: kit.ink,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <Icon name="Plus" size={15} color={kit.onInk} />
        <Text style={{ color: kit.onInk, fontSize: 13.5, fontWeight: "600" }}>New work</Text>
      </Pressable>
    </View>
  );
}

/**
 * The header with its reads: the tabs' counts are needs.list's (homeBadges), the Work tab's the running work,
 * the Health tab's the rows the Feed lists, the workspace menu's holds are needs.list's rows by scope, and the
 * wake chip is the loop's next wake. Nothing here counts on its own.
 */
export function HomeHeaderBar({
  theme,
  tab,
  onTab,
  workspace,
  onWorkspace,
  query,
  onQuery,
  wakeOpen,
  onWake,
  onNew,
}: {
  theme: PluginTheme;
  tab: HomeTab;
  onTab: (tab: HomeTab) => void;
  workspace: string | null;
  onWorkspace: (id: string | null) => void;
  query: string;
  onQuery: (query: string) => void;
  wakeOpen: boolean;
  onWake: () => void;
  onNew: () => void;
}) {
  const needs = useNeeds();
  const list = useWorkList();
  const notices = useNotices();
  const loop = useLoop();
  const presence = usePresence();
  const now = useTick(15_000);
  const items = list.data?.items ?? [];
  const running = runningOf(items).length;
  // The Health tab says what the Feed's Health section lists, and J7 lists: notices.list's total.
  const health = notices.data?.summary.total ?? 0;
  return (
    <HomeHeader
      theme={theme}
      tab={tab}
      onTab={onTab}
      badges={homeBadges(needs.data ?? null, running, health)}
      workspaces={workspaceOptions(needs.data?.rows ?? [], items)}
      workspace={workspace}
      onWorkspace={onWorkspace}
      workspaceApplies={tab === "feed" || tab === "work" || tab === "decisions"}
      presence={presence}
      wake={wakeChip(loop.data ?? null, now)}
      wakeOpen={wakeOpen}
      onWake={onWake}
      query={query}
      onQuery={onQuery}
      onNew={onNew}
    />
  );
}
