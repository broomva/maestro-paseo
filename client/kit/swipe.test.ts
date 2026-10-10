import { describe, expect, test } from "bun:test";
import { BOTH_WAYS, LEFTWARD } from "./assumptions";
import {
  actionsWidth,
  canSwipe,
  HOLD_KINDS,
  isHold,
  leftActions,
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
  test("the contract's owner_step is a hold, as are the inventory's owner-step and an initiative review", () => {
    expect(canSwipe("owner_step")).toBe(false);
    expect(canSwipe("owner-step")).toBe(false);
    expect(canSwipe("review")).toBe(false);
  });
  test("a hold never takes the gesture, however far and fast it moves, either way", () => {
    for (const kind of HOLD_KINDS)
      for (const ways of [BOTH_WAYS, LEFTWARD]) {
        expect(swipeCaptures(kind, 300, 0, ways)).toBe(false);
        expect(swipeCaptures(kind, -300, 0, ways)).toBe(false);
      }
    expect(swipeCaptures("finished", 300, 0, BOTH_WAYS)).toBe(true);
  });
});

describe("the swipe row's thresholds (desktop: both ways)", () => {
  test("a swipe starts only sideways, past the slop", () => {
    expect(swipeCaptures("work", SWIPE.slop, 0, BOTH_WAYS)).toBe(false);
    expect(swipeCaptures("work", SWIPE.slop + 1, 0, BOTH_WAYS)).toBe(true);
    expect(swipeCaptures("work", 20, 15, BOTH_WAYS)).toBe(false);
  });
  test("right: past 40% of the width commits the default verb, short of it springs back", () => {
    // 40% of a 361 pt row is 144.4 pt.
    expect(swipeRelease(145, 0, W, false, 2, BOTH_WAYS)).toBe("commit");
    expect(swipeRelease(144, 0, W, false, 2, BOTH_WAYS)).toBe("rest");
  });
  test("right: a fling commits from 48 px, not before", () => {
    expect(swipeRelease(SWIPE.flickMin, SWIPE.flick, W, false, 2, BOTH_WAYS)).toBe("commit");
    expect(swipeRelease(SWIPE.flickMin - 1, SWIPE.flick, W, false, 2, BOTH_WAYS)).toBe("rest");
    expect(swipeRelease(SWIPE.flickMin, SWIPE.flick - 0.01, W, false, 2, BOTH_WAYS)).toBe("rest");
  });
  test("left: past 56 px opens Snooze and Open; short of it springs back", () => {
    expect(swipeRelease(-56, 0, W, false, 2, BOTH_WAYS)).toBe("reveal");
    expect(swipeRelease(-55, 0, W, false, 2, BOTH_WAYS)).toBe("rest");
    expect(swipeRelease(-200, 0, W, false, 0, BOTH_WAYS)).toBe("rest");
  });
  test("open: dragging right closes the actions and never commits", () => {
    expect(swipeRelease(actionsWidth(2), 0, W, true, 2, BOTH_WAYS)).toBe("rest");
    expect(swipeRelease(W, 2, W, true, 2, BOTH_WAYS)).toBe("rest");
    expect(swipeRelease(-10, 0, W, true, 2, BOTH_WAYS)).toBe("reveal");
  });
  test("the left drag stops at its actions and then stretches a third", () => {
    expect(swipeOffset(-100, false, 2, BOTH_WAYS)).toBe(-100);
    expect(swipeOffset(-actionsWidth(2) - 30, false, 2, BOTH_WAYS)).toBe(-actionsWidth(2) - 10);
    expect(swipeOffset(40, true, 2, BOTH_WAYS)).toBe(-actionsWidth(2) + 40);
  });
});

describe("on compact native the row swipes leftward only (BRO-3033 fact 3)", () => {
  test("a rightward move is never taken, so Paseo's sidebar gesture keeps it (a tap closes open actions)", () => {
    expect(swipeCaptures("finished", 40, 0, LEFTWARD)).toBe(false);
    expect(swipeCaptures("finished", -40, 0, LEFTWARD)).toBe(true);
  });
  test("a rightward release never commits, and a rightward drag never moves the row past rest", () => {
    expect(swipeRelease(W, 3, W, false, 3, LEFTWARD)).toBe("rest");
    expect(swipeOffset(90, false, 3, LEFTWARD)).toBe(0);
    expect(swipeOffset(40, true, 3, LEFTWARD)).toBe(-actionsWidth(3) + 40);
  });
  test("the default verb becomes the first left action; the desktop keeps it on the right swipe", () => {
    expect(leftActions(LEFTWARD, "continue", "snooze", "open")).toEqual(["continue", "snooze", "open"]);
    expect(leftActions(BOTH_WAYS, "continue", "snooze", "open")).toEqual(["snooze", "open"]);
    expect(leftActions(LEFTWARD, undefined, undefined, "open")).toEqual(["open"]);
  });
});
