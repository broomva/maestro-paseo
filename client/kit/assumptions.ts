// The platform facts the kit is built on, each behind one function so a
// platform change lands in one line. The device spike BRO-3033
// (docs/design/next/device-checks.md) checked them on Paseo 0.11.1; what it
// could not check stays marked as an assumption. Every component that depends
// on one takes a prop that overrides it, and the gallery shows each look. Pure
// (client/kit/kit-model.test.ts).
//
//   F1 undertowLook    The Undertow's gradient. Desktop renders
//                      `backgroundImage`; iOS renders
//                      `experimental_backgroundImage` (fact 5), so every
//                      gradient sets both keys (gradientStyle). Android was not
//                      checked: it keeps the still ring of tinted Views.
//   A1 undertowMotion  Animating a gradient was not tested on iOS (fact 5), so
//                      the halo moves on the web only and holds still on iOS.
//   F2 frostLook       backdropFilter blurs on the web only; no blur on iOS.
//   F3 chromeInset     Paseo draws a header only: nothing at the bottom, and no
//                      insets (fact 1). The sheet clears the home indicator
//                      itself, measured with RN SafeAreaView (parts.tsx).
//   F4 swipeDirections On compact native, Paseo's sidebar gesture takes every
//                      rightward drag past ~15 px and terminates the plugin's
//                      PanResponder (fact 3). Leftward and vertical drags are
//                      the plugin's. Rightward stays on the desktop.
//   A2 nativeDriver    Transforms and opacity run on the native driver off the
//                      web. Every Animated output the kit drives is one.
//   A3 DRAG_NATIVE_DRIVER  Values a finger drags spring on the JS thread, so a
//                      grab mid-spring reads where they are (fact 3 measured it).
//   F5 keysHint        Key caps (J, ⌘↵) only where there is a keyboard: the web.

export type KitPlatform = "ios" | "android" | "web" | (string & {});

export type UndertowLook = "gradient" | "ring";
export type FrostLook = "frost" | "solid";

/** F1: the Undertow's gradients where they render (web, iOS); a still tinted ring elsewhere. */
export function undertowLook(platform: KitPlatform): UndertowLook {
  return platform === "web" || platform === "ios" ? "gradient" : "ring";
}

/** A1: whether the Undertow's gradients move. Only the web is known to animate them. */
export function undertowMotion(platform: KitPlatform): boolean {
  return platform === "web";
}

/** A gradient under both keys: `backgroundImage` for react-native-web, `experimental_backgroundImage` for iOS (F1). */
export function gradientStyle(gradient: string): { backgroundImage: string; experimental_backgroundImage: string } {
  return { backgroundImage: gradient, experimental_backgroundImage: gradient };
}

/** F2: the inspector's action bar is frosted on the web, solid elsewhere. */
export function frostLook(platform: KitPlatform): FrostLook {
  return platform === "web" ? "frost" : "solid";
}

/** F3: what Paseo draws at the bottom of a plugin screen: nothing (BRO-3033 fact 1). */
export function chromeInset(_platform: KitPlatform): number {
  return 0;
}

/** Which ways a horizontal swipe may go. */
export interface Directions {
  left: boolean;
  right: boolean;
}

export const BOTH_WAYS: Directions = { left: true, right: true };
export const LEFTWARD: Directions = { left: true, right: false };

/** F4: rightward swipes are Paseo's on compact native (its sidebar gesture), the plugin's everywhere else. */
export function swipeDirections(layout: { compact: boolean; platform: KitPlatform }): Directions {
  const native = layout.platform === "ios" || layout.platform === "android";
  return layout.compact && native ? LEFTWARD : BOTH_WAYS;
}

/**
 * A3: a value a finger drags (the sheet, the deck, a row, the phone card) springs on the JS thread. A grab
 * mid-spring must start from where the value is, and stopAnimation reads a JS-driven value at once, where a
 * native-driven one reports back later. BRO-3033 measured JS-driven springs at 0 frames over 20 ms (fact 3,
 * simulator; the real iPhone is an owner check).
 */
export const DRAG_NATIVE_DRIVER = false;

/** A2: whether Animated may hand a transform to the native driver (values no finger drags). */
export function nativeDriver(platform: KitPlatform): boolean {
  return platform !== "web";
}

/** F5: whether key caps show beside the controls they drive. */
export function keysHint(platform: KitPlatform): boolean {
  return platform === "web";
}
