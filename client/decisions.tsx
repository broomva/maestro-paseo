// Decisions: the asks in `.control/asks` ledgers, each with what a person needs
// to decide it, answered in place. Two kinds of ledger feed it: the
// workspace's own (the control repo's, each ask read at its home by the
// control interface spec's §5.2 rule, server/control-home.ts), and a fleet
// scope's own root (server/fleet.ts). Both are listed a ledger at a time, the
// ledgers with asks that wait on you first, open, and the rest folded; the
// answered asks of a ledger stay folded under it.
//
// AskNotices is the same where the rest of Maestro shows what needs you: the
// asks that wait on you (blocking, or recommending what cannot be undone),
// which the header count counts.

import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { attentionWork } from "../shared/contracts";
import {
  ANSWER_NOTE_CHARS,
  type AnswerWhere,
  answerAsk,
  type DecisionAsk,
  getWorkspaceAsks,
  homeKey,
  type WorkspaceAsksView,
} from "../shared/fleet";
import {
  askNoticeText,
  BATCHED_TEXT,
  type DecisionGroup,
  groupDecisions,
  groupMeta,
  homeText,
} from "./decisions-model";
import { decisionAnswered, decisionMeta } from "./fleet-model";
import { errorText } from "./format";
import { useRefresh } from "./hooks";
import { Button, Card, Notice, radius, Section, space, useText } from "./ui";

/** Ledgers change when someone answers or an arc commits: a read every 30 s is plenty. */
const POLL_MS = 30_000;
/** Up to this many open asks in all, every ledger opens; past it, only those with an ask that waits on you. */
const ALL_OPEN_UP_TO = 10;

type Navigation = PluginSurfaceProps["navigation"];

/** Whether two reads name the same ask at the same home. */
export function sameAsk(a: DecisionAsk, b: DecisionAsk): boolean {
  return a.ledger === b.ledger && a.id === b.id && a.uid === b.uid && homeKey(a.home) === homeKey(b.home);
}

/**
 * A decision ask, with everything a person needs to decide it: what waiting
 * costs, why it is theirs, each option and what it does, and what happens if
 * they say nothing. Choose an option (or write an answer), then Answer: it is
 * written into the ledger at the ask's home, under its lock.
 */
export function DecisionCard({
  theme,
  ask,
  where,
  compact,
  navigation,
  onAnswered,
}: {
  theme: PluginTheme;
  ask: DecisionAsk;
  /** Where the answer goes, as the ask was read. */
  where: AnswerWhere;
  compact: boolean;
  navigation: Navigation;
  /** Puts the answered ask into the reads held, so the card says so at once. */
  onAnswered: (answered: DecisionAsk) => void;
}) {
  const text = useText(theme);
  const toast = useToast();
  const refresh = useRefresh();
  const send = useRpc(answerAsk);
  const answer = useMutation({
    mutationFn: send,
    onSuccess: ({ ask: answered }) => onAnswered(answered),
    onSettled: () => {
      void refresh();
    },
  });
  const [chosen, setChosen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const open = ask.state === "open";
  const option = ask.options.find((entry) => entry.id === chosen) ?? null;
  const title = ask.headline ?? ask.question ?? ask.id;
  const origin = ask.origin;
  const submit = () =>
    answer.mutate(
      { where, ledger: ask.ledger, uid: ask.uid, id: ask.id, hash: ask.hash, option: chosen, note },
      {
        onSuccess: ({ warning }) => {
          setChosen(null);
          setNote("");
          if (warning) toast.error(warning);
        },
        onError: (error) => toast.error(errorText(error)),
      },
    );
  return (
    <Card theme={theme} style={{ gap: space[2] }}>
      <Text style={[text.body, { fontWeight: "600" }]}>{title}</Text>
      <Text style={text.small}>{decisionMeta(ask)}</Text>
      {open && ask.waiting ? (
        <Text style={[text.small, { color: theme.colors.statusWarning, fontWeight: "600" }]}>
          {ask.blocking
            ? "Waits on you: it blocks until you answer."
            : "Waits on you: what it recommends cannot be undone."}
        </Text>
      ) : null}
      {ask.headline && ask.question ? <Text style={text.muted}>{ask.question}</Text> : null}
      {ask.stakes ? (
        <Text style={text.small}>
          <Text style={{ fontWeight: "600", color: theme.colors.foreground }}>What waiting costs: </Text>
          {ask.stakes}
        </Text>
      ) : null}
      {ask.whyYou ? (
        <Text style={text.small}>
          <Text style={{ fontWeight: "600", color: theme.colors.foreground }}>Why you: </Text>
          {ask.whyYou}
        </Text>
      ) : null}
      {ask.options.length > 0 ? (
        <View accessibilityRole="radiogroup" accessibilityLabel={`Options for ${ask.id}`} style={{ gap: space[2] }}>
          {ask.options.map((entry) => {
            const picked = open ? chosen === entry.id : ask.answerOption === entry.id;
            const badges = [
              entry.recommended ? "Recommended" : null,
              entry.reversible === false ? "Cannot be undone" : null,
              !open && picked ? "Your answer" : null,
            ].filter(Boolean);
            return (
              <Pressable
                key={entry.id}
                accessibilityRole="radio"
                accessibilityState={{ checked: picked, disabled: !open || answer.isPending }}
                aria-checked={picked}
                accessibilityLabel={`${entry.label}${entry.recommended ? ", recommended" : ""}`}
                disabled={!open || answer.isPending}
                onPress={() => setChosen((current) => (current === entry.id ? null : entry.id))}
                style={({ pressed }) => ({
                  gap: 2,
                  padding: space[3],
                  borderRadius: radius.control,
                  borderWidth: picked ? 2 : 1,
                  borderColor: picked ? theme.colors.accent : theme.colors.border,
                  opacity: pressed ? 0.85 : 1,
                })}
              >
                <View style={{ flexDirection: "row", alignItems: "baseline", gap: space[2], flexWrap: "wrap" }}>
                  <Text style={[text.body, { flex: 1, minWidth: 140, fontWeight: picked ? "600" : "400" }]}>
                    {entry.label}
                  </Text>
                  {badges.length > 0 ? (
                    <Text
                      style={[
                        text.small,
                        { color: entry.reversible === false ? theme.colors.statusWarning : theme.colors.accent },
                      ]}
                    >
                      {badges.join(" · ")}
                    </Text>
                  ) : null}
                </View>
                {entry.consequence ? <Text style={text.small}>{entry.consequence}</Text> : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {ask.fallback ? (
        <Text style={text.small}>
          <Text style={{ fontWeight: "600", color: theme.colors.foreground }}>If you say nothing: </Text>
          {ask.fallback}
        </Text>
      ) : null}
      {!open ? (
        <View style={{ gap: 2 }}>
          <Text style={[text.small, { color: theme.colors.statusSuccess }]}>{decisionAnswered(ask)}</Text>
          {ask.answer ? (
            <Text style={text.small} selectable>
              {ask.answer}
            </Text>
          ) : null}
          {ask.batched ? <Text style={text.small}>{BATCHED_TEXT}</Text> : null}
        </View>
      ) : ask.refusal ? (
        <Notice theme={theme} tone="warn">
          {ask.refusal}
        </Notice>
      ) : (
        <View style={{ gap: space[2] }}>
          <TextInput
            value={note}
            onChangeText={setNote}
            multiline
            maxLength={ANSWER_NOTE_CHARS}
            placeholder={ask.options.length > 0 ? "Add words (optional)" : "Your answer"}
            placeholderTextColor={theme.colors.foregroundMuted}
            accessibilityLabel={`Your words for ${ask.id}`}
            style={{
              minHeight: 48,
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
          <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap", alignItems: "center" }}>
            <Button
              theme={theme}
              variant="primary"
              icon="Check"
              label={option ? `Answer: ${option.label}` : "Answer"}
              compact={compact}
              busy={answer.isPending}
              disabled={!option && note.trim().length === 0}
              accessibilityLabel={`Answer ${ask.id}${option ? `: ${option.label}` : ""}`}
              onPress={submit}
            />
            <Text style={[text.small, { flex: 1, minWidth: 160 }]}>{homeText(ask)}</Text>
          </View>
        </View>
      )}
      {origin && navigation ? (
        <View style={{ flexDirection: "row" }}>
          <Button
            theme={theme}
            variant="quiet"
            icon="ArrowUpRight"
            label="Open the session that asked"
            compact={compact}
            accessibilityLabel={`Open the session that asked ${ask.id}`}
            onPress={() => navigation.openAgent({ agentId: origin.agentId })}
          />
        </View>
      ) : null}
    </Card>
  );
}

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
  const keyOf = (ask: DecisionAsk) => `${homeKey(ask.home)}:${ask.uid ?? ask.id}`;
  const answered = (ask: DecisionAsk) => {
    setAnsweredHere((now) => new Set([...now, keyOf(ask)]));
    // Its last open ask answered, a ledger would fold under you: it stays as you had it, open.
    setChosen((now) => now ?? true);
    onAnswered(ask);
  };
  const stay = group.answered.filter((ask) => answeredHere.has(keyOf(ask)));
  const folded = group.answered.filter((ask) => !answeredHere.has(keyOf(ask)));
  const card = (ask: DecisionAsk) => (
    <DecisionCard
      key={keyOf(ask)}
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

/** Asks a ledger at a time: ledgers with an ask that waits on you first and open, the rest folded once there are many. */
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

const workspaceWhere = (ask: DecisionAsk): AnswerWhere => ({ kind: "workspace", home: homeKey(ask.home) });

/** The workspace's own asks, in the Fleet view: every ledger of the control repo, each ask at its home. */
export function WorkspaceDecisions({
  theme,
  compact,
  navigation,
}: {
  theme: PluginTheme;
  compact: boolean;
  navigation: Navigation;
}) {
  const text = useText(theme);
  const client = useQueryClient();
  const read = useWorkspaceAsks();
  const onAnswered = (answered: DecisionAsk) =>
    client.setQueriesData<WorkspaceAsksView>({ queryKey: ["maestro", "workspace-asks"] }, (view) =>
      view ? { ...view, decisions: view.decisions.map((ask) => (sameAsk(ask, answered) ? answered : ask)) } : view,
    );
  if (read.isPending) return <ActivityIndicator color={theme.colors.foregroundMuted} />;
  if (read.isError) {
    return (
      <Notice theme={theme} tone="warn">
        {`Your workspace's asks could not be read: ${errorText(read.error)}`}
      </Notice>
    );
  }
  const { controlRepo, decisions, warnings } = read.data;
  if (decisions.length === 0 && warnings.length === 0) return null;
  const open = decisions.filter((ask) => ask.state === "open");
  const waiting = open.filter((ask) => ask.waiting).length;
  return (
    <Section
      theme={theme}
      title="Decisions"
      meta={[`${open.length} open`, waiting > 0 ? `${waiting} ${waiting === 1 ? "waits" : "wait"} on you` : null]
        .filter(Boolean)
        .join(" · ")}
    >
      <Text style={text.small}>
        {`Your workspace's asks, from every ledger in ${controlRepo}. Each is read where it lives: closed once origin/main records an answer, else at the one checkout whose copy has not landed, else on origin/main. Your answer is written there, under Maestro's ledger lock (§5.5); agent edits, ask_ledger.py and the Asks plugin do not take it yet.`}
      </Text>
      {warnings.slice(0, 3).map((warning) => (
        <Notice key={warning} theme={theme} tone="warn">
          {warning}
        </Notice>
      ))}
      <DecisionGroups
        theme={theme}
        asks={decisions}
        where={workspaceWhere}
        compact={compact}
        navigation={navigation}
        onAnswered={onAnswered}
      />
    </Section>
  );
}

/**
 * The decision asks that wait on you, where Maestro shows what needs you, from
 * work.attention: exactly what the header count counts for them. Open
 * Decisions goes to the Fleet view, where they are answered.
 */
export function AskNotices({
  theme,
  compact,
  onOpen,
}: {
  theme: PluginTheme;
  compact: boolean;
  onOpen: (scope: string | null) => void;
}) {
  const read = useRpc(attentionWork);
  const attention = useQuery({
    queryKey: ["maestro", "attention"],
    queryFn: () => read({}),
    refetchInterval: POLL_MS,
  });
  const asks = attention.data?.asks ?? [];
  const [first] = asks;
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
          onPress={() => onOpen(first.scope)}
        />
      }
    >
      {askNoticeText(asks)}
    </Notice>
  );
}
