// J1, the Feed home on the desktop (BRO-3035; docs/design/next/j1-feed-home.png): the body under Maestro's
// header. A scope bar of kind chips, the four glance tiles, the main column (every hold as a full card, then
// what you watch as rows), the rail (Decide, Handled for you, Proposals), and the inspector that slides in
// from the right over the rail. It reads needs.list and handled.list and shows what home-model.ts decided; the
// header's count, the Feed tab, the Needs you tile and the Needs you section are one number.
//
// Selection, not navigation (J1's note): the card you opened stays lit in the stream, J and K walk the holds
// while the inspector is open, and Esc closes it while Maestro has focus. Every verb goes through
// client/verbs.ts; one that leaves a receipt shows the undo toast for UNDO_MS (B4).

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useWorkspaceAsks } from "./decisions";
import { decisionAsks, ledgerOf } from "./decisions-model";
import { needsSection } from "./feed-model";
import { errorText } from "./format";
import {
  DecideRail,
  FinishedRow,
  HandledRail,
  HealthRowView,
  HoldCard,
  ProposalsRail,
  QueuedList,
  RunningRow,
  SectionHeading,
} from "./home-cards";
import {
  glanceTiles,
  holdInspector,
  holdKindOf,
  holdParam,
  homeSections,
  type KindFilter,
  keyAction,
  kindChips,
  needsHint,
  railOf,
  type Selection,
  stepHold,
  workInspector,
} from "./home-model";
import { useHandled, useLoop, useNeeds, useWatched, useWorkList } from "./hooks";
import { requestIntent } from "./intent";
import { GlanceTile } from "./kit/glance-tile";
import { InspectorPanel } from "./kit/inspector";
import { Dot, PASS_THROUGH, TABULAR } from "./kit/parts";
import { kitOf } from "./kit/tokens";
import { undoEntry } from "./kit/undo-model";
import { UndoToast, useUndoToast } from "./kit/undo-toast";
import { useOpenUrl } from "./open-url";
import { groupHint } from "./plane-model";
import { Notice } from "./ui";
import { planVerb, useVerbs, type VerbId, type VerbTarget } from "./verbs";

/** Something to open: a hold by its key (Paseo's `params.hold`, a count or a card), or the work item with this id. */
export interface HomeFocus {
  hold?: string;
  work?: string;
  /** When it was asked: a later one is a new request even for the same hold. */
  at: number;
}

const INSPECTOR_WIDTH = 480;

/** The time now, moved on every `ms` while mounted. */
function useTick(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

type KeyEvent = {
  key: string;
  repeat?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  target?: unknown;
  preventDefault?: () => void;
};

function typingIn(target: unknown): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
  const tag = el?.tagName?.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!el?.isContentEditable;
}

export function HomeScreen({
  theme,
  navigation,
  workspace,
  query,
  focus,
  onFocusHandled,
  onOpenWork,
}: {
  theme: PluginTheme;
  navigation?: { openAgent: (input: { agentId: string }) => void };
  workspace: string | null;
  query: string;
  focus: HomeFocus | null;
  /** Said once `focus` has been acted on, so a remount (another tab and back) does not act on it again. */
  onFocusHandled: () => void;
  /** Work this screen cannot show as a hold or a row: it opens in the work's own detail. */
  onOpenWork: (id: string) => void;
}) {
  const kit = kitOf(theme);
  const list = useWorkList();
  const needs = useNeeds();
  const handled = useHandled();
  const loop = useLoop();
  const watched = useWatched();
  const asksRead = useWorkspaceAsks();
  const toast = useToast();
  const openUrl = useOpenUrl();
  const verbs = useVerbs();
  const undo = useUndoToast((receipt) => {
    verbs.undo(receipt).catch((error: unknown) => toast.error(errorText(error)));
  });
  const now = useTick(15_000);
  const root = useRef<unknown>(null);
  const [width, setWidth] = useState(0);
  const [filter, setFilter] = useState<KindFilter>("all");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [open, setOpen] = useState(false);
  const [gone, setGone] = useState<string | null>(null);
  const [scrollY, setScrollY] = useState(0);
  const [columnsTop, setColumnsTop] = useState(0);

  const items = list.data?.items ?? [];
  const asks = asksRead.data ? decisionAsks(asksRead.data) : [];
  const rows = needs.data?.rows ?? null;
  const homeInput = {
    needs: needs.data ?? null,
    handled: handled.data ?? null,
    items,
    asks,
    watched: watched.data ?? null,
    workspace,
    filter,
    query,
  };
  const sections = homeSections(homeInput);
  // Every hold, joined, whatever the chips and the search keep: a selection survives a filter.
  const everyHold = useMemo(() => needsSection(rows ?? [], items, asks), [rows, items, asks]);
  const holdKeys = sections.needs.map((entry) => entry.row.key);
  const visibleHolds = filter === "all" ? sections.needs : homeSections({ ...homeInput, filter: "all" }).needs;
  const finishedAll = homeSections({
    needs: needs.data ?? null,
    handled: handled.data ?? null,
    items,
    asks,
    watched: watched.data ?? null,
    workspace: null,
    filter: "all",
    query: "",
  });
  const chips = kindChips(needs.data?.summary ?? null, finishedAll.health.length, finishedAll.finished.length, filter);
  const tiles = glanceTiles(
    needs.data ?? null,
    handled.data ?? null,
    items,
    list.data?.scoreboard ?? null,
    loop.data ?? null,
    now,
  );
  const rail = railOf(asks, handled.data ?? null);

  const entry = selection?.kind === "hold" ? (everyHold.find((one) => one.row.key === selection.key) ?? null) : null;
  const chosenItem = selection?.kind === "work" ? (items.find((one) => one.id === selection.id) ?? null) : null;
  const inspected = entry ? holdInspector(entry, now) : chosenItem ? workInspector(chosenItem, now) : null;
  const kind: Parameters<typeof keyAction>[0] = entry
    ? holdKindOf(entry.row)
    : chosenItem?.state === "blocked"
      ? "notice"
      : "work";

  const selectHold = (key: string) => {
    setSelection({ kind: "hold", key });
    setOpen(true);
  };
  const selectWork = (id: string) => {
    setSelection({ kind: "work", id });
    setOpen(true);
  };

  // Opening on `params.hold` (BRO-3033 fact 2) or a count or card elsewhere: that hold's inspector, once needs.list is read.
  // Only a read made since this screen mounted is the truth about a hold: a cached one may predate it.
  const fresh = needs.isFetchedAfterMount || needs.isError ? rows : null;
  const handledFocus = useRef(-1);
  useEffect(() => {
    if (!focus || handledFocus.current === focus.at) return;
    if (focus.work) {
      const held = (fresh ?? []).find((row) => row.key === `work:${focus.work}`);
      if (fresh === null && !held) return;
      if (!held && !list.data) return;
      handledFocus.current = focus.at;
      onFocusHandled();
      if (held) selectHold(held.key);
      else if (items.some((one) => one.id === focus.work)) selectWork(focus.work);
      else onOpenWork(focus.work);
      return;
    }
    const target = holdParam(focus.hold, fresh);
    if (target.kind === "wait") return;
    handledFocus.current = focus.at;
    onFocusHandled();
    if (target.kind === "open") selectHold(target.key);
    else if (target.kind === "gone") setGone(target.key);
  });

  const env = {
    openUrl,
    openAgent: (agentId: string) => navigation?.openAgent({ agentId }),
  };
  // One verb at a time on a hold: it cannot be acted on again until the call has answered and every read has landed.
  const inFlight = useRef(new Set<string>());
  const act = async (verb: VerbId, target: VerbTarget, choice?: string) => {
    const id = target.row?.key ?? (target.item ? `work:${target.item.id}` : (target.proposal ?? verb));
    if (inFlight.current.has(id)) return;
    inFlight.current.add(id);
    let landed: Promise<void> = Promise.resolve();
    try {
      const plan = planVerb(verb, target, choice);
      const out = await verbs.run(plan, env);
      landed = out.settled;
      // Work this screen has no hold or row for opens in its own detail; the rest is for the tab that owns it.
      if (out.go?.kind === "select") onOpenWork(out.go.id);
      else if (out.go) requestIntent(out.go);
      if (out.receipt) undo.show(undoEntry(out.receipt, out.done, Date.now(), out.appliesAt, "applies in"));
      else toast.show(out.done);
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      void landed.catch(() => undefined).then(() => inFlight.current.delete(id));
    }
  };
  const targetOf = (hold: typeof entry): VerbTarget =>
    hold ? { row: hold.row, item: hold.item, ask: hold.ask } : { item: chosenItem };

  const onCardVerb = (hold: NonNullable<typeof entry>, id: string) => {
    if (id === "deny" || id === "answer") selectHold(hold.row.key);
    else void act(id as VerbId, targetOf(hold));
  };
  const onInspectorVerb = (id: string, choice?: string) => void act(id as VerbId, targetOf(entry), choice);

  const walk = (step: 1 | -1) => {
    const next = stepHold(holdKeys, selection?.kind === "hold" ? selection.key : null, step);
    if (next) selectHold(next);
  };
  const walkRef = useRef(walk);
  walkRef.current = walk;
  const keyRef = useRef({ kind, open, inspected: inspected !== null, onVerb: onInspectorVerb });
  keyRef.current = { kind, open, inspected: inspected !== null, onVerb: onInspectorVerb };
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const doc = (
      globalThis as {
        document?: {
          addEventListener(type: "keydown", fn: (event: KeyEvent) => void): void;
          removeEventListener(type: "keydown", fn: (event: KeyEvent) => void): void;
          body?: unknown;
        };
      }
    ).document;
    if (!doc) return;
    const onHomeKey = (event: KeyEvent) => {
      if (!keyRef.current.open || !keyRef.current.inspected) return;
      // Maestro's keys are Maestro's only while focus is inside its screen: the page's body is not Maestro's.
      const within = root.current as { contains?: (other: unknown) => boolean } | null;
      const target = event.target;
      if (!target || !within?.contains?.(target)) return;
      const action = keyAction(
        keyRef.current.kind,
        { key: event.key, meta: event.metaKey, ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey },
        typingIn(target),
      );
      if (!action) return;
      event.preventDefault?.();
      if ("step" in action) walkRef.current(action.step);
      // A held key sends a verb once: only the first press acts.
      else if (!event.repeat) keyRef.current.onVerb(action.verb);
    };
    doc.addEventListener("keydown", onHomeKey);
    return () => doc.removeEventListener("keydown", onHomeKey);
  }, []);

  const wide = width === 0 || width >= 1060;
  const showing = open && inspected !== null;
  const panelWidth = width > 0 ? Math.min(INSPECTOR_WIDTH, width - 32) : INSPECTOR_WIDTH;
  const panelTop = Math.max(0, columnsTop - scrollY - 16);
  const railNodes = (
    <View style={{ gap: 12 }}>
      <DecideRail
        theme={theme}
        rows={rail.decide.rows}
        more={rail.decide.more}
        onOpen={(ask) =>
          requestIntent(
            ask ? { kind: "decisions", ledger: ledgerOf(ask), id: ask.id, key: null } : { kind: "decisions" },
          )
        }
      />
      <HandledRail theme={theme} groups={rail.handled} onOpenWork={(id) => selectWork(id)} />
      <ProposalsRail theme={theme} asks={rail.proposals} onVerb={(key, verb) => void act(verb, { proposal: key })} />
    </View>
  );
  const nothing =
    sections.needs.length +
      sections.finished.length +
      sections.health.length +
      sections.running.length +
      sections.queued.length ===
    0;
  const canPrompt = planVerb("continue", {}).call !== "unavailable";
  const selectedKey = selection?.kind === "hold" ? selection.key : null;
  const selectedWork = selection?.kind === "work" ? selection.id : null;

  return (
    <View
      ref={root as never}
      testID="home-screen"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{ flex: 1 }}
    >
      <ScrollView
        contentContainerStyle={{ padding: 20, paddingTop: 12, gap: 16 }}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={32}
        onScroll={(event) => setScrollY(event.nativeEvent.contentOffset.y)}
      >
        {needs.isError && !needs.data ? (
          <Notice theme={theme} tone="danger">
            {`What needs you could not be read (${errorText(needs.error)}); the count and Needs you come back when it reads.`}
          </Notice>
        ) : null}
        {gone ? (
          <Notice theme={theme} tone="warn">
            That hold is no longer waiting on you: it was answered, or it closed.
          </Notice>
        ) : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <View accessibilityRole="radiogroup" style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", flex: 1 }}>
            {chips.map((chip) => {
              const chosen = chip.id === filter;
              return (
                <Pressable
                  key={chip.id}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: chosen }}
                  accessibilityLabel={chip.label}
                  onPress={() => setFilter(chip.id)}
                  style={({ pressed }: { pressed: boolean }) => ({
                    height: 30,
                    paddingHorizontal: 14,
                    borderRadius: 9999,
                    justifyContent: "center",
                    backgroundColor: chosen ? kit.ink : kit.sunken,
                    opacity: pressed ? 0.8 : 1,
                  })}
                >
                  <Text
                    style={{
                      color: chosen ? kit.onInk : kit.fg2,
                      fontSize: 13,
                      fontWeight: chosen ? "600" : "400",
                      ...TABULAR,
                    }}
                  >
                    {chip.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={{ color: kit.muted, fontSize: 12.5 }}>
            {workspace ? `Showing ${workspace}` : "Showing all workspaces"} · sorted by what blocks work
          </Text>
        </View>

        <View style={{ flexDirection: "row", gap: 14, flexWrap: "wrap" }}>
          <GlanceTile
            theme={theme}
            icon="Hand"
            label="Needs you"
            value={String(tiles.needs.value)}
            unit={tiles.needs.value === 1 ? "hold" : "holds"}
            line={tiles.needs.line}
            tone={tiles.needs.value > 0 ? "needs" : "plain"}
            onPress={() => {
              setFilter("all");
              // The first hold you can see: the workspace and the search still narrow what is listed.
              const first = visibleHolds[0]?.row.key;
              if (first) selectHold(first);
              else toast.show("No hold here: the workspace or the search hides them");
            }}
          >
            {tiles.needs.oldest ? (
              <Text style={{ color: kit.fg2, fontSize: 12.5 }} numberOfLines={1}>
                {tiles.needs.oldest}
              </Text>
            ) : null}
          </GlanceTile>
          <GlanceTile
            theme={theme}
            icon="Loader"
            label="Running"
            value={String(tiles.running.value)}
            unit={tiles.running.value === 1 ? "session" : "sessions"}
            onPress={() => setFilter("all")}
          >
            {tiles.running.rows.map((row) => (
              <View key={row.key} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Dot color={kit.blue} size={8} />
                <Text style={{ color: kit.fg2, fontSize: 12.5 }} numberOfLines={1}>
                  {row.scope} · {row.text}
                </Text>
              </View>
            ))}
          </GlanceTile>
          <GlanceTile
            theme={theme}
            icon="CircleCheck"
            label="Handled today"
            value={String(tiles.handled.value)}
            unit="closed for you"
            line={tiles.handled.line}
          >
            {tiles.handled.last ? (
              <Text style={{ color: kit.fg2, fontSize: 12.5 }} numberOfLines={1}>
                {tiles.handled.last}
              </Text>
            ) : null}
          </GlanceTile>
          <GlanceTile
            theme={theme}
            icon="Timer"
            label="Unsupervised today"
            value={tiles.unsupervised.value}
            line={undefined}
          >
            <View style={{ height: 22, justifyContent: "flex-end" }}>
              <View style={{ height: 14, borderRadius: 4, backgroundColor: kit.sunken }}>
                {tiles.unsupervised.segments.map((segment) => (
                  <View
                    key={segment.start}
                    style={{
                      position: "absolute",
                      left: `${segment.start * 100}%`,
                      width: `${Math.max(segment.width * 100, 1)}%`,
                      top: 0,
                      bottom: 0,
                      borderRadius: 3,
                      backgroundColor: segment.live ? kit.blue : kit.border,
                    }}
                  />
                ))}
              </View>
            </View>
            <Text style={{ color: kit.fg2, fontSize: 12.5 }} numberOfLines={1}>
              {tiles.unsupervised.next}
            </Text>
          </GlanceTile>
        </View>

        <View
          onLayout={(event) => setColumnsTop(event.nativeEvent.layout.y)}
          style={{
            flexDirection: "row",
            gap: 16,
            alignItems: "flex-start",
            paddingRight: showing ? panelWidth + 16 : 0,
          }}
        >
          <View style={{ flex: 1, gap: 20, minWidth: 0 }}>
            {list.isPending || needs.isPending ? <ActivityIndicator color={kit.muted} /> : null}
            {list.isError ? (
              <Notice theme={theme} tone="danger">
                {errorText(list.error)}
              </Notice>
            ) : null}
            {sections.needs.length > 0 ? (
              <View style={{ gap: 12 }}>
                <SectionHeading
                  theme={theme}
                  title="Needs you"
                  count={sections.needs.length}
                  hint={needsHint(sections.needs)}
                />
                {sections.needs.map((hold) => (
                  <HoldCard
                    key={hold.row.key}
                    theme={theme}
                    entry={hold}
                    now={now}
                    selected={hold.row.key === selectedKey}
                    onSelect={() => selectHold(hold.row.key)}
                    onVerb={(id) => onCardVerb(hold, id)}
                  />
                ))}
              </View>
            ) : null}
            {sections.finished.length > 0 ? (
              <View style={{ gap: 12 }}>
                <SectionHeading
                  theme={theme}
                  title="Finished"
                  count={sections.finished.length}
                  hint="landed with nothing held on you"
                />
                {sections.finished.map((item) => (
                  <FinishedRow
                    key={item.id}
                    theme={theme}
                    item={item}
                    now={now}
                    selected={item.id === selectedWork}
                    canPrompt={canPrompt}
                    onSelect={() => selectWork(item.id)}
                    onVerb={(id) => (id === "open" ? selectWork(item.id) : void act("continue", { item }))}
                  />
                ))}
              </View>
            ) : null}
            {sections.health.length > 0 ? (
              <View style={{ gap: 12 }}>
                <SectionHeading
                  theme={theme}
                  title="Health"
                  count={sections.health.length}
                  hint="what you watch that went wrong"
                />
                {sections.health.map((row) => (
                  <HealthRowView
                    key={row.key}
                    theme={theme}
                    row={row}
                    now={now}
                    selected={row.item?.id === selectedWork}
                    onSelect={() => (row.item ? selectWork(row.item.id) : row.open && requestIntent(row.open))}
                    onVerb={() => (row.item ? selectWork(row.item.id) : row.open && requestIntent(row.open))}
                  />
                ))}
              </View>
            ) : null}
            {sections.running.length > 0 ? (
              <View style={{ gap: 12 }}>
                <SectionHeading theme={theme} title="Running" count={sections.running.length} />
                {sections.running.map((item) => (
                  <RunningRow
                    key={item.id}
                    theme={theme}
                    item={item}
                    now={now}
                    selected={item.id === selectedWork}
                    onSelect={() => selectWork(item.id)}
                  />
                ))}
              </View>
            ) : null}
            {sections.queued.length > 0 ? (
              <View style={{ gap: 12 }}>
                <SectionHeading
                  theme={theme}
                  title="Queued"
                  count={sections.queued.length}
                  hint={groupHint("queued", loop.data?.minutes != null)}
                />
                <QueuedList theme={theme} items={sections.queued} now={now} onSelect={selectWork} />
              </View>
            ) : null}
            {nothing && list.data && needs.data ? (
              <View style={{ alignItems: "center", gap: 8, paddingVertical: 40 }}>
                <Icon name="Inbox" size={22} color={kit.muted} />
                <Text style={{ color: kit.muted, fontSize: 14 }}>
                  {query.trim()
                    ? `No work matches “${query.trim()}”.`
                    : filter === "all" && !workspace
                      ? "Nothing needs you and nothing is running."
                      : "Nothing here."}
                </Text>
              </View>
            ) : null}
          </View>
          {wide && !showing ? <View style={{ width: 340 }}>{railNodes}</View> : null}
        </View>
        {wide || showing ? null : railNodes}
      </ScrollView>
      {/* From the right over the rail, below the tiles: the card you opened stays lit in the stream. */}
      <View style={[PASS_THROUGH, { position: "absolute", top: panelTop, left: 0, right: 0, bottom: 0 }]}>
        <InspectorPanel
          theme={theme}
          item={inspected}
          open={showing}
          onClose={() => setOpen(false)}
          onVerb={onInspectorVerb}
          onNext={holdKeys.length > 1 ? () => walk(1) : undefined}
          onOpenSession={() => void act("open", targetOf(entry))}
          width={panelWidth}
          scope={root}
        />
      </View>
      <UndoToast theme={theme} entry={undo.entry} onUndo={undo.undo} bottom={20} />
    </View>
  );
}
