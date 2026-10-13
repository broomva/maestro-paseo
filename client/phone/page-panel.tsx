// A page on the phone (M8's Initiatives, M11's Settings, and the views Health's sheet reaches): a card that
// rises over the surface with the detail header's grabber, a round chevron (down to close at the root of a
// page, left to go back one level inside it) and where you are. It is in the surface, not Paseo's host Modal,
// so the tab bar and the undo toast stay in the same tree; the card that a hold opens rises over it. PanResponder
// and Animated only: a drag down on the header closes it.

import type { PluginTheme } from "@getpaseo/plugin";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { Animated, PanResponder, ScrollView, Text, View } from "react-native";
import { tint } from "../fleet-color";
import { DRAG_NATIVE_DRIVER } from "../kit/assumptions";
import { RoundButton } from "../kit/parts";
import { kitOf } from "../kit/tokens";
import { useReducedMotion } from "../ui";

/** A drag down this far (or this fast) closes the page. */
const CLOSE_DRAG = 120;
const CLOSE_FLING = 0.8;

export function PagePanel({
  theme,
  height,
  trail,
  onBack,
  onClose,
  children,
}: {
  theme: PluginTheme;
  /** The surface's height: the page is a card this tall, a little under Paseo's header. */
  height: number;
  /** Where you are: "Settings", "Settings › Lanes". One level deeper than the first shows the back chevron. */
  trail: readonly string[];
  /** One level back (only called when `trail` has more than one entry). */
  onBack: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const kit = kitOf(theme);
  const reduced = useReducedMotion();
  const y = useRef(new Animated.Value(reduced ? 0 : height)).current;
  const live = useRef({ onClose, reduced, height });
  live.current = { onClose, reduced, height };
  useEffect(() => {
    if (reduced) return;
    Animated.spring(y, { toValue: 0, damping: 26, stiffness: 260, useNativeDriver: DRAG_NATIVE_DRIVER }).start();
  }, [y, reduced]);
  const drag = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => g.dy > 8 && Math.abs(g.dy) > Math.abs(g.dx) * 1.5,
        onPanResponderMove: (_, g) => y.setValue(Math.max(0, g.dy)),
        onPanResponderRelease: (_, g) => {
          if (g.dy > CLOSE_DRAG || g.vy > CLOSE_FLING) live.current.onClose();
          else
            Animated.spring(y, {
              toValue: 0,
              damping: 26,
              stiffness: 260,
              useNativeDriver: DRAG_NATIVE_DRIVER,
            }).start();
        },
        onPanResponderTerminate: () =>
          Animated.spring(y, { toValue: 0, damping: 26, stiffness: 260, useNativeDriver: DRAG_NATIVE_DRIVER }).start(),
      }),
    [y],
  );
  const nested = trail.length > 1;
  return (
    <Animated.View
      testID="page-panel"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        top: 12,
        transform: [{ translateY: y }],
        backgroundColor: kit.sunken,
        borderTopLeftRadius: 22,
        borderTopRightRadius: 22,
        overflow: "hidden",
        shadowColor: "#0c101a",
        shadowOpacity: kit.dark ? 0.5 : 0.18,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: -3 },
      }}
    >
      <View
        {...drag.panHandlers}
        style={{
          backgroundColor: kit.bg,
          borderBottomWidth: 1,
          borderBottomColor: kit.hairline,
          paddingTop: 6,
          paddingHorizontal: 14,
          paddingBottom: 8,
          gap: 4,
        }}
      >
        <View style={{ alignItems: "center" }} accessible={false}>
          <View style={{ width: 36, height: 5, borderRadius: 3, backgroundColor: tint(kit.fg, 0.15) }} />
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <RoundButton
            theme={theme}
            icon={nested ? "ChevronLeft" : "ChevronDown"}
            label={nested ? "Back" : "Close"}
            onPress={nested ? onBack : onClose}
          />
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            style={{ flex: 1, textAlign: "center", color: kit.fg, fontSize: 13, fontWeight: "600" }}
          >
            {trail.join(" › ")}
          </Text>
          {/* The same width as the round button, so the words stay centred. */}
          <View style={{ width: 36 }} />
        </View>
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, paddingBottom: 120, gap: 12 }}
      >
        {children}
      </ScrollView>
    </Animated.View>
  );
}
