// The inspector (JE rule "One inspector for every item"; J1, J2–J4, J6b, J8 on
// the desktop, M2–M4 on the phone): one container, a body per kind (approval,
// ask, notice, work item, initiative review) and an action bar of that kind's
// verbs (client/kit/inspector-model.ts).
//
// Desktop: InspectorPanel, a View inside Maestro's screen that slides in from
// the right with Animated.spring (J1: over the rail; J6b: over the right-hand
// lanes, B3) and goes back on Esc or its close button. Its action bar is
// frosted with backdropFilter on the web and solid elsewhere (assumption A2).
// Phone: InspectorCard, a card that rises from the deck under the detail
// header; swipe it down to close and sideways for the next hold, its verbs
// 52 pt and pinned at the bottom, its bar solid (no blur on iOS).

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Animated, PanResponder, Platform, Pressable, ScrollView, Text, View, type ViewStyle } from "react-native";
import { tint } from "../fleet-color";
import { useReducedMotion, webAria } from "../ui";
import { type FrostLook, frostLook, keysHint, nativeDriver } from "./assumptions";
import { DECK, deckRelease } from "./deck-model";
import { DetailHeader } from "./detail-header";
import { type InspectorKind, inspectorHidden, KIND_LOOK, type VerbSpec, verbsFor } from "./inspector-model";
import { Dot, Kicker, MONO, Pill, SectionLabel, TABULAR } from "./parts";
import { type Kit, kitOf } from "./tokens";
import { TidepoolDot } from "./undertow";

export type EvidenceTone = "ok" | "warn" | "danger" | "muted";

export interface Evidence {
  label: string;
  value: string;
  note?: string;
  tone: EvidenceTone;
}

export interface HistoryLine {
  age: string;
  verb: string;
  detail: string;
  tone?: EvidenceTone | "needs";
}

export interface SessionRef {
  name: string;
  status: string;
  /** The session's work state; a running one wears the tidepool dot. */
  state: string;
}

export interface Choice {
  id: string;
  label: string;
  note?: string;
  recommended?: boolean;
}

export interface LogLine {
  at: string;
  text: string;
  tone?: "danger" | "warn";
}

interface Common {
  key: string;
  kicker: readonly string[];
  age?: string;
  title: string;
  summary?: string;
  /** The primary verb's own words ("Allow merge"); the kind's otherwise. */
  primaryLabel?: string;
  session?: SessionRef;
  history?: readonly HistoryLine[];
}

export type InspectorItem =
  | (Common & { kind: "approval"; action: string; evidence: readonly Evidence[]; after: readonly string[] })
  | (Common & {
      kind: "ask";
      why?: string;
      options: readonly Choice[];
      chosen?: string;
      /** The silent default: what happens if you say nothing, and how far its countdown has run (0 to 1). */
      fallback?: { line: string; elapsed: number };
    })
  | (Common & {
      kind: "notice";
      log: readonly LogLine[];
      closesWhen: readonly { when: string; becomes: string }[];
      note?: string;
    })
  | (Common & {
      kind: "work";
      state: string;
      lifecycle: readonly { label: string; at?: string; done: boolean }[];
    })
  | (Common & { kind: "review"; late?: string; options: readonly Choice[]; chosen?: string });

const toneColor = (kit: Kit, tone: EvidenceTone | "needs" | undefined) =>
  tone === "ok"
    ? kit.ok
    : tone === "warn"
      ? kit.warn
      : tone === "danger"
        ? kit.danger
        : tone === "needs"
          ? kit.needs
          : kit.muted;

function EvidenceGrid({
  theme,
  evidence,
  columns,
}: {
  theme: PluginTheme;
  evidence: readonly Evidence[];
  columns: number;
}) {
  const kit = kitOf(theme);
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {evidence.map((item) => (
        <View
          key={item.label}
          accessible
          accessibilityLabel={`${item.label}: ${item.value}${item.note ? `, ${item.note}` : ""}`}
          style={{
            flexBasis: columns === 2 ? "47%" : "22%",
            flexGrow: 1,
            backgroundColor: kit.sunken,
            borderRadius: 10,
            paddingVertical: 10,
            paddingHorizontal: 12,
            gap: 3,
          }}
        >
          <Text style={{ color: kit.muted, fontSize: 11.5 }}>{item.label}</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Dot color={toneColor(kit, item.tone)} />
            <Text style={{ color: kit.fg, fontSize: 15, fontWeight: "600", ...TABULAR }}>{item.value}</Text>
          </View>
          {item.note ? <Text style={{ color: kit.muted, fontSize: 11 }}>{item.note}</Text> : null}
        </View>
      ))}
    </View>
  );
}

function Choices({
  theme,
  options,
  chosen,
  onChoose,
}: {
  theme: PluginTheme;
  options: readonly Choice[];
  chosen: string | undefined;
  onChoose: (id: string) => void;
}) {
  const kit = kitOf(theme);
  return (
    <View accessibilityRole="radiogroup" style={{ gap: 8 }}>
      {options.map((option) => {
        const on = option.id === chosen;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            {...webAria({ "aria-checked": on })}
            accessibilityLabel={`${option.label}${option.recommended ? ", recommended" : ""}`}
            onPress={() => onChoose(option.id)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              borderRadius: 12,
              borderWidth: on ? 1.5 : 1,
              borderColor: on ? kit.info : kit.border,
              backgroundColor: on ? tint(kit.info, kit.dark ? 0.16 : 0.07) : kit.bg,
              paddingVertical: 10,
              paddingHorizontal: 14,
            }}
          >
            <Icon name={on ? "CircleCheck" : "Circle"} size={20} color={on ? kit.info : kit.muted} />
            <View style={{ flex: 1, gap: 2 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={{ color: kit.fg, fontSize: 14.5, fontWeight: "600" }}>{option.label}</Text>
                {option.recommended ? (
                  <Text style={{ color: kit.ok, fontSize: 11.5, fontWeight: "600" }}>Rec.</Text>
                ) : null}
              </View>
              {option.note ? <Text style={{ color: kit.muted, fontSize: 12.5 }}>{option.note}</Text> : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

function SessionLine({ theme, session, onOpen }: { theme: PluginTheme; session: SessionRef; onOpen?: () => void }) {
  const kit = kitOf(theme);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Session ${session.name}, ${session.status}`}
      onPress={onOpen}
      disabled={!onOpen}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: kit.border,
        paddingVertical: 10,
        paddingHorizontal: 12,
      }}
    >
      <TidepoolDot theme={theme} state={session.state} />
      {session.state === "running" ? null : <Dot color={kit.needs} size={8} />}
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={{ color: kit.fg, fontSize: 13, fontFamily: MONO }}>{session.name}</Text>
        <Text style={{ color: kit.muted, fontSize: 12 }}>{session.status}</Text>
      </View>
      {onOpen ? <Icon name="ArrowUpRight" size={15} color={kit.muted} /> : null}
    </Pressable>
  );
}

function History({ theme, lines }: { theme: PluginTheme; lines: readonly HistoryLine[] }) {
  const kit = kitOf(theme);
  return (
    <View style={{ gap: 8 }}>
      {lines.map((line) => (
        <View key={`${line.age}-${line.verb}`} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Dot color={toneColor(kit, line.tone)} size={6} />
          <Text style={{ width: 30, color: kit.muted, fontSize: 11.5, fontFamily: MONO }}>{line.age}</Text>
          <Text style={{ color: kit.fg, fontSize: 12.5, fontWeight: "600" }}>{line.verb}</Text>
          <Text numberOfLines={1} style={{ flex: 1, color: kit.fg2, fontSize: 12.5 }}>
            {line.detail}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** Lines with the ↳ of "what happens next". */
function After({ theme, lines }: { theme: PluginTheme; lines: readonly string[] }) {
  const kit = kitOf(theme);
  return (
    <View style={{ gap: 6 }}>
      {lines.map((line) => (
        <View key={line} style={{ flexDirection: "row", gap: 8 }}>
          <Icon name="CornerDownRight" size={14} color={kit.muted} />
          <Text style={{ flex: 1, color: kit.fg2, fontSize: 13.5, lineHeight: 19 }}>{line}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The body for the item's kind. `compact` is the phone's 393 pt column: two
 * evidence tiles a row, capped section labels. `onOpenSession` opens the
 * session; `onChoose` reports an ask's or review's choice.
 */
export function InspectorBody({
  theme,
  item,
  compact = false,
  onOpenSession,
  onChoose,
}: {
  theme: PluginTheme;
  item: InspectorItem;
  compact?: boolean;
  onOpenSession?: () => void;
  onChoose?: (id: string) => void;
}) {
  const kit = kitOf(theme);
  const look = KIND_LOOK[item.kind];
  const initialChoice = item.kind === "ask" || item.kind === "review" ? item.chosen : undefined;
  const [chosen, setChosen] = useState(initialChoice);
  useEffect(() => setChosen(initialChoice), [initialChoice]);
  const choose = (id: string) => {
    setChosen(id);
    onChoose?.(id);
  };
  const iconColor = item.kind === "notice" ? kit.danger : item.kind === "work" ? kit.muted : kit.needs;
  const sections: ReactNode[] = [];
  const label = (text: string) => (
    <SectionLabel key={`label-${text}`} theme={theme} caps={compact}>
      {text}
    </SectionLabel>
  );
  switch (item.kind) {
    case "approval":
      sections.push(
        <View
          key="action"
          style={{
            backgroundColor: kit.sunken,
            borderRadius: 10,
            paddingVertical: 10,
            paddingHorizontal: 12,
            flexDirection: "row",
            gap: 8,
          }}
        >
          {compact ? null : <Text style={{ color: kit.muted, fontSize: 12.5 }}>Action</Text>}
          <Text selectable style={{ flex: 1, color: kit.fg, fontSize: 12.5, fontFamily: MONO }}>
            {item.action}
          </Text>
        </View>,
        <EvidenceGrid key="evidence" theme={theme} evidence={item.evidence} columns={compact ? 2 : 4} />,
        label("After you allow"),
        <After key="after" theme={theme} lines={item.after} />,
      );
      break;
    case "ask":
      if (item.why)
        sections.push(
          <Text key="why" style={{ color: kit.fg2, fontSize: 14, lineHeight: 20 }}>
            {item.why}
          </Text>,
        );
      sections.push(<Choices key="choices" theme={theme} options={item.options} chosen={chosen} onChoose={choose} />);
      if (item.fallback)
        sections.push(
          <View key="fallback" style={{ gap: 8 }}>
            <View accessible={false} style={{ height: 3, borderRadius: 2, backgroundColor: tint(kit.fg, 0.08) }}>
              <View
                style={{
                  width: `${Math.round(Math.min(1, Math.max(0, item.fallback.elapsed)) * 100)}%`,
                  height: 3,
                  borderRadius: 2,
                  backgroundColor: kit.info,
                }}
              />
            </View>
            <Text style={{ color: kit.muted, fontSize: 12.5 }}>{item.fallback.line}</Text>
          </View>,
        );
      break;
    case "notice":
      sections.push(
        <View
          key="log"
          style={{ backgroundColor: "#0c101a", borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, gap: 4 }}
        >
          {item.log.map((line) => (
            <View key={`${line.at}-${line.text}`} style={{ flexDirection: "row", gap: 10 }}>
              <Text style={{ color: "#818693", fontSize: 11.5, fontFamily: MONO }}>{line.at}</Text>
              <Text
                style={{
                  flex: 1,
                  fontSize: 11.5,
                  fontFamily: MONO,
                  color: line.tone === "danger" ? "#f2777a" : line.tone === "warn" ? "#e6c06a" : "#e6e8ec",
                }}
              >
                {line.text}
              </Text>
            </View>
          ))}
        </View>,
        label("Closes when"),
        <View key="closes" style={{ borderRadius: 12, borderWidth: 1, borderColor: kit.border }}>
          {item.closesWhen.map((close, at) => (
            <View
              key={close.when}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingVertical: 10,
                paddingHorizontal: 12,
                borderTopWidth: at === 0 ? 0 : 1,
                borderTopColor: kit.border,
              }}
            >
              <Icon name="CircleDashed" size={14} color={kit.muted} />
              <Text style={{ flex: 1, color: kit.fg, fontSize: 13.5 }}>{close.when}</Text>
              <Text style={{ color: kit.muted, fontSize: 12.5 }}>→ {close.becomes}</Text>
            </View>
          ))}
        </View>,
      );
      if (item.note)
        sections.push(
          <View
            key="note"
            style={{ flexDirection: "row", gap: 8, backgroundColor: kit.warnSoft, borderRadius: 10, padding: 12 }}
          >
            <Icon name="Info" size={15} color={kit.warn} />
            <Text style={{ flex: 1, color: kit.fg2, fontSize: 13, lineHeight: 18 }}>{item.note}</Text>
          </View>,
        );
      break;
    case "work":
      sections.push(
        label("Lifecycle"),
        <View key="lifecycle" style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {item.lifecycle.map((step) => (
            <View
              key={step.label}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                height: 28,
                paddingHorizontal: 10,
                borderRadius: 9999,
                backgroundColor: step.done ? kit.sunken : "transparent",
                borderWidth: step.done ? 0 : 1,
                borderColor: kit.border,
              }}
            >
              <Dot color={step.done ? kit.ok : kit.muted} size={6} />
              <Text style={{ color: step.done ? kit.fg : kit.muted, fontSize: 12.5 }}>{step.label}</Text>
              {step.at ? <Text style={{ color: kit.muted, fontSize: 11.5, ...TABULAR }}>{step.at}</Text> : null}
            </View>
          ))}
        </View>,
      );
      break;
    case "review":
      if (item.late)
        sections.push(
          <View
            key="late"
            style={{
              flexDirection: "row",
              gap: 8,
              alignItems: "center",
              backgroundColor: kit.warnSoft,
              borderRadius: 10,
              padding: 10,
            }}
          >
            <Icon name="Clock" size={15} color={kit.warn} />
            <Text style={{ color: kit.warn, fontSize: 13, fontWeight: "600" }}>{item.late}</Text>
          </View>,
        );
      sections.push(<Choices key="choices" theme={theme} options={item.options} chosen={chosen} onChoose={choose} />);
      break;
  }
  if (item.session)
    sections.push(
      label("Session"),
      <SessionLine key="session" theme={theme} session={item.session} onOpen={onOpenSession} />,
    );
  if (item.history?.length)
    sections.push(label("History"), <History key="history" theme={theme} lines={item.history} />);
  return (
    <View style={{ gap: compact ? 14 : 16 }}>
      <Kicker
        theme={theme}
        icon={look.icon}
        iconColor={iconColor}
        parts={compact ? item.kicker : [look.label, ...item.kicker]}
        age={item.age}
      />
      <Text
        accessibilityRole="header"
        style={{
          color: kit.fg,
          fontSize: compact ? 23 : 22,
          lineHeight: compact ? 29 : 28,
          fontWeight: "600",
          letterSpacing: -0.3,
        }}
      >
        {item.title}
      </Text>
      {item.summary ? <Text style={{ color: kit.fg2, fontSize: 14.5, lineHeight: 21 }}>{item.summary}</Text> : null}
      {sections}
    </View>
  );
}

/** The action bar's fill: frost on the web (backdropFilter passes through react-native-web), solid elsewhere. */
function barStyle(kit: Kit, look: FrostLook): ViewStyle {
  if (look === "solid") return { backgroundColor: kit.bg };
  return {
    backgroundColor: kit.dark ? "rgba(6, 8, 16, 0.72)" : "rgba(255, 255, 255, 0.77)",
    backdropFilter: "blur(18px) saturate(1.4)",
  } as unknown as ViewStyle;
}

/** The verbs, secondary first, primary last; `onVerb` gets the verb's id. */
function Verbs({
  theme,
  verbs,
  onVerb,
  height,
  grow,
  keys,
}: {
  theme: PluginTheme;
  verbs: readonly VerbSpec[];
  onVerb: (id: string) => void;
  height: number;
  grow: boolean;
  /** Key caps beside the verbs: the desktop's bar only; the phone card has no keys to press. */
  keys: boolean;
}) {
  return (
    <>
      {verbs.map((verb) => (
        <Pill
          key={verb.id}
          theme={theme}
          label={verb.label}
          primary={verb.primary}
          keyCap={keys ? verb.key : undefined}
          height={height}
          grow={grow}
          onPress={() => onVerb(verb.id)}
        />
      ))}
    </>
  );
}

/** The width a sideways swipe on the phone card is measured against: the 393 pt column less its margins. */
const CARD_SWIPE_WIDTH = 360;

type KeyTarget = {
  addEventListener(type: "keydown", listener: (event: { key: string }) => void): void;
  removeEventListener(type: "keydown", listener: (event: { key: string }) => void): void;
};

/**
 * The desktop inspector: an absolute View over the right side of its parent,
 * `inset` from its edges (J1 over the rail, J6b over the lanes; the parent
 * does not reflow). `item` null or `open` false sends it back past the right
 * edge. The selected card stays lit in the screen, which is the screen's job.
 */
export function InspectorPanel({
  theme,
  item,
  open,
  onClose,
  onVerb,
  onNext,
  onOpenSession,
  width = 480,
  inset = 16,
  frost,
}: {
  theme: PluginTheme;
  item: InspectorItem | null;
  open: boolean;
  onClose: () => void;
  onVerb: (id: string) => void;
  /** "Next hold J": present when the screen can walk to the next item. */
  onNext?: () => void;
  onOpenSession?: () => void;
  width?: number;
  inset?: number;
  /** Assumption A2's override: the bar's look. */
  frost?: FrostLook;
}) {
  const kit = kitOf(theme);
  const reduced = useReducedMotion();
  const shown = open && item !== null;
  const x = useRef(new Animated.Value(shown ? 0 : inspectorHidden(width))).current;
  const [kept, setKept] = useState(item);
  if (item && item !== kept) setKept(item);
  useEffect(() => {
    const to = shown ? 0 : inspectorHidden(width);
    if (reduced) x.setValue(to);
    else
      Animated.spring(x, {
        toValue: to,
        damping: 26,
        stiffness: 240,
        useNativeDriver: nativeDriver(Platform.OS),
      }).start();
  }, [shown, width, reduced, x]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!shown || Platform.OS !== "web") return;
    const doc = (globalThis as { document?: KeyTarget }).document;
    if (!doc) return;
    const onKey = (event: { key: string }) => {
      if (event.key === "Escape") closeRef.current();
    };
    doc.addEventListener("keydown", onKey);
    return () => doc.removeEventListener("keydown", onKey);
  }, [shown]);
  const showing = item ?? kept;
  if (!showing) return null;
  const hold = KIND_LOOK[showing.kind].hold;
  return (
    <Animated.View
      testID="inspector-panel"
      accessibilityElementsHidden={!shown}
      importantForAccessibility={shown ? "auto" : "no-hide-descendants"}
      style={{
        pointerEvents: shown ? "auto" : "none",
        position: "absolute",
        top: inset,
        right: inset,
        bottom: inset,
        width,
        borderRadius: 18,
        borderWidth: hold ? 1.5 : 1,
        borderColor: hold ? kit.needsLine : kit.border,
        backgroundColor: kit.bg,
        overflow: "hidden",
        shadowColor: "#0c101a",
        shadowOpacity: kit.dark ? 0.5 : 0.12,
        shadowRadius: 32,
        shadowOffset: { width: 0, height: 8 },
        transform: [{ translateX: x }],
      }}
    >
      <ScrollView contentContainerStyle={{ paddingVertical: 20, paddingHorizontal: 24, paddingBottom: 84 }}>
        <View style={{ position: "absolute", top: 14, right: 14, zIndex: 1 }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Close the inspector" onPress={onClose} hitSlop={8}>
            <Icon name="X" size={16} color={kit.muted} />
          </Pressable>
        </View>
        <InspectorBody theme={theme} item={showing} onOpenSession={onOpenSession} />
      </ScrollView>
      <View
        testID="inspector-bar"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingVertical: 12,
          paddingHorizontal: 20,
          borderTopWidth: 1,
          borderTopColor: kit.hairline,
          ...barStyle(kit, frost ?? frostLook(Platform.OS)),
        }}
      >
        {onNext ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Next hold"
            onPress={onNext}
            style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
          >
            <Text style={{ color: kit.muted, fontSize: 12 }}>Next hold</Text>
            {keysHint(Platform.OS) ? (
              <View
                style={{
                  borderWidth: 1,
                  borderColor: kit.border,
                  borderRadius: 4,
                  paddingHorizontal: 5,
                  paddingVertical: 1,
                }}
              >
                <Text style={{ color: kit.muted, fontSize: 11, fontFamily: MONO }}>J</Text>
              </View>
            ) : null}
          </Pressable>
        ) : null}
        <View style={{ flex: 1 }} />
        <Verbs
          theme={theme}
          verbs={verbsFor(showing.kind, showing.primaryLabel)}
          onVerb={onVerb}
          height={36}
          grow={false}
          keys
        />
      </View>
    </Animated.View>
  );
}

/**
 * The phone's inspector: a card risen from the deck over a dimmed sliver of
 * the screen (M2–M4). `index` and `total` place it among the deck's holds.
 * Swipe the header down to close; swipe sideways for the next or previous.
 */
export function InspectorCard({
  theme,
  item,
  index,
  total,
  open,
  height,
  onClose,
  onMore,
  onVerb,
  onIndexChange,
  onOpenSession,
}: {
  theme: PluginTheme;
  item: InspectorItem;
  index: number;
  total: number;
  open: boolean;
  /** The screen's height; the card stops 56 pt under its top. */
  height: number;
  onClose: () => void;
  onMore: () => void;
  onVerb: (id: string) => void;
  onIndexChange: (index: number) => void;
  onOpenSession?: () => void;
}) {
  const kit = kitOf(theme);
  const reduced = useReducedMotion();
  const y = useRef(new Animated.Value(open ? 0 : height)).current;
  const live = useRef({ index, total, onIndexChange, onClose, height });
  live.current = { index, total, onIndexChange, onClose, height };
  useEffect(() => {
    const to = open ? 0 : height;
    if (reduced) y.setValue(to);
    else
      Animated.spring(y, {
        toValue: to,
        damping: 26,
        stiffness: 240,
        useNativeDriver: nativeDriver(Platform.OS),
      }).start();
  }, [open, height, reduced, y]);
  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 8 || Math.abs(g.dx) > 10,
        onPanResponderMove: (_, g) => {
          if (Math.abs(g.dy) >= Math.abs(g.dx)) y.setValue(Math.max(0, g.dy));
        },
        onPanResponderRelease: (_, g) => {
          const { index: at, total: count, onIndexChange: change, onClose: close } = live.current;
          if (Math.abs(g.dy) >= Math.abs(g.dx)) {
            // Dismiss past a projected threshold, else spring back (M2–M4 Build note).
            if (g.dy + g.vy * 180 > 140) close();
            else
              Animated.spring(y, {
                toValue: 0,
                velocity: g.vy * 1000,
                useNativeDriver: nativeDriver(Platform.OS),
              }).start();
            return;
          }
          const next = deckRelease(at, count, g.dx, g.vx, CARD_SWIPE_WIDTH);
          if (next !== at) change(next);
        },
      }),
    [y],
  );
  return (
    <View
      style={{ position: "absolute", top: 0, left: 0, right: 0, height, pointerEvents: open ? "box-none" : "none" }}
    >
      <Animated.View
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: kit.scrim,
          opacity: y.interpolate({ inputRange: [0, height], outputRange: [1, 0], extrapolate: "clamp" }),
        }}
      />
      <Animated.View
        testID="inspector-card"
        accessibilityViewIsModal={open}
        style={{
          position: "absolute",
          top: 12,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: kit.bg,
          borderTopLeftRadius: 22,
          borderTopRightRadius: 22,
          overflow: "hidden",
          transform: [{ translateY: y }],
        }}
      >
        <DetailHeader
          theme={theme}
          kind={KIND_LOOK[item.kind].label}
          index={index}
          total={total}
          onClose={onClose}
          onMore={onMore}
          dragHandlers={responder.panHandlers}
        />
        <ScrollView contentContainerStyle={{ paddingVertical: 18, paddingHorizontal: 20, paddingBottom: 32 }}>
          <InspectorBody theme={theme} item={item} compact onOpenSession={onOpenSession} />
        </ScrollView>
        <View
          testID="inspector-card-bar"
          style={{
            flexDirection: "row",
            gap: 10,
            paddingTop: 12,
            paddingBottom: 16,
            paddingHorizontal: 16,
            borderTopWidth: 1,
            borderTopColor: kit.hairline,
            backgroundColor: kit.bg,
          }}
        >
          <Verbs
            theme={theme}
            verbs={verbsFor(item.kind, item.primaryLabel)}
            onVerb={onVerb}
            height={DECK.verb}
            grow
            keys={false}
          />
        </View>
      </Animated.View>
    </View>
  );
}

export type { InspectorKind };
