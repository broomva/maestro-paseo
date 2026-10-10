// The phone's pull-up sheet (M1): it peeks from the bottom edge, and the tab bar
// rides on its top edge. ONE Animated value, `progress` (0 down, 1 up), drives
// the sheet, the tab bar and the undo toast: the sheet and the tab bar are one
// Animated.View moved by one translateY, and the toast's lift is another
// interpolation of the same value. Every output is a transform or an opacity,
// so the value can run on iOS's native driver (a layout prop such as `bottom`
// cannot). Pure: the value is anything that
// interpolates, so the arithmetic is tested without a renderer
// (client/kit/sheet.test.ts).

export interface SheetGeometry {
  /** The screen's height. */
  height: number;
  /** Where the tab bar's top stops when the sheet is up. */
  top: number;
  /** The tab bar's band above the sheet: the bar plus its margins. */
  tabBar: number;
  /** How much of the sheet shows when it is down: grabber, title and counts. */
  peek: number;
  /** Space Paseo's own chrome keeps at the bottom: none on 0.11.1 (client/kit/assumptions.ts F3). */
  inset: number;
  /** The home indicator: the sheet runs under it, and its peek and the toast sit above it. */
  safe: number;
}

/** Gap between the toast and what it sits on. */
export const TOAST_GAP = 10;

/** The rider's translateY at each end, and the distance between them. */
export function sheetRange(g: SheetGeometry): { down: number; up: number; travel: number } {
  const down = g.height - g.inset - g.safe - g.peek - g.tabBar;
  const up = Math.min(g.top, down);
  return { down, up, travel: Math.max(1, down - up) };
}

/** The rider's height: the tab bar's band plus the sheet, from `top` to the inset. */
export function riderHeight(g: SheetGeometry): number {
  return Math.max(g.tabBar + g.peek + g.safe, g.height - g.inset - Math.min(g.top, sheetRange(g).down));
}

/** The toast's distance from the bottom edge, down and up. */
export function toastBottoms(g: SheetGeometry): { down: number; up: number } {
  return { down: g.inset + g.safe + g.peek + g.tabBar + TOAST_GAP, up: g.inset + g.safe + TOAST_GAP };
}

interface Interpolation {
  inputRange: number[];
  outputRange: number[];
  extrapolate: "clamp";
}

/** Anything with Animated's interpolate: an Animated.Value in the app, a recorder in a test. */
export interface Interpolating<T> {
  interpolate(config: Interpolation): T;
}

/**
 * What the one value drives. `rider` is the translateY that moves the sheet
 * and the tab bar together (the tab bar is the rider's first child, so it can
 * never part from the sheet's top edge). The toast sits `toastBottoms(g).up`
 * from the bottom edge and `toastLift` is its translateY: lifted above the tab
 * bar when the sheet is down, none when it is up. `scrim` dims the deck under
 * a raised sheet.
 */
export function sheetDrive<T>(progress: Interpolating<T>, g: SheetGeometry): { rider: T; toastLift: T; scrim: T } {
  const { down, up } = sheetRange(g);
  const toast = toastBottoms(g);
  const range = [0, 1];
  return {
    rider: progress.interpolate({ inputRange: range, outputRange: [down, up], extrapolate: "clamp" }),
    toastLift: progress.interpolate({
      inputRange: range,
      outputRange: [toast.up - toast.down, 0],
      extrapolate: "clamp",
    }),
    scrim: progress.interpolate({ inputRange: range, outputRange: [0, 1], extrapolate: "clamp" }),
  };
}

export const SHEET = {
  /** A release this fast (px/ms) goes the way it was thrown, wherever it is. */
  flick: 0.45,
  /** How far ahead a slower release is projected, in ms of its velocity. */
  project: 180,
  /** A move this far (px), mostly vertical, starts a drag. */
  slop: 6,
} as const;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Whether a move starts the sheet's drag: vertical, past the slop. */
export function sheetCaptures(dx: number, dy: number): boolean {
  return Math.abs(dy) > SHEET.slop && Math.abs(dy) > Math.abs(dx);
}

/** Progress during a drag that began at `from` (0 or 1) and has moved `dy` px (down is positive). */
export function dragProgress(from: number, dy: number, travel: number): number {
  return clamp01(from - dy / travel);
}

/** Where a release lands, 0 or 1: a flick goes its way; otherwise the projected position's nearer end. */
export function sheetRelease(from: number, dy: number, vy: number, travel: number): 0 | 1 {
  if (Math.abs(vy) >= SHEET.flick) return vy < 0 ? 1 : 0;
  const projected = dragProgress(from, dy, travel) - (vy * SHEET.project) / travel;
  return projected >= 0.5 ? 1 : 0;
}

/** The release velocity as Animated.spring takes it: progress per second (PanResponder gives px per ms). */
export function releaseVelocity(vy: number, travel: number): number {
  return (-vy * 1000) / travel;
}
