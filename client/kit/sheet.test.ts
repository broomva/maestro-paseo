import { describe, expect, test } from "bun:test";
import {
  dragProgress,
  type Interpolating,
  releaseVelocity,
  riderHeight,
  SHEET,
  type SheetGeometry,
  sheetCaptures,
  sheetDrive,
  sheetRange,
  sheetRelease,
  TOAST_GAP,
  toastBottoms,
} from "./sheet-model";

const G: SheetGeometry = { height: 760, top: 64, tabBar: 72, peek: 104, inset: 0, safe: 0 };

/** A stand-in for one Animated.Value: every interpolation reads the same `at`, as Animated's do. */
function oneValue(start: number) {
  const value = {
    at: start,
    made: 0,
    interpolate(config: { inputRange: number[]; outputRange: number[] }) {
      value.made += 1;
      const [i0, i1] = config.inputRange as [number, number];
      const [o0, o1] = config.outputRange as [number, number];
      return { source: value, read: () => o0 + ((Math.min(Math.max(value.at, i0), i1) - i0) / (i1 - i0)) * (o1 - o0) };
    },
  };
  return value;
}
type Read = { source: unknown; read: () => number };

describe("the pull-up sheet: one Animated value drives the sheet, the tab bar and the toast", () => {
  test("every output is an interpolation of the one value it was given", () => {
    const value = oneValue(0);
    const drive = sheetDrive(value as Interpolating<Read>, G);
    expect(value.made).toBe(3);
    for (const out of [drive.rider, drive.toastLift, drive.scrim]) expect(out.source).toBe(value);
  });

  test("down: the tab bar's band sits on the peek, its top edge on the sheet's; the toast sits above the tab bar", () => {
    const value = oneValue(0);
    const drive = sheetDrive(value as Interpolating<Read>, G);
    const { down } = sheetRange(G);
    // The rider's top is the tab bar's top; the sheet starts one band below it and shows `peek`.
    expect(drive.rider.read()).toBe(down);
    expect(down + G.tabBar + G.peek).toBe(G.height - G.inset);
    // The toast's resting place is the bottom edge; lifted, it clears the peek and the tab bar.
    expect(toastBottoms(G).up - drive.toastLift.read()).toBe(G.inset + G.peek + G.tabBar + TOAST_GAP);
    expect(drive.scrim.read()).toBe(0);
  });

  test("up: the tab bar rides to `top` with the sheet, and the toast drops to the bottom edge", () => {
    const value = oneValue(1);
    const drive = sheetDrive(value as Interpolating<Read>, G);
    expect(drive.rider.read()).toBe(G.top);
    expect(drive.toastLift.read()).toBe(0);
    expect(toastBottoms(G).up).toBe(G.inset + TOAST_GAP);
    expect(drive.scrim.read()).toBe(1);
  });

  test("mid-drag the tab bar and the toast move together, by the same value", () => {
    const value = oneValue(0);
    const drive = sheetDrive(value as Interpolating<Read>, G);
    const { travel } = sheetRange(G);
    value.at = 0.25;
    const riderMoved = sheetRange(G).down - drive.rider.read();
    expect(riderMoved).toBeCloseTo(travel * 0.25, 6);
    value.at = 0.75;
    expect(sheetRange(G).down - drive.rider.read()).toBeCloseTo(travel * 0.75, 6);
    expect(drive.scrim.read()).toBeCloseTo(0.75, 6);
  });

  test("the rider reaches from `top` to the bottom edge, so the raised sheet leaves no gap", () => {
    expect(G.top + riderHeight(G)).toBe(G.height - G.inset);
    const inset: SheetGeometry = { ...G, inset: 34 };
    expect(sheetRange(inset).down + inset.tabBar + inset.peek).toBe(inset.height - 34);
    expect(inset.top + riderHeight(inset)).toBe(inset.height - 34);
  });

  test("the sheet runs under the home indicator; its peek and the toast sit above it (BRO-3033 fact 1)", () => {
    const phone: SheetGeometry = { ...G, height: 748, safe: 34 };
    // The sheet still reaches the physical edge, so nothing shows under it.
    expect(phone.top + riderHeight(phone)).toBe(phone.height);
    // Down, the peek's content ends where the home indicator begins.
    expect(sheetRange(phone).down + phone.tabBar + phone.peek).toBe(phone.height - 34);
    expect(toastBottoms(phone)).toEqual({ down: 34 + 104 + 72 + TOAST_GAP, up: 34 + TOAST_GAP });
  });
});

describe("the sheet's release", () => {
  const { travel } = sheetRange(G);
  test("a flick goes the way it was thrown, wherever it is", () => {
    expect(sheetRelease(0, -10, -SHEET.flick, travel)).toBe(1);
    expect(sheetRelease(1, 10, SHEET.flick, travel)).toBe(0);
    expect(sheetRelease(1, -5, -SHEET.flick - 1, travel)).toBe(1);
  });
  test("a slow release lands on the nearer end of where it was heading", () => {
    expect(sheetRelease(0, -travel * 0.6, 0, travel)).toBe(1);
    expect(sheetRelease(0, -travel * 0.4, 0, travel)).toBe(0);
    expect(sheetRelease(1, travel * 0.4, 0, travel)).toBe(1);
    expect(sheetRelease(1, travel * 0.6, 0, travel)).toBe(0);
    // Under the flick speed, the velocity still projects: 0.4 of the way plus a push carries it up.
    expect(sheetRelease(0, -travel * 0.4, -0.4, travel)).toBe(1);
  });
  test("a drag is clamped to the two ends", () => {
    expect(dragProgress(0, 50, travel)).toBe(0);
    expect(dragProgress(1, -50, travel)).toBe(1);
    expect(dragProgress(0, -travel / 2, travel)).toBeCloseTo(0.5, 6);
  });
  test("a drag starts only on a vertical move past the slop", () => {
    expect(sheetCaptures(0, SHEET.slop)).toBe(false);
    expect(sheetCaptures(0, SHEET.slop + 1)).toBe(true);
    expect(sheetCaptures(20, 12)).toBe(false);
  });
  test("the release velocity is handed to the spring in progress per second, up positive", () => {
    expect(releaseVelocity(-1, 500)).toBe(2);
    expect(releaseVelocity(0.5, 500)).toBe(-1);
  });
});
