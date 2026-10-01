// The three work planes. Feed: attention-first groups of cards. Board: four
// fixed columns work moves across. List: dense rows under the same groups.

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import type { WorkItem } from "../shared/contracts";
import { GROUP_COPY, type Group } from "../shared/states";
import { ChangeText, WithChange } from "./changed";
import { ago } from "./format";
import {
  boardColumns,
  cardLabel,
  changedVisible,
  crumb,
  groupsOf,
  stateText,
  stuckText,
  workerText,
} from "./plane-model";
import { radius, StateDot, StateLabel, space, useText, webAria } from "./ui";

type Selectable = { theme: PluginTheme; selected: string | null; onSelect: (id: string) => void };

function GroupHeader({ theme, group, count }: { theme: PluginTheme; group: Group; count: number }) {
  const text = useText(theme);
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: space[2], flexWrap: "wrap" }}>
      <Text style={[text.body, { fontWeight: "600" }]} accessibilityRole="header">
        {GROUP_COPY[group].title}
      </Text>
      <Text style={[text.small, text.tabular]}>{count}</Text>
      <Text style={text.small}>{GROUP_COPY[group].hint}</Text>
    </View>
  );
}

export function FeedView({ items, ...pick }: Selectable & { items: WorkItem[] }) {
  return (
    <>
      {groupsOf(items).map(({ group, items: rows }) => (
        <View key={group} style={{ gap: space[2] }}>
          <GroupHeader theme={pick.theme} group={group} count={rows.length} />
          <View style={{ gap: space[2] }}>
            {rows.map((item) => (
              <WorkCard key={item.id} {...pick} item={item} />
            ))}
          </View>
        </View>
      ))}
    </>
  );
}

export function BoardView({ items, ...pick }: Selectable & { items: WorkItem[] }) {
  const text = useText(pick.theme);
  return (
    <ScrollView horizontal contentContainerStyle={{ flexGrow: 1, gap: space[3] }}>
      {boardColumns(items).map((column) => (
        <View key={column.id} style={{ flex: 1, minWidth: 220, gap: space[2] }}>
          <View style={{ gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: space[2] }}>
              <Text style={[text.body, { fontWeight: "600" }]} accessibilityRole="header">
                {column.title}
              </Text>
              <Text style={[text.small, text.tabular]}>{column.items.length}</Text>
            </View>
            <Text style={text.small} numberOfLines={1}>
              {column.hint}
            </Text>
          </View>
          {column.items.map((item) => (
            <WorkCard key={item.id} {...pick} item={item} />
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

export function ListView({ items, ...pick }: Selectable & { items: WorkItem[] }) {
  return (
    <>
      {groupsOf(items).map(({ group, items: rows }) => (
        <View key={group} style={{ gap: space[1] }}>
          <GroupHeader theme={pick.theme} group={group} count={rows.length} />
          {rows.map((item) => (
            <ListRow key={item.id} {...pick} item={item} />
          ))}
        </View>
      ))}
    </>
  );
}

function WorkCard({ theme, item, selected, onSelect }: Selectable & { item: WorkItem }) {
  const text = useText(theme);
  const place = crumb(item);
  const stuck = stuckText(item);
  const worker = workerText(item.worker);
  const branch = item.worker?.branch ?? null;
  const isSelected = item.id === selected;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: isSelected }}
      {...webAria({ "aria-current": isSelected })}
      accessibilityLabel={cardLabel(item)}
      onPress={() => onSelect(item.id)}
      style={({ pressed }) => ({
        gap: space[2],
        padding: space[3],
        borderRadius: radius.card,
        borderWidth: 1,
        borderColor: isSelected ? theme.colors.accent : theme.colors.border,
        backgroundColor: pressed ? theme.colors.surface2 : theme.colors.surface1,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: space[2] }}>
        <Text style={[text.small, { flex: 1 }]} numberOfLines={1}>
          {place ?? ""}
        </Text>
        <Text style={[text.small, text.tabular]}>{ago(item.updatedAt)}</Text>
      </View>
      <Text style={[text.body, { fontWeight: "500" }]} numberOfLines={2}>
        {item.title}
      </Text>
      {stuck ? (
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space[1] }}>
          <View style={{ paddingTop: 2 }}>
            <Icon name="CircleAlert" size={13} color={theme.colors.statusWarning} />
          </View>
          <Text style={[text.small, { flex: 1 }]} numberOfLines={2}>
            {stuck}
          </Text>
        </View>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[3], flexWrap: "wrap" }}>
        <StateLabel theme={theme} state={item.state} label={stateText(item)} />
        {worker ? <Text style={text.small}>{worker}</Text> : null}
      </View>
      <WithChange workspaceId={item.worker?.workspaceId} stat={item.changed}>
        {(stat) =>
          changedVisible(branch, stat) ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}>
              {branch ? (
                <Text style={[text.mono, { color: theme.colors.foregroundMuted, flexShrink: 1 }]} numberOfLines={1}>
                  {branch}
                </Text>
              ) : null}
              {stat ? <ChangeText theme={theme} stat={stat} /> : null}
            </View>
          ) : null
        }
      </WithChange>
    </Pressable>
  );
}

function ListRow({ theme, item, selected, onSelect }: Selectable & { item: WorkItem }) {
  const text = useText(theme);
  const place = crumb(item);
  const branch = item.worker?.branch ?? null;
  const isSelected = item.id === selected;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: isSelected }}
      {...webAria({ "aria-current": isSelected })}
      accessibilityLabel={cardLabel(item)}
      onPress={() => onSelect(item.id)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: space[2],
        minHeight: 36,
        paddingHorizontal: space[2],
        borderRadius: radius.control,
        backgroundColor: isSelected || pressed ? theme.colors.surface1 : "transparent",
      })}
    >
      <StateDot theme={theme} state={item.state} dim={7} />
      <Text style={[text.small, { width: 64 }]} numberOfLines={1}>
        {stateText(item)}
      </Text>
      <Text style={[text.body, { flex: 2, minWidth: 0 }]} numberOfLines={1}>
        {item.title}
      </Text>
      <Text style={[text.small, { flex: 1, minWidth: 0 }]} numberOfLines={1}>
        {place ?? ""}
      </Text>
      <Text style={[text.mono, { flex: 1, minWidth: 0, color: theme.colors.foregroundMuted }]} numberOfLines={1}>
        {branch ?? ""}
      </Text>
      <Text style={[text.small, text.tabular, { width: 32, textAlign: "right" }]}>{ago(item.updatedAt)}</Text>
    </Pressable>
  );
}
