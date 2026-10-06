// Decisions: the asks in `.control/asks` ledgers, each with what a person needs
// to decide it, answered in place. Two kinds of ledger feed it: the
// workspace's own (the control repo's, each ask read at its home by the
// control interface spec's §5.2 rule, server/control-home.ts), shown one at a
// time in the Decisions tab (DecisionsView), and a fleet scope's own root
// (server/fleet.ts), listed a ledger at a time in the Fleet view
// (DecisionGroups). Both use the same card and the same ask.answer.
//
// Ideas (idea-triage asks) are not listed here: they are answered in the
// Initiatives tab, under their initiative (client/initiatives.tsx).
//
// AskNotices is the same where the rest of Maestro shows what needs you: the
// asks that wait on you (blocking, or recommending what cannot be undone),
// which the header count counts.

import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type MutableRefObject, type ReactNode, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, Easing, Platform, Pressable, Text, View } from "react-native";
import { attentionWork } from "../shared/contracts";
import {
  ANSWER_NOTE_CHARS,
  type AnswerWhere,
  type AskNotice,
  answerAsk,
  type DecisionAsk,
  getWorkspaceAsks,
  homeKey,
  type WorkspaceAsksView,
} from "../shared/fleet";
import {
  answeredLine,
  answerVerb,
  askKey,
  askNoticeText,
  BATCHED_TEXT,
  currentIndex,
  type DecisionGroup,
  fallbackLine,
  groupDecisions,
  groupMeta,
  headlineOf,
  isTriaged,
  ledgerName,
  ledgerRail,
  metaLine,
  ORDERINGS,
  type Ordering,
  progressOf,
  recentlyAnswered,
  type TriageKey,
  triageKey,
  triageQueue,
  upNext,
  writtenTo,
} from "./decisions-model";
import { errorText, plural } from "./format";
import { useRefresh } from "./hooks";
import { requestIntent } from "./intent";
import {
  Button,
  Card,
  Kbd,
  Notice,
  ProgressBar,
  radius,
  Section,
  Segmented,
  size,
  space,
  usePressScale,
  useReducedMotion,
  useText,
} from "./ui";

/** Ledgers change when someone answers or an arc commits: a read every 30 s is plenty. */
const POLL_MS = 30_000;
/** Up to this many open asks in all, every ledger opens; past it, only those with an ask that waits on you. */
const ALL_OPEN_UP_TO = 10;
/** The rail lists this many ledgers before "more". */
const RAIL_SHOWN = 8;
/** How long an answered card takes to leave. */
const EXIT_MS = 160;

type Navigation = PluginSurfaceProps["navigation"];

/** Whether two reads name the same ask at the same home. */
export function sameAsk(a: DecisionAsk, b: DecisionAsk): boolean {
  return a.ledger === b.ledger && a.id === b.id && a.uid === b.uid && homeKey(a.home) === homeKey(b.home);
}

const mono = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, monospace" });

/** What the keyboard drives on the card on screen: choose an option, answer. */
export type CardKeys = { choose: (index: number) => void; answer: () => void; options: number };

/** A verb with press feedback: 0.96 while held (none under reduced motion), 44 pt on a phone. */
function Verb({
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
        style={({ pressed }) => ({
          minHeight: compact ? 44 : 36,
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
function Tag({ theme, tone, children }: { theme: PluginTheme; tone: "accent" | "warn" | "success"; children: string }) {
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
function Fold({
  theme,
  label,
  open,
  onToggle,
  accessibilityLabel,
}: {
  theme: PluginTheme;
  label: string;
  open: boolean;
  onToggle: () => void;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      aria-expanded={open}
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onToggle}
      hitSlop={6}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        gap: space[1],
        minHeight: 28,
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
  /** Filled in each render with what the keyboard can drive on this card. */
  keys?: MutableRefObject<CardKeys | null>;
  /** Shows the keys beside what they drive (the web's triage). */
  hints?: boolean;
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
  const [chosen, setChosen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [fullOpen, setFullOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const open = ask.state === "open";
  const option = ask.options.find((entry) => entry.id === chosen) ?? null;
  const hasOptions = ask.options.length > 0;
  const lead = headlineOf(ask);
  const canAnswer = open && !ask.refusal && !answer.isPending && (option !== null || note.trim().length > 0);
  const fallback = fallbackLine(ask);
  const origin = ask.origin;
  const submit = () => {
    if (!canAnswer) return;
    answer.mutate(
      { where, ledger: ask.ledger, uid: ask.uid, id: ask.id, hash: ask.hash, option: chosen, note },
      {
        onSuccess: ({ ask: answered, warning }) => {
          setChosen(null);
          setNote("");
          if (warning) toast.error(warning);
          onAnswered(answered, warning);
        },
        onError: (error) => toast.error(errorText(error)),
      },
    );
  };
  if (keys) {
    keys.current = open
      ? {
          options: ask.options.length,
          choose: (index) => {
            const entry = ask.options[index];
            if (entry && !answer.isPending) setChosen(entry.id);
          },
          answer: submit,
        }
      : null;
  }
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
        {lead.derived && lead.rest ? (
          <View style={{ gap: space[1] }}>
            <Fold
              theme={theme}
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
                style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
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

      {fallback ? (
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space[2] }}>
          <Icon name="VolumeX" size={13} color={theme.colors.foregroundMuted} />
          <Text style={[text.small, { flex: 1 }]}>{fallback}</Text>
        </View>
      ) : null}

      {!open ? (
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
          label="Details"
          open={detailsOpen}
          onToggle={() => setDetailsOpen((now) => !now)}
          accessibilityLabel={`${detailsOpen ? "Hide" : "Show"} the details of ${ask.id}`}
        />
        {detailsOpen ? (
          <View style={{ gap: space[2], paddingLeft: space[4] }}>
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
                {ask.audit.exhausted.map((line) => (
                  <Text key={line} style={text.small} selectable>
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

/** One ledger's asks: its heading (press to fold or open), its open asks, and its answered ones folded under them. */
function LedgerGroup({
  theme,
  group,
  startOpen,
  where,
  compact,
  navigation,
  onAnswered,
}: {
  theme: PluginTheme;
  group: DecisionGroup;
  startOpen: boolean;
  where: (ask: DecisionAsk) => AnswerWhere;
  compact: boolean;
  navigation: Navigation;
  onAnswered: (answered: DecisionAsk) => void;
}) {
  const text = useText(theme);
  // Your own fold or open holds; until you choose, a ledger opens once an ask in it waits on you.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? startOpen;
  const [answeredOpen, setAnsweredOpen] = useState(false);
  // Asks you answered here stay where you answered them, saying so, rather than folding away at once.
  const [answeredHere, setAnsweredHere] = useState<ReadonlySet<string>>(() => new Set());
  const meta = groupMeta(group);
  const answered = (ask: DecisionAsk) => {
    setAnsweredHere((now) => new Set([...now, askKey(ask)]));
    // Its last open ask answered, a ledger would fold under you: it stays as you had it, open.
    setChosen((now) => now ?? true);
    onAnswered(ask);
  };
  const stay = group.answered.filter((ask) => answeredHere.has(askKey(ask)));
  const folded = group.answered.filter((ask) => !answeredHere.has(askKey(ask)));
  const card = (ask: DecisionAsk) => (
    <DecisionCard
      key={askKey(ask)}
      theme={theme}
      ask={ask}
      where={where(ask)}
      compact={compact}
      navigation={navigation}
      onAnswered={answered}
    />
  );
  return (
    <View style={{ gap: space[2] }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        accessibilityLabel={`${group.ledger}: ${meta}`}
        onPress={() => setChosen(!open)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "baseline",
          gap: space[2],
          flexWrap: "wrap",
          paddingVertical: space[1],
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <Text style={[text.small, { fontWeight: "600", color: theme.colors.foreground }]}>
          {`${open ? "▾" : "▸"} ${group.arc ?? group.ledger}`}
        </Text>
        <Text style={[text.small, { color: group.waiting > 0 ? theme.colors.statusWarning : undefined }]}>{meta}</Text>
      </Pressable>
      {open ? (
        <View style={{ gap: space[2] }}>
          {group.open.map(card)}
          {stay.map(card)}
          {folded.length > 0 ? (
            <View style={{ flexDirection: "row" }}>
              <Button
                theme={theme}
                variant="quiet"
                icon={answeredOpen ? "ChevronUp" : "ChevronDown"}
                label={answeredOpen ? "Hide the answered" : `Show ${folded.length} answered`}
                compact={compact}
                accessibilityLabel={`${answeredOpen ? "Hide" : "Show"} the answered asks in ${group.ledger}`}
                onPress={() => setAnsweredOpen((now) => !now)}
              />
            </View>
          ) : null}
          {answeredOpen ? folded.map(card) : null}
        </View>
      ) : null}
    </View>
  );
}

/** A fleet scope's asks, a ledger at a time: ledgers with an ask that waits on you first and open, the rest folded once there are many. */
export function DecisionGroups({
  theme,
  asks,
  where,
  compact,
  navigation,
  onAnswered,
  focus = null,
}: {
  theme: PluginTheme;
  asks: readonly DecisionAsk[];
  where: (ask: DecisionAsk) => AnswerWhere;
  compact: boolean;
  navigation: Navigation;
  onAnswered: (answered: DecisionAsk) => void;
  /** A ledger to open whatever else is folded. */
  focus?: string | null;
}) {
  const groups = groupDecisions(asks);
  // Judged once, as you open the view: a count crossing ten as you answer or as asks arrive never folds or opens it all.
  const [many] = useState(() => groups.reduce((sum, group) => sum + group.open.length, 0) > ALL_OPEN_UP_TO);
  return (
    <View style={{ gap: space[3] }}>
      {groups.map((group) => (
        <LedgerGroup
          key={group.ledger}
          theme={theme}
          group={group}
          startOpen={group.ledger === focus || group.waiting > 0 || (group.open.length > 0 && !many)}
          where={where}
          compact={compact}
          navigation={navigation}
          onAnswered={onAnswered}
        />
      ))}
    </View>
  );
}

export function useWorkspaceAsks() {
  const get = useRpc(getWorkspaceAsks);
  return useQuery({ queryKey: ["maestro", "workspace-asks"], queryFn: () => get({}), refetchInterval: POLL_MS });
}

const workspaceWhere = (ask: DecisionAsk): AnswerWhere => ({ kind: "workspace", home: homeKey(ask.home) });

/** The workspace's open decisions (ideas aside) and how many wait on you: the Decisions tab's badge. */
export function useDecisionCounts(): { open: number; waiting: number } {
  const read = useWorkspaceAsks();
  const open = (read.data?.decisions ?? []).filter(isTriaged);
  return { open: open.length, waiting: open.filter((ask) => ask.waiting).length };
}

/**
 * The workspace's decisions in a few lines, for a view that is not Decisions:
 * how many are open across how many ledgers, how many wait on you, and a way
 * to the Decisions tab, where they are answered one at a time.
 */
export function WorkspaceDecisions({
  theme,
  compact,
  focus = null,
}: {
  theme: PluginTheme;
  compact: boolean;
  navigation?: Navigation;
  /** A ledger to open the tab at. */
  focus?: string | null;
}) {
  const text = useText(theme);
  const read = useWorkspaceAsks();
  if (!read.data) return null;
  const rail = ledgerRail(read.data.decisions);
  const open = rail.reduce((sum, entry) => sum + entry.open, 0);
  if (open === 0) return null;
  const waiting = rail.reduce((sum, entry) => sum + entry.waiting, 0);
  return (
    <Section
      theme={theme}
      title="Workspace decisions"
      meta={[
        `${open} open across ${plural(rail.length, "ledger")}`,
        waiting > 0 ? `${waiting} ${waiting === 1 ? "waits" : "wait"} on you` : null,
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      <Text style={text.small}>They are not the fleet's: they have their own tab, one decision at a time.</Text>
      <View style={{ flexDirection: "row" }}>
        <Button
          theme={theme}
          icon="ArrowRight"
          label="Triage decisions"
          compact={compact}
          onPress={() => requestIntent({ kind: "decisions", ledger: focus, id: null })}
        />
      </View>
    </Section>
  );
}

/**
 * Where the Decisions tab opens: the ledger it lists (null: all), the ask it
 * shows first (its ledger and id), and when it was asked, so a second request
 * while open is taken too.
 */
export type DecisionsFocus = { ledger: string | null; ask: { ledger: string | null; id: string } | null; at: number };

/** A ledger in the rail: its name, its open count, and a warn dot only where an ask waits on you. */
function RailRow({
  theme,
  label,
  open,
  waiting,
  selected,
  onPress,
  accessibilityLabel,
  compact,
}: {
  theme: PluginTheme;
  label: string;
  open: number;
  waiting: number;
  selected: boolean;
  onPress: () => void;
  accessibilityLabel: string;
  compact: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      {...{ "aria-pressed": selected }}
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: space[2],
        minHeight: compact ? 44 : 32,
        paddingHorizontal: space[2] + 2,
        borderRadius: radius.control,
        backgroundColor: selected || pressed || hovered ? theme.colors.surface2 : "transparent",
      })}
    >
      <Text
        numberOfLines={1}
        style={{
          flex: 1,
          color: selected ? theme.colors.foreground : theme.colors.foregroundMuted,
          fontSize: size.xs,
          fontWeight: selected ? "600" : "400",
          fontFamily: label === "All" ? undefined : mono,
        }}
      >
        {label}
      </Text>
      {waiting > 0 ? (
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.statusWarning }} />
      ) : null}
      <Text
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: size.xs,
          fontVariant: ["tabular-nums"],
          minWidth: 16,
          textAlign: "right",
        }}
      >
        {open}
      </Text>
    </Pressable>
  );
}

const railLabel = (name: string, open: number, waiting: number) =>
  `${name}: ${open} open${waiting > 0 ? `, ${waiting} ${waiting === 1 ? "waits" : "wait"} on you` : ""}`;

type KeyEvent = {
  key: string;
  target: unknown;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  preventDefault(): void;
};
type KeyTarget = {
  addEventListener(type: "keydown", listener: (event: KeyEvent) => void, capture: boolean): void;
  removeEventListener(type: "keydown", listener: (event: KeyEvent) => void, capture: boolean): void;
};

/** Whether a key press comes from somewhere you type. */
function typingIn(target: unknown): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  const tag = el?.tagName?.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable === true;
}

/** Whether a key press comes from a control where Enter presses that control: any but an option of the card. */
function onAControl(target: unknown): boolean {
  const el = target as { closest?: (selector: string) => { getAttribute(name: string): string | null } | null } | null;
  if (!el?.closest) return false;
  const control = el.closest('[role="button"],[role="tab"],[role="menuitem"],[role="link"],a,button,[role="radio"]');
  if (!control) return false;
  const group = el.closest('[role="radiogroup"]');
  return !group?.getAttribute("aria-label")?.startsWith("Options for");
}

/**
 * The Decisions tab: the workspace's open asks one at a time. "Decision N of
 * M" and a thin bar, the order (Blocking first, Oldest, By ledger), a rail of
 * ledgers with their open counts (a warn dot only where an ask waits on you),
 * the one card, and the next three. On the web, 1–4 choose, Enter answers, S
 * skips and J/K move, never while you type. An answered card leaves (160 ms,
 * none under reduced motion) and the next comes up; what you answered says so
 * above it, with where it was written. There is no undo: an answer is in the
 * ledger once it is written.
 */
export function DecisionsView({
  theme,
  compact,
  navigation,
  focus = null,
}: {
  theme: PluginTheme;
  compact: boolean;
  navigation: Navigation;
  /** Open at a ledger, and at an ask in it (from an initiative's waiting_on, or Needs you). */
  focus?: DecisionsFocus | null;
}) {
  const text = useText(theme);
  const client = useQueryClient();
  const read = useWorkspaceAsks();
  const reduced = useReducedMotion();
  const [ordering, setOrdering] = useState<Ordering>("blocking");
  const [ledger, setLedger] = useState<string | null>(focus?.ledger ?? null);
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [lastIndex, setLastIndex] = useState(0);
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set());
  const [status, setStatus] = useState<
    { kind: "answered"; ask: DecisionAsk; warning: string | null } | { kind: "skipped"; ask: DecisionAsk } | null
  >(null);
  const [railAll, setRailAll] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [answeredOpen, setAnsweredOpen] = useState(false);
  const [pending, setPending] = useState<DecisionsFocus | null>(focus);
  const [seen, setSeen] = useState(focus?.at ?? null);
  // Opened again at another ask while mounted: that one.
  if (focus && focus.at !== seen) {
    setSeen(focus.at);
    setPending(focus);
    setLedger(focus.ledger);
  }
  const fade = useRef(new Animated.Value(1)).current;
  const lift = useRef(new Animated.Value(0)).current;
  const keys = useRef<CardKeys | null>(null);

  const all = (read.data?.decisions ?? []).filter((ask) => !ask.idea);
  const rail = ledgerRail(all);
  // A ledger with nothing open is no filter: all of them.
  const ledgerShown = ledger !== null && rail.some((entry) => entry.ledger === ledger) ? ledger : null;
  const queue = triageQueue(all, { ordering, ledger: ledgerShown, skipped });
  // A focus is taken once the asks are read: the ask it names, wherever the order puts it.
  if (pending && read.data) {
    setPending(null);
    const want = pending.ask;
    const target = want
      ? queue.find((ask) => ask.id === want.id && (want.ledger === null || ask.ledger === want.ledger))
      : undefined;
    if (target) setCurrentKey(askKey(target));
    else setLastIndex(0);
  }
  const index = currentIndex(queue, currentKey, lastIndex);
  const current = index >= 0 ? (queue[index] ?? null) : null;
  const next = upNext(queue, index);
  const progress = progressOf(index, queue.length);
  const totalOpen = rail.reduce((sum, entry) => sum + entry.open, 0);
  const totalWaiting = rail.reduce((sum, entry) => sum + entry.waiting, 0);
  const answeredList = recentlyAnswered(all);

  const go = (at: number) => {
    const target = queue[at];
    if (!target) return;
    setCurrentKey(askKey(target));
    setLastIndex(at);
  };
  const skip = () => {
    if (!current) return;
    const following = queue[index + 1] ?? null;
    setSkipped((now) => new Set([...now, askKey(current)]));
    setStatus({ kind: "skipped", ask: current });
    setCurrentKey(following ? askKey(following) : askKey(current));
    setLastIndex(index);
  };
  const commit = (answered: DecisionAsk) => {
    client.setQueriesData<WorkspaceAsksView>({ queryKey: ["maestro", "workspace-asks"] }, (view) =>
      view ? { ...view, decisions: view.decisions.map((ask) => (sameAsk(ask, answered) ? answered : ask)) } : view,
    );
  };
  const onAnswered = (answered: DecisionAsk, warning: string | null) => {
    setStatus({ kind: "answered", ask: answered, warning });
    setLastIndex(index);
    if (reduced) {
      commit(answered);
      return;
    }
    // The card leaves softly, then the next one is simply there.
    const native = Platform.OS !== "web";
    Animated.parallel([
      Animated.timing(fade, {
        toValue: 0,
        duration: EXIT_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: native,
      }),
      Animated.timing(lift, {
        toValue: -6,
        duration: EXIT_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: native,
      }),
    ]).start(() => {
      commit(answered);
      fade.setValue(1);
      lift.setValue(0);
    });
  };

  // The keys, on the web: read through refs, so the listener is added once.
  const act = useRef<(key: TriageKey) => void>(() => undefined);
  act.current = (key) => {
    if (key.kind === "choose") keys.current?.choose(key.index);
    else if (key.kind === "answer") keys.current?.answer();
    else if (key.kind === "skip") skip();
    else if (key.kind === "next") go(Math.min(index + 1, queue.length - 1));
    else go(Math.max(index - 1, 0));
  };
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const doc = (globalThis as { document?: KeyTarget }).document;
    if (!doc) return;
    const onKey = (event: KeyEvent) => {
      const key = triageKey(event, {
        typing: typingIn(event.target),
        onControl: onAControl(event.target),
        options: keys.current?.options ?? 0,
      });
      if (!key) return;
      event.preventDefault();
      act.current(key);
    };
    // In the capture phase, before a focused option takes Enter as a press of itself (it would only choose it again).
    doc.addEventListener("keydown", onKey, true);
    return () => doc.removeEventListener("keydown", onKey, true);
  }, []);

  if (read.isPending) return <ActivityIndicator color={theme.colors.foregroundMuted} />;
  if (read.isError) {
    return (
      <View style={{ gap: space[3] }}>
        <Notice theme={theme} tone="danger">
          {`Your workspace's asks could not be read: ${errorText(read.error)}`}
        </Notice>
        <View style={{ flexDirection: "row" }}>
          <Button theme={theme} label="Try again" compact={compact} onPress={() => void read.refetch()} />
        </View>
      </View>
    );
  }
  const { controlRepo, warnings } = read.data;
  const hints = Platform.OS === "web" && !compact;
  // A new order starts at its first decision.
  const reorder = (next: Ordering) => {
    setOrdering(next);
    setCurrentKey(null);
    setLastIndex(0);
  };
  const choose = (entry: string | null) => {
    setLedger(entry);
    setCurrentKey(null);
    setLastIndex(0);
    setPickerOpen(false);
  };
  const shownRail =
    railAll || rail.length <= RAIL_SHOWN
      ? rail
      : rail.filter((entry, at) => at < RAIL_SHOWN || entry.ledger === ledgerShown);
  const hidden = rail.filter((entry) => !shownRail.includes(entry));
  const hiddenOpen = hidden.reduce((sum, entry) => sum + entry.open, 0);

  const header = (
    <View
      style={{
        flexDirection: compact ? "column" : "row",
        alignItems: compact ? "stretch" : "flex-end",
        gap: space[3],
      }}
    >
      <View style={{ flex: compact ? undefined : 1, gap: space[2] }}>
        <Text accessibilityRole="header" style={[text.title, text.tabular]}>
          {progress.text}
        </Text>
        <View style={{ maxWidth: compact ? undefined : 420 }}>
          <ProgressBar theme={theme} fraction={progress.fraction} />
        </View>
        <Text style={[text.small, text.tabular]}>
          {[
            `${totalOpen} open`,
            totalWaiting > 0 ? `${totalWaiting} ${totalWaiting === 1 ? "waits" : "wait"} on you` : null,
            skipped.size > 0 ? `${skipped.size} skipped` : null,
            compact ? null : `from ${controlRepo}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      </View>
      <Segmented
        theme={theme}
        label="Order"
        options={ORDERINGS}
        value={ordering}
        onChange={reorder}
        compact={compact}
      />
    </View>
  );

  const statusLine = status ? (
    <View
      accessibilityRole="alert"
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: space[2],
        padding: space[3],
        borderRadius: radius.control,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <Icon
        name={status.kind === "answered" ? "CircleCheck" : "SkipForward"}
        size={16}
        color={status.kind === "answered" ? theme.colors.statusSuccess : theme.colors.foregroundMuted}
      />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[text.body, { fontSize: 13 }]}>
          {status.kind === "answered"
            ? `${answeredLine(status.ask)} · ${ledgerName(status.ask.ledger)} ${status.ask.id}`
            : `Skipped ${ledgerName(status.ask.ledger)} ${status.ask.id}: it comes back at the end of the queue.`}
        </Text>
        {status.kind === "answered" ? (
          <Text style={text.small}>
            {status.ask.batched ? BATCHED_TEXT : `${writtenTo(status.ask)}. Answers are not undone here.`}
          </Text>
        ) : null}
        {status.kind === "answered" && status.warning ? (
          <Text style={[text.small, { color: theme.colors.statusWarning }]}>{status.warning}</Text>
        ) : null}
      </View>
    </View>
  ) : null;

  const ledgerPicker = compact ? (
    <View style={{ gap: space[1] }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: pickerOpen }}
        aria-expanded={pickerOpen}
        accessibilityLabel={`Ledger: ${ledgerShown ?? "All"}. Change ledger`}
        onPress={() => setPickerOpen((now) => !now)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: space[2],
          minHeight: 44,
          paddingHorizontal: space[3],
          borderRadius: radius.control,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: pressed ? theme.colors.surface2 : theme.colors.surface1,
        })}
      >
        <Text style={text.label}>Ledger</Text>
        <Text
          numberOfLines={1}
          style={[text.body, { flex: 1, fontFamily: ledgerShown ? mono : undefined, fontSize: 13 }]}
        >
          {ledgerShown ? ledgerName(ledgerShown) : "All"}
        </Text>
        <Text style={[text.small, text.tabular]}>{queue.length}</Text>
        <Icon name={pickerOpen ? "ChevronUp" : "ChevronDown"} size={16} color={theme.colors.foregroundMuted} />
      </Pressable>
      {pickerOpen ? (
        <View
          style={{
            padding: space[1],
            borderRadius: radius.card,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
          }}
        >
          <RailRow
            theme={theme}
            label="All"
            open={totalOpen}
            waiting={totalWaiting}
            selected={ledgerShown === null}
            compact
            accessibilityLabel={railLabel("All ledgers", totalOpen, totalWaiting)}
            onPress={() => choose(null)}
          />
          {rail.map((entry) => (
            <RailRow
              key={entry.ledger}
              theme={theme}
              label={ledgerName(entry.ledger)}
              open={entry.open}
              waiting={entry.waiting}
              selected={entry.ledger === ledgerShown}
              compact
              accessibilityLabel={railLabel(entry.ledger, entry.open, entry.waiting)}
              onPress={() => choose(entry.ledger)}
            />
          ))}
        </View>
      ) : null}
    </View>
  ) : null;

  const railView = compact ? null : (
    <View style={{ width: 220, gap: 2 }}>
      <Text style={[text.label, { letterSpacing: 0.6, paddingHorizontal: space[2] + 2, paddingBottom: space[1] }]}>
        LEDGERS
      </Text>
      <RailRow
        theme={theme}
        label="All"
        open={totalOpen}
        waiting={totalWaiting}
        selected={ledgerShown === null}
        compact={false}
        accessibilityLabel={railLabel("All ledgers", totalOpen, totalWaiting)}
        onPress={() => choose(null)}
      />
      {shownRail.map((entry) => (
        <RailRow
          key={entry.ledger}
          theme={theme}
          label={ledgerName(entry.ledger)}
          open={entry.open}
          waiting={entry.waiting}
          selected={entry.ledger === ledgerShown}
          compact={false}
          accessibilityLabel={railLabel(entry.ledger, entry.open, entry.waiting)}
          onPress={() => choose(entry.ledger)}
        />
      ))}
      {hidden.length > 0 || railAll ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={railAll ? "Show fewer ledgers" : `Show ${hidden.length} more ledgers`}
          onPress={() => setRailAll((now) => !now)}
          style={({ pressed }) => ({
            minHeight: 32,
            justifyContent: "center",
            paddingHorizontal: space[2] + 2,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Text style={[text.small, text.tabular]}>
            {railAll
              ? "Show fewer"
              : `+ ${hidden.length} more${hidden.some((entry) => entry.waiting > 0) ? ", one waits on you" : ""} · ${hiddenOpen} open`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );

  const upNextView =
    next.length > 0 ? (
      <View style={{ gap: space[1] }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
          <Text style={[text.label, { letterSpacing: 0.6, flex: 1 }]}>UP NEXT</Text>
          {hints ? (
            <>
              <Kbd theme={theme}>J</Kbd>
              <Kbd theme={theme}>K</Kbd>
              <Text style={text.small}>move</Text>
            </>
          ) : null}
        </View>
        {next.map((ask, at) => (
          <Pressable
            key={askKey(ask)}
            accessibilityRole="button"
            accessibilityLabel={`Go to ${ask.id} in ${ask.ledger}: ${headlineOf(ask).headline}`}
            onPress={() => go(index + 1 + at)}
            style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
              flexDirection: compact ? "column" : "row",
              alignItems: compact ? "flex-start" : "center",
              gap: compact ? 2 : space[3],
              minHeight: 44,
              paddingVertical: space[2],
              paddingHorizontal: space[2],
              borderRadius: radius.control,
              backgroundColor: pressed || hovered ? theme.colors.surface2 : "transparent",
            })}
          >
            <Text numberOfLines={2} style={[text.body, { flex: compact ? undefined : 1, fontSize: 13 }]}>
              {`${ask.waiting ? "● " : ""}${headlineOf(ask).headline}`}
            </Text>
            <Text numberOfLines={1} style={[text.small, { fontFamily: mono }]}>
              {`${ledgerName(ask.ledger)} · ${ask.id}`}
            </Text>
          </Pressable>
        ))}
      </View>
    ) : null;

  const answeredView =
    answeredList.length > 0 ? (
      <View style={{ gap: space[2] }}>
        <Fold
          theme={theme}
          label={answeredOpen ? "Hide the recently answered" : `Recently answered · ${answeredList.length}`}
          open={answeredOpen}
          onToggle={() => setAnsweredOpen((now) => !now)}
        />
        {answeredOpen
          ? answeredList.map((ask) => (
              <View key={askKey(ask)} style={{ gap: 2, paddingLeft: space[4] }}>
                <Text style={[text.body, { fontSize: 13 }]}>{headlineOf(ask).headline}</Text>
                <Text style={[text.small, { color: theme.colors.statusSuccess }]}>
                  {`${answeredLine(ask)} · ${ledgerName(ask.ledger)} ${ask.id}`}
                </Text>
                {ask.answer ? (
                  <Text style={text.small} selectable>
                    {ask.answer}
                  </Text>
                ) : null}
                {ask.batched ? <Text style={text.small}>{BATCHED_TEXT}</Text> : null}
              </View>
            ))
          : null}
      </View>
    ) : null;

  const main = (
    <View style={{ flex: 1, gap: space[4], minWidth: 0 }}>
      {ledgerPicker}
      {statusLine}
      {current ? (
        <Animated.View key={askKey(current)} style={{ opacity: fade, transform: [{ translateY: lift }] }}>
          <DecisionCard
            theme={theme}
            ask={current}
            where={workspaceWhere(current)}
            compact={compact}
            navigation={navigation}
            onAnswered={onAnswered}
            onSkip={queue.length > 1 ? skip : undefined}
            keys={keys}
            hints={hints}
          />
        </Animated.View>
      ) : (
        <Card theme={theme}>
          <Text style={text.title}>
            {ledgerShown ? `Nothing open in ${ledgerName(ledgerShown)}` : "Nothing to decide"}
          </Text>
          <Text style={text.muted}>
            {ledgerShown
              ? "Every ask in this ledger is answered."
              : `No open asks in the ledgers of ${controlRepo}. New ones show here as agents write them.`}
          </Text>
        </Card>
      )}
      {upNextView}
      {answeredView}
    </View>
  );

  return (
    <View style={{ gap: space[4] }}>
      {header}
      {warnings.slice(0, 3).map((warning) => (
        <Notice key={warning} theme={theme} tone="warn">
          {warning}
        </Notice>
      ))}
      {compact ? (
        main
      ) : (
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space[5] }}>
          {railView}
          {main}
        </View>
      )}
    </View>
  );
}

/**
 * The decision asks that wait on you, where Maestro shows what needs you, from
 * work.attention: exactly what the header count counts for them. Open
 * Decisions goes to the Decisions tab for the workspace's, at the first one,
 * and to the Fleet view for a fleet scope's.
 */
export function AskNotices({
  theme,
  compact,
  onOpen,
}: {
  theme: PluginTheme;
  compact: boolean;
  onOpen: (notice: AskNotice) => void;
}) {
  const read = useRpc(attentionWork);
  const attention = useQuery({
    queryKey: ["maestro", "attention"],
    queryFn: () => read({}),
    refetchInterval: POLL_MS,
  });
  const asks = attention.data?.asks ?? [];
  const [first] = asks;
  if (!first) return null;
  return (
    <Notice
      theme={theme}
      tone="warn"
      action={
        <Button
          theme={theme}
          icon="Inbox"
          label="Open Decisions"
          compact={compact}
          accessibilityLabel={`Open Decisions, ${asks.length} waiting`}
          onPress={() => onOpen(first)}
        />
      }
    >
      {askNoticeText(asks)}
    </Notice>
  );
}
