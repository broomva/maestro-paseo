// The plane's controls: the view switch (tabs in two labelled groups, Work and
// System, on a wide window; one view picker on a phone), the
// initiative scope and the state filter (toggle chips: pressing the active one
// clears it). Chips carry a label and a count; a dot never stands alone.

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Group, OrchState } from "../shared/states";
import {
  type Filter,
  filterLabel,
  groupedViews,
  type Initiative,
  type PlaneView,
  scopeLabel,
  VIEW_GROUPS,
  VIEWS,
  type ViewOption,
} from "./plane-model";
import { radius, StateDot, size, space, webAria } from "./ui";

// A representative state per group, for the chip's dot.
const GROUP_DOT: Record<Group, OrchState> = {
  review: "review",
  blocked: "blocked",
  running: "running",
  queued: "proposed",
  done: "done",
};

/** A view's badge on the switch: a count, in the warn tone when something waits on you, and its words for a screen reader. */
export type ViewBadge = { count: number; warn: boolean; label: string };

function BadgeCount({ theme, badge, selected }: { theme: PluginTheme; badge: ViewBadge; selected: boolean }) {
  return (
    <View
      style={{
        minWidth: 20,
        height: 18,
        paddingHorizontal: 6,
        borderRadius: radius.pill,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: badge.warn
          ? theme.colors.statusWarning
          : selected
            ? theme.colors.surface1
            : theme.colors.surface2,
      }}
    >
      <Text
        style={{
          color: badge.warn ? theme.colors.surface0 : theme.colors.foregroundMuted,
          fontSize: 11,
          fontWeight: "700",
          fontVariant: ["tabular-nums"],
        }}
      >
        {badge.count}
      </Text>
    </View>
  );
}

/** A view's name for a screen reader: its label, and its badge's words when it has one. */
export function viewLabel(option: ViewOption, badge?: ViewBadge | null): string {
  return badge ? `${option.label}, ${badge.label}` : option.label;
}

/**
 * The view switch on a wide window: two labelled groups, Work (Feed, Board,
 * List, History) and System (Fleet, Decisions, Timeline, Initiatives), as tabs.
 */
export function ViewSwitch({
  theme,
  view,
  onView,
  views = VIEWS,
  badges = {},
}: {
  theme: PluginTheme;
  view: PlaneView;
  onView: (view: PlaneView) => void;
  views?: readonly ViewOption[];
  badges?: Partial<Record<PlaneView, ViewBadge | null>>;
}) {
  const groups = groupedViews(views);
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: "row",
        alignItems: "center",
        flexWrap: "wrap",
        rowGap: space[2],
        columnGap: space[4],
        paddingBottom: space[3],
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      {groups.map((group, at) => (
        <View
          key={group.group}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 2,
            paddingLeft: at > 0 ? space[4] : 0,
            borderLeftWidth: at > 0 ? 1 : 0,
            borderLeftColor: theme.colors.border,
          }}
        >
          <Text
            accessibilityRole="header"
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 11,
              fontWeight: "600",
              letterSpacing: 0.6,
              marginRight: space[2],
            }}
          >
            {group.label.toUpperCase()}
          </Text>
          {group.views.map((option) => {
            const selected = option.id === view;
            const ink = selected ? theme.colors.foreground : theme.colors.foregroundMuted;
            const badge = badges[option.id] ?? null;
            return (
              <Pressable
                key={option.id}
                accessibilityRole="tab"
                aria-selected={selected}
                accessibilityLabel={viewLabel(option, badge)}
                onPress={() => onView(option.id)}
                style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space[2],
                  minHeight: 32,
                  paddingHorizontal: space[2] + 2,
                  borderRadius: radius.control,
                  backgroundColor: selected || pressed || hovered ? theme.colors.surface2 : "transparent",
                })}
              >
                <Icon name={option.icon} size={14} color={ink} />
                <Text style={{ color: ink, fontSize: size.sm, fontWeight: selected ? "600" : "500" }}>
                  {option.label}
                </Text>
                {badge ? <BadgeCount theme={theme} badge={badge} selected={selected} /> : null}
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

export function Chip({
  theme,
  label,
  count,
  badge = 0,
  dot,
  selected,
  accessibilityLabel,
  onPress,
}: {
  theme: PluginTheme;
  label: string;
  count?: string;
  badge?: number;
  dot?: OrchState;
  selected: boolean;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      {...webAria({ "aria-pressed": selected })}
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: space[1],
        minHeight: 30,
        paddingHorizontal: space[3],
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        backgroundColor: selected || pressed ? theme.colors.surface2 : "transparent",
      })}
    >
      {dot ? <StateDot theme={theme} state={dot} dim={7} still /> : null}
      <Text style={{ color: theme.colors.foreground, fontSize: size.xs, fontWeight: "600" }}>{label}</Text>
      {count ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: size.xs, fontVariant: ["tabular-nums"] }}>
          {count}
        </Text>
      ) : null}
      {badge > 0 ? (
        <View
          style={{
            minWidth: 18,
            height: 18,
            paddingHorizontal: 5,
            borderRadius: radius.pill,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.colors.accent,
          }}
        >
          <Text style={{ color: theme.colors.accentForeground, fontSize: 11, fontWeight: "700" }}>{badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

export function ScopeRow({
  theme,
  initiatives,
  scope,
  onScope,
}: {
  theme: PluginTheme;
  initiatives: Initiative[];
  scope: string | null;
  onScope: (scope: string | null) => void;
}) {
  return (
    <View
      accessibilityRole="toolbar"
      accessibilityLabel="Initiatives"
      style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}
    >
      <Icon name="Layers" size={14} color={theme.colors.foregroundMuted} />
      <Chip
        theme={theme}
        label="All work"
        selected={scope === null}
        accessibilityLabel="All work"
        onPress={() => onScope(null)}
      />
      {initiatives.map((initiative) => (
        <Chip
          key={initiative.name}
          theme={theme}
          label={initiative.name}
          count={`${initiative.open}/${initiative.total}`}
          badge={initiative.needsYou}
          selected={scope === initiative.name}
          accessibilityLabel={scopeLabel(initiative)}
          onPress={() => onScope(scope === initiative.name ? null : initiative.name)}
        />
      ))}
    </View>
  );
}

export function FilterRow({
  theme,
  filters,
  counts,
  filter,
  onFilter,
}: {
  theme: PluginTheme;
  filters: Filter[];
  counts: Record<Filter, number>;
  filter: Filter;
  onFilter: (filter: Filter) => void;
}) {
  return (
    <View
      accessibilityRole="toolbar"
      accessibilityLabel="Filter by state"
      style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}
    >
      {filters.map((option) => (
        <Chip
          key={option}
          theme={theme}
          label={filterLabel(option)}
          count={String(counts[option])}
          dot={option === "all" ? undefined : GROUP_DOT[option]}
          selected={option === filter}
          accessibilityLabel={`${filterLabel(option)}, ${counts[option]}`}
          onPress={() => onFilter(option === filter ? "all" : option)}
        />
      ))}
    </View>
  );
}
