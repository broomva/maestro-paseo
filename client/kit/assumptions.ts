// What the kit assumes about the platform that the device spike BRO-3033 is
// still verifying, each behind one function so its result lands in one line.
// Every component that depends on one takes a prop that overrides it, and the
// gallery shows both looks side by side. Pure (client/kit/assumptions.test.ts).
//
//   A1 undertowLook   The Undertow's gradient halo. Desktop: gradients pass
//                     through react-native-web as backgroundImage. iOS: RN's
//                     experimental_backgroundImage is unverified in Paseo's
//                     host (BRO-3033 fact 5), so the halo is a still ring of
//                     tinted Views, JE rule 9's own reduced-motion look.
//   A2 frostLook      The inspector's action bar. backdropFilter blurs on the
//                     web only; there is no blur on iOS (capabilities §3).
//   A3 chromeInset    What Paseo's iOS app draws at the bottom of a plugin
//                     screen (BRO-3033 fact 1). The tab bar sits this far above
//                     the bottom edge; 0 until the spike measures it.
//   A4 nativeDriver   Transforms and opacity run on the native driver on iOS;
//                     on the web Animated runs on the JS thread. PanResponder
//                     is JS-thread everywhere (BRO-3033 fact 3: frame drops).
//   A5 keysHint       Key caps (J, ⌘↵) show only where there is a keyboard to
//                     press them: the web build.

export type KitPlatform = "ios" | "android" | "web" | (string & {});

export type UndertowLook = "gradient" | "ring";
export type FrostLook = "frost" | "solid";

/** A1: the Undertow halo animates its gradients on the web, and is a still ring elsewhere. */
export function undertowLook(platform: KitPlatform): UndertowLook {
  return platform === "web" ? "gradient" : "ring";
}

/** A2: the inspector's action bar is frosted on the web, solid elsewhere. */
export function frostLook(platform: KitPlatform): FrostLook {
  return platform === "web" ? "frost" : "solid";
}

/** A3: how far above the screen's bottom edge the phone's tab bar and sheet stop. */
export function chromeInset(_platform: KitPlatform): number {
  return 0;
}

/** A4: whether Animated may hand a transform to the native driver. */
export function nativeDriver(platform: KitPlatform): boolean {
  return platform !== "web";
}

/** A5: whether key caps show beside the controls they drive. */
export function keysHint(platform: KitPlatform): boolean {
  return platform === "web";
}
