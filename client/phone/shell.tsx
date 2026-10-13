// The phone's Maestro (M1, BRO-3037; docs/design/next/m1-feed-home-mobile.png): every tab is a deck of what
// needs you there, and a sheet of everything else peeks from the bottom edge with the tab bar riding on its top
// edge. This module reads what the desktop reads (needs.list, handled.list, notices.list, the work list, the asks,
// answers.status, the verb ledger) and wires the kit's parts to it: the Deck and its holds, the pull-up sheet,
// the swipe rows on it, the card that rises (M2–M4), and the undo toast. Every verb is sent through
// client/use-inspector.ts and client/verbs.ts, the adapter the desktop uses, so a verb here is the same act with
// the same 8 s undo (B4). Work and Health keep today's bodies until M6 and M7 replace them (`classic`).
//
// What the deck shows and what a verb sends come from one read: a hold's card is drawn from its entry, and
// its verbs send that entry's target, never an id looked up again. A read that failed says so; it never reads as
// "nothing needs you". The deck follows a hold by key, so the list changing under it moves nothing onto the
// wrong hold.

import type { PluginTheme } from "@getpaseo/plugin";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, type LayoutChangeEvent, Pressable, ScrollView, Text, View } from "react-native";
import { useWorkspaceAsks } from "../decisions";
import { decisionAsks, isTriaged, triageQueue } from "../decisions-model";
import { stageTiles, wentRows } from "../decisions-stage-model";
import { type NeedEntry, needsSection } from "../feed-model";
import { errorText } from "../format";
import type { HomeFocus } from "../home";
import { holdInspector, holdParam, homeSections, workspaceOptions } from "../home-model";
import { useAnswersStatus, useHandled, useNeeds, useNotices, useVerbLedger, useWorkList } from "../hooks";
import { requestIntent } from "../intent";
import { type Directions, swipeDirections } from "../kit/assumptions";
import { Deck } from "../kit/deck";
import { InspectorCard, type InspectorItem } from "../kit/inspector";
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
import { AnswersSheet } from "./answers-sheet";
import { DeckHeader } from "./deck-header";
import { HoldCard } from "./hold-card";
import {
  advanceTo,
  answerStep,
  answersCounts,
  CONFIRM_WINDOW_MS,
  decisionsDeck,
  deckEmptyWords,
  deckTitle,
  deckVerbs,
  feedCounts,
  feedDeck,
  feedSheet,
  irreversibleChoice,
  openingChoice,
  type PhoneTab,
  phoneTabs,
  resolveIndex,
  type SheetRow,
  sheetTitle,
  unreadWords,
} from "./model";
import { SheetRows } from "./sheet-rows";

/** The sheet's top when it is up: the tab bar stops this far under Paseo's header. */
const SHEET_TOP = 12;

export interface PhoneSurfaceProps {
  theme: PluginTheme;
  layout: { compact: boolean; platform: string };
  navigation?: { openAgent: (input: { agentId: string }) => void };
  tab: PhoneTab;
  onTab: (tab: PhoneTab) => void;
  workspace: string | null;
  onWorkspace: (id: string | null) => void;
  /** A hold or work to open on: `params.hold` (a push), or an intent from elsewhere. */
  focus: HomeFocus | null;
  onFocusHandled: () => void;
  onNew: () => void;
  /** Work this screen has no hold or row for opens on its own page. */
  onOpenWork: (id: string) => void;
  /** The body of the tabs M6 and M7 have not replaced yet. */
  classic: ReactNode;
  /** A frame the host already knows (a test, a shot): otherwise the screen's own layout is measured. */
  frame?: { width: number; height: number };
}

type Read = "pending" | "error" | "ok";

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
  const asks = asksRead.data ? decisionAsks(asksRead.data) : [];
  const rows = needs.data?.rows ?? null;
  const read: Read = needs.data ? "ok" : needs.isError ? "error" : "pending";
  // Sources needs.list could not read (BRO-3008): their holds are missing because the read failed, never answered.
  const unread = needs.data?.unread;

  // Every hold, joined to its work or ask: the deck and the card read this, and every verb sends from it.
  const everyHold = useMemo(() => needsSection(rows ?? [], items, asks), [rows, items, asks]);
  const entries = useMemo(() => {
    const scoped = everyHold.filter((entry) => workspace === null || entry.row.scope === workspace);
    return tab === "decisions" ? decisionsDeck(scoped) : feedDeck(scoped);
  }, [everyHold, tab, workspace]);
  const keys = entries.map((entry) => entry.row.key);

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
    entries: everyHold,
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

  // Opening on a hold (`params.hold`, M10) or work: once needs.list has been read since this screen mounted.
  const fresh = needs.isFetchedAfterMount || needs.isError ? rows : null;
  const handledFocus = useRef(-1);
  const { onOpenWork } = props;
  useEffect(() => {
    if (!focus || handledFocus.current === focus.at) return;
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
      setStand({ key: target.key, last: 0 });
      setPushedAt(focus.from === "push" ? { key: target.key, tab } : null);
      setGone(null);
    } else if (target.kind === "gone") setGone(target.key);
  });

  // A card belongs to the tab it rose from: another tab starts without it.
  const closeCard = inspector.setOpen;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a change of tab closes the card
  useEffect(() => {
    closeCard(false);
  }, [tab]);

  // Your choice on each ask or review, by hold: the recommendation until you pick.
  const [choices, setChoices] = useState<Record<string, string>>({});
  // Your words on an ask written with no options, by hold.
  const [said, setSaid] = useState<Record<string, string>>({});
  const [armed, setArmed] = useState<{ key: string; choice: string; at: number } | null>(null);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(null), CONFIRM_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  const advance = (from: string) => {
    const next = advanceTo(keys, from, waitingKeys);
    setStand({ key: next, last: Math.max(0, keys.indexOf(next)) });
  };

  /** Answer an ask or a review: a reversible choice is sent; one that cannot be undone asks twice (answerStep). */
  const answer = async (entry: NeedEntry, item: InspectorItem, picked: string | undefined, card: boolean) => {
    const key = entry.row.key;
    if (picked === undefined) {
      // An ask with no options is answered in words alone; anything else with nothing chosen opens its card.
      const words = (said[key] ?? "").trim();
      if (item.kind === "ask" && item.options.length === 0 && words) {
        const sent = await inspector.act("answer", inspector.targetOf(entry), undefined, words);
        if (sent) {
          setSaid((now) => ({ ...now, [key]: "" }));
          inspector.setOpen(false);
          advance(key);
        }
      } else inspector.selectHold(key);
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
    const sent = await inspector.act("answer", inspector.targetOf(entry), picked, "", irreversible);
    if (sent) {
      inspector.setOpen(false);
      advance(key);
    }
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
  const cardIndex = selection?.kind === "hold" ? Math.max(0, keys.indexOf(selection.key)) : 0;
  const cardTotal = selection?.kind === "hold" ? Math.max(1, keys.length) : 1;
  const onCardVerb = (id: string, choice?: string) => {
    if (!selection) return;
    if (openEntry && cardItem && (id === "answer" || id === "skip")) {
      if (id === "answer") return void answer(openEntry, cardItem, choice, true);
      inspector.setOpen(false);
      return advance(openEntry.row.key);
    }
    const heldKey = openEntry?.row.key ?? null;
    inspector.onVerb(id, choice);
    if (id !== "open" && id !== "cancel") {
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
    },
    onContinue: (row: SheetRow) => void inspector.act("continue", { item: row.target.item }),
    onSnooze: (row: SheetRow) => void inspector.act("snooze", { notice: row.target.notice }),
    onSession: (row: SheetRow) => void inspector.act("open", { item: row.target.item }),
  };
  const canContinue = (row: SheetRow) => planVerb("continue", { item: row.target.item }).call !== "unavailable";
  const hasSession = (row: SheetRow) => planVerb("open", { item: row.target.item }).call === "session";

  const tabBar = (
    <TabBar
      theme={theme}
      tabs={phoneTabs(needs.data ?? null, notices.data?.summary.total ?? 0)}
      active={tab}
      onSelect={(id) => onTab(id as PhoneTab)}
      onNew={props.onNew}
    />
  );
  const header = (
    <DeckHeader
      theme={theme}
      workspaces={workspaceOptions(rows ?? [], items)}
      workspace={workspace}
      onWorkspace={onWorkspace}
      presence={presence}
      width={Math.max(0, size.width - 32)}
    />
  );

  const deckTab = tab === "feed" || tab === "decisions";
  const measured = size.height > 0 && size.width > 0;

  const queue = useMemo(
    () =>
      triageQueue(
        asks.filter((ask) => !ask.idea),
        { ordering: "blocking" },
      ).filter(isTriaged),
    [asks],
  );

  const empty = (
    <View style={{ paddingVertical: 28, gap: 10, alignItems: "flex-start" }}>
      {read === "pending" ? <ActivityIndicator color={kit.muted} /> : null}
      <Text
        accessibilityRole="alert"
        style={{ color: read === "error" || unread?.length ? kit.danger : kit.muted, fontSize: 16 }}
      >
        {deckEmptyWords(read, tab, unread)}
      </Text>
      {read === "error" ? (
        <>
          <Text style={{ color: kit.muted, fontSize: 13 }}>{errorText(needs.error)}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Try again"
            onPress={() => void needs.refetch()}
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
      {deckTab ? (
        <ScrollView
          // Each tab starts at its own top: a scroll position is not carried from one deck to another.
          key={tab}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: TAB_BAND + PEEK + safe + 24,
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
          {unread?.length ? (
            <Text testID="unread-sources" accessibilityRole="alert" style={{ color: kit.danger, fontSize: 13.5 }}>
              {unreadWords(unread)}
            </Text>
          ) : null}
          {gone && !unread?.length ? (
            <Text accessibilityRole="alert" style={{ color: kit.warn, fontSize: 13.5 }}>
              That hold is no longer waiting on you: it was answered, or it closed.
            </Text>
          ) : null}
          <Deck
            theme={theme}
            title={deckTitle(tab)}
            trailing={header}
            items={entries}
            index={index}
            onIndexChange={move}
            keyOf={(entry) => entry.row.key}
            directions={directions}
            empty={empty}
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
                  onDetails={() => inspector.selectHold(key)}
                  onVerb={(id) => void onDeckVerb(entry, item, id)}
                />
              );
            }}
          />
        </ScrollView>
      ) : (
        <View style={{ flex: 1, paddingBottom: TAB_BAND + safe }}>{props.classic}</View>
      )}

      {measured && deckTab ? (
        <PullSheet
          theme={theme}
          height={size.height}
          top={SHEET_TOP}
          inset={0}
          safeBottom={safe}
          tabBar={tabBar}
          title={sheetTitle(tab)}
          counts={
            <View style={{ flexDirection: "row", gap: 5 }}>
              {(tab === "feed"
                ? feedCounts(sections, handled.data ?? null)
                : answersCounts(answersRead.data ?? null)
              ).map((count) => (
                <Chip
                  key={count.id}
                  theme={theme}
                  label={count.label}
                  tone={count.tone}
                  dense
                  lead={
                    "running" in count && count.running ? (
                      <TidepoolDot theme={theme} state="running" size={11} />
                    ) : undefined
                  }
                />
              ))}
            </View>
          }
          toast={(place) => (
            <UndoToast
              theme={theme}
              entry={inspector.undo.entry}
              onUndo={inspector.undo.undo}
              bottom={place.bottom}
              lift={place.lift}
            />
          )}
        >
          {tab === "feed" ? (
            list.isError && !list.data ? (
              <Text accessibilityRole="alert" style={{ color: kit.danger, fontSize: 14, paddingHorizontal: 4 }}>
                {`Couldn't read the work list (${errorText(list.error)}).`}
              </Text>
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
            )
          ) : (
            <AnswersSheet
              theme={theme}
              tiles={stageTiles(queue, needs.data ?? null, answersRead.data ?? null, now)}
              held={answersRead.data?.held ?? null}
              went={answersRead.data ? wentRows(answersRead.data.recent) : null}
              onOpenPr={openUrl}
            />
          )}
        </PullSheet>
      ) : null}
      {!deckTab ? (
        <View
          pointerEvents="box-none"
          style={{ position: "absolute", left: 0, right: 0, bottom: safe, height: TAB_BAND, paddingHorizontal: 12 }}
        >
          {tabBar}
        </View>
      ) : null}
      {measured && cardItem ? (
        <InspectorCard
          theme={theme}
          directions={directions}
          item={cardItem}
          index={cardIndex}
          total={cardTotal}
          open={inspector.showing}
          height={size.height}
          onClose={() => inspector.setOpen(false)}
          onMore={() => {
            if (openEntry?.row.session || inspector.item?.worker)
              void inspector.act("open", inspector.targetOf(openEntry));
            else toast.show("Nothing else to do here.");
          }}
          onVerb={onCardVerb}
          // The card swiped to another hold: the deck is on it when the card closes.
          onIndexChange={(at) => {
            const next = keys[at];
            if (!next) return;
            move(at);
            inspector.selectHold(next);
          }}
          onOpenSession={() => void inspector.act("open", inspector.targetOf(openEntry))}
        />
      ) : null}
    </View>
  );
}
