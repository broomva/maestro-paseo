// The plane's controls: the Feed / Board / List switch, the initiative scope
// and the state filter. Chips carry a label and a count; a dot never stands
// alone.

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import type { Group, OrchState } from "../shared/states";
import { type Filter, filterLabel, type Initiative, type PlaneView, scopeLabel, VIEWS } from "./plane-model";
import { radius, StateDot, size, space } from "./ui";

// A representative state per group, for the chip's dot.
const GROUP_DOT: Record<Group, OrchState> = {
  review: "review",
  blocked: "blocked",
  running: "running",
  queued: "proposed",
  done: "done",
};

export function ViewSwitch({
  theme,
  view,
  onView,
}: {
  theme: PluginTheme;
  view: PlaneView;
  onView: (view: PlaneView) => void;
}) {
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: "row",
        alignSelf: "flex-start",
        padding: 2,
        gap: 2,
        borderRadius: radius.control,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      {VIEWS.map((option) => {
        const selected = option.id === view;
        const ink = selected ? theme.colors.foreground : theme.colors.foregroundMuted;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="tab"
            aria-selected={selected}
            accessibilityLabel={option.label}
            onPress={() => onView(option.id)}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: space[1],
              minHeight: 30,
              paddingHorizontal: space[3],
              borderRadius: radius.control - 2,
              backgroundColor: selected ? theme.colors.surface2 : pressed ? theme.colors.surface2 : "transparent",
            })}
          >
            <Icon name={option.icon} size={14} color={ink} />
            <Text style={{ color: ink, fontSize: size.xs, fontWeight: "600" }}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Chip({
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
      accessibilityRole="radio"
      aria-checked={selected}
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
      accessibilityRole="radiogroup"
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
      accessibilityRole="radiogroup"
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
