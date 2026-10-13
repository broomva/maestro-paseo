// The component gallery (BRO-3034): every part of the J/M kit in every state,
// light and dark, so the parts can be dogfooded and shot before the screens
// that adopt them exist. Behind a flag: the daemon must run with
// MAESTRO_KIT_GALLERY=1 (shared/kit.ts), and the screen has no sidebar row or
// Command Center item, so it is reached by its route only. Each screen ticket
// (BRO-3035 J1, BRO-3036 J2–J9, BRO-3037 M1–M11) deletes a component's entries
// here as it adopts the component; the gallery goes when it is empty. J1 adopted
// the desktop parts (the glance tiles, the inspector panel and the undo toast on
// the desktop), so the Desktop section is gone. M1–M5 (BRO-3037) adopted the phone's
// deck, pull-up sheet, tab bar, swipe rows, undo toast and the card that rises, as the
// live screen (client/phone/shell.tsx), so the M1 shell section is gone; the states a
// real screen does not reach (a row half-swiped, the ring fallback) stay.
//
// Sections: Phone (detail header, tab bar, swipe row states, inspector cards) and
// Undertow (halo, ring fallback, dot, pulse, and what wears nothing).

import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginScreenProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { ActivityIndicator, type LayoutChangeEvent, ScrollView, Text, View } from "react-native";
import { kitGallery } from "../../shared/kit";
import { UNDO_MS } from "../../shared/undo";
import { isDarkSurface } from "../fleet-color";
import { Segmented } from "../ui";
import { BOTH_WAYS, type Directions, LEFTWARD, swipeDirections } from "./assumptions";
import { Deck, DeckHold } from "./deck";
import { DetailHeader } from "./detail-header";
import { GALLERY_DARK, GALLERY_LIGHT, INSPECTOR_SAMPLES, type RowSample, SHEET_ROWS } from "./gallery-data";
import { InspectorBody, InspectorCard } from "./inspector";
import { KIND_LOOK, verbsFor } from "./inspector-model";
import { Chip, CLIP, Dot, MONO } from "./parts";
import { PullSheet } from "./pull-sheet";
import { SwipeRow } from "./swipe-row";
import { type Tab, TabBar } from "./tab-bar";
import { kitOf } from "./tokens";
import { StandingPulse, TidepoolDot, Undertow } from "./undertow";
import { undoEntry } from "./undo-model";
import { UndoToast, useUndoToast } from "./undo-toast";

type Section = "phone" | "undertow";
type Scheme = "both" | "light" | "dark";

const SECTIONS: readonly { id: Section; label: string }[] = [
  { id: "phone", label: "Phone" },
  { id: "undertow", label: "Undertow" },
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
const _frozenNow = () => FROZEN + 3_000;

const ignore = () => undefined;

/** The screen: the gallery when the daemon's flag is on, else a line saying how to turn it on. */
const pick = <T extends string>(options: readonly { id: T }[], value: string | undefined): T | undefined =>
  options.find((option) => option.id === value)?.id;

export function KitGalleryScreen({ theme, layout, params }: PluginScreenProps) {
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
  return (
    <KitGallery
      theme={theme}
      compact={layout.compact}
      section={pick(SECTIONS, params?.section)}
      scheme={pick(SCHEMES, params?.scheme)}
      directions={swipeDirections(layout)}
    />
  );
}

export function KitGallery({
  theme,
  compact,
  section: initialSection,
  scheme: initialScheme,
  directions,
}: {
  theme: PluginTheme;
  compact: boolean;
  section?: Section;
  scheme?: Scheme;
  /** The ways the phone parts swipe here: swipeDirections(layout) (BRO-3033 fact 3). */
  directions?: Directions;
}) {
  const kit = kitOf(theme);
  const [section, setSection] = useState<Section>(initialSection ?? "phone");
  const [scheme, setScheme] = useState<Scheme>(initialScheme ?? (compact ? (kit.dark ? "dark" : "light") : "both"));
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
  return (
    <ScrollView style={{ flex: 1, backgroundColor: kit.bg }} contentContainerStyle={{ paddingBottom: 48 }}>
      {controls}
      <View style={{ flexDirection: compact ? "column" : "row", gap: 16, paddingHorizontal: compact ? 12 : 20 }}>
        {panes.map((pane) => (
          <Pane key={pane.colors.surface0} theme={pane}>
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
        backgroundColor: kit.bg,
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
        note="At rest · left swipe open (Snooze, Open) · right swipe committing (desktop) · compact native: the default verb joins the left actions (BRO-3033) · a hold (never swipes)"
      >
        <View style={{ maxWidth: 393, borderRadius: 14, overflow: "hidden", gap: 1, backgroundColor: kit.hairline }}>
          <SwipeRow
            directions={BOTH_WAYS}
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
            directions={BOTH_WAYS}
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
            directions={BOTH_WAYS}
          />
          <SwipeRow
            theme={theme}
            kind="finished"
            title="GitHub identity: PR #12 merged"
            meta="holon · on the phone: Continue is a left action"
            age="18m"
            lead={<Dot color={kit.ok} size={9} />}
            primary={{ label: "Continue", icon: "Play", onPress: ignore }}
            open={{ label: "Open", icon: "ArrowUpRight", onPress: ignore }}
            preview="open"
            directions={LEFTWARD}
          />
          <SwipeRow
            directions={BOTH_WAYS}
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
        note="This platform's look: the gradient moves on the web and holds still on iOS; reduced motion holds it still"
      >
        <View style={{ maxWidth: 320 }}>
          <Undertow theme={theme} state="running">
            {card}
          </Undertow>
        </View>
      </Group>
      <Group
        theme={theme}
        title="Halo — iOS"
        note="The same gradients under experimental_backgroundImage, held still: animating them on iOS is untested (BRO-3033 fact 5)"
      >
        <View style={{ maxWidth: 320 }}>
          <Undertow theme={theme} state="running" look="gradient" still>
            {card}
          </Undertow>
        </View>
      </Group>
      <Group
        theme={theme}
        title="Halo — still ring"
        note="The fallback: Android (unchecked) and any host without gradients"
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
            {
              label: "Running row, still ring (fallback)",
              mark: <TidepoolDot theme={theme} state="running" look="ring" />,
            },
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
