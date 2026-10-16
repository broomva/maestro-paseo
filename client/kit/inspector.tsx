// The inspector (JE rule "One inspector for every item"; J1, J2–J4, J6b, J8 on
// the desktop, M2–M4 on the phone): one container, a body per kind (approval,
// ask, notice, work item, initiative review) and an action bar of that kind's
// verbs (client/kit/inspector-model.ts).
//
// Desktop: InspectorPanel, a View inside Maestro's screen that slides in from
// the right with Animated.spring (J1: over the rail; J6b: over the right-hand
// lanes, B3) and goes back on Esc or its close button. Its action bar is
// frosted with backdropFilter on the web and solid elsewhere (assumptions.ts F2).
// Phone: InspectorCard, a card that rises from the deck under the detail
// header; swipe it down to close and sideways for the next hold, its verbs
// 52 pt and pinned at the bottom, its bar solid (no blur on iOS).

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Animated, PanResponder, Platform, Pressable, ScrollView, Text, View, type ViewStyle } from "react-native";
import { tint } from "../fleet-color";
import { typingIn, useReducedMotion, webAria } from "../ui";
import { type Directions, DRAG_NATIVE_DRIVER, type FrostLook, frostLook, keysHint, nativeDriver } from "./assumptions";
import { DECK, deckCaptures, deckRelease } from "./deck-model";
import { DetailHeader } from "./detail-header";
import {
  answerLabel,
  type InspectorKind,
  inspectorHidden,
  KIND_LOOK,
  panelVerbsFor,
  type VerbSpec,
  verbsFor,
  withoutRefused,
} from "./inspector-model";
import { Dot, Kicker, MONO, PASS_THROUGH, Pill, SectionLabel, TABULAR } from "./parts";
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
  /** Whether it waits on you: only then is its dot Tidepool (Needs you); otherwise it is muted. */
  waiting?: boolean;
}

export interface Choice {
  id: string;
  label: string;
  note?: string;
  recommended?: boolean;
  /** An answer that cannot be undone: a screen reader says so, and the screen asks twice. */
  irreversible?: boolean;
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
  | (Common & {
      kind: "approval";
      action: string;
      /** The layer that held it, in words ("the session's permission prompt"): J2's "Held by" box. */
      heldBy?: string;
      evidence: readonly Evidence[];
      after: readonly string[];
      /** What Deny does (J2's "Deny: …" line); shown under its own label. */
      afterDeny?: readonly string[];
    })
  | (Common & {
      kind: "ask";
      why?: string;
      /** J3's two tiles: what waiting costs, and why it is yours. The desktop shows them in place of `why` and the summary. */
      cost?: string;
      whyYou?: string;
      /** Where your answer is written and acted on, in words. */
      goes?: string;
      /** What a screen reader calls the words field; "Your words for <title>" when absent. */
      fieldLabel?: string;
      /** What a screen reader calls the options' radio group; "Options" when absent. */
      optionsLabel?: string;
      options: readonly Choice[];
      chosen?: string;
      /** The silent default: what happens if you say nothing, and how far its countdown has run (0 to 1). */
      fallback?: { line: string; elapsed?: number };
      /** Why it cannot be answered here (an id collision, split copies): no Answer is offered, and this says why. */
      refusal?: string;
    })
  | (Common & {
      kind: "owner_step";
      /** Where the step is done: "platform.openai.com → Billing → workspace credits". */
      where: string;
      /** How Maestro knows it is done, and what holds until then. */
      check?: string;
    })
  | (Common & {
      kind: "notice";
      log: readonly LogLine[];
      closesWhen: readonly { when: string; becomes: string }[];
      note?: string;
      /** The session can be sent a prompt with Unblock: the desktop shows a field for it (J4). */
      prompt?: boolean;
    })
  | (Common & {
      kind: "work";
      state: string;
      lifecycle: readonly { label: string; at?: string; done: boolean }[];
    })
  | (Common & {
      kind: "review";
      late?: string;
      options: readonly Choice[];
      chosen?: string;
      /** The review's own text above its three answers (J8): what changed, what hangs off it. */
      since?: readonly string[];
      hanging?: readonly { icon: string; value: string; label: string }[];
      goes?: string;
    });

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
  compact = false,
  label,
  locked = false,
  keys = false,
}: {
  theme: PluginTheme;
  options: readonly Choice[];
  chosen: string | undefined;
  onChoose: (id: string) => void;
  /** The phone's: "Rec." and no key caps. The desktop says Recommended and numbers each answer (1 to 4 choose). */
  compact?: boolean;
  label?: string;
  /** Nothing can be chosen now: an answer is in flight, or the ask is answered. */
  locked?: boolean;
  /** Draw the 1–4 key caps: only where those keys choose (J5's tab), never where they would do nothing. */
  keys?: boolean;
}) {
  const kit = kitOf(theme);
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ gap: 8 }}>
      {options.map((option, at) => {
        const on = option.id === chosen;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="radio"
            accessibilityState={{ checked: on, disabled: locked }}
            disabled={locked}
            {...webAria({ "aria-checked": on })}
            accessibilityLabel={`${option.label}${option.recommended ? ", recommended" : ""}${option.irreversible ? ", cannot be undone" : ""}`}
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
                  <Text style={{ color: kit.ok, fontSize: 11.5, fontWeight: "600" }}>
                    {compact ? "Rec." : "Recommended"}
                  </Text>
                ) : null}
              </View>
              {option.note ? <Text style={{ color: kit.muted, fontSize: 12.5 }}>{option.note}</Text> : null}
            </View>
            {compact || !keys || at > 3 ? null : (
              <View
                style={{
                  borderWidth: 1,
                  borderColor: kit.border,
                  borderRadius: 5,
                  paddingHorizontal: 6,
                  paddingVertical: 1,
                }}
              >
                <Text style={{ color: kit.muted, fontSize: 11, fontFamily: MONO }}>{at + 1}</Text>
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

/** A quiet tile with a small title: what waiting costs, why it is yours (J3). */
function Tile({ theme, title, children }: { theme: PluginTheme; title: string; children: string }) {
  const kit = kitOf(theme);
  return (
    <View style={{ flex: 1, minWidth: 180, gap: 4, backgroundColor: kit.sunken, borderRadius: 10, padding: 12 }}>
      <Text style={{ color: kit.muted, fontSize: 11.5 }}>{title}</Text>
      <Text style={{ color: kit.fg2, fontSize: 13, lineHeight: 18 }}>{children}</Text>
    </View>
  );
}

/** Your words, optional: the field J3 puts under the options, and J4 under a notice for its prompt. */
function WordsField({
  theme,
  value,
  onChange,
  placeholder,
  label,
}: {
  theme: PluginTheme;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
}) {
  const kit = kitOf(theme);
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      multiline
      maxLength={2000}
      placeholder={placeholder}
      placeholderTextColor={kit.muted}
      accessibilityLabel={label}
      style={{
        minHeight: 48,
        paddingHorizontal: 14,
        paddingVertical: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: kit.border,
        backgroundColor: kit.bg,
        color: kit.fg,
        fontSize: 14,
        textAlignVertical: "top",
      }}
    />
  );
}

/** A line with a small icon: where your answer goes, how a notice closes. */
function IconLine({ theme, icon, children }: { theme: PluginTheme; icon: string; children: string }) {
  const kit = kitOf(theme);
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <Icon name={icon} size={15} color={kit.muted} />
      <Text style={{ flex: 1, color: kit.fg2, fontSize: 13, lineHeight: 18 }}>{children}</Text>
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
      {session.state === "running" ? null : <Dot color={session.waiting ? kit.needs : kit.muted} size={8} />}
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
  onClose,
  choice,
  words,
  onWords,
  locked = false,
  keys = false,
}: {
  theme: PluginTheme;
  item: InspectorItem;
  compact?: boolean;
  onOpenSession?: () => void;
  onChoose?: (id: string) => void;
  /** The desktop's close button, at the kicker's end (the phone closes from its detail header). */
  onClose?: () => void;
  /** The chosen option when the container holds it (InspectorPanel, InspectorCard); the body's own otherwise. */
  choice?: string;
  /** Your words, held by the container so a verb carries them; with `onWords` the desktop shows the field (J3, J4). */
  words?: string;
  onWords?: (value: string) => void;
  /** The options cannot be chosen now (J5: an answer is in flight, or the ask is answered). */
  locked?: boolean;
  /** The 1–4 keys choose an option here (J5's tab): its answers wear their key caps. */
  keys?: boolean;
}) {
  const kit = kitOf(theme);
  const look = KIND_LOOK[item.kind];
  const initialChoice = item.kind === "ask" || item.kind === "review" ? item.chosen : undefined;
  const [own, setChosen] = useState(initialChoice);
  const chosen = choice ?? own;
  // A new item starts from its own choice, never the last item's (the key changes even when both are unset).
  // biome-ignore lint/correctness/useExhaustiveDependencies: item.key is the reset trigger
  useEffect(() => setChosen(initialChoice), [initialChoice, item.key]);
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
        item.heldBy && !compact ? (
          <View
            key="held"
            style={{
              backgroundColor: kit.sunken,
              borderRadius: 10,
              paddingVertical: 10,
              paddingHorizontal: 12,
              flexDirection: "row",
              gap: 8,
            }}
          >
            <Text style={{ color: kit.muted, fontSize: 12.5 }}>Held by</Text>
            <Text selectable style={{ flex: 1, color: kit.fg, fontSize: 12.5, fontFamily: MONO }}>
              {item.heldBy}
            </Text>
          </View>
        ) : null,
        item.evidence.length > 0 ? (
          <EvidenceGrid key="evidence" theme={theme} evidence={item.evidence} columns={compact ? 2 : 4} />
        ) : null,
        label("After you allow"),
        <After key="after" theme={theme} lines={item.after} />,
      );
      if (!compact && item.afterDeny?.length)
        sections.push(label("If you deny"), <After key="deny" theme={theme} lines={item.afterDeny} />);
      break;
    case "ask": {
      // The desktop's two tiles (J3) say what waiting costs and why it is yours; the phone keeps its line.
      const tiles = !compact && (item.cost || item.whyYou);
      if (tiles)
        sections.push(
          <View key="tiles" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {item.cost ? (
              <Tile theme={theme} title="What waiting costs">
                {item.cost}
              </Tile>
            ) : null}
            {item.whyYou ? (
              <Tile theme={theme} title="Why you">
                {item.whyYou}
              </Tile>
            ) : null}
          </View>,
        );
      else if (item.why)
        sections.push(
          <Text key="why" style={{ color: kit.fg2, fontSize: 14, lineHeight: 20 }}>
            {item.why}
          </Text>,
        );
      sections.push(
        <Choices
          key="choices"
          theme={theme}
          options={item.options}
          chosen={chosen}
          onChoose={choose}
          compact={compact}
          label={item.optionsLabel ?? "Options"}
          locked={locked || Boolean(item.refusal)}
          keys={keys}
        />,
      );
      if (item.refusal)
        sections.push(
          <Text key="refusal" accessibilityRole="alert" style={{ color: kit.warn, fontSize: 13.5, lineHeight: 19 }}>
            {`This ask cannot be answered here. ${item.refusal}`}
          </Text>,
        );
      if (item.fallback)
        sections.push(
          <View key="fallback" style={{ gap: 8 }}>
            {item.fallback.elapsed === undefined ? null : (
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
            )}
            <Text style={{ color: kit.muted, fontSize: 12.5 }}>{item.fallback.line}</Text>
          </View>,
        );
      if (!compact && onWords)
        sections.push(
          <WordsField
            key="words"
            theme={theme}
            value={words ?? ""}
            onChange={onWords}
            placeholder="Add words (optional)"
            label={item.fieldLabel ?? `Your words for ${item.title}`}
          />,
        );
      if (!compact && item.goes)
        sections.push(
          <IconLine key="goes" theme={theme} icon="Send">
            {item.goes}
          </IconLine>,
        );
      break;
    }
    case "owner_step":
      sections.push(
        <View
          key="where"
          style={{
            backgroundColor: kit.sunken,
            borderRadius: 10,
            paddingVertical: 10,
            paddingHorizontal: 12,
            flexDirection: compact ? "column" : "row",
            gap: compact ? 2 : 8,
          }}
        >
          <Text style={{ color: kit.muted, fontSize: 12.5 }}>Where</Text>
          <Text selectable style={{ flex: compact ? 0 : 1, color: kit.fg, fontSize: 12.5, fontFamily: MONO }}>
            {item.where}
          </Text>
        </View>,
      );
      if (item.check)
        sections.push(
          <View key="check" style={{ flexDirection: "row", gap: 8 }}>
            <Icon name="Info" size={15} color={kit.muted} />
            <Text style={{ flex: 1, color: kit.fg2, fontSize: 13.5, lineHeight: 19 }}>{item.check}</Text>
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
      if (!compact && item.prompt && onWords)
        sections.push(
          <WordsField
            key="prompt"
            theme={theme}
            value={words ?? ""}
            onChange={onWords}
            placeholder="A prompt for the session (optional)"
            label={`A prompt for the session of ${item.title}`}
          />,
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
    case "review": {
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
      if (!compact && item.since?.length)
        sections.push(label("Since the last review"), <After key="since" theme={theme} lines={item.since} />);
      if (!compact && item.hanging?.length)
        sections.push(
          <View key="hanging" style={{ flexDirection: "row", gap: 8 }}>
            {item.hanging.map((tile) => (
              <View
                key={tile.label}
                style={{ flex: 1, gap: 2, backgroundColor: kit.sunken, borderRadius: 10, padding: 12 }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Icon name={tile.icon} size={14} color={kit.muted} />
                  <Text style={{ color: kit.fg, fontSize: 16, fontWeight: "600", ...TABULAR }}>{tile.value}</Text>
                </View>
                <Text style={{ color: kit.muted, fontSize: 11.5 }}>{tile.label}</Text>
              </View>
            ))}
          </View>,
        );
      sections.push(
        <Choices
          key="choices"
          theme={theme}
          options={item.options}
          chosen={chosen}
          onChoose={choose}
          compact={compact}
          label="Options"
          locked={locked}
        />,
      );
      if (!compact && item.goes)
        sections.push(
          <IconLine key="goes" theme={theme} icon="Send">
            {item.goes}
          </IconLine>,
        );
      break;
    }
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
        trailing={
          onClose ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close the inspector"
              onPress={onClose}
              hitSlop={8}
              style={{ marginLeft: 6 }}
            >
              <Icon name="X" size={16} color={kit.muted} />
            </Pressable>
          ) : null
        }
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
      {/* The desktop's ask says what waiting costs in its own tile (J3): once, not twice; the rest of a long question stays. */}
      {item.summary && !(item.kind === "ask" && !compact && item.summary === item.cost) ? (
        <Text style={{ color: kit.fg2, fontSize: 14.5, lineHeight: 21 }}>{item.summary}</Text>
      ) : null}
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

/**
 * Slides `value` to 0 while `shown` and to `hidden` when not, and says whether
 * the view should stay mounted: while it shows and until it has left. A closed
 * inspector unmounts, so its verbs are never focusable, scrolled into view or
 * read out while it sits off-screen.
 */
/**
 * The option chosen on the item showing, held by the container so a verb carries it (`onVerb("answer",
 * "fleet")`). It belongs to one item: another item starts from its own default.
 */
function useChoice(item: InspectorItem | null): {
  choice: string | undefined;
  /** You picked it yourself: the option an item starts on (a recommendation) is not a pick. */
  explicit: boolean;
  choose: (id: string) => void;
} {
  const [picked, setPicked] = useState<{ key: string; id: string } | null>(null);
  const fallback = item && (item.kind === "ask" || item.kind === "review") ? item.chosen : undefined;
  return {
    choice: item && picked?.key === item.key ? picked.id : fallback,
    explicit: Boolean(item && picked?.key === item.key),
    choose: (id) => {
      if (item) setPicked({ key: item.key, id });
    },
  };
}

/** Your words on the item showing, held by the container so a verb carries them; they belong to one item. */
function useWords(item: InspectorItem | null): { words: string; setWords: (value: string) => void } {
  const [typed, setTyped] = useState<{ key: string; text: string } | null>(null);
  return {
    words: item && typed?.key === item.key ? typed.text : "",
    setWords: (text) => {
      if (item) setTyped({ key: item.key, text });
    },
  };
}

function useSlide(shown: boolean, value: Animated.Value, hidden: number, reduced: boolean, native: boolean): boolean {
  const [present, setPresent] = useState(shown);
  useEffect(() => {
    if (shown) setPresent(true);
    const to = shown ? 0 : hidden;
    if (reduced) {
      value.setValue(to);
      if (!shown) setPresent(false);
      return;
    }
    const slide = Animated.spring(value, {
      toValue: to,
      damping: 26,
      stiffness: 240,
      useNativeDriver: native,
    });
    slide.start(({ finished }) => {
      if (finished && !shown) setPresent(false);
    });
    return () => slide.stop();
  }, [shown, hidden, reduced, value, native]);
  return present;
}

/** The width a sideways swipe on the phone card is measured against: the 393 pt column less its margins. */
const CARD_SWIPE_WIDTH = 360;

type KeyTarget = {
  addEventListener(type: "keydown", listener: (event: { key: string; target?: unknown }) => void): void;
  removeEventListener(type: "keydown", listener: (event: { key: string; target?: unknown }) => void): void;
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
  scope,
}: {
  theme: PluginTheme;
  item: InspectorItem | null;
  open: boolean;
  onClose: () => void;
  /** A verb pressed, with the option chosen when the item is an ask or a review, and the words typed (J3, J4). */
  onVerb: (id: string, choice?: string, words?: string) => void;
  /** "Next hold J": present when the screen can walk to the next item. */
  onNext?: () => void;
  onOpenSession?: () => void;
  width?: number;
  inset?: number;
  /** F2's override: the bar's look. */
  frost?: FrostLook;
  /** Maestro's screen, whose focus Esc belongs to; without it every Esc not typed in a field is Maestro's. */
  scope?: { current: unknown };
}) {
  const kit = kitOf(theme);
  const reduced = useReducedMotion();
  const shown = open && item !== null;
  const x = useRef(new Animated.Value(shown ? 0 : inspectorHidden(width))).current;
  const [kept, setKept] = useState(item);
  if (item && item !== kept) setKept(item);
  const present = useSlide(shown, x, inspectorHidden(width), reduced, nativeDriver(Platform.OS));
  const picked = useChoice(item ?? kept);
  const said = useWords(item ?? kept);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  useEffect(() => {
    if (!shown || Platform.OS !== "web") return;
    const doc = (globalThis as { document?: KeyTarget }).document;
    if (!doc) return;
    // Esc is Maestro's while Maestro has focus: anywhere in `scope` (the screen; a pressed card or tile keeps
    // focus there), or nowhere in particular (the page). A field someone types in keeps its Esc, and so does
    // anything outside the scope, such as Paseo's ⌘K palette (paseo-plugin-capabilities.md §7).
    const onKey = (event: { key: string; target?: unknown }) => {
      if (event.key !== "Escape") return;
      const target = event.target;
      const page = (doc as { body?: unknown }).body;
      const unfocused = !target || target === doc || target === page;
      if (unfocused) {
        closeRef.current();
        return;
      }
      if (typingIn(target)) return;
      const within = scopeRef.current?.current as { contains?: (other: unknown) => boolean } | null | undefined;
      if (within?.contains && !within.contains(target)) return;
      closeRef.current();
    };
    doc.addEventListener("keydown", onKey);
    return () => doc.removeEventListener("keydown", onKey);
  }, [shown]);
  const showing = item ?? kept;
  if (!showing || !present) return null;
  const hold = KIND_LOOK[showing.kind].hold;
  // Words typed beside an option you did not pick yourself are an answer in your words: the recommendation an ask
  // starts on is never sent with them, and the primary says which it is sending.
  const inWords = showing.kind === "ask" && !picked.explicit && said.words.trim().length > 0;
  const sent = inWords ? undefined : picked.choice;
  const primary =
    showing.kind === "ask" || showing.kind === "review"
      ? inWords
        ? "Answer in your words"
        : answerLabel(showing.options, sent)
      : showing.primaryLabel;
  const verbs = withoutRefused(
    showing,
    panelVerbsFor(showing.kind, primary, showing.kind === "review" && showing.session !== undefined),
  );
  const links = verbs.filter((verb) => verb.link);
  const pills = verbs.filter((verb) => !verb.link);
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
        <InspectorBody
          theme={theme}
          item={showing}
          onOpenSession={onOpenSession}
          onClose={onClose}
          choice={inWords ? "" : picked.choice}
          onChoose={picked.choose}
          words={said.words}
          onWords={showing.kind === "ask" || showing.kind === "notice" ? said.setWords : undefined}
        />
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
        {links.map((verb) => (
          <Pressable
            key={verb.id}
            accessibilityRole="button"
            accessibilityLabel={verb.label}
            onPress={() => onVerb(verb.id, sent, said.words)}
          >
            <Text style={{ color: kit.muted, fontSize: 12.5 }}>{verb.label}</Text>
          </Pressable>
        ))}
        <View style={{ flex: 1 }} />
        <Verbs
          theme={theme}
          verbs={pills}
          onVerb={(id) => onVerb(id, sent, said.words)}
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
  directions,
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
  /** A verb pressed, with the option chosen when the item is an ask or a review, and the words typed (J3, J4). */
  onVerb: (id: string, choice?: string, words?: string) => void;
  onIndexChange: (index: number) => void;
  onOpenSession?: () => void;
  /** Which ways it swipes to the next hold: the screen passes swipeDirections(layout) (BRO-3033 fact 3). */
  directions: Directions;
}) {
  const kit = kitOf(theme);
  const reduced = useReducedMotion();
  const y = useRef(new Animated.Value(open ? 0 : height)).current;
  const ways = directions;
  const live = useRef({ index, total, onIndexChange, onClose, height, ways });
  live.current = { index, total, onIndexChange, onClose, height, ways };
  // The card is dragged, so it springs on the JS thread (A3) and a grab reads where it is.
  const present = useSlide(open, y, height, reduced, DRAG_NATIVE_DRIVER);
  const picked = useChoice(item);
  const origin = useRef(0);
  const responder = useMemo(() => {
    const home = (velocity: number) =>
      Animated.spring(y, { toValue: 0, velocity, useNativeDriver: DRAG_NATIVE_DRIVER }).start();
    const vertical = (g: { dx: number; dy: number }) => Math.abs(g.dy) >= Math.abs(g.dx);
    return PanResponder.create({
      // Down to close, only when mostly down; sideways for the next hold, only the ways it may go
      // (compact native: leftward), so a mostly-rightward drag is always left to Paseo there.
      onMoveShouldSetPanResponder: (_, g) =>
        (g.dy > 8 && g.dy > Math.abs(g.dx)) || deckCaptures(g.dx, g.dy, live.current.ways),
      onPanResponderGrant: () => {
        y.stopAnimation((at) => {
          origin.current = at;
        });
      },
      onPanResponderMove: (_, g) => {
        if (vertical(g)) y.setValue(Math.max(0, origin.current + g.dy));
      },
      onPanResponderRelease: (_, g) => {
        const { index: at, total: count, onIndexChange: change, onClose: close, ways: allowed } = live.current;
        if (vertical(g)) {
          // Dismiss past a projected threshold, else spring back (M2–M4 Build note).
          if (origin.current + g.dy + g.vy * 180 > 140) close();
          else home(g.vy * 1000);
          return;
        }
        home(0);
        const next = deckRelease(at, count, g.dx, g.vx, CARD_SWIPE_WIDTH, allowed);
        if (next !== at) change(next);
      },
      // The host took the gesture: the card springs back into place.
      onPanResponderTerminate: () => home(0),
    });
  }, [y]);
  if (!present) return null;
  return (
    <View
      testID="inspector-card-root"
      style={[
        open ? PASS_THROUGH : { pointerEvents: "none" },
        { position: "absolute", top: 0, left: 0, right: 0, height },
      ]}
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
          <InspectorBody
            theme={theme}
            item={item}
            compact
            onOpenSession={onOpenSession}
            choice={picked.choice}
            onChoose={picked.choose}
          />
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
            verbs={withoutRefused(item, verbsFor(item.kind, item.primaryLabel))}
            onVerb={(id) => onVerb(id, picked.choice)}
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
