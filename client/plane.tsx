// The Maestro surface: all work, attention first. Wide windows keep the list
// and the selected item side by side; compact windows push the item over the
// list and give it a way back.

import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { Scoreboard, WorkItem } from "../shared/contracts";
import { GROUP_COPY, GROUP_ORDER, PLAIN_VOICE } from "../shared/states";
import { WorkDetail } from "./detail";
import { ago, basename, duration, errorText, plural } from "./format";
import { useWorkList } from "./hooks";
import { NewWork } from "./new-work";
import { Button, Card, IconButton, Notice, radius, StateDot, space, toneColor, useText } from "./ui";

export function MaestroSurface({ theme, layout, navigation }: PluginSurfaceProps) {
  const list = useWorkList();
  const text = useText(theme);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const compact = layout.compact;
  const pad = compact ? space[4] : space[6];

  const items = list.data?.items ?? [];
  const current = selected && items.some((item) => item.id === selected) ? selected : null;
  const needsYou = items.filter((item) => item.group === "review").length;
  const running = items.filter((item) => item.group === "running").length;
  const stuck = items.filter((item) => item.group === "blocked").length;
  const summary =
    [
      needsYou ? `${needsYou} ${needsYou === 1 ? "needs" : "need"} you` : null,
      stuck ? `${stuck} stuck` : null,
      running ? `${running} running` : null,
    ]
      .filter(Boolean)
      .join(" · ") || (items.length ? "Nothing needs you" : "No work yet");

  const newWork = (
    <NewWork theme={theme} open={creating} onOpenChange={setCreating} onCreated={setSelected} compact={compact} />
  );

  if (compact && current) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
        <WorkDetail id={current} theme={theme} compact navigation={navigation} onBack={() => setSelected(null)} />
        {newWork}
      </View>
    );
  }

  const listPane = (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: pad, gap: space[5] }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space[3] }}>
        <View style={{ flex: 1, gap: space[1] }}>
          <Text style={text.heading} accessibilityRole="header">
            Maestro
          </Text>
          <Text style={text.muted}>{summary}</Text>
        </View>
        <IconButton theme={theme} icon="RefreshCw" label="Refresh work" onPress={() => void list.refetch()} />
        <Button
          theme={theme}
          variant="primary"
          icon="Plus"
          label="New work"
          compact={compact}
          onPress={() => setCreating(true)}
        />
      </View>

      {list.isPending ? (
        <ActivityIndicator color={theme.colors.foregroundMuted} />
      ) : list.isError ? (
        <View style={{ gap: space[3] }}>
          <Notice theme={theme} tone="danger">
            {errorText(list.error)}
          </Notice>
          <Button theme={theme} label="Try again" onPress={() => void list.refetch()} />
        </View>
      ) : (
        <>
          <ScoreboardCard theme={theme} board={list.data.scoreboard} />
          {list.data.warnings.slice(0, 3).map((warning) => (
            <Notice key={warning} theme={theme} tone="warn">
              {warning}
            </Notice>
          ))}
          {list.data.warnings.length > 3 ? (
            <Text style={text.small}>{plural(list.data.warnings.length - 3, "more file")} could not be read.</Text>
          ) : null}
          {items.length === 0 ? (
            <Card theme={theme}>
              <Text style={text.title}>No work yet</Text>
              <Text style={text.muted}>
                Work lives as folders in {list.data.root}. Write one down and dispatch it: an agent runs it in its own
                worktree and brings it back to you.
              </Text>
              <View style={{ flexDirection: "row" }}>
                <Button
                  theme={theme}
                  variant="primary"
                  icon="Plus"
                  label="New work"
                  compact={compact}
                  onPress={() => setCreating(true)}
                />
              </View>
            </Card>
          ) : (
            GROUP_ORDER.map((group) => {
              const rows = items.filter((item) => item.group === group);
              if (rows.length === 0) return null;
              return (
                <View key={group} style={{ gap: space[2] }}>
                  <View style={{ flexDirection: "row", alignItems: "baseline", gap: space[2], flexWrap: "wrap" }}>
                    <Text style={[text.body, { fontWeight: "600" }]} accessibilityRole="header">
                      {GROUP_COPY[group].title}
                    </Text>
                    <Text style={[text.small, text.tabular]}>{rows.length}</Text>
                    <Text style={text.small}>{GROUP_COPY[group].hint}</Text>
                  </View>
                  <View style={{ gap: space[1] }}>
                    {rows.map((item) => (
                      <WorkRow
                        key={item.id}
                        theme={theme}
                        item={item}
                        selected={item.id === current}
                        compact={compact}
                        onPress={() => setSelected(item.id)}
                      />
                    ))}
                  </View>
                </View>
              );
            })
          )}
        </>
      )}
    </ScrollView>
  );

  if (compact) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
        {listPane}
        {newWork}
      </View>
    );
  }

  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: theme.colors.surface0 }}>
      <View style={{ width: 440, maxWidth: "45%", borderRightWidth: 1, borderRightColor: theme.colors.border }}>
        {listPane}
      </View>
      <View style={{ flex: 1 }}>
        {current ? (
          <WorkDetail id={current} theme={theme} compact={false} navigation={navigation} />
        ) : (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space[8], gap: space[2] }}>
            <Text style={text.title}>Pick a work item</Text>
            <Text style={[text.muted, { textAlign: "center", maxWidth: 360 }]}>
              Its receipts, checks and the verb it needs from you show here.
            </Text>
          </View>
        )}
      </View>
      {newWork}
    </View>
  );
}

function WorkRow({
  theme,
  item,
  selected,
  compact,
  onPress,
}: {
  theme: PluginTheme;
  item: WorkItem;
  selected: boolean;
  compact: boolean;
  onPress: () => void;
}) {
  const text = useText(theme);
  const voice = PLAIN_VOICE[item.state];
  const flag =
    item.phase === "asking"
      ? "Question"
      : item.phase === "checking"
        ? "Checking"
        : item.group === "review" || item.group === "blocked"
          ? voice.label
          : null;
  const meta = [item.project ?? item.initiative, basename(item.repo), ago(item.updatedAt)].filter(Boolean).join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${item.title}, ${item.state === "canceled" ? "Canceled" : voice.label}`}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: space[2],
        minHeight: compact ? 56 : 52,
        paddingVertical: space[2],
        paddingHorizontal: space[3],
        borderRadius: radius.control,
        borderWidth: 1,
        borderColor: selected ? theme.colors.border : "transparent",
        backgroundColor: selected || pressed ? theme.colors.surface1 : "transparent",
      })}
    >
      <StateDot theme={theme} state={item.state} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[text.body, { fontWeight: "500" }]} numberOfLines={1}>
          {item.title}
        </Text>
        {meta ? (
          <Text style={[text.small, text.tabular]} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
      {flag ? (
        <Text style={{ color: toneColor(theme, voice.tone), fontSize: 12, fontWeight: "600" }}>{flag}</Text>
      ) : null}
    </Pressable>
  );
}

function ScoreboardCard({ theme, board }: { theme: PluginTheme; board: Scoreboard }) {
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
    </Card>
  );
}
