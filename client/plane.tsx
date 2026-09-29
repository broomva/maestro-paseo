// The Maestro surface: all work, attention first, as a feed, a board or a
// list, scoped to one initiative or to everything. Wide windows keep the feed
// and the selected item side by side; the board and the list take the width
// and open the item beside them. Compact windows show the feed and push the
// item over it, with a way back.

import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import type { Scoreboard } from "../shared/contracts";
import { ChangeScope } from "./changed";
import { WorkDetail } from "./detail";
import { duration, errorText, plural } from "./format";
import { useWorkList } from "./hooks";
import { useIntent } from "./intent";
import { NewWork } from "./new-work";
import { FilterRow, ScopeRow, ViewSwitch } from "./plane-controls";
import {
  applyFilter,
  countFilters,
  emptyText,
  type Filter,
  initiatives,
  inScope,
  type PlaneView,
  resolveScope,
  summaryText,
  viewFor,
  visibleFilters,
} from "./plane-model";
import { BoardView, FeedView, ListView } from "./plane-views";
import { Button, Card, IconButton, Notice, space, useText } from "./ui";

export function MaestroSurface({ theme, layout, navigation }: PluginSurfaceProps) {
  const list = useWorkList();
  const text = useText(theme);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [chosenView, setView] = useState<PlaneView>("feed");
  const [filter, setFilter] = useState<Filter>("all");
  const [chosenScope, setScope] = useState<string | null>(null);
  useIntent((intent) => {
    if (intent.kind === "select") setSelected(intent.id);
    else if (intent.kind === "new") setCreating(true);
    else {
      // A filter opened from elsewhere means that group across all work, where its chips show.
      setFilter(intent.group);
      setScope(null);
      setView((view) => (view === "board" ? "feed" : view));
    }
  });
  const compact = layout.compact;
  const pad = compact ? space[4] : space[6];
  const view = viewFor(chosenView, compact);

  const items = list.data?.items ?? [];
  const current = selected && items.some((item) => item.id === selected) ? selected : null;
  const scopes = initiatives(items);
  const scope = resolveScope(items, chosenScope);
  const scoped = inScope(items, scope);
  const counts = countFilters(scoped);
  const shown = view === "board" ? scoped : applyFilter(scoped, filter);
  const pick = { theme, selected: current, onSelect: setSelected };

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
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: pad, gap: space[5] }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space[3] }}>
        <View style={{ flex: 1, gap: space[1] }}>
          <Text style={text.heading} accessibilityRole="header">
            Maestro
          </Text>
          <Text style={text.muted}>{summaryText(items)}</Text>
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

      {compact ? null : <ViewSwitch theme={theme} view={view} onView={setView} />}

      {list.isPending ? (
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
          <ScoreboardCard theme={theme} board={list.data.scoreboard} />
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
              {view === "board" ? null : (
                <FilterRow
                  theme={theme}
                  filters={visibleFilters(counts, filter)}
                  counts={counts}
                  filter={filter}
                  onFilter={setFilter}
                />
              )}
              {shown.length === 0 && view !== "board" ? (
                <Text style={text.muted}>{emptyText(filter)}</Text>
              ) : view === "board" ? (
                <BoardView {...pick} items={shown} />
              ) : view === "list" ? (
                <ListView {...pick} items={shown} />
              ) : (
                <FeedView {...pick} items={shown} />
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

  // The board and the list want the width: the item opens beside them only when one is picked.
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

function ScoreboardCard({ theme, board }: { theme: PluginTheme; board: Scoreboard }) {
  const text = useText(theme);
  const runs = board.segments.length;
  const label = `Unsupervised ${duration(board.unsupervisedMs)} today, ${plural(runs, "stretch", "stretches")}, ${plural(board.looks, "look")}`;
  return (
    <Card theme={theme}>
      <Text style={text.label}>Unsupervised today</Text>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: space[3], flexWrap: "wrap" }}>
        <Text style={[text.heading, text.tabular]}>{duration(board.unsupervisedMs)}</Text>
        <Text style={[text.muted, text.tabular]}>
          {plural(board.looks, "look")} · longest run {duration(board.longestRunMs)}
        </Text>
      </View>
      <View accessible accessibilityLabel={label} style={{ height: 16, justifyContent: "center" }}>
        <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.border, overflow: "hidden" }}>
          {board.segments.map((segment) => (
            <View
              key={`${segment.start}`}
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: `${segment.start * 100}%`,
                width: `${Math.max(segment.width * 100, 0.6)}%`,
                backgroundColor: theme.colors.accent,
                opacity: segment.live ? 1 : 0.7,
              }}
            />
          ))}
        </View>
        {[...new Set(board.notches)].map((notch) => (
          <View
            key={notch}
            style={{
              position: "absolute",
              left: `${notch * 100}%`,
              top: 1,
              width: 2,
              height: 14,
              borderRadius: 1,
              backgroundColor: theme.colors.foreground,
            }}
          />
        ))}
      </View>
      <Text style={text.small}>Bars are runs on their own. Each mark is a time you stepped in.</Text>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        {["00:00", "06:00", "12:00", "18:00", "24:00"].map((mark) => (
          <Text key={mark} style={[text.small, text.tabular]}>
            {mark}
          </Text>
        ))}
      </View>
    </Card>
  );
}
