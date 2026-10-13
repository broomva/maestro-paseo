import { describe, expect, test } from "bun:test";
import { keyboardLift } from "./keyboard-lift";

describe("the keyboard's lift", () => {
  test("is its height less the safe area the sheet already stands above, never negative", () => {
    expect(keyboardLift(336, 34)).toBe(302);
    expect(keyboardLift(20, 34)).toBe(0);
    expect(keyboardLift(336, -5)).toBe(336);
  });
});
