// The Maestro surface. A wide window is the desktop: Maestro's header over the Feed home (J1), the board (J6), Health
// (J7), Initiatives (J8) or one of the older views (List, History, Fleet, Decisions, Timeline, Loops), with the
// selected item beside it. A compact window is the phone (client/phone/shell.tsx): four tabs, each a deck of what
// needs you and a sheet of the rest, with pages (Initiatives, Fleet, Timeline, Loops) rising over them. What needs
// you is needs.list (BRO-3001): the tab badges, the decks and the header read it, and nothing here counts on its own.
// This screen holds the state they share (the tab, the page, the workspace, the opened hold) and hears the intents
// other surfaces send (client/intent.ts), which it turns into a tab, a page or an opened hold.

import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { workKey } from "../shared/needs";
import { ChangeScope } from "./changed";
import { type DecisionsFocus, DecisionsView } from "./decision-triage";
import { AnswersNotices, AskNotices, useWorkspaceAsks } from "./decisions";
import { decisionAsks, ledgerOf } from "./decisions-model";
import { WorkDetail } from "./detail";
import { NeedsSection } from "./feed";
import { needsByInitiative, needsSection } from "./feed-model";
import { FleetNotices, FleetView } from "./fleet";
import { errorText, plural } from "./format";
import { holdTarget } from "./header-count";
import { HealthScreen } from "./health";
import { HistoryView } from "./history";
import { type HomeFocus, HomeScreen } from "./home";
import { HomeHeaderBar } from "./home-header";
import { HOME_TABS, type HomeTab, TAB_VIEWS, tabOfView } from "./home-model";
import { useLoop, useNeeds, useNeedsEvents, useWorkList } from "./hooks";
import { InitiativeNotices } from "./initiatives";
import { InitiativesBoard } from "./initiatives-board";
import { requestIntent, useIntent } from "./intent";
import { LoopPanel } from "./loop";
import { LoopsNotices, LoopsView } from "./loops";
import { NewWork } from "./new-work";
import { PendingVerbs } from "./pending-verbs";
import { PHONE_TABS, type PhonePage, type PhoneTab, pageOfIntent } from "./phone/model";
import { PhoneSurface } from "./phone/shell";
import { FilterRow, ScopeRow } from "./plane-controls";
import {
  applyFilter,
  countFilters,
  emptyText,
  type Filter,
  initiatives,
  inScope,
  type PlaneView,
  resolveScope,
  SYSTEM_VIEWS,
  VIEWS,
  visibleFilters,
} from "./plane-model";
import { ListView } from "./plane-views";
import { ScoreboardCard } from "./scoreboard";
import { ChipRow } from "./stage-parts";
import { TimelineNotices, TimelineView } from "./timeline";
import { Button, Card, Notice, space, useText } from "./ui";
import { WorkBoard } from "./work-board";

/** The views whose desktop screen is J2–J9 (BRO-3036): they carry their own watched things, so no notice band sits above them. */
const J_SCREENS: readonly PlaneView[] = ["decisions", "board", "health", "initiatives"];

/** The tab `params.tab` names (BRO-3033 fact 2), the Feed when it names none. */
function phoneTabParam(value: string | undefined): PhoneTab {
  return PHONE_TABS.find((tab) => tab.id === value)?.id ?? "feed";
}

export function MaestroSurface({ theme, layout, navigation, params }: PluginScreenProps) {
  const list = useWorkList();
  // What needs you (needs.list): the subtitle, the tabs and Needs you say the header's number, read once.
  const needs = useNeeds();
  // A session that changes refetches both, as a verb does when it settles.
  useNeedsEvents();
  // The same read as the loop control's (one query): whether the loop is on words the Queued hint.
  const loopOn = useLoop().data?.minutes != null;
  const text = useText(theme);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [chosenView, setChosenView] = useState<PlaneView>("feed");
  // The phone's tab (M1, M6, M7) and the page over it (M8, M11, and the views Health's sheet reaches).
  const [phoneTab, setPhoneTab] = useState<PhoneTab>(() => phoneTabParam(params?.tab));
  const [phonePage, setPhonePage] = useState<PhonePage | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [chosenScope, setScope] = useState<string | null>(null);
  const [loopOpen, setLoopOpen] = useState(false);
  const [fleetScope, setFleetScope] = useState<string | null>(null);
  const [fleetTick, setFleetTick] = useState<number | null>(null);
  const [decisionsFocus, setDecisionsFocus] = useState<DecisionsFocus | null>(null);
  const [query, setQuery] = useState("");
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [homeFocus, setHomeFocus] = useState<HomeFocus | null>(null);
  const lastView = useRef<Partial<Record<HomeTab, PlaneView>>>({});
  const asksRead = useWorkspaceAsks();
  const asks = asksRead.data ? decisionAsks(asksRead.data) : [];
  /** Shows a view on the desktop; the phone has tabs and pages instead (client/phone/shell.tsx). */
  const setView = setChosenView;
  const openFleet = (scope: string | null, tick: number | null = null) => {
    setFleetScope(scope);
    setFleetTick(tick);
    setView("fleet");
  };
  // Asks open in Decisions, at the ask named: the workspace's and every fleet scope's.
  const openDecisions = (ledger: string | null, ask: DecisionsFocus["ask"]) => {
    setDecisionsFocus({ ledger, ask, at: Date.now() });
    setView("decisions");
    // The phone's Decisions deck opens on the ask when needs.list holds it (its hold key is `ask:` and the ask's key).
    if (layout.compact) {
      setPhoneTab("decisions");
      setPhonePage(null);
      if (ask?.key) setHomeFocus({ hold: `ask:${ask.key}`, at: Date.now() });
    }
  };
  // Opening on `params.hold` (a push, the header count): that hold's inspector on the Feed (BRO-3033 fact 2).
  const holdParam = params?.hold;
  useEffect(() => {
    if (!holdParam) return;
    setView("feed");
    // The phone opens its Feed deck on the hold and says so (M10); every hold is in it.
    setPhoneTab("feed");
    setPhonePage(null);
    setHomeFocus({ hold: holdParam, at: Date.now(), from: "push" });
  }, [holdParam]);
  useIntent((intent) => {
    if (intent.kind === "select") {
      // On the desktop the Feed home opens it: a hold in its inspector, other work in its own detail.
      if (!layout.compact) {
        setView("feed");
        setHomeFocus({ work: intent.id, at: Date.now() });
      } else {
        // The phone's Feed deck opens a hold, its card opens other work, and work with neither opens its page.
        setPhoneTab("feed");
        setPhonePage(null);
        setHomeFocus({ work: intent.id, at: Date.now() });
      }
    } else if (intent.kind === "new") setCreating(true);
    else if (layout.compact && pageOfIntent(intent)) setPhonePage(pageOfIntent(intent));
    else if (intent.kind === "fleet") openFleet(intent.scope);
    else if (intent.kind === "decisions")
      openDecisions(
        intent.ledger ?? null,
        intent.id ? { ledger: intent.ledger ?? null, id: intent.id, key: intent.key ?? null } : null,
      );
    else if (intent.kind === "timeline") setView("timeline");
    else if (intent.kind === "loops") setView("loops");
    else if (intent.kind === "initiatives") setView("initiatives");
    else {
      // A filter opened from elsewhere means that group across all work, where its chips show.
      setFilter(intent.group);
      setScope(null);
      // Its chips are the List's: the Work tab opens there, not on the Board, which would clear the filter.
      lastView.current.work = "list";
      // The Board splits by state, History lists receipts, and the system views are not work: none applies the chips.
      setChosenView((view) => (view === "board" || view === "history" || SYSTEM_VIEWS.includes(view) ? "feed" : view));
      // The phone's Needs you is its Feed deck.
      if (layout.compact) {
        setPhoneTab("feed");
        setPhonePage(null);
      }
    }
  });
  const compact = layout.compact;
  const view = chosenView;
  const bands = !J_SCREENS.includes(view);
  const tab = tabOfView(view);

  const items = list.data?.items ?? [];
  const current = selected && items.some((item) => item.id === selected) ? selected : null;
  // Every hold needs.list holds, joined to the work and asks this client has: each initiative's count is its own.
  const needsRows = needs.data?.rows ?? [];
  const scopes = initiatives(items, needsByInitiative(needsSection(needsRows, items, asks)));
  const scope = resolveScope(items, chosenScope);
  const loaded = list.data !== undefined;
  // A scope whose initiative left the list is dropped, so it cannot come back unseen.
  useEffect(() => {
    if (loaded && chosenScope !== null && scope === null) setScope(null);
  }, [loaded, chosenScope, scope]);
  const scoped = inScope(items, scope);
  // The Needs you chip counts and lists needs.list's holds in scope, asks included: the header's number, unscoped.
  const scopedNeeds = needsSection(needsRows, items, asks, scope);
  const counts = { ...countFilters(scoped), review: scopedNeeds.length };
  const shown = view === "board" ? scoped : applyFilter(scoped, filter);
  const pick = { theme, selected: current, onSelect: setSelected };
  // The board has no state chips, so it clears the filter rather than hide one.
  const chooseView = (next: PlaneView) => {
    setView(next);
    lastView.current[tabOfView(next)] = next;
    if (next === "board") setFilter("all");
    // A tick opened from a timeline run is that visit's: the Fleet tab chosen later opens on none. So is an ask an initiative opened.
    setFleetTick(null);
    setDecisionsFocus(null);
  };

  // The desktop's New work is Paseo's modal; the phone's grows from the + in its own surface (M9).
  const newWork = compact ? null : (
    <NewWork theme={theme} open={creating} onOpenChange={setCreating} onCreated={setSelected} compact={false} />
  );

  if (compact && current) {
    return (
      <ChangeScope>
        <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
          <WorkDetail
            id={current}
            theme={theme}
            compact
            navigation={navigation}
            onBack={() => setSelected(null)}
            open={requestIntent}
          />
          {newWork}
        </View>
      </ChangeScope>
    );
  }

  const listPane = (
    // A tap on a button below a note field acts on the first tap, not only closes the keyboard.
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{
        padding: space[6],
        gap: space[5],
        // The Feed is a home page: a readable column, centred when it has the window to itself.
        ...(view === "feed" ? { width: "100%", maxWidth: 760, alignSelf: "center" as const } : null),
      }}
      keyboardShouldPersistTaps="handled"
    >
      {loopOpen ? <LoopPanel theme={theme} onClose={() => setLoopOpen(false)} /> : null}

      {/* What you decided that has not taken effect: every verb of yours waits 8 s, with one Undo (B4). A work's
          own decision at the gate counts down in its detail. */}
      <PendingVerbs
        theme={theme}
        compact={false}
        skip={["work.verdict"]}
        except={current ? [workKey(current)] : undefined}
      />

      {/* What needs you could not be read: said, never shown as nothing. */}
      {needs.isError && !needs.data ? (
        <Notice theme={theme} tone="danger">
          {`What needs you could not be read (${errorText(needs.error)}); the count and Needs you come back when it reads.`}
        </Notice>
      ) : null}

      {/* The desktop's J screens say what they watch themselves (J5's tiles, Health's notices): no band above them. */}
      {bands ? (
        <>
          {view === "fleet" ? null : <FleetNotices theme={theme} compact={false} onOpen={openFleet} />}
          <AnswersNotices theme={theme} compact={false} />
          {/* On the Feed, Decide below says the same, inline. */}
          {view === "decisions" || view === "feed" ? null : (
            <AskNotices theme={theme} compact={false} onOpen={(row) => requestIntent(holdTarget(row))} />
          )}
          {view === "loops" ? null : <LoopsNotices theme={theme} compact={false} onOpen={() => setView("loops")} />}
          {view === "timeline" ? null : (
            <TimelineNotices theme={theme} compact={false} onOpen={() => setView("timeline")} />
          )}
          {view === "initiatives" ? null : (
            <InitiativeNotices theme={theme} compact={false} onOpen={() => chooseView("initiatives")} />
          )}
        </>
      ) : null}

      {TAB_VIEWS[tab].length > 1 ? (
        <ChipRow
          theme={theme}
          label={`${HOME_TABS.find((entry) => entry.id === tab)?.label ?? "Maestro"} views`}
          variant="segment"
          options={VIEWS.filter((option) => TAB_VIEWS[tab].includes(option.id))}
          value={view}
          onChange={chooseView}
        />
      ) : null}

      {view === "fleet" ? (
        <FleetView
          theme={theme}
          compact={false}
          scope={fleetScope}
          tick={fleetTick}
          navigation={navigation}
          onScope={(scope) => openFleet(scope)}
          onSelect={setSelected}
        />
      ) : view === "decisions" ? (
        <DecisionsView
          theme={theme}
          compact={false}
          navigation={navigation}
          focus={decisionsFocus}
          workspace={workspace}
        />
      ) : view === "loops" ? (
        <LoopsView theme={theme} />
      ) : view === "timeline" ? (
        <TimelineView
          theme={theme}
          compact={false}
          navigation={navigation}
          onOpenFleet={openFleet}
          onOpenLoop={() => setLoopOpen(true)}
        />
      ) : list.isPending ? (
        <ActivityIndicator color={theme.colors.foregroundMuted} />
      ) : list.isError ? (
        <View style={{ gap: space[3] }}>
          <Notice theme={theme} tone="danger">
            {errorText(list.error)}
          </Notice>
          <Button theme={theme} label="Try again" onPress={() => void list.refetch()} />
        </View>
      ) : (
        <>
          {view === "feed" ? null : (
            <ScoreboardCard theme={theme} board={list.data.scoreboard} onOpenHistory={() => chooseView("history")} />
          )}
          {list.data.warnings.slice(0, 3).map((warning) => (
            <Notice key={warning} theme={theme} tone="warn">
              {warning}
            </Notice>
          ))}
          {list.data.warnings.length > 3 ? (
            <Text style={text.small}>{plural(list.data.warnings.length - 3, "more file")} could not be read.</Text>
          ) : null}
          {items.length === 0 ? (
            <Card theme={theme}>
              <Text style={text.title}>No work yet</Text>
              <Text style={text.muted}>
                Work lives as folders in {list.data.root}. Write one down and dispatch it: an agent runs it in its own
                worktree and brings it back to you.
              </Text>
              <View style={{ flexDirection: "row" }}>
                <Button
                  theme={theme}
                  variant="primary"
                  icon="Plus"
                  label="New work"
                  compact={false}
                  onPress={() => setCreating(true)}
                />
              </View>
            </Card>
          ) : (
            <>
              {scopes.length > 0 ? (
                <ScopeRow theme={theme} initiatives={scopes} scope={scope} onScope={setScope} />
              ) : null}
              {view === "board" || view === "history" ? null : (
                <FilterRow
                  theme={theme}
                  filters={visibleFilters(counts, filter)}
                  counts={counts}
                  filter={filter}
                  onFilter={setFilter}
                />
              )}
              {view === "history" ? (
                <HistoryView {...pick} scope={scope} />
              ) : filter === "review" && view !== "board" ? (
                scopedNeeds.length === 0 ? (
                  <Text style={text.muted}>{emptyText(filter)}</Text>
                ) : (
                  <NeedsSection
                    {...pick}
                    entries={scopedNeeds}
                    onOpenAsk={(ask) =>
                      openDecisions(ledgerOf(ask), { ledger: ledgerOf(ask), uid: ask.uid, id: ask.id })
                    }
                    onOpenHold={(row) => requestIntent(holdTarget(row))}
                  />
                )
              ) : shown.length === 0 && view !== "board" ? (
                <Text style={text.muted}>{emptyText(filter)}</Text>
              ) : (
                <ListView {...pick} items={shown} loopOn={loopOn} />
              )}
            </>
          )}
        </>
      )}
    </ScrollView>
  );

  if (compact) {
    return (
      <ChangeScope>
        <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
          <PhoneSurface
            theme={theme}
            layout={layout}
            navigation={navigation}
            tab={phoneTab}
            onTab={setPhoneTab}
            workspace={workspace}
            onWorkspace={setWorkspace}
            focus={homeFocus}
            onFocusHandled={() => setHomeFocus(null)}
            onNew={() => setCreating(true)}
            onOpenWork={setSelected}
            page={phonePage}
            onPage={setPhonePage}
            onOpenDecision={(ledger, id) => openDecisions(ledger, id ? { ledger, id } : null)}
          />
        </View>
      </ChangeScope>
    );
  }

  // The desktop: Maestro's own header over the Feed home (J1) or, for any other tab, its view with the item
  // that is picked beside it. The Feed home opens holds in its inspector, so it has no detail pane of its own.
  return (
    <ChangeScope>
      <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
        <View style={{ paddingHorizontal: 20, paddingTop: 16, zIndex: 30, gap: 12 }}>
          <HomeHeaderBar
            theme={theme}
            tab={tab}
            onTab={(next) => chooseView(lastView.current[next] ?? TAB_VIEWS[next][0])}
            workspace={workspace}
            onWorkspace={setWorkspace}
            query={query}
            onQuery={setQuery}
            wakeOpen={loopOpen}
            onWake={() => setLoopOpen((open) => !open)}
            onNew={() => setCreating(true)}
          />
          {loopOpen ? <LoopPanel theme={theme} onClose={() => setLoopOpen(false)} /> : null}
          {/* The toast holds one verb; the ledger holds every one still inside its 8 s (B4), so each keeps its Undo. */}
          {view === "health" || view === "initiatives" || view === "board" ? (
            <PendingVerbs theme={theme} compact={false} />
          ) : null}
        </View>
        {view === "feed" ? (
          <HomeScreen
            theme={theme}
            navigation={navigation}
            workspace={workspace}
            query={query}
            focus={homeFocus}
            onFocusHandled={() => setHomeFocus(null)}
            onOpenWork={(id) => {
              chooseView("list");
              setSelected(id);
            }}
          />
        ) : view === "health" ? (
          // J7: Health as one sentence, four tiles, the notices with what closes each, and the sessions.
          <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 12 }} keyboardShouldPersistTaps="handled">
            <HealthScreen
              theme={theme}
              navigation={navigation}
              view={view}
              views={VIEWS.filter((option) => TAB_VIEWS[tab].includes(option.id))}
              onView={(next) => chooseView(next as PlaneView)}
              onOpenWork={(id) => {
                chooseView("list");
                setSelected(id);
              }}
            />
          </ScrollView>
        ) : view === "initiatives" ? (
          // J8: lateness first, four tiles, and a due review answered in the inspector (B2).
          <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 12 }} keyboardShouldPersistTaps="handled">
            <InitiativesBoard
              theme={theme}
              navigation={navigation}
              onOpenDecision={(ledger, id) => openDecisions(ledger, id ? { ledger, id } : null)}
              onOpenWork={(id) => {
                chooseView("list");
                setSelected(id);
              }}
            />
          </ScrollView>
        ) : view === "board" ? (
          // J6: Work as five trays, its own filters and its own inspector; the other Work views keep their pane.
          <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 12 }} keyboardShouldPersistTaps="handled">
            <WorkBoard
              theme={theme}
              navigation={navigation}
              workspace={workspace}
              query={query}
              view={view}
              views={VIEWS.filter((option) => TAB_VIEWS[tab].includes(option.id))}
              onView={(next) => chooseView(next as PlaneView)}
              onOpenWork={(id) => {
                chooseView("list");
                setSelected(id);
              }}
            />
          </ScrollView>
        ) : (
          <View style={{ flex: 1, flexDirection: "row" }}>
            <View style={{ flex: 1 }}>{listPane}</View>
            {current ? (
              <View style={{ width: 440, maxWidth: "45%", borderLeftWidth: 1, borderLeftColor: theme.colors.border }}>
                <WorkDetail
                  id={current}
                  theme={theme}
                  compact={false}
                  navigation={navigation}
                  onBack={() => setSelected(null)}
                  open={requestIntent}
                />
              </View>
            ) : null}
          </View>
        )}
        {newWork}
      </View>
    </ChangeScope>
  );
}
