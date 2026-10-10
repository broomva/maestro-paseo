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
}

/**
 * Counts animation frames from touch-down until the release spring settles (both run on the JS thread):
 * a frame later than 20 ms is a dropped one at 60 Hz.
 */
function useFrameMeter(name: string) {
  const [stats, setStats] = useState<FrameStats | null>(null);
  const state = useRef<{ raf: number; last: number; s: FrameStats } | null>(null);
  return {
    stats,
    start() {
      const s: FrameStats = { frames: 0, over20: 0, over33: 0, maxMs: 0 };
      const tick = (t: number) => {
        const cur = state.current;
        if (!cur) return;
        if (cur.last) {
          const dt = t - cur.last;
          s.frames += 1;
          if (dt > 20) s.over20 += 1;
          if (dt > 33.4) s.over33 += 1;
          if (dt > s.maxMs) s.maxMs = Math.round(dt);
        }
        cur.last = t;
        cur.raf = requestAnimationFrame(tick);
      };
      state.current = { raf: requestAnimationFrame(tick), last: 0, s };
    },
    stop() {
      const cur = state.current;
      if (!cur) return;
      cancelAnimationFrame(cur.raf);
      state.current = null;
      setStats({ ...cur.s });
      log(`frames ${name}`, cur.s);
    },
  };
}

/** A card the finger drags anywhere; on release it springs home carrying the gesture's velocity. */
function DragProbe({ name, axis, busyMs }: { name: string; axis: "x" | "y" | "xy"; busyMs: number }) {
  const pos = useRef(new Animated.ValueXY()).current;
  const meter = useFrameMeter(name);
  const [outcome, setOutcome] = useState("");
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_e, g) =>
          axis === "x" ? Math.abs(g.dx) > Math.abs(g.dy) : axis === "y" ? Math.abs(g.dy) > Math.abs(g.dx) : true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => meter.start(),
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
          }).start(() => meter.stop());
        },
        onPanResponderTerminate: (_e, g) => {
          log(`terminated ${name}`);
          setOutcome(`TERMINATED by host at dx=${Math.round(g.dx)} dy=${Math.round(g.dy)}`);
          pos.setValue({ x: 0, y: 0 });
          meter.stop();
        },
      }),
    [axis, busyMs, meter, name, pos, setOutcome],
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
          ? `frames ${s.frames} · >20ms ${s.over20} · >33ms ${s.over33} · max ${s.maxMs}ms`
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
          // How far the keyboard's top edge reaches over the composer's bottom: the lift a composer needs.
          const top = e?.endCoordinates?.screenY;
          if (top !== undefined) {
            composer.current?.measureInWindow((_x, y, _w, ch) => {
              const overlap = `${n}: composer bottom=${Math.round(y + ch)} keyboard top=${Math.round(top)} overlap=${Math.round(y + ch - top)}`;
              log("keyboard-overlap", overlap);
              setKb((prev) => [...prev.slice(-5), overlap]);
            });
          }
          if (n === "keyboardWillShow" || n === "keyboardDidShow") setKbHeight(h);
          if (n === "keyboardWillHide" || n === "keyboardDidHide") setKbHeight(0);
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
              <DragProbe name="row-in-scroll" axis="x" busyMs={0} />
              <Text style={{ fontSize: 12, paddingVertical: 40 }}>(vertical scroll room)</Text>
            </ScrollView>
          </Section>
          <Section title="4 · Keyboard">
            <Text testID="probe-kb">{kb.length ? kb.join("\n") : "no keyboard events yet"}</Text>
            <Text testID="probe-kb-height">keyboard height {Math.round(kbHeight)}</Text>
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
            marginBottom: kbHeight,
            borderTopWidth: 1,
            borderTopColor: "#888",
            backgroundColor: props.theme.colors.surface1,
          }}
        >
          <RNTextInput
            testID="probe-composer-input"
            placeholder="bottom composer: does it ride the keyboard?"
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
