// The Timeline view: every scheduled thing on one axis, the past day to the
// left of now and the next day to its right. Each source is a row: its name
// and status, how often it runs, a track with its runs (colored by how they
// ended, a missed one hollow) and the runs still to come, and its last and
// next run in words. Pressing a row opens its recent runs, why it has the
// status it has, its log's end, and a way to the fleet scope, the loop or the
// run's session. Nothing here starts or changes a schedule.
//
// TimelineNotices is the same where the rest of Maestro shows what needs you:
// a failed or missed run that is not a fleet scope's (FleetNotices has those).

import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { attentionWork } from "../shared/contracts";
import { getTimeline, getTimelineLog, TIMELINE_RUNS, type TimelineSource } from "../shared/timeline";
import { errorText } from "./format";
import { keyedLines } from "./loop-model";
import {
  type Axis,
  axisOf,
  axisTicks,
  kindLabel,
  labelOffset,
  lastWords,
  type MarkTone,
  marksOf,
  nextWords,
  noticeText,
  place,
  rowLabel,
  runLine,
  runsShown,
  sinceWords,
  sortSources,
  statusLabel,
  summaryLine,
  TIMELINE_POLL_MS,
  toneOf,
} from "./timeline-model";
import { Button, Card, IconButton, Notice, radius, size, space, useText } from "./ui";

export function useTimeline() {
  const get = useRpc(getTimeline);
  return useQuery({ queryKey: ["maestro", "timeline"], queryFn: () => get({}), refetchInterval: TIMELINE_POLL_MS });
}

/** A launchd job's log end, read when its row opens, and with the view's poll while it stays open. */
function useTimelineLog(id: string, enabled: boolean) {
  const read = useRpc(getTimelineLog);
  return useQuery({
    queryKey: ["maestro", "timeline", "log", id],
    queryFn: () => read({ id }),
    enabled,
    refetchInterval: TIMELINE_POLL_MS,
  });
}

function ink(theme: PluginTheme, tone: MarkTone): string {
  switch (tone) {
    case "danger":
      return theme.colors.statusDanger;
    case "warn":
      return theme.colors.statusWarning;
    case "success":
      return theme.colors.statusSuccess;
    case "accent":
      return theme.colors.accent;
    default:
      return theme.colors.foregroundMuted;
  }
}

/** A dot with its word beside it: color never stands alone. */
function Status({
  theme,
  tone,
  label,
  hollow = false,
}: {
  theme: PluginTheme;
  tone: MarkTone;
  label: string;
  hollow?: boolean;
}) {
  const color = ink(theme, tone);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[1] }}>
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 8,
          backgroundColor: hollow ? "transparent" : color,
          borderWidth: hollow ? 1.5 : 0,
          borderColor: color,
        }}
      />
      <Text style={{ color, fontSize: size.xs, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

const TRACK = 20;

/** One source's runs along the axis, with now drawn through it. Hidden from screen readers: the row's words say it. */
function Track({ theme, source, axis }: { theme: PluginTheme; source: TimelineSource; axis: Axis }) {
  const marks = marksOf(source, axis);
  const now = place(axis, axis.now);
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      aria-hidden
      style={{ height: TRACK, position: "relative", overflow: "hidden" }}
    >
      <View
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: TRACK / 2 - 1,
          height: 2,
          borderRadius: 1,
          backgroundColor: theme.colors.border,
        }}
      />
      {marks.map((mark) => {
        if (mark.future) {
          const dim = mark.next ? 9 : 5;
          return (
            <View
              key={mark.key}
              style={{
                position: "absolute",
                left: `${mark.left * 100}%`,
                top: TRACK / 2 - dim / 2,
                marginLeft: -dim / 2,
                width: dim,
                height: dim,
                borderRadius: dim,
                borderWidth: mark.next ? 2 : 1,
                borderColor: mark.next ? theme.colors.accent : theme.colors.foregroundMuted,
                backgroundColor: theme.colors.surface1,
                opacity: mark.next ? 1 : 0.7,
              }}
            />
          );
        }
        const loud = mark.tone === "danger" || mark.tone === "warn";
        const missed = mark.tone === "warn";
        const height = loud ? 16 : 10;
        return (
          <View
            key={mark.key}
            style={{
              position: "absolute",
              left: `${mark.left * 100}%`,
              width: `${mark.width * 100}%`,
              minWidth: loud ? 5 : 3,
              marginLeft: loud ? -2.5 : -1.5,
              top: TRACK / 2 - height / 2,
              height,
              borderRadius: 2,
              backgroundColor: missed ? theme.colors.surface1 : ink(theme, mark.tone),
              borderWidth: missed ? 2 : 0,
              borderColor: ink(theme, mark.tone),
            }}
          />
        );
      })}
      <View
        style={{
          position: "absolute",
          left: `${now * 100}%`,
          marginLeft: -1,
          top: 0,
          bottom: 0,
          width: 2,
          backgroundColor: theme.colors.foreground,
        }}
      />
    </View>
  );
}

/** The axis's labels above the tracks: the local hours, and now. */
function AxisLabels({ theme, axis, compact }: { theme: PluginTheme; axis: Axis; compact: boolean }) {
  const text = useText(theme);
  const ticks = axisTicks(axis, compact ? 12 : 6);
  const width = 56;
  const label = (left: number, words: string, strong = false, key = words) => (
    <Text
      key={key}
      style={[
        text.small,
        text.tabular,
        {
          position: "absolute",
          left: `${left * 100}%`,
          width,
          // Held inside the row at either end, not hung half off it.
          marginLeft: labelOffset(left, width),
          textAlign: left < 0.05 ? "left" : left > 0.95 ? "right" : "center",
          color: strong ? theme.colors.foreground : theme.colors.foregroundMuted,
          fontWeight: strong ? "600" : "400",
        },
      ]}
    >
      {words}
    </Text>
  );
  return (
    <View accessible={false} aria-hidden style={{ height: 16, position: "relative" }}>
      {ticks.map((tick) => label(tick.left, tick.label, false, tick.key))}
      {label(place(axis, axis.now), "now", true)}
    </View>
  );
}

function Legend({ theme }: { theme: PluginTheme }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: space[3], rowGap: space[1] }}>
      <Status theme={theme} tone={toneOf("ok")} label="Passed" />
      <Status theme={theme} tone={toneOf("failed")} label="Failed" />
      <Status theme={theme} tone={toneOf("missed")} label="Missed" hollow />
      <Status theme={theme} tone={toneOf("unknown")} label="Exit not recorded" />
      <Status theme={theme} tone="accent" label="To come" hollow />
    </View>
  );
}

function SourceRow({
  theme,
  source,
  axis,
  open,
  onToggle,
  compact,
  canOpenAgent,
  onLink,
}: {
  theme: PluginTheme;
  source: TimelineSource;
  axis: Axis;
  open: boolean;
  onToggle: () => void;
  compact: boolean;
  canOpenAgent: boolean;
  onLink: (source: TimelineSource) => void;
}) {
  const text = useText(theme);
  const now = axis.now;
  const since = sinceWords(source, now);
  const next = nextWords(source, now);
  const tone = toneOf(source.status);
  return (
    <View style={{ gap: space[2], paddingTop: space[3], borderTopWidth: 1, borderTopColor: theme.colors.border }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        accessibilityLabel={rowLabel(source, now)}
        onPress={onToggle}
        style={({ pressed }) => ({ gap: space[2], opacity: pressed ? 0.85 : 1 })}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
          <Text style={[text.body, { flex: 1, fontWeight: "600" }]} numberOfLines={1}>
            {source.name}
          </Text>
          <Status theme={theme} tone={tone} label={statusLabel(source.status)} hollow={source.status === "missed"} />
        </View>
        <Text style={text.small} numberOfLines={compact ? 2 : 1}>
          {kindLabel(source.kind)} · {source.cadence}
        </Text>
        <Track theme={theme} source={source} axis={axis} />
        {source.needsYou ? (
          <Text style={[text.small, { color: ink(theme, tone) }]}>
            {source.reason}
            {since ? ` ${since[0]?.toUpperCase()}${since.slice(1)}.` : ""}
            {source.kind === "fleet" ? " It is in Needs you through the Fleet." : ""}
          </Text>
        ) : null}
        <Text style={[text.small, text.tabular]}>{[lastWords(source, now), next].filter(Boolean).join(" · ")}</Text>
      </Pressable>
      {open ? (
        <SourceDetail
          theme={theme}
          source={source}
          now={now}
          compact={compact}
          canOpenAgent={canOpenAgent}
          onLink={onLink}
        />
      ) : null}
    </View>
  );
}

function linkLabel(source: TimelineSource, canOpenAgent: boolean): string | null {
  switch (source.link?.kind) {
    case "fleet":
      return "Open Fleet";
    case "loop":
      return "Open the loop";
    case "agent":
      if (!canOpenAgent) return null;
      return source.kind === "heartbeat" ? "Open its session" : "Open the last run's session";
    default:
      return null;
  }
}

function SourceDetail({
  theme,
  source,
  now,
  compact,
  canOpenAgent,
  onLink,
}: {
  theme: PluginTheme;
  source: TimelineSource;
  now: number;
  compact: boolean;
  canOpenAgent: boolean;
  onLink: (source: TimelineSource) => void;
}) {
  const text = useText(theme);
  const { shown, more } = runsShown(source.runs);
  const link = linkLabel(source, canOpenAgent);
  const log = useTimelineLog(source.id, source.hasLog);
  return (
    <View style={{ gap: space[3], paddingBottom: space[2] }}>
      {source.needsYou ? null : <Text style={text.body}>{source.reason}</Text>}
      <View style={{ gap: space[1] }}>
        <Text style={text.label} accessibilityRole="header">
          Runs in the last 24 h
        </Text>
        {shown.length === 0 ? (
          <Text style={text.small}>None in the window.</Text>
        ) : (
          shown.map((run) => (
            <View
              key={`${run.at}:${run.status}`}
              style={{ flexDirection: "row", alignItems: "flex-start", gap: space[2] }}
            >
              <View
                style={{
                  width: 8,
                  height: 8,
                  marginTop: 4,
                  borderRadius: 8,
                  backgroundColor: run.status === "missed" ? "transparent" : ink(theme, toneOf(run.status)),
                  borderWidth: run.status === "missed" ? 1.5 : 0,
                  borderColor: ink(theme, toneOf(run.status)),
                }}
              />
              <Text style={[text.small, text.tabular, { flex: 1, color: theme.colors.foreground }]}>
                {runLine(run, now)}
              </Text>
            </View>
          ))
        )}
        {more > 0 ? <Text style={text.small}>{`And ${more} more in the window.`}</Text> : null}
        {source.runsCut ? (
          <Text
            style={text.small}
          >{`The track draws its newest ${TIMELINE_RUNS} runs; earlier ones are not drawn.`}</Text>
        ) : null}
      </View>
      {source.where ? (
        <Text style={[text.small, { color: theme.colors.foregroundMuted }]} selectable numberOfLines={2}>
          {source.where}
        </Text>
      ) : null}
      {log.data?.tail ? (
        <View
          style={{
            padding: space[2],
            borderRadius: radius.control,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface0,
          }}
        >
          <Text style={text.mono} selectable numberOfLines={compact ? 12 : 24}>
            {log.data.tail}
          </Text>
        </View>
      ) : null}
      {link ? (
        <View style={{ flexDirection: "row" }}>
          <Button theme={theme} label={link} compact={compact} onPress={() => onLink(source)} />
        </View>
      ) : null}
    </View>
  );
}

export function TimelineView({
  theme,
  compact,
  navigation,
  onOpenFleet,
  onOpenLoop,
}: {
  theme: PluginTheme;
  compact: boolean;
  navigation: PluginSurfaceProps["navigation"];
  onOpenFleet: (scope: string) => void;
  onOpenLoop: () => void;
}) {
  const text = useText(theme);
  const timeline = useTimeline();
  const [open, setOpen] = useState<string | null>(null);
  const onLink = (source: TimelineSource) => {
    const link = source.link;
    if (link?.kind === "fleet") onOpenFleet(link.scope);
    else if (link?.kind === "loop") onOpenLoop();
    else if (link?.kind === "agent") navigation?.openAgent({ agentId: link.agentId });
  };
  if (timeline.isPending) return <ActivityIndicator color={theme.colors.foregroundMuted} />;
  if (timeline.isError) {
    return (
      <View style={{ gap: space[3] }}>
        <Notice theme={theme} tone="danger">
          {errorText(timeline.error)}
        </Notice>
        <Button theme={theme} label="Try again" onPress={() => void timeline.refetch()} />
      </View>
    );
  }
  const view = timeline.data;
  const axis = axisOf(view);
  const sources = sortSources(view.sources);
  return (
    <Card theme={theme}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space[2] }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={text.title} accessibilityRole="header">
            Timeline
          </Text>
          <Text style={text.small}>The past 24 h and the next 24 h. {summaryLine(sources)}</Text>
        </View>
        <IconButton
          theme={theme}
          icon="RefreshCw"
          label="Refresh the timeline"
          onPress={() => void timeline.refetch()}
        />
      </View>
      <Legend theme={theme} />
      {keyedLines(view.warnings.slice(0, 3)).map(({ key, line }) => (
        <Notice key={key} theme={theme} tone="warn">
          {line}
        </Notice>
      ))}
      {view.warnings.length > 3 ? (
        <Text style={text.small}>{`And ${view.warnings.length - 3} more that could not be read.`}</Text>
      ) : null}
      {sources.length === 0 ? (
        <Text style={text.muted}>
          Nothing is scheduled: no Paseo schedule, launchd job, loop or fleet tick was found.
        </Text>
      ) : (
        <View style={{ gap: space[3] }}>
          <AxisLabels theme={theme} axis={axis} compact={compact} />
          {sources.map((source) => (
            <SourceRow
              key={source.id}
              theme={theme}
              source={source}
              axis={axis}
              compact={compact}
              canOpenAgent={Boolean(navigation)}
              open={open === source.id}
              onToggle={() => setOpen((current) => (current === source.id ? null : source.id))}
              onLink={onLink}
            />
          ))}
        </View>
      )}
    </Card>
  );
}

/** A failed or missed run, above the other views, for each source that needs you (fleet scopes are FleetNotices'). */
export function TimelineNotices({
  theme,
  compact,
  onOpen,
}: {
  theme: PluginTheme;
  compact: boolean;
  onOpen: () => void;
}) {
  const read = useRpc(attentionWork);
  const attention = useQuery({
    queryKey: ["maestro", "attention"],
    queryFn: () => read({}),
    // One query with FleetNotices, at its pace.
    refetchInterval: TIMELINE_POLL_MS,
  });
  const notices = attention.data?.timeline ?? [];
  if (notices.length === 0) return null;
  return (
    <View style={{ gap: space[2] }}>
      {notices.map((notice) => (
        <Notice
          key={notice.id}
          theme={theme}
          tone={notice.status === "failed" ? "danger" : "warn"}
          action={
            <Button
              theme={theme}
              icon="CalendarClock"
              label="Open Timeline"
              compact={compact}
              accessibilityLabel={`Open Timeline, ${notice.name}`}
              onPress={onOpen}
            />
          }
        >
          {noticeText(notice, Date.now())}
        </Notice>
      ))}
    </View>
  );
}
