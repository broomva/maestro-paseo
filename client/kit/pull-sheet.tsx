// The phone's pull-up sheet (M1): everything else on the tab, peeking from the
// bottom edge under the tab bar, which rides on the sheet's top edge. ONE
// Animated value drives the sheet, the tab bar, the dimming behind it and the
// undo toast (client/kit/sheet-model.ts): the tab bar and the sheet are the
// two children of one Animated.View, so they cannot part. Drag the grabber or
// the peek; a release carries its velocity into the spring. Paseo's host sheet
// is not used: it is modal, not a resting peek (M1 Build note).

import type { PluginTheme } from "@getpaseo/plugin";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Animated, PanResponder, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { tint } from "../fleet-color";
import { useReducedMotion } from "../ui";
import { chromeInset, nativeDriver } from "./assumptions";
import { CLIP, PASS_THROUGH, SafeBottom } from "./parts";
import {
  dragProgress,
  releaseVelocity,
  riderHeight,
  type SheetGeometry,
  sheetCaptures,
  sheetDrive,
  sheetRange,
  sheetRelease,
  toastBottoms,
} from "./sheet-model";
import { TAB_BAR_HEIGHT } from "./tab-bar";
import { kitOf } from "./tokens";

/** The tab bar's band: the bar and the gap between it and the sheet. */
export const TAB_BAND = TAB_BAR_HEIGHT + 10;
/** What shows of the sheet when it is down: the grabber, the title and one line of counts. */
export const PEEK = 104;

export function sheetGeometry(height: number, top: number, inset = chromeInset(Platform.OS), safe = 0): SheetGeometry {
  return { height, top, tabBar: TAB_BAND, peek: PEEK, inset, safe };
}

export function PullSheet({
  theme,
  height,
  top,
  inset,
  safeBottom,
  tabBar,
  title,
  counts,
  children,
  toast,
  initial = 0,
  onPosition,
}: {
  theme: PluginTheme;
  /** The screen's height. */
  height: number;
  /** Where the tab bar stops when the sheet is up. */
  top: number;
  /** Paseo's bottom chrome: none on 0.11.1 (F3). */
  inset?: number;
  /** The home indicator's height; measured with RN SafeAreaView when not given. */
  safeBottom?: number;
  tabBar: ReactNode;
  title: string;
  /** The line of counts under the title. */
  counts?: ReactNode;
  children: ReactNode;
  /** The undo toast, given where it sits and its lift: an interpolation of the same value. */
  toast?: (place: { bottom: number; lift: Animated.AnimatedInterpolation<number> }) => ReactNode;
  initial?: 0 | 1;
  onPosition?: (position: 0 | 1) => void;
}) {
  const kit = kitOf(theme);
  const reduced = useReducedMotion();
  const bottomChrome = inset ?? chromeInset(Platform.OS);
  const [measured, setMeasured] = useState(0);
  const safe = safeBottom ?? measured;
  const geometry = sheetGeometry(height, top, bottomChrome, safe);
  const { travel } = sheetRange(geometry);
  const progress = useRef(new Animated.Value(initial)).current;
  const [position, setPosition] = useState<0 | 1>(initial);
  const drive = useMemo(
    () => sheetDrive(progress, sheetGeometry(height, top, bottomChrome, safe)),
    [progress, height, top, bottomChrome, safe],
  );
  const live = useRef({ position, travel, onPosition, reduced });
  live.current = { position, travel, onPosition, reduced };

  const settle = (to: 0 | 1, velocity = 0) => {
    setPosition(to);
    live.current.onPosition?.(to);
    if (live.current.reduced) {
      progress.setValue(to);
      return;
    }
    Animated.spring(progress, {
      toValue: to,
      velocity,
      damping: 26,
      stiffness: 260,
      useNativeDriver: nativeDriver(Platform.OS),
    }).start();
  };
  const origin = useRef<number>(initial);
  const settleRef = useRef(settle);
  settleRef.current = settle;

  useEffect(() => {
    progress.setValue(initial);
    setPosition(initial);
  }, [initial, progress]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => sheetCaptures(g.dx, g.dy),
        // A drag starts where the sheet is, even mid-spring: the stopped value, not the spring's target.
        onPanResponderGrant: () => {
          origin.current = live.current.position;
          progress.stopAnimation((at) => {
            origin.current = at;
          });
        },
        onPanResponderMove: (_, g) => {
          progress.setValue(dragProgress(origin.current, g.dy, live.current.travel));
        },
        onPanResponderRelease: (_, g) => {
          const t = live.current.travel;
          settleRef.current(sheetRelease(origin.current, g.dy, g.vy, t), releaseVelocity(g.vy, t));
        },
        onPanResponderTerminate: () => settleRef.current(live.current.position),
      }),
    [progress],
  );

  const up = position === 1;
  return (
    <View
      testID="pull-sheet-root"
      style={[PASS_THROUGH, { position: "absolute", top: 0, left: 0, right: 0, height, ...CLIP }]}
    >
      {safeBottom === undefined ? <SafeBottom onBottom={setMeasured} /> : null}
      <Animated.View
        style={{
          pointerEvents: up ? "auto" : "none",
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: kit.scrim,
          opacity: drive.scrim,
        }}
      >
        <Pressable accessibilityLabel="Back to the deck" style={{ flex: 1 }} onPress={() => settle(0)} />
      </Animated.View>
      <Animated.View
        testID="pull-sheet-rider"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: riderHeight(geometry),
          transform: [{ translateY: drive.rider }],
        }}
      >
        <View testID="pull-sheet-tab-band" style={{ height: TAB_BAND, paddingHorizontal: 12 }}>
          {tabBar}
        </View>
        <View
          testID="pull-sheet"
          style={{
            flex: 1,
            backgroundColor: kit.dark ? kit.sunken : "#f3f4f6",
            borderTopLeftRadius: 22,
            borderTopRightRadius: 22,
            borderTopWidth: 1,
            borderColor: kit.hairline,
            overflow: "hidden",
          }}
        >
          <View {...responder.panHandlers} style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10, gap: 10 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={up ? "Lower the sheet" : "Raise the sheet"}
              accessibilityState={{ expanded: up }}
              onPress={() => settle(up ? 0 : 1)}
              hitSlop={10}
              style={{ alignSelf: "center", paddingVertical: 4, paddingHorizontal: 24 }}
            >
              <View style={{ width: 36, height: 5, borderRadius: 3, backgroundColor: tint(kit.fg, 0.18) }} />
            </Pressable>
            <Text accessibilityRole="header" style={{ color: kit.fg, fontSize: 19, fontWeight: "600" }}>
              {title}
            </Text>
            {counts}
          </View>
          <ScrollView
            scrollEnabled={up}
            contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 80 + safe, gap: 14 }}
          >
            {children}
          </ScrollView>
        </View>
      </Animated.View>
      {toast?.({ bottom: toastBottoms(geometry).up, lift: drive.toastLift })}
    </View>
  );
}
