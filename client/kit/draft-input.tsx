// A text field whose words belong to you while you type (BRO-3180, the caret jump; the rule is client/kit/draft-echo.ts).
//
// The native view owns the text: the field starts from its owner's value and tells the owner every change, but never
// writes a value back that it sent itself. A value the owner changed on its own (cleared, another ask's words, an
// answer undone) replaces the text, by remounting the view on it: at once while you are in the field, or for the first
// change of a burst when you are not; the rest of a burst waits until the owner has been quiet for TWIN_SETTLE_MS. A
// twin field bound to the same words (the deck card under the ask card) then rebuilds twice while you type in the
// other, not on every keystroke (P20 round 1).

import { TextInput } from "@getpaseo/plugin/client/react-native";
import { type ElementRef, forwardRef, useCallback, useEffect, useRef, useState } from "react";
import type { NativeSyntheticEvent, TargetedEvent, TextInputProps } from "react-native";
import { draftEcho, received, typed } from "./draft-echo";

/** How long an unfocused field waits for its owner to go quiet before it takes the owner's words. */
export const TWIN_SETTLE_MS = 250;

export type DraftInputProps = Omit<TextInputProps, "value" | "defaultValue" | "onChangeText"> & {
  value: string;
  onChangeText?: (text: string) => void;
};

type Input = ElementRef<typeof TextInput>;

export const DraftInput = forwardRef<Input, DraftInputProps>(function DraftInput(
  { value, onChangeText, onFocus, onBlur, ...rest },
  ref,
) {
  const echo = useRef(draftEcho(value));
  const focused = useRef(false);
  const own = useRef<Input | null>(null);
  const refocus = useRef(false);
  // The owner's words are taken but the view still shows the old ones: it remounts on them.
  const pending = useRef(false);
  const [generation, setGeneration] = useState(0);
  const remountedAt = useRef(Number.NEGATIVE_INFINITY);
  const remount = useCallback((keepFocus: boolean) => {
    pending.current = false;
    refocus.current = keepFocus;
    remountedAt.current = Date.now();
    setGeneration((now) => now + 1);
  }, []);
  // Settled after commit, never in render: a render React throws away changes nothing.
  useEffect(() => {
    const next = received(echo.current, value);
    echo.current = next.echo;
    if (next.take) pending.current = true;
    if (!pending.current) return;
    if (focused.current) return remount(true);
    // The first change of a burst goes in at once (the next ask's words, never the last one's); the rest of the
    // burst once the owner is quiet.
    if (Date.now() - remountedAt.current >= TWIN_SETTLE_MS) return remount(false);
    const timer = setTimeout(() => remount(false), TWIN_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [value, remount]);
  // A field remounted under your finger keeps the focus it had.
  // biome-ignore lint/correctness/useExhaustiveDependencies: generation is the trigger
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    (own.current as { focus?: () => void } | null)?.focus?.();
  }, [generation]);
  const setRef = useCallback(
    (input: Input | null) => {
      own.current = input;
      if (typeof ref === "function") ref(input);
      else if (ref) ref.current = input;
    },
    [ref],
  );
  return (
    <TextInput
      key={generation}
      {...rest}
      ref={setRef}
      defaultValue={echo.current.shown}
      onFocus={(event: NativeSyntheticEvent<TargetedEvent>) => {
        focused.current = true;
        // Words taken while you were away are put in before you type over the old ones.
        if (pending.current) remount(true);
        onFocus?.(event);
      }}
      onBlur={(event: NativeSyntheticEvent<TargetedEvent>) => {
        focused.current = false;
        onBlur?.(event);
      }}
      onChangeText={(text: string) => {
        echo.current = typed(echo.current, text);
        onChangeText?.(text);
      }}
    />
  );
});
