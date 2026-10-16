// The phone's deck (M1c, in M1): what needs you on this tab, one hold at a
// time. A large title with the workspace and presence beside it, one segment
// per hold with "1 of 4", then the hold as a card whose verbs are 52 pt
// pills. Swipe sideways for the next hold; the next card's edge shows at the
// right so the swipe is discoverable. Each segment is a tap target too: on
// compact native a rightward swipe is Paseo's (BRO-3033 fact 3), so `directions`
// bars it there, and the segments are the way back. The deck opens on `openOn`
// (a hold key, from the screen's `params.hold`). PanResponder and Animated
// only; the thresholds are client/kit/deck-model.ts.

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Animated, type LayoutChangeEvent, PanResponder, Pressable, Text, View } from "react-native";
import { tint } from "../fleet-color";
import { useReducedMotion } from "../ui";
import { BOTH_WAYS as BOTH, type Directions, DRAG_NATIVE_DRIVER } from "./assumptions";
import { clampIndex, DECK, deckCaptures, deckOffset, deckRelease, indexOfKey, place } from "./deck-model";
import { CLIP, Kicker, Pill, TABULAR } from "./parts";
import { kitOf } from "./tokens";

/** How much of the next card shows at the right edge. */
const PEEK = 14;

/** One spring for paging and for springing home, so the two feel alike. */
const DECK_SPRING = { damping: 24, stiffness: 220 } as const;

export function Deck<T>({
  theme,
  title,
  trailing,
  items,
  index: wanted,
  onIndexChange,
  renderItem,
  keyOf,
  empty,
  directions,
  openOn,
}: {
  theme: PluginTheme;
  title: string;
  /** Beside the title: the workspace filter and presence. */
  trailing?: ReactNode;
  items: readonly T[];
  index: number;
  onIndexChange: (index: number) => void;
  renderItem: (item: T, index: number) => ReactNode;
  keyOf: (item: T) => string;
  /** What the deck says when nothing needs you. */
  empty?: ReactNode;
  /** Which ways it swipes: the screen passes swipeDirections(layout) (BRO-3033 fact 3). */
  directions: Directions;
  /** The hold to open on, by key, once when the deck mounts (the screen's `params.hold`). */
  openOn?: string;
}) {
  const kit = kitOf(theme);
  const reduced = useReducedMotion();
  const ways = directions;
  // The deck never trusts an index past its holds: when the list shrinks under it, it shows the last and says so.
  const index = clampIndex(wanted, items.length);
  useEffect(() => {
    if (items.length > 0 && wanted !== index) onIndexChange(index);
  }, [wanted, index, items.length, onIndexChange]);
  const [width, setWidth] = useState(0);
  const cardWidth = Math.max(0, width - PEEK - DECK.gap);
  const x = useRef(new Animated.Value(0)).current;
  const live = useRef({ index, count: items.length, cardWidth, onIndexChange, ways, reduced });
  live.current = { index, count: items.length, cardWidth, onIndexChange, ways, reduced };

  // Open on the hold the screen was opened with, once: later moves are the deck's own state.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || openOn === undefined || items.length === 0) return;
    opened.current = true;
    const at = indexOfKey(items.map(keyOf), openOn);
    if (at !== index) onIndexChange(at);
  }, [openOn, items, keyOf, index, onIndexChange]);

  // The velocity a fling released with, carried into the page it lands on so the strip does not stop at the finger.
  const fling = useRef(0);
  // Whether the strip has been placed once: the first placement (and a hold opened by `openOn`) does not slide in.
  const placed = useRef(false);
  useEffect(() => {
    const to = deckOffset(index, items.length, 0, cardWidth, BOTH);
    const velocity = fling.current;
    fling.current = 0;
    if (cardWidth === 0) return;
    if (reduced || !placed.current) {
      placed.current = true;
      x.setValue(to);
      return;
    }
    Animated.spring(x, { toValue: to, velocity, ...DECK_SPRING, useNativeDriver: DRAG_NATIVE_DRIVER }).start();
  }, [index, items.length, cardWidth, reduced, x]);

  // Where the strip stood when the finger landed: a grab mid-spring moves on from there, never from the target.
  const origin = useRef(0);
  const responder = useMemo(() => {
    // Home: the current hold's place. The host terminates rightward drags on compact native, so this runs often.
    const home = (velocity: number) => {
      const { index: at, count, cardWidth: w, reduced: still } = live.current;
      const to = deckOffset(at, count, 0, w, BOTH);
      if (still) x.setValue(to);
      else Animated.spring(x, { toValue: to, velocity, ...DECK_SPRING, useNativeDriver: DRAG_NATIVE_DRIVER }).start();
    };
    // The drag measured from the hold's place, so a strip caught mid-spring carries its offset into the drag.
    const travelled = (dx: number) => {
      const { index: at, count, cardWidth: w } = live.current;
      return dx + origin.current - deckOffset(at, count, 0, w, BOTH);
    };
    const barred = (dx: number) => (dx > 0 ? !live.current.ways.right : !live.current.ways.left);
    return PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => deckCaptures(g.dx, g.dy, live.current.ways),
      // A sideways drag is the deck's before a row, a field or a pill inside the card can keep it (BRO-3153).
      onMoveShouldSetPanResponderCapture: (_, g) => deckCaptures(g.dx, g.dy, live.current.ways),
      // Once it is the deck's, the page's vertical scroll may not take it mid-drag: that sprang it home. The host
      // can still end it (its rightward sidebar gesture on compact native, BRO-3033 fact 3), and home(0) runs then.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        x.stopAnimation((at) => {
          origin.current = at;
        });
      },
      onPanResponderMove: (_, g) => {
        const { index: at, count, cardWidth: w } = live.current;
        // A barred way holds the strip where it is: no jump, no movement.
        x.setValue(barred(g.dx) ? origin.current : deckOffset(at, count, travelled(g.dx), w, BOTH));
      },
      onPanResponderRelease: (_, g) => {
        const { index: at, count, cardWidth: w, onIndexChange: change, ways: allowed } = live.current;
        const next = barred(g.dx) ? at : deckRelease(at, count, travelled(g.dx), g.vx, w, allowed);
        if (next !== at) {
          fling.current = g.vx * 1000;
          change(next);
        } else home(g.vx * 1000);
      },
      onPanResponderTerminate: () => home(0),
    });
  }, [x]);

  return (
    <View testID="deck" style={{ gap: 10 }}>
      {/* Above the cards: the workspace and presence menus open from here and must paint over them. */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, zIndex: 20 }}>
        <Text accessibilityRole="header" style={{ flex: 1, color: kit.fg, fontSize: 24, fontWeight: "700" }}>
          {title}
        </Text>
        {trailing}
      </View>
      {items.length > 0 ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ flex: 1, flexDirection: "row", gap: 6 }}>
            {items.map((item, at) => (
              <Pressable
                key={keyOf(item)}
                accessibilityRole="button"
                accessibilityLabel={`Hold ${place(at, items.length)}`}
                accessibilityState={{ selected: at === index }}
                onPress={() => onIndexChange(at)}
                hitSlop={{ top: 14, bottom: 14 }}
                style={{ flex: 1, paddingVertical: 6 }}
              >
                <View
                  style={{
                    height: 4,
                    borderRadius: 2,
                    backgroundColor: at === index ? kit.needs : tint(kit.fg, 0.12),
                  }}
                />
              </Pressable>
            ))}
          </View>
          <StepButton
            theme={theme}
            icon="ChevronLeft"
            label="Previous hold"
            disabled={index <= 0}
            onPress={() => onIndexChange(index - 1)}
          />
          <Text style={{ color: kit.muted, fontSize: 12, ...TABULAR }}>{place(index, items.length)}</Text>
          <StepButton
            theme={theme}
            icon="ChevronRight"
            label="Next hold"
            disabled={index >= items.length - 1}
            onPress={() => onIndexChange(index + 1)}
          />
        </View>
      ) : null}
      <View onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)} style={CLIP}>
        {items.length === 0 ? (
          empty
        ) : (
          <Animated.View
            {...responder.panHandlers}
            accessibilityHint={ways.right ? "Swipe sideways for the next hold" : "Swipe left for the next hold"}
            style={{ flexDirection: "row", gap: DECK.gap, transform: [{ translateX: x }] }}
          >
            {items.map((item, at) => (
              <View
                key={keyOf(item)}
                style={{ width: cardWidth || undefined }}
                accessibilityElementsHidden={at !== index}
                importantForAccessibility={at === index ? "auto" : "no-hide-descendants"}
              >
                {renderItem(item, at)}
              </View>
            ))}
          </Animated.View>
        )}
      </View>
    </View>
  );
}

/**
 * One step back or on (BRO-3153): a 48 pt tall target beside "n of N". On compact native a rightward swipe is Paseo's
 * sidebar (BRO-3033 fact 3), and the segments are 4 pt tall, so going back was the hardest move on the deck.
 */
function StepButton({
  theme,
  icon,
  label,
  disabled,
  onPress,
}: {
  theme: PluginTheme;
  icon: "ChevronLeft" | "ChevronRight";
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const kit = kitOf(theme);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
      style={({ pressed }: { pressed: boolean }) => ({
        width: 32,
        height: 32,
        borderRadius: 16,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed ? kit.hairline : kit.sunken,
        opacity: disabled ? 0.35 : 1,
      })}
    >
      <Icon name={icon} size={18} color={kit.fg} />
    </Pressable>
  );
}

export interface DeckVerb {
  label: string;
  primary?: boolean;
  /** What a screen reader says when the label alone does not ("Answer: Keep them off"). */
  accessibilityLabel?: string;
  /** A verb of this hold is waiting out its undo window, or the call is in flight: it cannot be pressed again. */
  disabled?: boolean;
  onPress: () => void;
}

/**
 * A hold as the deck shows it (M1 frames 1, 3 and 4): the kicker, a large
 * title, why it is yours, the kind's evidence, a link to the full card, and the
 * kind's verbs as 52 pt pills.
 */
export function DeckHold({
  theme,
  icon,
  kicker,
  age,
  title,
  summary,
  children,
  onDetails,
  verbs,
}: {
  theme: PluginTheme;
  icon: string;
  kicker: readonly string[];
  age?: string;
  title: string;
  summary?: string;
  children?: ReactNode;
  onDetails?: () => void;
  verbs: readonly DeckVerb[];
}) {
  const kit = kitOf(theme);
  return (
    <View
      style={{
        backgroundColor: kit.bg,
        borderRadius: 18,
        borderWidth: 1.5,
        borderColor: kit.needsLine,
        paddingVertical: 16,
        paddingHorizontal: 18,
        gap: 12,
        shadowColor: "#0c101a",
        shadowOpacity: kit.dark ? 0.4 : 0.07,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 2 },
      }}
    >
      <Kicker theme={theme} icon={icon} parts={age ? [...kicker, age] : kicker} />
      <Text style={{ color: kit.fg, fontSize: 25, lineHeight: 31, fontWeight: "600", letterSpacing: -0.3 }}>
        {title}
      </Text>
      {summary ? <Text style={{ color: kit.fg2, fontSize: 15.5, lineHeight: 22 }}>{summary}</Text> : null}
      {children}
      {onDetails ? (
        <Pressable
          accessibilityRole="link"
          onPress={onDetails}
          style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 4 }}
        >
          <Text style={{ color: kit.info, fontSize: 14 }}>Details, session and history</Text>
          <Icon name="ChevronRight" size={15} color={kit.info} />
        </Pressable>
      ) : null}
      <View style={{ flexDirection: "row", gap: 10, paddingTop: 2 }}>
        {verbs.map((verb) => (
          <Pill
            key={verb.label}
            theme={theme}
            label={verb.label}
            primary={verb.primary}
            disabled={verb.disabled}
            accessibilityLabel={verb.accessibilityLabel}
            onPress={verb.onPress}
            height={DECK.verb}
            grow
          />
        ))}
      </View>
    </View>
  );
}
