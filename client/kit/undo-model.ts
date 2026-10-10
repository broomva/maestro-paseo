// The undo toast's window (B4: 8 s everywhere). Every owner verb answers
// `{ receipt, appliesAt }` with appliesAt UNDO_MS after the call
// (view-models.md, Verbs and undo); the toast counts down to appliesAt, so it
// and the session card count down together. Undo inside the window hands the
// receipt back for work.undo; at appliesAt the toast goes and Undo does
// nothing. The clock and timers are injected, so the window is tested to the
// millisecond (client/kit/undo.test.ts). No classes: the client bundle must
// parse under Hermes (client/hermes.test.ts).

import { UNDO_MS } from "../../shared/undo";

export interface UndoEntry {
  receipt: string;
  /** What was done, in the past tense: "Allowed #933". */
  done: string;
  /** What happens when the window closes, before the countdown: "merges in". Optional. */
  then?: string;
  /** Epoch ms when the verb applies. */
  appliesAt: number;
}

/** An entry from a verb's answer; with no appliesAt it applies UNDO_MS from now. */
export function undoEntry(
  receipt: string,
  done: string,
  now: number,
  appliesAt?: string | number,
  then?: string,
): UndoEntry {
  const at = typeof appliesAt === "string" ? Date.parse(appliesAt) : appliesAt;
  return { receipt, done, then, appliesAt: Number.isFinite(at) ? (at as number) : now + UNDO_MS };
}

export function remainingMs(entry: UndoEntry, now: number): number {
  return Math.max(0, entry.appliesAt - now);
}

/** Whole seconds left, rounded up: "8 s" for the first second, "1 s" for the last. */
export function secondsLeft(entry: UndoEntry, now: number): number {
  return Math.ceil(remainingMs(entry, now) / 1000);
}

export function isOpen(entry: UndoEntry, now: number): boolean {
  return now < entry.appliesAt;
}

/** The toast's words: "Allowed #933 · merges in 8 s", or "Continued · A1 adopted" with no `then`. */
export function toastText(entry: UndoEntry, now: number): string {
  return entry.then ? `${entry.done} · ${entry.then} ${secondsLeft(entry, now)} s` : entry.done;
}

export interface UndoClock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface UndoWindow {
  /** Show an entry; it replaces any entry showing (that one's verb simply applies). */
  show(entry: UndoEntry): void;
  /** Take the showing entry back: its receipt if the window is still open, else null. */
  undo(): string | null;
  /** Hide the toast without undoing (the verb applies on time). */
  dismiss(): void;
  current(): UndoEntry | null;
  dispose(): void;
}

/**
 * One toast's window. `onChange` fires with the entry shown or null; the
 * toast hides by itself at appliesAt.
 */
export function createUndoWindow(clock: UndoClock, onChange: (entry: UndoEntry | null) => void): UndoWindow {
  let entry: UndoEntry | null = null;
  let timer: unknown = null;
  const stop = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };
  const set = (next: UndoEntry | null) => {
    stop();
    entry = next;
    if (next) {
      timer = clock.setTimeout(
        () => {
          timer = null;
          if (entry === next) set(null);
        },
        remainingMs(next, clock.now()),
      );
    }
    onChange(entry);
  };
  return {
    show: (next) => set(isOpen(next, clock.now()) ? next : null),
    undo() {
      if (!entry || !isOpen(entry, clock.now())) return null;
      const receipt = entry.receipt;
      set(null);
      return receipt;
    },
    dismiss: () => set(null),
    current: () => (entry && isOpen(entry, clock.now()) ? entry : null),
    dispose: () => {
      stop();
      entry = null;
    },
  };
}
