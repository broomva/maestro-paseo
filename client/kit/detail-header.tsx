// M/Detail header (Pen Faf21; M2–M4): the top of a card that rose from the
// deck. A grabber, a round close (chevron down), where you are ("Approval · 1
// of 4") over one segment per hold, and ⋯ for Open session, Copy link and
// Snooze. Segments before you are done (ok), yours is Tidepool, the rest wait.
// The words come from client/kit/deck-model.ts.

import type { PluginTheme } from "@getpaseo/plugin";
import type { GestureResponderHandlers } from "react-native";
import { Text, View } from "react-native";
import { tint } from "../fleet-color";
import { placeLabel, type Segment, segments } from "./deck-model";
import { RoundButton } from "./parts";
import { kitOf } from "./tokens";

/** Past this many, the segments are one bar: 12 × 22 pt fits between Close and More at a phone's 375 pt. */
const MAX_SEGMENTS = 12;

export function DetailHeader({
  theme,
  kind,
  index,
  total,
  onClose,
  onMore,
  dragHandlers,
}: {
  theme: PluginTheme;
  /** The kind's name: "Approval", "Ask", "Notice". */
  kind: string;
  index: number;
  total: number;
  onClose: () => void;
  onMore: () => void;
  /** The card's swipe-down handlers, so the grabber and bar drag it (client/kit/inspector.tsx). */
  dragHandlers?: GestureResponderHandlers;
}) {
  const kit = kitOf(theme);
  const label = placeLabel(kind, index, total);
  const color = (segment: Segment) =>
    segment === "current" ? kit.needs : segment === "done" ? kit.ok : tint(kit.fg, kit.dark ? 0.2 : 0.12);
  return (
    <View
      {...dragHandlers}
      testID="detail-header"
      style={{
        backgroundColor: kit.bg,
        borderTopLeftRadius: 22,
        borderTopRightRadius: 22,
        borderBottomWidth: 1,
        borderBottomColor: kit.hairline,
        paddingTop: 6,
        paddingHorizontal: 14,
        paddingBottom: 8,
        gap: 4,
      }}
    >
      <View style={{ alignItems: "center" }} accessible={false}>
        <View style={{ width: 36, height: 5, borderRadius: 3, backgroundColor: tint(kit.fg, 0.15) }} />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <RoundButton theme={theme} icon="ChevronDown" label="Close" onPress={onClose} />
        <View style={{ flex: 1, alignItems: "center", gap: 5 }}>
          <Text accessibilityRole="header" style={{ color: kit.fg, fontSize: 13, fontWeight: "600" }}>
            {label}
          </Text>
          {total > MAX_SEGMENTS ? (
            // A long series is one thin bar: a segment per ask would run into Close and More (BRO-3172).
            <View
              testID="progress-bar"
              accessible={false}
              style={{ width: 200, height: 4, borderRadius: 2, backgroundColor: color("todo"), overflow: "hidden" }}
            >
              <View
                style={{
                  width: `${(Math.min(Math.max(index + 1, 1), total) / total) * 100}%`,
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: color("current"),
                }}
              />
            </View>
          ) : (
            <View style={{ flexDirection: "row", gap: 4 }} accessible={false}>
              {segments(index, total).map((segment, at) => (
                <View
                  // biome-ignore lint/suspicious/noArrayIndexKey: a segment is its position
                  key={at}
                  testID={`segment-${segment}`}
                  style={{ width: 18, height: 4, borderRadius: 2, backgroundColor: color(segment) }}
                />
              ))}
            </View>
          )}
        </View>
        <RoundButton theme={theme} icon="Ellipsis" label="More" onPress={onMore} />
      </View>
    </View>
  );
}
