// The undo toast (B4: 8 s everywhere; M1 frames 2 and 3, H1's Undo capsule):
// an ink capsule with what was done, the countdown to when it applies, and
// Undo. It is our own View inside Maestro's screen, not the host's toast, which
// has no action. On the phone it sits above the tab bar when the sheet is down
// and at the bottom edge when the sheet is up: its `lift` is the sheet's drive
// (client/kit/sheet-model.ts), so the one Animated value places it too.
// The window is client/kit/undo-model.ts.

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Platform, Pressable, Text } from "react-native";
import { useReducedMotion } from "../ui";
import { nativeDriver } from "./assumptions";
import { kitOf } from "./tokens";
import { createUndoWindow, toastText, type UndoClock, type UndoEntry, type UndoWindow } from "./undo-model";

const realClock: UndoClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The toast's state: show an entry after a verb answers, undo inside the
 * window. `onUndo` receives the receipt (the screen calls work.undo with it).
 */
export function useUndoToast(onUndo: (receipt: string) => void, clock: UndoClock = realClock) {
  const [entry, setEntry] = useState<UndoEntry | null>(null);
  const undoRef = useRef(onUndo);
  undoRef.current = onUndo;
  const undoWindow: UndoWindow = useMemo(() => createUndoWindow(clock, setEntry), [clock]);
  useEffect(() => () => undoWindow.dispose(), [undoWindow]);
  return {
    entry,
    show: undoWindow.show,
    dismiss: undoWindow.dismiss,
    /** Whether there was a window to take back: false once it has closed and the verb applied. */
    undo: (): boolean => {
      const receipt = undoWindow.undo();
      if (receipt) undoRef.current(receipt);
      return receipt !== null;
    },
  };
}

/** Re-read the clock four times a second while an entry shows, so the countdown moves on time. */
function useSecondTick(entry: UndoEntry | null, now: () => number): number {
  const [at, setAt] = useState(now);
  useEffect(() => {
    if (!entry) return;
    setAt(now());
    const handle = setInterval(() => setAt(now()), 250);
    return () => clearInterval(handle);
  }, [entry, now]);
  return at;
}

/**
 * The capsule, `bottom` from the bottom edge and lifted by `lift` (on the
 * phone, an interpolation of the sheet's value); null `entry` renders nothing.
 */
export function UndoToast({
  theme,
  entry,
  onUndo,
  bottom = 16,
  lift = 0,
  now = Date.now,
  maxWidth = 420,
}: {
  theme: PluginTheme;
  entry: UndoEntry | null;
  onUndo: () => void;
  bottom?: number;
  lift?: number | Animated.AnimatedInterpolation<number>;
  now?: () => number;
  maxWidth?: number;
}) {
  const kit = kitOf(theme);
  const reduced = useReducedMotion();
  const at = useSecondTick(entry, now);
  const rise = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!entry) return;
    if (reduced) {
      rise.setValue(1);
      return;
    }
    rise.setValue(0);
    Animated.spring(rise, {
      toValue: 1,
      useNativeDriver: nativeDriver(Platform.OS),
      damping: 18,
      stiffness: 260,
    }).start();
  }, [entry, reduced, rise]);
  if (!entry) return null;
  const text = toastText(entry, at);
  return (
    <Animated.View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      testID="undo-toast"
      style={{
        position: "absolute",
        left: 16,
        right: 16,
        bottom,
        alignItems: "center",
        transform: [{ translateY: lift }],
      }}
    >
      <Animated.View
        style={{
          opacity: rise,
          transform: [{ translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
          width: "100%",
          maxWidth,
          height: 50,
          borderRadius: 9999,
          backgroundColor: kit.toastBg,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingLeft: 18,
          paddingRight: 8,
          shadowColor: "#0c101a",
          shadowOpacity: 0.25,
          shadowRadius: 30,
          shadowOffset: { width: 0, height: 8 },
        }}
      >
        <Icon name="Check" size={16} color={kit.toastOk} />
        <Text numberOfLines={1} style={{ flex: 1, color: kit.toastFg, fontSize: 14, fontWeight: "500" }}>
          {text}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Undo: ${entry.done}`}
          onPress={onUndo}
          style={({ pressed }) => ({
            height: 34,
            paddingHorizontal: 14,
            borderRadius: 9999,
            justifyContent: "center",
            backgroundColor: kit.dark ? "rgba(12, 16, 26, 0.1)" : "rgba(255, 255, 255, 0.15)",
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Text style={{ color: kit.toastFg, fontSize: 13, fontWeight: "600" }}>Undo</Text>
        </Pressable>
      </Animated.View>
    </Animated.View>
  );
}
