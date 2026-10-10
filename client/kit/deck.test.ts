import { describe, expect, test } from "bun:test";
import { BOTH_WAYS, LEFTWARD } from "./assumptions";
import { DECK, deckCaptures, deckOffset, deckRelease, indexOfKey, place, placeLabel, segments } from "./deck-model";

const W = 340;

describe("the deck: one hold at a time, swipe sideways for the next", () => {
  test("a swipe past a quarter of the width moves one hold, either way", () => {
    // A quarter of a 340 pt card is 85 pt.
    expect(deckRelease(0, 4, -85, 0, W, BOTH_WAYS)).toBe(1);
    expect(deckRelease(0, 4, -84, 0, W, BOTH_WAYS)).toBe(0);
    expect(deckRelease(2, 4, 85, 0, W, BOTH_WAYS)).toBe(1);
    expect(deckRelease(2, 4, 84, 0, W, BOTH_WAYS)).toBe(2);
  });
  test("a long swipe still moves one hold, never two", () => {
    expect(deckRelease(0, 4, -W * 3, 3, W, BOTH_WAYS)).toBe(1);
  });
  test("a flick moves one from 32 px", () => {
    expect(deckRelease(1, 4, -DECK.flickMin, -DECK.flick, W, BOTH_WAYS)).toBe(2);
    expect(deckRelease(1, 4, -DECK.flickMin + 1, -DECK.flick, W, BOTH_WAYS)).toBe(1);
  });
  test("never past either end", () => {
    expect(deckRelease(0, 4, W, 2, W, BOTH_WAYS)).toBe(0);
    expect(deckRelease(3, 4, -W, -2, W, BOTH_WAYS)).toBe(3);
    expect(deckRelease(0, 0, -W, -2, W, BOTH_WAYS)).toBe(0);
  });
  test("the edges resist the drag", () => {
    expect(deckOffset(0, 4, 90, W, BOTH_WAYS)).toBe(30);
    expect(deckOffset(1, 4, 90, W, BOTH_WAYS)).toBe(-(W + DECK.gap) + 90);
    expect(deckOffset(3, 4, -90, W, BOTH_WAYS)).toBe(-3 * (W + DECK.gap) - 30);
  });
  test("only a sideways move past the slop starts a swipe, so a vertical scroll is left alone", () => {
    expect(deckCaptures(DECK.slop + 1, 0, BOTH_WAYS)).toBe(true);
    expect(deckCaptures(DECK.slop, 0, BOTH_WAYS)).toBe(false);
    expect(deckCaptures(20, 30, BOTH_WAYS)).toBe(false);
  });
  test("its verbs are 52 pt", () => {
    expect(DECK.verb).toBe(52);
  });
});

describe("on compact native the deck swipes leftward only (BRO-3033 fact 3)", () => {
  test("a rightward move is never taken, so Paseo's sidebar gesture keeps it", () => {
    expect(deckCaptures(40, 0, LEFTWARD)).toBe(false);
    expect(deckCaptures(-40, 0, LEFTWARD)).toBe(true);
  });
  test("a rightward release never pages back, and a rightward drag does not move the strip", () => {
    expect(deckRelease(2, 4, W, 2, W, LEFTWARD)).toBe(2);
    expect(deckOffset(2, 4, 90, W, LEFTWARD)).toBe(-2 * (W + DECK.gap));
    expect(deckRelease(2, 4, -W, -2, W, LEFTWARD)).toBe(3);
  });
});

describe("opening on a hold (BRO-3033 fact 2: params.hold)", () => {
  test("the hold's place by key, else the first", () => {
    const keys = ["approval:933", "ask:7f3e", "notice:3593"];
    expect(indexOfKey(keys, "ask:7f3e")).toBe(1);
    expect(indexOfKey(keys, "gone")).toBe(0);
    expect(indexOfKey(keys, undefined)).toBe(0);
  });
});

describe("the detail header's place", () => {
  test("'Kind · n of N', counted from one", () => {
    expect(placeLabel("Approval", 0, 4)).toBe("Approval · 1 of 4");
    expect(placeLabel("Ask", 2, 4)).toBe("Ask · 3 of 4");
    expect(place(9, 4)).toBe("4 of 4");
  });
  test("one segment per hold: done before you, current, then waiting", () => {
    expect(segments(2, 4)).toEqual(["done", "done", "current", "todo"]);
    expect(segments(0, 1)).toEqual(["current"]);
  });
});
