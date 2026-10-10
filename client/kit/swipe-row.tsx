// The swipe row (M/Row, Pen xqZXY; M1d's swipes, on M1's sheet rows only):
// lead mark, title, mono meta, age. Swipe right for the row's default verb
// (Continue, Done); swipe left to show Snooze and Open. On compact native a
// rightward drag is Paseo's (BRO-3033 fact 3), so `directions` bars it there and
// the default verb becomes the first left action; a drag the host takes springs
// the row home. A hold never swipes (client/kit/swipe-model.ts): its
// PanResponder never takes the gesture, and it draws no actions behind it.
// Every action is also an accessibility action. PanResponder and Animated only.

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Animated, type LayoutChangeEvent, PanResponder, Pressable, Text, View } from "react-native";
import { useReducedMotion } from "../ui";
import { BOTH_WAYS, type Directions, DRAG_NATIVE_DRIVER } from "./assumptions";
import { CLIP, MONO, TABULAR } from "./parts";
import { actionsWidth, canSwipe, leftActions, SWIPE, swipeCaptures, swipeOffset, swipeRelease } from "./swipe-model";
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
  directions,
}: {
  theme: PluginTheme;
  /** The row's kind; a hold (ask, approval, owner-step) never swipes. */
  kind: string;
  title: string;
  meta?: string;
  age?: string;
  lead?: ReactNode;
  onPress?: () => void;
  /** The default verb: Continue, Done. A right swipe where one is allowed, else the first left action. */
  primary?: RowAction;
  /** The left swipe's first action, when the row can be snoozed. */
  snooze?: RowAction;
  /** The left swipe's Open. */
  open?: RowAction;
  /** A still state for the gallery: the left actions shown, or the right swipe half way. */
  preview?: "open" | "commit";
  /** Which ways it swipes: the screen passes swipeDirections(layout) (BRO-3033 fact 3). */
  directions: Directions;
}) {
  const kit = kitOf(theme);
  const ways = directions;
  const swipes = canSwipe(kind);
  const actions = swipes ? leftActions(ways, primary, snooze, open) : [];
  const rightVerb = ways.right ? primary : undefined;
  const [width, setWidth] = useState(0);
  const start = preview === "open" ? -actionsWidth(actions.length) : 0;
  const x = useRef(new Animated.Value(start)).current;
  // Whether the left actions show: a ref for the gesture handlers, and state so a render knows it too (a tap on
  // an open row closes it instead of opening the item; on compact native that tap is the only way to close it).
  const opened = useRef(preview === "open");
  const [isOpen, setIsOpen] = useState(preview === "open");
  const markOpen = useRef((open: boolean) => {
    opened.current = open;
    setIsOpen(open);
  }).current;
  const [shown, setShown] = useState<"left" | "right" | null>(preview === "open" ? "left" : preview ? "right" : null);
  const reduced = useReducedMotion();
  const live = useRef({ width, actions: actions.length, primary: rightVerb, kind, reduced, ways });
  live.current = { width, actions: actions.length, primary: rightVerb, kind, reduced, ways };
  useEffect(() => {
    if (preview === "commit" && width > 0 && ways.right) x.setValue(width * 0.3);
  }, [preview, width, x, ways.right]);

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
        useNativeDriver: DRAG_NATIVE_DRIVER,
      }).start(done);
    },
    [x],
  );

  const origin = useRef(start);
  const responder = useMemo(() => {
    const travelled = (dx: number) => dx + origin.current - (opened.current ? -actionsWidth(live.current.actions) : 0);
    return PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => swipeCaptures(live.current.kind, g.dx, g.dy, live.current.ways),
      // A row caught mid-spring moves on from where it is: the drag is measured from its resting place.
      onPanResponderGrant: () => {
        x.stopAnimation((at) => {
          origin.current = at;
        });
      },
      onPanResponderMove: (_, g) => {
        const at = swipeOffset(travelled(g.dx), opened.current, live.current.actions, live.current.ways);
        setShown(at > 0 ? "right" : at < 0 ? "left" : null);
        x.setValue(live.current.primary || at <= 0 ? at : 0);
      },
      onPanResponderRelease: (_, g) => {
        const { width: w, actions: count, primary: verb, ways: allowed } = live.current;
        const end = swipeRelease(travelled(g.dx), g.vx, w, opened.current, count, allowed);
        if (end === "commit" && verb) {
          markOpen(false);
          settle(w, g.vx * 1000, () => {
            verb.onPress();
            x.setValue(0);
            setShown(null);
          });
        } else if (end === "reveal") {
          markOpen(true);
          settle(-actionsWidth(count), g.vx * 1000);
        } else {
          markOpen(false);
          settle(0, g.vx * 1000, () => setShown(null));
        }
      },
      // The host took the gesture (on compact native, any rightward drag): spring home, shut.
      onPanResponderTerminate: () => {
        markOpen(false);
        settle(0, 0, () => setShown(null));
      },
    });
  }, [x, settle, markOpen]);

  const close = () => {
    markOpen(false);
    settle(0, 0, () => setShown(null));
  };

  return (
    <View
      testID={`swipe-row-${kind}`}
      onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
      style={{ ...CLIP, backgroundColor: kit.bg }}
    >
      {swipes && shown === "right" && rightVerb ? (
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
          <Icon name={rightVerb.icon} size={17} color="#ffffff" />
          <Text style={{ color: "#ffffff", fontSize: 13, fontWeight: "600" }}>{rightVerb.label}</Text>
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
                backgroundColor: action === primary ? kit.ok : action === snooze ? kit.warn : kit.blue,
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
              ? leftActions(BOTH_WAYS, primary, snooze, open)
                  .concat(primary ? [primary] : [])
                  .map((a) => ({ name: a.label, label: a.label }))
              : undefined
          }
          onAccessibilityAction={(event) =>
            [primary, ...actions].find((a) => a?.label === event.nativeEvent.actionName)?.onPress()
          }
          onPress={isOpen ? close : onPress}
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
