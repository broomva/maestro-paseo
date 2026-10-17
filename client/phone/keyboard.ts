// How a sheet of ours rises with the software keyboard (BRO-3033 fact 4: Paseo's host does not move a plugin's
// views for it, and `keyboardWillShow` carries the height and the duration of the animation iOS runs). The lift
// is the keyboard's height less the safe area the sheet already stands above, never negative; a sheet that
// stands at the bottom rises by it and returns on `keyboardWillHide`. The web has no such event: the lift stays 0.

import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Keyboard, Platform } from "react-native";
import { keyboardLift, keyboardOverlap, viewportInset } from "./keyboard-lift";

/** The events carrying it: iOS announces the animation before it runs; elsewhere it is announced after. */
export const KEYBOARD_EVENTS =
  Platform.OS === "ios"
    ? ({ show: "keyboardWillShow", hide: "keyboardWillHide" } as const)
    : ({ show: "keyboardDidShow", hide: "keyboardDidHide" } as const);

/** An animated lift that follows the keyboard; `safeBottom` is the home indicator's height the sheet stands above. */
export function useKeyboardLift(safeBottom: number): Animated.Value {
  const lift = useRef(new Animated.Value(0)).current;
  const safe = useRef(safeBottom);
  safe.current = safeBottom;
  useEffect(() => {
    const to = (value: number, duration: number) =>
      Animated.timing(lift, {
        toValue: value,
        duration,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }).start();
    const shown = Keyboard.addListener(KEYBOARD_EVENTS.show, (event) =>
      to(keyboardLift(event.endCoordinates.height, safe.current), event.duration ?? 250),
    );
    const hidden = Keyboard.addListener(KEYBOARD_EVENTS.hide, (event) => to(0, event.duration ?? 250));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, [lift]);
  return lift;
}

type Measurable = { measureInWindow?: (done: (x: number, y: number, width: number, height: number) => void) => void };
type VisualViewport = {
  height: number;
  offsetTop: number;
  addEventListener(type: "resize" | "scroll", listener: () => void): void;
  removeEventListener(type: "resize" | "scroll", listener: () => void): void;
};

/**
 * How much of a bottom view the software keyboard covers, in px, as state (BRO-3180: the ask card). Native: the RN
 * `Keyboard` events, the overlap measured against the view's own bottom edge (device-checks fact 4 — the host insets
 * nothing), and the keyboard's height less `safeBottom` when the view cannot be measured. The web: the visual viewport,
 * which the keyboard shrinks while the layout viewport stays (iOS Safari, a webview). 0 with no keyboard.
 */
export function useKeyboardInset(view: { current: unknown }, safeBottom = 0): number {
  const [inset, setInset] = useState(0);
  const safe = useRef(safeBottom);
  safe.current = safeBottom;
  useEffect(() => {
    const viewport = (globalThis as { window?: { visualViewport?: VisualViewport; innerHeight?: number } }).window;
    const visual = Platform.OS === "web" ? viewport?.visualViewport : undefined;
    if (visual && viewport) {
      const read = () =>
        setInset(viewportInset(viewport.innerHeight ?? visual.height, visual.height, visual.offsetTop));
      read();
      visual.addEventListener("resize", read);
      visual.addEventListener("scroll", read);
      return () => {
        visual.removeEventListener("resize", read);
        visual.removeEventListener("scroll", read);
      };
    }
    const shown = Keyboard.addListener(KEYBOARD_EVENTS.show, (event) => {
      const fallback = keyboardLift(event.endCoordinates.height, safe.current);
      const target = view.current as Measurable | null;
      if (!target?.measureInWindow) return setInset(fallback);
      target.measureInWindow((_x, y, _width, height) =>
        setInset(height > 0 ? keyboardOverlap(y + height, event.endCoordinates.screenY) : fallback),
      );
    });
    const hidden = Keyboard.addListener(KEYBOARD_EVENTS.hide, () => setInset(0));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, [view]);
  return inset;
}
