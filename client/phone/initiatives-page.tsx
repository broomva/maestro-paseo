// The phone's Initiatives (M8, BRO-3037; docs/design/next/m8-initiatives-mobile.png): a page reached from Health's
// sheet, since the tab bar has four tabs. Lateness is the loudest thing and a missing driver a hollow dot. A due
// review is an Ask on its due date (B2): its row opens the same hold the Feed's deck shows, answered there with
// its three answers and the 8 s undo; the other rows open their card. A read that failed says so: it is never
// an empty list. The rows are client/initiatives-board-model.ts's, the desktop's own.

import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { DecisionAsk } from "../../shared/fleet";
import type { InitiativesView } from "../../shared/initiatives";
import { useWorkspaceAsks } from "../decisions";
import { decisionAsks, sameAsk } from "../decisions-model";
import { errorText } from "../format";
import { useNeeds, useWorkList } from "../hooks";
import { IdeaList, InitiativeCard, useInitiatives } from "../initiatives";
import { type InitiativeFilter, type InitiativeRow, initiativeBoard } from "../initiatives-board-model";
import { ideasOf } from "../initiatives-model";
import { Dot, Pill, TABULAR } from "../kit/parts";
import { kitOf } from "../kit/tokens";
import { ChipRow } from "../stage-parts";

type Navigation = PluginSurfaceProps["navigation"];

function Row({
  theme,
  row,
  open,
  onPress,
}: {
  theme: PluginTheme;
  row: InitiativeRow;
  open: boolean;
  onPress: () => void;
}) {
  const kit = kitOf(theme);
  const statusColor = row.status.tone === "ok" ? kit.ok : row.status.tone === "warn" ? kit.warn : kit.muted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Initiative: ${row.name}${row.due ? `, review ${row.date.late ?? "due"}` : ""}`}
      accessibilityState={{ expanded: open }}
      testID={`initiative-${row.id}`}
      onPress={onPress}
      style={({ pressed }: { pressed: boolean }) => ({
        minHeight: 64,
        paddingVertical: 12,
        paddingHorizontal: 14,
        flexDirection: "row",
        gap: 12,
        backgroundColor: open ? kit.needsSoft : kit.bg,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text numberOfLines={1} style={{ flexShrink: 1, color: kit.fg, fontSize: 16, fontWeight: "600" }}>
            {row.name}
          </Text>
          <Text style={{ color: statusColor, fontSize: 11.5, fontWeight: "600" }}>{row.status.word}</Text>
        </View>
        {row.summary ? (
          <Text numberOfLines={1} style={{ color: kit.muted, fontSize: 13 }}>
            {row.summary}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {row.driver.live ? (
            <Dot color={kit.blue} size={8} />
          ) : (
            <View style={{ width: 8, height: 8, borderRadius: 4, borderWidth: 1.5, borderColor: kit.muted }} />
          )}
          <Text
            numberOfLines={1}
            style={{
              color: row.driver.live ? kit.fg2 : kit.muted,
              fontSize: 12.5,
              fontFamily: "ui-monospace, Menlo, monospace",
            }}
          >
            {row.driver.name === "none" ? "no driver" : row.driver.name}
          </Text>
        </View>
      </View>
      <View style={{ alignItems: "flex-end", gap: 3 }}>
        <Text
          style={{
            color: row.date.late ? kit.warn : kit.fg2,
            fontSize: 13,
            fontWeight: row.date.late ? "700" : "400",
            ...TABULAR,
          }}
        >
          {row.date.late ? `${row.date.text} · ${row.date.late}` : row.date.text}
        </Text>
        <Text style={{ color: kit.muted, fontSize: 12.5, ...TABULAR }}>
          {[
            row.work > 0 ? `${row.work} work` : null,
            row.asks > 0 ? `${row.asks} ${row.asks === 1 ? "ask" : "asks"}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      </View>
      <View style={{ justifyContent: "center" }}>
        <Icon name={row.due ? "CalendarClock" : "ChevronRight"} size={16} color={row.due ? kit.warn : kit.muted} />
      </View>
    </Pressable>
  );
}

export function InitiativesPage({
  theme,
  navigation,
  onOpenHold,
  onOpenDecision,
  onOpenWork,
}: {
  theme: PluginTheme;
  navigation: Navigation;
  /** A due review opens as the hold the Feed's deck shows (`review:<id>`). */
  onOpenHold: (key: string) => void;
  onOpenDecision: (ledger: string, askId: string | null) => void;
  onOpenWork: (id: string) => void;
}) {
  const kit = kitOf(theme);
  const client = useQueryClient();
  const read = useInitiatives();
  const needs = useNeeds();
  const list = useWorkList();
  const asksRead = useWorkspaceAsks();
  const [filter, setFilter] = useState<InitiativeFilter>("all");
  const [opened, setOpened] = useState<string | null>(null);
  const view = read.data;
  const board = initiativeBoard({
    initiatives: view?.initiatives ?? [],
    ideas: view?.ideas ?? [],
    items: list.data?.items ?? [],
    asks: asksRead.data ? decisionAsks(asksRead.data) : [],
    needs: needs.data ?? null,
    filter,
    today: view?.today ?? new Date().toISOString().slice(0, 10),
  });
  // An answer to an idea goes into every read held at once, so the row and the counts say so before the next poll.
  const onAnswered = (answered: DecisionAsk) =>
    client.setQueriesData<InitiativesView>({ queryKey: ["maestro", "initiatives"] }, (current) =>
      current ? { ...current, ideas: current.ideas.map((ask) => (sameAsk(ask, answered) ? answered : ask)) } : current,
    );
  if (read.isPending) return <ActivityIndicator color={kit.muted} />;
  if (!view) {
    return (
      <View style={{ gap: 12 }} testID="initiatives-unread">
        <Text accessibilityRole="alert" style={{ color: kit.danger, fontSize: 15 }}>
          {`Couldn't read your initiatives: ${errorText(read.error)}`}
        </Text>
        <View style={{ flexDirection: "row" }}>
          <Pill theme={theme} label="Try again" height={44} onPress={() => void read.refetch()} />
        </View>
      </View>
    );
  }
  // Due reviews are needs.list's holds; when that read failed, the due ones are missing, not none.
  const dueUnread = needs.isError && !needs.data;
  return (
    <View style={{ gap: 12 }} testID="initiatives-page">
      <Text accessibilityRole="header" style={{ color: kit.fg, fontSize: 28, fontWeight: "600", letterSpacing: -0.3 }}>
        Initiatives
      </Text>
      {dueUnread ? (
        <Text accessibilityRole="alert" style={{ color: kit.danger, fontSize: 13.5 }}>
          Couldn't read what needs you: a review that is due is not marked below.
        </Text>
      ) : null}
      {view.warnings.slice(0, 3).map((warning) => (
        <Text key={warning} style={{ color: kit.warn, fontSize: 13 }}>
          {warning}
        </Text>
      ))}
      <ChipRow
        theme={theme}
        label="Initiatives"
        options={board.chips.map((chip) => ({ id: chip.id, label: chip.label, count: chip.count }))}
        value={filter}
        onChange={(next) => {
          setFilter(next);
          setOpened(null);
        }}
      />
      {filter === "proposed" ? (
        <IdeaList
          theme={theme}
          ideas={view.ideas}
          today={view.today}
          compact
          onAnswered={onAnswered}
          onOpenWork={onOpenWork}
        />
      ) : board.rows.length === 0 ? (
        <Text style={{ color: kit.muted, fontSize: 14 }}>
          {view.initiatives.length === 0
            ? `An initiative is one file in ${view.controlRepo || "the control repo"}/.control/initiatives on origin/main. None is there yet.`
            : "Nothing here."}
        </Text>
      ) : (
        <View style={{ borderRadius: 14, overflow: "hidden", gap: 1, backgroundColor: kit.hairline }}>
          {board.rows.map((row) => (
            <View key={`${row.initiative.home.kind}:${row.initiative.file}`}>
              <Row
                theme={theme}
                row={row}
                open={!row.due && opened === row.id}
                onPress={() => {
                  if (row.due) onOpenHold(`review:${row.id}`);
                  else setOpened((now) => (now === row.id ? null : row.id));
                }}
              />
              {!row.due && opened === row.id ? (
                <View style={{ padding: 12, backgroundColor: kit.bg }}>
                  <InitiativeCard
                    theme={theme}
                    initiative={row.initiative}
                    ideas={ideasOf(view.ideas, row.id)}
                    today={view.today}
                    compact
                    navigation={navigation}
                    onOpenDecision={onOpenDecision}
                    onAnswered={onAnswered}
                    onOpenWork={onOpenWork}
                  />
                </View>
              ) : null}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
