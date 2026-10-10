// Small parts every kit component uses: the ink and control pills (B1), the
// kicker line, the section label and the system monospace. System fonts only
// (paseo-plugin-capabilities.md §3); the mockups' Inter and JetBrains Mono are
// Pen's stand-ins for ui-sans-serif and ui-monospace.

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useRef } from "react";
import {
  type LayoutChangeEvent,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import { focusRing } from "../ui";
import { keysHint } from "./assumptions";
import { type Kit, kitOf } from "./tokens";

export const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, monospace" });

export const TABULAR: TextStyle = { fontVariant: ["tabular-nums"] };

/**
 * Clip children that slide out of view (the sheet below the peek, the deck's next cards). On the web an
 * `overflow: hidden` box is still a scroll container: focus or scrollIntoView on a child scrolls it, and the
 * sheet and deck slide out of place. `clip` cuts without scrolling. Native has no `clip` and does not scroll a
 * View, so it keeps `hidden`.
 */
/**
 * A view that lets touches through to what is under it while its children still take theirs ("box-none").
 * It must be a StyleSheet style: react-native-web compiles "box-none" into CSS only from StyleSheet.create;
 * inline, `pointer-events: box-none` is not CSS, so the view would swallow every touch over the screen.
 */
export const PASS_THROUGH = StyleSheet.create({ view: { pointerEvents: "box-none" } }).view;

export const CLIP = (Platform.OS === "web" ? { overflow: "clip" } : { overflow: "hidden" }) as ViewStyle;

/** The kit's colors for this theme (client/kit/tokens.ts). */
export function useKit(theme: PluginTheme): Kit {
  return kitOf(theme);
}

/**
 * A pill verb. Primary is broomva ink (B1): the theme's foreground with its
 * surface as the word. Secondary is the control fill. `height` is 36 on the
 * desktop's action bar, 44 in a card, 52 on the phone's deck and detail card.
 */
export function Pill({
  theme,
  label,
  onPress,
  primary = false,
  height = 36,
  grow = false,
  keyCap,
  disabled = false,
}: {
  theme: PluginTheme;
  label: string;
  onPress: () => void;
  primary?: boolean;
  height?: number;
  grow?: boolean;
  keyCap?: string;
  disabled?: boolean;
}) {
  const kit = kitOf(theme);
  const ink = primary ? kit.onInk : kit.fg;
  const showKey = keyCap && keysHint(Platform.OS);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({
        ...focusRing(theme, focused),
        height,
        minWidth: height,
        flexGrow: grow ? 1 : 0,
        flexBasis: grow ? 0 : "auto",
        // A pill that shares a row grows to its share and centres its word, so it keeps only a small margin.
        paddingHorizontal: grow ? 10 : height >= 44 ? 20 : 16,
        borderRadius: 9999,
        backgroundColor: primary ? kit.ink : kit.control,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
      })}
    >
      <Text numberOfLines={1} style={{ color: ink, fontSize: height >= 44 ? 16 : 14, fontWeight: "600" }}>
        {label}
      </Text>
      {showKey ? <Text style={{ color: ink, opacity: 0.6, fontSize: 11, fontFamily: MONO }}>{keyCap}</Text> : null}
    </Pressable>
  );
}

/** A round 36 pt button holding an icon: the detail header's close and ⋯. */
export function RoundButton({
  theme,
  icon,
  label,
  onPress,
}: {
  theme: PluginTheme;
  icon: string;
  label: string;
  onPress: () => void;
}) {
  const kit = kitOf(theme);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({
        ...focusRing(theme, focused),
        width: 36,
        height: 36,
        borderRadius: 9999,
        backgroundColor: kit.hairline,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Icon name={icon} size={19} color={kit.fg} />
    </Pressable>
  );
}

/** The kicker: kind icon, a mono line of where it comes from, and its age at the end. */
export function Kicker({
  theme,
  icon,
  iconColor,
  parts,
  age,
  trailing,
}: {
  theme: PluginTheme;
  icon: string;
  iconColor?: string;
  parts: readonly string[];
  age?: string;
  /** After the age: the desktop inspector's close button. */
  trailing?: ReactNode;
}) {
  const kit = kitOf(theme);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Icon name={icon} size={14} color={iconColor ?? kit.needs} />
      <Text numberOfLines={1} style={{ flex: 1, color: kit.muted, fontSize: 11.5, fontFamily: MONO }}>
        {parts.join(" · ")}
      </Text>
      {age ? <Text style={{ color: kit.muted, fontSize: 12, ...TABULAR }}>{age}</Text> : null}
      {trailing}
    </View>
  );
}

/** A section's label inside a card: "After you allow", "Session", "History". */
export function SectionLabel({
  theme,
  children,
  caps = false,
}: {
  theme: PluginTheme;
  children: string;
  caps?: boolean;
}) {
  const kit = kitOf(theme);
  return (
    <Text
      accessibilityRole="header"
      style={{
        color: kit.fg2,
        fontSize: caps ? 11 : 12,
        fontWeight: "600",
        letterSpacing: caps ? 0.6 : 0,
        textTransform: caps ? "uppercase" : "none",
      }}
    >
      {children}
    </Text>
  );
}

/** A small colored dot before a word: status that always pairs color with text. */
export function Dot({ color, size = 7 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size, backgroundColor: color }} />;
}

/** A row of chips: counts under a sheet's title ("3 running", "22 handled"). */
export function Chip({
  theme,
  label,
  lead,
  tone,
}: {
  theme: PluginTheme;
  label: string;
  lead?: ReactNode;
  tone?: "warn";
}) {
  const kit = kitOf(theme);
  const style: ViewStyle = {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 30,
    paddingHorizontal: 12,
    borderRadius: 9999,
    backgroundColor: tone === "warn" ? kit.warnSoft : kit.sunken,
  };
  return (
    <View style={style}>
      {lead}
      <Text style={{ color: tone === "warn" ? kit.warn : kit.fg2, fontSize: 13, ...TABULAR }}>{label}</Text>
    </View>
  );
}

/**
 * Reports how much of its parent's bottom edge the safe area keeps: the home
 * indicator on an iPhone, 0 elsewhere. Paseo gives a plugin no insets and
 * react-native-safe-area-context is not importable (BRO-3033 fact 1), so an
 * invisible RN SafeAreaView fills the parent and its padded child's bottom is
 * read against the frame's.
 */
export function SafeBottom({ onBottom }: { onBottom: (bottom: number) => void }) {
  const frame = useRef(0);
  const inner = useRef<{ y: number; height: number } | null>(null);
  const report = () => {
    if (frame.current > 0 && inner.current)
      onBottom(Math.max(0, Math.round(frame.current - inner.current.y - inner.current.height)));
  };
  return (
    <SafeAreaView
      accessible={false}
      style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, opacity: 0, pointerEvents: "none" }}
      onLayout={(event: LayoutChangeEvent) => {
        frame.current = event.nativeEvent.layout.height;
        report();
      }}
    >
      <View
        style={{ flex: 1 }}
        onLayout={(event: LayoutChangeEvent) => {
          inner.current = event.nativeEvent.layout;
          report();
        }}
      />
    </SafeAreaView>
  );
}
