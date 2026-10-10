// The swipe row (M/Row, Pen xqZXY; M1d's swipes, on M1's sheet rows only):
// lead mark, title, mono meta, age. Swipe right for the row's default verb
// (Continue, Done); swipe left to show Snooze and Open. A hold never swipes
// (client/kit/swipe-model.ts): its PanResponder never takes the gesture, and it
// draws no actions behind it. PanResponder and Animated only.

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Animated, type LayoutChangeEvent, PanResponder, Platform, Pressable, Text, View } from "react-native";
import { useReducedMotion } from "../ui";
import { nativeDriver } from "./assumptions";
import { MONO, TABULAR } from "./parts";
import { actionsWidth, canSwipe, SWIPE, swipeCaptures, swipeOffset, swipeRelease } from "./swipe-model";
import { kitOf } from "./tokens";

export interface RowAction {
  label: string;
  icon: string;
  onPress: () => void;
}

export function SwipeRow({
  theme,
  kind,
  title,
  meta,
  age,
  lead,
  onPress,
  primary,
  snooze,
  open,
  preview,
}: {
  theme: PluginTheme;
  /** The row's kind; a hold (ask, approval, owner-step) never swipes. */
  kind: string;
  title: string;
  meta?: string;
  age?: string;
  lead?: ReactNode;
  onPress?: () => void;
  /** The right swipe's verb: Continue, Done. */
  primary?: RowAction;
  /** The left swipe's first action, when the row can be snoozed. */
  snooze?: RowAction;
  /** The left swipe's Open. */
  open?: RowAction;
  /** A still state for the gallery: the left actions shown, or the right swipe half way. */
  preview?: "open" | "commit";
}) {
  const kit = kitOf(theme);
  const swipes = canSwipe(kind);
  const actions = swipes ? [snooze, open].filter((a): a is RowAction => Boolean(a)) : [];
  const [width, setWidth] = useState(0);
  const start = preview === "open" ? -actionsWidth(actions.length) : 0;
  const x = useRef(new Animated.Value(start)).current;
  const opened = useRef(preview === "open");
  const [shown, setShown] = useState<"left" | "right" | null>(preview === "open" ? "left" : preview ? "right" : null);
  const reduced = useReducedMotion();
  const live = useRef({ width, actions: actions.length, primary, kind, reduced });
  live.current = { width, actions: actions.length, primary, kind, reduced };
  useEffect(() => {
    if (preview === "commit" && width > 0) x.setValue(width * 0.3);
  }, [preview, width, x]);

  // Springs carry the release's velocity; under reduced motion the row snaps.
  const settle = useMemo(
    () => (to: number, velocity: number, done?: () => void) => {
      if (live.current.reduced) {
        x.setValue(to);
        done?.();
        return;
      }
      Animated.spring(x, {
        toValue: to,
        velocity,
        damping: 22,
        stiffness: 240,
        useNativeDriver: nativeDriver(Platform.OS),
      }).start(done);
    },
    [x],
  );

  const responder = useMemo(() => {
    return PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => swipeCaptures(live.current.kind, g.dx, g.dy),
      onPanResponderGrant: () => x.stopAnimation(),
      onPanResponderMove: (_, g) => {
        const at = swipeOffset(g.dx, opened.current, live.current.actions);
        setShown(at > 0 ? "right" : at < 0 ? "left" : null);
        x.setValue(live.current.primary || at <= 0 ? at : 0);
      },
      onPanResponderRelease: (_, g) => {
        const { width: w, actions: count, primary: verb } = live.current;
        const end = swipeRelease(g.dx, g.vx, w, opened.current, count);
        if (end === "commit" && verb) {
          opened.current = false;
          settle(w, g.vx * 1000, () => {
            verb.onPress();
            x.setValue(0);
            setShown(null);
          });
        } else if (end === "reveal") {
          opened.current = true;
          settle(-actionsWidth(count), g.vx * 1000);
        } else {
          opened.current = false;
          settle(0, g.vx * 1000, () => setShown(null));
        }
      },
      onPanResponderTerminate: () => {
        opened.current = false;
        settle(0, 0, () => setShown(null));
      },
    });
  }, [x, settle]);

  const close = () => {
    opened.current = false;
    settle(0, 0, () => setShown(null));
  };

  return (
    <View
      testID={`swipe-row-${kind}`}
      onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
      style={{ overflow: "hidden", backgroundColor: kit.bg }}
    >
      {swipes && shown === "right" && primary ? (
        <View
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            backgroundColor: kit.ok,
            flexDirection: "row",
            alignItems: "center",
            paddingLeft: 18,
            gap: 8,
          }}
        >
          <Icon name={primary.icon} size={17} color="#ffffff" />
          <Text style={{ color: "#ffffff", fontSize: 13, fontWeight: "600" }}>{primary.label}</Text>
        </View>
      ) : null}
      {swipes && shown === "left" ? (
        <View style={{ position: "absolute", top: 0, bottom: 0, right: 0, flexDirection: "row" }}>
          {actions.map((action) => (
            <Pressable
              key={action.label}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              onPress={() => {
                close();
                action.onPress();
              }}
              style={{
                width: SWIPE.action,
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                backgroundColor: action === snooze ? kit.warn : kit.blue,
              }}
            >
              <Icon name={action.icon} size={17} color="#ffffff" />
              <Text style={{ color: "#ffffff", fontSize: 11.5, fontWeight: "600" }}>{action.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <Animated.View
        {...(swipes ? responder.panHandlers : null)}
        style={{ transform: [{ translateX: x }], backgroundColor: kit.bg }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={[title, meta, age].filter(Boolean).join(", ")}
          accessibilityActions={
            swipes
              ? actions.concat(primary ? [primary] : []).map((a) => ({ name: a.label, label: a.label }))
              : undefined
          }
          onAccessibilityAction={(event) =>
            [primary, ...actions].find((a) => a?.label === event.nativeEvent.actionName)?.onPress()
          }
          onPress={onPress}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            paddingVertical: 11,
            paddingHorizontal: 14,
            backgroundColor: pressed ? kit.sunken : kit.bg,
          })}
        >
          <View style={{ width: 18, alignItems: "center" }}>{lead}</View>
          <View style={{ flex: 1, gap: 1 }}>
            <Text numberOfLines={1} style={{ color: kit.fg, fontSize: 14, fontWeight: "500" }}>
              {title}
            </Text>
            {meta ? (
              <Text numberOfLines={1} style={{ color: kit.muted, fontSize: 11.5, fontFamily: MONO }}>
                {meta}
              </Text>
            ) : null}
          </View>
          {age ? <Text style={{ color: kit.muted, fontSize: 12, ...TABULAR }}>{age}</Text> : null}
        </Pressable>
      </Animated.View>
    </View>
  );
}
