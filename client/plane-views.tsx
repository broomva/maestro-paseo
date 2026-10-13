// The three work planes. Feed: attention-first groups of cards. Board: four
// fixed columns work moves across. List: dense rows under the same groups.

import type { PluginTheme } from "@getpaseo/plugin";
import { Pressable, Text, View } from "react-native";
import type { WorkItem } from "../shared/contracts";
import { GROUP_COPY, type Group } from "../shared/states";
import { ago } from "./format";
import { cardLabel, groupHint, groupsOf, stateText } from "./plane-model";
import { placeText, titleText } from "./records-text";
import { radius, StateDot, space, Unbroken, useText, webAria } from "./ui";

type Selectable = { theme: PluginTheme; selected: string | null; onSelect: (id: string) => void };
/** A plane's work, and whether the loop is on, which words the Queued hint. */
type Plane = Selectable & { items: WorkItem[]; loopOn: boolean };

function GroupHeader({
  theme,
  group,
  count,
  loopOn,
}: {
  theme: PluginTheme;
  group: Group;
  count: number;
  loopOn: boolean;
}) {
  const text = useText(theme);
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: space[2], flexWrap: "wrap" }}>
      <Text style={[text.body, { fontWeight: "600" }]} accessibilityRole="header">
        {GROUP_COPY[group].title}
      </Text>
      <Text style={[text.small, text.tabular]}>{count}</Text>
      <Text style={text.small}>{groupHint(group, loopOn)}</Text>
    </View>
  );
}

export function ListView({ items, loopOn, ...pick }: Plane) {
  return (
    <>
      {groupsOf(items).map(({ group, items: rows }) => (
        <View key={group} style={{ gap: space[1] }}>
          <GroupHeader theme={pick.theme} group={group} count={rows.length} loopOn={loopOn} />
          {rows.map((item) => (
            <ListRow key={item.id} {...pick} item={item} />
          ))}
        </View>
      ))}
    </>
  );
}

/**
 * What a screen reader hears for a card: cardLabel's words with the title and
 * place a person reads (records-text.ts), not the raw marker and folder path.
 */
function labelOf(item: WorkItem): string {
  return cardLabel({ ...item, title: titleText(item), initiative: placeText(item), project: null, repo: null });
}

function ListRow({ theme, item, selected, onSelect }: Selectable & { item: WorkItem }) {
  const text = useText(theme);
  const place = placeText(item);
  const branch = item.worker?.branch ?? null;
  const isSelected = item.id === selected;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: isSelected }}
      {...webAria({ "aria-current": isSelected })}
      accessibilityLabel={labelOf(item)}
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
        <Unbroken>{titleText(item)}</Unbroken>
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
