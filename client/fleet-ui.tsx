// The Fleet cockpit's own primitives (BRO-2837): a press that scales to 0.96,
// buttons with one primary per section, status pills that pair color with a
// word, a segmented control, KPI tiles, the tick strip and a row menu. Paseo
// theme tokens only; motion goes still under reduced motion. No classes: the
// bundle must parse under Hermes (client/hermes.test.ts).

import type { PluginTheme } from "@getpaseo/plugin";
import * as kit from "@getpaseo/plugin/client/react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Platform,
  Pressable,
  type StyleProp,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import { infoFor, isDarkSurface, tint } from "./fleet-color";
import { radius, size, space, useReducedMotion, webAria } from "./ui";

export type Tone = "danger" | "warn" | "success" | "muted" | "accent" | "info";

/** Whether the theme is dark: its base surface's luminance, in any color form (client/fleet-color.ts). */
export function isDark(theme: PluginTheme): boolean {
  return isDarkSurface(theme.colors.surface0);
}

/**
 * Info blue: what is running, and nothing else. The one color not from the
 * theme: Paseo has no info token, and its accent can be the success green.
 */
export function infoInk(theme: PluginTheme): string {
  return infoFor(theme.colors.surface0);
}

export function toneInk(theme: PluginTheme, tone: Tone): string {
  switch (tone) {
    case "danger":
      return theme.colors.statusDanger;
    case "warn":
      return theme.colors.statusWarning;
    case "success":
      return theme.colors.statusSuccess;
    case "accent":
      return theme.colors.accent;
    case "info":
      return infoInk(theme);
    default:
      return theme.colors.foregroundMuted;
  }
}

/** The focus ring: visible on either theme, outside the control so it never shifts its layout. */
const RING: ViewStyle = {
  outlineWidth: 2,
  outlineStyle: "solid",
  outlineColor: "rgba(128, 160, 255, 0.95)",
  outlineOffset: 2,
};

export { tint };

/** The cockpit's type ramp: title 22/700, section 16/700, card title 15/600, body 13, meta 12. */
export function ramp(theme: PluginTheme) {
  const ink = theme.colors.foreground;
  const muted = theme.colors.foregroundMuted;
  return {
    title: { color: ink, fontSize: size.xl, lineHeight: 28, fontWeight: "700" } as TextStyle,
    section: { color: ink, fontSize: size.base, lineHeight: 22, fontWeight: "700" } as TextStyle,
    cardTitle: { color: ink, fontSize: 15, lineHeight: 20, fontWeight: "600" } as TextStyle,
    body: { color: ink, fontSize: 13, lineHeight: 19 } as TextStyle,
    muted: { color: muted, fontSize: 13, lineHeight: 19 } as TextStyle,
    meta: { color: muted, fontSize: 12, lineHeight: 16 } as TextStyle,
    label: { color: muted, fontSize: 11, lineHeight: 14, fontWeight: "600", letterSpacing: 0.4 } as TextStyle,
    number: { color: ink, fontSize: 28, lineHeight: 32, fontWeight: "700", fontVariant: ["tabular-nums"] } as TextStyle,
    mono: {
      color: ink,
      fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, monospace" }),
      fontSize: 12,
      lineHeight: 17,
    } as TextStyle,
    tabular: { fontVariant: ["tabular-nums"] } as TextStyle,
  };
}

/**
 * A pressable. Only a button (`scale`) scales to 0.96 while held (120 ms,
 * native driver off the web), still under reduced motion; tiles, tabs, rows
 * and menu items answer a press with their background instead. Every one
 * shows a focus ring while focused. `style` paints the surface; `outer` sizes
 * it in its parent's layout.
 */
export function Press({
  onPress,
  accessibilityLabel,
  accessibilityRole = "button",
  accessibilityState,
  selected,
  disabled = false,
  scale: scales = false,
  ring = radius.control,
  hitSlop,
  style,
  outer,
  children,
}: {
  onPress: () => void;
  accessibilityLabel?: string;
  accessibilityRole?: "button" | "link" | "tab" | "menuitem" | "radio";
  accessibilityState?: {
    selected?: boolean;
    disabled?: boolean;
    busy?: boolean;
    expanded?: boolean;
    checked?: boolean;
  };
  selected?: boolean;
  disabled?: boolean;
  /** A button: it scales while held. */
  scale?: boolean;
  /** The control's own corner radius: the focus ring follows it, offset outside (concentric). */
  ring?: number;
  hitSlop?: number | { top?: number; bottom?: number; left?: number; right?: number };
  style?: StyleProp<ViewStyle> | ((pressed: boolean) => StyleProp<ViewStyle>);
  outer?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const [focused, setFocused] = useState(false);
  const to = (value: number) => {
    if (reduced || !scales) return;
    Animated.timing(scale, {
      toValue: value,
      duration: 120,
      easing: Easing.out(Easing.quad),
      useNativeDriver: Platform.OS !== "web",
    }).start();
  };
  return (
    <Pressable
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ ...accessibilityState, ...(selected === undefined ? {} : { selected }), disabled }}
      {...(selected === undefined ? {} : webAria({ "aria-pressed": selected }))}
      disabled={disabled}
      hitSlop={hitSlop}
      onPress={onPress}
      onPressIn={() => to(0.96)}
      onPressOut={() => to(1)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={[outer, focused ? RING : null, focused ? { borderRadius: ring } : null]}
    >
      {({ pressed }) =>
        scales ? (
          <Animated.View style={[typeof style === "function" ? style(pressed) : style, { transform: [{ scale }] }]}>
            {children}
          </Animated.View>
        ) : (
          <View style={typeof style === "function" ? style(pressed) : style}>{children}</View>
        )
      }
    </Pressable>
  );
}

export type Weight = "primary" | "secondary" | "quiet" | "danger";

/**
 * A verb. One primary per section; `phone` makes it 44 pt tall, the desktop's
 * 34 visible with a hit area of at least 40.
 */
export function Verb({
  theme,
  label,
  onPress,
  weight = "secondary",
  icon,
  busy = false,
  disabled = false,
  phone = false,
  grow = false,
  accessibilityLabel,
}: {
  theme: PluginTheme;
  label: string;
  onPress: () => void;
  weight?: Weight;
  icon?: string;
  busy?: boolean;
  disabled?: boolean;
  phone?: boolean;
  grow?: boolean;
  accessibilityLabel?: string;
}) {
  const inactive = disabled || busy;
  const fill =
    weight === "primary" ? theme.colors.accent : weight === "secondary" ? theme.colors.surface2 : "transparent";
  const ink =
    weight === "primary"
      ? theme.colors.accentForeground
      : weight === "danger"
        ? theme.colors.statusDanger
        : weight === "quiet"
          ? theme.colors.foregroundMuted
          : theme.colors.foreground;
  return (
    <Press
      onPress={onPress}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ busy }}
      disabled={inactive}
      scale
      hitSlop={phone ? undefined : 3}
      outer={grow ? { flexGrow: 1, flexBasis: 0 } : undefined}
      style={(pressed) => ({
        minHeight: phone ? 44 : 34,
        paddingHorizontal: weight === "quiet" ? space[2] : space[3],
        borderRadius: radius.control,
        backgroundColor: pressed && weight !== "primary" ? theme.colors.surface2 : fill,
        borderWidth: weight === "secondary" ? 1 : 0,
        borderColor: theme.colors.border,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: space[2],
        opacity: inactive ? 0.5 : 1,
      })}
    >
      {busy ? <ActivityIndicator size="small" color={ink} /> : icon ? <Icon name={icon} size={15} color={ink} /> : null}
      <Text style={{ color: ink, fontSize: 13, fontWeight: "600" }} numberOfLines={1}>
        {label}
      </Text>
    </Press>
  );
}

/**
 * A status pill: a dot and its word on a tint of its color; color never
 * stands alone. `outline` is the neutral treatment (a border, no fill) for
 * words that are not a status, such as "dry run".
 */
export function Pill({
  theme,
  tone,
  label,
  icon,
  outline = false,
}: {
  theme: PluginTheme;
  tone: Tone;
  label: string;
  icon?: string;
  outline?: boolean;
}) {
  const ink = outline ? theme.colors.foregroundMuted : toneInk(theme, tone);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        gap: 5,
        height: 22,
        paddingHorizontal: space[2],
        borderRadius: radius.pill,
        borderWidth: outline ? 1 : 0,
        borderColor: theme.colors.border,
        backgroundColor: outline ? "transparent" : tint(ink, 0.14),
      }}
    >
      {icon ? (
        <Icon name={icon} size={12} color={ink} />
      ) : (
        <View style={{ width: 6, height: 6, borderRadius: 6, backgroundColor: ink }} />
      )}
      <Text style={{ color: ink, fontSize: 12, fontWeight: "600" }} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export interface Segment {
  id: string;
  label: string;
  /** A dot beside the label, in its tone; the accessibility label says what it means. */
  tone?: Tone;
  count?: number;
  accessibilityLabel: string;
}

/**
 * A segmented control. Concentric: the track's 10 = the segment's 7 + its
 * 3 of padding. `fill` stretches it (and each segment) across the row.
 */
export function Segmented({
  theme,
  segments,
  value,
  onChange,
  label,
  fill = false,
  phone = false,
}: {
  theme: PluginTheme;
  segments: readonly Segment[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  fill?: boolean;
  phone?: boolean;
}) {
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={label}
      style={{
        flexDirection: "row",
        alignSelf: fill ? "stretch" : "flex-start",
        flexWrap: fill ? "nowrap" : "wrap",
        padding: 3,
        gap: 2,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
      }}
    >
      {segments.map((segment) => {
        const selected = segment.id === value;
        return (
          <Press
            key={segment.id}
            accessibilityRole="tab"
            ring={7}
            accessibilityLabel={segment.accessibilityLabel}
            selected={selected}
            onPress={() => onChange(segment.id)}
            hitSlop={phone ? undefined : { top: 3, bottom: 3 }}
            outer={fill ? { flexGrow: 1, flexBasis: 0 } : undefined}
            style={(pressed) => ({
              minHeight: phone ? 44 : 34,
              paddingHorizontal: space[3],
              borderRadius: 7,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              backgroundColor: selected
                ? theme.colors.surface2
                : pressed
                  ? tint(theme.colors.foreground, 0.04)
                  : "transparent",
            })}
          >
            {segment.tone ? (
              <View style={{ width: 7, height: 7, borderRadius: 7, backgroundColor: toneInk(theme, segment.tone) }} />
            ) : null}
            <Text
              style={{
                color: selected ? theme.colors.foreground : theme.colors.foregroundMuted,
                fontSize: 13,
                fontWeight: selected ? "600" : "500",
              }}
              numberOfLines={1}
            >
              {segment.label}
            </Text>
            {segment.count !== undefined ? (
              <Text
                style={{
                  color: theme.colors.foregroundMuted,
                  fontSize: 12,
                  fontWeight: "600",
                  fontVariant: ["tabular-nums"],
                }}
              >
                {segment.count}
              </Text>
            ) : null}
          </Press>
        );
      })}
    </View>
  );
}

/**
 * A KPI tile: its word with a dot, the number, a line under it, and what a
 * press does (*Show*, or *Go to* for a tile that jumps). Pressed, it filters
 * the roster; selected, it says *Filtering* and carries a foreground border.
 */
export function Kpi({
  theme,
  label,
  value,
  sub,
  tone,
  selected,
  quiet = false,
  phone = false,
  jumps = false,
  onPress,
  accessibilityLabel,
}: {
  theme: PluginTheme;
  label: string;
  value: number;
  sub: string | null;
  tone: Tone;
  selected: boolean;
  quiet?: boolean;
  phone?: boolean;
  /** It moves to a section rather than filtering. */
  jumps?: boolean;
  onPress: () => void;
  accessibilityLabel: string;
}) {
  const t = ramp(theme);
  const ink = toneInk(theme, tone);
  const hot = tone === "warn" && value > 0 && !quiet;
  const affordance = selected ? "Filtering" : jumps ? "Go to" : "Show";
  return (
    <Press
      onPress={onPress}
      ring={radius.card}
      accessibilityLabel={accessibilityLabel}
      selected={selected}
      outer={{ flexGrow: 1, flexBasis: phone ? 0 : 128, minWidth: phone ? 0 : 120 }}
      style={(pressed) => ({
        minHeight: phone ? 64 : 96,
        padding: phone ? space[2] : space[3],
        gap: phone ? 0 : 2,
        borderRadius: radius.card,
        borderWidth: selected ? 2 : hot ? 1.5 : 1,
        borderColor: selected ? theme.colors.foreground : hot ? tint(ink, 0.7) : theme.colors.border,
        backgroundColor: pressed
          ? theme.colors.surface2
          : hot
            ? tint(ink, 0.1)
            : selected
              ? theme.colors.surface2
              : theme.colors.surface1,
      })}
    >
      {phone ? null : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {quiet ? null : <View style={{ width: 7, height: 7, borderRadius: 7, backgroundColor: ink }} />}
          <Text
            style={[
              t.meta,
              { flex: 1, fontWeight: "600", color: quiet ? theme.colors.foregroundMuted : theme.colors.foreground },
            ]}
            numberOfLines={1}
          >
            {label}
          </Text>
          {selected ? (
            <Text style={[t.meta, { fontSize: 11, color: theme.colors.foreground }]}>{affordance}</Text>
          ) : null}
          <Icon
            name={selected ? "Filter" : jumps ? "ArrowDown" : "ChevronRight"}
            size={12}
            color={selected ? theme.colors.foreground : theme.colors.foregroundMuted}
          />
        </View>
      )}
      <Text
        style={[
          t.number,
          phone ? { fontSize: 22, lineHeight: 28 } : null,
          quiet ? { fontSize: 22, color: theme.colors.foregroundMuted } : null,
          hot ? { color: ink } : null,
        ]}
      >
        {value}
      </Text>
      {phone ? (
        <Text style={[t.meta, { color: theme.colors.foreground }]} numberOfLines={1}>
          {selected ? `${label} · filtering` : label}
        </Text>
      ) : sub ? (
        <Text style={t.meta} numberOfLines={2}>
          {sub}
        </Text>
      ) : null}
    </Press>
  );
}

/** A row of label / value facts, as the inspector shows them. */
export function Facts({
  theme,
  rows,
}: {
  theme: PluginTheme;
  rows: readonly { label: string; value: string; mono?: boolean }[];
}) {
  const t = ramp(theme);
  return (
    <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: radius.card, overflow: "hidden" }}>
      {rows.map((row, index) => (
        <View
          key={row.label}
          style={{
            flexDirection: "row",
            gap: space[3],
            paddingVertical: space[2],
            paddingHorizontal: space[3],
            borderTopWidth: index === 0 ? 0 : 1,
            borderTopColor: theme.colors.border,
          }}
        >
          <Text style={[t.meta, { width: 92 }]}>{row.label}</Text>
          <Text style={[row.mono ? t.mono : t.body, { flex: 1 }]} selectable numberOfLines={2}>
            {row.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

export interface MenuItem {
  label: string;
  icon: string;
  onPress: () => void;
  tone?: "danger";
}

/** The ⋯ menu: anchored under its button, closed on a choice or a second press. */
export function RowMenu({
  theme,
  label,
  open,
  onOpenChange,
  items,
}: {
  theme: PluginTheme;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: readonly MenuItem[];
}) {
  const t = ramp(theme);
  return (
    <View style={{ position: "relative", zIndex: open ? 30 : 0 }}>
      <Press
        onPress={() => onOpenChange(!open)}
        accessibilityLabel={label}
        accessibilityState={{ expanded: open }}
        hitSlop={4}
        style={(pressed) => ({
          width: 32,
          height: 32,
          borderRadius: radius.control,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: open || pressed ? theme.colors.surface2 : "transparent",
          borderWidth: 1,
          borderColor: open ? theme.colors.border : "transparent",
        })}
      >
        <Icon name="Ellipsis" size={16} color={theme.colors.foregroundMuted} />
      </Press>
      {open ? (
        <View
          accessibilityRole="menu"
          style={{
            position: "absolute",
            top: 36,
            right: 0,
            minWidth: 210,
            padding: 4,
            gap: 2,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
            boxShadow: "0 6px 16px rgba(0, 0, 0, 0.18)",
            elevation: 8,
          }}
        >
          {items.map((item) => {
            const ink = item.tone === "danger" ? theme.colors.statusDanger : theme.colors.foreground;
            return (
              <Press
                key={item.label}
                accessibilityRole="menuitem"
                accessibilityLabel={item.label}
                onPress={() => {
                  onOpenChange(false);
                  item.onPress();
                }}
                style={(pressed) => ({
                  minHeight: 40,
                  paddingHorizontal: space[2],
                  borderRadius: 8,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space[2],
                  backgroundColor: pressed ? theme.colors.surface2 : "transparent",
                })}
              >
                <Icon name={item.icon} size={15} color={item.tone === "danger" ? ink : theme.colors.foregroundMuted} />
                <Text style={[t.body, { color: ink }]}>{item.label}</Text>
              </Press>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

/** Copies through the host's clipboard; false where the host offers none (an older Paseo). */
export async function copy(text: string): Promise<boolean> {
  const write = (kit as { copyText?: (text: string) => Promise<void> }).copyText;
  if (typeof write !== "function") return false;
  await write(text);
  return true;
}

/** A section heading with its count beside it, and what sits on its right. */
export function SectionHead({
  theme,
  title,
  count,
  right,
}: {
  theme: PluginTheme;
  title: string;
  count?: number;
  right?: ReactNode;
}) {
  const t = ramp(theme);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap", minHeight: 30 }}>
      <Text style={t.section} accessibilityRole="header">
        {title}
      </Text>
      {count !== undefined && count > 0 ? (
        <View
          style={{
            minWidth: 22,
            height: 20,
            paddingHorizontal: 6,
            borderRadius: radius.pill,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: tint(theme.colors.statusWarning, 0.16),
          }}
        >
          <Text
            style={{
              color: theme.colors.statusWarning,
              fontSize: 12,
              fontWeight: "700",
              fontVariant: ["tabular-nums"],
            }}
          >
            {count}
          </Text>
        </View>
      ) : null}
      <View style={{ flex: 1 }} />
      {right}
    </View>
  );
}
