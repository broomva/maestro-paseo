// The phone's Maestro (M1, BRO-3037; docs/design/next/m1-feed-home-mobile.png): every tab is a deck of what
// needs you there, and a sheet of everything else peeks from the bottom edge with the tab bar riding on its top
// edge. This module reads what the desktop reads (needs.list, handled.list, notices.list, the work list, the asks,
// answers.status, the verb ledger) and wires the kit's parts to it: the Deck and its holds, the pull-up sheet,
// the swipe rows on it, the card that rises (M2–M4), and the undo toast. Every verb is sent through
// client/use-inspector.ts and client/verbs.ts, the adapter the desktop uses, so a verb here is the same act with
// the same 8 s undo (B4). Work (M6) and Health (M7) are decks and sheets of their own; Initiatives (M8), the views
// Health reaches and Settings (M11) are pages that rise over the surface; New work (M9) grows from the +.
//
// What the deck shows and what a verb sends come from one read: a hold's card is drawn from its entry, and
// its verbs send that entry's target, never an id looked up again. A read that failed says so; it never reads as
// "nothing needs you". The deck follows a hold by key, so the list changing under it moves nothing onto the
// wrong hold.

import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, type LayoutChangeEvent, Pressable, ScrollView, Text, View } from "react-native";
import { ANSWERS_KEY } from "../../shared/needs";
import { useWorkspaceAsks } from "../decisions";
import { decisionAsks, isTriaged, triageQueue } from "../decisions-model";
import { stageTiles, wentRows } from "../decisions-stage-model";
import { type NeedEntry, needsSection } from "../feed-model";
import { ago, errorText } from "../format";
import type { HomeFocus } from "../home";
import { type HealthRow, holdInspector, holdParam, homeSections, workspaceOptions } from "../home-model";
import { useAnswersStatus, useHandled, useNeeds, useNotices, useVerbLedger, useWorkList } from "../hooks";
import { requestIntent } from "../intent";
import { type Directions, swipeDirections } from "../kit/assumptions";
import { Deck } from "../kit/deck";
import { InspectorCard, type InspectorItem } from "../kit/inspector";
import { OTHER_CHOICE } from "../kit/inspector-model";
import { Chip, SafeBottom } from "../kit/parts";
import { PEEK, PullSheet, TAB_BAND } from "../kit/pull-sheet";
import { TabBar } from "../kit/tab-bar";
import { kitOf } from "../kit/tokens";
import { TidepoolDot } from "../kit/undertow";
import { UndoToast } from "../kit/undo-toast";
import { useOpenUrl } from "../open-url";
import { pendingFor, secondsLeft } from "../pending-model";
import { usePresence } from "../presence";
import { useInspector } from "../use-inspector";
import { useTick } from "../use-tick";
import { planVerb, type VerbId } from "../verbs";
import { type LaneCard, NO_FILTERS, workBoard } from "../work-model";
import { AnswersSheet } from "./answers-sheet";
import { DeckHeader } from "./deck-header";
import { FleetSheet, HealthHost, NoticeDeckCard, UnblockSheet } from "./health-tab";
import { HoldCard } from "./hold-card";
import {
  advanceTo,
  answerStep,
  answersCounts,
  bothRead,
  CONFIRM_WINDOW_MS,
  type DeckRead,
  decisionCards,
  decisionCountWords,
  decisionsDeck,
  deckEmptyWords,
  deckTitle,
  deckVerbs,
  feedCounts,
  feedDeck,
  feedSheet,
  irreversibleChoice,
  MOVE_SETTLE_MS,
  openAsks,
  openingChoice,
  type PhonePage,
  type PhoneTab,
  pageOfIntent,
  pageTrail,
  phoneTabs,
  readOf,
  resolveIndex,
  type SheetCount,
  type SheetRow,
  sheetTitle,
  staleWords,
  unreadWords,
  workspaceNameOf,
} from "./model";
import { NewWorkSheet } from "./new-work-sheet";
import { LedgerWarnings } from "./open-asks";
import { PageBody } from "./page-body";
import { PagePanel } from "./page-panel";
import { askRefOf, cardTarget, DRAFT_TTL_MS, draftKey, draftOf, sweepDrafts, withDraft } from "./resume";
import { flushDrafts, loadDrafts, loadResume, saveDrafts, saveResume } from "./resume-store";
import { AnswersSummary, SeriesList } from "./series-dashboard";
import {
  type AskSeries,
  askSeries,
  endWords,
  firstOfVisit,
  inLedger,
  keyOfDecision,
  marked,
  navigable,
  nextInVisit,
  seriesWith,
  startVisit,
  type Visit,
  visitKeys,
} from "./series-model";
import { SheetRows } from "./sheet-rows";
import {
  firstLane,
  healthCounts,
  healthDeck,
  laneCards,
  laneRows,
  type NoticeAct,
  type WorkLaneId,
  workCounts,
  workDeck,
} from "./tabs-model";
import { LaneSwitcher, WorkDeckCard } from "./work-tab";

/** The sheet's top when it is up: the tab bar stops this far under Paseo's header. */
const SHEET_TOP = 12;

export interface PhoneSurfaceProps {
  theme: PluginTheme;
  layout: { compact: boolean; platform: string };
  navigation?: PluginSurfaceProps["navigation"];
  tab: PhoneTab;
  onTab: (tab: PhoneTab) => void;
  workspace: string | null;
  onWorkspace: (id: string | null) => void;
  /** A hold or work to open on: `params.hold` (a push), or an intent from elsewhere. */
  focus: HomeFocus | null;
  onFocusHandled: () => void;
  /** New work (M9) is open: its sheet grows from the + and the screen owns whether it is shown. */
  creating: boolean;
  onCreating: (open: boolean) => void;
  /** Work this screen has no hold or row for opens on its own page. */
  onOpenWork: (id: string) => void;
  /** The page that is up (M8, M11, and the views Health reaches), and how it changes; null: none. */
  page: PhonePage | null;
  onPage: (page: PhonePage | null) => void;
  /** An ask or a review's decision opened from a page: the Decisions tab at it. */
  onOpenDecision: (ledger: string, askId: string | null) => void;
  /** A frame the host already knows (a test, a shot): otherwise the screen's own layout is measured. */
  frame?: { width: number; height: number };
}

export function PhoneSurface(props: PhoneSurfaceProps) {
  const { theme, layout, navigation, tab, onTab, workspace, onWorkspace, focus, onFocusHandled } = props;
  const kit = kitOf(theme);
  const toast = useToast();
  const openUrl = useOpenUrl();
  const now = useTick(15_000);
  const directions: Directions = swipeDirections({ compact: layout.compact, platform: layout.platform });
  const presence = usePresence();
  const [size, setSize] = useState(props.frame ?? { width: 0, height: 0 });
  const [safe, setSafe] = useState(0);

  const list = useWorkList();
  const needs = useNeeds();
  const handled = useHandled();
  const notices = useNotices();
  const asksRead = useWorkspaceAsks();
  const answersRead = useAnswersStatus();
  const ledger = useVerbLedger();

  const items = list.data?.items ?? [];
  const asks = useMemo(() => (asksRead.data ? decisionAsks(asksRead.data) : []), [asksRead.data]);
  const rows = needs.data?.rows ?? null;
  // A refetch that failed over an earlier read is "stale" (BRO-3094): said, and never concluded from.
  const read: DeckRead = readOf(needs);
  const asksReadState: DeckRead = readOf(asksRead);
  // Sources needs.list could not read (BRO-3008): their holds are missing because the read failed, never answered.
  const unread = needs.data?.unread;

  // Every hold, joined to its work or ask: the deck and the card read this, and every verb sends from it.
  const everyHold = useMemo(() => needsSection(rows ?? [], items, asks), [rows, items, asks]);
  const scopedHolds = useMemo(
    () => everyHold.filter((entry) => workspace === null || entry.row.scope === workspace),
    [everyHold, workspace],
  );
  // Every other open ask, ideas among them (BRO-3140): on the Decisions deck after its holds, never twice (by the
  // keys of every hold, BRO-3112). null while asks.workspace has never been read. `everyOpen` is every workspace's
  // (the chip offers them all); `openRows` the chosen one's.
  const promptHeld = needs.data !== undefined && !(needs.data.unread ?? []).includes("asks");
  const everyOpen = useMemo(
    () =>
      asksRead.data
        ? openAsks(
            asks,
            workspaceNameOf(asksRead.data.controlRepo),
            null,
            now,
            new Set(everyHold.map((entry) => entry.row.key)),
            promptHeld,
          )
        : null,
    [asksRead.data, asks, now, everyHold, promptHeld],
  );
  const openRows = useMemo(
    () => everyOpen?.filter((row) => workspace === null || row.entry.row.scope === workspace) ?? null,
    [everyOpen, workspace],
  );
  const cards = useMemo(() => decisionCards(decisionsDeck(scopedHolds), openRows ?? []), [scopedHolds, openRows]);
  // The Decisions dashboard's series (BRO-3172), in this workspace; an open looks its key up in every workspace's.
  // The answers batch is the "Your answers" row, never a series of its own.
  const series = useMemo(() => askSeries(cards.filter((card) => card.entry.row.key !== ANSWERS_KEY)), [cards]);
  const everyCard = useMemo(() => decisionCards(decisionsDeck(everyHold), everyOpen ?? []), [everyHold, everyOpen]);
  const everySeries = useMemo(() => askSeries(everyCard), [everyCard]);
  // The open asks open the same card a hold does: an answer is the same verb.
  const inspectable = useMemo(
    () => [...everyHold, ...(everyOpen ?? []).map((row) => row.entry)],
    [everyHold, everyOpen],
  );
  const entries = useMemo(
    () => (tab === "decisions" ? cards.map((card) => card.entry) : tab === "feed" ? feedDeck(scopedHolds) : []),
    [cards, scopedHolds, tab],
  );

  const sections = homeSections({
    needs: needs.data ?? null,
    handled: handled.data ?? null,
    items,
    asks,
    notices: notices.data ?? null,
    workspace,
    filter: "all",
    query: "",
  });
  const groups = feedSheet(sections, now);

  // Work (M6): the board as the desktop's J6 reads it, in this workspace; its deck is the Needs you tray's work.
  const board = useMemo(
    () =>
      workBoard({
        items,
        needs: needs.data ?? null,
        handled: handled.data ?? null,
        asks,
        filters: { ...NO_FILTERS, workspace },
        now,
      }),
    [items, needs.data, handled.data, asks, workspace, now],
  );
  const workCards = useMemo(() => workDeck(board), [board]);
  const [chosenLane, setLane] = useState<WorkLaneId | null>(null);
  const lane = chosenLane ?? firstLane(board);
  // Health (M7): the notices, stuck first, in this workspace.
  const noticeRows = useMemo(() => healthDeck(sections.health), [sections.health]);
  const noticesRead: DeckRead = readOf(notices);
  const workRead: DeckRead = bothRead(read, readOf(list));

  // The deck's holds, by key: the Feed's and Decisions' holds, Work's work, Health's notices.
  const keys =
    tab === "work"
      ? workCards.map((card) => card.key)
      : tab === "health"
        ? noticeRows.map((row) => row.key)
        : entries.map((entry) => entry.row.key);

  // Where the deck stands: a hold by its key, so the list moving under it moves nothing onto the wrong hold.
  const [stand, setStand] = useState<{ key: string | null; last: number }>({ key: null, last: 0 });
  const index = resolveIndex(keys, stand.key, stand.last);
  const move = (to: number) => setStand({ key: keys[to] ?? null, last: to });
  // The hold a push opened the deck on: the note shows while the deck is still on it, on that tab (M10).
  const [pushedAt, setPushedAt] = useState<{ key: string; tab: PhoneTab } | null>(null);
  const pushed = pushedAt !== null && pushedAt.tab === tab && keys[index] === pushedAt.key;
  const [gone, setGone] = useState<string | null>(null);

  const inspector = useInspector({
    items,
    entries: inspectable,
    holdKeys: keys,
    navigation,
    onOpenWork: props.onOpenWork,
    now,
  });
  const { selection, entry: openEntry, inspected } = inspector;

  // What waits out its undo window: its verbs cannot be pressed again, and the deck moves past it.
  const waitingVerbs = useMemo(() => pendingFor(ledger.data?.pending ?? []), [ledger.data]);
  const waitingKeys = useMemo(() => new Set(waitingVerbs.map((verb) => verb.key)), [waitingVerbs]);
  const waitingWords = (key: string): string | null => {
    const verb = waitingVerbs.find((one) => one.key === key);
    if (!verb) return null;
    const left = secondsLeft(ledger.dataUpdatedAt + verb.remainingMs - Date.now());
    return left > 0 ? `${verb.label} · applies in ${left} s` : `${verb.label} · applying now`;
  };

  // The card's walk through one series (BRO-3172): null while the card pages the tab's deck, or is closed. Answer and
  // Skip move it on within the series and never wrap; the last one closes it onto the dashboard with a toast.
  const [visit, setVisit] = useState<Visit | null>(null);
  const visitLive = visit ? (everySeries.find((one) => one.id === visit.series)?.keys ?? []) : [];
  const visitList = visit ? visitKeys(visit, visitLive) : [];
  // The order a visit walks in: its snapshot, then what joined since (a key that left keeps its place to walk past).
  const walk = (now: Visit) => [...now.snapshot, ...visitLive.filter((key) => !now.snapshot.includes(key))];
  const mayShow = (now: Visit) => (key: string) => navigable(key, visitLive, waitingKeys, now);
  // The ask the visit answered last: Undo takes the card back to it.
  const lastAnswered = useRef<string | null>(null);
  // When the card last moved on: Answer and Skip wait MOVE_SETTLE_MS after it, so a double tap answers one ask.
  const movedAt = useRef(0);
  const openSeries = (one: AskSeries, at?: string) => {
    const started = startVisit(one);
    const key = at ?? firstOfVisit(one.keys, (candidate) => navigable(candidate, one.keys, waitingKeys, started));
    if (!key) return;
    lastAnswered.current = null;
    // A fresh visit's first press is never held by the last visit's settle.
    movedAt.current = 0;
    setVisit(started);
    inspector.selectHold(key);
  };
  /** A hold opens in its series when it has one; any other opens its card over the tab's deck, as before. */
  const openHold = (key: string) => {
    const one = seriesWith(everySeries, key);
    if (one) return openSeries(one, key);
    setVisit(null);
    inspector.selectHold(key);
  };
  // What the latest render holds: an answer resolves after its press, maybe after the card closed or moved, and must
  // act on the card as it is then, never on the visit its press closed over (Codex P20 round 1).
  const onCard = selection?.kind === "hold" ? selection.key : null;
  const latest = useRef({ visit, showing: false, onCard, list: visitList, walk, mayShow });
  latest.current = { visit, showing: inspector.showing, onCard, list: visitList, walk, mayShow };
  /** The visit moves past `from`: to the next ask it may show, else it ends and says so. */
  const visitOn = (from: string, now: Visit) => {
    const to = nextInVisit(latest.current.walk(now), from, latest.current.mayShow(now));
    if (to) {
      movedAt.current = Date.now();
      setVisit(now);
      inspector.selectHold(to);
      return;
    }
    setVisit(null);
    inspector.setOpen(false);
    toast.show(endWords(now));
  };
  const visitMove = (from: string, how: "answered" | "skipped") => {
    const now = latest.current.visit;
    if (now) visitOn(from, marked(now, from, how));
  };
  // The ask on the card left the read without an answer here (answered elsewhere, or closed): the card is still open
  // but has nothing to show, and the visit moves on. A card you closed ends its visit (Claude P20 round 1).
  useEffect(() => {
    if (!visit) return;
    // The card went to a hold outside the series (a page, a key step), one the read still holds: the visit ends, it
    // never snaps back. A key the read no longer holds is one that left it (below), even one that joined mid-visit.
    if (inspector.showing && onCard !== null && !visit.snapshot.includes(onCard) && !visitLive.includes(onCard)) {
      setVisit(null);
      lastAnswered.current = null;
      return;
    }
    const left = onCard !== null && !visitLive.includes(onCard) && !visit.answered.includes(onCard);
    if (inspector.open && left && onCard) return visitOn(onCard, visit);
    if (!inspector.showing) {
      setVisit(null);
      lastAnswered.current = null;
    }
  });
  const undo = () => {
    const key = lastAnswered.current;
    lastAnswered.current = null;
    // Only an answer actually taken back returns the card to it: past its window it applied (Claude P20 round 1).
    const undone = inspector.undo.undo();
    if (undone && key && visit) {
      setVisit(marked(visit, key, "undone"));
      inspector.selectHold(key);
    }
  };

  // Opening on a hold (`params.hold`, M10) or work: once needs.list has been read since this screen mounted.
  // A refetch that failed concludes nothing (BRO-3094): the push waits for a read that landed.
  // An open ask on the Decisions deck is a hold to open too, once asks.workspace has answered as well.
  const asksSettled = asksRead.isFetchedAfterMount || asksRead.isError;
  const fresh =
    needs.isFetchedAfterMount && !needs.isError && asksSettled
      ? [...(rows ?? []), ...(everyOpen ?? []).map((row) => row.entry.row)]
      : null;
  const handledFocus = useRef(-1);
  const { onOpenWork } = props;
  useEffect(() => {
    if (!focus || handledFocus.current === focus.at) return;
    if (focus.decision) {
      // An ask named by its ledger and id (Initiatives): the one open ask that matches, else its ledger's series.
      if (fresh === null) return;
      handledFocus.current = focus.at;
      onFocusHandled();
      const { ledger, id } = focus.decision;
      const key = keyOfDecision(everyCard, ledger, id);
      // The ledger's series, only when the name points at one (a bare file name can be in two scopes).
      const named = everyCard.filter(({ entry }) => entry.ask && inLedger(entry.ask, ledger));
      const one = new Set(named.map((found) => seriesWith(everySeries, found.entry.row.key)?.id));
      const anyInLedger = one.size === 1 ? named[0]?.entry.row.key : undefined;
      if (key) setOpenAsk({ key, whole: false });
      else if (anyInLedger) setOpenAsk({ key: anyInLedger, whole: true });
      else if (asksRead.isError)
        toast.show("Couldn't read the open asks, so that ask did not open. It reads again in a moment.");
      else if (one.size > 1)
        toast.show(`${ledger} is in more than one place (two workspaces, or two homes): open it from Decisions.`);
      return;
    }
    if (focus.work) {
      const held = (fresh ?? []).find((row) => row.key === `work:${focus.work}`);
      if (fresh === null && !held) return;
      if (!held && !list.data) return;
      handledFocus.current = focus.at;
      onFocusHandled();
      if (held) setStand({ key: held.key, last: 0 });
      else if (items.some((one) => one.id === focus.work)) inspector.selectWork(focus.work);
      else onOpenWork(focus.work);
      return;
    }
    const target = holdParam(focus.hold, fresh);
    if (target.kind === "wait") return;
    handledFocus.current = focus.at;
    onFocusHandled();
    if (target.kind === "open") {
      // A hold that is now an open ask needs.list does not hold is on the Decisions deck, not this tab's.
      const onDecisions = !(rows ?? []).some((row) => row.key === target.key);
      const at = onDecisions ? "decisions" : tab;
      if (at !== tab) onTab(at);
      setStand({ key: target.key, last: 0 });
      setPushedAt(focus.from === "push" ? { key: target.key, tab: at } : null);
      setGone(null);
      // An ask opens on the card, in its series (BRO-3172), after the tab's change has closed what was open.
      if (seriesWith(everySeries, target.key)) setOpenAsk({ key: target.key, whole: false });
    } else if (target.kind === "gone") setGone(target.key);
  });

  // A card belongs to the tab it rose from: another tab starts without it.
  const closeCard = inspector.setOpen;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a change of tab closes the card
  useEffect(() => {
    closeCard(false);
  }, [tab]);
  // An open asked for with a change of tab: applied here, after the effect above, so the tab's close cannot undo it.
  const [openAsk, setOpenAsk] = useState<{ key: string; whole: boolean } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new request opens
  useEffect(() => {
    if (!openAsk) return;
    setOpenAsk(null);
    const one = seriesWith(everySeries, openAsk.key);
    if (one && openAsk.whole) openSeries(one);
    else openHold(openAsk.key);
  }, [openAsk]);

  // The card you were on reopens on the same ask (BRO-3180 B): once per mount, after the reads land, unless a push or
  // another focus already says where to go. Its ask is found by identity; gone, the card opens on its series; with no
  // series left, you land on the dashboard and are told.
  const restored = useRef(false);
  // Where you left it, read at this screen's first render: before the surface saves the tab it opened on now.
  const left = useRef(loadResume()).current;
  // The hold the restore asked to open: until a card shows, the saved card is left as it is.
  const reopening = useRef<string | null>(null);
  const keepSaved = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    const card = left.card;
    // A push or another focus says where to go; a route that opened another tab than the card's leaves it closed.
    if (focus || !card || tab !== left.tab) {
      restored.current = true;
      return;
    }
    // The card's ask is found in any fresh read of the asks (positive evidence) and opened; it is concluded gone only
    // from a fresh, warning-free read, so an ask not read yet, or missing from a degraded read, is never taken for
    // answered; with no trusted read the card stays saved (P20 B round 1).
    if (fresh === null || !asksRead.isFetchedAfterMount || asksRead.isError) return;
    const key = cardTarget(
      card,
      inspectable.map((entry) => ({ key: entry.row.key, ask: entry.ask })),
    );
    if (key) {
      restored.current = true;
      reopening.current = key;
      return setOpenAsk({ key, whole: false });
    }
    restored.current = true;
    // Not found, and the read is degraded: no conclusion. The saved card stays until you open another one.
    if ((asksRead.data?.warnings.length ?? 1) > 0) {
      keepSaved.current = true;
      return;
    }
    const one = card.series ? everySeries.find((series) => series.id === card.series) : undefined;
    if (one?.keys[0]) {
      reopening.current = one.keys[0];
      return setOpenAsk({ key: one.keys[0], whole: true });
    }
    saveResume({ card: null });
    toast.show("That ask was answered while you were away.");
  });
  // The card as it stands, kept once the restore above has run: the ask it shows, by identity, and its series.
  useEffect(() => {
    if (!restored.current) return;
    if (reopening.current !== null) {
      if (!inspector.showing) return;
      reopening.current = null;
    }
    const entry = inspector.showing && onCard ? inspectable.find((one) => one.row.key === onCard) : undefined;
    // An ask on the card whose ask read has not landed (asks.workspace down): nothing to name it by yet, so the saved
    // card is left as it is rather than cleared (P20 B round 1).
    if (entry && entry.row.kind === "ask" && !entry.ask) return;
    const card = entry?.ask ? { series: visit?.series ?? null, ask: askRefOf(entry.ask) } : null;
    if (keepSaved.current) {
      if (!card) return;
      keepSaved.current = false;
    }
    if (JSON.stringify(loadResume().card) !== JSON.stringify(card)) saveResume({ card });
  });
  // A draft restored onto an ask that changed since is kept, and said so when its card shows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the card showing an ask is the trigger, not the toast
  useEffect(() => {
    if (!inspector.showing || !onCard || !changedSince.current.has(onCard)) return;
    changedSince.current.delete(onCard);
    toast.show("This ask changed since you wrote your draft: read it again before you answer.");
  }, [inspector.showing, onCard]);

  // Your choice on each ask or review, by hold: the recommendation until you pick.
  const [choices, setChoices] = useState<Record<string, string>>({});
  // Your words on an ask written with no options, by hold.
  const [said, setSaid] = useState<Record<string, string>>({});
  const [armed, setArmed] = useState<{ key: string; choice: string; at: number } | null>(null);

  // What you picked and typed survives leaving Maestro (BRO-3180 B): seeded from the device by the ask's identity once
  // the asks are read, written back as you type, and dropped only when a fresh read shows the ask answered.
  const seeded = useRef(new Set<string>());
  const changedSince = useRef(new Set<string>());
  useEffect(() => {
    const drafts = loadDrafts();
    const seedWords: Record<string, string> = {};
    const seedChoices: Record<string, string> = {};
    for (const entry of inspectable) {
      const key = entry.row.key;
      if (!entry.ask || seeded.current.has(key)) continue;
      seeded.current.add(key);
      const draft = drafts[draftKey(askRefOf(entry.ask))];
      // An expired draft, or one for an ask no longer open, is not brought back.
      if (!draft || entry.ask.state !== "open" || Date.now() - draft.at > DRAFT_TTL_MS) continue;
      if (draft.words) seedWords[key] = draft.words;
      if (draft.chosen) seedChoices[key] = draft.chosen;
      if (draft.hash !== entry.ask.hash) changedSince.current.add(key);
    }
    if (Object.keys(seedWords).length) setSaid((now) => ({ ...seedWords, ...now }));
    if (Object.keys(seedChoices).length) setChoices((now) => ({ ...seedChoices, ...now }));
  }, [inspectable]);
  useEffect(() => {
    let drafts = loadDrafts();
    const before = drafts;
    for (const key of new Set([...Object.keys(said), ...Object.keys(choices)])) {
      const ask = inspectable.find((entry) => entry.row.key === key)?.ask;
      if (!ask || !seeded.current.has(key)) continue;
      const id = draftKey(askRefOf(ask));
      const next = draftOf(ask, choices[key], said[key], Date.now());
      const was = drafts[id];
      // Unchanged since it was stored (a seed, a re-render): left as it is, so opening Maestro never refreshes a
      // draft's age; only your edits do.
      if (next && was && was.words === next.words && was.chosen === next.chosen && was.hash === next.hash) continue;
      if (!next && !was) continue;
      drafts = withDraft(drafts, id, next);
    }
    if (drafts !== before) saveDrafts(drafts);
  }, [said, choices, inspectable]);
  useEffect(() => {
    if (!asksRead.data) return;
    const drafts = loadDrafts();
    const swept = sweepDrafts(
      drafts,
      {
        asks: decisionAsks(asksRead.data),
        fresh: asksRead.isFetchedAfterMount && !asksRead.isError,
        warnings: asksRead.data.warnings.length,
      },
      Date.now(),
    );
    if (Object.keys(swept).length !== Object.keys(drafts).length) saveDrafts(swept);
  }, [asksRead.data, asksRead.isFetchedAfterMount, asksRead.isError]);
  useEffect(() => () => flushDrafts(), []);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(null), CONFIRM_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  const advance = (from: string) => {
    // A hold the deck does not list (a review opened from its page) leaves the deck where it is.
    if (!keys.includes(from)) return;
    const next = advanceTo(keys, from, waitingKeys);
    setStand({ key: next, last: Math.max(0, keys.indexOf(next)) });
  };

  /** Answer an ask or a review: a reversible choice is sent; one that cannot be undone asks twice (answerStep). */
  const answer = async (entry: NeedEntry, item: InspectorItem, picked: string | undefined, card: boolean) => {
    const key = entry.row.key;
    // An ask that cannot be answered here says why and sends nothing (BRO-3111).
    if (item.kind === "ask" && item.refusal) {
      toast.show(`This ask cannot be answered here. ${item.refusal}`);
      return;
    }
    if (picked === undefined) {
      // An ask with no options is answered in words alone; anything else with nothing chosen opens its card.
      const words = (said[key] ?? "").trim();
      if (card && item.kind === "ask" && item.options.length === 0 && !words) {
        toast.show("Write your answer: this ask has no options.");
        return;
      }
      if (item.kind === "ask" && item.options.length === 0 && words) {
        const sent = await inspector.act("answer", inspector.targetOf(entry), undefined, words);
        if (sent) afterAnswer(key, card);
      } else inspector.selectHold(key);
      return;
    }
    // Your words go with it (BRO-3146): a note beside the option, or the answer itself when Other is chosen.
    const words = item.kind === "ask" ? (said[key] ?? "").trim() : "";
    if (picked === OTHER_CHOICE && !words) {
      toast.show("Write your answer: Other takes your own words.");
      return;
    }
    const irreversible = irreversibleChoice(item, picked);
    const step = answerStep(armed, { key, choice: picked, irreversible }, Date.now());
    if (step === "wait") return;
    if (step === "arm") {
      setArmed({ key, choice: picked, at: Date.now() });
      if (card) toast.show("This cannot be undone. Press Answer again to confirm.");
      return;
    }
    setArmed(null);
    const sent = await inspector.act("answer", inspector.targetOf(entry), picked, words, irreversible);
    // The words stay with the hold: an answer undone in its window comes back with them.
    if (sent) afterAnswer(key, card);
  };

  /** After an answer was sent: the card on a visit moves on in its series; otherwise it closes and the deck moves. */
  const afterAnswer = (key: string, card: boolean) => {
    const now = latest.current;
    if (card && now.visit && now.list.includes(key)) {
      lastAnswered.current = key;
      // The card left this ask while the answer was in flight (moved on, or closed): it is marked, nothing reopens.
      if (!now.showing || now.onCard !== key) return setVisit(marked(now.visit, key, "answered"));
      // The deck the visit was opened over (the Feed's) moves past it too.
      advance(key);
      return visitMove(key, "answered");
    }
    // The card this answer came from is closed, or another card is up now (another series opened while it was in
    // flight): whatever shows is left alone, and only the deck moves (Codex P20 round 2).
    if (card && (!now.showing || now.onCard !== key)) return advance(key);
    inspector.setOpen(false);
    advance(key);
  };

  const onDeckVerb = async (entry: NeedEntry, item: InspectorItem, id: string) => {
    const key = entry.row.key;
    if (id === "answer") return answer(entry, item, choices[key] ?? openingChoice(item), false);
    if (id === "deny") return inspector.selectHold(key);
    if (id === "skip" || id === "later") return advance(key);
    const sent = await inspector.act(id as VerbId, inspector.targetOf(entry));
    if (sent && id !== "open") advance(key);
  };

  // The card that rises: its verbs are the same as the deck's, and it hands the deck back on close.
  const keep = useRef<InspectorItem | null>(null);
  if (inspected) keep.current = inspected;
  const cardItem = inspected ?? keep.current;
  // The card pages through its series on a visit, else through the deck's holds when what it opened is one of them.
  const inVisit = onCard !== null && visit !== null && visitList.includes(onCard);
  const inDeck = !inVisit && onCard !== null && keys.includes(onCard);
  const cardIndex = inVisit ? visitList.indexOf(onCard) : inDeck ? Math.max(0, keys.indexOf(onCard)) : 0;
  const cardTotal = inVisit ? visitList.length : inDeck ? Math.max(1, keys.length) : 1;
  const onCardVerb = async (id: string, choice?: string) => {
    if (!selection) return;
    if (openEntry && cardItem && (id === "answer" || id === "skip")) {
      // Just moved on: the tap was meant for the ask before (a double tap), never for this one.
      if (inVisit && Date.now() - movedAt.current < MOVE_SETTLE_MS) return;
      if (id === "answer") return answer(openEntry, cardItem, choice, true);
      if (inVisit) return visitMove(openEntry.row.key, "skipped");
      inspector.setOpen(false);
      return advance(openEntry.row.key);
    }
    const heldKey = openEntry?.row.key ?? null;
    // The card closes and the deck moves on only when the verb was sent: a refused one leaves both where they are.
    const sent = await inspector.onVerb(id, choice);
    if (sent && id !== "open" && id !== "cancel") {
      inspector.setOpen(false);
      if (heldKey) advance(heldKey);
    }
  };

  // The sheet's row verbs, each through the one adapter.
  const rowHandlers = {
    // A notice that another view handles (a schedule, a loop) opens that view; work opens its card.
    onOpen: (row: SheetRow) => {
      if (row.target.open) requestIntent(row.target.open);
      else if (row.target.item) inspector.selectWork(row.target.item.id);
      else toast.show("It was closed: there is nothing to open.");
    },
    onContinue: (row: SheetRow) => void inspector.act("continue", { item: row.target.item }),
    onSnooze: (row: SheetRow) => void inspector.act("snooze", { notice: row.target.notice }),
    onSession: (row: SheetRow) => void inspector.act("open", { item: row.target.item }),
  };
  const canContinue = (row: SheetRow) => planVerb("continue", { item: row.target.item }).call !== "unavailable";
  const hasSession = (row: SheetRow) => planVerb("open", { item: row.target.item }).call === "session";

  // Health's deck: a notice's one verb. Unblock asks for words in a sheet of our own; Snooze is sent; the rest open
  // the view that handles the notice (a page) or its work (the card). The deck moves on only when a verb was sent.
  const [unblocking, setUnblocking] = useState<HealthRow | null>(null);
  const openNotice = (row: HealthRow) => {
    if (row.item) inspector.selectWork(row.item.id);
    else if (row.open) {
      const next = pageOfIntent(row.open);
      if (next) props.onPage(next);
      else requestIntent(row.open);
    } else toast.show("Nothing else to open for it.");
  };
  const onNoticeVerb = async (row: HealthRow, act: NoticeAct) => {
    if (act === "unblock") return setUnblocking(row);
    if (act === "open") return openNotice(row);
    const sent = await inspector.act("snooze", { notice: { key: row.key } });
    if (sent) advance(row.key);
  };

  const tabBar = (
    <TabBar
      theme={theme}
      tabs={phoneTabs(needs.data ?? null, notices.data?.summary.total ?? 0)}
      active={tab}
      onSelect={(id) => onTab(id as PhoneTab)}
      onNew={() => props.onCreating(true)}
    />
  );
  const header = (
    <DeckHeader
      theme={theme}
      workspaces={workspaceOptions(
        tab === "decisions" ? [...(rows ?? []), ...(everyOpen ?? []).map((row) => row.entry.row)] : (rows ?? []),
        items,
      )}
      workspace={workspace}
      onWorkspace={onWorkspace}
      presence={presence}
      width={Math.max(0, size.width - 32)}
      onSettings={() => props.onPage({ kind: "settings", page: "root" })}
    />
  );

  const measured = size.height > 0 && size.width > 0;
  const { page } = props;
  // The one undo toast over the card on a visit, and on the dashboard (which has no sheet to carry it).
  const ownToast = tab === "decisions" || (visit !== null && inspector.showing);

  const queue = useMemo(
    () =>
      triageQueue(
        asks.filter((ask) => !ask.idea),
        { ordering: "blocking" },
      ).filter(isTriaged),
    [asks],
  );

  // Each tab's read, for what its empty deck says: never "nothing" over a read that failed.
  const deckRead: DeckRead =
    tab === "health"
      ? noticesRead
      : tab === "work"
        ? workRead
        : tab === "decisions"
          ? bothRead(read, asksReadState)
          : read;
  const deckQueries =
    tab === "health" ? [notices] : tab === "work" ? [needs, list] : tab === "decisions" ? [needs, asksRead] : [needs];
  // When the deck's read went stale: the oldest of the reads that failed again.
  const staleAt = Math.min(
    ...deckQueries
      .filter((query) => query.isError && query.data && query.dataUpdatedAt > 0)
      .map((query) => query.dataUpdatedAt),
  );
  // The read that failed with nothing to show first, then one that failed again: its own error, not a neighbour's.
  const deckError = (
    deckQueries.find((query) => query.isError && !query.data) ?? deckQueries.find((query) => query.isError)
  )?.error;
  const deckUnread = tab === "health" ? notices.data?.summary.unread : unread;
  const empty = (
    <View style={{ paddingVertical: 28, gap: 10, alignItems: "flex-start" }}>
      {deckRead === "pending" ? <ActivityIndicator color={kit.muted} /> : null}
      <Text
        accessibilityRole="alert"
        style={{ color: deckRead === "error" || deckUnread?.length ? kit.danger : kit.muted, fontSize: 16 }}
      >
        {deckEmptyWords(deckRead, tab, deckUnread)}
      </Text>
      {deckRead === "error" || deckRead === "stale" ? (
        <>
          <Text style={{ color: kit.muted, fontSize: 13 }}>{errorText(deckError)}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Try again"
            onPress={() => {
              if (tab === "health") void notices.refetch();
              else {
                void needs.refetch();
                void list.refetch();
                if (tab === "decisions") void asksRead.refetch();
              }
            }}
            style={{
              height: 44,
              paddingHorizontal: 18,
              borderRadius: 9999,
              backgroundColor: kit.control,
              justifyContent: "center",
            }}
          >
            <Text style={{ color: kit.fg, fontWeight: "600" }}>Try again</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );

  const deckProps = {
    theme,
    title: deckTitle(tab),
    trailing: header,
    index,
    onIndexChange: move,
    directions,
    empty,
  };
  const askedAbout = (row: HealthRow) => (row.since ? ago(row.since, now) : "");

  const sheetCounts = (counts: readonly SheetCount[]) => (
    <View style={{ flexDirection: "row", gap: 5 }}>
      {counts.map((count) => (
        <Chip
          key={count.id}
          theme={theme}
          label={count.label}
          tone={count.tone}
          dense
          lead={
            "running" in count && count.running ? <TidepoolDot theme={theme} state="running" size={11} /> : undefined
          }
        />
      ))}
    </View>
  );
  // The sheet: the same frame for every tab; its toast is the surface's one undo (under a page, the page's own).
  const sheet = (counts: readonly SheetCount[], body: ReactNode) => (
    <PullSheet
      theme={theme}
      height={size.height}
      top={SHEET_TOP}
      inset={0}
      safeBottom={safe}
      tabBar={tabBar}
      title={sheetTitle(tab)}
      counts={sheetCounts(counts)}
      toast={(place) => (
        <UndoToast
          theme={theme}
          entry={page || ownToast ? null : inspector.undo.entry}
          onUndo={undo}
          bottom={place.bottom}
          lift={place.lift}
        />
      )}
    >
      {body}
    </PullSheet>
  );
  const unreadList = (what: string, error: unknown) => (
    <Text accessibilityRole="alert" style={{ color: kit.danger, fontSize: 14, paddingHorizontal: 4 }}>
      {`Couldn't read ${what} (${errorText(error)}).`}
    </Text>
  );

  const scrolled = (children: ReactNode) => (
    <ScrollView
      // Each tab starts at its own top: a scroll position is not carried from one deck to another.
      key={tab}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: TAB_BAND + (tab === "decisions" ? 0 : PEEK) + safe + 24,
        gap: 10,
      }}
    >
      {pushed ? (
        <View
          testID="from-the-push"
          style={{
            alignSelf: "flex-start",
            height: 28,
            paddingHorizontal: 12,
            borderRadius: 9999,
            backgroundColor: kit.needsSoft,
            justifyContent: "center",
          }}
        >
          <Text style={{ color: kit.needs, fontSize: 12.5, fontWeight: "600" }}>From the push · same hold</Text>
        </View>
      ) : null}
      {deckRead === "stale" && Number.isFinite(staleAt) && keys.length > 0 ? (
        <Text testID="stale-read" accessibilityRole="alert" style={{ color: kit.warn, fontSize: 13.5 }}>
          {staleWords(staleAt, now)}
        </Text>
      ) : null}
      {tab === "decisions" && cards.length > 0 && (deckRead === "ok" || deckRead === "stale") ? (
        <Text testID="decision-count" style={{ color: kit.muted, fontSize: 13.5, fontVariant: ["tabular-nums"] }}>
          {decisionCountWords(cards)}
        </Text>
      ) : null}
      {tab === "decisions" && asksRead.data ? <LedgerWarnings theme={theme} warnings={asksRead.data.warnings} /> : null}
      {tab === "decisions" && read === "error" && entries.length > 0 ? (
        <Text accessibilityRole="alert" style={{ color: kit.danger, fontSize: 13.5 }}>
          {`Couldn't read what needs you (${errorText(needs.error)}): what waits on you may be missing.`}
        </Text>
      ) : null}
      {tab === "decisions" && asksReadState === "error" && entries.length > 0 ? (
        <Text accessibilityRole="alert" style={{ color: kit.danger, fontSize: 13.5 }}>
          {`Couldn't read the open asks (${errorText(asksRead.error)}): only the holds are listed.`}
        </Text>
      ) : null}
      {deckUnread?.length ? (
        <Text testID="unread-sources" accessibilityRole="alert" style={{ color: kit.danger, fontSize: 13.5 }}>
          {unreadWords(deckUnread, tab)}
        </Text>
      ) : null}
      {gone && !unread?.length && deckRead === "ok" ? (
        <Text accessibilityRole="alert" style={{ color: kit.warn, fontSize: 13.5 }}>
          That hold is no longer waiting on you: it was answered, or it closed.
        </Text>
      ) : null}
      {children}
    </ScrollView>
  );

  const workSheet = (
    <>
      <LaneSwitcher
        theme={theme}
        lane={lane}
        counts={{
          running: laneCards(board, "running").length,
          queued: laneCards(board, "queued").length,
          standing: laneCards(board, "standing").length,
          done: laneCards(board, "done").length,
        }}
        onLane={setLane}
      />
      {list.isError && !list.data ? (
        unreadList("the work list", list.error)
      ) : laneCards(board, lane).length === 0 ? (
        <Text style={{ color: kit.muted, fontSize: 14, paddingHorizontal: 4 }}>
          {list.data ? `Nothing is ${lane === "done" ? "done in the last 24 h" : lane}.` : "Reading the work…"}
        </Text>
      ) : (
        <SheetRows
          theme={theme}
          groups={[{ id: "running", title: "", rows: laneRows(laneCards(board, lane), lane, now) }]}
          directions={directions}
          handlers={rowHandlers}
          canContinue={canContinue}
          hasSession={hasSession}
          halo={(row) => row.lead === "running"}
        />
      )}
    </>
  );

  return (
    <View
      testID="phone-shell"
      onLayout={(event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        if (!props.frame) setSize({ width, height });
      }}
      style={{ flex: 1, backgroundColor: kit.bg, ...(props.frame ? props.frame : null) }}
    >
      <SafeBottom onBottom={setSafe} />
      {scrolled(
        tab === "work" ? (
          <Deck<LaneCard>
            {...deckProps}
            items={workCards}
            keyOf={(card) => card.key}
            renderItem={(card) => (
              <WorkDeckCard
                theme={theme}
                card={card}
                hasSession={planVerb("open", { item: card.item }).call === "session"}
                onSession={() => void inspector.act("open", { item: card.item })}
                onHold={() => inspector.selectHold(card.key)}
              />
            )}
          />
        ) : tab === "health" ? (
          <Deck<HealthRow>
            {...deckProps}
            items={noticeRows}
            keyOf={(row) => row.key}
            renderItem={(row) => (
              <NoticeDeckCard
                theme={theme}
                row={row}
                age={askedAbout(row)}
                waiting={waitingWords(row.key)}
                hasSession={planVerb("open", { item: row.item }).call === "session"}
                onSession={() => void inspector.act("open", { item: row.item })}
                onVerb={(act) => void onNoticeVerb(row, act)}
                onDetails={() => openNotice(row)}
              />
            )}
          />
        ) : tab === "decisions" ? (
          <View testID="decisions-dashboard" style={{ gap: 12 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, zIndex: 20 }}>
              <Text accessibilityRole="header" style={{ flex: 1, color: kit.fg, fontSize: 24, fontWeight: "700" }}>
                {deckTitle(tab)}
              </Text>
              {header}
            </View>
            <AnswersSummary theme={theme} counts={answersCounts(answersRead.data ?? null)}>
              <AnswersSheet
                theme={theme}
                tiles={stageTiles(queue, needs.data ?? null, answersRead.data ?? null, now)}
                held={answersRead.data?.held ?? null}
                went={answersRead.data ? wentRows(answersRead.data.recent) : null}
                onOpenPr={openUrl}
              />
            </AnswersSummary>
            {cards.length === 0 ? (
              empty
            ) : series.length === 0 ? null : (
              <SeriesList theme={theme} series={series} now={now} onOpen={(one) => openSeries(one)} />
            )}
          </View>
        ) : (
          <Deck<NeedEntry>
            {...deckProps}
            items={entries}
            keyOf={(entry) => entry.row.key}
            renderItem={(entry) => {
              const item = holdInspector(entry, now);
              const key = entry.row.key;
              return (
                <HoldCard
                  theme={theme}
                  item={item}
                  verbs={deckVerbs(item, entry.row.session !== undefined)}
                  choice={choices[key] ?? openingChoice(item)}
                  armed={armed?.key === key && armed.choice === (choices[key] ?? openingChoice(item))}
                  waiting={waitingWords(key)}
                  busy={false}
                  words={said[key] ?? ""}
                  onWords={(text) => setSaid((now) => ({ ...now, [key]: text }))}
                  onChoose={(id) => {
                    setArmed(null);
                    setChoices((now) => ({ ...now, [key]: id }));
                  }}
                  onDetails={() => openHold(key)}
                  onVerb={(id) => void onDeckVerb(entry, item, id)}
                />
              );
            }}
          />
        ),
      )}

      {measured && tab === "feed"
        ? sheet(
            feedCounts(sections, handled.data ?? null),
            list.isError && !list.data ? (
              unreadList("the work list", list.error)
            ) : groups.length === 0 ? (
              <Text style={{ color: kit.muted, fontSize: 14, paddingHorizontal: 4 }}>
                {list.data ? "Nothing else is running, queued or finished." : "Reading the work…"}
              </Text>
            ) : (
              <SheetRows
                theme={theme}
                groups={groups}
                directions={directions}
                handlers={rowHandlers}
                canContinue={canContinue}
                hasSession={hasSession}
              />
            ),
          )
        : null}
      {measured && tab === "decisions" ? (
        // The dashboard has no sheet (BRO-3172): the tab bar sits on the bottom edge by itself.
        <View
          testID="tab-band"
          style={{ position: "absolute", left: 0, right: 0, bottom: safe + 8, height: TAB_BAND, paddingHorizontal: 12 }}
        >
          {tabBar}
        </View>
      ) : null}
      {measured && tab === "work" ? sheet(workCounts(board), workSheet) : null}
      {measured && tab === "health" ? (
        <HealthHost
          items={items}
          workFailed={list.isError && !list.data}
          now={now}
          render={(model, lanes) =>
            sheet(
              healthCounts(model, lanes),
              <FleetSheet
                theme={theme}
                model={model}
                directions={directions}
                due={(rows ?? []).filter((row) => row.key.startsWith("review:")).length}
                onTile={() => undefined}
                onLog={() => props.onPage({ kind: "loops" })}
                onPage={(next) =>
                  props.onPage(next === "fleet" ? { kind: "fleet", scope: null, tick: null } : { kind: next })
                }
              />,
            )
          }
        />
      ) : null}

      {page ? (
        <PagePanel
          theme={theme}
          height={size.height}
          trail={pageTrail(page)}
          onBack={() => props.onPage(page.kind === "settings" ? { kind: "settings", page: "root" } : null)}
          onClose={() => props.onPage(null)}
        >
          <PageBody
            theme={theme}
            page={page}
            navigation={navigation}
            presence={presence}
            onPage={props.onPage}
            onOpenHold={openHold}
            onOpenDecision={props.onOpenDecision}
            onOpenWork={(id) => (items.some((one) => one.id === id) ? inspector.selectWork(id) : props.onOpenWork(id))}
          />
        </PagePanel>
      ) : null}
      {props.creating ? (
        <NewWorkSheet
          theme={theme}
          height={size.height}
          safeBottom={safe}
          onClose={() => props.onCreating(false)}
          onCreated={() => props.onCreating(false)}
        />
      ) : null}
      {measured && cardItem ? (
        <InspectorCard
          theme={theme}
          directions={directions}
          // It starts on the option chosen on the deck (Codex P20 round 2): the deck's note rides with that option.
          item={
            openEntry && (cardItem.kind === "ask" || cardItem.kind === "review")
              ? { ...cardItem, chosen: choices[openEntry.row.key] ?? openingChoice(cardItem) }
              : cardItem
          }
          index={cardIndex}
          total={cardTotal}
          open={inspector.showing}
          height={size.height}
          onClose={() => inspector.setOpen(false)}
          safeBottom={safe}
          onMore={() => {
            if (openEntry?.row.session || inspector.item?.worker)
              void inspector.act("open", inspector.targetOf(openEntry));
            else toast.show("Nothing else to do here.");
          }}
          onVerb={onCardVerb}
          // The deck card's words, shown and edited on the card too (BRO-3146): one set of words per hold.
          words={openEntry ? (said[openEntry.row.key] ?? "") : ""}
          onWords={openEntry ? (text) => setSaid((now) => ({ ...now, [openEntry.row.key]: text })) : undefined}
          // A pick on the card is the deck's pick too: closed, the deck answers with what the card showed.
          onChoose={
            openEntry
              ? (id) => {
                  setArmed(null);
                  setChoices((now) => ({ ...now, [openEntry.row.key]: id }));
                }
              : undefined
          }
          // The card swiped to another hold: the deck is on it when the card closes.
          onIndexChange={(at) => {
            if (inVisit && visit && onCard) {
              // Toward the swipe, to the nearest ask the visit may show; none that way, it stays.
              const target = visitList[at];
              const ok = mayShow(visit);
              const to = target && ok(target) ? target : nextInVisit(walk(visit), onCard, ok, at > cardIndex ? 1 : -1);
              if (to) inspector.selectHold(to);
              return;
            }
            const next = keys[at];
            if (!next) return;
            move(at);
            inspector.selectHold(next);
          }}
          onOpenSession={() => void inspector.act("open", inspector.targetOf(openEntry))}
        />
      ) : null}
      {!page && ownToast ? (
        <UndoToast
          theme={theme}
          entry={inspector.undo.entry}
          onUndo={undo}
          // Over the card, above its pinned verbs; on the dashboard, above the tab bar.
          bottom={inspector.showing ? safe + 96 : TAB_BAND + safe + 16}
          lift={0}
        />
      ) : null}
      {unblocking ? (
        <UnblockSheet
          theme={theme}
          title={unblocking.title}
          safeBottom={safe}
          onCancel={() => setUnblocking(null)}
          onSend={async (words) => {
            // Closes and moves on only when the prompt was sent; the work is the one the notice was drawn from.
            const sent = await inspector.act("unblock", { item: unblocking.item }, undefined, words);
            if (sent) {
              setUnblocking(null);
              advance(unblocking.key);
            }
            return sent;
          }}
        />
      ) : null}
      {page ? <UndoToast theme={theme} entry={inspector.undo.entry} onUndo={undo} bottom={safe + 16} lift={0} /> : null}
    </View>
  );
}
