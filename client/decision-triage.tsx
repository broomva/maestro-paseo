// The Decisions tab: the workspace's open asks one at a time (design draft C,
// BRO-2838). The card on screen is pinned to its ask's full identity (askKey:
// home, ledger, uid, id) the moment it shows: a poll, another client or an
// answer elsewhere never swaps it for another. An ask answered elsewhere stays
// on screen, read-only, saying so, until you go on. Your choice and words are
// held per ask, so a remount never loses them. Keys act only inside the tab.

import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, Easing, Platform, Pressable, Text, View } from "react-native";
import { type AnswerWhere, type DecisionAsk, homeKey, type WorkspaceAsksView } from "../shared/fleet";
import { type CardKeys, DecisionCard, type Draft, EMPTY_DRAFT, mono } from "./decision-card";
import { useWorkspaceAsks } from "./decisions";
import {
  answeredLine,
  askKey,
  BATCHED_TEXT,
  cutAtWord,
  headlineOf,
  ledgerName,
  ledgerRail,
  matchFocus,
  nextAfter,
  ORDERINGS,
  type Ordering,
  progressOf,
  pruneSkipped,
  railName,
  railOverflow,
  recentlyAnswered,
  sameAsk,
  type TriageKey,
  triageKey,
  triageQueue,
  upNext,
  writtenTo,
} from "./decisions-model";
import { errorText } from "./format";
import {
  Button,
  Card,
  focusRing,
  Kbd,
  Notice,
  ProgressBar,
  radius,
  Segmented,
  size,
  space,
  useReducedMotion,
  useText,
} from "./ui";

type Navigation = PluginSurfaceProps["navigation"];

/** The rail lists this many ledgers before "more". */
const RAIL_SHOWN = 8;
/** How long an answered card takes to leave. */
const EXIT_MS = 160;
/** The tab's root, which takes focus so its keys stay its own. */
export const DECISIONS_ROOT_ID = "maestro-decisions";

/**
 * Where the Decisions tab opens: the ledger it lists (null: all), the ask it
 * shows first (as much of its identity as the caller knows: ledger and id, and
 * its uid and home when known), and when it was asked, so a second request
 * while open is taken too.
 */
export type DecisionsFocus = {
  ledger: string | null;
  ask: { ledger: string | null; id: string; uid?: string | null; home?: string | null } | null;
  at: number;
};

const workspaceWhere = (ask: DecisionAsk): AnswerWhere => ({ kind: "workspace", home: homeKey(ask.home) });

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
      style={({ pressed, hovered, focused }: { pressed: boolean; hovered?: boolean; focused?: boolean }) => ({
        ...focusRing(theme, focused),
        flexDirection: "row",
        alignItems: "center",
        gap: space[2],
        minHeight: compact ? 44 : 40,
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
type DomNode = { contains?(other: unknown): boolean; focus?(options?: { preventScroll?: boolean }): void };

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
 * A card on its way out: its own fade and lift (never shared with the next
 * card), 160 ms; with `leaving` unset it simply shows. Reduced motion skips the
 * animation and calls onDone at once.
 */
function ExitCard({
  leaving,
  reduced,
  onDone,
  children,
}: {
  leaving: boolean;
  reduced: boolean;
  onDone: () => void;
  children: ReactNode;
}) {
  const fade = useRef(new Animated.Value(1)).current;
  const lift = useRef(new Animated.Value(0)).current;
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!leaving) return;
    if (reduced) {
      done.current();
      return;
    }
    const native = Platform.OS !== "web";
    const easing = Easing.out(Easing.quad);
    const run = Animated.parallel([
      Animated.timing(fade, { toValue: 0, duration: EXIT_MS, easing, useNativeDriver: native }),
      Animated.timing(lift, { toValue: -6, duration: EXIT_MS, easing, useNativeDriver: native }),
    ]);
    // Stopped short (unmounted, or reduced motion turned on, which calls onDone itself): nothing more.
    run.start(({ finished }) => {
      if (finished) done.current();
    });
    return () => run.stop();
  }, [leaving, reduced, fade, lift]);
  return <Animated.View style={{ opacity: fade, transform: [{ translateY: lift }] }}>{children}</Animated.View>;
}

type Status =
  | { kind: "answered"; ask: DecisionAsk; warning: string | null }
  | { kind: "skipped"; ask: DecisionAsk }
  | null;

/**
 * The Decisions tab. "Decision N of M" counts this visit: M is every ask it
 * has had in its queue, N the ones handled (answered or skipped) plus the one
 * on screen, and the bar is what is handled. The order (Blocking first,
 * Oldest, By ledger) and the ledger rail (a warn dot only where an ask waits on
 * you) each start at their first decision. On the web, 1–4 choose, Enter
 * answers, S skips and J/K move, only while focus is in the tab and never
 * while you type. An answered card leaves (160 ms, none under reduced motion)
 * and the next comes up; the line above the card says what you answered.
 * There is no undo: an answer is in the ledger once it is written.
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
  const [pinned, setPinned] = useState<{ key: string; ask: DecisionAsk } | null>(null);
  const [lastIndex, setLastIndex] = useState(0);
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set());
  const [drafts, setDrafts] = useState<Readonly<Record<string, Draft>>>({});
  const [leaving, setLeaving] = useState<{ key: string; ask: DecisionAsk; at: number } | null>(null);
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
  const [status, setStatus] = useState<Status>(null);
  const [pending, setPending] = useState<DecisionsFocus | null>(focus);
  const [railAll, setRailAll] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [answeredOpen, setAnsweredOpen] = useState(false);
  const keys = useRef<CardKeys | null>(null);
  const root = useRef<View>(null);

  const all = (read.data?.decisions ?? []).filter((ask) => !ask.idea);
  const rail = ledgerRail(all);
  // A ledger with nothing open is no filter: all of them.
  const ledgerShown = ledger !== null && rail.some((entry) => entry.ledger === ledger) ? ledger : null;
  const queue = triageQueue(all, { ordering, ledger: ledgerShown, skipped });
  const queueRef = useRef(queue);
  queueRef.current = queue;

  // The card on screen: the one leaving, else the pinned ask, else (before the pin lands) the focus's or the first.
  const focusTarget = pending?.ask && read.data ? matchFocus(queue, pending.ask) : null;
  const shownKey = leaving?.key ?? pinned?.key ?? (focusTarget ? askKey(focusTarget) : null) ?? null;
  const live = shownKey ? (queue.find((ask) => askKey(ask) === shownKey) ?? null) : null;
  const fallbackFirst = !shownKey && !pending ? (queue[0] ?? null) : null;
  const current = leaving?.ask ?? live ?? pinned?.ask ?? focusTarget ?? fallbackFirst;
  const currentKey = current ? askKey(current) : null;
  const index = currentKey ? queue.findIndex((ask) => askKey(ask) === currentKey) : -1;
  // Answered elsewhere, its home may have moved with it (a checkout's answer, now read on origin/main): same ledger, uid and id.
  const elsewhere = current
    ? all.find(
        (ask) =>
          ask.ledger === current.ledger && ask.uid === current.uid && ask.id === current.id && ask.state !== "open",
      )
    : undefined;
  const frozen =
    current && !leaving && index < 0
      ? elsewhere
        ? "This was answered elsewhere: its answer is in the ledger now. Nothing was sent from here."
        : "This ask is no longer open here: it left its ledger or moved. Nothing was sent from here."
      : null;

  // Pin what shows, the moment it shows: first open, a focus, and after any change of ask.
  useEffect(() => {
    if (!read.data || leaving) return;
    if (pending) {
      setPending(null);
      const target = pending.ask ? matchFocus(queueRef.current, pending.ask) : null;
      const first = target ?? queueRef.current[0] ?? null;
      setPinned(first ? { key: askKey(first), ask: first } : null);
      setLastIndex(0);
      return;
    }
    if (!pinned && current && !frozen) setPinned({ key: askKey(current), ask: current });
  }, [read.data, pending, pinned, current, frozen, leaving]);
  // Keep the pinned snapshot fresh while its ask is open, so a frozen card shows the last words read.
  useEffect(() => {
    if (pinned && live && live !== pinned.ask && askKey(live) === pinned.key) setPinned({ key: pinned.key, ask: live });
    if (live && index >= 0 && index !== lastIndex) setLastIndex(index);
  }, [pinned, live, index, lastIndex]);
  // A new focus while open: its ledger, and its ask once read.
  const focusAt = focus?.at ?? null;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  useEffect(() => {
    const next = focusRef.current;
    if (focusAt === null || !next) return;
    setLedger(next.ledger);
    setPending(next);
    setLeaving(null);
    setSeen(new Set());
  }, [focusAt]);
  // Every ask this visit has queued counts toward M; skips of asks no longer open are dropped.
  const queueKeys = queue.map(askKey).join("\n");
  useEffect(() => {
    const keysNow = queueKeys ? queueKeys.split("\n") : [];
    setSeen((now) => (keysNow.every((key) => now.has(key)) ? now : new Set([...now, ...keysNow])));
    setSkipped((now) => pruneSkipped(now, queueRef.current));
  }, [queueKeys]);

  // Focus the tab when it opens, so its keys are its own.
  useEffect(() => {
    (root.current as unknown as DomNode | null)?.focus?.({ preventScroll: true });
  }, []);

  const pin = (ask: DecisionAsk | null, at = 0) => {
    setPinned(ask ? { key: askKey(ask), ask } : null);
    setLastIndex(at);
  };
  const go = (at: number) => {
    const target = queue[at];
    if (target) pin(target, at);
  };
  const leave = () => pin(nextAfter(queue, currentKey, index < 0 ? lastIndex : index), index < 0 ? lastIndex : index);
  const skip = () => {
    if (!current || !currentKey) return;
    setSkipped((now) => new Set([...now, currentKey]));
    setStatus({ kind: "skipped", ask: current });
    leave();
  };
  const onAnswered = (answered: DecisionAsk, warning: string | null) => {
    if (!current || !currentKey) return;
    const at = index < 0 ? lastIndex : index;
    setStatus({ kind: "answered", ask: answered, warning });
    setDrafts(({ [currentKey]: _gone, ...rest }) => rest);
    client.setQueriesData<WorkspaceAsksView>({ queryKey: ["maestro", "workspace-asks"] }, (view) =>
      view ? { ...view, decisions: view.decisions.map((ask) => (sameAsk(ask, answered) ? answered : ask)) } : view,
    );
    // The card that leaves is the one you answered, as it read: a refetch landing mid-exit does not change it.
    setLeaving({ key: currentKey, ask: current, at });
  };
  const exitDone = () => {
    const was = leaving;
    if (!was) return;
    setLeaving(null);
    pin(nextAfter(queueRef.current, was.key, was.at), was.at);
    (root.current as unknown as DomNode | null)?.focus?.({ preventScroll: true });
  };
  const reorder = (next: Ordering) => {
    setOrdering(next);
    pin(triageQueue(all, { ordering: next, ledger: ledgerShown, skipped })[0] ?? null);
  };
  const choose = (entry: string | null) => {
    setLedger(entry);
    setSeen(new Set());
    setPickerOpen(false);
    pin(triageQueue(all, { ordering, ledger: entry, skipped })[0] ?? null);
  };

  // The keys, on the web, only from inside the tab: read through refs, so the listener is added once.
  const canSkip = queue.length > 1 && !frozen && !leaving;
  const act = useRef<(key: TriageKey) => void>(() => undefined);
  act.current = (key) => {
    if (leaving) return;
    if (key.kind === "choose") keys.current?.choose(key.index);
    else if (key.kind === "answer") keys.current?.answer();
    else if (key.kind === "skip") skip();
    else if (key.kind === "next") go(Math.min((index < 0 ? lastIndex - 1 : index) + 1, queue.length - 1));
    else go(Math.max((index < 0 ? lastIndex : index) - 1, 0));
  };
  const skipAllowed = useRef(canSkip);
  skipAllowed.current = canSkip;
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const doc = (globalThis as { document?: KeyTarget }).document;
    if (!doc) return;
    const onKey = (event: KeyEvent) => {
      const node = root.current as unknown as DomNode | null;
      if (!node?.contains?.(event.target)) return;
      const key = triageKey(event, {
        typing: typingIn(event.target),
        onControl: onAControl(event.target),
        options: keys.current?.options ?? 0,
        canSkip: skipAllowed.current,
      });
      if (!key) return;
      event.preventDefault();
      act.current(key);
    };
    // In the capture phase, before a focused option takes Enter as a press of itself (it would only choose it again).
    doc.addEventListener("keydown", onKey, true);
    return () => doc.removeEventListener("keydown", onKey, true);
  }, []);

  const rootProps = {
    ref: root,
    nativeID: DECISIONS_ROOT_ID,
    focusable: true,
    accessibilityLabel: "Decisions",
    style: { gap: space[4], outlineWidth: 0 },
  };

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
  const { warnings } = read.data;
  const hints = Platform.OS === "web" && !compact;
  const totalOpen = rail.reduce((sum, entry) => sum + entry.open, 0);
  const totalWaiting = rail.reduce((sum, entry) => sum + entry.waiting, 0);
  const answeredList = recentlyAnswered(all);
  // M: every ask queued this visit; handled: those no longer waiting for you here (answered anywhere, or skipped).
  const visit = new Set([...seen, ...queue.map(askKey)]);
  const waitingHere = queue.filter((ask) => !skipped.has(askKey(ask))).map(askKey);
  const handled = visit.size - waitingHere.length;
  const progress = progressOf(handled, visit.size);
  const next = upNext(queue, index < 0 ? lastIndex - 1 : index);
  const shownRail =
    railAll || rail.length <= RAIL_SHOWN
      ? rail
      : rail.filter((entry, at) => at < RAIL_SHOWN || entry.ledger === ledgerShown);
  const hidden = rail.filter((entry) => !shownRail.includes(entry));

  const statusLine = (
    <View style={{ minHeight: 18, gap: 2 }} accessibilityLiveRegion="polite">
      {status ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
          <Icon
            name={status.kind === "answered" ? "CircleCheck" : "SkipForward"}
            size={14}
            color={status.kind === "answered" ? theme.colors.statusSuccess : theme.colors.foregroundMuted}
          />
          <Text numberOfLines={1} style={[text.small, { flex: 1, color: theme.colors.foreground }]}>
            {status.kind === "answered"
              ? `${answeredLine(status.ask)} · ${ledgerName(status.ask.ledger)} · answers are not undone here`
              : `Skipped “${cutAtWord(headlineOf(status.ask).headline, 60)}”: it comes back at the end of the queue`}
          </Text>
        </View>
      ) : null}
      {status?.kind === "answered" && status.warning ? (
        <Text style={[text.small, { color: theme.colors.statusWarning }]}>{status.warning}</Text>
      ) : null}
    </View>
  );

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
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
        {statusLine}
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

  const ledgerPicker = compact ? (
    <View style={{ gap: space[1] }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: pickerOpen }}
        aria-expanded={pickerOpen}
        accessibilityLabel={`Ledger: ${ledgerShown ?? "All"}. Change ledger`}
        onPress={() => setPickerOpen((now) => !now)}
        style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({
          ...focusRing(theme, focused),
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
          {ledgerShown ? railName(ledgerShown, 30) : "All"}
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
              label={railName(entry.ledger, 34)}
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
          label={railName(entry.ledger)}
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
          style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({
            ...focusRing(theme, focused),
            minHeight: 40,
            justifyContent: "center",
            paddingHorizontal: space[2] + 2,
            borderRadius: radius.control,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Text style={[text.small, text.tabular]}>{railAll ? "Show fewer" : railOverflow(hidden)}</Text>
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
        {next.map((ask) => (
          <Pressable
            key={askKey(ask)}
            accessibilityRole="button"
            accessibilityLabel={`Go to ${ask.id} in ${ask.ledger}: ${headlineOf(ask).headline}`}
            onPress={() => go(queue.indexOf(ask))}
            style={({ pressed, hovered, focused }: { pressed: boolean; hovered?: boolean; focused?: boolean }) => ({
              ...focusRing(theme, focused),
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
              {ledgerName(ask.ledger)}
            </Text>
          </Pressable>
        ))}
      </View>
    ) : null;

  const answeredView =
    answeredList.length > 0 ? (
      <View style={{ gap: space[2] }}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: answeredOpen }}
          aria-expanded={answeredOpen}
          accessibilityLabel={
            answeredOpen ? "Hide the recently answered" : `Recently answered · ${answeredList.length}`
          }
          onPress={() => setAnsweredOpen((now) => !now)}
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
          <Icon name={answeredOpen ? "ChevronDown" : "ChevronRight"} size={14} color={theme.colors.foregroundMuted} />
          <Text style={[text.small, text.tabular, { fontWeight: "600" }]}>
            {answeredOpen ? "Hide the recently answered" : `Recently answered · ${answeredList.length}`}
          </Text>
        </Pressable>
        {answeredOpen
          ? answeredList.map((ask) => (
              <View key={askKey(ask)} style={{ gap: 2, paddingLeft: space[4] }}>
                <Text style={[text.body, { fontSize: 13 }]}>{headlineOf(ask).headline}</Text>
                <Text style={[text.small, { color: theme.colors.statusSuccess }]}>
                  {`${answeredLine(ask)} · ${ledgerName(ask.ledger)}`}
                </Text>
                {ask.answer ? (
                  <Text style={text.small} selectable>
                    {ask.answer}
                  </Text>
                ) : null}
                <Text style={text.small}>{ask.batched ? BATCHED_TEXT : writtenTo(ask)}</Text>
              </View>
            ))
          : null}
      </View>
    ) : null;

  const main = (
    <View style={{ flex: 1, gap: space[4], minWidth: 0 }}>
      {ledgerPicker}
      {current && currentKey ? (
        <ExitCard key={currentKey} leaving={leaving?.key === currentKey} reduced={reduced} onDone={exitDone}>
          <DecisionCard
            theme={theme}
            ask={current}
            where={workspaceWhere(current)}
            compact={compact}
            navigation={navigation}
            onAnswered={onAnswered}
            onSkip={canSkip ? skip : undefined}
            keys={keys}
            hints={hints}
            draft={drafts[currentKey] ?? EMPTY_DRAFT}
            onDraft={(draft) => setDrafts((now) => ({ ...now, [currentKey]: draft }))}
            frozen={frozen}
            onNext={frozen ? leave : undefined}
          />
        </ExitCard>
      ) : (
        <Card theme={theme}>
          <Text style={text.title}>
            {ledgerShown ? `Nothing open in ${ledgerName(ledgerShown)}` : "Nothing to decide"}
          </Text>
          <Text style={text.muted}>
            {ledgerShown
              ? "Every ask in this ledger is answered."
              : "No open asks in your workspace's ledgers. New ones show here as agents write them."}
          </Text>
        </Card>
      )}
      {upNextView}
      {answeredView}
    </View>
  );

  return (
    <View {...rootProps}>
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
