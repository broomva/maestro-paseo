// Shared React Native primitives, drawn from the host theme so they follow
// every Paseo theme. Broomva rules apply on top: the 4px ladder, cards at 12,
// pills only on actions and status, color always paired with text, and live
// motion that goes still under reduced motion.

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Platform,
  Pressable,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import { type OrchState, PLAIN_VOICE, type Tone } from "../shared/states";
import { flagRuns } from "../shared/text";

export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32 } as const;
export const radius = { control: 8, card: 12, pill: 9999 } as const;
export const size = { xs: 12, sm: 14, base: 16, lg: 18, xl: 22, xxl: 24 } as const;

/**
 * ARIA that react-native-web writes to the DOM but React Native's types omit.
 * Native ignores it, so pair it with accessibilityState for iOS and Android.
 */
export function webAria(props: {
  "aria-pressed"?: boolean;
  "aria-current"?: boolean;
  "aria-checked"?: boolean;
  /** Roles React Native's types lack, for the web only (a menu of choices is `menuitemradio`). */
  role?: "menuitemradio";
}): object {
  return props;
}

export function toneColor(theme: PluginTheme, tone: Tone): string {
  switch (tone) {
    case "active":
    case "accent":
      return theme.colors.accent;
    case "warn":
      return theme.colors.statusWarning;
    case "success":
      return theme.colors.statusSuccess;
    default:
      return theme.colors.foregroundMuted;
  }
}

/**
 * The platform's reduced-motion answer where it can be read at once (the web's
 * matchMedia), else false until AccessibilityInfo answers. Read at once, the
 * first frame is already right, and the async answer that follows is the same
 * value, which React drops without a render.
 */
function reducedMotionNow(): boolean {
  const view = (globalThis as { window?: { matchMedia?: (query: string) => { matches: boolean } } }).window;
  try {
    return view?.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(reducedMotionNow);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (alive) setReduced(value);
      })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}

/**
 * The state dot. Running work gets the tidepool: a ring that widens and fades
 * from the dot. Queued work is a hollow ring so it reads by shape as well as
 * color. Reduced motion keeps the ring as a static halo; `still` drops it, for
 * dots that stand for a group rather than live work.
 */
export function StateDot({
  theme,
  state,
  dim = 8,
  still = false,
}: {
  theme: PluginTheme;
  state: OrchState;
  dim?: number;
  still?: boolean;
}) {
  const tone = PLAIN_VOICE[state].tone;
  const color = toneColor(theme, tone);
  const live = state === "running" && !still;
  const reduced = useReducedMotion();
  const wave = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!live || reduced) {
      wave.setValue(0.35);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(wave, {
        toValue: 1,
        duration: 1800,
        easing: Easing.out(Easing.quad),
        useNativeDriver: Platform.OS !== "web",
      }),
    );
    wave.setValue(0);
    loop.start();
    return () => loop.stop();
  }, [live, reduced, wave]);
  const hollow = tone === "muted" && state !== "canceled";
  const box = dim * 2.5;
  return (
    <View style={{ width: box, height: box, alignItems: "center", justifyContent: "center" }} accessible={false}>
      {live ? (
        <Animated.View
          style={{
            position: "absolute",
            width: dim,
            height: dim,
            borderRadius: dim,
            backgroundColor: color,
            opacity: wave.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
            transform: [{ scale: wave.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] }) }],
          }}
        />
      ) : null}
      <View
        style={{
          width: dim,
          height: dim,
          borderRadius: dim,
          backgroundColor: hollow ? "transparent" : color,
          borderWidth: hollow ? 1.5 : 0,
          borderColor: color,
        }}
      />
    </View>
  );
}

export function StateLabel({ theme, state, label }: { theme: PluginTheme; state: OrchState; label?: string }) {
  const voice = PLAIN_VOICE[state];
  const color = voice.tone === "muted" ? theme.colors.foregroundMuted : toneColor(theme, voice.tone);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[1] }}>
      <StateDot theme={theme} state={state} dim={7} />
      <Text style={{ color, fontSize: size.xs, fontWeight: "600" }}>
        {label ?? (state === "canceled" ? "Canceled" : voice.label)}
      </Text>
    </View>
  );
}

type Variant = "primary" | "secondary" | "quiet";

export function Button({
  theme,
  label,
  onPress,
  variant = "secondary",
  icon,
  busy = false,
  disabled = false,
  compact = false,
  accessibilityLabel,
}: {
  theme: PluginTheme;
  label: string;
  onPress: () => void;
  variant?: Variant;
  icon?: string;
  busy?: boolean;
  disabled?: boolean;
  compact?: boolean;
  accessibilityLabel?: string;
}) {
  const inactive = disabled || busy;
  const press = usePressScale();
  const fill =
    variant === "primary" ? theme.colors.accent : variant === "secondary" ? theme.colors.surface2 : "transparent";
  const ink =
    variant === "primary"
      ? theme.colors.accentForeground
      : variant === "quiet"
        ? theme.colors.foregroundMuted
        : theme.colors.foreground;
  // The press scale is the motion; the pressed opacity stays as its static cue (and the only one under reduced motion).
  return (
    <Animated.View style={{ transform: [{ scale: press.scale }] }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityState={{ disabled: inactive, busy }}
        disabled={inactive}
        onPress={onPress}
        onPressIn={inactive ? undefined : press.onPressIn}
        onPressOut={press.onPressOut}
        style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({
          ...focusRing(theme, focused),
          minHeight: compact ? 44 : 40,
          paddingHorizontal: variant === "quiet" ? space[2] : space[4],
          borderRadius: radius.pill,
          backgroundColor: fill,
          borderWidth: variant === "secondary" ? 1 : 0,
          borderColor: theme.colors.border,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: space[2],
          opacity: inactive ? 0.5 : pressed ? 0.85 : 1,
        })}
      >
        {busy ? (
          <ActivityIndicator size="small" color={ink} />
        ) : icon ? (
          <Icon name={icon} size={16} color={ink} />
        ) : null}
        <Text style={{ color: ink, fontSize: size.sm, fontWeight: "600" }}>{label}</Text>
      </Pressable>
    </Animated.View>
  );
}

export function IconButton({
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
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => ({
        width: 36,
        height: 36,
        borderRadius: radius.control,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed ? theme.colors.surface2 : "transparent",
      })}
    >
      <Icon name={icon} size={18} color={theme.colors.foregroundMuted} />
    </Pressable>
  );
}

export function Card({ theme, children, style }: { theme: PluginTheme; children: ReactNode; style?: ViewStyle }) {
  return (
    <View
      style={[
        {
          backgroundColor: theme.colors.surface1,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: radius.card,
          padding: space[4],
          gap: space[3],
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function useText(theme: PluginTheme) {
  return useMemo(() => {
    const base: TextStyle = { color: theme.colors.foreground, fontSize: size.sm, lineHeight: 20 };
    return {
      body: base,
      muted: { ...base, color: theme.colors.foregroundMuted },
      small: { ...base, fontSize: size.xs, lineHeight: 16, color: theme.colors.foregroundMuted },
      label: {
        ...base,
        fontSize: size.xs,
        lineHeight: 16,
        fontWeight: "600" as const,
        color: theme.colors.foregroundMuted,
      },
      title: { ...base, fontSize: size.lg, lineHeight: 24, fontWeight: "600" as const },
      heading: { ...base, fontSize: size.xxl, lineHeight: 30, fontWeight: "600" as const },
      danger: { ...base, color: theme.colors.statusDanger },
      mono: {
        ...base,
        fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, monospace" }),
        fontSize: size.xs,
        lineHeight: 16,
      },
      tabular: { fontVariant: ["tabular-nums" as const] },
    };
  }, [theme]);
}

export function Notice({
  theme,
  tone,
  children,
  action,
}: {
  theme: PluginTheme;
  tone: "danger" | "warn";
  children: ReactNode;
  /** A verb that answers the notice, under its words. */
  action?: ReactNode;
}) {
  const color = tone === "danger" ? theme.colors.statusDanger : theme.colors.statusWarning;
  return (
    <View
      accessibilityRole="alert"
      style={{
        flexDirection: "row",
        gap: space[2],
        alignItems: "flex-start",
        padding: space[3],
        borderRadius: radius.control,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <Icon name={tone === "danger" ? "CircleAlert" : "TriangleAlert"} size={16} color={color} />
      {action ? (
        <View style={{ flex: 1, gap: space[2] }}>
          <Text style={{ color: theme.colors.foreground, fontSize: size.sm, lineHeight: 20 }}>{children}</Text>
          <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap" }}>{action}</View>
        </View>
      ) : (
        <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: size.sm, lineHeight: 20 }}>{children}</Text>
      )}
    </View>
  );
}

/** A titled part of a view: its heading, a line of facts beside it, and its body. */
export function Section({
  theme,
  title,
  meta,
  children,
}: {
  theme: PluginTheme;
  title: string;
  meta?: string;
  children: ReactNode;
}) {
  const text = useText(theme);
  return (
    <View style={{ gap: space[2] }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: space[2], flexWrap: "wrap" }}>
        <Text style={[text.body, { fontWeight: "600" }]} accessibilityRole="header">
          {title}
        </Text>
        {meta ? <Text style={[text.small, text.tabular]}>{meta}</Text> : null}
      </View>
      {children}
    </View>
  );
}

/**
 * A row that opens what it labels: a chevron that turns a quarter (transform
 * only, 160ms, still under reduced motion), the label, and an optional hint.
 * Closed by default; the children render only while open.
 */
export function Disclosure({
  theme,
  label,
  hint,
  children,
}: {
  theme: PluginTheme;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const text = useText(theme);
  const [open, setOpen] = useState(false);
  const reduced = useReducedMotion();
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const to = open ? 1 : 0;
    if (reduced) {
      turn.setValue(to);
      return;
    }
    const run = Animated.timing(turn, {
      toValue: to,
      duration: 160,
      easing: Easing.out(Easing.quad),
      useNativeDriver: Platform.OS !== "web",
    });
    run.start();
    return () => run.stop();
  }, [open, reduced, turn]);
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "90deg"] });
  return (
    <View style={{ gap: space[2] }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        accessibilityLabel={label}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          alignSelf: "flex-start",
          gap: space[2],
          // 44: a touch target on a phone, where this row is most often tapped.
          minHeight: 44,
          paddingHorizontal: space[2],
          marginLeft: -space[2],
          borderRadius: radius.control,
          backgroundColor: pressed ? theme.colors.surface2 : "transparent",
        })}
      >
        <Animated.View style={{ transform: [{ rotate }] }}>
          <Icon name="ChevronRight" size={14} color={theme.colors.foregroundMuted} />
        </Animated.View>
        <Text style={text.muted}>{label}</Text>
        {hint ? <Text style={[text.small, text.tabular]}>{hint}</Text> : null}
      </Pressable>
      {open ? children : null}
    </View>
  );
}

/**
 * Text whose flag-like tokens (`--compare`) never wrap at their hyphen: each
 * is a nested Text with `white-space: nowrap` on the web; native ignores the
 * rule, so it is set there only. The string is the source's, byte for byte.
 */
export function Unbroken({ children }: { children: string }) {
  const runs = flagRuns(children);
  if (Platform.OS !== "web" || !runs.some((run) => run.flag)) return <>{children}</>;
  const nowrap = { whiteSpace: "nowrap" } as unknown as TextStyle;
  return (
    <>
      {runs.map((run, index) =>
        run.flag ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs are a fixed split of one string, never reordered.
          <Text key={index} style={nowrap}>
            {run.text}
          </Text>
        ) : (
          run.text
        ),
      )}
    </>
  );
}

/** Press feedback: 0.96 while held, 120 ms each way; none under reduced motion. */
export function usePressScale(): {
  scale: Animated.Value;
  onPressIn: () => void;
  onPressOut: () => void;
} {
  const reduced = useReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const to = (value: number) => {
    if (reduced) {
      scale.setValue(1);
      return;
    }
    Animated.timing(scale, {
      toValue: value,
      duration: 120,
      easing: Easing.out(Easing.quad),
      useNativeDriver: Platform.OS !== "web",
    }).start();
  };
  return { scale, onPressIn: () => to(0.96), onPressOut: () => to(1) };
}

/** A key on the keyboard, as a hint beside the control it drives. Web only: a phone has no keys to show. */
export function Kbd({ theme, children }: { theme: PluginTheme; children: string }) {
  if (Platform.OS !== "web") return null;
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{
        minWidth: 20,
        height: 20,
        paddingHorizontal: 5,
        borderRadius: 5,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        aria-hidden
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 11,
          fontWeight: "600",
          fontFamily: Platform.select({ default: "ui-monospace, Menlo, monospace", ios: "Menlo" }),
        }}
      >
        {children}
      </Text>
    </View>
  );
}

/** A thin bar for how far through something you are, 0 to 1. Decorative: its words sit beside it. */
export function ProgressBar({ theme, fraction }: { theme: PluginTheme; fraction: number }) {
  const width = `${Math.round(Math.min(Math.max(fraction, 0), 1) * 100)}%` as const;
  return (
    <View
      accessible={false}
      style={{ height: 4, borderRadius: radius.pill, backgroundColor: theme.colors.surface2, overflow: "hidden" }}
    >
      <View style={{ width, height: 4, borderRadius: radius.pill, backgroundColor: theme.colors.accent }} />
    </View>
  );
}

/**
 * A segmented control: one choice of a few, each a labelled button, 40 pt
 * tall (44 on a phone). The track is 10 (the segments' 7 plus its 3 of
 * padding), so the corners nest.
 */
export function Segmented<T extends string>({
  theme,
  label,
  options,
  value,
  onChange,
  compact = false,
}: {
  theme: PluginTheme;
  /** The control's name for a screen reader. */
  label: string;
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  compact?: boolean;
}) {
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{
        flexDirection: "row",
        alignSelf: compact ? "stretch" : "flex-start",
        padding: 3,
        gap: 2,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      {options.map((option) => {
        const selected = option.id === value;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            aria-checked={selected}
            accessibilityLabel={option.label}
            onPress={() => onChange(option.id)}
            style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({
              ...focusRing(theme, focused),
              flex: compact ? 1 : undefined,
              minHeight: compact ? 44 : 40,
              paddingHorizontal: space[3],
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 7,
              backgroundColor: selected ? theme.colors.surface2 : pressed ? theme.colors.surface2 : "transparent",
            })}
          >
            <Text
              style={{
                color: selected ? theme.colors.foreground : theme.colors.foregroundMuted,
                fontSize: size.xs,
                fontWeight: "600",
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Whether the last input was a key (true) or a pointer (false): focus rings show for keys only (focus-visible). */
let keyboardModality = false;
let modalityWatched = false;
function watchModality(): void {
  if (modalityWatched || Platform.OS !== "web") return;
  const doc = (globalThis as { document?: { addEventListener(type: string, fn: () => void, capture: boolean): void } })
    .document;
  if (!doc) return;
  modalityWatched = true;
  doc.addEventListener(
    "keydown",
    () => {
      keyboardModality = true;
    },
    true,
  );
  for (const type of ["mousedown", "pointerdown", "touchstart"]) {
    doc.addEventListener(
      type,
      () => {
        keyboardModality = false;
      },
      true,
    );
  }
}

/**
 * A focus ring for a Pressable's style callback: a 2 px accent outline, offset
 * 2, while it has focus from the keyboard (focus-visible), never from a click.
 */
export function focusRing(theme: PluginTheme, focused: boolean | undefined): ViewStyle {
  watchModality();
  if (!focused || !keyboardModality) return {};
  return {
    outlineColor: theme.colors.accent,
    outlineStyle: "solid",
    outlineWidth: 2,
    outlineOffset: 2,
  } as ViewStyle;
}
