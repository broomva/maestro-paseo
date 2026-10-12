// The decision card: one ask, made easy to decide. Shared by the Decisions
// tab (client/decision-triage.tsx), one at a time with keys, and the Fleet
// view's per-scope ledgers (DecisionGroups in client/decisions.tsx).

import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { type QueryClient, useIsMutating, useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import { type MutableRefObject, type ReactNode, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, Platform, Pressable, Text, View } from "react-native";
import {
  ANSWER_NOTE_CHARS,
  type AnswerWhere,
  answerAsk,
  type DecisionAsk,
  type WorkspaceAsksView,
} from "../shared/fleet";
import { askHoldKey } from "../shared/needs";
import { withinTimeout } from "./answer-timeout";
import {
  answeredLine,
  answerVerb,
  askKey,
  fateLine,
  headlineOf,
  metaLine,
  SILENCE_TAG,
  sameAsk,
  silenceOf,
  writtenTo,
} from "./decisions-model";
import { errorText } from "./format";
import { useRefresh, useVerbLedger } from "./hooks";
import { pendingFor } from "./pending-model";
import { PendingVerbs } from "./pending-verbs";
import { Card, focusRing, Kbd, Notice, radius, size, space, usePressScale, useText } from "./ui";

type Navigation = PluginSurfaceProps["navigation"];

export const mono = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, monospace" });

/** Your choice and your words on one ask, before you answer. */
export type Draft = { chosen: string | null; note: string };
/** Your choice and words per ask (askKey), in the query cache so they outlive this card and its view. */
export type Drafts = Readonly<Record<string, Draft>>;
export const DRAFTS_KEY = ["decision-drafts"];

export const EMPTY_DRAFT: Draft = { chosen: null, note: "" };

/** What the keyboard drives on the card on screen: choose an option, answer, call off an armed confirm. */
export type CardKeys = {
  choose: (index: number) => void;
  answer: () => void;
  cancel: () => void;
  /** Whether a confirm is armed: only then is Escape the card's. */
  armed: () => boolean;
  options: number;
};

/** Every answer in flight carries this key's head; one ask's adds its full identity (askKey). */
export const ANSWER_KEY = ["maestro", "answer"] as const;
const answerKeyOf = (ask: DecisionAsk) => [...ANSWER_KEY, askKey(ask)];
/** An answer's reply, filed under the scope of the copy it stands for (the server's reply carries none). */
const withScope = (reply: DecisionAsk, copy: DecisionAsk): DecisionAsk => ({ ...reply, scope: copy.scope });

/** Whether any answer is in flight, read from the mutation cache at once: a second press in the same frame sees the first. */
export function answerInFlight(client: QueryClient): boolean {
  return client.isMutating({ mutationKey: [...ANSWER_KEY] }) > 0;
}

/** A confirm is taken this long after it is armed, at the soonest: a second Enter in the same breath is not deliberate. */
export const CONFIRM_MS = 400;

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
  variant?: "primary" | "secondary" | "warn";
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
  const warn = variant === "warn";
  const ink = primary ? theme.colors.accentForeground : warn ? theme.colors.surface0 : theme.colors.foreground;
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
          backgroundColor: primary ? theme.colors.accent : warn ? theme.colors.statusWarning : theme.colors.surface2,
          borderWidth: primary || warn ? 0 : 1,
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
/** The answered line's colour: green only once the answer was acted on (or Maestro holds no account of it); amber while it is on its way. */
export function answeredColor(theme: PluginTheme, fate: ReturnType<typeof fateLine>): string {
  if (!fate || fate.tone === "done") return theme.colors.statusSuccess;
  return fate.tone === "waiting" ? theme.colors.statusWarning : theme.colors.foregroundMuted;
}

/**
 * What a decision card does, apart from how it looks: your choice and words, the answer's flight and failure,
 * the deliberate confirm for an option that cannot be undone, and the keys the view can drive. Shared by the
 * card (the phone, the Fleet view's ledgers) and J5's stage (client/decisions-stage.tsx), so the two answer
 * the same way.
 */
export function useDecisionCard({
  ask,
  where,
  onAnswered,
  keys,
  draft,
  onDraft,
  frozen = null,
}: {
  ask: DecisionAsk;
  where: AnswerWhere;
  onAnswered: (answered: DecisionAsk, warning: string | null, queued?: boolean) => void;
  keys?: MutableRefObject<CardKeys | null>;
  draft?: Draft;
  onDraft?: (draft: Draft) => void;
  frozen?: string | null;
}) {
  const toast = useToast();
  const refresh = useRefresh();
  const send = useRpc(answerAsk);
  const client = useQueryClient();
  // These run from the mutation cache, whether or not this card is still on screen when the reply lands:
  // the list learns the answer, and a failure is said.
  const answer = useMutation({
    mutationKey: answerKeyOf(ask),
    mutationFn: (input: Parameters<typeof send>[0]) => withinTimeout(send(input)),
    onSuccess: ({ ask: answered, warning }) => {
      // The draft is spent, whether or not this card is still on screen.
      client.setQueryData<Drafts>(DRAFTS_KEY, (now) => {
        if (!now) return now;
        const { [askKey(ask)]: _spent, ...rest } = now;
        return rest;
      });
      // The list learns it in whichever part holds it, each copy keeping its own list's scope.
      const swap = (one: DecisionAsk) => (sameAsk(one, answered) ? withScope(answered, one) : one);
      client.setQueriesData<WorkspaceAsksView>({ queryKey: ["maestro", "workspace-asks"] }, (view) =>
        view ? { ...view, decisions: view.decisions.map(swap), fleet: view.fleet?.map(swap) } : view,
      );
      if (warning) toast.error(warning);
    },
    onError: (error) => toast.error(errorText(error)),
    onSettled: () => {
      void refresh();
    },
  });
  // Any answer in flight holds every card still; this ask's own, as the mutation cache has it, survives a remount.
  const anyInFlight = useIsMutating({ mutationKey: [...ANSWER_KEY] }) > 0;
  const mine = useMutationState({
    filters: { mutationKey: answerKeyOf(ask) },
    select: (mutation) => ({ status: mutation.state.status, error: mutation.state.error }),
  });
  const last = mine[mine.length - 1] ?? null;
  const pendingHere = last?.status === "pending";
  const failure = last?.status === "error" ? last.error : null;
  const [own, setOwn] = useState<Draft>(EMPTY_DRAFT);
  const current = draft ?? own;
  const setDraft = (next: Draft) => (onDraft ? onDraft(next) : setOwn(next));
  const { chosen, note } = current;
  // An option that cannot be undone takes a second, deliberate press: the first arms the confirm.
  const [confirming, setConfirming] = useState(false);
  const armedAt = useRef<number | null>(null);
  const disarm = () => {
    armedAt.current = null;
    setConfirming(false);
  };
  const setChosen = (id: string) => {
    if (id !== current.chosen) disarm();
    setDraft({ ...current, chosen: id });
  };
  const setNote = (value: string) => setDraft({ ...current, note: value });
  const open = ask.state === "open" && !frozen;
  const fate = fateLine(ask);
  const option = ask.options.find((entry) => entry.id === chosen) ?? null;
  const hasOptions = ask.options.length > 0;
  const lead = headlineOf(ask);
  // Your answer, written 8 s after you give it unless undone (B4): until then the ask stays open, and says so.
  const holdKey = askHoldKey(ask);
  const waiting = pendingFor(useVerbLedger().data?.pending ?? [], [holdKey]).length > 0;
  const canAnswer = open && !ask.refusal && !anyInFlight && !waiting && (option !== null || note.trim().length > 0);
  const silence = silenceOf(ask);
  const origin = ask.origin;
  const submit = () => {
    if (answerInFlight(client) || !canAnswer) return;
    if (option?.reversible === false) {
      const armed = armedAt.current;
      if (armed === null) {
        armedAt.current = Date.now();
        setConfirming(true);
        return;
      }
      if (Date.now() - armed < CONFIRM_MS) return;
    }
    disarm();
    // What follows is this card's own, while it is on screen; what must outlive it is in the hook's callbacks.
    answer.mutate(
      { where, ledger: ask.ledger, uid: ask.uid, id: ask.id, hash: ask.hash, option: chosen, note },
      {
        onSuccess: ({ ask: reply, warning, receipt }) => {
          setDraft(EMPTY_DRAFT);
          // With a receipt the answer is queued: the ask is still open, written when its undo window closes (B4).
          onAnswered(withScope(reply, ask), warning, receipt !== undefined);
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
          if (entry && !answerInFlight(client)) setChosen(entry.id);
        },
        answer: submit,
        cancel: disarm,
        armed: () => armedAt.current !== null,
      }
    : null;
  useEffect(() => {
    if (!keys) return;
    keys.current = drive;
    return () => {
      keys.current = null;
    };
  });
  return {
    open,
    fate,
    option,
    hasOptions,
    lead,
    canAnswer,
    holdKey,
    silence,
    origin,
    submit,
    confirming,
    failure,
    pendingHere,
    anyInFlight,
    chosen,
    note,
    setChosen,
    setNote,
    label: ask.id,
  };
}

/**
 * The audit layer under Details: the ask's id, class, gates, ledger, where the answer is written, and the
 * session that asked. Folded; the card and J5's stage share it.
 */
export function DecisionDetails({
  theme,
  ask,
  lead,
  open,
  compact,
  navigation,
}: {
  theme: PluginTheme;
  ask: DecisionAsk;
  lead: ReturnType<typeof headlineOf>;
  open: boolean;
  compact: boolean;
  navigation: Navigation;
}) {
  const text = useText(theme);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const origin = ask.origin;
  return (
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
          {ask.audit && (ask.audit.gates.length > 0 || (ask.audit.withheld ?? 0) > 0) ? (
            <Fact theme={theme} label="Gates">
              {[
                ask.audit.gates.join(", "),
                (ask.audit.withheld ?? 0) > 0 ? `+${ask.audit.withheld} not shown (free text; see the ledger)` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </Fact>
          ) : null}
          <Fact theme={theme} label="Ledger">
            {`${ask.scope ? `fleet ${ask.scope} · ` : ""}${ask.ledger}${ask.arc ? ` (arc ${ask.arc})` : ""}${ask.uid ? ` · uid ${ask.uid}` : ""}`}
          </Fact>
          {open ? <Text style={text.small}>{writtenTo(ask)}</Text> : null}
          {origin && navigation ? (
            <View style={{ flexDirection: "row" }}>
              <Verb
                theme={theme}
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
  );
}

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
  onAnswered: (answered: DecisionAsk, warning: string | null, queued?: boolean) => void;
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
  const [fullOpen, setFullOpen] = useState(false);
  const {
    open,
    fate,
    option,
    hasOptions,
    lead,
    canAnswer,
    holdKey,
    silence,
    submit,
    confirming,
    failure,
    pendingHere,
    anyInFlight,
    chosen,
    note,
    setChosen,
    setNote,
  } = useDecisionCard({ ask, where, onAnswered, keys, draft, onDraft, frozen });
  const showHints = hints && !compact;
  const label = `${ask.id}`;
  return (
    <Card theme={theme} style={{ gap: space[4], padding: compact ? space[4] : space[5] }}>
      <PendingVerbs theme={theme} compact={compact} keys={[holdKey]} />
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
            const inactive = !open || anyInFlight || Boolean(ask.refusal);
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
          <Text style={[text.small, { color: answeredColor(theme, fate), fontWeight: "600" }]}>
            {answeredLine(ask)}
          </Text>
          {ask.answer ? (
            <Text style={text.small} selectable>
              {ask.answer}
            </Text>
          ) : null}
          {fate ? (
            <Text style={[text.small, fate.tone === "waiting" ? { color: theme.colors.statusWarning } : null]}>
              {fate.words}
            </Text>
          ) : null}
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
          {confirming ? (
            <Text style={[text.small, { color: theme.colors.statusWarning }]}>
              {`“${option?.label ?? ""}” cannot be undone. Press again to send it, or Esc (or another option) to stop.`}
            </Text>
          ) : null}
          {failure ? (
            <Notice theme={theme} tone="danger">
              {`Not answered: ${errorText(failure)}`}
            </Notice>
          ) : null}
          <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap", alignItems: "center" }}>
            <Verb
              theme={theme}
              variant={confirming ? "warn" : "primary"}
              icon={confirming ? "TriangleAlert" : "Check"}
              label={confirming ? "Confirm — cannot be undone" : answerVerb(option, hasOptions, note)}
              compact={compact}
              grow={compact}
              busy={pendingHere}
              disabled={!canAnswer}
              accessibilityLabel={
                confirming
                  ? `Confirm ${ask.id}: ${option?.label ?? ""}, cannot be undone`
                  : `Answer ${ask.id}${option ? `: ${option.label}` : ""}`
              }
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

      <DecisionDetails theme={theme} ask={ask} lead={lead} open={open} compact={compact} navigation={navigation} />
    </Card>
  );
}
