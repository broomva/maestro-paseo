// The cockpit's colors, proven: every color form a theme may give parses, the
// dark test reads them all, and info blue holds 4.5:1 as a pill's word on its
// own tint over light and dark surfaces (Broomva's and Paseo-like defaults).

import { describe, expect, test } from "bun:test";
import { BROOMVA_DARK, BROOMVA_LIGHT } from "../shared/theme";
import { contrast, INFO, infoFor, isDarkSurface, over, parseColor, tint } from "./fleet-color";

/** The pill's paint: its word in `ink` on `ink` at 14% over `surface` (fleet-ui.tsx Pill). */
const pillContrast = (ink: string, surface: string) => {
  const word = parseColor(ink);
  const ground = parseColor(surface);
  if (!word || !ground) throw new Error("unparsed");
  return contrast(word, over(word, ground, 0.14));
};

describe("colors", () => {
  test("every color form parses", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#0008")).toEqual({ r: 0, g: 0, b: 0, a: 136 / 255 });
    expect(parseColor("#1f2332")).toEqual({ r: 31, g: 35, b: 50, a: 1 });
    expect(parseColor("#1f233280")?.a).toBeCloseTo(128 / 255);
    expect(parseColor("rgb(6, 8, 16)")).toEqual({ r: 6, g: 8, b: 16, a: 1 });
    expect(parseColor("rgba(6, 8, 16, 0.5)")?.a).toBe(0.5);
    expect(parseColor("rgb(6 8 16 / 50%)")?.a).toBe(0.5);
    expect(parseColor("teal")).toBeNull();
    expect(tint("#1f5bc4", 0.14)).toBe("rgba(31, 91, 196, 0.14)");
    expect(tint("teal", 0.14)).toBe("teal");
  });

  test("dark or light, in any form", () => {
    for (const dark of ["#000", "#0008", "#060810", "#181818ff", "rgb(24, 24, 27)", BROOMVA_DARK.colors.background]) {
      expect(isDarkSurface(dark)).toBe(true);
    }
    for (const light of [
      "#fff",
      "#ffff",
      "#f3f4f6",
      "#ffffffff",
      "rgb(250, 250, 250)",
      BROOMVA_LIGHT.colors.background,
    ]) {
      expect(isDarkSurface(light)).toBe(false);
    }
    expect(infoFor("#ffffff")).toBe(INFO.light);
    expect(infoFor("rgb(10, 10, 10)")).toBe(INFO.dark);
  });

  test("info blue holds 4.5:1 on its own tint, light and dark", () => {
    for (const surface of ["#ffffff", "#f3f4f6", "#eeeeee", "#e1e3e6"]) {
      expect(pillContrast(INFO.light, surface)).toBeGreaterThanOrEqual(4.5);
    }
    for (const surface of ["#060810", "#0d101c", "#1f2332", "#181818", "#262626"]) {
      expect(pillContrast(INFO.dark, surface)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
