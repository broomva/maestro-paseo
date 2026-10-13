// The inbox digest (K1's third column): the only card the inbox session holds. "3 things need you · each opens its
// own session", read from needs.list now, so it is the header's own number. A row opens the session that asked,
// where the card to act from waits (K2's page); the digest has no verb of its own. Open in Maestro opens the Feed.

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { CardData } from "../shared/card";
import { CARD_POLL_MS, type CardActions, readOf, useCardWork } from "./card-hooks";
import { type DigestRow, digestOf } from "./card-model";
import { CARD_LOOK, CardFrame, OpenLink } from "./card-parts";
import { useNeeds } from "./hooks";
import { Kicker, Pill } from "./kit/parts";
import { kitOf } from "./kit/tokens";
import { focusRing } from "./ui";

const ROW_ICON: Record<DigestRow["kind"], string> = {
  approval: "ShieldCheck",
  ask: "CircleHelp",
  owner_step: "Hand",
  finished: "CircleCheck",
};

export function DigestCard({
  data,
  theme,
  actions,
}: {
  data: CardData;
  theme: PluginTheme;
  compact: boolean;
  host: string | null;
  actions: CardActions;
}) {
  const kit = kitOf(theme);
  const [live, setLive] = useState(true);
  const needs = useNeeds(live ? CARD_POLL_MS : false);
  const work = useCardWork(data.key, live);
  const state = digestOf({
    card: data,
    needs: readOf(needs),
    work: work.data ? { status: "ok", value: work.data.item } : null,
  });
  // A digest of nothing has nothing left to change; one that lists holds keeps reading.
  useEffect(() => setLive(state.phase !== "rows" || state.total > 0), [state]);
  return (
    <CardFrame theme={theme} ring={state.phase === "rows" && state.total > 0} testID="card-digest">
      <Kicker theme={theme} icon={CARD_LOOK.digest.icon} parts={[CARD_LOOK.digest.label, "the inbox digest"]} />
      {state.phase === "loading" ? (
        <ActivityIndicator color={kit.muted} />
      ) : state.phase === "unread" ? (
        <>
          <Text testID="card-unread" style={{ color: kit.fg2, fontSize: 14, lineHeight: 20 }}>
            {state.words}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Pill theme={theme} label="Try again" height={40} onPress={() => void needs.refetch()} />
            <OpenLink theme={theme} onPress={actions.maestro} />
          </View>
        </>
      ) : (
        <>
          <Text accessibilityRole="header" style={{ color: kit.fg, fontSize: 17, fontWeight: "600", lineHeight: 23 }}>
            {state.total > 0 ? `${state.words} · each opens its own session` : state.words}
          </Text>
          {state.rows.map((row) => (
            <DigestLine key={row.key} row={row} theme={theme} actions={actions} />
          ))}
          {state.more > 0 ? <Text style={{ color: kit.muted, fontSize: 12.5 }}>{`and ${state.more} more`}</Text> : null}
          <View style={{ flexDirection: "row" }}>
            <OpenLink theme={theme} onPress={actions.maestro} />
          </View>
        </>
      )}
    </CardFrame>
  );
}

function DigestLine({ row, theme, actions }: { row: DigestRow; theme: PluginTheme; actions: CardActions }) {
  const kit = kitOf(theme);
  const open = () => (row.agentId ? actions.session(row.agentId) : actions.hold(row.key));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${row.title}, ${row.caption}`}
      onPress={open}
      style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({
        ...focusRing(theme, focused),
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        minHeight: 52,
        paddingHorizontal: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: kit.hairline,
        backgroundColor: kit.bg,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Icon name={ROW_ICON[row.kind]} size={17} color={row.kind === "finished" ? kit.ok : kit.needs} />
      <View style={{ flex: 1, gap: 1 }}>
        <Text numberOfLines={1} style={{ color: kit.fg, fontSize: 14.5, fontWeight: "500" }}>
          {row.title}
        </Text>
        <Text numberOfLines={1} style={{ color: kit.muted, fontSize: 12.5 }}>
          {row.caption}
        </Text>
      </View>
      <Icon name="ChevronRight" size={16} color={kit.muted} />
    </Pressable>
  );
}
