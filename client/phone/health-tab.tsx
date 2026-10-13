// The phone's Health tab (M7, BRO-3037; docs/design/next/m7-health-mobile.png). The deck holds the notices that
// need a look, stuck first, each with its evidence and what closes it; the sheet is the fleet at a glance (the
// desktop's four tiles) over the schedules and loops, with the views Health reaches (Initiatives, M8). It draws
// what client/phone/tabs-model.ts decided and hands every press up; a verb is sent by the screen through the one
// adapter (client/verbs.ts), so a notice's Snooze has the same 8 s undo as everywhere.

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useState } from "react";
import { Animated, Pressable, Text, View } from "react-native";
import type { WorkItem } from "../../shared/contracts";
import type { NoticeKind } from "../../shared/notices";
import { useFleet, useScopeReads } from "../fleet";
import { errorText } from "../format";
import { type HealthModel, healthModel } from "../health-model";
import type { HealthRow } from "../home-model";
import { useLoop, useNotices } from "../hooks";
import type { Directions } from "../kit/assumptions";
import { DeckHold } from "../kit/deck";
import { GlanceTile } from "../kit/glance-tile";
import { Dot, Pill } from "../kit/parts";
import { SwipeRow } from "../kit/swipe-row";
import { kitOf } from "../kit/tokens";
import { useLoops } from "../loops";
import { useKeyboardLift } from "./keyboard";
import { fleetTiles, type NoticeAct, noticeAct, noticePrimary } from "./tabs-model";

const NOTICE_ICON: Record<NoticeKind, string> = {
  stuck: "CircleAlert",
  quiet: "Hourglass",
  schedule: "CalendarClock",
  loop: "Repeat",
  initiative: "Target",
};
const NOTICE_WORD: Record<NoticeKind, string> = {
  stuck: "Stuck",
  quiet: "Quiet",
  schedule: "Schedule",
  loop: "Loop",
  initiative: "Initiatives",
};

/** A notice on the deck: the fact, what closes it, and its one verb beside Open session. */
export function NoticeDeckCard({
  theme,
  row,
  age,
  waiting,
  hasSession,
  onSession,
  onVerb,
}: {
  theme: PluginTheme;
  row: HealthRow;
  age: string;
  /** What waits out its undo window on this notice ("Snooze 4h · applies in 6 s"): its verb cannot be pressed again. */
  waiting: string | null;
  hasSession: boolean;
  onSession: () => void;
  onVerb: (act: NoticeAct) => void;
}) {
  const kit = kitOf(theme);
  const { notice } = row;
  const act = noticeAct(notice, row.item);
  const stuck = notice.kind === "stuck";
  return (
    <DeckHold
      theme={theme}
      icon={NOTICE_ICON[notice.kind]}
      kicker={[NOTICE_WORD[notice.kind], notice.scope, ...(notice.ticket ? [notice.ticket] : [])]}
      age={age || undefined}
      title={notice.title}
      summary={notice.detail}
      verbs={[
        ...(hasSession ? [{ label: "Open session", onPress: onSession }] : []),
        {
          label: noticePrimary(notice, row.item),
          primary: true,
          disabled: waiting !== null,
          onPress: () => onVerb(act),
        },
      ]}
    >
      {notice.closesWhen.length > 0 ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "flex-start",
            gap: 8,
            backgroundColor: kit.sunken,
            borderRadius: 10,
            padding: 10,
          }}
        >
          <Icon name="CircleDot" size={15} color={stuck ? kit.danger : kit.muted} />
          <Text style={{ flex: 1, color: kit.fg2, fontSize: 13.5, lineHeight: 19 }}>
            {`Closes when ${notice.closesWhen.map((close) => close.when).join(", or ")}`}
          </Text>
        </View>
      ) : null}
      {waiting ? (
        <Text accessibilityLiveRegion="polite" style={{ color: kit.info, fontSize: 13, fontWeight: "600" }}>
          {waiting}
        </Text>
      ) : null}
    </DeckHold>
  );
}

/** Our own sheet for the words Unblock sends (M7): over the deck, not Paseo's Modal, so the notice stays visible above it. */
export function UnblockSheet({
  theme,
  title,
  safeBottom,
  onSend,
  onCancel,
}: {
  theme: PluginTheme;
  title: string;
  safeBottom: number;
  /** Resolves true when the prompt was sent: only then does the sheet close and the deck move on. */
  onSend: (words: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const kit = kitOf(theme);
  const lift = useKeyboardLift(safeBottom);
  const [words, setWords] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <View
      testID="unblock-sheet"
      style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, justifyContent: "flex-end" }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel unblock"
        onPress={onCancel}
        style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: "rgba(12,16,26,0.35)" }}
      />
      <Animated.View
        style={{
          marginBottom: Animated.add(lift, safeBottom),
          backgroundColor: kit.bg,
          borderTopLeftRadius: 22,
          borderTopRightRadius: 22,
          padding: 16,
          gap: 12,
        }}
      >
        <Text accessibilityRole="header" style={{ color: kit.fg, fontSize: 17, fontWeight: "600" }}>
          {`Unblock ${title}`}
        </Text>
        <Text style={{ color: kit.muted, fontSize: 13.5, lineHeight: 19 }}>
          What you write is sent into its session. Leave it empty to start the work again from its brief if the session
          is gone. The card stays until the session moves.
        </Text>
        <TextInput
          accessibilityLabel={`A prompt for the session of ${title}`}
          value={words}
          onChangeText={setWords}
          editable={!busy}
          multiline
          autoFocus
          placeholder="A prompt for the session (optional)"
          placeholderTextColor={kit.muted}
          style={{
            minHeight: 84,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: kit.hairline,
            backgroundColor: kit.sunken,
            color: kit.fg,
            fontSize: 15,
            paddingHorizontal: 12,
            paddingVertical: 10,
          }}
        />
        <View style={{ flexDirection: "row", gap: 10 }}>
          <Pill theme={theme} label="Cancel" height={52} grow onPress={onCancel} />
          <Pill
            theme={theme}
            label="Send"
            primary
            height={52}
            grow
            busy={busy}
            onPress={() => {
              setBusy(true);
              void onSend(words.trim()).finally(() => setBusy(false));
            }}
          />
        </View>
      </Animated.View>
    </View>
  );
}

function Tiles({ theme, model, onTile }: { theme: PluginTheme; model: HealthModel; onTile: (id: string) => void }) {
  const tiles = fleetTiles(model);
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
      {tiles.map((tile) => (
        <View key={tile.id} style={{ width: "48%", flexGrow: 1 }}>
          <GlanceTile
            theme={theme}
            compact
            icon={tile.icon}
            label={tile.label}
            value={tile.value}
            unit={tile.unit}
            line={tile.line}
            tone={tile.tone}
            onPress={() => onTile(tile.id)}
          />
        </View>
      ))}
    </View>
  );
}

const toneColor = (kit: ReturnType<typeof kitOf>, tone: string) =>
  tone === "ok"
    ? kit.ok
    : tone === "danger"
      ? kit.danger
      : tone === "warn"
        ? kit.warn
        : tone === "info"
          ? kit.blue
          : kit.muted;

/** What the Health sheet lists: the tiles, the schedules (a swipe opens the log), and the views Health reaches. */
export function FleetSheet({
  theme,
  model,
  directions,
  due,
  onTile,
  onLog,
  onPage,
}: {
  theme: PluginTheme;
  model: HealthModel;
  directions: Directions;
  /** needs.list's due reviews: the Initiatives row's number. */
  due: number;
  onTile: (id: string) => void;
  onLog: () => void;
  onPage: (page: "initiatives" | "fleet" | "timeline" | "loops") => void;
}) {
  const kit = kitOf(theme);
  const pages = [
    { id: "initiatives" as const, label: "Initiatives", icon: "Target", note: due > 0 ? `${due} review due` : "" },
    { id: "fleet" as const, label: "Fleet", icon: "Activity", note: "" },
    { id: "timeline" as const, label: "Timeline", icon: "GanttChart", note: "" },
    { id: "loops" as const, label: "Loops", icon: "Repeat", note: "" },
  ];
  return (
    <>
      {model.header.mode || model.header.cadence ? (
        <Text style={{ color: kit.warn, fontSize: 13, fontWeight: "600" }}>
          {[model.header.mode?.split(" · ")[0], model.header.cadence].filter(Boolean).join(" · ")}
        </Text>
      ) : null}
      <Tiles theme={theme} model={model} onTile={onTile} />
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4 }}>
          <Text accessibilityRole="header" style={{ color: kit.fg, fontSize: 15, fontWeight: "600" }}>
            Schedules and loops
          </Text>
          <Text style={{ color: kit.muted, fontSize: 13 }}>{model.schedulesList.length}</Text>
        </View>
        <View style={{ borderRadius: 14, overflow: "hidden", gap: 1, backgroundColor: kit.hairline }}>
          {model.schedulesList.map((row) => (
            <SwipeRow
              key={row.key}
              theme={theme}
              directions={directions}
              kind="schedule"
              title={row.name}
              meta={row.where}
              age={row.status.word}
              lead={<Dot color={toneColor(kit, row.status.tone)} size={9} />}
              onPress={onLog}
              open={{ label: "Open log", icon: "FileText", onPress: onLog }}
            />
          ))}
          {model.schedulesList.length === 0 ? (
            <Text style={{ color: kit.muted, fontSize: 13.5, padding: 14, backgroundColor: kit.bg }}>
              No loop or schedule is registered or observed.
            </Text>
          ) : null}
        </View>
      </View>
      <View style={{ gap: 6 }}>
        <Text
          accessibilityRole="header"
          style={{ color: kit.fg, fontSize: 15, fontWeight: "600", paddingHorizontal: 4 }}
        >
          More
        </Text>
        <View style={{ borderRadius: 14, overflow: "hidden", gap: 1, backgroundColor: kit.hairline }}>
          {pages.map((page) => (
            <Pressable
              key={page.id}
              accessibilityRole="button"
              accessibilityLabel={page.note ? `${page.label}, ${page.note}` : page.label}
              onPress={() => onPage(page.id)}
              style={{
                minHeight: 52,
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                paddingHorizontal: 14,
                backgroundColor: kit.bg,
              }}
            >
              <Icon name={page.icon} size={17} color={kit.muted} />
              <Text style={{ flex: 1, color: kit.fg, fontSize: 15 }}>{page.label}</Text>
              {page.note ? <Text style={{ color: kit.warn, fontSize: 13, fontWeight: "600" }}>{page.note}</Text> : null}
              <Icon name="ChevronRight" size={16} color={kit.muted} />
            </Pressable>
          ))}
        </View>
      </View>
    </>
  );
}

/**
 * Reads what the Health sheet draws, only while the Health tab is showing (the fleet, loops and loop reads poll, and
 * the other tabs do not need them), and hands the model and the lane count to `render`. A read that failed is
 * said in the model (its tile says "not read"), never read as none; `lanes` is null when the fleet was not read.
 */
export function HealthHost({
  items,
  workFailed,
  now,
  render,
}: {
  items: readonly WorkItem[];
  workFailed: boolean;
  now: number;
  render: (model: HealthModel, lanes: number | null) => ReactNode;
}) {
  const fleet = useFleet(null);
  const reads = useScopeReads(fleet.data, true, fleet.isError && fleet.data ? errorText(fleet.error) : null);
  const loops = useLoops();
  const notices = useNotices();
  const loop = useLoop();
  const model = healthModel({
    reads,
    loops: loops.data ?? null,
    notices: notices.data ?? null,
    noticesFailed: notices.isError,
    workFailed,
    items,
    loop: loop.data ?? null,
    now,
  });
  return <>{render(model, fleet.data ? fleet.data.scopes.length : null)}</>;
}
