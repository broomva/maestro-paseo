// The phone's Work tab (M6, BRO-3037; docs/design/next/m6-work-mobile.png). The deck holds the work that needs
// you, each with its hold, its lifecycle and its receipts so far; Open the hold goes to the same card as the
// Feed. The sheet is the board as one list with a lane switcher; running rows wear the Undertow (B1: Running
// only). It draws what client/phone/tabs-model.ts decided and hands every press up.

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import { tint } from "../fleet-color";
import { DeckHold } from "../kit/deck";
import { MONO } from "../kit/parts";
import { kitOf } from "../kit/tokens";
import type { LaneCard } from "../work-model";
import { lifecycleOf, receiptLines, WORK_LANES, type WorkLaneId } from "./tabs-model";

/** The work a hold on the deck is: its kicker, title, why it is yours, lifecycle and receipts. */
export function WorkDeckCard({
  theme,
  card,
  hasSession,
  onSession,
  onHold,
}: {
  theme: PluginTheme;
  card: LaneCard;
  hasSession: boolean;
  onSession: () => void;
  onHold: () => void;
}) {
  const kit = kitOf(theme);
  const item = card.item;
  const steps = item ? lifecycleOf(item) : [];
  const receipts = item ? receiptLines(item) : [];
  // The step the work is at: the last it reached.
  const at = steps.reduce((last, step, index) => (step.done ? index : last), 0);
  return (
    <DeckHold
      theme={theme}
      icon="Hand"
      kicker={["Needs you", ...card.kicker]}
      title={card.title}
      verbs={[
        { label: "Open session", disabled: !hasSession, onPress: onSession },
        { label: "Open the hold", primary: true, onPress: onHold },
      ]}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          backgroundColor: kit.needsSoft,
          borderRadius: 10,
          padding: 10,
        }}
      >
        <Icon name="ShieldCheck" size={15} color={kit.needs} />
        <Text style={{ flex: 1, color: kit.fg, fontSize: 14, lineHeight: 19 }}>{`Its hold: ${card.line}`}</Text>
      </View>
      {steps.length > 0 ? (
        <View style={{ gap: 6 }}>
          <Text style={{ color: kit.muted, fontSize: 11, fontWeight: "600", letterSpacing: 0.6 }}>LIFECYCLE</Text>
          <View style={{ flexDirection: "row", gap: 4 }} accessibilityLabel={`Lifecycle: ${steps[at]?.label ?? ""}`}>
            {steps.map((step) => (
              <View
                key={step.label}
                style={{
                  flex: 1,
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: step.done ? kit.ok : tint(kit.fg, 0.12),
                }}
              />
            ))}
          </View>
          <View style={{ flexDirection: "row", gap: 4 }}>
            {steps.map((step, index) => (
              <Text
                key={step.label}
                numberOfLines={1}
                style={{
                  flex: 1,
                  color: index === at ? kit.info : kit.muted,
                  fontSize: 12,
                  fontWeight: index === at ? "600" : "400",
                }}
              >
                {step.label}
              </Text>
            ))}
          </View>
        </View>
      ) : null}
      <View style={{ gap: 6 }}>
        <Text style={{ color: kit.muted, fontSize: 11, fontWeight: "600", letterSpacing: 0.6 }}>RECEIPTS</Text>
        <View style={{ backgroundColor: kit.sunken, borderRadius: 10, padding: 10, gap: 3 }}>
          {receipts.length > 0 ? (
            receipts.map((line) => (
              <Text key={line} style={{ color: kit.fg2, fontSize: 12.5, fontFamily: MONO }}>
                {line}
              </Text>
            ))
          ) : (
            <Text style={{ color: kit.muted, fontSize: 12.5 }}>None recorded yet.</Text>
          )}
        </View>
      </View>
    </DeckHold>
  );
}

/** The lane switcher over the board (M6 frame 2): four segments, each with its own count. */
export function LaneSwitcher({
  theme,
  lane,
  counts,
  onLane,
}: {
  theme: PluginTheme;
  lane: WorkLaneId;
  counts: Readonly<Record<WorkLaneId, number>>;
  onLane: (lane: WorkLaneId) => void;
}) {
  const kit = kitOf(theme);
  return (
    <View
      accessibilityRole="tablist"
      style={{ flexDirection: "row", padding: 3, borderRadius: 12, backgroundColor: kit.sunken, gap: 2 }}
    >
      {WORK_LANES.map((entry) => {
        const on = entry.id === lane;
        return (
          <Pressable
            key={entry.id}
            accessibilityRole="tab"
            accessibilityLabel={`${entry.title}, ${counts[entry.id]}`}
            accessibilityState={{ selected: on }}
            onPress={() => onLane(entry.id)}
            style={{
              flex: 1,
              minHeight: 38,
              borderRadius: 9,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: on ? kit.bg : "transparent",
            }}
          >
            <Text style={{ color: on ? kit.fg : kit.fg2, fontSize: 13.5, fontWeight: on ? "600" : "400" }}>
              {`${entry.title} ${counts[entry.id]}`}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
