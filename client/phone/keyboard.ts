// How a sheet of ours rises with the software keyboard (BRO-3033 fact 4: Paseo's host does not move a plugin's
// views for it, and `keyboardWillShow` carries the height and the duration of the animation iOS runs). The lift
// is the keyboard's height less the safe area the sheet already stands above, never negative; a sheet that
// stands at the bottom rises by it and returns on `keyboardWillHide`. The web has no such event: the lift stays 0.

import { useEffect, useRef } from "react";
import { Animated, Easing, Keyboard, Platform } from "react-native";
import { keyboardLift } from "./keyboard-lift";

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
