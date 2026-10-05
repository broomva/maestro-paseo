// The Fleet view: fleet-reconcile's hourly runs per scope. Its health (on
// time, failing, missed), what needs you from it (the asks and alerts, each
// the Maestro work the fleet raised, opened rather than copied), what it would
// do under dry run with your verdict on each, its last ticks, and its latest
// report. Your verdict is recorded in the fleet's review file; nothing here
// changes what the fleet does, its mode or its dry run.
//
// Each thing drills in: an ask opens the session it is about and the tick
// that raised it; a decision ask, the workspace's or the fleet's own ledger's
// (client/decisions.tsx), shows what it costs and what each option does, and
// takes your answer in place; a proposal opens
// its session in Paseo; a tick opens its report, its failed step and its log.
//
// FleetNotices is the same scope health where the rest of Maestro shows what
// needs you: a missed or failing tick the fleet has not raised as work of its own.

import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { attentionWork } from "../shared/contracts";
import {
  type DecisionAsk,
  type FleetAsk,
  type FleetDetail,
  type FleetItem,
  type FleetProposal,
  type FleetView as FleetRead,
  type FleetScope,
  type FleetTick,
  getFleet,
  getFleetTick,
  groupProposals,
  type ProposalGroup,
  type ReviewVerdict,
  reviewProposal,
} from "../shared/fleet";
import { PLAIN_VOICE } from "../shared/states";
import { DecisionGroups, sameAsk, WorkspaceDecisions } from "./decisions";
import {
  agoText,
  askMeta,
  askWhere,
  classText,
  groupReviewText,
  groupSubject,
  HEALTH_LABEL,
  healthTone,
  keysFor,
  lastTickText,
  modeText,
  noticeText,
  proposalSubject,
  proposalsHeading,
  scopeChipLabel,
  sessionFacts,
  TICK_LABEL,
  tickFacts,
  tickLabel,
  tickTone,
  tickWhen,
} from "./fleet-model";
import { errorText, plural } from "./format";
import { useRefresh } from "./hooks";
import { MarkdownView } from "./markdown-view";
import { Chip } from "./plane-controls";
import { Button, Card, Notice, radius, Section, size, space, useText } from "./ui";

/** Ticks come hourly: a read every 30 s is plenty, and the reads are files. */
const POLL_MS = 30_000;
const TICKS = 24;

type Navigation = PluginSurfaceProps["navigation"];

/** One tick's report and log lines, read when its row (or an ask raised at it) is opened. */
function useFleetTick(scope: string, tick: number, enabled: boolean) {
  const get = useRpc(getFleetTick);
  return useQuery({
    queryKey: ["maestro", "fleet-tick", scope, tick],
    queryFn: () => get({ scope, tick }),
    enabled,
    staleTime: POLL_MS,
  });
}

export function useFleet(scope: string | null) {
  const get = useRpc(getFleet);
  return useQuery({
    queryKey: ["maestro", "fleet", scope],
    queryFn: () => get(scope ? { scope, ticks: TICKS } : { ticks: TICKS }),
    refetchInterval: POLL_MS,
  });
}

function toneInk(theme: PluginTheme, tone: "danger" | "warn" | "success" | "muted" | "accent"): string {
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
function Status({ theme, tone, label }: { theme: PluginTheme; tone: Parameters<typeof toneInk>[1]; label: string }) {
  const ink = toneInk(theme, tone);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[1] }}>
      <View style={{ width: 7, height: 7, borderRadius: 7, backgroundColor: ink }} />
      <Text style={{ color: ink, fontSize: size.xs, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

/** A link to work the fleet raised: its title, its state, and Open. */
function ItemLink({
  theme,
  item,
  compact,
  onSelect,
}: {
  theme: PluginTheme;
  item: FleetItem;
  compact: boolean;
  onSelect: (id: string) => void;
}) {
  const text = useText(theme);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}>
      <View style={{ flex: 1, minWidth: 160, gap: 2 }}>
        <Text style={text.small} numberOfLines={2}>
          {item.title}
        </Text>
        <Text
          style={[text.small, { color: item.needsYou ? theme.colors.statusWarning : theme.colors.foregroundMuted }]}
        >
          {item.needsYou ? "In Needs you" : PLAIN_VOICE[item.state].label}
        </Text>
      </View>
      <Button
        theme={theme}
        icon="ArrowUpRight"
        label="Open"
        compact={compact}
        accessibilityLabel={`Open ${item.title}`}
        onPress={() => onSelect(item.id)}
      />
    </View>
  );
}

function HealthCard({
  theme,
  scope,
  detail,
  compact,
  onSelect,
}: {
  theme: PluginTheme;
  scope: FleetScope;
  detail: FleetDetail;
  compact: boolean;
  onSelect: (id: string) => void;
}) {
  const text = useText(theme);
  const { health } = scope;
  const every = detail.schedule.intervalMinutes;
  return (
    <Card theme={theme}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}>
        <Text style={text.title}>{scope.id}</Text>
        <Status theme={theme} tone={healthTone(health.status)} label={HEALTH_LABEL[health.status]} />
      </View>
      <Text style={text.body}>{health.reason}</Text>
      <Text style={text.small}>
        {[
          lastTickText(scope),
          modeText(scope),
          detail.schedule.scheduled ? (every ? `every ${every} min` : "scheduled") : "no LaunchAgent",
        ].join(" · ")}
      </Text>
      {health.item ? (
        <View style={{ gap: space[1] }}>
          <Text style={text.label}>The fleet raised this as work</Text>
          <ItemLink theme={theme} item={health.item} compact={compact} onSelect={onSelect} />
        </View>
      ) : null}
    </Card>
  );
}

/** A tick's report, failed step, exit and log lines: what opening a tick row shows, and an ask's details. */
function TickDetail({
  theme,
  scope,
  tick,
  facts,
  compact,
}: {
  theme: PluginTheme;
  scope: string;
  tick: number;
  facts: string | null;
  compact: boolean;
}) {
  const text = useText(theme);
  const read = useFleetTick(scope, tick, true);
  return (
    <View style={{ gap: space[2], paddingVertical: space[2] }}>
      {facts ? <Text style={[text.small, text.tabular, { color: theme.colors.foreground }]}>{facts}</Text> : null}
      {read.isPending ? (
        <ActivityIndicator color={theme.colors.foregroundMuted} />
      ) : read.isError ? (
        <Notice theme={theme} tone="danger">
          {errorText(read.error)}
        </Notice>
      ) : (
        <>
          {read.data.notes.map((note) => (
            <Notice key={note} theme={theme} tone="warn">
              {note}
            </Notice>
          ))}
          {read.data.log ? (
            <View style={{ gap: space[1] }}>
              <Text style={text.label}>{`What tick ${tick} logged`}</Text>
              <View
                style={{
                  padding: space[2],
                  borderRadius: radius.control,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.surface0,
                }}
              >
                <Text style={text.mono} selectable numberOfLines={compact ? 16 : 40}>
                  {read.data.log.text}
                </Text>
              </View>
              <Text style={text.small} selectable numberOfLines={1}>
                {read.data.log.truncated ? `The end of it, from ${read.data.log.path}` : read.data.log.path}
              </Text>
            </View>
          ) : (
            <Text style={text.small}>{`tick.log holds no lines for tick ${tick}.`}</Text>
          )}
          {read.data.report ? (
            <View style={{ gap: space[1] }}>
              <Text style={text.label}>{`Tick ${tick}'s report`}</Text>
              <Card theme={theme}>
                <MarkdownView source={read.data.report.markdown} theme={theme} compact={compact} />
                {read.data.report.truncated ? <Text style={text.small}>The report is longer than this.</Text> : null}
              </Card>
            </View>
          ) : (
            <Text style={text.small}>{`Tick ${tick} wrote no report.`}</Text>
          )}
        </>
      )}
    </View>
  );
}

/** A session's name, how it is, where it runs and its branch, with Open in Paseo when it is a Paseo agent. */
function SessionLine({
  theme,
  session,
  compact,
  navigation,
}: {
  theme: PluginTheme;
  session: NonNullable<FleetProposal["session"]>;
  compact: boolean;
  navigation: Navigation;
}) {
  const text = useText(theme);
  const agentId = session.agentId;
  const facts = sessionFacts(session);
  const name = `${session.short}${session.name ? ` ${session.name}` : ""}`;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}>
      <View style={{ flex: 1, minWidth: 160, gap: 2 }}>
        <Text style={text.small} numberOfLines={1}>
          {name}
        </Text>
        {facts ? (
          <Text style={[text.small, { color: theme.colors.foregroundMuted }]} numberOfLines={2} selectable>
            {facts}
          </Text>
        ) : null}
      </View>
      {!agentId ? (
        <Text style={text.small}>Not a Paseo session</Text>
      ) : navigation ? (
        <Button
          theme={theme}
          icon="ArrowUpRight"
          label="Open in Paseo"
          compact={compact}
          accessibilityLabel={`Open session ${name} in Paseo`}
          onPress={() => navigation.openAgent({ agentId })}
        />
      ) : null}
    </View>
  );
}

function AskRow({
  theme,
  scope,
  ask,
  compact,
  navigation,
  onSelect,
}: {
  theme: PluginTheme;
  scope: string;
  ask: FleetAsk;
  compact: boolean;
  navigation: Navigation;
  onSelect: (id: string) => void;
}) {
  const text = useText(theme);
  const [open, setOpen] = useState(false);
  const item = ask.item;
  const session = ask.session;
  const agentId = session?.agentId ?? null;
  return (
    <View
      style={{
        gap: space[1],
        padding: space[3],
        borderRadius: radius.control,
        borderWidth: 1,
        borderColor: theme.colors.border,
      }}
    >
      <Text style={text.body}>{ask.question}</Text>
      <Text style={text.small}>{askMeta(ask)}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}>
        <Text
          style={[
            text.small,
            {
              flex: 1,
              minWidth: 160,
              color: item?.needsYou ? theme.colors.statusWarning : theme.colors.foregroundMuted,
            },
          ]}
        >
          {askWhere(ask)}
        </Text>
        {agentId && navigation ? (
          <Button
            theme={theme}
            icon="ArrowUpRight"
            label="Open session"
            compact={compact}
            accessibilityLabel={`Open the session ask ${ask.id} is about: ${session?.name ?? session?.short}`}
            onPress={() => navigation.openAgent({ agentId })}
          />
        ) : null}
        {item ? (
          <Button
            theme={theme}
            icon="ArrowUpRight"
            label={item.needsYou ? "Answer in Needs you" : "Open"}
            compact={compact}
            accessibilityLabel={`Open the fleet's work for ask ${ask.id}: ${item.title}`}
            onPress={() => onSelect(item.id)}
          />
        ) : null}
        <Button
          theme={theme}
          variant="quiet"
          icon={open ? "ChevronUp" : "ChevronDown"}
          label={open ? "Less" : "Details"}
          compact={compact}
          accessibilityLabel={`${open ? "Hide" : "Show"} the details of ask ${ask.id}`}
          onPress={() => setOpen((shown) => !shown)}
        />
      </View>
      {open ? (
        <View style={{ gap: space[1], paddingTop: space[1] }}>
          <Text style={[text.small, text.tabular]} selectable>
            {[
              `key ${ask.key}`,
              ask.batch ? `batch ${ask.batch}` : null,
              session ? `session ${session.id}${agentId ? "" : " (not a Paseo session)"}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
          {ask.firstTick !== null ? (
            <>
              <Text style={text.label}>{`Raised at tick ${ask.firstTick}`}</Text>
              <TickDetail theme={theme} scope={scope} tick={ask.firstTick} facts={null} compact={compact} />
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Puts verdicts the host has just recorded into every Fleet read held, so the
 * card says so at once: no second tap on a button that still reads Accept,
 * and nothing moves under the finger while the refetch is on its way.
 */
function useApplyReviews() {
  const client = useQueryClient();
  return (scope: string, reviewed: readonly FleetProposal[]) => {
    const byKey = new Map(reviewed.map((proposal) => [proposal.key, proposal.review]));
    client.setQueriesData<FleetRead>({ queryKey: ["maestro", "fleet"] }, (view) => {
      if (!view?.detail || view.detail.id !== scope) return view;
      const proposals = view.detail.proposals.map((proposal) =>
        byKey.has(proposal.key) ? { ...proposal, review: byKey.get(proposal.key) ?? null } : proposal,
      );
      const unreviewed = groupProposals(proposals).filter((group) => group.review === null).length;
      return {
        ...view,
        scopes: view.scopes.map((entry) => (entry.id === scope ? { ...entry, unreviewed } : entry)),
        detail: { ...view.detail, proposals },
      };
    });
  };
}

/** How many sessions a group lists before "Show all". */
const GROUP_SHOWN = 3;

function ProposalCard({
  theme,
  scope,
  group,
  compact,
  navigation,
}: {
  theme: PluginTheme;
  scope: string;
  group: ProposalGroup;
  compact: boolean;
  navigation: Navigation;
}) {
  const text = useText(theme);
  const toast = useToast();
  const refresh = useRefresh();
  const apply = useApplyReviews();
  const send = useRpc(reviewProposal);
  // The card says it from the host's answer at once. The refetch after is not waited on: an onSettled that
  // returned its promise would hold every callback below until it landed, on a slow relay too.
  const review = useMutation({
    mutationFn: send,
    onSuccess: ({ proposals }, sent) => apply(sent.scope, proposals),
    onSettled: () => {
      void refresh();
    },
  });
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [all, setAll] = useState(false);
  const subject = groupSubject(group);
  const many = group.proposals.length > 1;
  const decide = (choice: ReviewVerdict, words = "") => {
    const keys = keysFor(group, choice);
    if (keys.length === 0) return;
    review.mutate(
      { scope, keys, verdict: choice, note: words },
      {
        onSuccess: () => {
          setRejecting(false);
          setNote("");
        },
        onError: (error) => toast.error(errorText(error)),
      },
    );
  };
  const klass = group.classId
    ? group.className
      ? `Class ${group.classId}, ${group.className}`
      : `Class ${group.classId}`
    : null;
  const [first] = group.proposals;
  const sessions = group.proposals.filter((proposal) => proposal.session);
  const shown = all ? sessions : sessions.slice(0, GROUP_SHOWN);
  const verdict = group.review?.verdict ?? null;
  const label = `${group.action}, ${subject}`;
  return (
    <Card theme={theme} style={{ gap: space[2] }}>
      <Text style={[text.body, { fontWeight: "600" }]}>Would {group.action}</Text>
      <Text style={text.small} numberOfLines={2}>
        {[subject, klass, first?.tick !== null && first?.tick !== undefined ? `tick ${first.tick}` : null]
          .filter(Boolean)
          .join(" · ")}
      </Text>
      {!many && first?.evidence ? (
        <Text style={text.muted} numberOfLines={3}>
          {first.evidence}
        </Text>
      ) : null}
      {!many && first?.session ? (
        <SessionLine theme={theme} session={first.session} compact={compact} navigation={navigation} />
      ) : null}
      <Text
        style={[
          text.small,
          {
            color:
              verdict === "accept"
                ? theme.colors.statusSuccess
                : verdict === "reject"
                  ? theme.colors.statusDanger
                  : theme.colors.foregroundMuted,
          },
        ]}
      >
        {groupReviewText(group)}
      </Text>
      {rejecting ? (
        <View style={{ gap: space[2] }}>
          <TextInput
            value={note}
            onChangeText={setNote}
            multiline
            placeholder="Why not? (optional)"
            placeholderTextColor={theme.colors.foregroundMuted}
            accessibilityLabel={`Why reject: ${label}`}
            style={{
              minHeight: 56,
              padding: space[3],
              borderRadius: radius.control,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface2,
              color: theme.colors.foreground,
              fontSize: 14,
              textAlignVertical: "top",
            }}
          />
          <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap" }}>
            <Button
              theme={theme}
              variant="primary"
              label={many ? `Reject all ${group.proposals.length}` : "Reject"}
              compact={compact}
              busy={review.isPending}
              accessibilityLabel={`Confirm reject: ${label}`}
              onPress={() => decide("reject", note)}
            />
            <Button
              theme={theme}
              variant="quiet"
              label="Keep it"
              compact={compact}
              disabled={review.isPending}
              onPress={() => setRejecting(false)}
            />
          </View>
        </View>
      ) : (
        <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap" }}>
          <Button
            theme={theme}
            variant={verdict === "accept" ? "secondary" : "primary"}
            icon="Check"
            label={verdict === "accept" ? "Accepted" : many ? `Accept all ${group.proposals.length}` : "Accept"}
            compact={compact}
            busy={review.isPending}
            disabled={verdict === "accept"}
            accessibilityLabel={`Accept: ${label}`}
            onPress={() => decide("accept")}
          />
          <Button
            theme={theme}
            icon="X"
            label={verdict === "reject" ? "Rejected" : "Reject"}
            compact={compact}
            disabled={verdict === "reject" || review.isPending}
            accessibilityLabel={`Reject: ${label}`}
            onPress={() => setRejecting(true)}
          />
        </View>
      )}
      {/* The sessions under the verbs: a long list never pushes the verdict off the screen. */}
      {many ? (
        <View style={{ gap: space[1] }}>
          {shown.map((proposal) => (
            <View key={proposal.key} style={{ gap: 2 }}>
              {proposal.session ? (
                <SessionLine theme={theme} session={proposal.session} compact={compact} navigation={navigation} />
              ) : (
                <Text style={text.small} numberOfLines={1}>
                  {proposalSubject(proposal)}
                </Text>
              )}
              {proposal.evidence ? (
                <Text style={[text.small, { paddingLeft: space[3] }]} numberOfLines={2}>
                  {proposal.evidence}
                </Text>
              ) : null}
            </View>
          ))}
          {sessions.length > GROUP_SHOWN ? (
            <View style={{ flexDirection: "row" }}>
              <Button
                theme={theme}
                variant="quiet"
                label={all ? "Show fewer" : `Show all ${sessions.length}`}
                compact={compact}
                accessibilityLabel={`${all ? "Show fewer" : "Show all"} sessions: ${group.action}`}
                onPress={() => setAll((open) => !open)}
              />
            </View>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

function TickRow({
  theme,
  scope,
  tick,
  compact,
  open,
  onToggle,
}: {
  theme: PluginTheme;
  scope: string;
  tick: FleetTick;
  compact: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const text = useText(theme);
  const status = (
    <Status
      theme={theme}
      tone={tickTone(tick.status)}
      label={`${TICK_LABEL[tick.status]}${tick.failedStep ? ` at ${tick.failedStep}` : ""}`}
    />
  );
  const classes = <Text style={[text.small, compact ? null : { flex: 1 }]}>{classText(tick.classCounts)}</Text>;
  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        accessibilityLabel={`${tickLabel(tick)}. ${classText(tick.classCounts)}`}
        onPress={onToggle}
        style={({ pressed }) => ({ paddingVertical: space[2], gap: 2, opacity: pressed ? 0.85 : 1 })}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[3], flexWrap: "wrap" }}>
          <Text style={[text.body, text.tabular, { fontWeight: "600", minWidth: 32 }]}>{tick.tick}</Text>
          <Text style={[text.small, text.tabular, { minWidth: 92 }]}>{tickWhen(tick.at)}</Text>
          {status}
          {compact ? null : classes}
        </View>
        {compact ? classes : null}
      </Pressable>
      {open ? (
        <TickDetail theme={theme} scope={scope} tick={tick.tick} facts={tickFacts(tick)} compact={compact} />
      ) : null}
    </View>
  );
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
  scope: string | null;
  /** A tick to open, when the view is opened on one (from a timeline run). */
  tick?: number | null;
  navigation: Navigation;
  onScope: (scope: string) => void;
  onSelect: (id: string) => void;
}) {
  const fleet = useFleet(scope);
  const text = useText(theme);
  const client = useQueryClient();
  // An answer the host has just written goes into every Fleet read held, so the card says so at once.
  const applyAnswer = (scopeId: string, answered: DecisionAsk) =>
    client.setQueriesData<FleetRead>({ queryKey: ["maestro", "fleet"] }, (view) => {
      if (!view?.detail || view.detail.id !== scopeId) return view;
      const decisions = view.detail.decisions.map((ask) => (sameAsk(ask, answered) ? answered : ask));
      return { ...view, detail: { ...view.detail, decisions } };
    });
  const [reportOpen, setReportOpen] = useState(!compact);
  const [openTick, setOpenTick] = useState<number | null>(tick);
  const [opened, setOpened] = useState(tick);
  // Opened on another tick while mounted (a second timeline run): that one opens.
  if (tick !== opened) {
    setOpened(tick);
    setOpenTick(tick);
  }

  if (fleet.isPending) return <ActivityIndicator color={theme.colors.foregroundMuted} />;
  if (fleet.isError) {
    return (
      <View style={{ gap: space[3] }}>
        <Notice theme={theme} tone="danger">
          {errorText(fleet.error)}
        </Notice>
        <Button theme={theme} label="Try again" onPress={() => void fleet.refetch()} />
      </View>
    );
  }
  const { scopes, detail, error } = fleet.data;
  const current = scopes.find((entry) => entry.id === detail?.id) ?? null;
  return (
    <View style={{ gap: space[5] }}>
      <WorkspaceDecisions theme={theme} compact={compact} navigation={navigation} />
      {error ? (
        <Notice theme={theme} tone="warn">
          {error}
        </Notice>
      ) : null}
      {scopes.length === 0 || !detail || !current ? (
        <Card theme={theme}>
          <Text style={text.title}>No fleet on this Mac</Text>
          <Text style={text.muted}>
            fleet-reconcile has no scope here: its config (~/.config/ctx/fleet.json) names none, and no state dir holds
            a ledger or ticks. Its install.sh sets one up.
          </Text>
        </Card>
      ) : (
        <>
          {scopes.length > 1 ? (
            <View
              accessibilityRole="toolbar"
              accessibilityLabel="Fleet scope"
              style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}
            >
              {scopes.map((entry) => (
                <Chip
                  key={entry.id}
                  theme={theme}
                  label={entry.id}
                  count={entry.health.status === "ok" ? undefined : HEALTH_LABEL[entry.health.status]}
                  badge={entry.unreviewed}
                  selected={entry.id === current.id}
                  accessibilityLabel={scopeChipLabel(entry)}
                  onPress={() => onScope(entry.id)}
                />
              ))}
            </View>
          ) : null}

          <HealthCard theme={theme} scope={current} detail={detail} compact={compact} onSelect={onSelect} />

          {detail.warnings.slice(0, 3).map((warning) => (
            <Notice key={warning} theme={theme} tone="warn">
              {warning}
            </Notice>
          ))}

          {detail.decisions.length > 0 ? (
            <Section
              theme={theme}
              title="The fleet's decisions"
              meta={`${detail.decisions.filter((ask) => ask.state === "open").length} open`}
            >
              <Text style={text.small}>
                The fleet's own ask ledger, in {detail.askRoot}. Your answer is written there, under the ledger lock
                (§5.5), and the fleet reads it at its next tick.
              </Text>
              <DecisionGroups
                theme={theme}
                asks={detail.decisions}
                where={() => ({ kind: "fleet", scope: current.id })}
                compact={compact}
                navigation={navigation}
                onAnswered={(answered) => applyAnswer(current.id, answered)}
              />
            </Section>
          ) : null}

          <Section theme={theme} title="Asks" meta={detail.asks.length > 0 ? `${detail.asks.length} open` : undefined}>
            {detail.asks.length === 0 ? (
              <Text style={text.muted}>The fleet has no open asks for you.</Text>
            ) : (
              <View style={{ gap: space[2] }}>
                <Text style={text.small}>
                  You answer each in the work the fleet raised for its batch: approve to acknowledge, send back a note
                  to answer, cancel to dismiss. An ask about a session opens it; Details shows the tick that raised it.
                </Text>
                {detail.asks.map((ask) => (
                  <AskRow
                    key={`${ask.batch}-${ask.key}`}
                    theme={theme}
                    scope={current.id}
                    ask={ask}
                    compact={compact}
                    navigation={navigation}
                    onSelect={onSelect}
                  />
                ))}
              </View>
            )}
            {detail.alerts.length > 0 ? (
              <View style={{ gap: space[2] }}>
                <Text style={text.label}>{plural(detail.alerts.length, "open alert")}</Text>
                {detail.alerts.map((item) => (
                  <ItemLink key={item.id} theme={theme} item={item} compact={compact} onSelect={onSelect} />
                ))}
              </View>
            ) : null}
          </Section>

          <Section
            theme={theme}
            title="Would do"
            meta={detail.proposals.length > 0 ? proposalsHeading(groupProposals(detail.proposals)) : undefined}
          >
            <Text style={text.small}>
              {current.dryRun === true
                ? "Under dry run nothing here was done. Your verdict is recorded for the fleet's phase-3 review; it changes nothing it does."
                : current.dryRun === false
                  ? "What the fleet proposes, live. Your verdict is recorded for the fleet; it changes nothing it does."
                  : "What the fleet proposes. Your verdict is recorded for the fleet; it changes nothing it does."}
            </Text>
            {detail.proposals.length === 0 ? (
              <Text style={text.muted}>The latest report proposes nothing.</Text>
            ) : (
              groupProposals(detail.proposals).map((group) => (
                <ProposalCard
                  key={group.key}
                  theme={theme}
                  scope={current.id}
                  group={group}
                  compact={compact}
                  navigation={navigation}
                />
              ))
            )}
          </Section>

          <Section theme={theme} title="Ticks" meta={`last ${plural(detail.ticks.length, "tick")}`}>
            {detail.ticks.length === 0 ? (
              <Text style={text.muted}>No tick has run in this scope yet.</Text>
            ) : (
              <View>
                {detail.ticks.map((row) => (
                  <TickRow
                    key={row.tick}
                    theme={theme}
                    scope={current.id}
                    tick={row}
                    compact={compact}
                    open={openTick === row.tick}
                    onToggle={() => setOpenTick((now) => (now === row.tick ? null : row.tick))}
                  />
                ))}
              </View>
            )}
          </Section>

          {detail.report ? (
            <Section
              theme={theme}
              title={`Report, tick ${detail.report.tick}`}
              meta={agoText(current.lastTick?.at ?? null) ?? undefined}
            >
              <View style={{ flexDirection: "row" }}>
                <Button
                  theme={theme}
                  icon={reportOpen ? "ChevronUp" : "ChevronDown"}
                  label={reportOpen ? "Hide the report" : "Show the report"}
                  compact={compact}
                  onPress={() => setReportOpen((open) => !open)}
                />
              </View>
              {reportOpen ? (
                <Card theme={theme}>
                  <MarkdownView source={detail.report.markdown} theme={theme} compact={compact} />
                  {detail.report.truncated ? (
                    <Text style={text.small}>The report is longer than this; the rest is in {detail.stateDir}.</Text>
                  ) : null}
                </Card>
              ) : null}
            </Section>
          ) : null}
        </>
      )}
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
  const read = useRpc(attentionWork);
  const attention = useQuery({
    queryKey: ["maestro", "attention"],
    queryFn: () => read({}),
    refetchInterval: POLL_MS,
  });
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
