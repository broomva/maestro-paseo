// J8, Initiatives (BRO-3036; docs/design/next/j8-initiatives.png): late reviews come first and say how late;
// four tiles say what needs you before you scan; each row names its driver, its review date and what hangs off
// it. A due review is an Ask on its due date (B2): picking one opens its review in J1's inspector, with what
// changed, what hangs off it and its three answers (keep, park, close), and it is the same hold the Feed's deck
// shows. The answer goes through client/verbs.ts and waits out its 8 s undo; Maestro records it as a receipt
// and never edits the initiative's file (A8). The other rows open their card (the file's links and what it
// waits on); Proposed lists the ideas, answered where they were.

import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { DecisionAsk } from "../shared/fleet";
import type { InitiativesView } from "../shared/initiatives";
import { holdOf } from "../shared/needs";
import { useWorkspaceAsks } from "./decisions";
import { decisionAsks, sameAsk } from "./decisions-model";
import { type NeedEntry, needsSection } from "./feed-model";
import { errorText } from "./format";
import { useNeeds, useWorkList } from "./hooks";
import { IdeaList, InitiativeCard, useInitiatives } from "./initiatives";
import { type InitiativeFilter, type InitiativeRow, initiativeBoard, sourceLine } from "./initiatives-board-model";
import { ideasOf } from "./initiatives-model";
import { InspectorPanel } from "./kit/inspector";
import { Dot, PASS_THROUGH, TABULAR } from "./kit/parts";
import { kitOf } from "./kit/tokens";
import { UndoToast } from "./kit/undo-toast";
import { ChipRow, TileWithVerb } from "./stage-parts";
import { Button, focusRing, Notice } from "./ui";
import { useInspector } from "./use-inspector";
import { useTick } from "./use-tick";

type Navigation = PluginSurfaceProps["navigation"];

const INSPECTOR_WIDTH = 420;

function Row({
  theme,
  row,
  selected,
  onPress,
}: {
  theme: PluginTheme;
  row: InitiativeRow;
  selected: boolean;
  onPress: () => void;
}) {
  const kit = kitOf(theme);
  const statusColor = row.status.tone === "ok" ? kit.ok : row.status.tone === "warn" ? kit.warn : kit.muted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Initiative: ${row.name}${row.due ? `, review ${row.date.late ?? "due"}` : ""}`}
      accessibilityState={{ selected }}
      aria-current={selected}
      testID={`initiative-${row.id}`}
      onPress={onPress}
      style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({
        ...focusRing(theme, focused),
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        paddingVertical: 12,
        paddingHorizontal: 14,
        backgroundColor: selected ? kit.needsSoft : "transparent",
        borderLeftWidth: 2,
        borderLeftColor: selected ? kit.needs : "transparent",
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Icon name="Target" size={16} color={row.due ? kit.warn : kit.muted} />
      <View style={{ flex: 3, gap: 2, minWidth: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text numberOfLines={1} style={{ color: kit.fg, fontSize: 14, fontWeight: "600" }}>
            {row.name}
          </Text>
          <Text style={{ color: statusColor, fontSize: 11.5, fontWeight: "600" }}>{row.status.word}</Text>
        </View>
        {row.summary ? (
          <Text numberOfLines={1} style={{ color: kit.muted, fontSize: 12.5 }}>
            {row.summary}
          </Text>
        ) : null}
      </View>
      <View style={{ flex: 2, flexDirection: "row", alignItems: "center", gap: 6 }}>
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
          {row.driver.name}
        </Text>
      </View>
      <View style={{ width: 120, flexDirection: "row", gap: 6, alignItems: "baseline" }}>
        <Text
          style={{
            color: row.date.late ? kit.warn : kit.fg2,
            fontSize: 12.5,
            fontWeight: row.date.late ? "700" : "400",
            ...TABULAR,
          }}
        >
          {row.date.text}
        </Text>
        {row.date.late ? (
          <Text style={{ color: kit.warn, fontSize: 12, fontWeight: "700" }}>· {row.date.late}</Text>
        ) : null}
      </View>
      <View style={{ width: 130, flexDirection: "row", gap: 8 }}>
        <Text style={{ color: kit.fg2, fontSize: 12.5, ...TABULAR }}>{row.work} work</Text>
        <Text style={{ color: row.asks > 0 ? kit.info : kit.muted, fontSize: 12.5, ...TABULAR }}>
          {row.asks} {row.asks === 1 ? "ask" : "asks"}
        </Text>
      </View>
    </Pressable>
  );
}

export function InitiativesBoard({
  theme,
  navigation,
  onOpenDecision,
  onOpenWork,
}: {
  theme: PluginTheme;
  navigation: Navigation;
  onOpenDecision: (ledger: string, askId: string | null) => void;
  onOpenWork: (id: string) => void;
}) {
  const kit = kitOf(theme);
  const client = useQueryClient();
  const read = useInitiatives();
  const needs = useNeeds();
  const list = useWorkList();
  const asksRead = useWorkspaceAsks();
  const now = useTick(15_000);
  const [filter, setFilter] = useState<InitiativeFilter>("all");
  const [opened, setOpened] = useState<string | null>(null);
  const items = list.data?.items ?? [];
  const asks = asksRead.data ? decisionAsks(asksRead.data) : [];
  const entries: NeedEntry[] = useMemo(
    () => needsSection(needs.data?.rows ?? [], items, asks),
    [needs.data, items, asks],
  );
  const view = read.data;
  const board = initiativeBoard({
    initiatives: view?.initiatives ?? [],
    ideas: view?.ideas ?? [],
    items,
    asks,
    needs: needs.data ?? null,
    filter,
    today: view?.today ?? new Date().toISOString().slice(0, 10),
  });
  const holdKeys = board.rows.filter((row) => row.due).map((row) => `review:${row.id}`);
  const inspector = useInspector({ items, entries, holdKeys, navigation, onOpenWork, now });
  // An answer to an idea goes into every read held at once, so the row and the counts say so before the next poll.
  const onAnswered = (answered: DecisionAsk) =>
    client.setQueriesData<InitiativesView>({ queryKey: ["maestro", "initiatives"] }, (current) =>
      current ? { ...current, ideas: current.ideas.map((ask) => (sameAsk(ask, answered) ? answered : ask)) } : current,
    );
  if (read.isPending) return <ActivityIndicator color={kit.muted} />;
  if (!view) {
    return (
      <View style={{ gap: 12 }}>
        <Notice theme={theme} tone="danger">
          {`Your initiatives could not be read: ${errorText(read.error)}`}
        </Notice>
        <Button theme={theme} label="Try again" onPress={() => void read.refetch()} />
      </View>
    );
  }
  const selectedKey = inspector.selection?.kind === "hold" ? inspector.selection.key : null;
  return (
    <View ref={inspector.root as never} testID="initiatives-board" style={{ gap: 14 }}>
      {view.warnings.slice(0, 3).map((warning) => (
        <Notice key={warning} theme={theme} tone="warn">
          {warning}
        </Notice>
      ))}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
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
        <View style={{ flex: 1 }} />
        <Text style={{ color: kit.muted, fontSize: 12.5 }}>{sourceLine(view.controlRepo)}</Text>
      </View>
      <View style={{ flexDirection: "row", gap: 14, flexWrap: "wrap" }}>
        <TileWithVerb
          theme={theme}
          icon="CalendarClock"
          label="Review due"
          value={String(board.tiles.due.value)}
          unit="due"
          line={board.tiles.due.line}
          tone={board.tiles.due.value > 0 ? "warn" : "plain"}
        />
        <TileWithVerb
          theme={theme}
          icon="Target"
          label="Active"
          value={String(board.tiles.active.value)}
          line={board.tiles.active.line}
          tone="plain"
        />
        <TileWithVerb
          theme={theme}
          icon="Lightbulb"
          label="Proposed"
          value={String(board.tiles.proposed.value)}
          line={board.tiles.proposed.line}
          tone="plain"
        />
        <TileWithVerb
          theme={theme}
          icon="GitBranch"
          label="Hanging off"
          value={String(board.tiles.hanging.work)}
          unit={`work · ${board.tiles.hanging.asks} ${board.tiles.hanging.asks === 1 ? "ask" : "asks"}`}
          line={board.tiles.hanging.line}
          tone="plain"
        />
      </View>
      <View style={{ position: "relative", minHeight: 420 }}>
        {filter === "proposed" ? (
          <IdeaList
            theme={theme}
            ideas={view.ideas}
            today={view.today}
            compact={false}
            onAnswered={onAnswered}
            onOpenWork={onOpenWork}
          />
        ) : board.rows.length === 0 ? (
          <Text style={{ color: kit.muted, fontSize: 13 }}>
            {view.initiatives.length === 0
              ? `An initiative is one file in ${view.controlRepo || "the control repo"}/.control/initiatives on origin/main. None is there yet.`
              : "Nothing here."}
          </Text>
        ) : (
          <View
            style={{
              borderRadius: 16,
              borderWidth: 1,
              borderColor: kit.hairline,
              backgroundColor: kit.bg,
              overflow: "hidden",
              // The inspector covers the table's right edge, never the rows' names.
              marginRight: inspector.showing ? INSPECTOR_WIDTH + 16 : 0,
            }}
          >
            {board.rows.map((row, at) => (
              <View
                key={`${row.initiative.home.kind}:${row.initiative.file}`}
                style={{ borderTopWidth: at === 0 ? 0 : 1, borderTopColor: kit.hairline }}
              >
                <Row
                  theme={theme}
                  row={row}
                  selected={row.due ? selectedKey === `review:${row.id}` && inspector.showing : opened === row.id}
                  onPress={() => {
                    if (row.due && holdOf(`review:${row.id}`)) {
                      setOpened(null);
                      inspector.selectHold(`review:${row.id}`);
                    } else {
                      inspector.setOpen(false);
                      setOpened((now) => (now === row.id ? null : row.id));
                    }
                  }}
                />
                {!row.due && opened === row.id ? (
                  <View style={{ padding: 14, paddingTop: 0 }}>
                    <InitiativeCard
                      theme={theme}
                      initiative={row.initiative}
                      ideas={ideasOf(view.ideas, row.id)}
                      today={view.today}
                      compact={false}
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
        <View style={[PASS_THROUGH, { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }]}>
          <InspectorPanel
            theme={theme}
            item={inspector.inspected}
            open={inspector.showing}
            onClose={() => inspector.setOpen(false)}
            onVerb={inspector.onVerb}
            onNext={holdKeys.length > 1 ? () => inspector.walk(1) : undefined}
            onOpenSession={() => void inspector.act("open", inspector.targetOf(inspector.entry))}
            width={INSPECTOR_WIDTH}
            inset={0}
            scope={inspector.root}
          />
        </View>
      </View>
      <UndoToast theme={theme} entry={inspector.undo.entry} onUndo={inspector.undo.undo} bottom={20} />
    </View>
  );
}
