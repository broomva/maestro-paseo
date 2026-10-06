// The decision card: one ask, made easy to decide. Shared by the Decisions
// tab (client/decision-triage.tsx), one at a time with keys, and the Fleet
// view's per-scope ledgers (DecisionGroups in client/decisions.tsx).

import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation } from "@tanstack/react-query";
import { type MutableRefObject, type ReactNode, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, Platform, Pressable, Text, View } from "react-native";
import { ANSWER_NOTE_CHARS, type AnswerWhere, answerAsk, type DecisionAsk } from "../shared/fleet";
import {
  answeredLine,
  answerVerb,
  BATCHED_TEXT,
  headlineOf,
  keyedLines,
  metaLine,
  SILENCE_TAG,
  silenceOf,
  writtenTo,
} from "./decisions-model";
import { errorText } from "./format";
import { useRefresh } from "./hooks";
import { Button, Card, focusRing, Kbd, Notice, radius, size, space, usePressScale, useText } from "./ui";

type Navigation = PluginSurfaceProps["navigation"];

export const mono = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, monospace" });

/** Your choice and your words on one ask, before you answer. */
export type Draft = { chosen: string | null; note: string };
export const EMPTY_DRAFT: Draft = { chosen: null, note: "" };

/** What the keyboard drives on the card on screen: choose an option, answer. */
export type CardKeys = { choose: (index: number) => void; answer: () => void; options: number };

/** A verb with press feedback: 0.96 while held (none under reduced motion), 40 pt tall, 44 on a phone. */
export function Verb({
  theme,
  label,
  onPress,
  variant = "secondary",
  icon,
  busy = false,
  disabled = false,
  compact,
  grow = false,
  accessibilityLabel,
}: {
  theme: PluginTheme;
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary";
  icon?: string;
  busy?: boolean;
  disabled?: boolean;
  compact: boolean;
  grow?: boolean;
  accessibilityLabel?: string;
}) {
  const press = usePressScale();
  const inactive = disabled || busy;
  const primary = variant === "primary";
  const ink = primary ? theme.colors.accentForeground : theme.colors.foreground;
  return (
    <Animated.View style={{ transform: [{ scale: press.scale }], flexGrow: grow ? 1 : 0 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityState={{ disabled: inactive, busy }}
        disabled={inactive}
        onPress={onPress}
        onPressIn={inactive ? undefined : press.onPressIn}
        onPressOut={press.onPressOut}
        style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({
          ...focusRing(theme, focused),
          minHeight: compact ? 44 : 40,
          paddingHorizontal: space[4],
          borderRadius: radius.control,
          backgroundColor: primary ? theme.colors.accent : theme.colors.surface2,
          borderWidth: primary ? 0 : 1,
          borderColor: theme.colors.border,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: space[2],
          opacity: inactive ? 0.5 : pressed ? 0.9 : 1,
        })}
      >
        {busy ? (
          <ActivityIndicator size="small" color={ink} />
        ) : icon ? (
          <Icon name={icon} size={16} color={ink} />
        ) : null}
        <Text style={{ color: ink, fontSize: size.sm, fontWeight: "600" }} numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

/** One of the two quiet panels: what waiting costs, why it is yours. */
function Panel({
  theme,
  icon,
  title,
  stacked,
  children,
}: {
  theme: PluginTheme;
  icon: string;
  title: string;
  /** One above the other (a phone): each takes its own height, never a share of the row's. */
  stacked: boolean;
  children: string;
}) {
  const text = useText(theme);
  return (
    <View
      style={{
        flex: stacked ? undefined : 1,
        minWidth: stacked ? undefined : 200,
        gap: space[1],
        padding: space[3],
        borderRadius: radius.control,
        backgroundColor: theme.colors.surface0,
        borderWidth: 1,
        borderColor: theme.colors.border,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[1] }}>
        <Icon name={icon} size={13} color={theme.colors.foregroundMuted} />
        <Text style={text.label}>{title}</Text>
      </View>
      <Text style={[text.body, { fontSize: 13, lineHeight: 19 }]}>{children}</Text>
    </View>
  );
}

/** A small tag beside an option's label: always words, the color only a second cue. */
export function Tag({
  theme,
  tone,
  children,
}: {
  theme: PluginTheme;
  tone: "accent" | "warn" | "success";
  children: string;
}) {
  const color =
    tone === "warn"
      ? theme.colors.statusWarning
      : tone === "success"
        ? theme.colors.statusSuccess
        : theme.colors.accent;
  return (
    <View
      style={{
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: color,
      }}
    >
      <Text style={{ color, fontSize: 11, fontWeight: "600", lineHeight: 15 }}>{children}</Text>
    </View>
  );
}

/** A fold: its label and a chevron, pressed to open or close what follows. */
export function Fold({
  theme,
  label,
  open,
  onToggle,
  compact,
  accessibilityLabel,
}: {
  theme: PluginTheme;
  label: string;
  open: boolean;
  onToggle: () => void;
  compact: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      aria-expanded={open}
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onToggle}
      style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({
        ...focusRing(theme, focused),
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        gap: space[1],
        minHeight: compact ? 44 : 40,
        paddingRight: space[2],
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={theme.colors.foregroundMuted} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: size.xs, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

/** A labelled line of the audit layer, under Details. */
function Fact({ theme, label, children }: { theme: PluginTheme; label: string; children: ReactNode }) {
  const text = useText(theme);
  return (
    <Text style={text.small} selectable>
      <Text style={{ fontWeight: "600", color: theme.colors.foreground }}>{`${label}: `}</Text>
      {children}
    </Text>
  );
}

/**
 * A decision ask, made easy to decide: the question as its headline, what
 * waiting costs and why it is yours side by side, each option as a radio card
 * with what it does (the recommended one marked, never chosen for you; one that
 * cannot be undone says so), and what happens if you say nothing. The verb
 * names the option it sends. The full question, the audit layer and where the
 * answer is written fold under Details. The answer is written into the
 * ledger at the ask's home, under its lock.
 */
export function DecisionCard({
  theme,
  ask,
  where,
  compact,
  navigation,
  onAnswered,
  onSkip,
  keys,
  hints = false,
  draft,
  onDraft,
  frozen = null,
  onNext,
}: {
  theme: PluginTheme;
  ask: DecisionAsk;
  /** Where the answer goes, as the ask was read. */
  where: AnswerWhere;
  compact: boolean;
  navigation: Navigation;
  /** The host wrote it: the answered ask as written, and what failed after, if anything. */
  onAnswered: (answered: DecisionAsk, warning: string | null) => void;
  /** Offers Skip, which leaves the ask open and moves on. */
  onSkip?: () => void;
  /** Holds what the keyboard can drive on this card while it is on screen; null once it leaves. */
  keys?: MutableRefObject<CardKeys | null>;
  /** Shows the keys beside what they drive (the web's triage). */
  hints?: boolean;
  /** Your choice and words so far, held by the view so a remount keeps them; the card's own when absent. */
  draft?: Draft;
  onDraft?: (draft: Draft) => void;
  /** Why this ask can no longer be answered here (answered elsewhere, gone): the card is read-only and says so. */
  frozen?: string | null;
  /** Offered with `frozen`: go on to the next decision. */
  onNext?: () => void;
}) {
  const text = useText(theme);
  const toast = useToast();
  const refresh = useRefresh();
  const send = useRpc(answerAsk);
  const answer = useMutation({
    mutationFn: send,
    onSettled: () => {
      void refresh();
    },
  });
  const [own, setOwn] = useState<Draft>(EMPTY_DRAFT);
  const current = draft ?? own;
  const setDraft = (next: Draft) => (onDraft ? onDraft(next) : setOwn(next));
  const { chosen, note } = current;
  const setChosen = (id: string) => setDraft({ ...current, chosen: id });
  const setNote = (value: string) => setDraft({ ...current, note: value });
  // Set before the request leaves, read before the next: a second Enter in the same frame finds it.
  const inFlight = useRef(false);
  const [fullOpen, setFullOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const open = ask.state === "open" && !frozen;
  const option = ask.options.find((entry) => entry.id === chosen) ?? null;
  const hasOptions = ask.options.length > 0;
  const lead = headlineOf(ask);
  const canAnswer = open && !ask.refusal && !answer.isPending && (option !== null || note.trim().length > 0);
  const silence = silenceOf(ask);
  const origin = ask.origin;
  const submit = () => {
    if (inFlight.current || !canAnswer) return;
    inFlight.current = true;
    answer.mutate(
      { where, ledger: ask.ledger, uid: ask.uid, id: ask.id, hash: ask.hash, option: chosen, note },
      {
        onSuccess: ({ ask: answered, warning }) => {
          setDraft(EMPTY_DRAFT);
          if (warning) toast.error(warning);
          onAnswered(answered, warning);
        },
        onError: (error) => toast.error(errorText(error)),
        onSettled: () => {
          inFlight.current = false;
        },
      },
    );
  };
  // The keyboard reaches this card only while it is on screen and open.
  const drive: CardKeys | null = open
    ? {
        options: ask.options.length,
        choose: (index) => {
          const entry = ask.options[index];
          if (entry && !inFlight.current) setChosen(entry.id);
        },
        answer: submit,
      }
    : null;
  useEffect(() => {
    if (!keys) return;
    keys.current = drive;
    return () => {
      keys.current = null;
    };
  });
  const showHints = hints && !compact;
  const label = `${ask.id}`;
  return (
    <Card theme={theme} style={{ gap: space[4], padding: compact ? space[4] : space[5] }}>
      <View style={{ gap: space[2] }}>
        <Text style={[text.small, text.tabular, { fontFamily: mono }]} numberOfLines={2}>
          {metaLine(ask)}
        </Text>
        {open && ask.waiting ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space[1] }}>
            <Icon name="TriangleAlert" size={13} color={theme.colors.statusWarning} />
            <Text style={[text.small, { color: theme.colors.statusWarning, fontWeight: "600" }]}>
              {ask.blocking
                ? "Waits on you: it blocks until you answer."
                : "Waits on you: what it recommends cannot be undone."}
            </Text>
          </View>
        ) : null}
        <Text
          accessibilityRole="header"
          style={{
            color: theme.colors.foreground,
            fontSize: compact ? size.lg : 20,
            lineHeight: compact ? 24 : 27,
            fontWeight: "700",
          }}
        >
          {lead.headline}
        </Text>
        {lead.rest ? (
          <View style={{ gap: space[1] }}>
            <Fold
              theme={theme}
              compact={compact}
              label={fullOpen ? "Hide the full question" : "Full question"}
              open={fullOpen}
              onToggle={() => setFullOpen((now) => !now)}
              accessibilityLabel={`${fullOpen ? "Hide" : "Show"} the full question of ${label}`}
            />
            {fullOpen ? (
              <Text style={text.muted} selectable>
                {lead.rest}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>

      {ask.stakes || ask.whyYou ? (
        <View style={{ flexDirection: compact ? "column" : "row", gap: space[2] }}>
          {ask.stakes ? (
            <Panel theme={theme} icon="Hourglass" title="What waiting costs" stacked={compact}>
              {ask.stakes}
            </Panel>
          ) : null}
          {ask.whyYou ? (
            <Panel theme={theme} icon="User" title="Why you" stacked={compact}>
              {ask.whyYou}
            </Panel>
          ) : null}
        </View>
      ) : null}

      {hasOptions ? (
        <View accessibilityRole="radiogroup" accessibilityLabel={`Options for ${ask.id}`} style={{ gap: space[2] }}>
          {ask.options.map((entry, at) => {
            const picked = open ? chosen === entry.id : ask.answerOption === entry.id;
            const irreversible = entry.reversible === false;
            const inactive = !open || answer.isPending || Boolean(ask.refusal);
            return (
              <Pressable
                key={entry.id}
                accessibilityRole="radio"
                accessibilityState={{ checked: picked, disabled: inactive }}
                aria-checked={picked}
                accessibilityLabel={[
                  entry.label,
                  entry.recommended ? "recommended" : null,
                  irreversible ? "cannot be undone" : null,
                ]
                  .filter(Boolean)
                  .join(", ")}
                disabled={inactive}
                onPress={() => setChosen(entry.id)}
                style={({ pressed, hovered, focused }: { pressed: boolean; hovered?: boolean; focused?: boolean }) => ({
                  ...focusRing(theme, focused),
                  flexDirection: "row",
                  alignItems: "flex-start",
                  gap: space[3],
                  minHeight: compact ? 56 : 48,
                  paddingVertical: space[3],
                  paddingHorizontal: space[3],
                  borderRadius: radius.control,
                  borderWidth: 1,
                  borderColor: picked ? theme.colors.accent : theme.colors.border,
                  backgroundColor: picked
                    ? theme.colors.surface2
                    : (pressed || hovered) && !inactive
                      ? theme.colors.surface2
                      : "transparent",
                })}
              >
                <View
                  style={{
                    width: 18,
                    height: 18,
                    marginTop: 1,
                    borderRadius: 9,
                    borderWidth: picked ? 5 : 1.5,
                    borderColor: picked ? theme.colors.accent : theme.colors.foregroundMuted,
                  }}
                />
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}>
                    <Text
                      style={{ color: theme.colors.foreground, fontSize: size.sm, lineHeight: 20, fontWeight: "600" }}
                    >
                      {entry.label}
                    </Text>
                    {entry.recommended ? (
                      <Tag theme={theme} tone="accent">
                        Recommended
                      </Tag>
                    ) : null}
                    {irreversible ? (
                      <Tag theme={theme} tone="warn">
                        Cannot be undone
                      </Tag>
                    ) : null}
                    {!open && picked ? (
                      <Tag theme={theme} tone="success">
                        Your answer
                      </Tag>
                    ) : null}
                  </View>
                  {entry.consequence ? <Text style={text.small}>{entry.consequence}</Text> : null}
                </View>
                {showHints && open && at < 4 ? <Kbd theme={theme}>{String(at + 1)}</Kbd> : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {silence ? (
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space[2] }}>
          <Icon name="VolumeX" size={13} color={theme.colors.foregroundMuted} />
          <View style={{ flex: 1, gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}>
              <Text style={[text.small, { color: theme.colors.foreground }]}>{silence.text}</Text>
              {silence.tag ? (
                <Tag theme={theme} tone={silence.tag === "same" ? "accent" : "warn"}>
                  {SILENCE_TAG[silence.tag]}
                </Tag>
              ) : null}
            </View>
            {silence.words ? <Text style={text.small}>{`The ledger says: “${silence.words}”`}</Text> : null}
          </View>
        </View>
      ) : null}

      {frozen ? (
        <View style={{ gap: space[2] }}>
          <Notice theme={theme} tone="warn">
            {frozen}
          </Notice>
          {onNext ? (
            <View style={{ flexDirection: "row" }}>
              <Verb
                theme={theme}
                variant="primary"
                label="Next decision"
                icon="ArrowRight"
                compact={compact}
                onPress={onNext}
              />
            </View>
          ) : null}
        </View>
      ) : !open ? (
        <View style={{ gap: 2 }}>
          <Text style={[text.small, { color: theme.colors.statusSuccess, fontWeight: "600" }]}>
            {answeredLine(ask)}
          </Text>
          {ask.answer ? (
            <Text style={text.small} selectable>
              {ask.answer}
            </Text>
          ) : null}
          {ask.batched ? <Text style={text.small}>{BATCHED_TEXT}</Text> : null}
        </View>
      ) : ask.refusal ? (
        <View style={{ gap: space[2] }}>
          <Notice theme={theme} tone="warn">
            {`This ask cannot be answered here. ${ask.refusal}`}
          </Notice>
          {onSkip ? (
            <View style={{ flexDirection: "row", gap: space[2], alignItems: "center" }}>
              <Verb
                theme={theme}
                label="Skip"
                icon="SkipForward"
                compact={compact}
                onPress={onSkip}
                accessibilityLabel={`Skip ${ask.id} for now`}
              />
              {showHints ? <Kbd theme={theme}>S</Kbd> : null}
            </View>
          ) : null}
        </View>
      ) : (
        <View style={{ gap: space[3] }}>
          <View style={{ gap: space[1] }}>
            {!hasOptions ? (
              <Text style={[text.label, { color: theme.colors.foreground }]}>
                No options were written for this ask: answer it in your own words.
              </Text>
            ) : null}
            <TextInput
              value={note}
              onChangeText={setNote}
              multiline
              maxLength={ANSWER_NOTE_CHARS}
              placeholder={hasOptions ? "Add words (optional)" : "Your answer"}
              placeholderTextColor={theme.colors.foregroundMuted}
              accessibilityLabel={`Your words for ${ask.id}`}
              style={{
                minHeight: hasOptions ? 44 : 88,
                paddingHorizontal: space[3],
                paddingVertical: space[2] + 2,
                borderRadius: radius.control,
                borderWidth: 1,
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface0,
                color: theme.colors.foreground,
                fontSize: 14,
                textAlignVertical: "top",
              }}
            />
          </View>
          {answer.isError ? (
            <Notice theme={theme} tone="danger">
              {`Not answered: ${errorText(answer.error)}`}
            </Notice>
          ) : null}
          <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap", alignItems: "center" }}>
            <Verb
              theme={theme}
              variant="primary"
              icon="Check"
              label={answerVerb(option, hasOptions, note)}
              compact={compact}
              grow={compact}
              busy={answer.isPending}
              disabled={!canAnswer}
              accessibilityLabel={`Answer ${ask.id}${option ? `: ${option.label}` : ""}`}
              onPress={submit}
            />
            {showHints ? <Kbd theme={theme}>Enter</Kbd> : null}
            {onSkip ? (
              <>
                <View style={{ width: showHints ? space[2] : 0 }} />
                <Verb
                  theme={theme}
                  label="Skip"
                  icon="SkipForward"
                  compact={compact}
                  onPress={onSkip}
                  accessibilityLabel={`Skip ${ask.id} for now`}
                />
                {showHints ? <Kbd theme={theme}>S</Kbd> : null}
              </>
            ) : null}
          </View>
        </View>
      )}

      <View style={{ gap: space[2], borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: space[3] }}>
        <Fold
          theme={theme}
          compact={compact}
          label="Details"
          open={detailsOpen}
          onToggle={() => setDetailsOpen((now) => !now)}
          accessibilityLabel={`${detailsOpen ? "Hide" : "Show"} the details of ${ask.id}`}
        />
        {detailsOpen ? (
          <View style={{ gap: space[2], paddingLeft: space[4] }}>
            <Fact theme={theme} label="Ask">
              {ask.id}
            </Fact>
            {ask.question && !lead.derived && ask.question !== lead.headline ? (
              <Fact theme={theme} label="The full question">
                {ask.question}
              </Fact>
            ) : null}
            {ask.audit?.class ? (
              <Fact theme={theme} label="Class">
                {ask.audit.class}
              </Fact>
            ) : null}
            {ask.audit && ask.audit.gates.length > 0 ? (
              <Fact theme={theme} label="Gates">
                {ask.audit.gates.join(", ")}
              </Fact>
            ) : null}
            {ask.audit && ask.audit.exhausted.length > 0 ? (
              <View style={{ gap: 2 }}>
                <Text style={[text.small, { fontWeight: "600", color: theme.colors.foreground }]}>
                  Tried before asking
                </Text>
                {keyedLines(ask.audit.exhausted).map(({ key, line }) => (
                  <Text key={key} style={text.small} selectable>
                    {`· ${line}`}
                  </Text>
                ))}
              </View>
            ) : null}
            <Fact theme={theme} label="Ledger">
              {`${ask.ledger}${ask.arc ? ` (arc ${ask.arc})` : ""}${ask.uid ? ` · uid ${ask.uid}` : ""}`}
            </Fact>
            {open ? <Text style={text.small}>{writtenTo(ask)}</Text> : null}
            {origin && navigation ? (
              <View style={{ flexDirection: "row" }}>
                <Button
                  theme={theme}
                  variant="quiet"
                  icon="ArrowUpRight"
                  label="Open the session that asked"
                  compact={compact}
                  accessibilityLabel={`Open the session that asked ${ask.id}`}
                  onPress={() => navigation.openAgent({ agentId: origin.agentId })}
                />
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    </Card>
  );
}
