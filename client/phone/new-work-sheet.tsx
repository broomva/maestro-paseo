// New work on the phone (M9, BRO-3037; docs/design/next/m9-new-work-mobile.png): our own in-surface sheet, not
// Paseo's host Modal, so it grows from the + on the tab bar, dims the deck rather than replacing it, and rises
// with the keyboard (BRO-3033 fact 4). It hosts the desktop's composer, which says before you send what the work
// must land and who starts it: you do, with Dispatch; Save to queue starts nothing; Maestro never starts work
// on its own (A8). Save to queue and Dispatch are pinned at the sheet's foot as 52 pt pills, so the keyboard
// pushes them up while the brief and the promises scroll behind. Closing with something typed asks first.

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, Pressable, ScrollView, Text, View } from "react-native";
import { DRAG_NATIVE_DRIVER } from "../kit/assumptions";
import { Pill } from "../kit/parts";
import { kitOf } from "../kit/tokens";
import { Composer, type ComposerState } from "../new-work";
import { useReducedMotion } from "../ui";
import { useKeyboardLift } from "./keyboard";

const NONE: ComposerState = {
  ready: false,
  pending: false,
  confirming: false,
  dirty: false,
  save: () => undefined,
  dispatch: () => undefined,
};

export function NewWorkSheet({
  theme,
  height,
  safeBottom,
  onClose,
  onCreated,
}: {
  theme: PluginTheme;
  height: number;
  safeBottom: number;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const kit = kitOf(theme);
  const reduced = useReducedMotion();
  const lift = useKeyboardLift(safeBottom);
  const grow = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const [state, setState] = useState<ComposerState>(NONE);
  const [discarding, setDiscarding] = useState(false);
  const publish = useCallback((next: ComposerState) => setState(next), []);
  useEffect(() => {
    if (reduced) return;
    Animated.spring(grow, { toValue: 1, damping: 24, stiffness: 240, useNativeDriver: DRAG_NATIVE_DRIVER }).start();
  }, [grow, reduced]);
  // Closing with something typed asks first; with nothing typed it just closes.
  const close = () => (state.dirty ? setDiscarding(true) : onClose());
  const dispatchLabel = state.confirming ? "Confirm dispatch" : "Dispatch";
  return (
    <View testID="new-work-sheet" style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }}>
      <Animated.View
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          opacity: grow,
          backgroundColor: "rgba(12,16,26,0.4)",
        }}
      >
        <Pressable accessibilityRole="button" accessibilityLabel="Close new work" onPress={close} style={{ flex: 1 }} />
      </Animated.View>
      <Animated.View
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: Math.round(height * 0.1),
          bottom: lift,
          opacity: grow,
          // It grows from the + at the tab bar's right end: a scale from there and a rise from the bottom.
          transform: [
            { translateY: grow.interpolate({ inputRange: [0, 1], outputRange: [height * 0.35, 0] }) },
            { scale: grow.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] }) },
          ],
          backgroundColor: kit.bg,
          borderTopLeftRadius: 22,
          borderTopRightRadius: 22,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 18,
            paddingTop: 18,
            paddingBottom: 6,
          }}
        >
          <Text accessibilityRole="header" style={{ flex: 1, color: kit.fg, fontSize: 22, fontWeight: "600" }}>
            New work
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close new work"
            onPress={close}
            hitSlop={8}
            style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
          >
            <Icon name="X" size={20} color={kit.fg2} />
          </Pressable>
        </View>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
        >
          <Composer theme={theme} compact heading={false} onClose={close} onCreated={onCreated} onState={publish} />
        </ScrollView>
        {discarding ? (
          <View
            accessibilityRole="alert"
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              paddingHorizontal: 16,
              paddingVertical: 10,
              backgroundColor: kit.warnSoft,
            }}
          >
            <Text style={{ flex: 1, color: kit.warn, fontSize: 14, fontWeight: "600" }}>Discard what you wrote?</Text>
            <Pill theme={theme} label="Keep writing" height={44} onPress={() => setDiscarding(false)} />
            <Pill theme={theme} label="Discard" height={44} primary onPress={onClose} />
          </View>
        ) : null}
        <View
          style={{
            flexDirection: "row",
            gap: 10,
            paddingHorizontal: 16,
            paddingTop: 10,
            // Above the home indicator; with the keyboard up the sheet's own bottom has risen by the keyboard less this.
            paddingBottom: 10 + safeBottom,
            borderTopWidth: 1,
            borderTopColor: kit.hairline,
            backgroundColor: kit.bg,
          }}
        >
          <Pill
            theme={theme}
            label="Save to queue"
            height={52}
            grow
            disabled={!state.ready || state.pending}
            onPress={state.save}
          />
          <Pill
            theme={theme}
            label={dispatchLabel}
            primary
            height={52}
            grow
            busy={state.pending}
            disabled={!state.ready}
            onPress={state.dispatch}
          />
        </View>
      </Animated.View>
    </View>
  );
}
