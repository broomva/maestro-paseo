// The parts J5–J9 share (BRO-3036), in J1's language: a row of chips that choose one thing (an order, a
// ledger, a filter), the segmented progress under a stage, and a glance tile that carries its own verb. Each
// draws what its screen's model decided; nothing here counts.

import type { PluginTheme } from "@getpaseo/plugin";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { GlanceTile } from "./kit/glance-tile";
import { Pill, TABULAR } from "./kit/parts";
import type { TileTone } from "./kit/tile-model";
import { kitOf } from "./kit/tokens";
import { focusRing, webAria } from "./ui";

export interface ChipOption<T extends string> {
  id: T;
  label: string;
  /** A count after the label, drawn muted. */
  count?: number;
  /** What a screen reader says, when it is more than the label and the count. */
  aria?: string;
}

/**
 * Chips that choose one: `variant` "pills" is J1's scope bar (the chosen one in ink), "segment" an order's
 * control (a sunken track, the chosen one lifted). A radio group, so a screen reader says which is chosen.
 */
export function ChipRow<T extends string>({
  theme,
  label,
  options,
  value,
  onChange,
  variant = "pills",
}: {
  theme: PluginTheme;
  label: string;
  options: readonly ChipOption<T>[];
  value: T;
  onChange: (id: T) => void;
  variant?: "pills" | "segment";
}) {
  const kit = kitOf(theme);
  const segment = variant === "segment";
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        gap: segment ? 2 : 8,
        padding: segment ? 3 : 0,
        borderRadius: 9999,
        backgroundColor: segment ? kit.sunken : "transparent",
        alignSelf: "flex-start",
      }}
    >
      {options.map((option) => {
        const chosen = option.id === value;
        const ink = !segment && chosen;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="radio"
            accessibilityState={{ checked: chosen }}
            {...webAria({ "aria-checked": chosen })}
            accessibilityLabel={
              option.aria ?? (option.count === undefined ? option.label : `${option.label}, ${option.count}`)
            }
            onPress={() => onChange(option.id)}
            style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({
              ...focusRing(theme, focused),
              height: segment ? 28 : 30,
              paddingHorizontal: 14,
              borderRadius: 9999,
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              backgroundColor: ink ? kit.ink : segment && chosen ? kit.bg : segment ? "transparent" : kit.sunken,
              shadowColor: "#0c101a",
              shadowOpacity: segment && chosen ? 0.1 : 0,
              shadowRadius: 2,
              shadowOffset: { width: 0, height: 1 },
              opacity: pressed ? 0.8 : 1,
            })}
          >
            <Text
              style={{
                color: ink ? kit.onInk : chosen ? kit.fg : kit.fg2,
                fontSize: 13,
                fontWeight: chosen ? "600" : "400",
                ...TABULAR,
              }}
            >
              {option.label}
            </Text>
            {option.count === undefined ? null : (
              <Text style={{ color: ink ? kit.onInk : kit.muted, fontSize: 12, opacity: ink ? 0.7 : 1, ...TABULAR }}>
                {option.count}
              </Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

/** One segment per decision this visit has had, filled for each answered: the stage's progress. */
export function Segments({ theme, filled }: { theme: PluginTheme; filled: readonly boolean[] }) {
  const kit = kitOf(theme);
  return (
    <View accessible={false} style={{ flexDirection: "row", gap: 3 }}>
      {filled.map((done, at) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: segments have no identity but their place
          key={at}
          style={{ width: 18, height: 4, borderRadius: 2, backgroundColor: done ? kit.needs : kit.border }}
        />
      ))}
    </View>
  );
}

/**
 * A glance tile that carries its own verb at its top right (J5's "Open the PR"). The verb is the tile's, so the
 * tile itself is not pressable: a button never sits inside a button.
 */
export function TileWithVerb({
  theme,
  icon,
  label,
  value,
  unit,
  line,
  tone,
  verb,
  onVerb,
  children,
}: {
  theme: PluginTheme;
  icon: string;
  label: string;
  value: string;
  unit?: string;
  line?: string;
  tone: TileTone;
  verb?: string;
  onVerb?: () => void;
  children?: ReactNode;
}) {
  return (
    <View style={{ flex: 1, minWidth: 200 }}>
      <GlanceTile theme={theme} icon={icon} label={label} value={value} unit={unit} line={line} tone={tone} lines={3}>
        {children}
      </GlanceTile>
      {verb && onVerb ? (
        <View style={{ position: "absolute", top: 10, right: 12 }}>
          <Pill theme={theme} label={verb} primary height={28} onPress={onVerb} />
        </View>
      ) : null}
    </View>
  );
}
