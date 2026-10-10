// The Undertow (broomva-design, agentic-work extension; JE rule 9): a running
// card wears a contained 4 px halo whose pools breathe (4.2 s), whose tide runs
// counter-phase (3.4 s) and under which a faint orbit passes (9 s). A running
// row gets the 15 px tidepool dot; standing work a quiet pulse. Running only:
// the components read the state and decide nothing else
// (client/kit/undertow-model.ts). Reduced motion stops every layer and the halo
// holds still. Gradients pass through react-native-web as backgroundImage; on
// iOS the halo is a still ring of tinted Views (client/kit/assumptions.ts A1).

import type { PluginTheme } from "@getpaseo/plugin";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Animated, Easing, type LayoutChangeEvent, Platform, View, type ViewStyle } from "react-native";
import { tint } from "../fleet-color";
import { useReducedMotion } from "../ui";
import { nativeDriver, type UndertowLook, undertowLook } from "./assumptions";
import { kitOf } from "./tokens";
import { UNDERTOW_MS, undertowMarks } from "./undertow-model";

/** A style key react-native-web passes to the DOM and React Native's types omit. */
const image = (backgroundImage: string) => ({ backgroundImage }) as unknown as ViewStyle;

/** A 0→1 value that loops over `ms` while `on`, and rests at `rest` when not. */
function useLoop(ms: number, on: boolean, rest = 0.5, alternate = false): Animated.Value {
  const value = useRef(new Animated.Value(rest)).current;
  useEffect(() => {
    if (!on) {
      value.setValue(rest);
      return;
    }
    const step = (to: number) =>
      Animated.timing(value, {
        toValue: to,
        duration: alternate ? ms / 2 : ms,
        easing: alternate ? Easing.inOut(Easing.sin) : Easing.linear,
        useNativeDriver: nativeDriver(Platform.OS),
      });
    value.setValue(0);
    const loop = Animated.loop(alternate ? Animated.sequence([step(1), step(0)]) : step(1));
    loop.start();
    return () => loop.stop();
  }, [ms, on, rest, alternate, value]);
  return value;
}

/**
 * A card's halo, only while `state` is running; any other state renders the
 * children as they are. `look` overrides the platform's (A1).
 */
export function Undertow({
  theme,
  state,
  children,
  look,
  radius = 16,
}: {
  theme: PluginTheme;
  state: string;
  children: ReactNode;
  look?: UndertowLook;
  radius?: number;
}) {
  const kit = kitOf(theme);
  const reduced = useReducedMotion();
  const halo = undertowMarks(state).halo;
  const chosen = look ?? undertowLook(Platform.OS);
  const moving = halo && chosen === "gradient" && !reduced;
  const pools = useLoop(UNDERTOW_MS.pools, moving, 0.5, true);
  const tide = useLoop(UNDERTOW_MS.tide, moving, 0.5, true);
  const orbit = useLoop(UNDERTOW_MS.orbit, moving, 0.15);
  const [box, setBox] = useState({ width: 0, height: 0 });
  if (!halo) return <>{children}</>;
  const frame: ViewStyle = { borderRadius: radius, padding: 4, overflow: "hidden" };
  const inner = (
    <View style={{ borderRadius: radius - 4, backgroundColor: kit.bg, overflow: "hidden" }}>{children}</View>
  );
  if (chosen === "ring") {
    return (
      <View
        testID="undertow-ring"
        style={{
          ...frame,
          backgroundColor: tint(kit.ice, kit.dark ? 0.35 : 0.6),
          borderWidth: 1,
          borderColor: tint(kit.blue, 0.45),
          padding: 3,
        }}
      >
        {inner}
      </View>
    );
  }
  const side = Math.ceil(Math.hypot(box.width, box.height));
  const fill = { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, pointerEvents: "none" } as const;
  return (
    <View
      testID="undertow-halo"
      onLayout={(event: LayoutChangeEvent) => setBox(event.nativeEvent.layout)}
      style={{ ...frame, backgroundColor: "rgba(161, 209, 244, 0.35)" }}
    >
      <Animated.View
        style={[
          fill,
          image("radial-gradient(ellipse 84% 110% at 22% 35%, rgba(55, 131, 240, 0.7), rgba(55, 131, 240, 0) 70%)"),
          { opacity: pools.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }) },
        ]}
      />
      <Animated.View
        style={[
          fill,
          image("radial-gradient(ellipse 72% 96% at 78% 65%, rgba(9, 183, 220, 0.7), rgba(9, 183, 220, 0) 70%)"),
          { opacity: pools.interpolate({ inputRange: [0, 1], outputRange: [1, 0.45] }) },
        ]}
      />
      <Animated.View
        style={[
          { position: "absolute", top: 0, bottom: 0, left: 0, width: box.width * 2, pointerEvents: "none" },
          image(
            "linear-gradient(90deg, rgba(55, 131, 240, 0) 30%, rgba(55, 131, 240, 0.28) 50%, rgba(161, 209, 244, 0.55) 58%, rgba(161, 209, 244, 0) 72%)",
          ),
          { transform: [{ translateX: tide.interpolate({ inputRange: [0, 1], outputRange: [0, -box.width] }) }] },
        ]}
      />
      {side > 0 ? (
        <Animated.View
          style={[
            {
              position: "absolute",
              width: side,
              height: side,
              left: (box.width - side) / 2,
              top: (box.height - side) / 2,
              opacity: 0.4,
              pointerEvents: "none",
            },
            image(
              "conic-gradient(rgba(55, 131, 240, 0) 58%, rgba(55, 131, 240, 0.18) 70%, rgb(55, 131, 240) 80%, rgb(161, 209, 244) 86%, rgba(161, 209, 244, 0) 92%)",
            ),
            { transform: [{ rotate: orbit.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }] },
          ]}
        />
      ) : null}
      {inner}
    </View>
  );
}

/** A running row's 15 px tidepool dot; nothing for any other state. */
export function TidepoolDot({
  theme,
  state,
  look,
  size = 15,
}: {
  theme: PluginTheme;
  state: string;
  look?: UndertowLook;
  size?: number;
}) {
  const kit = kitOf(theme);
  const reduced = useReducedMotion();
  const chosen = look ?? undertowLook(Platform.OS);
  const on = undertowMarks(state).dot;
  const turn = useLoop(UNDERTOW_MS.tide, on && chosen === "gradient" && !reduced, 0);
  if (!on) return null;
  const round = { width: size, height: size, borderRadius: size } as const;
  if (chosen === "ring") {
    return (
      <View
        testID="tidepool-dot"
        accessible={false}
        style={{ ...round, backgroundColor: kit.blue, borderWidth: 2, borderColor: tint(kit.ice, 0.9) }}
      />
    );
  }
  return (
    <Animated.View
      testID="tidepool-dot"
      accessible={false}
      style={[
        round,
        image("linear-gradient(200deg, #5480C7 20%, rgba(55, 131, 240, 0.55) 42%, #85CFF3 55%, #5480C7 80%)"),
        { transform: [{ rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }] },
      ]}
    />
  );
}

/** Standing work's quiet pulse: a ring that breathes round a still core; nothing for any other state. */
export function StandingPulse({ theme, state, size = 15 }: { theme: PluginTheme; state: string; size?: number }) {
  const kit = kitOf(theme);
  const reduced = useReducedMotion();
  const on = undertowMarks(state).pulse;
  const breathe = useLoop(UNDERTOW_MS.pools, on && !reduced, 1, true);
  if (!on) return null;
  const core = Math.round(size * 0.47);
  return (
    <View
      testID="standing-pulse"
      accessible={false}
      style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}
    >
      <Animated.View
        style={{
          position: "absolute",
          width: size,
          height: size,
          borderRadius: size,
          borderWidth: 2,
          borderColor: tint(kit.blue, 0.3),
          opacity: breathe.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }),
        }}
      />
      <View style={{ width: core, height: core, borderRadius: core, backgroundColor: kit.blue }} />
    </View>
  );
}
