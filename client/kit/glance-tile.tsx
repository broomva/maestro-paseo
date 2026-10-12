// The glance tile (J1's four tiles; M/Tile on the phone): an icon and label, a
// number with its unit, a line of context, and the whole tile a tap target.
// Tinted only for Needs you (Tidepool) or late and stranded (warn); every
// other tile is plain (client/kit/tile-model.ts). `children` takes a tile's
// extra line, such as Running's session rows or the unsupervised bars.

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { focusRing } from "../ui";
import { TABULAR } from "./parts";
import { type TileTone, tileLook } from "./tile-model";
import { kitOf } from "./tokens";

export function GlanceTile({
  theme,
  icon,
  label,
  value,
  unit,
  line,
  tone = "plain",
  onPress,
  selected = false,
  compact = false,
  lines = 2,
  children,
}: {
  theme: PluginTheme;
  icon: string;
  label: string;
  value: string;
  unit?: string;
  line?: string;
  tone?: TileTone;
  onPress?: () => void;
  selected?: boolean;
  /** The phone's 172 pt tile (M/Tile); the desktop's is wider and its number larger. */
  compact?: boolean;
  /** How many lines the context line may take before it is cut: a tile that says what to do about its number takes three. */
  lines?: number;
  children?: ReactNode;
}) {
  const kit = kitOf(theme);
  const look = tileLook(kit, tone);
  const accessibilityLabel = [label, value, unit, line].filter(Boolean).join(", ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected }}
      disabled={!onPress}
      onPress={onPress}
      testID={`glance-tile-${tone}`}
      style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({
        ...focusRing(theme, focused),
        flex: 1,
        minWidth: compact ? 150 : 200,
        minHeight: compact ? 96 : 124,
        borderRadius: 16,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? kit.needs : look.border,
        backgroundColor: look.fill,
        paddingVertical: compact ? 12 : 16,
        paddingHorizontal: compact ? 14 : 18,
        gap: compact ? 3 : 6,
        shadowColor: "#0c101a",
        shadowOpacity: look.tinted ? 0 : 0.06,
        shadowRadius: 3,
        shadowOffset: { width: 0, height: 1 },
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name={icon} size={compact ? 13 : 15} color={look.tinted ? look.label : kit.muted} />
        <Text numberOfLines={1} style={{ color: look.label, fontSize: compact ? 12 : 13, fontWeight: "600" }}>
          {label}
        </Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 6 }}>
        <Text
          style={{
            color: kit.fg,
            fontSize: compact ? 26 : 30,
            lineHeight: compact ? 29 : 34,
            fontWeight: "600",
            ...TABULAR,
          }}
        >
          {value}
        </Text>
        {unit ? <Text style={{ color: kit.muted, fontSize: 12, paddingBottom: 3 }}>{unit}</Text> : null}
      </View>
      {line ? (
        <Text
          numberOfLines={lines}
          style={{ color: kit.fg2, fontSize: compact ? 11.5 : 12.5, lineHeight: compact ? 16 : 18 }}
        >
          {line}
        </Text>
      ) : null}
      {children}
    </Pressable>
  );
}
