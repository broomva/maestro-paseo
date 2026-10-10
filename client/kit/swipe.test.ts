import { describe, expect, test } from "bun:test";
import {
  actionsWidth,
  canSwipe,
  HOLD_KINDS,
  isHold,
  SWIPE,
  swipeCaptures,
  swipeOffset,
  swipeRelease,
} from "./swipe-model";

const W = 361;

describe("the swipe row never swipes a hold", () => {
  test("asks, approvals and owner steps are holds; the rest swipe", () => {
    for (const kind of HOLD_KINDS) {
      expect(isHold(kind)).toBe(true);
      expect(canSwipe(kind)).toBe(false);
    }
    for (const kind of ["work", "notice", "finished", "running"]) expect(canSwipe(kind)).toBe(true);
  });
  test("a hold never takes the gesture, however far and fast it moves", () => {
    for (const kind of HOLD_KINDS) {
      expect(swipeCaptures(kind, 300, 0)).toBe(false);
      expect(swipeCaptures(kind, -300, 0)).toBe(false);
    }
    expect(swipeCaptures("finished", 300, 0)).toBe(true);
  });
});

describe("the swipe row's thresholds", () => {
  test("a swipe starts only sideways, past the slop", () => {
    expect(swipeCaptures("work", SWIPE.slop, 0)).toBe(false);
    expect(swipeCaptures("work", SWIPE.slop + 1, 0)).toBe(true);
    expect(swipeCaptures("work", 20, 15)).toBe(false);
  });
  test("right: past 40% of the width commits the default verb, short of it springs back", () => {
    expect(swipeRelease(W * SWIPE.commit, 0, W, false, 2)).toBe("commit");
    expect(swipeRelease(W * SWIPE.commit - 1, 0, W, false, 2)).toBe("rest");
  });
  test("right: a fling commits from 48 px, not before", () => {
    expect(swipeRelease(SWIPE.flickMin, SWIPE.flick, W, false, 2)).toBe("commit");
    expect(swipeRelease(SWIPE.flickMin - 1, SWIPE.flick, W, false, 2)).toBe("rest");
    expect(swipeRelease(SWIPE.flickMin, SWIPE.flick - 0.01, W, false, 2)).toBe("rest");
  });
  test("left: past 56 px opens Snooze and Open; short of it springs back", () => {
    expect(swipeRelease(-SWIPE.reveal, 0, W, false, 2)).toBe("reveal");
    expect(swipeRelease(-SWIPE.reveal + 1, 0, W, false, 2)).toBe("rest");
    expect(swipeRelease(-200, 0, W, false, 0)).toBe("rest");
  });
  test("open: dragging right closes the actions and never commits", () => {
    expect(swipeRelease(actionsWidth(2), 0, W, true, 2)).toBe("rest");
    expect(swipeRelease(W, 2, W, true, 2)).toBe("rest");
    expect(swipeRelease(-10, 0, W, true, 2)).toBe("reveal");
  });
  test("the left drag stops at its actions and then stretches a third", () => {
    expect(swipeOffset(-100, false, 2)).toBe(-100);
    expect(swipeOffset(-actionsWidth(2) - 30, false, 2)).toBe(-actionsWidth(2) - 10);
    expect(swipeOffset(40, true, 2)).toBe(-actionsWidth(2) + 40);
  });
});
