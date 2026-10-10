// The component gallery (BRO-3034): every part of the J/M kit in every state,
// light and dark, so the parts can be dogfooded and shot before the screens
// that adopt them exist. Behind a flag: the daemon must run with
// MAESTRO_KIT_GALLERY=1 (shared/kit.ts), and the screen has no sidebar row or
// Command Center item, so it is reached by its route only. Each screen ticket
// (BRO-3035 J1, BRO-3036 J2–J9, BRO-3037 M1–M11) deletes a component's entries
// here as it adopts the component; the gallery goes when it is empty.
//
// Sections: Desktop (glance tiles, the inspector per kind with both bar looks,
// the undo toast), Phone (detail header, tab bar, swipe row states, inspector
// cards), Undertow (halo, ring fallback, dot, pulse, and what wears nothing),
// and M1, the live phone shell: deck, pull-up sheet with the tab bar riding
// it, swipe rows, undo toast, and the card that rises from the deck.

import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginScreenProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { ActivityIndicator, type LayoutChangeEvent, ScrollView, Text, View } from "react-native";
import { kitGallery } from "../../shared/kit";
import { UNDO_MS } from "../../shared/undo";
import { isDarkSurface } from "../fleet-color";
import { Segmented } from "../ui";
import type { FrostLook } from "./assumptions";
import { Deck, DeckHold } from "./deck";
import { DetailHeader } from "./detail-header";
import { GALLERY_DARK, GALLERY_LIGHT, INSPECTOR_SAMPLES, type RowSample, SHEET_ROWS } from "./gallery-data";
import { GlanceTile } from "./glance-tile";
import { InspectorBody, InspectorCard, type InspectorItem, InspectorPanel } from "./inspector";
import { KIND_LOOK } from "./inspector-model";
import { Chip, Dot, MONO, Pill } from "./parts";
import { PullSheet } from "./pull-sheet";
import { SwipeRow } from "./swipe-row";
import { type Tab, TabBar } from "./tab-bar";
import { kitOf } from "./tokens";
import { StandingPulse, TidepoolDot, Undertow } from "./undertow";
import { undoEntry } from "./undo-model";
import { UndoToast, useUndoToast } from "./undo-toast";

type Section = "desktop" | "phone" | "undertow" | "m1";
type Scheme = "both" | "light" | "dark";

const SECTIONS: readonly { id: Section; label: string }[] = [
  { id: "desktop", label: "Desktop" },
  { id: "phone", label: "Phone" },
  { id: "undertow", label: "Undertow" },
  { id: "m1", label: "M1 shell" },
];
const SCHEMES: readonly { id: Scheme; label: string }[] = [
  { id: "both", label: "Both" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

const TABS: readonly Tab[] = [
  { id: "feed", label: "Feed", icon: "Inbox", badge: 4, badgeTone: "needs" },
  { id: "decisions", label: "Decisions", icon: "MessagesSquare", badge: 2, badgeTone: "needs" },
  { id: "work", label: "Work", icon: "LayoutList" },
  { id: "health", label: "Health", icon: "Activity", badge: 4, badgeTone: "warn" },
];

/** A clock frozen 3 s into an 8 s window, so a still toast reads "5 s" in every shot. */
const FROZEN = 1_000_000;
const frozenNow = () => FROZEN + 3_000;

const ignore = () => undefined;

/** The screen: the gallery when the daemon's flag is on, else a line saying how to turn it on. */
export function KitGalleryScreen({ theme, layout }: PluginScreenProps) {
  const read = useRpc(kitGallery);
  const flag = useQuery({ queryKey: ["maestro", "kit", "gallery"], queryFn: () => read({}) });
  const kit = kitOf(theme);
  if (flag.isPending) return <ActivityIndicator style={{ margin: 24 }} color={kit.muted} />;
  if (!flag.data?.enabled)
    return (
      <View style={{ flex: 1, padding: 24, backgroundColor: kit.bg }}>
        <Text style={{ color: kit.fg2, fontSize: 14 }}>
          The component gallery is off. Start the daemon with MAESTRO_KIT_GALLERY=1 to show it.
        </Text>
      </View>
    );
  return <KitGallery theme={theme} compact={layout.compact} />;
}

export function KitGallery({ theme, compact }: { theme: PluginTheme; compact: boolean }) {
  const kit = kitOf(theme);
  const [section, setSection] = useState<Section>(compact ? "m1" : "desktop");
  const [scheme, setScheme] = useState<Scheme>(compact ? (kit.dark ? "dark" : "light") : "both");
  const activeDark = isDarkSurface(theme.colors.surface0);
  // The active Paseo theme stands for its own appearance; broomva's palette for the other.
  const light = activeDark ? GALLERY_LIGHT : theme;
  const dark = activeDark ? theme : GALLERY_DARK;
  const panes = scheme === "both" ? [light, dark] : scheme === "light" ? [light] : [dark];
  const controls = (
    <View style={{ gap: 10, padding: compact ? 12 : 20, paddingBottom: 8 }}>
      <Text accessibilityRole="header" style={{ color: kit.fg, fontSize: 18, fontWeight: "600" }}>
        Component kit
      </Text>
      <Text style={{ color: kit.muted, fontSize: 12.5 }}>
        BRO-3034 · every J/M part in every state · undo window {UNDO_MS / 1000} s
      </Text>
      <View style={{ flexDirection: compact ? "column" : "row", gap: 8 }}>
        <Segmented
          theme={theme}
          label="Section"
          options={SECTIONS}
          value={section}
          onChange={setSection}
          compact={compact}
        />
        <Segmented
          theme={theme}
          label="Appearance"
          options={SCHEMES}
          value={scheme}
          onChange={setScheme}
          compact={compact}
        />
      </View>
    </View>
  );
  if (section === "m1")
    return (
      <View style={{ flex: 1, backgroundColor: kit.bg }}>
        {controls}
        <View style={{ flex: 1, flexDirection: "row", gap: 16, padding: compact ? 0 : 16, justifyContent: "center" }}>
          {panes.map((pane) => (
            <PhoneShell key={pane.colors.surface0} theme={pane} framed={!compact} />
          ))}
        </View>
      </View>
    );
  return (
    <ScrollView style={{ flex: 1, backgroundColor: kit.bg }} contentContainerStyle={{ paddingBottom: 48 }}>
      {controls}
      <View style={{ flexDirection: compact ? "column" : "row", gap: 16, paddingHorizontal: compact ? 12 : 20 }}>
        {panes.map((pane) => (
          <Pane key={pane.colors.surface0} theme={pane}>
            {section === "desktop" ? <DesktopParts theme={pane} /> : null}
            {section === "phone" ? <PhoneParts theme={pane} /> : null}
            {section === "undertow" ? <UndertowParts theme={pane} /> : null}
          </Pane>
        ))}
      </View>
    </ScrollView>
  );
}

function Pane({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  const kit = kitOf(theme);
  return (
    <View
      testID={kit.dark ? "gallery-pane-dark" : "gallery-pane-light"}
      style={{
        flex: 1,
        minWidth: 0,
        backgroundColor: kit.dark ? kit.bg : "#f3f4f6",
        borderRadius: 16,
        borderWidth: 1,
        borderColor: kit.border,
        padding: 16,
        gap: 18,
      }}
    >
      <Text style={{ color: kit.muted, fontSize: 12, fontWeight: "600" }}>{kit.dark ? "Dark" : "Light"}</Text>
      {children}
    </View>
  );
}

function Group({
  theme,
  title,
  note,
  children,
}: {
  theme: PluginTheme;
  title: string;
  note?: string;
  children: ReactNode;
}) {
  const kit = kitOf(theme);
  return (
    <View style={{ gap: 10 }}>
      <View style={{ gap: 2 }}>
        <Text accessibilityRole="header" style={{ color: kit.fg, fontSize: 14, fontWeight: "600" }}>
          {title}
        </Text>
        {note ? <Text style={{ color: kit.muted, fontSize: 12 }}>{note}</Text> : null}
      </View>
      {children}
    </View>
  );
}

function DesktopParts({ theme }: { theme: PluginTheme }) {
  const kit = kitOf(theme);
  const [kind, setKind] = useState<InspectorItem["kind"]>("approval");
  const [open, setOpen] = useState(true);
  const [frost, setFrost] = useState<FrostLook>("frost");
  const [undone, setUndone] = useState<string | null>(null);
  const toast = useUndoToast((receipt) => setUndone(receipt));
  const [stage, setStage] = useState(0);
  const item = INSPECTOR_SAMPLES.find((sample) => sample.kind === kind) ?? INSPECTOR_SAMPLES[0];
  return (
    <>
      <Group theme={theme} title="Glance tiles" note="Tinted only for Needs you (Tidepool) or late and stranded (warn)">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
          <GlanceTile
            theme={theme}
            icon="Hand"
            label="Needs you"
            value="4"
            unit="holds"
            line="1 approval · 1 owner step · 2 asks"
            tone="needs"
            onPress={ignore}
          />
          <GlanceTile theme={theme} icon="Loader" label="Running" value="3" unit="sessions" onPress={ignore}>
            {["sri · STI-3684 turn 4", "holon turn 1 · gh api"].map((line) => (
              <View key={line} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <TidepoolDot theme={theme} state="running" size={11} />
                <Text numberOfLines={1} style={{ color: kit.fg2, fontSize: 11.5 }}>
                  {line}
                </Text>
              </View>
            ))}
          </GlanceTile>
          <GlanceTile
            theme={theme}
            icon="CheckCheck"
            label="Handled today"
            value="22"
            unit="closed for you"
            line="4 closed by you · 3 asks answered"
            onPress={ignore}
          />
          <GlanceTile
            theme={theme}
            icon="Clock"
            label="Waiting to land"
            value="27"
            unit="answers"
            line="stranded: no session took them"
            tone="warn"
            onPress={ignore}
          />
          <GlanceTile
            theme={theme}
            icon="Timer"
            label="Unsupervised today"
            value="4h 32m"
            line="selected · next wake 18 min"
            selected
            onPress={ignore}
          />
        </View>
      </Group>

      <Group
        theme={theme}
        title="Inspector"
        note="Every kind; slides in from the right; Esc or × sends it back. Bar: frost (web) or solid (iOS, A2)"
      >
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Segmented
            theme={theme}
            label="Kind"
            options={INSPECTOR_SAMPLES.map((sample) => ({ id: sample.kind, label: KIND_LOOK[sample.kind].label }))}
            value={kind}
            onChange={(next) => {
              setKind(next);
              setOpen(true);
            }}
          />
          <Segmented
            theme={theme}
            label="Bar"
            options={[
              { id: "frost", label: "Frost" },
              { id: "solid", label: "Solid" },
            ]}
            value={frost}
            onChange={setFrost}
          />
          <Pill theme={theme} label={open ? "Close inspector" : "Open inspector"} onPress={() => setOpen(!open)} />
        </View>
        <View
          onLayout={(event: LayoutChangeEvent) => setStage(event.nativeEvent.layout.width)}
          style={{
            height: 660,
            borderRadius: 14,
            overflow: "hidden",
            backgroundColor: kit.dark ? kit.sunken : "#e9ebee",
          }}
        >
          <View style={{ padding: 16, gap: 8, width: Math.max(0, stage - Math.min(480, stage - 32) - 32) }}>
            {INSPECTOR_SAMPLES.map((sample) => (
              <View
                key={sample.key}
                style={{
                  backgroundColor: kit.bg,
                  borderRadius: 12,
                  borderWidth: sample.kind === kind && open ? 2 : 1,
                  borderColor: sample.kind === kind && open ? kit.needs : kit.hairline,
                  padding: 10,
                }}
              >
                <Text numberOfLines={2} style={{ color: kit.fg, fontSize: 12.5, fontWeight: "600" }}>
                  {sample.title}
                </Text>
              </View>
            ))}
          </View>
          {stage > 0 ? (
            <InspectorPanel
              theme={theme}
              item={item}
              open={open}
              width={Math.min(480, stage - 32)}
              frost={frost}
              onClose={() => setOpen(false)}
              onNext={() => {
                const at = INSPECTOR_SAMPLES.findIndex((sample) => sample.kind === kind);
                setKind(INSPECTOR_SAMPLES[(at + 1) % INSPECTOR_SAMPLES.length].kind);
              }}
              onVerb={(id) => {
                if (id === "allow" || id === "answer" || id === "unblock")
                  toast.show(
                    undoEntry(
                      `receipt:${item.key}:${id}`,
                      `${KIND_LOOK[item.kind].label} · ${id}`,
                      Date.now(),
                      undefined,
                      "applies in",
                    ),
                  );
              }}
            />
          ) : null}
          <UndoToast theme={theme} entry={toast.entry} onUndo={toast.undo} />
        </View>
        {undone ? <Text style={{ color: kit.muted, fontSize: 12 }}>Undone: {undone}</Text> : null}
      </Group>

      <Group
        theme={theme}
        title="Undo toast"
        note={`The ${UNDO_MS / 1000} s window (B4). Still states use a frozen clock; the live one is the inspector's verb above`}
      >
        {[
          undoEntry("r1", "Allowed #933", FROZEN, FROZEN + UNDO_MS, "merges in"),
          undoEntry("r2", "Continued · A1 adopted", FROZEN, FROZEN + UNDO_MS),
        ].map((entry) => (
          <View
            key={entry.receipt}
            style={{ height: 66, borderRadius: 12, backgroundColor: kit.dark ? kit.sunken : "#e9ebee" }}
          >
            <UndoToast theme={theme} entry={entry} onUndo={ignore} now={frozenNow} bottom={8} />
          </View>
        ))}
      </Group>
    </>
  );
}

function PhoneParts({ theme }: { theme: PluginTheme }) {
  const kit = kitOf(theme);
  const [active, setActive] = useState("feed");
  const lead = (row: RowSample) =>
    row.state === "running" ? (
      <TidepoolDot theme={theme} state="running" />
    ) : row.state === "standing" ? (
      <StandingPulse theme={theme} state="standing" />
    ) : (
      <Dot color={row.kind === "finished" ? kit.ok : row.kind === "ask" ? kit.needs : kit.danger} size={9} />
    );
  const sample = SHEET_ROWS[1].rows[0];
  return (
    <>
      <Group theme={theme} title="Detail header" note="Grabber, round close, Kind · n of N with segments, ⋯">
        {[
          { kind: "Approval", index: 0 },
          { kind: "Ask", index: 2 },
          { kind: "Notice", index: 3 },
        ].map((state) => (
          <View key={state.kind} style={{ maxWidth: 393, borderRadius: 22, overflow: "hidden" }}>
            <DetailHeader
              theme={theme}
              kind={state.kind}
              index={state.index}
              total={4}
              onClose={ignore}
              onMore={ignore}
            />
          </View>
        ))}
      </Group>
      <Group theme={theme} title="Tab bar" note="Rides on the sheet's top edge; counts Tidepool, Health's warn">
        <View style={{ maxWidth: 369 }}>
          <TabBar theme={theme} tabs={TABS} active={active} onSelect={setActive} onNew={ignore} />
        </View>
      </Group>
      <Group
        theme={theme}
        title="Swipe row"
        note="At rest · left swipe open (Snooze, Open) · right swipe committing · a hold (never swipes)"
      >
        <View style={{ maxWidth: 393, borderRadius: 14, overflow: "hidden", gap: 1, backgroundColor: kit.hairline }}>
          <SwipeRow
            theme={theme}
            kind={sample.kind}
            title={sample.title}
            meta={sample.meta}
            age={sample.age}
            lead={lead(sample)}
            snooze={{ label: "Snooze 4h", icon: "AlarmClock", onPress: ignore }}
            open={{ label: "Open", icon: "ArrowUpRight", onPress: ignore }}
          />
          <SwipeRow
            theme={theme}
            kind={sample.kind}
            title={sample.title}
            meta={sample.meta}
            age={sample.age}
            lead={lead(sample)}
            snooze={{ label: "Snooze 4h", icon: "AlarmClock", onPress: ignore }}
            open={{ label: "Open", icon: "ArrowUpRight", onPress: ignore }}
            preview="open"
          />
          <SwipeRow
            theme={theme}
            kind="finished"
            title="GitHub identity: PR #12 merged"
            meta="holon · waits for Continue"
            age="18m"
            lead={<Dot color={kit.ok} size={9} />}
            primary={{ label: "Continue", icon: "Play", onPress: ignore }}
            open={{ label: "Open", icon: "ArrowUpRight", onPress: ignore }}
            preview="commit"
          />
          <SwipeRow
            theme={theme}
            kind="ask"
            title="Install the three headless mods?"
            meta="claude-code-mods · ask"
            age="2h"
            lead={<Dot color={kit.needs} size={9} />}
            primary={{ label: "Answer", icon: "Check", onPress: ignore }}
            open={{ label: "Open", icon: "ArrowUpRight", onPress: ignore }}
            preview="open"
          />
        </View>
      </Group>
      <Group theme={theme} title="Inspector card" note="The phone's inspector body per kind; verbs 52 pt, bar solid">
        {INSPECTOR_SAMPLES.slice(0, 3).map((item) => (
          <View key={item.key} style={{ maxWidth: 393, borderRadius: 22, overflow: "hidden", backgroundColor: kit.bg }}>
            <DetailHeader
              theme={theme}
              kind={KIND_LOOK[item.kind].label}
              index={0}
              total={4}
              onClose={ignore}
              onMore={ignore}
            />
            <View style={{ padding: 20 }}>
              <InspectorBody theme={theme} item={item} compact />
            </View>
          </View>
        ))}
      </Group>
    </>
  );
}

function SampleCard({
  theme,
  kicker,
  title,
  line,
}: {
  theme: PluginTheme;
  kicker: string;
  title: string;
  line: string;
}) {
  const kit = kitOf(theme);
  return (
    <View style={{ paddingVertical: 10, paddingHorizontal: 12, gap: 4 }}>
      <Text style={{ color: kit.muted, fontSize: 11, fontFamily: MONO }}>{kicker}</Text>
      <Text style={{ color: kit.fg, fontSize: 13, fontWeight: "600" }}>{title}</Text>
      <Text style={{ color: kit.fg2, fontSize: 11.5 }}>{line}</Text>
    </View>
  );
}

function UndertowParts({ theme }: { theme: PluginTheme }) {
  const kit = kitOf(theme);
  const plain = (children: ReactNode, ring?: string) => (
    <View
      style={{
        borderRadius: 16,
        borderWidth: ring ? 1.5 : 1,
        borderColor: ring ?? kit.hairline,
        backgroundColor: kit.bg,
      }}
    >
      {children}
    </View>
  );
  const card = (
    <SampleCard
      theme={theme}
      kicker="sri · STI-3684"
      title="Provable Outlook + fetch-by-id reads"
      line="Turn 4 · bun test · 40s"
    />
  );
  return (
    <>
      <Group
        theme={theme}
        title="Halo — running"
        note="This platform's look (gradient on the web; reduced motion holds it still)"
      >
        <View style={{ maxWidth: 320 }}>
          <Undertow theme={theme} state="running">
            {card}
          </Undertow>
        </View>
      </Group>
      <Group
        theme={theme}
        title="Halo — still ring"
        note="The iOS fallback until BRO-3033 confirms gradients (assumption A1)"
      >
        <View style={{ maxWidth: 320 }}>
          <Undertow theme={theme} state="running" look="ring">
            {card}
          </Undertow>
        </View>
      </Group>
      <Group
        theme={theme}
        title="Wears nothing"
        note="Standing, queued and Needs you cards: the Undertow marks Running only"
      >
        <View style={{ maxWidth: 320, gap: 8 }}>
          <Undertow theme={theme} state="standing">
            {plain(
              <SampleCard
                theme={theme}
                kicker="sri · STI-3617"
                title="Eve turn latency (P0)"
                line="standing · quiet 808 min"
              />,
            )}
          </Undertow>
          <Undertow theme={theme} state="queued">
            {plain(
              <SampleCard
                theme={theme}
                kicker="maestro-paseo · BRO-2936"
                title="PR on the card, live turn"
                line="queued · the broomva lane takes it next"
              />,
            )}
          </Undertow>
          <Undertow theme={theme} state="review">
            {plain(
              <SampleCard
                theme={theme}
                kicker="workspace#933 · auto_merge"
                title="Allow merging workspace#933?"
                line="Needs you stays Tidepool, never the halo"
              />,
              kit.needsLine,
            )}
          </Undertow>
        </View>
      </Group>
      <Group
        theme={theme}
        title="Dot and pulse"
        note="Running row: the tidepool dot · standing: the quiet pulse · anything else: nothing"
      >
        <View style={{ gap: 10 }}>
          {[
            { label: "Running row", mark: <TidepoolDot theme={theme} state="running" /> },
            { label: "Running row, still ring (A1)", mark: <TidepoolDot theme={theme} state="running" look="ring" /> },
            { label: "Standing", mark: <StandingPulse theme={theme} state="standing" /> },
            { label: "Queued (nothing)", mark: <TidepoolDot theme={theme} state="queued" /> },
          ].map((row) => (
            <View key={row.label} style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 18 }}>
              <View style={{ width: 18, alignItems: "center" }}>{row.mark}</View>
              <Text style={{ color: kit.fg2, fontSize: 13 }}>{row.label}</Text>
            </View>
          ))}
        </View>
      </Group>
    </>
  );
}

/** M1, live: the deck, the sheet carrying the tab bar, swipe rows, the toast, and the card that rises. */
function PhoneShell({ theme, framed }: { theme: PluginTheme; framed: boolean }) {
  const kit = kitOf(theme);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [index, setIndex] = useState(0);
  const [tab, setTab] = useState("feed");
  const [detail, setDetail] = useState(false);
  const [gone, setGone] = useState<string[]>([]);
  const toast = useUndoToast((receipt) => setGone((keys) => keys.filter((key) => `receipt:${key}` !== receipt)));
  const holds = INSPECTOR_SAMPLES.slice(0, 3).concat(INSPECTOR_SAMPLES[4]);
  const act = (done: string, then: string | undefined, key: string) =>
    toast.show(undoEntry(`receipt:${key}`, done, Date.now(), undefined, then));
  const header = (
    <View style={{ flexDirection: "row", gap: 6 }}>
      <Chip theme={theme} label="All" lead={null} />
      <Chip theme={theme} label="Present" lead={<Dot color={kit.ok} />} />
    </View>
  );
  return (
    <View
      testID="phone-shell"
      onLayout={(event: LayoutChangeEvent) => setSize(event.nativeEvent.layout)}
      style={{
        flex: framed ? 0 : 1,
        width: framed ? 393 : undefined,
        height: framed ? 760 : undefined,
        alignSelf: framed ? "flex-start" : "stretch",
        borderRadius: framed ? 28 : 0,
        borderWidth: framed ? 1 : 0,
        borderColor: kit.border,
        overflow: "hidden",
        backgroundColor: kit.bg,
      }}
    >
      <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
        <Deck
          theme={theme}
          title="Needs you"
          trailing={header}
          items={holds}
          index={index}
          onIndexChange={setIndex}
          keyOf={(item) => item.key}
          renderItem={(item) => (
            <DeckHold
              theme={theme}
              icon={KIND_LOOK[item.kind].icon}
              kicker={[KIND_LOOK[item.kind].label, ...item.kicker]}
              age={item.age}
              title={item.title}
              summary={item.summary ?? (item.kind === "ask" ? item.why : undefined)}
              onDetails={() => setDetail(true)}
              verbs={
                item.kind === "approval"
                  ? [
                      { label: "Deny…", onPress: ignore },
                      {
                        label: "Allow merge",
                        primary: true,
                        onPress: () => act("Allowed #933", "merges in", item.key),
                      },
                    ]
                  : [
                      {
                        label: item.kind === "notice" ? "Open session" : "Skip",
                        onPress: () => setIndex(Math.min(index + 1, holds.length - 1)),
                      },
                      {
                        label: item.kind === "notice" ? "Unblock…" : "Answer",
                        primary: true,
                        onPress: () => act(`${KIND_LOOK[item.kind].label} answered`, "applies in", item.key),
                      },
                    ]
              }
            >
              {item.kind === "approval" ? (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {item.evidence.map((evidence) => (
                    <View
                      key={evidence.label}
                      style={{
                        flexBasis: "46%",
                        flexGrow: 1,
                        backgroundColor: kit.sunken,
                        borderRadius: 10,
                        padding: 10,
                        gap: 2,
                      }}
                    >
                      <Text style={{ color: kit.muted, fontSize: 11.5 }}>{evidence.label}</Text>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                        <Dot color={evidence.tone === "warn" ? kit.warn : kit.ok} />
                        <Text style={{ color: kit.fg, fontSize: 15, fontWeight: "600" }}>{evidence.value}</Text>
                      </View>
                    </View>
                  ))}
                </View>
              ) : null}
            </DeckHold>
          )}
        />
      </View>
      {size.height > 0 ? (
        <PullSheet
          theme={theme}
          height={size.height}
          top={64}
          tabBar={<TabBar theme={theme} tabs={TABS} active={tab} onSelect={setTab} onNew={ignore} />}
          title="Everything else"
          counts={
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              <Chip theme={theme} label="3 running" lead={<TidepoolDot theme={theme} state="running" size={11} />} />
              <Chip theme={theme} label="1 finished" />
              <Chip theme={theme} label="4 health" />
              <Chip theme={theme} label="22 handled" />
            </View>
          }
          toast={(place) => (
            <UndoToast theme={theme} entry={toast.entry} onUndo={toast.undo} bottom={place.bottom} lift={place.lift} />
          )}
        >
          {SHEET_ROWS.map((group) => (
            <View key={group.title} style={{ gap: 6 }}>
              <Text style={{ color: kit.fg, fontSize: 15, fontWeight: "600", paddingHorizontal: 4 }}>
                {group.title}
              </Text>
              <View style={{ borderRadius: 14, overflow: "hidden", gap: 1, backgroundColor: kit.hairline }}>
                {group.rows
                  .filter((row) => !gone.includes(row.key))
                  .map((row) => (
                    <SwipeRow
                      key={row.key}
                      theme={theme}
                      kind={row.kind}
                      title={row.title}
                      meta={row.meta}
                      age={row.age}
                      lead={
                        row.state === "running" ? (
                          <TidepoolDot theme={theme} state="running" />
                        ) : row.state === "standing" ? (
                          <StandingPulse theme={theme} state="standing" />
                        ) : (
                          <Dot
                            color={row.kind === "finished" ? kit.ok : row.kind === "ask" ? kit.needs : kit.danger}
                            size={9}
                          />
                        )
                      }
                      primary={
                        row.kind === "finished" || row.kind === "notice"
                          ? {
                              label: row.kind === "finished" ? "Continue" : "Done",
                              icon: "Check",
                              onPress: () => {
                                setGone((keys) => [...keys, row.key]);
                                act(row.kind === "finished" ? "Continued" : "Done", undefined, row.key);
                              },
                            }
                          : undefined
                      }
                      snooze={
                        row.kind === "notice" ? { label: "Snooze 4h", icon: "AlarmClock", onPress: ignore } : undefined
                      }
                      open={{ label: "Open", icon: "ArrowUpRight", onPress: ignore }}
                    />
                  ))}
              </View>
            </View>
          ))}
        </PullSheet>
      ) : null}
      {size.height > 0 ? (
        <InspectorCard
          theme={theme}
          item={holds[index]}
          index={index}
          total={holds.length}
          open={detail}
          height={size.height}
          onClose={() => setDetail(false)}
          onMore={ignore}
          onIndexChange={setIndex}
          onVerb={(id) => {
            setDetail(false);
            if (id !== "deny" && id !== "skip" && id !== "open")
              act(`${KIND_LOOK[holds[index].kind].label} · ${id}`, "applies in", holds[index].key);
          }}
        />
      ) : null}
    </View>
  );
}
