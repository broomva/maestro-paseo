// J7, Health (BRO-3036; docs/design/next/j7-health.png): one sentence on how the fleet is; four tiles that say
// why (the ticks of the last 24 h, the sessions as one bar, the schedules as a number, the conductor and its
// lanes); the open notices, each with what closes it and its one verb; every schedule's own recent runs; and the
// sessions that want a look. It draws what client/health-model.ts decided and reads only what the other screens
// read: notices.list (the Health tab's badge, the Feed's section and this list are the same rows), fleet.get,
// loops.get and work.list. A notice that is work opens in J4's inspector; Snooze goes through client/verbs.ts.

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import type { NoticeRow } from "../shared/notices";
import { useFleet, useScopeReads } from "./fleet";
import type { Cell } from "./fleet-cockpit-model";
import { stateTone, stateWord } from "./fleet-cockpit-model";
import { cellStyle } from "./fleet-health";
import { errorText } from "./format";
import { activeText, type BarSegment, type HealthModel, healthModel, type Tone, whereText } from "./health-model";
import { noticeIntent } from "./home-model";
import { useLoop, useNotices, useWorkList } from "./hooks";
import { requestIntent } from "./intent";
import { InspectorPanel } from "./kit/inspector";
import { Dot, PASS_THROUGH, Pill, TABULAR } from "./kit/parts";
import { kitOf } from "./kit/tokens";
import { StandingPulse } from "./kit/undertow";
import { UndoToast } from "./kit/undo-toast";
import { useLoops } from "./loops";
import { settingsOpener } from "./settings-link";
import { ChipRow } from "./stage-parts";
import { focusRing, Notice } from "./ui";
import { useInspector } from "./use-inspector";
import { useTick } from "./use-tick";

const INSPECTOR_WIDTH = 480;

function toneColor(kit: ReturnType<typeof kitOf>, tone: Tone | "success"): string {
  return tone === "ok" || tone === "success"
    ? kit.ok
    : tone === "warn"
      ? kit.warn
      : tone === "danger"
        ? kit.danger
        : tone === "info"
          ? kit.blue
          : kit.muted;
}

/** A small run of cells: one per tick or run, newest on the right, each with its own words. */
function Cells({ theme, cells, height = 14 }: { theme: PluginTheme; cells: readonly Cell[]; height?: number }) {
  return (
    <View style={{ flexDirection: "row", gap: 3, flex: 1 }}>
      {cells.map((cell, at) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: cells have no identity but their place
          key={at}
          accessible
          accessibilityRole="image"
          accessibilityLabel={cell.label}
          style={cellStyle(theme, cell.kind, height)}
        />
      ))}
    </View>
  );
}

function Panel({
  theme,
  icon,
  title,
  aside,
  children,
}: {
  theme: PluginTheme;
  icon: string;
  title: string;
  aside?: string;
  children: React.ReactNode;
}) {
  const kit = kitOf(theme);
  return (
    <View
      style={{
        flex: 1,
        minWidth: 240,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: kit.hairline,
        backgroundColor: kit.bg,
        padding: 16,
        gap: 10,
        shadowColor: "#0c101a",
        shadowOpacity: 0.05,
        shadowRadius: 3,
        shadowOffset: { width: 0, height: 1 },
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name={icon} size={15} color={kit.ok} />
        <Text style={{ flex: 1, color: kit.fg, fontSize: 13, fontWeight: "600" }}>{title}</Text>
        {aside ? <Text style={{ color: kit.muted, fontSize: 12, ...TABULAR }}>{aside}</Text> : null}
      </View>
      {children}
    </View>
  );
}

function TicksTile({ theme, model }: { theme: PluginTheme; model: HealthModel }) {
  const kit = kitOf(theme);
  return (
    <Panel theme={theme} icon="Activity" title="Fleet ticks · 24 h" aside={model.ticks.line}>
      {model.ticks.rows.map((row) => (
        <View key={row.scope} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text
            numberOfLines={1}
            style={{ width: 54, color: kit.muted, fontSize: 11.5, fontFamily: "ui-monospace, Menlo, monospace" }}
          >
            {row.scope}
          </Text>
          <Cells theme={theme} cells={row.cells} height={16} />
        </View>
      ))}
      {model.ticks.rows.length === 0 ? (
        <Text style={{ color: kit.muted, fontSize: 12.5 }}>No fleet scope is read.</Text>
      ) : null}
      <View style={{ flexDirection: "row", gap: 12 }}>
        {(["passed", "failed", "empty"] as const).map((kind) => (
          <View key={kind} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <View style={{ ...cellStyle(theme, kind, 8), flex: undefined, width: 8, borderRadius: 2 }} />
            <Text style={{ color: kit.muted, fontSize: 11 }}>{kind === "empty" ? "next" : kind}</Text>
          </View>
        ))}
      </View>
    </Panel>
  );
}

function SessionsTile({ theme, model }: { theme: PluginTheme; model: HealthModel }) {
  const kit = kitOf(theme);
  const { segments, seen } = model.sessions;
  const segmentColor = (segment: BarSegment) => (segment.id === "idle" ? kit.border : toneColor(kit, segment.tone));
  return (
    <Panel theme={theme} icon="MonitorSmartphone" title="Sessions" aside={`${seen} seen`}>
      <View
        accessible
        accessibilityLabel={`Sessions: ${segments.map((s) => `${s.count} ${s.label.toLowerCase()}`).join(", ")}`}
        style={{
          flexDirection: "row",
          height: 8,
          borderRadius: 4,
          overflow: "hidden",
          backgroundColor: kit.sunken,
          gap: 1,
        }}
      >
        {segments
          .filter((segment) => segment.count > 0)
          .map((segment) => (
            <View key={segment.id} style={{ flex: segment.count, backgroundColor: segmentColor(segment) }} />
          ))}
      </View>
      {segments.map((segment) => (
        <View key={segment.id} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Dot color={segmentColor(segment)} size={7} />
          <Text style={{ flex: 1, color: kit.fg2, fontSize: 12.5 }}>{segment.label}</Text>
          {segment.note ? <Text style={{ color: kit.muted, fontSize: 12 }}>{segment.note}</Text> : null}
          <Text
            style={{ minWidth: 18, textAlign: "right", color: kit.fg, fontSize: 12.5, fontWeight: "600", ...TABULAR }}
          >
            {segment.count}
          </Text>
        </View>
      ))}
    </Panel>
  );
}

function SchedulesTile({ theme, model }: { theme: PluginTheme; model: HealthModel }) {
  const kit = kitOf(theme);
  return (
    <Panel theme={theme} icon="CalendarClock" title="Schedules and loops">
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 6 }}>
        <Text style={{ color: kit.fg, fontSize: 30, lineHeight: 34, fontWeight: "600", ...TABULAR }}>
          {model.schedules.total}
        </Text>
        <Text style={{ color: kit.muted, fontSize: 12, paddingBottom: 3 }}>tracked</Text>
      </View>
      {model.schedules.breakdown ? (
        <Text style={{ color: kit.fg2, fontSize: 12.5 }}>{model.schedules.breakdown}</Text>
      ) : null}
      {model.schedules.next ? <Text style={{ color: kit.muted, fontSize: 12 }}>{model.schedules.next}</Text> : null}
    </Panel>
  );
}

function ConductorTile({ theme, model }: { theme: PluginTheme; model: HealthModel }) {
  const kit = kitOf(theme);
  return (
    <Panel theme={theme} icon="Radio" title="Conductor and lanes">
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {model.conductor.on ? (
          <StandingPulse theme={theme} state="standing" size={15} />
        ) : (
          <Dot color={kit.muted} size={8} />
        )}
        <Text style={{ flex: 1, color: kit.fg, fontSize: 13, fontWeight: "600" }}>{model.conductor.cadence}</Text>
      </View>
      <Text style={{ color: kit.fg2, fontSize: 12.5, lineHeight: 17 }}>{model.conductor.words}</Text>
      <Text style={{ color: kit.muted, fontSize: 12 }}>
        Each lane's liveness shows here once lanes.get exists; until then no lane is drawn.
      </Text>
    </Panel>
  );
}

const NOTICE_ICON: Record<NoticeRow["kind"], string> = {
  stuck: "CircleAlert",
  quiet: "Hourglass",
  schedule: "CalendarClock",
  loop: "Repeat",
  initiative: "Target",
};

function Notices({
  theme,
  rows,
  onOpen,
  onVerb,
}: {
  theme: PluginTheme;
  rows: readonly NoticeRow[];
  onOpen: (row: NoticeRow) => void;
  onVerb: (row: NoticeRow) => void;
}) {
  const kit = kitOf(theme);
  return (
    <View style={{ borderRadius: 16, borderWidth: 1, borderColor: kit.hairline, backgroundColor: kit.bg }}>
      {rows.map((row, at) => (
        <View
          key={row.key}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            padding: 12,
            borderTopWidth: at === 0 ? 0 : 1,
            borderTopColor: kit.hairline,
          }}
        >
          <Icon
            name={NOTICE_ICON[row.kind]}
            size={16}
            color={row.kind === "stuck" ? kit.danger : row.kind === "quiet" ? kit.warn : kit.muted}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Notice: ${row.title}`}
            onPress={() => onOpen(row)}
            style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({
              ...focusRing(theme, focused),
              flex: 1,
              gap: 2,
              borderRadius: 8,
              opacity: pressed ? 0.8 : 1,
            })}
          >
            <Text
              numberOfLines={1}
              style={{ color: kit.muted, fontSize: 11.5, fontFamily: "ui-monospace, Menlo, monospace" }}
            >
              {[row.scope, row.ticket, row.kind].filter(Boolean).join(" · ")}
            </Text>
            <Text numberOfLines={2} style={{ color: kit.fg, fontSize: 14, fontWeight: "600" }}>
              {row.title}
            </Text>
            <Text numberOfLines={1} style={{ color: kit.muted, fontSize: 12 }}>
              closes when {row.closesWhen.map((close) => close.when).join(", or ")}
            </Text>
          </Pressable>
          <Pill
            theme={theme}
            label={row.verb.label}
            height={30}
            onPress={() => onVerb(row)}
            accessibilityLabel={`${row.verb.label}: ${row.title}`}
          />
        </View>
      ))}
    </View>
  );
}

export function HealthScreen({
  theme,
  navigation,
  view,
  views,
  onView,
  onOpenWork,
}: {
  theme: PluginTheme;
  navigation?: { openAgent: (input: { agentId: string }) => void };
  view: string;
  views: readonly { id: string; label: string }[];
  onView: (view: string) => void;
  onOpenWork: (id: string) => void;
}) {
  const kit = kitOf(theme);
  const fleet = useFleet(null);
  const reads = useScopeReads(fleet.data, true, fleet.isError && fleet.data ? errorText(fleet.error) : null);
  const loops = useLoops();
  const notices = useNotices();
  const list = useWorkList();
  const loop = useLoop();
  const now = useTick(15_000);
  const items = list.data?.items ?? [];
  const model = healthModel({
    reads,
    loops: loops.data ?? null,
    notices: notices.data ?? null,
    items,
    loop: loop.data ?? null,
    now,
  });
  const inspector = useInspector({ items, entries: [], holdKeys: [], navigation, onOpenWork, now });
  const openSettings = settingsOpener();
  const rows = notices.data?.rows ?? [];
  const open = (row: NoticeRow) => {
    if (row.link.kind === "work") inspector.selectWork(row.link.id);
    else {
      const intent = noticeIntent(row);
      if (intent) requestIntent(intent);
    }
  };
  const verb = (row: NoticeRow) => {
    if (row.verb.id === "snooze") void inspector.act("snooze", { notice: { key: row.key } });
    else open(row);
  };
  if (fleet.isPending && notices.isPending) return <ActivityIndicator color={kit.muted} />;
  const tone = toneColor(kit, model.verdict.tone);
  return (
    <View ref={inspector.root as never} testID="health-screen" style={{ flex: 1, gap: 14 }}>
      {fleet.isError && !fleet.data ? (
        <Notice theme={theme} tone="danger">
          {`The fleet could not be read: ${errorText(fleet.error)}`}
        </Notice>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap", zIndex: 5 }}>
        <ChipRow theme={theme} label="Health views" variant="segment" options={views} value={view} onChange={onView} />
        {model.header.mode ? (
          <View
            style={{
              borderRadius: 9999,
              paddingHorizontal: 10,
              height: 26,
              justifyContent: "center",
              backgroundColor: kit.warnSoft,
            }}
          >
            <Text style={{ color: kit.warn, fontSize: 12.5, fontWeight: "600" }}>{model.header.mode}</Text>
          </View>
        ) : null}
        {model.header.cadence ? <Text style={{ color: kit.muted, fontSize: 12.5 }}>{model.header.cadence}</Text> : null}
        <View style={{ flex: 1 }} />
        {openSettings ? (
          <Pressable accessibilityRole="link" accessibilityLabel="Settings: Loop and fleet" onPress={openSettings}>
            <Text style={{ color: kit.info, fontSize: 12.5 }}>Settings › Loop and fleet →</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <View
          accessibilityRole="header"
          style={{
            borderRadius: 9999,
            paddingHorizontal: 10,
            height: 26,
            justifyContent: "center",
            backgroundColor: kit.warnSoft,
          }}
        >
          <Text style={{ color: tone, fontSize: 12.5, fontWeight: "600" }}>{model.verdict.title}</Text>
        </View>
        <Text style={{ flex: 1, minWidth: 240, color: kit.fg2, fontSize: 13.5 }}>{model.verdict.sentence}</Text>
      </View>
      <View style={{ flexDirection: "row", gap: 14, flexWrap: "wrap" }}>
        <TicksTile theme={theme} model={model} />
        <SessionsTile theme={theme} model={model} />
        <SchedulesTile theme={theme} model={model} />
        <ConductorTile theme={theme} model={model} />
      </View>
      <View style={{ flexDirection: "row", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
        <View style={{ flex: 3, minWidth: 420, gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
            <Text accessibilityRole="header" style={{ color: kit.fg, fontSize: 15, fontWeight: "600" }}>
              Open notices
            </Text>
            <Text style={{ color: kit.fg2, fontSize: 12.5, ...TABULAR }}>{rows.length}</Text>
            <Text style={{ color: kit.muted, fontSize: 12.5 }}>· each closes when its source does</Text>
          </View>
          {rows.length === 0 ? (
            <Text style={{ color: kit.muted, fontSize: 13 }}>Nothing is asking for a look.</Text>
          ) : (
            <Notices theme={theme} rows={rows} onOpen={open} onVerb={verb} />
          )}
        </View>
        <View style={{ flex: 2, minWidth: 340, gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
            <Text accessibilityRole="header" style={{ color: kit.fg, fontSize: 15, fontWeight: "600" }}>
              Schedules and loops
            </Text>
            <Text style={{ color: kit.fg2, fontSize: 12.5, ...TABULAR }}>{model.schedulesList.length}</Text>
            <Text style={{ color: kit.muted, fontSize: 12.5 }}>· past 24 h, then next</Text>
          </View>
          <View style={{ borderRadius: 16, borderWidth: 1, borderColor: kit.hairline, backgroundColor: kit.bg }}>
            {model.schedulesList.map((row, at) => (
              <View
                key={row.key}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  padding: 10,
                  borderTopWidth: at === 0 ? 0 : 1,
                  borderTopColor: kit.hairline,
                }}
              >
                <View style={{ flex: 1, gap: 1 }}>
                  <Text
                    numberOfLines={1}
                    style={{ color: kit.fg, fontSize: 12.5, fontFamily: "ui-monospace, Menlo, monospace" }}
                  >
                    {row.name}
                  </Text>
                  <Text numberOfLines={1} style={{ color: kit.muted, fontSize: 11.5 }}>
                    {row.where}
                  </Text>
                </View>
                <View style={{ width: 150 }}>
                  <Cells theme={theme} cells={row.cells} height={10} />
                </View>
                <Text
                  style={{
                    width: 58,
                    textAlign: "right",
                    color: toneColor(kit, row.status.tone),
                    fontSize: 12,
                    fontWeight: "600",
                  }}
                >
                  {row.status.word}
                </Text>
              </View>
            ))}
            {model.schedulesList.length === 0 ? (
              <Text style={{ color: kit.muted, fontSize: 12.5, padding: 12 }}>
                No loop or schedule is registered or observed.
              </Text>
            ) : null}
          </View>
        </View>
      </View>
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
          <Text accessibilityRole="header" style={{ color: kit.fg, fontSize: 15, fontWeight: "600" }}>
            Sessions
          </Text>
          <Text style={{ color: kit.fg2, fontSize: 12.5, ...TABULAR }}>
            {model.sessionRows.shown} of {model.sessionRows.total}
          </Text>
          <Text style={{ color: kit.muted, fontSize: 12.5 }}>
            · the ones that need a look or are not adopted; the rest are in Work
          </Text>
        </View>
        <View style={{ borderRadius: 16, borderWidth: 1, borderColor: kit.hairline, backgroundColor: kit.bg }}>
          {model.sessionRows.rows.map((row, at) => (
            <View
              key={row.id}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                padding: 12,
                borderTopWidth: at === 0 ? 0 : 1,
                borderTopColor: kit.hairline,
              }}
            >
              <View style={{ flex: 2, gap: 1 }}>
                <Text
                  numberOfLines={1}
                  style={{ color: kit.fg, fontSize: 13, fontFamily: "ui-monospace, Menlo, monospace" }}
                >
                  {row.name ?? row.short}
                </Text>
                <Text numberOfLines={1} style={{ color: kit.muted, fontSize: 11.5 }}>
                  {row.short} · {row.kind ?? "session"}
                </Text>
              </View>
              <Text style={{ width: 64, color: toneColor(kit, stateTone(row.state)), fontSize: 12 }}>
                {stateWord(row.state)}
              </Text>
              <Text
                numberOfLines={1}
                style={{ flex: 3, color: kit.fg2, fontSize: 12, fontFamily: "ui-monospace, Menlo, monospace" }}
              >
                {whereText(row)}
              </Text>
              <Text style={{ width: 60, color: kit.muted, fontSize: 12 }}>{activeText(row, now)}</Text>
              <Text numberOfLines={1} style={{ flex: 3, color: kit.fg2, fontSize: 12.5 }}>
                {model.sessionRows.would(row)}
              </Text>
            </View>
          ))}
          {model.sessionRows.rows.length === 0 ? (
            <Text style={{ color: kit.muted, fontSize: 12.5, padding: 12 }}>
              Every session the fleet reads is adopted and calm.
            </Text>
          ) : null}
        </View>
      </View>
      <View style={[PASS_THROUGH, { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }]}>
        <InspectorPanel
          theme={theme}
          item={inspector.inspected}
          open={inspector.showing}
          onClose={() => inspector.setOpen(false)}
          onVerb={inspector.onVerb}
          onOpenSession={() => void inspector.act("open", inspector.targetOf(inspector.entry))}
          width={INSPECTOR_WIDTH}
          scope={inspector.root}
        />
      </View>
      <UndoToast theme={theme} entry={inspector.undo.entry} onUndo={inspector.undo.undo} bottom={20} />
    </View>
  );
}
