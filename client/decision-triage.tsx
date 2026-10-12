// The Decisions tab: every open ask Maestro reads, the workspace's and each
// fleet scope's own root's (each answered where it lives), one at a time (design draft C,
// BRO-2838). The card on screen is pinned to its ask's full identity (askKey:
// home, ledger, uid, id) the moment it shows: a poll, another client or an
// answer elsewhere never swaps it for another. An ask answered elsewhere stays
// on screen, read-only, saying so, until you go on. Your choice and words are
// held per ask, so a remount never loses them. Keys act only inside the tab.

import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useIsMutating, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, Easing, Platform, Pressable, Text, View } from "react-native";
import type { DecisionAsk } from "../shared/fleet";
import { UNDO_MS } from "../shared/undo";
import { ConductorAnswers } from "./conductor-answers";
import {
  ANSWER_KEY,
  answeredColor,
  answerInFlight,
  type CardKeys,
  DecisionCard,
  DRAFTS_KEY,
  type Drafts,
  EMPTY_DRAFT,
  mono,
  Verb,
} from "./decision-card";
import { useWorkspaceAsks } from "./decisions";
import {
  answeredElsewhere,
  answeredLine,
  askKey,
  cutAtWord,
  decisionAsks,
  fateLine,
  forTheConductor,
  headlineOf,
  isTriaged,
  ledgerName,
  ledgerOf,
  ledgerRail,
  nextAfter,
  ORDERINGS,
  type Ordering,
  progressOf,
  pruneSkipped,
  railName,
  recentlyAnswered,
  resolveFocus,
  type TriageKey,
  triageKey,
  triageQueue,
  upNext,
  whereOf,
  writtenTo,
} from "./decisions-model";
import { StageCard, StageControls, StageSide, StageTilesRow } from "./decisions-stage";
import { progressSegments, stageProgress, stageTiles, upNextRow, wentRows } from "./decisions-stage-model";
import { basename, errorText } from "./format";
import { useAnswersStatus, useNeeds } from "./hooks";
import { useOpenUrl } from "./open-url";
import {
  Card,
  focusRing,
  Kbd,
  Notice,
  ProgressBar,
  radius,
  Segmented,
  size,
  space,
  typingIn,
  useReducedMotion,
  useText,
} from "./ui";
import { useTick } from "./use-tick";

type Navigation = PluginSurfaceProps["navigation"];

/** Where drafts are kept: outside ["maestro"], so a refresh of every read leaves them be. */

/** The rail lists this many ledgers before "more". */
const _RAIL_SHOWN = 8;
/** How long an answered card takes to leave. */
const EXIT_MS = 160;
/** The workspace an ask belongs to, as needs.list scopes its hold: its fleet scope, else the control repo's folder. */
export function askScope(ask: Pick<DecisionAsk, "scope">, controlRepo: string): string {
  return ask.scope ?? basename(controlRepo) ?? "workspace";
}

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
  ask: { ledger: string | null; id: string; uid?: string | null; home?: string | null; key?: string | null } | null;
  at: number;
};

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
  repeat?: boolean;
  preventDefault(): void;
};
type KeyTarget = {
  addEventListener(type: "keydown", listener: (event: KeyEvent) => void, capture: boolean): void;
  removeEventListener(type: "keydown", listener: (event: KeyEvent) => void, capture: boolean): void;
};
type DomNode = { contains?(other: unknown): boolean; focus?(options?: { preventScroll?: boolean }): void };

/** The option card a key press comes from, by its place among the card's options; null when it is not one. */
function optionAt(target: unknown): number | null {
  type El = {
    closest?: (selector: string) => El | null;
    getAttribute?: (name: string) => string | null;
    querySelectorAll?: (selector: string) => ArrayLike<unknown>;
  };
  const el = target as El | null;
  const radio = el?.closest?.('[role="radio"]');
  const group = el?.closest?.('[role="radiogroup"]');
  if (!radio || !group?.getAttribute?.("aria-label")?.startsWith("Options for")) return null;
  const at = Array.from(group.querySelectorAll?.('[role="radio"]') ?? []).indexOf(radio);
  return at >= 0 ? at : null;
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
  | { kind: "answered"; ask: DecisionAsk; warning: string | null; queued: string | null }
  | { kind: "skipped"; ask: DecisionAsk }
  | null;

/**
 * The Decisions tab. "Decision N of M" counts this visit: M is every ask it
 * has had in its queue, N the ones answered plus the one on screen, and the
 * bar is what is answered (skips are counted apart). While an answer is in
 * flight the tab holds still: nothing moves off the card until its reply lands. The order (Blocking first,
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
  workspace = null,
}: {
  theme: PluginTheme;
  compact: boolean;
  navigation: Navigation;
  /** Open at a ledger, and at an ask in it (from an initiative's waiting_on, or Needs you). */
  focus?: DecisionsFocus | null;
  /** The header's workspace menu (J5): only the asks of that workspace or fleet scope; null for all. */
  workspace?: string | null;
}) {
  const text = useText(theme);
  const client = useQueryClient();
  const read = useWorkspaceAsks();
  const reduced = useReducedMotion();
  // J5's tiles and rail (desktop): needs.list and answers.status, each one read, the same ones the header reads.
  const needs = useNeeds();
  const answersRead = useAnswersStatus();
  const openUrl = useOpenUrl();
  const now = useTick(15_000);
  const [ordering, setOrdering] = useState<Ordering>("blocking");
  const [ledger, setLedger] = useState<string | null>(focus?.ledger ?? null);
  const [pinned, setPinned] = useState<{ key: string; ask: DecisionAsk } | null>(null);
  const [lastIndex, setLastIndex] = useState(0);
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set());
  // Your choice and words per ask, kept in the query cache (not this view), so leaving the tab and coming back keeps them.
  const drafts =
    useQuery({
      queryKey: DRAFTS_KEY,
      queryFn: () => client.getQueryData<Drafts>(DRAFTS_KEY) ?? {},
      initialData: {},
      staleTime: Number.POSITIVE_INFINITY,
      // Kept while no view watches it: a draft must outlive a long visit to another tab.
      gcTime: Number.POSITIVE_INFINITY,
    }).data ?? {};
  const setDrafts = useCallback(
    (update: (now: Drafts) => Drafts) => client.setQueryData<Drafts>(DRAFTS_KEY, (now) => update(now ?? {})),
    [client],
  );
  const [leaving, setLeaving] = useState<{ key: string; ask: DecisionAsk; at: number } | null>(null);
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
  const [status, setStatus] = useState<Status>(null);
  const [pending, setPending] = useState<{ focus: DecisionsFocus; retriedAt: number | null } | null>(
    focus ? { focus, retriedAt: null } : null,
  );
  const [focusNote, setFocusNote] = useState<string | null>(null);
  // Any answer in flight, as the mutation cache has it: it outlives this view, so a remount still holds still.
  const busy = useIsMutating({ mutationKey: [...ANSWER_KEY] }) > 0;
  // Which asks this client answered, or is answering: by their full key, from the same cache.
  const answers = useMutationState({
    filters: { mutationKey: [...ANSWER_KEY] },
    select: (mutation) => ({ key: String(mutation.options.mutationKey?.[2] ?? ""), status: mutation.state.status }),
  });
  const answeredHere = new Set(answers.filter((one) => one.status === "success").map((one) => one.key));
  const answeringHere = new Set(answers.filter((one) => one.status === "pending").map((one) => one.key));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [answeredOpen, setAnsweredOpen] = useState(false);
  const keys = useRef<CardKeys | null>(null);
  const root = useRef<View>(null);

  // The workspace's asks and every fleet scope's (each answered where it lives: whereOf), ideas aside.
  const all = (read.data ? decisionAsks(read.data) : [])
    .filter((ask) => !ask.idea)
    .filter((ask) => workspace === null || askScope(ask, read.data?.controlRepo ?? "") === workspace);
  const rail = ledgerRail(all);
  // A ledger you chose stays chosen when its last ask is answered ("Nothing open in it"); one no read knows is no filter.
  const ledgerShown = ledger !== null && all.some((ask) => ledgerOf(ask) === ledger) ? ledger : null;
  const openAll = all.filter(isTriaged);
  const queue = triageQueue(all, { ordering, ledger: ledgerShown, skipped });
  const queueRef = useRef(queue);
  queueRef.current = queue;

  // The card on screen: the one leaving, else the pinned ask, else (before the pin lands) the focus's or the first.
  const focusTarget = pending?.focus.ask && read.data ? (resolveFocus(queue, pending.focus.ask)?.ask ?? null) : null;
  const shownKey = leaving?.key ?? pinned?.key ?? (focusTarget ? askKey(focusTarget) : null) ?? null;
  const live = shownKey ? (queue.find((ask) => askKey(ask) === shownKey) ?? null) : null;
  // Back on the tab with an answer still in flight: that ask is the card, wherever the order puts it.
  const inFlightAsk = !shownKey ? (all.find((ask) => answeringHere.has(askKey(ask))) ?? null) : null;
  const fallbackFirst = !shownKey && !pending ? (inFlightAsk ?? queue[0] ?? null) : null;
  const current = leaving?.ask ?? live ?? pinned?.ask ?? focusTarget ?? fallbackFirst;
  const currentKey = current ? askKey(current) : null;
  const index = currentKey ? queue.findIndex((ask) => askKey(ask) === currentKey) : -1;
  // The card's ask, gone from the open queue: answered (here, or elsewhere: an answered copy wins), moved
  // home (only with a uid to say so, and no answered copy), or gone.
  // An ask whose answer is still on its way is not gone: the list may learn the answer a moment before the card does.
  const gone = current !== null && !leaving && index < 0 && !(currentKey !== null && answeringHere.has(currentKey));
  const sameIdentity = (ask: DecisionAsk) =>
    current !== null && ledgerOf(ask) === ledgerOf(current) && ask.uid === current.uid && ask.id === current.id;
  const answeredCopy = gone ? all.find((ask) => sameIdentity(ask) && ask.state !== "open") : undefined;
  const moved = gone && !answeredCopy && current?.uid != null ? (queue.find(sameIdentity) ?? null) : null;
  const frozen =
    gone && !moved && current
      ? currentKey && answeredHere.has(currentKey)
        ? `You answered this${answeredCopy ? `: ${answeredLine(answeredCopy).replace(/^Answered[^:]*: /, "")}` : ""}. Answers are not undone here.`
        : answeredCopy
          ? answeredElsewhere(answeredCopy)
          : current.uid === null
            ? "This was answered or moved: it is no longer open here. Nothing was sent from here."
            : "This ask is no longer open here: it left its ledger. Nothing was sent from here."
      : null;

  // Pin what shows, the moment it shows: first open, a focus, and after any change of ask.
  // A focus that names nothing yet waits for one more read (the ask may be newer than the list), then says so.
  const readAt = read.dataUpdatedAt + read.errorUpdatedAt;
  const refetch = read.refetch;
  useEffect(() => {
    if (!read.data || leaving) return;
    // A focus waits while an answer is in flight; pinning the card already on screen does not.
    if (pending && !busy) {
      const want = pending.focus.ask;
      const found = want ? resolveFocus(queueRef.current, want) : null;
      if (want && !found && pending.retriedAt === null) {
        setPending({ ...pending, retriedAt: readAt });
        void refetch();
        return;
      }
      if (want && !found && pending.retriedAt === readAt) return;
      setPending(null);
      const first = found?.ask ?? queueRef.current[0] ?? null;
      // Asked by its full identity and read, but no longer open: answered, not missing.
      const closed =
        want?.key && !found && read.data
          ? decisionAsks(read.data).some((ask) => askKey(ask) === want.key && ask.state !== "open")
          : false;
      setFocusNote(
        want && !found
          ? closed
            ? "That decision is answered now: showing the first open one."
            : "That decision isn't in the list yet: showing the first one."
          : (found?.note ?? null),
      );
      setPinned(first ? { key: askKey(first), ask: first } : null);
      setLastIndex(0);
      return;
    }
    if (!pinned && current && !frozen) setPinned({ key: askKey(current), ask: current });
  }, [read.data, readAt, refetch, pending, pinned, current, frozen, leaving, busy]);
  // Keep the pinned snapshot fresh while its ask is open, so a frozen card shows the last words read.
  useEffect(() => {
    if (pinned && live && live !== pinned.ask && askKey(live) === pinned.key) setPinned({ key: pinned.key, ask: live });
    if (live && index >= 0 && index !== lastIndex) setLastIndex(index);
  }, [pinned, live, index, lastIndex]);
  // Still open, at a new home: the same ask, pinned at its new identity, your choice and words with it.
  useEffect(() => {
    if (!moved || !pinned || busy) return;
    const from = pinned.key;
    const to = askKey(moved);
    setDrafts((now) => {
      const draft = now[from];
      if (!draft) return now;
      const { [from]: _old, ...rest } = now;
      return { ...rest, [to]: draft };
    });
    setPinned({ key: to, ask: moved });
  }, [moved, pinned, busy, setDrafts]);
  // A new focus while open: its ledger, and its ask once read.
  const focusAt = focus?.at ?? null;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  // Taken once, and not while an answer is in flight: it waits until the reply lands.
  const focusTaken = useRef<number | null>(null);
  useEffect(() => {
    const next = focusRef.current;
    if (focusAt === null || !next || busy || focusTaken.current === focusAt) return;
    focusTaken.current = focusAt;
    setLedger(next.ledger);
    setPending({ focus: next, retriedAt: null });
    setFocusNote(null);
    setLeaving(null);
    setSeen(new Set());
  }, [focusAt, busy]);
  // Every ask this visit has queued counts toward M; skips of asks no longer open are dropped.
  const queueKeys = queue.map(askKey).join("\n");
  useEffect(() => {
    const keysNow = queueKeys ? queueKeys.split("\n") : [];
    setSeen((now) => (keysNow.every((key) => now.has(key)) ? now : new Set([...now, ...keysNow])));
  }, [queueKeys]);
  // A skip stands while its ask is open anywhere, whatever ledger the rail shows.
  const openAllRef = useRef(openAll);
  openAllRef.current = openAll;
  const openKeys = openAll.map(askKey).join("\n");
  useEffect(() => {
    if (openKeys !== undefined) setSkipped((now) => pruneSkipped(now, openAllRef.current));
  }, [openKeys]);

  // Focus the tab once it shows (its first read, or a read that recovers), so its keys are its own; never off a field you are in.
  const showing = Boolean(read.data) && !(read.isError && !read.data);
  const stale = read.isError && Boolean(read.data);
  useEffect(() => {
    if (!showing || stale) return;
    const doc = (globalThis as { document?: { activeElement?: unknown; body?: unknown } }).document;
    const node = root.current as unknown as DomNode | null;
    const active = doc?.activeElement;
    if (active && active !== doc?.body && node?.contains?.(active)) return;
    node?.focus?.({ preventScroll: true });
  }, [showing, stale]);

  const pin = (ask: DecisionAsk | null, at = 0) => {
    if (answerInFlight(client)) return;
    setPinned(ask ? { key: askKey(ask), ask } : null);
    setLastIndex(at);
  };
  const go = (at: number) => {
    const target = queue[at];
    if (target) pin(target, at);
  };
  const leave = () => pin(nextAfter(queue, currentKey, index < 0 ? lastIndex : index), index < 0 ? lastIndex : index);
  const skip = () => {
    if (!current || !currentKey || answerInFlight(client)) return;
    setSkipped((now) => new Set([...now, currentKey]));
    setStatus({ kind: "skipped", ask: current });
    leave();
  };
  const onAnswered = (answered: DecisionAsk, warning: string | null, queued = false) => {
    if (!current || !currentKey) return;
    const at = index < 0 ? lastIndex : index;
    // An answer that waits out its undo window (B4) is still an open ask: say what you chose and that it can be undone.
    const choice = current.options.find((entry) => entry.id === drafts[currentKey]?.chosen)?.label;
    setStatus({
      kind: "answered",
      ask: answered,
      warning,
      queued: queued ? (choice ? `“${choice}”` : "in your words") : null,
    });
    setDrafts(({ [currentKey]: _gone, ...rest }) => rest);
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
    if (answerInFlight(client)) return;
    setOrdering(next);
    pin(triageQueue(all, { ordering: next, ledger: ledgerShown, skipped })[0] ?? null);
  };
  const choose = (entry: string | null) => {
    if (answerInFlight(client)) return;
    setLedger(entry);
    setSeen(new Set());
    setPickerOpen(false);
    pin(triageQueue(all, { ordering, ledger: entry, skipped })[0] ?? null);
  };

  // The keys, on the web, only from inside the tab: read through refs, so the listener is added once.
  const canSkip = queue.length > 1 && !frozen && !leaving && !busy;
  const act = useRef<(key: TriageKey) => void>(() => undefined);
  act.current = (key) => {
    if (leaving) return;
    if (key.kind === "choose") keys.current?.choose(key.index);
    else if (key.kind === "cancel") keys.current?.cancel();
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
        onOption: optionAt(event.target),
      });
      if (!key) return;
      // Escape is the card's only while a confirm is armed; a held Enter (key repeat) never answers.
      if (key.kind === "cancel" && !keys.current?.armed()) return;
      event.preventDefault();
      // A held key acts once: an answer or a skip is a verb, so only the first press counts.
      if ((key.kind === "answer" || key.kind === "skip") && event.repeat) return;
      act.current(key);
    };
    // In the capture phase, before a focused option takes Enter or Space as a press of itself (it selects that same option).
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
  if (!read.data) {
    return (
      <View style={{ gap: space[3] }}>
        <Notice theme={theme} tone="danger">
          {`Your workspace's asks could not be read: ${errorText(read.error)}`}
        </Notice>
        <View style={{ flexDirection: "row" }}>
          <Verb theme={theme} label="Try again" compact={compact} onPress={() => void read.refetch()} />
        </View>
      </View>
    );
  }
  const { warnings } = read.data;
  const hints = Platform.OS === "web" && !compact;
  const totalOpen = rail.reduce((sum, entry) => sum + entry.open, 0);
  const totalWaiting = rail.reduce((sum, entry) => sum + entry.waiting, 0);
  const answeredList = recentlyAnswered(all);
  const conductorList = forTheConductor(all);
  // M: every ask queued this visit; answered: those of them no longer open (here or elsewhere). Skips stay open.
  const visit = new Set([...seen, ...queue.map(askKey)]);
  const stillOpen = new Set(queue.map(askKey));
  const answeredCount = [...visit].filter((key) => !stillOpen.has(key)).length;
  const progress = progressOf(answeredCount, visit.size, !frozen && Boolean(current));
  const ledgerOpen = queue.length;
  const next = upNext(queue, index < 0 ? lastIndex - 1 : index);
  const statusLine = (
    // Mounted from the start, so a screen reader hears what is put in it; on the desktop it takes no room until then.
    <View style={{ minHeight: compact || status || focusNote ? 18 : 0, gap: 2 }} accessibilityLiveRegion="polite">
      {status ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
          <Icon
            name={status.kind === "answered" ? "CircleCheck" : "SkipForward"}
            size={14}
            color={status.kind === "answered" ? theme.colors.statusSuccess : theme.colors.foregroundMuted}
          />
          <Text style={[text.small, { flex: 1, color: theme.colors.foreground }]}>
            {status.kind === "answered"
              ? status.queued
                ? `Answered: ${status.queued} · ${ledgerName(ledgerOf(status.ask))} · written in ${UNDO_MS / 1000} s unless you undo it`
                : `${answeredLine(status.ask)} · ${ledgerName(ledgerOf(status.ask))} · answers are not undone here`
              : `Skipped “${cutAtWord(headlineOf(status.ask).headline, 60)}”: it comes back at the end of the queue`}
            {status.kind === "answered" && status.warning ? (
              <Text style={{ color: theme.colors.statusWarning }}>{` · ${status.warning}`}</Text>
            ) : null}
          </Text>
        </View>
      ) : focusNote ? (
        <Text style={[text.small, { color: theme.colors.foreground }]}>{focusNote}</Text>
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
            ledgerShown
              ? `${ledgerOpen} open in ${ledgerName(ledgerShown)} · ${totalOpen} in all`
              : `${totalOpen} open`,
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
            accessibilityLabel={`Go to ${ask.id} in ${ledgerOf(ask)}: ${headlineOf(ask).headline}`}
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
              {ask.waiting ? (
                <Text style={{ color: theme.colors.statusWarning, fontWeight: "600" }}>Waits on you · </Text>
              ) : null}
              {headlineOf(ask).headline}
            </Text>
            <Text numberOfLines={1} style={[text.small, { fontFamily: mono }]}>
              {ledgerName(ledgerOf(ask))}
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
                <Text style={[text.small, { color: answeredColor(theme, fateLine(ask)) }]}>
                  {`${answeredLine(ask)} · ${ledgerName(ledgerOf(ask))}`}
                </Text>
                {ask.answer ? (
                  <Text style={text.small} selectable>
                    {ask.answer}
                  </Text>
                ) : null}
                <Text style={text.small}>{fateLine(ask)?.words ?? writtenTo(ask)}</Text>
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
            where={whereOf(current)}
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
              : "No open asks in your workspace's ledgers or the fleet's. New ones show here as agents write them."}
          </Text>
          {ledgerShown && totalOpen > 0 ? (
            <View style={{ flexDirection: "row" }}>
              <Verb
                theme={theme}
                icon="ArrowLeft"
                label={`All ledgers · ${totalOpen} open`}
                compact={compact}
                onPress={() => choose(null)}
              />
            </View>
          ) : null}
        </Card>
      )}
      {upNextView}
      {/* Never folded away: an answer that would once have started work waits here, visibly, for the conductor (A8). */}
      <ConductorAnswers theme={theme} asks={conductorList} compact={compact} />
      {answeredView}
    </View>
  );

  // The desktop is J5 (docs/design/next/j5-decisions.png): the order and ledger chips, the four tiles, the decision
  // at full width and the column beside it. The phone keeps the list's own shape.
  if (!compact) {
    const nextBase = index < 0 ? lastIndex - 1 : index;
    const emptyStage = (
      <Card theme={theme}>
        <Text style={text.title}>
          {ledgerShown ? `Nothing open in ${ledgerName(ledgerShown)}` : "Nothing to decide"}
        </Text>
        <Text style={text.muted}>
          {ledgerShown
            ? "Every ask in this ledger is answered."
            : "No open asks in your workspace's ledgers or the fleet's. New ones show here as agents write them."}
        </Text>
        {ledgerShown && totalOpen > 0 ? (
          <View style={{ flexDirection: "row" }}>
            <Verb
              theme={theme}
              icon="ArrowLeft"
              label={`All ledgers · ${totalOpen} open`}
              compact={false}
              onPress={() => choose(null)}
            />
          </View>
        ) : null}
      </Card>
    );
    return (
      <View {...rootProps} style={{ gap: 16, outlineWidth: 0 }}>
        {stale ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }} accessibilityRole="alert">
            <Icon name="CloudOff" size={14} color={theme.colors.foregroundMuted} />
            <Text style={[text.small, { flex: 1 }]}>
              {`Could not refresh (${errorText(read.error)}): showing what was read before. It tries again on its own.`}
            </Text>
          </View>
        ) : null}
        {warnings.slice(0, 3).map((warning) => (
          <Notice key={warning} theme={theme} tone="warn">
            {warning}
          </Notice>
        ))}
        <StageControls
          theme={theme}
          ordering={ordering}
          onOrdering={reorder}
          asks={openAll}
          ledger={ledgerShown}
          onLedger={choose}
          progress={stageProgress(progress, queue, skipped.size)}
          segments={progressSegments(answeredCount, visit.size)}
        />
        <StageTilesRow
          theme={theme}
          tiles={stageTiles(openAll, needs.data ?? null, answersRead.data ?? null, now)}
          onOpenPr={openUrl}
        />
        {statusLine}
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 20 }}>
          <View style={{ flex: 1, minWidth: 0, gap: 16 }}>
            {current && currentKey ? (
              <ExitCard key={currentKey} leaving={leaving?.key === currentKey} reduced={reduced} onDone={exitDone}>
                <View style={{ flexDirection: "row" }}>
                  <StageCard
                    theme={theme}
                    ask={current}
                    where={whereOf(current)}
                    navigation={navigation}
                    now={now}
                    onAnswered={onAnswered}
                    onSkip={canSkip ? skip : undefined}
                    keys={keys}
                    draft={drafts[currentKey] ?? EMPTY_DRAFT}
                    onDraft={(draft) => setDrafts((was) => ({ ...was, [currentKey]: draft }))}
                    frozen={frozen}
                    onNext={frozen ? leave : undefined}
                  />
                </View>
              </ExitCard>
            ) : (
              emptyStage
            )}
            {/* Never folded away: an answer that would once have started work waits here, visibly, for the conductor (A8). */}
            <ConductorAnswers theme={theme} asks={conductorList} compact={false} />
          </View>
          <StageSide
            theme={theme}
            next={next.map(upNextRow)}
            nextTotal={Math.max(queue.length - (nextBase + 1), 0)}
            went={answersRead.data ? wentRows(answersRead.data.recent) : null}
            onGo={(at) => go(nextBase + 1 + at)}
          />
        </View>
      </View>
    );
  }

  return (
    <View {...rootProps}>
      {header}
      {stale ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }} accessibilityRole="alert">
          <Icon name="CloudOff" size={14} color={theme.colors.foregroundMuted} />
          <Text style={[text.small, { flex: 1 }]}>
            {`Could not refresh (${errorText(read.error)}): showing what was read before. It tries again on its own.`}
          </Text>
        </View>
      ) : null}
      {warnings.slice(0, 3).map((warning) => (
        <Notice key={warning} theme={theme} tone="warn">
          {warning}
        </Notice>
      ))}
      {main}
    </View>
  );
}
