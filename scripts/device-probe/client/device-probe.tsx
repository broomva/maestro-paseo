// BRO-3033 device probe: a throwaway screen that measures, on whatever host renders it, the facts the
// J/M build rests on: the params openScreen carries, the room the host leaves the screen, gradients,
// keyboard events, and how often the JS thread misses a frame while a PanResponder drives a view.
// Registered only by registerDeviceProbe; every reading is also logged with the "[probe]" prefix.

import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { TextInput as HostTextInput, ScrollView } from "@getpaseo/plugin/client/react-native";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Dimensions,
  Keyboard,
  PanResponder,
  Platform,
  Pressable,
  TextInput as RNTextInput,
  SafeAreaView,
  Text,
  View,
  type ViewStyle,
} from "react-native";

export const PROBE_SCREEN = "device-probe";

let mounts = 0;
let lastOpen = 0;

function log(...parts: unknown[]): void {
  console.log("[probe]", ...parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))));
}

interface FrameStats {
  frames: number;
  over20: number;
  over33: number;
  maxMs: number;
  medianMs: number;
}

/**
 * Counts animation frames from touch-down until the release spring settles (both run on the JS thread):
 * a frame later than 20 ms is a dropped one at 60 Hz. The median interval says which rate the screen runs at
 * (16.7 ms at 60 Hz, 8.3 ms at 120 Hz), so the threshold can be read against it.
 */
function useFrameMeter(name: string) {
  const [stats, setStats] = useState<FrameStats | null>(null);
  const state = useRef<{ raf: number; last: number; gaps: number[] } | null>(null);
  const meter = useMemo(() => {
    const stop = () => {
      const cur = state.current;
      if (!cur) return;
      cancelAnimationFrame(cur.raf);
      state.current = null;
      const gaps = [...cur.gaps].sort((a, b) => a - b);
      const s: FrameStats = {
        frames: gaps.length,
        over20: gaps.filter((g) => g > 20).length,
        over33: gaps.filter((g) => g > 33.4).length,
        maxMs: Math.round(gaps.at(-1) ?? 0),
        medianMs: Math.round((gaps[Math.floor(gaps.length / 2)] ?? 0) * 10) / 10,
      };
      setStats(s);
      log(`frames ${name}`, s);
    };
    return {
      start() {
        // A grab during the previous spring-back ends that measurement first, so two loops never share one.
        if (state.current) cancelAnimationFrame(state.current.raf);
        // Start from touch-down, so a stall before the first frame counts as a gap.
        const cur = { raf: 0, last: performance.now(), gaps: [] as number[] };
        const tick = (t: number) => {
          if (state.current !== cur) return;
          if (cur.last) cur.gaps.push(t - cur.last);
          cur.last = t;
          cur.raf = requestAnimationFrame(tick);
        };
        state.current = cur;
        cur.raf = requestAnimationFrame(tick);
      },
      stop,
    };
  }, [name]);
  return { stats, ...meter };
}

/**
 * A card the finger drags; on release it springs home carrying the gesture's velocity.
 * claim "start" takes the touch at once (a deck card); "move" takes it only once the drag is on its axis
 * (a row inside a vertical list).
 */
function DragProbe({
  name,
  axis,
  busyMs,
  claim = "start",
}: {
  name: string;
  axis: "x" | "y" | "xy";
  busyMs: number;
  claim?: "start" | "move";
}) {
  const pos = useRef(new Animated.ValueXY()).current;
  const meter = useFrameMeter(name);
  const { start, stop } = meter;
  const [outcome, setOutcome] = useState("");
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => claim === "start",
        onMoveShouldSetPanResponder: (_e, g) =>
          axis === "x" ? Math.abs(g.dx) > Math.abs(g.dy) : axis === "y" ? Math.abs(g.dy) > Math.abs(g.dx) : true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          pos.stopAnimation();
          start();
        },
        onPanResponderMove: (_e, g) => {
          // Optional synthetic render cost, to see how close a real card is to the edge.
          if (busyMs > 0) {
            const until = Date.now() + busyMs;
            while (Date.now() < until) {}
          }
          pos.setValue({ x: axis === "y" ? 0 : g.dx, y: axis === "x" ? 0 : g.dy });
        },
        onPanResponderRelease: (_e, g) => {
          log(`release ${name}`, { vx: g.vx, vy: g.vy });
          setOutcome(
            `released dx=${Math.round(g.dx)} dy=${Math.round(g.dy)} vx=${g.vx.toFixed(2)} vy=${g.vy.toFixed(2)}`,
          );
          Animated.spring(pos, {
            toValue: { x: 0, y: 0 },
            velocity: { x: g.vx, y: g.vy },
            useNativeDriver: false,
          }).start(({ finished }) => {
            // An interrupted spring (a new grab) leaves the new measurement running.
            if (finished) stop();
          });
        },
        onPanResponderTerminate: (_e, g) => {
          log(`terminated ${name}`);
          setOutcome(`TERMINATED by host at dx=${Math.round(g.dx)} dy=${Math.round(g.dy)}`);
          pos.setValue({ x: 0, y: 0 });
          stop();
        },
      }),
    [axis, busyMs, claim, name, pos, start, stop],
  );
  const s = meter.stats;
  return (
    <View style={{ gap: 4 }}>
      <Animated.View
        {...responder.panHandlers}
        style={{
          transform: pos.getTranslateTransform(),
          padding: 14,
          borderRadius: 12,
          backgroundColor: "#2f6fed",
        }}
      >
        <Text style={{ color: "white", fontWeight: "600" }}>
          {name} (drag {axis}
          {busyMs ? `, +${busyMs} ms per move` : ""})
        </Text>
      </Animated.View>
      <Text testID={`frames-${name}`} style={{ fontSize: 12 }}>
        {s
          ? `frames ${s.frames} · median ${s.medianMs}ms · >20ms ${s.over20} · >33ms ${s.over33} · max ${s.maxMs}ms`
          : "frames (drag + spring back): drag it, then let go"}
        {outcome ? ` · ${outcome}` : ""}
      </Text>
    </View>
  );
}

function Swatch({ label, style }: { label: string; style: Record<string, unknown> }) {
  return (
    <View style={{ gap: 4 }}>
      <View
        testID={`swatch-${label}`}
        style={[{ height: 56, borderRadius: 12, backgroundColor: "#888" }, style as ViewStyle]}
      />
      <Text style={{ fontSize: 12 }}>{label} (grey = the gradient did not render)</Text>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 8, paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#8884" }}>
      <Text style={{ fontWeight: "700", fontSize: 15 }}>{title}</Text>
      {children}
    </View>
  );
}

function Button({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, backgroundColor: "#8883" }}
    >
      <Text>{label}</Text>
    </Pressable>
  );
}

export function createDeviceProbe(client: Pick<PluginClientContext, "openScreen">) {
  return function DeviceProbe(props: PluginScreenProps) {
    const { params, layout } = props;
    const [mountId] = useState(() => {
      mounts += 1;
      return mounts;
    });
    const renders = useRef(0);
    renders.current += 1;
    const root = useRef<View>(null);
    const composer = useRef<View>(null);
    const [frame, setFrame] = useState<string>("");
    const [kb, setKb] = useState<string[]>([]);
    const [kbHeight, setKbHeight] = useState(0);
    const lift = useRef(0);
    const [liftState, setLiftState] = useState(0);
    const [safe, setSafe] = useState("");

    useEffect(() => {
      log("mount", { mountId, params, layout, platform: Platform.OS, version: Platform.Version });
      return () => log("unmount", { mountId });
    }, []);
    useEffect(() => {
      log("params", { mountId, params, sinceOpenMs: lastOpen ? Date.now() - lastOpen : null });
    }, [params]);

    useEffect(() => {
      const names = ["keyboardWillShow", "keyboardDidShow", "keyboardWillHide", "keyboardDidHide"] as const;
      const subs = names.map((n) =>
        Keyboard.addListener(n, (e) => {
          const h = e?.endCoordinates?.height ?? 0;
          const line = `${n} h=${Math.round(h)} screenY=${Math.round(e?.endCoordinates?.screenY ?? 0)} dur=${e?.duration ?? "?"}`;
          log("keyboard", line);
          setKb((prev) => [...prev.slice(-5), line]);
          setKbHeight(n === "keyboardWillShow" || n === "keyboardDidShow" ? h : 0);
          if (n === "keyboardWillHide" || n === "keyboardDidHide") {
            lift.current = 0;
            setLiftState(0);
            return;
          }
          // Lift by how far the keyboard's top edge reaches over the composer's bottom (measured with the
          // current lift applied), not by the raw height: the composer sits above the tab bar and the inset.
          const top = e?.endCoordinates?.screenY;
          if (top === undefined) return;
          composer.current?.measureInWindow((_x, y, _w, ch) => {
            const overlap = Math.round(y + ch - top);
            const next = Math.max(0, lift.current + overlap);
            const text = `${n}: composer bottom=${Math.round(y + ch)} keyboard top=${Math.round(top)} overlap=${overlap} → lift ${next}`;
            log("keyboard-overlap", text);
            setKb((prev) => [...prev.slice(-5), text]);
            lift.current = next;
            setLiftState(next);
          });
        }),
      );
      return () => {
        for (const s of subs) s.remove();
      };
    }, []);

    const measure = () => {
      root.current?.measureInWindow((x, y, w, h) => {
        // A hidden instance (an earlier openScreen still mounted) measures 0x0: not a reading.
        if (w === 0 || h === 0) return;
        const win = Dimensions.get("window");
        const scr = Dimensions.get("screen");
        const text = `screen top=${Math.round(y)} left=${Math.round(x)} w=${Math.round(w)} h=${Math.round(h)} · window ${win.width}x${win.height} · screen ${scr.width}x${scr.height} · room below=${Math.round(win.height - (y + h))}`;
        log("frame", { mountId, text });
        setFrame(text);
      });
    };

    const open = (p: Record<string, string>) => {
      lastOpen = Date.now();
      log("openScreen", p);
      client.openScreen({ screenId: PROBE_SCREEN, params: p });
    };

    return (
      <View ref={root} onLayout={measure} style={{ flex: 1, backgroundColor: props.theme.colors.surface0 }}>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 4 }}>
          <Text testID="probe-head" style={{ fontWeight: "700", fontSize: 18 }}>
            Device probe (BRO-3033)
          </Text>
          <Section title="1 · Host chrome and layout">
            <Text testID="probe-layout">
              platform {layout.platform} · compact {String(layout.compact)} · RN {Platform.OS}{" "}
              {String(Platform.Version)}
            </Text>
            <Text testID="probe-frame">{frame || "measuring…"}</Text>
          </Section>
          <Section title="2 · openScreen params">
            <Text testID="probe-params">params {JSON.stringify(params)}</Text>
            <Text testID="probe-mount">
              mount #{mountId} · renders {renders.current}
            </Text>
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              <Button label="hold=work-alpha" onPress={() => open({ hold: "work-alpha" })} />
              <Button label="hold=ask:7f3e" onPress={() => open({ hold: "ask:7f3e", tab: "decisions" })} />
              <Button
                label="hold=unicode+&/?#"
                onPress={() => open({ hold: "café & co/?#=1 ✓", long: "x".repeat(600) })}
              />
            </View>
          </Section>
          <Section title="5 · Gradients">
            <Swatch
              label="backgroundImage linear"
              style={{ backgroundImage: "linear-gradient(90deg, #2f6fed, #c43df0)" }}
            />
            <Swatch
              label="backgroundImage radial"
              style={{ backgroundImage: "radial-gradient(circle, #c43df0 0%, #2f6fed 60%, transparent 100%)" }}
            />
            <Swatch
              label="experimental_backgroundImage linear"
              style={{ experimental_backgroundImage: "linear-gradient(90deg, #2f6fed, #c43df0)" }}
            />
            <Swatch
              label="experimental_backgroundImage radial"
              style={{
                experimental_backgroundImage: "radial-gradient(circle, #c43df0 0%, #2f6fed 60%, transparent 100%)",
              }}
            />
            <Swatch label="boxShadow ring" style={{ backgroundColor: "#2f6fed33", boxShadow: "0 0 0 6px #c43df0" }} />
          </Section>
          <Section title="3 · PanResponder (JS thread)">
            <DragProbe name="deck" axis="x" busyMs={0} />
            <DragProbe name="sheet" axis="y" busyMs={0} />
            <DragProbe name="deck-busy" axis="x" busyMs={8} />
            <ScrollView horizontal={false} style={{ maxHeight: 120 }} nestedScrollEnabled>
              <DragProbe name="row-in-scroll" axis="x" busyMs={0} claim="move" />
              <Text style={{ fontSize: 12, paddingVertical: 40 }}>(vertical scroll room)</Text>
            </ScrollView>
          </Section>
          <Section title="4 · Keyboard">
            <Text testID="probe-kb">{kb.length ? kb.join("\n") : "no keyboard events yet"}</Text>
            <Text testID="probe-kb-height">
              keyboard height {Math.round(kbHeight)} · composer lift {liftState}
            </Text>
            <HostTextInput
              testID="probe-host-input"
              placeholder="host TextInput"
              style={{ borderWidth: 1, borderColor: "#888", borderRadius: 8, padding: 8 }}
            />
            <RNTextInput
              testID="probe-rn-input"
              placeholder="react-native TextInput"
              style={{ borderWidth: 1, borderColor: "#888", borderRadius: 8, padding: 8 }}
            />
          </Section>
          <View style={{ height: 320 }} />
        </ScrollView>
        <View
          ref={composer}
          testID="probe-composer"
          style={{
            padding: 8,
            marginBottom: liftState,
            borderTopWidth: 1,
            borderTopColor: "#888",
            backgroundColor: props.theme.colors.surface1,
          }}
        >
          <RNTextInput
            testID="probe-composer-input"
            placeholder="bottom composer: does it sit just above the keyboard?"
            style={{ borderWidth: 1, borderColor: "#888", borderRadius: 8, padding: 8 }}
          />
        </View>
        <SafeAreaView style={{ backgroundColor: "#c43df0" }}>
          <View
            testID="probe-tabbar"
            onLayout={(e) => {
              const t = `tab bar content h=${Math.round(e.nativeEvent.layout.height)} y=${Math.round(e.nativeEvent.layout.y)}`;
              log("safe-area", t);
              setSafe(t);
            }}
            style={{ height: 49, alignItems: "center", justifyContent: "center", backgroundColor: "#2f6fed" }}
          >
            <Text style={{ color: "white", fontSize: 12 }}>
              M1 tab bar in RN SafeAreaView (purple below = bottom inset) {safe}
            </Text>
          </View>
        </SafeAreaView>
      </View>
    );
  };
}

/** Adds the probe screen and a sidebar row that opens it with a hold param. */
export function registerDeviceProbe(client: PluginClientContext): () => void {
  const offScreen = client.addScreen({
    id: PROBE_SCREEN,
    title: (p) => (p.hold ? `Probe · ${p.hold}` : "Probe"),
    Component: createDeviceProbe(client),
  });
  const offRow = client.addSidebarHeaderItem({
    id: "device-probe-row",
    title: "Device probe",
    Component: (props: PluginSidebarItemProps) => (
      <SidebarRow
        icon="FlaskConical"
        label="Device probe"
        active={props.currentScreen?.screenId === PROBE_SCREEN}
        onPress={() => props.openScreen({ screenId: PROBE_SCREEN, params: { hold: "from-sidebar" } })}
      />
    ),
  });
  return () => {
    offScreen();
    offRow();
  };
}
