// The phone's Decisions tab as a dashboard (BRO-3172): your answers as one summary row that opens in place, then one
// row per ask series (client/phone/series-model.ts). A row opens the focused card (InspectorCard) on its series; no
// answer form is drawn here. The answers' tiles and rows are AnswersSheet's, unchanged.

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Dot, TABULAR } from "../kit/parts";
import { kitOf } from "../kit/tokens";
import { focusRing } from "../ui";
import type { SheetCount } from "./model";
import { type AskSeries, seriesLine } from "./series-model";

export function AnswersSummary({
  theme,
  counts,
  children,
}: {
  theme: PluginTheme;
  /** answersCounts: waiting to land, routed, acted, held. */
  counts: readonly SheetCount[];
  /** AnswersSheet, shown when the row is open. */
  children: ReactNode;
}) {
  const kit = kitOf(theme);
  const warn = counts.some((count) => count.tone === "warn");
  // It opens by itself while an answer waits to land, so its verb shows; a press is yours from then on.
  const [chosen, setChosen] = useState<boolean | null>(null);
  // Open by itself only while an answer waits to land: an unread status warns too, and stays folded.
  const waiting = counts.some((count) => count.id === "waiting" && count.tone === "warn");
  const open = chosen ?? waiting;
  return (
    <View style={{ gap: 12 }}>
      <Pressable
        testID="answers-summary"
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Your answers: ${counts.map((count) => count.label).join(", ")}. ${open ? "Hide" : "Show"} where they went`}
        onPress={() => setChosen(!open)}
        style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({
          ...focusRing(theme, focused),
          minHeight: 52,
          borderRadius: 14,
          paddingVertical: 10,
          paddingHorizontal: 14,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          backgroundColor: warn ? kit.warnSoft : kit.sunken,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={{ color: kit.fg, fontSize: 15, fontWeight: "600" }}>Your answers</Text>
          <Text numberOfLines={2} style={{ color: warn ? kit.warn : kit.muted, fontSize: 13, ...TABULAR }}>
            {counts.map((count) => count.label).join(" · ")}
          </Text>
        </View>
        <Icon name={open ? "ChevronUp" : "ChevronDown"} size={18} color={kit.muted} />
      </Pressable>
      {open ? children : null}
    </View>
  );
}

export function SeriesList({
  theme,
  series,
  now,
  onOpen,
}: {
  theme: PluginTheme;
  series: readonly AskSeries[];
  now: number;
  onOpen: (series: AskSeries) => void;
}) {
  const kit = kitOf(theme);
  return (
    <View testID="series-list" style={{ borderRadius: 16, overflow: "hidden", gap: 1, backgroundColor: kit.hairline }}>
      {series.map((one) => {
        const line = seriesLine(one, now);
        return (
          <Pressable
            key={one.id}
            testID="series-row"
            accessibilityRole="button"
            accessibilityLabel={`${one.title}. ${line}${one.blocking ? ". Blocking" : ""}. Open the series`}
            onPress={() => onOpen(one)}
            style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({
              ...focusRing(theme, focused),
              minHeight: 60,
              paddingVertical: 12,
              paddingHorizontal: 14,
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              backgroundColor: pressed ? kit.sunken : kit.bg,
            })}
          >
            <Dot color={one.waits > 0 ? kit.needs : kit.muted} size={8} />
            <View style={{ flex: 1, gap: 3 }}>
              <Text numberOfLines={2} style={{ color: kit.fg, fontSize: 15.5, fontWeight: "600" }}>
                {one.title}
              </Text>
              <Text numberOfLines={1} style={{ color: kit.muted, fontSize: 13, ...TABULAR }}>
                {line}
              </Text>
            </View>
            {one.blocking ? (
              <View
                style={{
                  height: 24,
                  paddingHorizontal: 9,
                  borderRadius: 9999,
                  justifyContent: "center",
                  backgroundColor: kit.needsSoft,
                }}
              >
                <Text style={{ color: kit.needs, fontSize: 12, fontWeight: "600" }}>Blocking</Text>
              </View>
            ) : null}
            <Icon name="ChevronRight" size={18} color={kit.muted} />
          </Pressable>
        );
      })}
    </View>
  );
}
