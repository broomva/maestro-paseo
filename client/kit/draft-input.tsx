// A text field whose words belong to you while you type (BRO-3180, the caret jump; the rule is client/kit/draft-echo.ts).
//
// The native view owns the text: the field starts from its owner's value and tells the owner every change, but never
// writes a value back that it sent itself. A value the owner changed on its own (cleared, another ask's words, an
// answer undone) replaces the text, by remounting the view on it.

import { TextInput } from "@getpaseo/plugin/client/react-native";
import { type ElementRef, forwardRef, useRef } from "react";
import type { TextInputProps } from "react-native";
import { draftEcho, received, typed } from "./draft-echo";

export type DraftInputProps = Omit<TextInputProps, "value" | "defaultValue" | "onChangeText"> & {
  value: string;
  onChangeText?: (text: string) => void;
};

export const DraftInput = forwardRef<ElementRef<typeof TextInput>, DraftInputProps>(function DraftInput(
  { value, onChangeText, ...rest },
  ref,
) {
  const echo = useRef(draftEcho(value));
  const generation = useRef(0);
  // Settled in render, idempotently: a second render of the same value finds it shown and changes nothing.
  const next = received(echo.current, value);
  echo.current = next.echo;
  if (next.take) generation.current += 1;
  return (
    <TextInput
      key={generation.current}
      {...rest}
      ref={ref}
      defaultValue={echo.current.shown}
      onChangeText={(text: string) => {
        echo.current = typed(echo.current, text);
        onChangeText?.(text);
      }}
    />
  );
});
