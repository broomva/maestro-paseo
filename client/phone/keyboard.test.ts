import { describe, expect, test } from "bun:test";
import { keyboardLift } from "./keyboard-lift";

describe("the keyboard's lift", () => {
  test("is its height less the safe area the sheet already stands above, never negative", () => {
    expect(keyboardLift(336, 34)).toBe(302);
    expect(keyboardLift(20, 34)).toBe(0);
    expect(keyboardLift(336, -5)).toBe(336);
  });
});

describe("the keyboard over the ask card (BRO-3180)", () => {
  const { keyboardOverlap, viewportInset, revealScroll } =
    require("./keyboard-lift") as typeof import("./keyboard-lift");
  test("covers a view by its bottom edge less the keyboard's top, never negative", () => {
    expect(keyboardOverlap(874, 538)).toBe(336);
    expect(keyboardOverlap(500, 538)).toBe(0);
  });
  test("on the web, is what the visual viewport leaves out at the bottom", () => {
    expect(viewportInset(874, 538, 0)).toBe(336);
    // Scrolled so the visual viewport sits lower: less is covered.
    expect(viewportInset(874, 538, 100)).toBe(236);
    // Rounding, not a keyboard.
    expect(viewportInset(874, 873.4, 0)).toBe(0);
  });
  test("scrolls a field into full view only when it is not", () => {
    // A field at 600–660 in a 380 px window scrolled to 0: scrolled until its bottom and margin show.
    expect(revealScroll({ top: 600, height: 60 }, 380, 0)).toBe(296);
    // Already in view: left where it is.
    expect(revealScroll({ top: 600, height: 60 }, 380, 300)).toBeNull();
    // Above the window: scrolled up to it.
    expect(revealScroll({ top: 100, height: 60 }, 380, 300)).toBe(84);
    // A field taller than the window shows its bottom, where the caret is.
    expect(revealScroll({ top: 100, height: 500 }, 380, 0)).toBe(236);
    expect(revealScroll({ top: 100, height: 60 }, 0, 0)).toBeNull();
  });
});
