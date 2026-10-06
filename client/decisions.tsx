// Decisions: the asks in `.control/asks` ledgers, each with what a person needs
// to decide it, answered in place. Two kinds of ledger feed it: the
// workspace's own (the control repo's, each ask read at its home by the
// control interface spec's §5.2 rule, server/control-home.ts), shown one at a
// time in the Decisions tab (DecisionsView), and a fleet scope's own root
// (server/fleet.ts), listed a ledger at a time in the Fleet view
// (DecisionGroups). Both use the same card and the same ask.answer.
//
// Ideas (idea-triage asks) are not listed here: they are answered in the
// Initiatives tab, under their initiative (client/initiatives.tsx).
//
// AskNotices is the same where the rest of Maestro shows what needs you: the
// asks that wait on you (blocking, or recommending what cannot be undone),
// which the header count counts.

import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type AnswerWhere, type AskNotice, type DecisionAsk, getWorkspaceAsks } from "../shared/fleet";
import { DecisionCard } from "./decision-card";
import {
  askKey,
  askNoticeText,
  type DecisionGroup,
  decisionAsks,
  groupDecisions,
  groupMeta,
  isTriaged,
  ledgerRail,
  noticeAsk,
} from "./decisions-model";
import { plural } from "./format";
import { useAttention } from "./hooks";
import { requestIntent } from "./intent";
import { Button, Notice, Section, space, useText } from "./ui";

export { DecisionCard } from "./decision-card";
/** Whether two reads name the same ask at the same home. */
export { sameAsk } from "./decisions-model";

/** Ledgers change when someone answers or an arc commits: a read every 30 s is plenty. */
const POLL_MS = 30_000;
/** Up to this many open asks in all, every ledger opens; past it, only those with an ask that waits on you. */
export const ALL_OPEN_UP_TO = 10;

type Navigation = PluginSurfaceProps["navigation"];

/** One ledger's asks: its heading (press to fold or open), its open asks, and its answered ones folded under them. */
function LedgerGroup({
  theme,
  group,
  startOpen,
  where,
  compact,
  navigation,
  onAnswered,
}: {
  theme: PluginTheme;
  group: DecisionGroup;
  startOpen: boolean;
  where: (ask: DecisionAsk) => AnswerWhere;
  compact: boolean;
  navigation: Navigation;
  onAnswered: (answered: DecisionAsk) => void;
}) {
  const text = useText(theme);
  // Your own fold or open holds; until you choose, a ledger opens once an ask in it waits on you.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? startOpen;
  const [answeredOpen, setAnsweredOpen] = useState(false);
  // Asks you answered here stay where you answered them, saying so, rather than folding away at once.
  const [answeredHere, setAnsweredHere] = useState<ReadonlySet<string>>(() => new Set());
  const meta = groupMeta(group);
  const answered = (ask: DecisionAsk) => {
    setAnsweredHere((now) => new Set([...now, askKey(ask)]));
    // Its last open ask answered, a ledger would fold under you: it stays as you had it, open.
    setChosen((now) => now ?? true);
    onAnswered(ask);
  };
  const stay = group.answered.filter((ask) => answeredHere.has(askKey(ask)));
  const folded = group.answered.filter((ask) => !answeredHere.has(askKey(ask)));
  const card = (ask: DecisionAsk) => (
    <DecisionCard
      key={askKey(ask)}
      theme={theme}
      ask={ask}
      where={where(ask)}
      compact={compact}
      navigation={navigation}
      onAnswered={answered}
    />
  );
  return (
    <View style={{ gap: space[2] }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        accessibilityLabel={`${group.ledger}: ${meta}`}
        onPress={() => setChosen(!open)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "baseline",
          gap: space[2],
          flexWrap: "wrap",
          paddingVertical: space[1],
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <Text style={[text.small, { fontWeight: "600", color: theme.colors.foreground }]}>
          {`${open ? "▾" : "▸"} ${group.arc ?? group.ledger}`}
        </Text>
        <Text style={[text.small, { color: group.waiting > 0 ? theme.colors.statusWarning : undefined }]}>{meta}</Text>
      </Pressable>
      {open ? (
        <View style={{ gap: space[2] }}>
          {group.open.map(card)}
          {stay.map(card)}
          {folded.length > 0 ? (
            <View style={{ flexDirection: "row" }}>
              <Button
                theme={theme}
                variant="quiet"
                icon={answeredOpen ? "ChevronUp" : "ChevronDown"}
                label={answeredOpen ? "Hide the answered" : `Show ${folded.length} answered`}
                compact={compact}
                accessibilityLabel={`${answeredOpen ? "Hide" : "Show"} the answered asks in ${group.ledger}`}
                onPress={() => setAnsweredOpen((now) => !now)}
              />
            </View>
          ) : null}
          {answeredOpen ? folded.map(card) : null}
        </View>
      ) : null}
    </View>
  );
}

/** A fleet scope's asks, a ledger at a time: ledgers with an ask that waits on you first and open, the rest folded once there are many. */
export function DecisionGroups({
  theme,
  asks,
  where,
  compact,
  navigation,
  onAnswered,
}: {
  theme: PluginTheme;
  asks: readonly DecisionAsk[];
  where: (ask: DecisionAsk) => AnswerWhere;
  compact: boolean;
  navigation: Navigation;
  onAnswered: (answered: DecisionAsk) => void;
}) {
  const groups = groupDecisions(asks);
  // Judged once, as you open the view: a count crossing ten as you answer or as asks arrive never folds or opens it all.
  const [many] = useState(() => groups.reduce((sum, group) => sum + group.open.length, 0) > ALL_OPEN_UP_TO);
  return (
    <View style={{ gap: space[3] }}>
      {groups.map((group) => (
        <LedgerGroup
          key={group.ledger}
          theme={theme}
          group={group}
          startOpen={group.waiting > 0 || (group.open.length > 0 && !many)}
          where={where}
          compact={compact}
          navigation={navigation}
          onAnswered={onAnswered}
        />
      ))}
    </View>
  );
}

export function useWorkspaceAsks() {
  const get = useRpc(getWorkspaceAsks);
  return useQuery({ queryKey: ["maestro", "workspace-asks"], queryFn: () => get({}), refetchInterval: POLL_MS });
}

/** The open decisions the tab lists (ideas aside: decisionAsks) and how many wait on you: the Decisions tab's badge. */
export function useDecisionCounts(): { open: number; waiting: number } {
  const read = useWorkspaceAsks();
  const open = (read.data ? decisionAsks(read.data) : []).filter(isTriaged);
  return { open: open.length, waiting: open.filter((ask) => ask.waiting).length };
}

/**
 * The workspace's decisions in a few lines, for a view that is not Decisions:
 * how many are open across how many ledgers, how many wait on you, and a way
 * to the Decisions tab, where they are answered one at a time.
 */
export function WorkspaceDecisions({
  theme,
  compact,
  focus = null,
}: {
  theme: PluginTheme;
  compact: boolean;
  navigation?: Navigation;
  /** A ledger to open the tab at. */
  focus?: string | null;
}) {
  const text = useText(theme);
  const read = useWorkspaceAsks();
  if (!read.data) return null;
  const rail = ledgerRail(read.data.decisions);
  const open = rail.reduce((sum, entry) => sum + entry.open, 0);
  if (open === 0) return null;
  const waiting = rail.reduce((sum, entry) => sum + entry.waiting, 0);
  return (
    <Section
      theme={theme}
      title="Workspace decisions"
      meta={[
        `${open} open across ${plural(rail.length, "ledger")}`,
        waiting > 0 ? `${waiting} ${waiting === 1 ? "waits" : "wait"} on you` : null,
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      <Text style={text.small}>They are not the fleet's: they have their own tab, one decision at a time.</Text>
      <View style={{ flexDirection: "row" }}>
        <Button
          theme={theme}
          icon="ArrowRight"
          label="Triage decisions"
          compact={compact}
          onPress={() => requestIntent({ kind: "decisions", ledger: focus, id: null })}
        />
      </View>
    </Section>
  );
}

/**
 * The decision asks that wait on you, where Maestro shows what needs you, from
 * work.attention: exactly what the header count counts for them. Open
 * Decisions goes to the Decisions tab for the workspace's, at the first one,
 * and to the Fleet view for a fleet scope's.
 */
export function AskNotices({
  theme,
  compact,
  onOpen,
}: {
  theme: PluginTheme;
  compact: boolean;
  onOpen: (notice: AskNotice) => void;
}) {
  // The one owner of the work.attention read (client/hooks.ts).
  const attention = useAttention();
  const asks = attention.data?.asks ?? [];
  // The ask the line names is the ask the button opens (noticeAsk).
  const first = noticeAsk(asks);
  if (!first) return null;
  return (
    <Notice
      theme={theme}
      tone="warn"
      action={
        <Button
          theme={theme}
          icon="Inbox"
          label="Open Decisions"
          compact={compact}
          accessibilityLabel={`Open Decisions, ${asks.length} waiting`}
          onPress={() => onOpen(first)}
        />
      }
    >
      {askNoticeText(asks)}
    </Notice>
  );
}
