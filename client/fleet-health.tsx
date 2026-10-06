// The cockpit's first screen: the health band (a verdict and one tick strip
// per scope, with its time axis and legend) and the KPI tiles that filter the
// roster. Every cell carries its own words, and failed, missed and unknown
// cells a glyph: color is never the only cue.

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  CELL_GLYPH,
  CELL_LEGEND,
  type Cell,
  type CellKind,
  cellAxis,
  type RosterFilter,
  type Verdict,
} from "./fleet-cockpit-model";
import { infoInk, Kpi, ramp, type Tone, tint, toneInk } from "./fleet-ui";
import { radius, space } from "./ui";

export function cellColor(theme: PluginTheme, kind: CellKind): string {
  switch (kind) {
    case "passed":
      return theme.colors.statusSuccess;
    case "missed":
      return theme.colors.statusWarning;
    case "failed":
      return theme.colors.statusDanger;
    case "running":
      return infoInk(theme);
    case "unknown":
      return theme.colors.foregroundMuted;
    default:
      return theme.colors.surface2;
  }
}

/**
 * A cell's paint. Running is an outline with a light fill, missed a dashed
 * outline, no exit a muted fill: each reads by shape as well as color.
 */
export function cellStyle(theme: PluginTheme, kind: CellKind, height: number) {
  const outlined = kind === "running" || kind === "missed";
  const color = cellColor(theme, kind);
  return {
    flex: 1,
    height,
    borderRadius: 4,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    backgroundColor: outlined ? tint(color, 0.22) : kind === "unknown" ? tint(color, 0.35) : color,
    borderWidth: outlined ? 1.5 : 0,
    borderStyle: kind === "missed" ? ("dashed" as const) : ("solid" as const),
    borderColor: color,
  };
}

/** A cell's glyph (× failed, ! missed, ? no exit), drawn over its paint. */
function Glyph({ theme, kind, size }: { theme: PluginTheme; kind: CellKind; size: number }) {
  const glyph = CELL_GLYPH[kind];
  if (!glyph) return null;
  const ink = kind === "failed" ? "#ffffff" : kind === "missed" ? theme.colors.statusWarning : theme.colors.foreground;
  return (
    <Text style={{ color: ink, fontSize: size, lineHeight: size + 2, fontWeight: "800" }} accessible={false}>
      {glyph}
    </Text>
  );
}

/**
 * One scope's strip: a cell per tick, oldest on the left. On the desktop a
 * cell is 24 tall with 8 above and below to press (40 in all), and opens its
 * tick; the cells' sides never overlap.
 */
export function TickStrip({
  theme,
  cells,
  phone,
  onOpen,
}: {
  theme: PluginTheme;
  cells: readonly Cell[];
  phone: boolean;
  onOpen?: (tick: number) => void;
}) {
  const height = phone ? 18 : 24;
  return (
    <View style={{ flexDirection: "row", gap: phone ? 2 : 3 }}>
      {cells.map((cell, index) => {
        const style = cellStyle(theme, cell.kind, height);
        const key = cell.tick ?? `empty-${index}`;
        const glyph = <Glyph theme={theme} kind={cell.kind} size={phone ? 10 : 12} />;
        if (cell.tick !== null && onOpen && !phone) {
          const tick = cell.tick;
          return (
            <Pressable
              key={key}
              accessibilityRole="button"
              accessibilityLabel={cell.label}
              hitSlop={{ top: 8, bottom: 8 }}
              onPress={() => onOpen(tick)}
              style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => [
                style,
                { opacity: pressed ? 0.7 : 1 },
                focused
                  ? { outlineWidth: 2, outlineStyle: "solid" as const, outlineColor: "rgba(128, 160, 255, 0.95)" }
                  : null,
              ]}
            >
              {glyph}
            </Pressable>
          );
        }
        return (
          <View key={key} style={style} accessible accessibilityRole="image" accessibilityLabel={cell.label}>
            {glyph}
          </View>
        );
      })}
    </View>
  );
}

/** The legend: a swatch (with its glyph) and a word for every kind a strip can show. */
export function CellLegend({ theme, phone }: { theme: PluginTheme; phone: boolean }) {
  const t = ramp(theme);
  return (
    <View
      style={{ flexDirection: "row", gap: phone ? space[2] : space[3], flexWrap: "wrap" }}
      accessibilityLabel="Legend"
    >
      {CELL_LEGEND.map((entry) => (
        <View key={entry.kind} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <View style={{ ...cellStyle(theme, entry.kind, 12), flex: undefined, width: 12, borderRadius: 3 }}>
            <Glyph theme={theme} kind={entry.kind} size={8} />
          </View>
          <Text style={[t.meta, { fontSize: 11 }]}>{entry.label}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The health band: the verdict on the left (an icon, a title, a sentence),
 * and on the right a strip per scope with the time axis and the legend under
 * it. A scope that could not be read says so in place of its strip. On the
 * phone it folds to the title, one strip per scope and the legend.
 */
export function HealthBand({
  theme,
  phone,
  wide,
  verdict,
  strips,
  badge,
  meta,
  onOpenTick,
  relation = null,
}: {
  theme: PluginTheme;
  phone: boolean;
  wide: boolean;
  verdict: Verdict;
  strips: readonly { scope: string; cells: readonly Cell[]; error?: string | null }[];
  /** On the phone, the mode badge sits in the card. */
  badge?: string | null;
  meta?: string | null;
  onOpenTick: (scope: string, tick: number) => void;
  /**
   * The header's count beside the fleet's part of it: `2 need you here · 5 in all (3 in Work)`, each other
   * surface pressable to its view. Null until the header's read is in.
   */
  relation?: {
    here: number;
    all: number;
    elsewhere: readonly { label: string; count: number; onPress: () => void }[];
  } | null;
}) {
  const t = ramp(theme);
  const ink = toneInk(theme, verdict.tone as Tone);
  const relationLine =
    relation && relation.all > 0 ? (
      <Text style={[t.muted, t.tabular]} accessibilityLabel={`${relation.here} need you here, ${relation.all} in all`}>
        <Text style={[t.body, { fontWeight: "600" }]}>{`${relation.here} need you here`}</Text>
        {` · ${relation.all} in all`}
        {relation.elsewhere.length > 0 ? " (" : ""}
        {relation.elsewhere.map((entry, index) => (
          <Text key={entry.label}>
            {index > 0 ? ", " : ""}
            <Text
              accessibilityRole="link"
              accessibilityLabel={`${entry.count} in ${entry.label}: open ${entry.label}`}
              onPress={entry.onPress}
              style={{ textDecorationLine: "underline" }}
            >
              {`${entry.count} in ${entry.label}`}
            </Text>
          </Text>
        ))}
        {relation.elsewhere.length > 0 ? ")" : ""}
      </Text>
    ) : null;
  const axis = cellAxis(strips.find((strip) => !strip.error)?.cells ?? []);
  const head = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
      <View
        style={{
          width: phone ? 24 : 28,
          height: phone ? 24 : 28,
          borderRadius: 28,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: tint(ink, 0.16),
        }}
      >
        <Icon name={verdict.icon} size={phone ? 14 : 16} color={ink} />
      </View>
      <Text style={[phone ? t.cardTitle : t.title, { flex: 1 }]} accessibilityRole="header" numberOfLines={3}>
        {verdict.title}
      </Text>
      {phone && badge ? (
        <View
          style={{
            paddingHorizontal: space[2],
            height: 22,
            borderRadius: radius.pill,
            justifyContent: "center",
            borderWidth: 1,
            borderColor: theme.colors.border,
          }}
        >
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{badge}</Text>
        </View>
      ) : null}
    </View>
  );
  const stripsView = (
    <View style={{ gap: phone ? space[2] : space[3], flex: wide ? 1.6 : undefined }}>
      {strips.map((strip) => (
        <View
          key={strip.scope}
          style={{
            flexDirection: wide ? "row" : "column",
            alignItems: wide ? "center" : "stretch",
            gap: wide ? space[3] : space[1],
          }}
        >
          {strips.length > 1 || !phone ? (
            <Text
              style={[t.meta, { fontWeight: "600", color: theme.colors.foreground, width: wide ? 64 : undefined }]}
              numberOfLines={1}
            >
              {strip.scope}
            </Text>
          ) : null}
          <View style={{ flex: wide ? 1 : undefined }}>
            {strip.error ? (
              <View
                accessibilityRole="alert"
                style={{
                  minHeight: phone ? 18 : 24,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space[2],
                  paddingHorizontal: space[2],
                  borderRadius: 4,
                  borderWidth: 1.5,
                  borderStyle: "dashed",
                  borderColor: theme.colors.statusDanger,
                }}
              >
                <Icon name="EyeOff" size={12} color={theme.colors.statusDanger} />
                <Text style={[t.meta, { color: theme.colors.statusDanger, flex: 1 }]} numberOfLines={2}>
                  {`Can't read ${strip.scope}: ${strip.error}`}
                </Text>
              </View>
            ) : (
              <TickStrip
                theme={theme}
                cells={strip.cells}
                phone={phone}
                onOpen={(tick) => onOpenTick(strip.scope, tick)}
              />
            )}
          </View>
        </View>
      ))}
      <View style={{ paddingLeft: wide ? 64 + space[3] : 0, gap: space[1] }}>
        {phone ? null : (
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            {axis.map((word) => (
              <Text key={word} style={[t.meta, t.tabular, { fontSize: 11 }]}>
                {word}
              </Text>
            ))}
          </View>
        )}
        <CellLegend theme={theme} phone={phone} />
      </View>
    </View>
  );
  return (
    <View
      style={{
        padding: phone ? space[3] : space[5],
        gap: phone ? space[3] : space[4],
        flexDirection: wide ? "row" : "column",
        borderRadius: radius.card + 4,
        borderWidth: 1,
        borderColor: verdict.tone === "danger" || verdict.tone === "warn" ? tint(ink, 0.6) : theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
      accessibilityRole="summary"
    >
      <View style={{ gap: space[2], flex: wide ? 1 : undefined }}>
        {head}
        {relationLine}
        {phone ? null : <Text style={t.muted}>{verdict.sentence}</Text>}
      </View>
      {stripsView}
      {phone && meta ? <Text style={[t.meta, t.tabular]}>{meta}</Text> : null}
    </View>
  );
}

export interface KpiValue {
  id: "needs" | RosterFilter;
  label: string;
  value: number;
  sub: string | null;
  tone: Tone;
  quiet?: boolean;
}

/**
 * The KPI tiles. *Needs you* jumps to the queue; every other tile filters the
 * roster to exactly what it counts (pressed again, back to all) and brings
 * the roster into view.
 */
export function KpiRow({
  theme,
  phone,
  tiles,
  selected,
  onPress,
}: {
  theme: PluginTheme;
  phone: boolean;
  tiles: readonly KpiValue[];
  selected: string | null;
  onPress: (id: KpiValue["id"]) => void;
}) {
  const tile = (entry: KpiValue) => (
    <Kpi
      key={entry.id}
      theme={theme}
      label={entry.label}
      value={entry.value}
      sub={entry.sub}
      tone={entry.tone}
      quiet={entry.quiet}
      phone={phone}
      jumps={entry.id === "needs"}
      selected={selected === entry.id}
      accessibilityLabel={`${entry.label}: ${entry.value}${entry.sub ? `, ${entry.sub}` : ""}. ${
        entry.id === "needs"
          ? "Go to Needs you"
          : selected === entry.id
            ? "Filtering the sessions"
            : "Show these sessions"
      }`}
      onPress={() => onPress(entry.id)}
    />
  );
  if (phone) {
    // Every tile on the phone too: a row that scrolls sideways, never one silently dropped.
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityLabel="Fleet counts"
        contentContainerStyle={{ gap: space[2], paddingRight: space[2] }}
      >
        {tiles.map(tile)}
      </ScrollView>
    );
  }
  return <View style={{ flexDirection: "row", gap: space[3], flexWrap: "wrap" }}>{tiles.map(tile)}</View>;
}
