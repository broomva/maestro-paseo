// The Maestro surface: all work, attention first, as a feed, a board or a
// list, or what happened as History, scoped to one initiative or to
// everything; or the Fleet, fleet-reconcile's hourly runs. Wide windows keep
// the feed and the selected item side by side; the board, the list, History
// and the Fleet take the width and open the item beside them. Compact windows
// show the feed, History or the Fleet and push the item over it, with a way
// back. A fleet tick that is missed or failing shows above every view but the
// Fleet, as the header count counts it; so does any other scheduled run that
// failed or was missed, above every view but the Timeline (client/timeline.tsx);
// so does an initiative past its date, above every view but Initiatives
// (client/initiatives.tsx), where an ask it waits on opens in Decisions; and so
// does a decision ask that waits on you, above every view but Decisions
// (client/decisions.tsx), the workspace's asks one at a time. The views come in
// two labelled groups, Work and System; a phone picks one from a single menu.

import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { ChangeScope } from "./changed";
import { type DecisionsFocus, DecisionsView } from "./decision-triage";
import { AskNotices, useDecisionCounts } from "./decisions";
import { ledgerOf } from "./decisions-model";
import { WorkDetail } from "./detail";
import { FleetNotices, FleetView } from "./fleet";
import { errorText, plural } from "./format";
import { needsYouCount } from "./header-count";
import { HistoryView } from "./history";
import { useAttention, useLoop, useWorkList } from "./hooks";
import { InitiativeNotices, InitiativesView } from "./initiatives";
import { useIntent } from "./intent";
import { LoopControl, LoopPanel } from "./loop";
import { NewWork } from "./new-work";
import { FilterRow, ScopeRow, ViewPicker, ViewSwitch } from "./plane-controls";
import {
  applyFilter,
  countFilters,
  decisionsBadge,
  emptyText,
  type Filter,
  initiatives,
  inScope,
  type PlaneView,
  resolveScope,
  SYSTEM_VIEWS,
  summaryText,
  viewFor,
  viewsFor,
  visibleFilters,
} from "./plane-model";
import { BoardView, FeedView, ListView } from "./plane-views";
import { ScoreboardCard } from "./scoreboard";
import { TimelineNotices, TimelineView } from "./timeline";
import { Button, Card, IconButton, Notice, space, useText } from "./ui";

export function MaestroSurface({ theme, layout, navigation }: PluginSurfaceProps) {
  const list = useWorkList();
  // The header's own count, Maestro-wide: the subtitle says the same number as the badge.
  const attention = useAttention();
  const needsYouTotal = attention.data
    ? needsYouCount(
        attention.data.waiting,
        attention.data.fleet,
        attention.data.timeline,
        attention.data.asks,
        attention.data.initiatives,
      )
    : null;
  // The same read as the loop control's (one query): whether the loop is on words the Queued hint.
  const loopOn = useLoop().data?.minutes != null;
  const text = useText(theme);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [chosenView, setView] = useState<PlaneView>("feed");
  const [filter, setFilter] = useState<Filter>("all");
  const [chosenScope, setScope] = useState<string | null>(null);
  const [loopOpen, setLoopOpen] = useState(false);
  const [fleetScope, setFleetScope] = useState<string | null>(null);
  const [fleetTick, setFleetTick] = useState<number | null>(null);
  const [decisionsFocus, setDecisionsFocus] = useState<DecisionsFocus | null>(null);
  const openFleet = (scope: string | null, tick: number | null = null) => {
    setFleetScope(scope);
    setFleetTick(tick);
    setView("fleet");
  };
  // Asks open in Decisions, at the ask named: the workspace's and every fleet scope's.
  const openDecisions = (ledger: string | null, ask: DecisionsFocus["ask"]) => {
    setDecisionsFocus({ ledger, ask, at: Date.now() });
    setView("decisions");
  };
  const decisionCounts = useDecisionCounts();
  useIntent((intent) => {
    if (intent.kind === "select") setSelected(intent.id);
    else if (intent.kind === "new") setCreating(true);
    else if (intent.kind === "fleet") openFleet(intent.scope);
    else if (intent.kind === "decisions")
      openDecisions(
        intent.ledger ?? null,
        intent.id ? { ledger: intent.ledger ?? null, id: intent.id, key: intent.key ?? null } : null,
      );
    else if (intent.kind === "timeline") setView("timeline");
    else if (intent.kind === "initiatives") setView("initiatives");
    else {
      // A filter opened from elsewhere means that group across all work, where its chips show.
      setFilter(intent.group);
      setScope(null);
      // The Board splits by state, History lists receipts, and the system views are not work: none applies the chips.
      setView((view) => (view === "board" || view === "history" || SYSTEM_VIEWS.includes(view) ? "feed" : view));
    }
  });
  const compact = layout.compact;
  const pad = compact ? space[4] : space[6];
  const view = viewFor(chosenView, compact);

  const items = list.data?.items ?? [];
  const current = selected && items.some((item) => item.id === selected) ? selected : null;
  const scopes = initiatives(items);
  const scope = resolveScope(items, chosenScope);
  const loaded = list.data !== undefined;
  // A scope whose initiative left the list is dropped, so it cannot come back unseen.
  useEffect(() => {
    if (loaded && chosenScope !== null && scope === null) setScope(null);
  }, [loaded, chosenScope, scope]);
  const scoped = inScope(items, scope);
  const counts = countFilters(scoped);
  const shown = view === "board" ? scoped : applyFilter(scoped, filter);
  const pick = { theme, selected: current, onSelect: setSelected };
  // The board has no state chips, so it clears the filter rather than hide one.
  const chooseView = (next: PlaneView) => {
    setView(next);
    if (next === "board") setFilter("all");
    // A tick opened from a timeline run is that visit's: the Fleet tab chosen later opens on none. So is an ask an initiative opened.
    setFleetTick(null);
    setDecisionsFocus(null);
  };

  const badges = { decisions: decisionsBadge(decisionCounts.open, decisionCounts.waiting) };

  const newWork = (
    <NewWork theme={theme} open={creating} onOpenChange={setCreating} onCreated={setSelected} compact={compact} />
  );

  if (compact && current) {
    return (
      <ChangeScope>
        <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
          <WorkDetail id={current} theme={theme} compact navigation={navigation} onBack={() => setSelected(null)} />
          {newWork}
        </View>
      </ChangeScope>
    );
  }

  const listPane = (
    // A tap on a button below a note field acts on the first tap, not only closes the keyboard.
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: pad, gap: space[5] }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ gap: space[2] }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space[3] }}>
          <View style={{ flex: 1, gap: space[1] }}>
            <Text style={text.heading} accessibilityRole="header">
              Maestro
            </Text>
            <Text style={text.muted}>{summaryText(items, needsYouTotal)}</Text>
          </View>
          <IconButton theme={theme} icon="RefreshCw" label="Refresh work" onPress={() => void list.refetch()} />
          <Button
            theme={theme}
            variant="primary"
            icon="Plus"
            label="New work"
            compact={compact}
            onPress={() => setCreating(true)}
          />
        </View>
        {/* Its own row, the pane's full width: beside the buttons a phone wraps "Next wake in 15 min". */}
        <LoopControl theme={theme} open={loopOpen} onToggle={() => setLoopOpen((open) => !open)} />
      </View>

      {loopOpen ? <LoopPanel theme={theme} onClose={() => setLoopOpen(false)} /> : null}

      {view === "fleet" ? null : <FleetNotices theme={theme} compact={compact} onOpen={openFleet} />}
      {view === "decisions" ? null : (
        <AskNotices
          theme={theme}
          compact={compact}
          onOpen={(notice) => openDecisions(null, { ledger: ledgerOf(notice), uid: notice.uid, id: notice.id })}
        />
      )}
      {view === "timeline" ? null : (
        <TimelineNotices theme={theme} compact={compact} onOpen={() => setView("timeline")} />
      )}
      {view === "initiatives" ? null : (
        <InitiativeNotices theme={theme} compact={compact} onOpen={() => chooseView("initiatives")} />
      )}

      {compact ? (
        <ViewPicker theme={theme} view={view} onView={chooseView} views={viewsFor(true)} badges={badges} />
      ) : (
        <ViewSwitch theme={theme} view={view} onView={chooseView} views={viewsFor(false)} badges={badges} />
      )}

      {view === "fleet" ? (
        <FleetView
          theme={theme}
          compact={compact}
          scope={fleetScope}
          tick={fleetTick}
          navigation={navigation}
          onScope={(scope) => openFleet(scope)}
          onSelect={setSelected}
        />
      ) : view === "decisions" ? (
        <DecisionsView theme={theme} compact={compact} navigation={navigation} focus={decisionsFocus} />
      ) : view === "initiatives" ? (
        <InitiativesView
          theme={theme}
          compact={compact}
          navigation={navigation}
          onOpenDecision={(ledger, id) => openDecisions(ledger, id ? { ledger, id } : null)}
          onOpenWork={setSelected}
        />
      ) : view === "timeline" ? (
        <TimelineView
          theme={theme}
          compact={compact}
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
          <ScoreboardCard theme={theme} board={list.data.scoreboard} onOpenHistory={() => chooseView("history")} />
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
                  compact={compact}
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
              ) : shown.length === 0 && view !== "board" ? (
                <Text style={text.muted}>{emptyText(filter)}</Text>
              ) : view === "board" ? (
                <BoardView {...pick} items={shown} loopOn={loopOn} />
              ) : view === "list" ? (
                <ListView {...pick} items={shown} loopOn={loopOn} />
              ) : (
                <FeedView {...pick} items={shown} loopOn={loopOn} />
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
          {listPane}
          {newWork}
        </View>
      </ChangeScope>
    );
  }

  // The board, the list, History and the system views want the width: the item opens beside them only when one is picked.
  const wide = view !== "feed";
  return (
    <ChangeScope>
      <View style={{ flex: 1, flexDirection: "row", backgroundColor: theme.colors.surface0 }}>
        <View
          style={
            wide
              ? { flex: 1 }
              : { width: 440, maxWidth: "45%", borderRightWidth: 1, borderRightColor: theme.colors.border }
          }
        >
          {listPane}
        </View>
        {wide ? (
          current ? (
            <View style={{ width: 440, maxWidth: "45%", borderLeftWidth: 1, borderLeftColor: theme.colors.border }}>
              <WorkDetail
                id={current}
                theme={theme}
                compact={false}
                navigation={navigation}
                onBack={() => setSelected(null)}
              />
            </View>
          ) : null
        ) : (
          <View style={{ flex: 1 }}>
            {current ? (
              <WorkDetail id={current} theme={theme} compact={false} navigation={navigation} />
            ) : (
              <View
                style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space[8], gap: space[2] }}
              >
                <Text style={text.title}>Pick a work item</Text>
                <Text style={[text.muted, { textAlign: "center", maxWidth: 360 }]}>
                  Its receipts, checks and the verb it needs from you show here.
                </Text>
              </View>
            )}
          </View>
        )}
        {newWork}
      </View>
    </ChangeScope>
  );
}
