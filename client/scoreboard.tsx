// Unsupervised hours: today as a timeline of runs and looks, and the week
// behind it as seven day bars. Tapping the week shows where its hours went,
// per initiative. Every bar carries its day and its hours as text; colour only
// repeats what the words say.

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Scoreboard } from "../shared/contracts";
import { duration, plural } from "./format";
import { Button, Card, space, useText } from "./ui";
import { type DayBar, dayBars, overlapNote, weekTotal, whereHoursWent } from "./week-model";

const BAR_HEIGHT = 44;

export function ScoreboardCard({
  theme,
  board,
  onOpenHistory,
}: {
  theme: PluginTheme;
  board: Scoreboard;
  onOpenHistory?: () => void;
}) {
  const text = useText(theme);
  const runs = board.segments.length;
  const label = `Unsupervised ${duration(board.unsupervisedMs)} today, ${plural(runs, "stretch", "stretches")}, ${plural(board.looks, "look")}`;
  return (
    <Card theme={theme}>
      <Text style={text.label}>Unsupervised today</Text>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: space[3], flexWrap: "wrap" }}>
        <Text style={[text.heading, text.tabular]}>{duration(board.unsupervisedMs)}</Text>
        <Text style={[text.muted, text.tabular]}>
          {plural(board.looks, "look")} · longest run {duration(board.longestRunMs)}
        </Text>
      </View>
      <View accessible accessibilityLabel={label} style={{ height: 16, justifyContent: "center" }}>
        <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.border, overflow: "hidden" }}>
          {board.segments.map((segment) => (
            <View
              key={`${segment.start}`}
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: `${segment.start * 100}%`,
                width: `${Math.max(segment.width * 100, 0.6)}%`,
                backgroundColor: theme.colors.accent,
                opacity: segment.live ? 1 : 0.7,
              }}
            />
          ))}
        </View>
        {[...new Set(board.notches)].map((notch) => (
          <View
            key={notch}
            style={{
              position: "absolute",
              left: `${notch * 100}%`,
              top: 1,
              width: 2,
              height: 14,
              borderRadius: 1,
              backgroundColor: theme.colors.foreground,
            }}
          />
        ))}
      </View>
      <Text style={text.small}>Bars are runs on their own. Each mark is a time you stepped in.</Text>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        {["00:00", "06:00", "12:00", "18:00", "24:00"].map((mark) => (
          <Text key={mark} style={[text.small, text.tabular]}>
            {mark}
          </Text>
        ))}
      </View>
      {board.week.length > 0 ? <Week theme={theme} board={board} onOpenHistory={onOpenHistory} /> : null}
    </Card>
  );
}

function Week({ theme, board, onOpenHistory }: { theme: PluginTheme; board: Scoreboard; onOpenHistory?: () => void }) {
  const text = useText(theme);
  const [open, setOpen] = useState(false);
  const total = weekTotal(board.week);
  const bars = dayBars(board.week);
  const toggle = () => setOpen((value) => !value);
  return (
    <View style={{ gap: space[3], paddingTop: space[3], borderTopWidth: 1, borderTopColor: theme.colors.border }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        accessibilityLabel={`This week, ${duration(total)} unsupervised. ${open ? "Hide" : "Show"} where the hours went`}
        onPress={toggle}
        style={{ flexDirection: "row", alignItems: "baseline", gap: space[2], flexWrap: "wrap" }}
      >
        <Text style={text.label}>This week</Text>
        <Text style={[text.body, text.tabular, { fontWeight: "600" }]}>{duration(total)}</Text>
        <View style={{ flex: 1 }} />
        <Text style={text.small}>Where the hours went</Text>
        <Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} color={theme.colors.foregroundMuted} />
      </Pressable>
      <View style={{ flexDirection: "row", gap: space[1] }}>
        {bars.map((bar) => (
          <Bar key={bar.date} theme={theme} bar={bar} onPress={toggle} />
        ))}
      </View>
      {open ? <WhereHoursWent theme={theme} board={board} total={total} onOpenHistory={onOpenHistory} /> : null}
    </View>
  );
}

function Bar({ theme, bar, onPress }: { theme: PluginTheme; bar: DayBar; onPress: () => void }) {
  const text = useText(theme);
  const height = bar.height > 0 ? Math.max(3, Math.round(bar.height * BAR_HEIGHT)) : 2;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={bar.label}
      onPress={onPress}
      style={{ flex: 1, minWidth: 0, alignItems: "center", gap: 2 }}
    >
      <Text style={[text.small, text.tabular, { fontSize: 11 }]} numberOfLines={1}>
        {bar.value}
      </Text>
      <View style={{ height: BAR_HEIGHT, width: "100%", justifyContent: "flex-end", alignItems: "center" }}>
        <View
          style={{
            height,
            width: "70%",
            maxWidth: 28,
            borderRadius: 3,
            backgroundColor: bar.height > 0 ? theme.colors.accent : theme.colors.border,
            opacity: bar.today || bar.height === 0 ? 1 : 0.6,
          }}
        />
      </View>
      <Text
        style={[
          text.small,
          {
            fontSize: 11,
            fontWeight: bar.today ? "700" : "400",
            color: bar.today ? theme.colors.foreground : undefined,
          },
        ]}
        numberOfLines={1}
      >
        {bar.day}
      </Text>
    </Pressable>
  );
}

function WhereHoursWent({
  theme,
  board,
  total,
  onOpenHistory,
}: {
  theme: PluginTheme;
  board: Scoreboard;
  total: number;
  onOpenHistory?: () => void;
}) {
  const text = useText(theme);
  const rows = whereHoursWent(board.weekByInitiative);
  const note = overlapNote(rows, total);
  return (
    <View style={{ gap: space[2] }}>
      <Text style={text.label} accessibilityRole="header">
        Where the hours went
      </Text>
      {rows.length === 0 ? (
        <Text style={text.muted}>Nothing ran on its own this week.</Text>
      ) : (
        rows.map((row) => (
          <View
            key={row.name}
            accessible
            accessibilityLabel={`${row.name}: ${duration(row.ms)} unsupervised this week`}
            style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}
          >
            <Text style={[text.body, { width: "34%" }]} numberOfLines={1}>
              {row.name}
            </Text>
            <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: theme.colors.border }}>
              <View
                style={{
                  width: `${Math.max(row.share * 100, 2)}%`,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: theme.colors.accent,
                }}
              />
            </View>
            <Text style={[text.small, text.tabular, { minWidth: 56, textAlign: "right" }]}>{duration(row.ms)}</Text>
          </View>
        ))
      )}
      {note ? <Text style={text.small}>{note}</Text> : null}
      {onOpenHistory ? (
        <View style={{ flexDirection: "row" }}>
          <Button theme={theme} variant="quiet" icon="History" label="Open History" onPress={onOpenHistory} />
        </View>
      ) : null}
    </View>
  );
}
