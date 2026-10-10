import { describe, expect, test } from "bun:test";
import { UNDO_MS } from "../../shared/undo";
import {
  createUndoWindow,
  isOpen,
  remainingMs,
  secondsLeft,
  toastText,
  type UndoClock,
  type UndoEntry,
  undoEntry,
} from "./undo-model";

/** A clock whose timers run only when the test moves time. */
function fakeClock(start = 1_000_000) {
  let now = start;
  let seq = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const clock: UndoClock = {
    now: () => now,
    setTimeout: (run, ms) => {
      seq += 1;
      timers.set(seq, { at: now + ms, run });
      return seq;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  const tick = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.run();
      }
    }
  };
  return { clock, tick, live: () => timers.size, at: () => now };
}

function opened() {
  const fake = fakeClock();
  const seen: (UndoEntry | null)[] = [];
  const window = createUndoWindow(fake.clock, (entry) => seen.push(entry));
  return { fake, seen, window };
}

describe("the undo toast's window is 8 s (B4)", () => {
  test("the window is the shared constant, 8 000 ms", () => {
    expect(UNDO_MS).toBe(8_000);
    const entry = undoEntry("r", "Allowed #933", 0);
    expect(entry.appliesAt).toBe(UNDO_MS);
  });

  test("it stays up for 8 s and goes at the 8 000th millisecond, not before", () => {
    const { fake, seen, window } = opened();
    window.show(undoEntry("r1", "Allowed #933", fake.at(), undefined, "merges in"));
    expect(window.current()?.receipt).toBe("r1");
    fake.tick(UNDO_MS - 1);
    expect(window.current()?.receipt).toBe("r1");
    expect(seen.at(-1)?.receipt).toBe("r1");
    fake.tick(1);
    expect(window.current()).toBeNull();
    expect(seen.at(-1)).toBeNull();
    expect(fake.live()).toBe(0);
  });

  test("Undo inside the window hands the receipt back once and hides the toast", () => {
    const { fake, seen, window } = opened();
    window.show(undoEntry("r1", "Allowed #933", fake.at()));
    fake.tick(UNDO_MS - 1);
    expect(window.undo()).toBe("r1");
    expect(seen.at(-1)).toBeNull();
    expect(window.undo()).toBeNull();
    expect(fake.live()).toBe(0);
  });

  test("Undo at or after 8 s does nothing: the verb has applied", () => {
    const { fake, window } = opened();
    window.show(undoEntry("r1", "Allowed #933", fake.at()));
    fake.tick(UNDO_MS);
    expect(window.undo()).toBeNull();
  });

  test("it counts down to the verb's own appliesAt, so it and the session card agree", () => {
    const { fake, window } = opened();
    const appliesAt = new Date(fake.at() + 5_000).toISOString();
    window.show(undoEntry("r1", "Allowed #933", fake.at(), appliesAt));
    fake.tick(4_999);
    expect(window.current()).not.toBeNull();
    fake.tick(1);
    expect(window.current()).toBeNull();
  });

  test("a second verb replaces the toast; the first applies on time and cannot be undone here", () => {
    const { fake, window } = opened();
    window.show(undoEntry("r1", "Allowed #933", fake.at()));
    fake.tick(3_000);
    window.show(undoEntry("r2", "Continued", fake.at()));
    expect(fake.live()).toBe(1);
    fake.tick(UNDO_MS - 1);
    expect(window.current()?.receipt).toBe("r2");
    expect(window.undo()).toBe("r2");
  });

  test("an entry already past its appliesAt never shows", () => {
    const { fake, window } = opened();
    window.show(undoEntry("r1", "Allowed", fake.at(), fake.at() - 1));
    expect(window.current()).toBeNull();
    expect(fake.live()).toBe(0);
  });

  test("the words count whole seconds down from 8 to 1", () => {
    const entry = undoEntry("r1", "Allowed #933", 0, undefined, "merges in");
    expect(toastText(entry, 0)).toBe("Allowed #933 · merges in 8 s");
    expect(toastText(entry, 1)).toBe("Allowed #933 · merges in 8 s");
    expect(toastText(entry, 1_000)).toBe("Allowed #933 · merges in 7 s");
    expect(toastText(entry, 7_999)).toBe("Allowed #933 · merges in 1 s");
    expect(secondsLeft(entry, 9_000)).toBe(0);
    expect(remainingMs(entry, 9_000)).toBe(0);
    expect(isOpen(entry, 7_999)).toBe(true);
    expect(isOpen(entry, 8_000)).toBe(false);
    expect(toastText(undoEntry("r2", "Continued · A1 adopted", 0), 0)).toBe("Continued · A1 adopted");
  });
});
