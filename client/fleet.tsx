// The Fleet view, as a cockpit (BRO-2837, design draft A with draft B's
// inspector): fleet-reconcile's hourly runs per scope, status first. Top to
// bottom: the scope control with the fleet's mode and cadence; the health band
// (a verdict and one tick strip per scope); KPI tiles that filter the roster;
// Needs you (the fleet's asks, alerts and own decisions, and the dry run's
// proposals waiting on your verdict) beside the latest tick; and the sessions
// in scope, each opening an inspector. "All" reads every scope.
//
// Read-only toward the fleet: your verdicts go to the fleet's review file and
// your answers to its ask ledger, as before; nothing here runs a tick, pauses
// the fleet, or changes its mode or dry run (server/fleet.ts). The
// workspace's own decisions are not here: they are the Decisions tab (BRO-2838).
//
// FleetNotices is the same scope health where the rest of Maestro shows what
// needs you: a missed or failing tick the fleet has not raised as work of its own.

import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { type FleetView as FleetRead, getFleet } from "../shared/fleet";
import {
  askAge,
  askedSessions,
  cadenceText,
  featuredScope,
  filterRoster,
  fleetNeedsYou,
  headerShares,
  healthCells,
  linkSession,
  modeBadge,
  needsText,
  nextTickAt,
  oldestText,
  proposalsBySession,
  type RosterFilter,
  type RosterRow,
  reviewedGroups,
  rosterCounts,
  rosterRows,
  type ScopeRead,
  teachQueue,
  verdictOf,
} from "./fleet-cockpit-model";
import { HealthBand, KpiRow, type KpiValue } from "./fleet-health";
import { HEALTH_LABEL, healthTone, noticeText } from "./fleet-model";
import { NeedsYouQueue, type ScopeContext, TeachTheFleet } from "./fleet-queue";
import { Roster, RosterChips, SessionInspector } from "./fleet-roster";
import { LatestTick, POLL_MS, TickSheet, type TickSheetState } from "./fleet-ticks";
import { Pill, ramp, SectionHead, Segmented, Verb } from "./fleet-ui";
import { errorText, plural } from "./format";
import { useAttention } from "./hooks";
import { requestIntent } from "./intent";
import { Button, Card, Notice, radius, space, useReducedMotion, useText } from "./ui";

const TICKS = 24;
/** Below this width the two columns stack, and the inspector opens as a sheet. */
const WIDE = 900;
/** Rows the roster shows before "Show all". */
const ROSTER_SHOWN = 12;
/** The scope control's id for every scope at once. */
const ALL = "all";

type Navigation = PluginSurfaceProps["navigation"];

export function useFleet(scope: string | null) {
  const get = useRpc(getFleet);
  return useQuery({
    queryKey: ["maestro", "fleet", scope],
    queryFn: () => get(scope ? { scope, ticks: TICKS } : { ticks: TICKS }),
    refetchInterval: POLL_MS,
  });
}

/**
 * Every scope the cockpit shows, with its detail once read: the chosen one,
 * or under All each scope, the first from the base read and the rest read
 * each under its own key (the same reads a scope chosen alone makes).
 */
function useScopeReads(base: FleetRead | undefined, all: boolean, baseStale: string | null = null): ScopeRead[] {
  const get = useRpc(getFleet);
  const others =
    all && base ? base.scopes.filter((scope) => scope.id !== base.detail?.id).map((scope) => scope.id) : [];
  const reads = useQueries({
    queries: others.map((id) => ({
      queryKey: ["maestro", "fleet", id],
      queryFn: () => get({ scope: id, ticks: TICKS }),
      refetchInterval: POLL_MS,
    })),
  });
  if (!base) return [];
  const details = new Map(
    [base.detail, ...reads.map((read) => read.data?.detail ?? null)].flatMap((detail) =>
      detail ? [[detail.id, detail] as const] : [],
    ),
  );
  // A scope's own read that failed with no data is said ("Can't read"); one whose refetch failed while
  // older data stands is a quiet note; one still on its first read is "Reading…". Never a silent gap.
  const state = new Map(
    others.map((id, at) => {
      const read = reads[at];
      const has = read?.data?.detail?.id === id;
      return [
        id,
        {
          error: read?.isError && !has ? errorText(read.error) : null,
          stale: read?.isError && has ? errorText(read.error) : null,
          reading: !has && !read?.isError,
        },
      ] as const;
    }),
  );
  const scopes = all ? base.scopes : base.scopes.filter((scope) => scope.id === base.detail?.id);
  // A scope's own read is fresher for its summary too (a verdict updates the read that holds its detail).
  const summary = (id: string) =>
    reads
      .map((read) => read.data?.scopes.find((scope) => scope.id === id && read.data?.detail?.id === id))
      .find(Boolean);
  return scopes.map((scope) => {
    const own = state.get(scope.id);
    return {
      scope: summary(scope.id) ?? scope,
      detail: details.get(scope.id) ?? null,
      error: own?.error ?? null,
      reading: own?.reading ?? false,
      stale: own?.stale ?? (scope.id === base.detail?.id ? baseStale : null),
    };
  });
}

/** Brings a section into view where the platform can (the web's scrollIntoView); elsewhere, nothing. */
function bringIntoView(target: View | null, reduced: boolean): void {
  const node = target as unknown as { scrollIntoView?: (options: object) => void } | null;
  node?.scrollIntoView?.({ behavior: reduced ? "auto" : "smooth", block: "start" });
}

export function FleetView({
  theme,
  compact,
  scope,
  tick = null,
  navigation,
  onScope,
  onSelect,
}: {
  theme: PluginTheme;
  compact: boolean;
  /** The scope shown; null: every scope (All). */
  scope: string | null;
  /** A tick to open, when the view is opened on one (from a timeline run). */
  tick?: number | null;
  navigation: Navigation;
  onScope: (scope: string | null) => void;
  onSelect: (id: string) => void;
}) {
  const fleet = useFleet(scope);
  const text = useText(theme);
  const t = ramp(theme);
  const all = scope === null;
  const reads = useScopeReads(fleet.data, all, fleet.isError && fleet.data ? errorText(fleet.error) : null);
  const reduced = useReducedMotion();
  // The header's own read (work.attention): what "N need you" counts everywhere.
  const attention = useAttention();
  const queueRef = useRef<View>(null);
  const rosterRef = useRef<View>(null);
  const [width, setWidth] = useState(compact ? 390 : 1100);
  const [filter, setFilter] = useState<RosterFilter>("all");
  const [inspect, setInspect] = useState<string | null>(null);
  const [rosterAll, setRosterAll] = useState(false);
  const [sheet, setSheet] = useState<TickSheetState | null>(
    tick !== null && scope ? { scope, tick, first: "log" } : null,
  );
  const [sheetTick, setSheetTick] = useState<number | null>(null);
  const [opened, setOpened] = useState(tick);
  // Opened on another tick while mounted (a second timeline run): that one opens.
  if (tick !== opened) {
    setOpened(tick);
    setSheet(tick !== null && scope ? { scope, tick, first: "log" } : null);
  }

  if (fleet.isPending) return <ActivityIndicator color={theme.colors.foregroundMuted} />;
  // A refetch that failed while data stands is a quiet note below the band, never this.
  if (fleet.isError && !fleet.data) {
    return (
      <View style={{ gap: space[3] }}>
        <Notice theme={theme} tone="danger">
          {errorText(fleet.error)}
        </Notice>
        <Button theme={theme} label="Try again" onPress={() => void fleet.refetch()} />
      </View>
    );
  }
  const { scopes, error } = fleet.data;
  if (scopes.length === 0 || reads.length === 0) {
    return (
      <View style={{ gap: space[4] }}>
        {error ? (
          <Notice theme={theme} tone="warn">
            {error}
          </Notice>
        ) : null}
        <Card theme={theme}>
          <Text style={text.title}>No fleet on this Mac</Text>
          <Text style={text.muted}>
            fleet-reconcile has no scope here: its config (~/.config/ctx/fleet.json) names none, and no state dir holds
            a ledger or ticks. Its install.sh sets one up.
          </Text>
        </Card>
      </View>
    );
  }

  const phone = compact;
  const wide = !phone && width >= WIDE;
  const now = Date.now();
  const cells = new Map(
    reads.map((read) => [read.scope.id, healthCells(read.detail?.ticks ?? [], read.scope.health, TICKS, now)]),
  );
  const featured = featuredScope(reads);
  const badge = modeBadge(reads.map((read) => read.scope));
  const cadence = featured
    ? cadenceText(featured.detail?.schedule ?? null, featured.scope.lastTick?.at ?? null, now)
    : null;
  const cadenceLine = cadence && all && reads.length > 1 && featured ? `${featured.scope.id}: ${cadence}` : cadence;

  // One selector for the fleet's health: the band, the tile, the section and the header's fleet share agree.
  const needs = fleetNeedsYou(reads);
  const teach = teachQueue(reads, now);
  // The header's count, split into the fleet's share (here: its health) and each other surface's (BRO-2908).
  const shares = attention.data ? headerShares(attention.data) : null;
  const elsewhere = shares
    ? [
        { label: "Work", count: shares.work, intent: { kind: "filter", group: "review" } as const },
        { label: "Decisions", count: shares.decisions, intent: { kind: "decisions" } as const },
        { label: "Timeline", count: shares.timeline, intent: { kind: "timeline" } as const },
        { label: "Initiatives", count: shares.initiatives, intent: { kind: "initiatives" } as const },
      ].filter((entry) => entry.count > 0)
    : [];
  // One scope shown: the fleet's share in the other scopes, so the parts add up to the header's total.
  const otherScopes = shares ? Math.max(0, shares.fleet - needs.total) : 0;
  const reviewed = reviewedGroups(reads, now);
  const roster = rosterRows(reads);
  const asked = askedSessions(reads);
  const counts = rosterCounts(roster, asked);
  const proposals = proposalsBySession(reads);
  const shownRows = filterRoster(roster, filter, asked);
  const visibleRows = rosterAll ? shownRows : shownRows.slice(0, ROSTER_SHOWN);
  const noRoster = reads.every((read) => !read.detail?.roster);
  const runningScopes = new Set(filterRoster(roster, "running", asked).map((row) => row.scopeId)).size;
  const verdict = verdictOf(reads, cells, all, {
    needs: needs.total,
    // The band counts health only; what the fleet raised is counted where it lives (BRO-2908).
    needsText: needsText({ ticks: needs.ticks, asks: 0, alerts: 0, decisions: 0 }),
    sessions: needs.sessions,
    failed: counts.failed,
    blocked: counts.blocked,
  });
  const tiles: KpiValue[] = [
    // The fleet's own: the header's count is all of Maestro's, so the tile names what it counts.
    {
      id: "needs",
      label: "Health",
      value: needs.total,
      sub: needs.total > 0 ? `${plural(needs.total, "scope")} late or failing` : "every scope on time",
      tone: "warn",
    },
    {
      id: "attention",
      label: "Attention",
      value: counts.attention,
      sub:
        [counts.failed > 0 ? `${counts.failed} failed` : null, counts.blocked > 0 ? `${counts.blocked} blocked` : null]
          .filter(Boolean)
          .join(" · ") || (counts.attention > 0 ? "want a look" : "nothing wants a look"),
      tone: "danger",
    },
    {
      id: "running",
      label: "Running",
      value: counts.running,
      sub: noRoster ? "no report" : `in ${plural(runningScopes, "scope")}`,
      tone: "info",
    },
    {
      id: "idle",
      label: "Idle",
      value: counts.idle,
      sub: counts.idle > 0 ? oldestText(filterRoster(roster, "idle", asked), now) : null,
      tone: "muted",
    },
    {
      id: "failed",
      label: "Failed",
      value: counts.failed,
      sub: counts.failed > 0 ? oldestText(filterRoster(roster, "failed", asked), now) : null,
      tone: "danger",
    },
    { id: "unmanaged", label: "Unmanaged", value: counts.unmanaged, sub: "not adopted by the fleet", tone: "muted" },
    {
      id: "out",
      label: "Out of scope",
      value: counts.out,
      sub: counts.unplaced > 0 ? `${counts.unplaced} unplaced` : null,
      tone: "muted",
      quiet: true,
    },
  ];
  const chooseFilter = (next: RosterFilter) => {
    setFilter((current) => (current === next && next !== "all" ? "all" : next));
    setRosterAll(false);
  };
  // Needs you jumps to the queue; every other tile filters the roster and brings it into view.
  const pressTile = (id: KpiValue["id"]) => {
    if (id === "needs") {
      bringIntoView(queueRef.current, reduced);
      return;
    }
    chooseFilter(id);
    bringIntoView(rosterRef.current, reduced);
  };
  const readOf = (id: string) => reads.find((read) => read.scope.id === id);
  const linkable = [...roster.inScope, ...roster.out];
  const context: ScopeContext = {
    next: (id) => {
      const read = readOf(id);
      return nextTickAt(read?.detail?.schedule ?? null, read?.scope.lastTick?.at ?? null);
    },
    age: (id, ask) => askAge(ask, readOf(id)?.detail?.ticks ?? [], now),
    link: (ask) => linkSession(ask, linkable),
    dryRun: (id) => readOf(id)?.scope.dryRun ?? null,
    lastTick: (id) => readOf(id)?.scope.lastTick?.tick ?? null,
  };
  const inspected = inspect ? ([...roster.inScope, ...roster.out].find((row) => row.id === inspect) ?? null) : null;
  const reportTickOf = (row: RosterRow) =>
    reads.find((read) => read.scope.id === row.scopeId)?.detail?.roster?.tick ?? null;
  const detailOf = (id: string) => reads.find((read) => read.scope.id === id)?.detail ?? null;
  const sideBySide = wide && inspected !== null;

  const scopeControl =
    scopes.length > 1 ? (
      <Segmented
        theme={theme}
        label="Fleet scope"
        fill={phone}
        phone={phone}
        value={scope ?? ALL}
        onChange={(id) => {
          setInspect(null);
          onScope(id === ALL ? null : id);
        }}
        segments={[
          { id: ALL, label: phone ? "All" : "All scopes", accessibilityLabel: "All scopes" },
          ...scopes.map((entry) => ({
            id: entry.id,
            label: entry.health.status === "ok" ? entry.id : `${entry.id} · ${HEALTH_LABEL[entry.health.status]}`,
            tone: healthTone(entry.health.status),
            accessibilityLabel: [
              entry.id,
              HEALTH_LABEL[entry.health.status],
              entry.unreviewed > 0 ? `${plural(entry.unreviewed, "proposal")} to review` : null,
              entry.openAsks > 0 ? plural(entry.openAsks, "open ask") : null,
            ]
              .filter(Boolean)
              .join(", "),
          })),
        ]}
      />
    ) : (
      <Text style={t.cardTitle}>{scopes[0]?.id}</Text>
    );

  const latest = featured ? (
    <LatestTick
      theme={theme}
      scope={featured.scope.id}
      detail={featured.detail}
      others={reads.filter((read) => read !== featured).map((read) => ({ scope: read.scope.id, detail: read.detail }))}
      phone={phone}
      onOpen={(next) => {
        setSheetTick(null);
        setSheet(next);
      }}
    />
  ) : null;

  const queueView = (
    <View style={{ gap: space[3] }} ref={queueRef}>
      <SectionHead theme={theme} title="Health" count={needs.total} />
      <NeedsYouQueue
        theme={theme}
        cards={needs.cards}
        elsewhere={needs.elsewhere}
        also={needs.also}
        context={context}
        phone={phone}
        navigation={navigation}
        onSelect={onSelect}
        onOpenTick={(next) => {
          setSheetTick(null);
          setSheet(next);
        }}
      />
    </View>
  );

  // Below the sessions: what the fleet would do, uncounted, never the page's lead.
  const teachView = (
    <TeachTheFleet
      theme={theme}
      teach={teach}
      reviewed={reviewed}
      context={context}
      phone={phone}
      navigation={navigation}
    />
  );

  const warnings = reads.flatMap((read) =>
    (read.detail?.warnings ?? []).map((warning) => `${read.scope.id}: ${warning}`),
  );

  return (
    <View style={{ gap: phone ? space[4] : space[5] }} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {error ? (
        <Notice theme={theme} tone="warn">
          {error}
        </Notice>
      ) : null}

      {phone ? (
        scopeControl
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[3], flexWrap: "wrap" }}>
          {scopeControl}
          <View style={{ flex: 1 }} />
          {badge ? <Pill theme={theme} tone="muted" outline icon="FlaskConical" label={badge} /> : null}
          {cadenceLine ? <Text style={[t.meta, t.tabular, { fontSize: 13 }]}>{cadenceLine}</Text> : null}
        </View>
      )}

      <HealthBand
        theme={theme}
        phone={phone}
        wide={wide}
        verdict={verdict}
        strips={reads.map((read) => ({
          scope: read.scope.id,
          cells: cells.get(read.scope.id) ?? [],
          error: read.error ?? null,
        }))}
        badge={badge?.startsWith("Dry run") ? "Dry run" : badge}
        meta={[featured?.scope.lastTick ? `Tick ${featured.scope.lastTick.tick}` : null, cadence]
          .filter(Boolean)
          .join(" · ")}
        onOpenTick={(id, at) => {
          setSheetTick(null);
          setSheet({ scope: id, tick: at, first: "log" });
        }}
        relation={
          shares
            ? {
                here: needs.total,
                all: shares.total,
                elsewhere: [
                  ...(otherScopes > 0
                    ? [{ label: "other scopes", count: otherScopes, onPress: () => onScope(null) }]
                    : []),
                  ...elsewhere.map((entry) => ({
                    label: entry.label,
                    count: entry.count,
                    onPress: () => requestIntent(entry.intent),
                  })),
                ],
              }
            : null
        }
      />

      {reads
        .filter((read) => read.stale)
        .map((read) => (
          <View
            key={`stale-${read.scope.id}`}
            style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}
            accessibilityRole="text"
          >
            <Icon name="RefreshCwOff" size={13} color={theme.colors.foregroundMuted} />
            <Text style={[t.meta, { flex: 1 }]}>
              {`Couldn't refresh ${read.scope.id} (${read.stale}); showing the last read.`}
            </Text>
          </View>
        ))}

      {warnings.slice(0, 3).map((warning) => (
        <Notice key={warning} theme={theme} tone="warn">
          {warning}
        </Notice>
      ))}

      <KpiRow
        theme={theme}
        phone={phone}
        tiles={tiles}
        selected={filter === "all" ? null : filter}
        onPress={pressTile}
      />

      {wide ? (
        <View style={{ flexDirection: "row", gap: space[5], alignItems: "flex-start" }}>
          <View style={{ flex: 1.75, minWidth: 0 }}>{queueView}</View>
          <View style={{ flex: 1, minWidth: 260, gap: space[3], paddingTop: 30 + space[3] }}>{latest}</View>
        </View>
      ) : (
        <>
          {queueView}
          {latest}
        </>
      )}

      <View style={{ gap: space[3] }} ref={rosterRef}>
        <SectionHead
          theme={theme}
          title={filter === "out" ? "Sessions out of scope" : "Sessions in scope"}
          right={
            phone ? null : (
              <RosterChips theme={theme} counts={counts} value={filter} phone={phone} onChange={chooseFilter} />
            )
          }
        />
        {phone ? (
          <RosterChips theme={theme} counts={counts} value={filter} phone={phone} onChange={chooseFilter} />
        ) : null}
        {noRoster ? (
          <Text style={t.muted}>No report has been read yet: the roster comes from the newest tick's report.</Text>
        ) : (
          <View style={{ flexDirection: sideBySide ? "row" : "column", gap: space[4], alignItems: "flex-start" }}>
            <View style={{ flex: sideBySide ? 1 : undefined, alignSelf: "stretch", minWidth: 0, gap: space[2] }}>
              <Roster
                theme={theme}
                rows={visibleRows}
                proposals={proposals}
                layout={phone || width < 700 ? "stack" : sideBySide ? "list" : "table"}
                showScope={all && reads.length > 1}
                selected={inspect}
                navigation={navigation}
                onOpen={(row) => setInspect((current) => (current === row.id ? null : row.id))}
                onSelect={onSelect}
              />
              {shownRows.length > ROSTER_SHOWN ? (
                <View style={{ flexDirection: "row" }}>
                  <Verb
                    theme={theme}
                    weight="quiet"
                    icon={rosterAll ? "ChevronUp" : "ChevronDown"}
                    label={rosterAll ? "Show fewer" : `Show all ${shownRows.length}`}
                    phone={phone}
                    onPress={() => setRosterAll((open) => !open)}
                  />
                </View>
              ) : null}
            </View>
            {sideBySide && inspected ? (
              <View
                style={{
                  flex: 1.4,
                  minWidth: 0,
                  padding: space[5],
                  borderRadius: radius.card + 4,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.surface1,
                }}
              >
                <SessionInspector
                  theme={theme}
                  row={inspected}
                  proposal={proposals.get(inspected.id) ?? null}
                  reportTick={reportTickOf(inspected)}
                  dryRun={readOf(inspected.scopeId)?.scope.dryRun ?? null}
                  phone={false}
                  navigation={navigation}
                  onSelect={onSelect}
                  onClose={() => setInspect(null)}
                />
              </View>
            ) : null}
          </View>
        )}
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}>
          <Icon name={filter === "out" ? "Eye" : "EyeOff"} size={14} color={theme.colors.foregroundMuted} />
          <Text style={[t.meta, t.tabular]}>
            {filter === "out"
              ? `Showing ${plural(counts.out, "session")} out of scope.`
              : `${plural(counts.out, "session")} out of scope ${counts.out === 1 ? "is" : "are"} hidden${counts.unplaced > 0 ? ` (${counts.unplaced} unplaced)` : ""}.`}
          </Text>
          {counts.out > 0 ? (
            <Verb
              theme={theme}
              weight="quiet"
              label={filter === "out" ? "Back to sessions in scope" : "Show them"}
              phone={phone}
              onPress={() => chooseFilter(filter === "out" ? "all" : "out")}
            />
          ) : null}
        </View>
      </View>

      {teachView}

      <TickSheet
        theme={theme}
        compact={phone}
        sheet={sheet}
        detail={sheet ? detailOf(sheet.scope) : null}
        openTick={sheetTick}
        onOpenTick={setSheetTick}
        onClose={() => setSheet(null)}
      />

      {!sideBySide ? (
        <Modal
          title={inspected ? (inspected.name ?? inspected.short) : "Session"}
          icon={<Icon name="SquareTerminal" size={18} color={theme.colors.foreground} />}
          open={inspected !== null}
          onOpenChange={(open) => {
            if (!open) setInspect(null);
          }}
        >
          <Modal.Content>
            {inspected ? (
              <SessionInspector
                theme={theme}
                row={inspected}
                proposal={proposals.get(inspected.id) ?? null}
                reportTick={reportTickOf(inspected)}
                dryRun={readOf(inspected.scopeId)?.scope.dryRun ?? null}
                phone={phone}
                navigation={navigation}
                onSelect={(id) => {
                  setInspect(null);
                  onSelect(id);
                }}
              />
            ) : null}
          </Modal.Content>
        </Modal>
      ) : null}
    </View>
  );
}

/**
 * The fleet's missed or failing ticks where Maestro shows what needs you, from
 * work.attention: exactly what the header count counts beside the work.
 */
export function FleetNotices({
  theme,
  compact,
  onOpen,
}: {
  theme: PluginTheme;
  compact: boolean;
  onOpen: (scope: string) => void;
}) {
  // The one owner of the work.attention read (client/hooks.ts).
  const attention = useAttention();
  const notices = attention.data?.fleet ?? [];
  if (notices.length === 0) return null;
  return (
    <View style={{ gap: space[2] }}>
      {notices.map((notice) => (
        <Notice
          key={notice.scope}
          theme={theme}
          tone="danger"
          action={
            <Button
              theme={theme}
              icon="Activity"
              label="Open Fleet"
              compact={compact}
              accessibilityLabel={`Open Fleet, ${notice.scope}`}
              onPress={() => onOpen(notice.scope)}
            />
          }
        >
          {noticeText(notice)}
        </Notice>
      ))}
    </View>
  );
}
