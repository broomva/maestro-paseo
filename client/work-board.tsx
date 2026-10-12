// J6 and J6b, Work as five trays (BRO-3036; docs/design/next/j6-work.png and j6b-work-inspector.png): sunken
// trays with white cards floating on them, so state reads from position. Running cards wear the Undertow, Standing
// ones the quiet pulse, Needs you is the one tinted tray, and Done says who closed each. Opening a card slides J1's
// inspector in from the right over the last two trays (B3); the three to its left stay readable and the board does
// not reflow. It reads work.list, needs.list and handled.list and shows what client/work-model.ts decided; every
// verb goes through client/verbs.ts (client/use-inspector.ts).

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { useWorkspaceAsks } from "./decisions";
import { decisionAsks } from "./decisions-model";
import { type NeedEntry, needsSection } from "./feed-model";
import { errorText } from "./format";
import { useHandled, useNeeds, useWorkList } from "./hooks";
import { InspectorPanel } from "./kit/inspector";
import { PASS_THROUGH, TABULAR } from "./kit/parts";
import { kitOf } from "./kit/tokens";
import { StandingPulse, Undertow } from "./kit/undertow";
import { UndoToast } from "./kit/undo-toast";
import { ChipRow, FilterMenu } from "./stage-parts";
import { focusRing, Notice } from "./ui";
import { useInspector } from "./use-inspector";
import { useTick } from "./use-tick";
import { type Lane, type LaneCard, NO_FILTERS, scopeLine, type WorkFilters, workBoard } from "./work-model";

/** A lane's narrowest width: below five of these the board scrolls sideways. */
const LANE_MIN = 250;
const INSPECTOR_WIDTH = 480;
const TRAY_GAP = 12;

function Card({
  theme,
  card,
  selected,
  onSelect,
}: {
  theme: PluginTheme;
  card: LaneCard;
  selected: boolean;
  onSelect: () => void;
}) {
  const kit = kitOf(theme);
  const body = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${card.lane === "needs" ? "Needs you" : card.lane}: ${card.title}`}
      accessibilityState={{ selected }}
      aria-current={selected}
      testID={`work-card-${card.key}`}
      onPress={onSelect}
      style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({
        ...focusRing(theme, focused),
        borderRadius: 14,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? kit.needs : kit.hairline,
        backgroundColor: selected ? kit.needsSoft : kit.bg,
        padding: 12,
        gap: 6,
        opacity: pressed ? 0.85 : 1,
        shadowColor: "#0c101a",
        shadowOpacity: selected ? 0 : 0.05,
        shadowRadius: 3,
        shadowOffset: { width: 0, height: 1 },
      })}
    >
      {card.kicker.length > 0 ? (
        <Text
          numberOfLines={1}
          style={{ color: kit.muted, fontSize: 11.5, fontFamily: "ui-monospace, Menlo, monospace" }}
        >
          {card.kicker.join(" · ")}
        </Text>
      ) : null}
      <Text numberOfLines={3} style={{ color: kit.fg, fontSize: 14, fontWeight: "600", lineHeight: 19 }}>
        {card.title}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {card.chip ? (
          <View
            style={{
              borderRadius: 6,
              paddingHorizontal: 6,
              paddingVertical: 1,
              backgroundColor: card.chip.tone === "info" ? kit.needsSoft : kit.sunken,
            }}
          >
            <Text
              style={{
                color: card.chip.tone === "ok" ? kit.ok : card.chip.tone === "info" ? kit.needs : kit.muted,
                fontSize: 11.5,
                fontWeight: "600",
              }}
            >
              {card.chip.word}
            </Text>
          </View>
        ) : null}
        {card.standing ? <StandingPulse theme={theme} state="standing" size={13} /> : null}
        <Text
          numberOfLines={2}
          style={{ flexShrink: 1, color: card.lane === "needs" ? kit.needs : kit.fg2, fontSize: 12.5 }}
        >
          {card.line}
        </Text>
      </View>
    </Pressable>
  );
  // The Undertow is Running's alone (JE rule 9).
  return card.running ? (
    <Undertow theme={theme} state="running" radius={18}>
      {body}
    </Undertow>
  ) : (
    body
  );
}

function Tray({
  theme,
  lane,
  selectedKey,
  width,
  onSelect,
}: {
  theme: PluginTheme;
  lane: Lane;
  width: number;
  selectedKey: string | null;
  onSelect: (card: LaneCard) => void;
}) {
  const kit = kitOf(theme);
  const needs = lane.id === "needs";
  return (
    <View
      testID={`lane-${lane.id}`}
      style={{
        width,
        borderRadius: 18,
        padding: 12,
        gap: 10,
        backgroundColor: needs ? kit.needsSoft : kit.sunken,
        alignSelf: "flex-start",
      }}
    >
      <View style={{ gap: 2, paddingHorizontal: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name={lane.icon} size={15} color={needs ? kit.needs : kit.muted} />
          <Text
            accessibilityRole="header"
            style={{ color: needs ? kit.needs : kit.fg, fontSize: 15, fontWeight: "600" }}
          >
            {lane.title}
          </Text>
          <Text style={{ color: kit.muted, fontSize: 12.5, ...TABULAR }}>{lane.cards.length}</Text>
        </View>
        <Text style={{ color: kit.muted, fontSize: 12 }}>{lane.hint}</Text>
      </View>
      {lane.cards.map((card) => (
        <Card
          key={card.key}
          theme={theme}
          card={card}
          selected={selectedKey === (card.select.kind === "hold" ? card.select.key : `work:${card.select.id}`)}
          onSelect={() => onSelect(card)}
        />
      ))}
    </View>
  );
}

export function WorkBoard({
  theme,
  navigation,
  workspace,
  query,
  view,
  views,
  onView,
  onOpenWork,
}: {
  theme: PluginTheme;
  navigation?: { openAgent: (input: { agentId: string }) => void };
  workspace: string | null;
  query: string;
  view: string;
  views: readonly { id: string; label: string }[];
  onView: (view: string) => void;
  /** Work this screen cannot show (a hold or an item it has no card for): it opens in the work's own detail. */
  onOpenWork: (id: string) => void;
}) {
  const kit = kitOf(theme);
  const list = useWorkList();
  const needs = useNeeds();
  const handled = useHandled();
  const asksRead = useWorkspaceAsks();
  const now = useTick(15_000);
  const [width, setWidth] = useState(0);
  const [initiative, setInitiative] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const items = list.data?.items ?? [];
  const asks = asksRead.data ? decisionAsks(asksRead.data) : [];
  const filters: WorkFilters = { ...NO_FILTERS, workspace, initiative, provider, query };
  const board = workBoard({ items, needs: needs.data ?? null, handled: handled.data ?? null, asks, filters, now });
  const everyHold: NeedEntry[] = useMemo(
    () => needsSection(needs.data?.rows ?? [], items, asks),
    [needs.data, items, asks],
  );
  const holdKeys = board.lanes.find((lane) => lane.id === "needs")?.cards.map((card) => card.key) ?? [];
  const inspector = useInspector({ items, entries: everyHold, holdKeys, navigation, onOpenWork, now });
  const selectedKey = inspector.selection
    ? inspector.selection.kind === "hold"
      ? inspector.selection.key
      : `work:${inspector.selection.id}`
    : null;
  // The inspector covers the last two trays: as wide as they are, never wider than the design's 480.
  const trayWidth = width > 0 ? Math.max(Math.floor((width - TRAY_GAP * 4) / 5), LANE_MIN) : LANE_MIN;
  const panelWidth = Math.min(INSPECTOR_WIDTH, trayWidth * 2 + TRAY_GAP - 8);

  if (list.isPending || needs.isPending) return <ActivityIndicator color={kit.muted} />;
  return (
    <View
      ref={inspector.root as never}
      testID="work-board"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{ flex: 1, gap: 14 }}
    >
      {list.isError ? (
        <Notice theme={theme} tone="danger">
          {errorText(list.error)}
        </Notice>
      ) : null}
      {needs.isError && !needs.data ? (
        <Notice theme={theme} tone="danger">
          {`What needs you could not be read: ${errorText(needs.error)}`}
        </Notice>
      ) : null}
      {handled.isError && !handled.data ? (
        <Notice theme={theme} tone="danger">
          {`What was handled for you could not be read: ${errorText(handled.error)}`}
        </Notice>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap", zIndex: 5 }}>
        <ChipRow theme={theme} label="Work views" variant="segment" options={views} value={view} onChange={onView} />
        <FilterMenu
          theme={theme}
          label="Initiative"
          noun="any"
          options={board.initiatives.map((name) => ({ id: name, label: name }))}
          value={initiative}
          onChange={setInitiative}
        />
        <FilterMenu
          theme={theme}
          label="Provider"
          noun="any"
          options={board.providers.map((name) => ({ id: name, label: name }))}
          value={provider}
          onChange={setProvider}
        />
        <View style={{ flex: 1 }} />
        <Text style={{ color: kit.muted, fontSize: 12.5, ...TABULAR }}>{scopeLine(board)}</Text>
      </View>
      <View style={{ position: "relative", minHeight: 600 }}>
        <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ gap: TRAY_GAP }}>
          {board.lanes.map((one) => (
            <Tray
              key={one.id}
              theme={theme}
              lane={one}
              width={trayWidth}
              selectedKey={selectedKey}
              onSelect={(card) =>
                card.select.kind === "hold"
                  ? inspector.selectHold(card.select.key)
                  : inspector.selectWork(card.select.id)
              }
            />
          ))}
        </ScrollView>
        {/* From the right over Needs you and Done: the card you opened stays lit, and Esc sends it back along the path it came. */}
        <View style={[PASS_THROUGH, { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }]}>
          <InspectorPanel
            theme={theme}
            item={inspector.inspected}
            open={inspector.showing}
            onClose={() => inspector.setOpen(false)}
            onVerb={inspector.onVerb}
            onNext={inspector.selection?.kind === "hold" && holdKeys.length > 1 ? () => inspector.walk(1) : undefined}
            onOpenSession={() => void inspector.act("open", inspector.targetOf(inspector.entry))}
            width={panelWidth}
            inset={0}
            scope={inspector.root}
          />
        </View>
      </View>
      <UndoToast theme={theme} entry={inspector.undo.entry} onUndo={inspector.undo.undo} bottom={20} />
    </View>
  );
}
