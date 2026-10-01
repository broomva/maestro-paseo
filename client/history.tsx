// History: what happened across all work, newest first, by day or by work, and
// whether you did it or the loop did it on its own. Read-only; tapping a row
// opens its work.

import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { HISTORY_CAP, HISTORY_DAYS, type HistoryEvent, historyWork } from "../shared/records";
import { errorText } from "./format";
import {
  actorText,
  byWho,
  countWho,
  dayKey,
  emptyHistoryText,
  eventCrumb,
  GROUPINGS,
  groupEvents,
  type HistoryGrouping,
  inScope,
  isYours,
  rowLabel,
  shortDay,
  timeText,
  WHO,
  type Who,
} from "./history-model";
import { Chip } from "./plane-controls";
import { Button, Notice, radius, size, space, useText, webAria } from "./ui";

const POLL_MS = 10_000;

export function useHistory(days: number) {
  const read = useRpc(historyWork);
  return useQuery({
    queryKey: ["maestro", "history", days],
    queryFn: () => read({ days }),
    refetchInterval: POLL_MS,
  });
}

export function HistoryView({
  theme,
  scope,
  selected,
  onSelect,
}: {
  theme: PluginTheme;
  scope: string | null;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const days = HISTORY_DAYS.default;
  const history = useHistory(days);
  const text = useText(theme);
  const [who, setWho] = useState<Who>("all");
  const [grouping, setGrouping] = useState<HistoryGrouping>("day");

  if (history.isPending) return <ActivityIndicator color={theme.colors.foregroundMuted} />;
  if (history.isError) {
    return (
      <View style={{ gap: space[3] }}>
        <Notice theme={theme} tone="danger">
          {errorText(history.error)}
        </Notice>
        <Button theme={theme} label="Try again" onPress={() => void history.refetch()} />
      </View>
    );
  }

  const scoped = inScope(history.data.events, scope);
  const counts = countWho(scoped);
  const groups = groupEvents(byWho(scoped, who), grouping);
  // Two receipts can match in every field: the second of a kind gets a count.
  const seen = new Map<string, number>();
  const keyOf = (event: HistoryEvent) => {
    const base = `${event.itemId}-${event.ts}-${event.type}-${event.text}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
  return (
    <View style={{ gap: space[4] }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}>
        <View
          accessibilityRole="toolbar"
          accessibilityLabel="Who did it"
          style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}
        >
          {WHO.map((option) => (
            <Chip
              key={option.id}
              theme={theme}
              label={option.label}
              count={String(counts[option.id])}
              selected={who === option.id}
              accessibilityLabel={`${option.label}, ${counts[option.id]}`}
              onPress={() => setWho(option.id === who ? "all" : option.id)}
            />
          ))}
        </View>
        <View
          accessibilityRole="toolbar"
          accessibilityLabel="Group by"
          style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}
        >
          {GROUPINGS.map((option) => (
            <Chip
              key={option.id}
              theme={theme}
              label={option.label}
              selected={grouping === option.id}
              accessibilityLabel={option.label}
              onPress={() => setGrouping(option.id)}
            />
          ))}
        </View>
      </View>
      {groups.length === 0 ? (
        <Text style={text.muted}>{emptyHistoryText(who, days)}</Text>
      ) : (
        groups.map((group) => (
          <View key={group.key} style={{ gap: space[1] }}>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: space[2], flexWrap: "wrap" }}>
              <Text style={[text.body, { fontWeight: "600" }]} accessibilityRole="header">
                {group.title}
              </Text>
              <Text style={[text.small, text.tabular]}>{group.events.length}</Text>
              {group.hint ? <Text style={text.small}>{group.hint}</Text> : null}
            </View>
            {group.events.map((event) => (
              <HistoryRow
                key={keyOf(event)}
                theme={theme}
                event={event}
                grouping={grouping}
                selected={selected}
                onSelect={onSelect}
              />
            ))}
          </View>
        ))
      )}
      {history.data.capped ? (
        <Text style={text.small}>
          Showing the latest {HISTORY_CAP} events of the last {days} days.
        </Text>
      ) : null}
    </View>
  );
}

function HistoryRow({
  theme,
  event,
  grouping,
  selected,
  onSelect,
}: {
  theme: PluginTheme;
  event: HistoryEvent;
  grouping: HistoryGrouping;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const text = useText(theme);
  const isSelected = event.itemId === selected;
  const crumb = eventCrumb(event);
  const when = grouping === "day" ? timeText(event.ts) : `${shortDay(dayKey(event.ts))} ${timeText(event.ts)}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: isSelected }}
      {...webAria({ "aria-current": isSelected })}
      accessibilityLabel={rowLabel(event)}
      onPress={() => onSelect(event.itemId)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "flex-start",
        gap: space[3],
        paddingVertical: space[2],
        paddingHorizontal: space[2],
        borderRadius: radius.control,
        backgroundColor: isSelected || pressed ? theme.colors.surface1 : "transparent",
      })}
    >
      <Text style={[text.small, text.tabular, { width: grouping === "day" ? 40 : 76 }]}>{when}</Text>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={text.body} numberOfLines={1}>
          {event.text}
        </Text>
        {event.detail ? (
          <Text style={text.small} numberOfLines={2}>
            {event.detail}
          </Text>
        ) : null}
        {grouping === "day" ? (
          <Text style={text.small} numberOfLines={1}>
            {[event.title, crumb].filter(Boolean).join(" · ")}
          </Text>
        ) : null}
      </View>
      <ActorTag theme={theme} actor={event.actor} />
    </Pressable>
  );
}

/** You or the loop, in words: the tag's outline differs too, but the word carries it. */
function ActorTag({ theme, actor }: { theme: PluginTheme; actor: HistoryEvent["actor"] }) {
  const yours = isYours({ actor });
  return (
    <View
      style={{
        paddingHorizontal: space[2],
        minHeight: 20,
        justifyContent: "center",
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: yours ? theme.colors.accent : theme.colors.border,
      }}
    >
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: size.xs, fontWeight: "600" }}>
        {actorText(actor)}
      </Text>
    </View>
  );
}
