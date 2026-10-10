import { describe, expect, test } from "bun:test";
import { DECK, deckCaptures, deckOffset, deckRelease, place, placeLabel, segments } from "./deck-model";

const W = 340;

describe("the deck: one hold at a time, swipe sideways for the next", () => {
  test("a swipe past a quarter of the width moves one hold, either way", () => {
    expect(deckRelease(0, 4, -W * DECK.advance, 0, W)).toBe(1);
    expect(deckRelease(2, 4, W * DECK.advance, 0, W)).toBe(1);
    expect(deckRelease(0, 4, -W * DECK.advance + 1, 0, W)).toBe(0);
  });
  test("a long swipe still moves one hold, never two", () => {
    expect(deckRelease(0, 4, -W * 3, 3, W)).toBe(1);
  });
  test("a flick moves one from 32 px", () => {
    expect(deckRelease(1, 4, -DECK.flickMin, -DECK.flick, W)).toBe(2);
    expect(deckRelease(1, 4, -DECK.flickMin + 1, -DECK.flick, W)).toBe(1);
  });
  test("never past either end", () => {
    expect(deckRelease(0, 4, W, 2, W)).toBe(0);
    expect(deckRelease(3, 4, -W, -2, W)).toBe(3);
    expect(deckRelease(0, 0, -W, -2, W)).toBe(0);
  });
  test("the edges resist the drag", () => {
    expect(deckOffset(0, 4, 90, W)).toBe(30);
    expect(deckOffset(1, 4, 90, W)).toBe(-(W + DECK.gap) + 90);
    expect(deckOffset(3, 4, -90, W)).toBe(-3 * (W + DECK.gap) - 30);
  });
  test("only a sideways move past the slop starts a swipe, so a vertical scroll is left alone", () => {
    expect(deckCaptures(DECK.slop + 1, 0)).toBe(true);
    expect(deckCaptures(DECK.slop, 0)).toBe(false);
    expect(deckCaptures(20, 30)).toBe(false);
  });
  test("its verbs are 52 pt", () => {
    expect(DECK.verb).toBe(52);
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
