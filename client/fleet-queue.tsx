// Needs you, in the cockpit: one card per thing that waits on you, each with
// at least one verb. A tick that is missed or failing, the fleet's alerts and
// asks, the scope's own decision asks (answered in place, client/decisions.tsx),
// and the dry run's proposals still waiting on your verdict. The first card's
// lead verb is filled (for a proposal, Agree); no other is. An ask the fleet
// has not raised as Maestro work yet says when it will be, and can still be
// acted on: copy its question, or the command that resumes its session.

import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Text, View } from "react-native";
import {
  type DecisionAsk,
  type FleetAsk,
  type FleetHealth,
  type FleetItem,
  type FleetProposal,
  type FleetView as FleetRead,
  groupProposals,
  type ProposalGroup,
  REVIEW_NOTE_CHARS,
  type ReviewVerdict,
  reviewProposal,
} from "../shared/fleet";
import { PLAIN_VOICE } from "../shared/states";
import { DecisionCard as AskCardOfDecisions, DecisionGroups, sameAsk } from "./decisions";
import {
  agreeText,
  askLines,
  askTag,
  askWhen,
  cutWords,
  displayName,
  plainEvidence,
  proposalTitle,
  type QueueCard,
  REPORT_MEANS,
  type RosterRow,
  resumeCommand,
  verdictNote,
} from "./fleet-cockpit-model";
import { groupSubject, keysFor, proposalSubject } from "./fleet-model";
import { TickDetail, type TickSheetState } from "./fleet-ticks";
import { copy, isDark, Pill, ramp, type Tone, tint, Verb } from "./fleet-ui";
import { errorText, plural } from "./format";
import { timeText } from "./history-model";
import { useRefresh } from "./hooks";
import { titleText } from "./records-text";
import { radius, space, Unbroken } from "./ui";

type Navigation = PluginSurfaceProps["navigation"];

/** What a card needs to know about its scope beyond the card: when the next tick is, an ask's age, a session's folder. */
export interface ScopeContext {
  next: (scope: string) => number | null;
  age: (scope: string, ask: FleetAsk) => string | null;
  /** The roster row an ask is about, linked by its id or a unique prefix of it (linkSession); null when none or ambiguous. */
  link: (ask: FleetAsk) => RosterRow | null;
  dryRun: (scope: string) => boolean | null;
  lastTick: (scope: string) => number | null;
}

/**
 * Puts verdicts the host has just recorded into every Fleet read held, so the
 * card says so at once: no second tap on a button that still reads Agree, and
 * nothing moves under the finger while the refetch is on its way.
 */
export function useApplyReviews() {
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

/** Your verdict on proposals, recorded through fleet.review and said at once from the host's answer. */
export function useVerdict() {
  const toast = useToast();
  const refresh = useRefresh();
  const apply = useApplyReviews();
  const send = useRpc(reviewProposal);
  const review = useMutation({
    mutationFn: send,
    onSuccess: ({ proposals }, sent) => apply(sent.scope, proposals),
    onSettled: () => {
      void refresh();
    },
  });
  return {
    pending: review.isPending,
    decide: (scope: string, keys: string[], verdict: ReviewVerdict, note: string, done?: () => void) => {
      if (keys.length === 0) return;
      review.mutate(
        { scope, keys, verdict, note },
        { onSuccess: () => done?.(), onError: (error) => toast.error(errorText(error)) },
      );
    },
  };
}

/** An answer the host has just written, put into every Fleet read held, so the card says so at once. */
export function useApplyAnswer() {
  const client = useQueryClient();
  return (scopeId: string, answered: DecisionAsk) =>
    client.setQueriesData<FleetRead>({ queryKey: ["maestro", "fleet"] }, (view) => {
      if (!view?.detail || view.detail.id !== scopeId) return view;
      const decisions = view.detail.decisions.map((ask) => (sameAsk(ask, answered) ? answered : ask));
      return { ...view, detail: { ...view.detail, decisions } };
    });
}

/** Copies text, and says so (or why not) in a toast. */
function useCopy() {
  const toast = useToast();
  return (text: string, what: string) => {
    copy(text)
      .then((done) => (done ? toast.show(`Copied ${what}`) : toast.error("Copying is not available here.")))
      .catch((error) => toast.error(errorText(error)));
  };
}

/** The note a disagreement carries: as long as the review file takes. */
export function NoteInput({
  theme,
  value,
  onChange,
  label,
}: {
  theme: PluginTheme;
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      multiline
      maxLength={REVIEW_NOTE_CHARS}
      placeholder="Why not? (optional)"
      placeholderTextColor={theme.colors.foregroundMuted}
      accessibilityLabel={label}
      style={{
        minHeight: 56,
        padding: space[3],
        borderRadius: radius.control,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
        color: theme.colors.foreground,
        fontSize: 13,
        textAlignVertical: "top",
      }}
    />
  );
}

/** The frame every queue card shares: its tag, its scope and age, a title, a line, verbs and a hint. */
function QueueFrame({
  theme,
  lead,
  tag,
  tone,
  outline = false,
  tagIcon,
  scope,
  meta,
  title,
  body,
  bodyLines = 2,
  verbs,
  hint,
  children,
}: {
  theme: PluginTheme;
  lead: boolean;
  tag: string;
  tone: Tone;
  /** The tag's neutral treatment (dry run is not a status). */
  outline?: boolean;
  tagIcon?: string;
  scope: string | null;
  meta?: string | null;
  title: string;
  body?: string | null;
  /** How many lines the body shows; 0: all of it. */
  bodyLines?: number;
  verbs?: ReactNode;
  hint?: string | null;
  children?: ReactNode;
}) {
  const t = ramp(theme);
  return (
    <View
      style={{
        padding: space[4],
        gap: space[2],
        borderRadius: radius.card,
        borderWidth: lead ? 1.5 : 1,
        borderColor: lead ? tint(theme.colors.foreground, isDark(theme) ? 0.28 : 0.35) : theme.colors.border,
        backgroundColor: lead ? theme.colors.surface2 : theme.colors.surface1,
        boxShadow: lead
          ? isDark(theme)
            ? "0 6px 18px rgba(0, 0, 0, 0.35)"
            : "0 4px 14px rgba(15, 23, 42, 0.12)"
          : undefined,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}>
        <Pill theme={theme} tone={tone} label={tag} icon={tagIcon} outline={outline} />
        {scope ? <Text style={[t.meta, { fontWeight: "600", color: theme.colors.foreground }]}>{scope}</Text> : null}
        {meta ? (
          <Text style={[t.meta, t.tabular]} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
      <Text style={t.cardTitle}>
        <Unbroken>{title}</Unbroken>
      </Text>
      {body ? (
        <Text style={t.muted} numberOfLines={bodyLines || undefined}>
          {body}
        </Text>
      ) : null}
      {verbs ? (
        <View
          style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap", paddingTop: space[1] }}
        >
          {verbs}
          {hint ? (
            <Text style={[t.meta, { flex: 1, textAlign: "right", minWidth: 120 }]} numberOfLines={1}>
              {hint}
            </Text>
          ) : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}

/**
 * A fleet ask. Its verbs, the first available leading: open the session in
 * Paseo, answer the work the fleet raised, copy the command that resumes the
 * session, or copy the question. One of them is always there.
 */
function AskCard({
  theme,
  scope,
  ask,
  more = [],
  lead,
  phone,
  context,
  navigation,
  onSelect,
}: {
  theme: PluginTheme;
  scope: string;
  ask: FleetAsk;
  /** The other asks the same raised item carries: one card, one count. */
  more?: readonly FleetAsk[];
  lead: boolean;
  phone: boolean;
  context: ScopeContext;
  navigation: Navigation;
  onSelect: (id: string) => void;
}) {
  const t = ramp(theme);
  const copyOut = useCopy();
  const [open, setOpen] = useState(false);
  const item = ask.item;
  const session = ask.session;
  // The key's id is often a short prefix: the roster row it links to gives the full id, its agent and folder.
  const row = context.link(ask);
  const agentId = row?.agentId ?? session?.agentId ?? null;
  const who = row ? displayName(row.name ?? row.short) : (session?.name ?? session?.short ?? null);
  const lines = askLines(ask.question);
  const resume = row ? resumeCommand(row.id, row.cwd) : null;
  const verbs: { key: string; label: string; icon: string; a11y: string; run: () => void }[] = [];
  // The honest next step for an ask is the session it is about: opened in Paseo, else resumed where it ran.
  if (agentId && navigation) {
    verbs.push({
      key: "open",
      label: who ? `Open ${cutWords(who, 24)}` : "Open session",
      icon: "ArrowUpRight",
      a11y: `Open the session ask ${ask.id} is about: ${who ?? session?.short}`,
      run: () => navigation.openAgent({ agentId }),
    });
  } else if (resume) {
    verbs.push({
      key: "resume",
      label: "Copy resume command",
      icon: "SquareTerminal",
      a11y: `Copy the command that resumes ${who ?? session?.short}`,
      run: () => copyOut(resume, "the resume command"),
    });
  }
  if (item) {
    verbs.push({
      key: "item",
      label: item.needsYou ? "Answer" : "Open work",
      icon: "MessageSquare",
      a11y: `Open the fleet's work for ask ${ask.id}: ${titleText(item)}`,
      run: () => onSelect(item.id),
    });
  }
  verbs.push({
    key: "question",
    label: "Copy question",
    icon: "Copy",
    a11y: `Copy the question of ask ${ask.id}`,
    run: () => copyOut(ask.question, "the question"),
  });
  const age = context.age(scope, ask);
  return (
    <QueueFrame
      theme={theme}
      lead={lead}
      tag={askTag(ask)}
      tone="warn"
      tagIcon={ask.class === "7" ? "Hand" : "MessageCircleQuestion"}
      scope={scope}
      meta={[who ? `about ${cutWords(who, 40)}` : null, age ? (age === "now" ? "just now" : `${age} ago`) : null]
        .filter(Boolean)
        .join(" · ")}
      title={lines.title}
      body={lines.body && !open ? cutWords(lines.body, phone ? 90 : 180) : lines.body}
      bodyLines={0}
      hint={!phone && agentId ? `Opens ${session?.short ?? ""} in Paseo` : null}
      verbs={
        <>
          {verbs.slice(0, phone ? 2 : 3).map((verb, index) => (
            <Verb
              key={verb.key}
              theme={theme}
              weight={index === 0 && lead ? "primary" : "secondary"}
              icon={verb.icon}
              label={verb.label}
              phone={phone}
              accessibilityLabel={verb.a11y}
              onPress={verb.run}
            />
          ))}
          <Verb
            theme={theme}
            weight="quiet"
            icon={open ? "ChevronUp" : "ChevronDown"}
            label={open ? "Less" : "Details"}
            phone={phone}
            accessibilityLabel={`${open ? "Hide" : "Show"} the details of ask ${ask.id}`}
            onPress={() => setOpen((shown) => !shown)}
          />
        </>
      }
    >
      {more.length > 0 ? (
        <View style={{ gap: 2 }}>
          <Text style={t.meta}>{`and ${plural(more.length, "more ask")} in the same work:`}</Text>
          {more.map((other) => (
            <Text key={other.key} style={t.body}>
              {`· ${askLines(other.question).title}`}
            </Text>
          ))}
        </View>
      ) : null}
      <Text style={[t.meta, { color: item?.needsYou ? theme.colors.statusWarning : theme.colors.foregroundMuted }]}>
        {askWhen(ask, context.next(scope))}
      </Text>
      {open ? (
        <View style={{ gap: space[1], paddingTop: space[1] }}>
          {phone && verbs.length > 2 ? (
            <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap" }}>
              {verbs.slice(2).map((verb) => (
                <Verb
                  key={verb.key}
                  theme={theme}
                  icon={verb.icon}
                  label={verb.label}
                  phone
                  accessibilityLabel={verb.a11y}
                  onPress={verb.run}
                />
              ))}
            </View>
          ) : null}
          <Text style={[t.meta, t.tabular]} selectable>
            {[
              ask.class ? `class ${ask.class}${ask.className ? ` (${ask.className})` : ""}` : null,
              ask.firstTick !== null ? `since tick ${ask.firstTick}` : null,
              `key ${ask.key}`,
              ask.batch ? `batch ${ask.batch}` : null,
              session ? `session ${session.id}${agentId ? "" : " (not a Paseo session)"}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
          {ask.firstTick !== null ? (
            <>
              <Text style={t.label}>{`Raised at tick ${ask.firstTick}`}</Text>
              <TickDetail theme={theme} scope={scope} tick={ask.firstTick} facts={null} compact={phone} />
            </>
          ) : null}
        </View>
      ) : null}
    </QueueFrame>
  );
}

function HealthCard({
  theme,
  scope,
  health,
  lastTick,
  lead,
  phone,
  onOpenTick,
  onSelect,
}: {
  theme: PluginTheme;
  scope: string;
  health: FleetHealth;
  lastTick: number | null;
  lead: boolean;
  phone: boolean;
  onOpenTick: (sheet: TickSheetState) => void;
  onSelect: (id: string) => void;
}) {
  const copyOut = useCopy();
  const missed = health.status === "missed";
  const item = health.item;
  const verbs: { key: string; label: string; icon: string; a11y: string; run: () => void }[] = [];
  if (lastTick !== null) {
    verbs.push({
      key: "log",
      label: "Open log",
      icon: "SquareTerminal",
      a11y: `Open tick ${lastTick}'s log, ${scope}`,
      run: () => onOpenTick({ scope, tick: lastTick, first: "log" }),
    });
  }
  if (item) {
    verbs.push({
      key: "alert",
      label: "Open alert",
      icon: "ArrowUpRight",
      a11y: `Open ${titleText(item)}`,
      run: () => onSelect(item.id),
    });
  }
  if (verbs.length === 0) {
    verbs.push({
      key: "copy",
      label: "Copy reason",
      icon: "Copy",
      a11y: `Copy why ${scope} needs you`,
      run: () => copyOut(health.reason, "the reason"),
    });
  }
  return (
    <QueueFrame
      theme={theme}
      lead={lead}
      tag={missed ? "Tick missed" : "Tick failing"}
      tone="danger"
      tagIcon={missed ? "Clock" : "CircleX"}
      scope={scope}
      title={missed ? `${scope} missed its tick` : `${scope} is failing`}
      body={health.reason}
      verbs={verbs.map((verb, index) => (
        <Verb
          key={verb.key}
          theme={theme}
          weight={index === 0 && lead ? "primary" : "secondary"}
          icon={verb.icon}
          label={verb.label}
          phone={phone}
          accessibilityLabel={verb.a11y}
          onPress={verb.run}
        />
      ))}
    />
  );
}

function AlertCard({
  theme,
  scope,
  item,
  lead,
  phone,
  onSelect,
}: {
  theme: PluginTheme;
  scope: string;
  item: FleetItem;
  lead: boolean;
  phone: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <QueueFrame
      theme={theme}
      lead={lead}
      tag="Fleet alert"
      tone="danger"
      tagIcon="TriangleAlert"
      scope={scope}
      meta={item.needsYou ? "In Needs you" : PLAIN_VOICE[item.state].label}
      title={titleText(item)}
      verbs={
        <Verb
          theme={theme}
          weight={lead ? "primary" : "secondary"}
          icon="ArrowUpRight"
          label="Open"
          phone={phone}
          accessibilityLabel={`Open ${titleText(item)}`}
          onPress={() => onSelect(item.id)}
        />
      }
    />
  );
}

/**
 * A proposal group: what the fleet would do, to whom (every session it
 * covers, by name), and your verdict. Agree and Disagree are secondary unless
 * the card leads the queue: under dry run a verdict teaches the fleet and
 * changes nothing now.
 */
export function ProposalCard({
  theme,
  scope,
  group,
  dryRun,
  lead = false,
  phone,
  navigation,
}: {
  theme: PluginTheme;
  scope: string;
  group: ProposalGroup;
  dryRun: boolean | null;
  lead?: boolean;
  phone: boolean;
  navigation: Navigation;
}) {
  const t = ramp(theme);
  // The card says it from the host's answer at once; the refetch after is not waited on.
  const review = useVerdict();
  const [disagreeing, setDisagreeing] = useState(false);
  const [note, setNote] = useState("");
  const [all, setAll] = useState(false);
  const subject = groupSubject(group);
  const many = group.proposals.length > 1;
  const decide = (choice: ReviewVerdict, words = "") =>
    review.decide(scope, keysFor(group, choice), choice, words, () => {
      setDisagreeing(false);
      setNote("");
    });
  const [first] = group.proposals;
  const sessions = group.proposals.filter((proposal) => proposal.session);
  const verdict = group.review?.verdict ?? null;
  const label = `${group.action}, ${subject}`;
  const names = sessions.map((proposal) => displayName(proposal.session?.name ?? proposal.session?.short ?? ""));
  const agentId = !many ? (first?.session?.agentId ?? null) : null;
  const evidence = first?.evidence ? cutWords(plainEvidence(first.evidence) ?? "", 140) : null;
  return (
    <QueueFrame
      theme={theme}
      lead={lead}
      tag={dryRun === false ? "Fleet proposal" : "Fleet proposal · dry run"}
      tone="muted"
      outline
      tagIcon="FlaskConical"
      scope={scope}
      meta={group.className && !/^\d/.test(group.className) ? group.className : null}
      title={proposalTitle(group)}
      body={evidence}
      bodyLines={0}
    >
      {many ? (
        <Text style={t.body} accessibilityLabel={`Covers ${plural(names.length, "session")}: ${names.join(", ")}`}>
          {names.join(" · ")}
        </Text>
      ) : null}
      <Text style={[t.meta, { color: verdict ? theme.colors.foreground : theme.colors.foregroundMuted }]}>
        {verdict ? agreeText(group.review) : verdictNote(dryRun)}
      </Text>
      {disagreeing ? (
        <View style={{ gap: space[2] }}>
          <NoteInput theme={theme} value={note} onChange={setNote} label={`Why disagree: ${label}`} />
          <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap" }}>
            <Verb
              theme={theme}
              icon="ThumbsDown"
              label={many ? `Disagree with all ${group.proposals.length}` : "Disagree"}
              phone={phone}
              grow={phone}
              busy={review.pending}
              accessibilityLabel={`Confirm disagree: ${label}`}
              onPress={() => decide("reject", note)}
            />
            <Verb
              theme={theme}
              weight="quiet"
              label="Keep it"
              phone={phone}
              disabled={review.pending}
              onPress={() => setDisagreeing(false)}
            />
          </View>
        </View>
      ) : (
        <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap", alignItems: "center" }}>
          <Verb
            theme={theme}
            weight={lead && verdict !== "accept" ? "primary" : "secondary"}
            icon={verdict === "accept" ? "Check" : "ThumbsUp"}
            label={
              verdict === "accept"
                ? "Agreed"
                : many
                  ? phone
                    ? `Agree (${group.proposals.length})`
                    : `Agree with all ${group.proposals.length}`
                  : "Agree"
            }
            phone={phone}
            grow={phone}
            busy={review.pending && !disagreeing}
            disabled={verdict === "accept"}
            accessibilityLabel={`Agree: ${label}`}
            onPress={() => decide("accept")}
          />
          <Verb
            theme={theme}
            weight={phone ? "secondary" : "quiet"}
            icon="ThumbsDown"
            label={verdict === "reject" ? "Disagreed" : "Disagree…"}
            phone={phone}
            grow={phone}
            disabled={verdict === "reject" || review.pending}
            accessibilityLabel={`Disagree: ${label}`}
            onPress={() => setDisagreeing(true)}
          />
          {many ? (
            // On the phone it takes a row of its own, so Agree and Disagree keep their words.
            <View style={phone ? { flexBasis: "100%", flexDirection: "row" } : undefined}>
              <Verb
                theme={theme}
                weight="quiet"
                icon={all ? "ChevronUp" : "ChevronDown"}
                label={all ? "Hide sessions" : "See sessions"}
                phone={phone}
                accessibilityLabel={`${all ? "Hide" : "See"} the sessions: ${group.action}`}
                onPress={() => setAll((open) => !open)}
              />
            </View>
          ) : null}
          {agentId && navigation ? (
            <Verb
              theme={theme}
              weight="quiet"
              icon="ArrowUpRight"
              label="Open in Paseo"
              phone={phone}
              accessibilityLabel={`Open session ${first ? proposalSubject(first) : ""} in Paseo`}
              onPress={() => navigation.openAgent({ agentId })}
            />
          ) : null}
        </View>
      )}
      {many && all ? (
        <View style={{ gap: space[2], paddingTop: space[1] }}>
          {sessions.map((proposal) => (
            <View key={proposal.key} style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
              <View style={{ flex: 1, gap: 1 }}>
                <Text style={[t.body, { fontWeight: "600" }]}>
                  {displayName(proposal.session?.name ?? proposalSubject(proposal))}
                </Text>
                <Text style={[t.mono, { color: theme.colors.foregroundMuted }]}>
                  {[proposal.session?.short, proposal.session?.status, proposal.session?.cwd]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
              </View>
              {proposal.session?.agentId && navigation ? (
                <Verb
                  theme={theme}
                  weight="quiet"
                  icon="ArrowUpRight"
                  label="Open"
                  phone={phone}
                  accessibilityLabel={`Open session ${proposalSubject(proposal)} in Paseo`}
                  onPress={() => navigation.openAgent({ agentId: proposal.session?.agentId ?? "" })}
                />
              ) : (
                <Text style={t.meta}>Not a Paseo session</Text>
              )}
            </View>
          ))}
        </View>
      ) : null}
    </QueueFrame>
  );
}

/**
 * The scope's own decision asks, folded to a line per open ask until *Read
 * and answer* opens them, answered in place. A scope whose asks are all
 * answered keeps them here, at the end of the queue, so an answer stays
 * findable.
 */
function DecisionsCard({
  theme,
  scope,
  asks,
  open,
  lead,
  phone,
  navigation,
}: {
  theme: PluginTheme;
  scope: string;
  asks: DecisionAsk[];
  open: number;
  lead: boolean;
  phone: boolean;
  navigation: Navigation;
}) {
  const applyAnswer = useApplyAnswer();
  const t = ramp(theme);
  // Folded to one line per ask: a decision's full context is long, and it would push the sessions off the page.
  const [shown, setShown] = useState(false);
  const pending = asks.filter((ask) => ask.state === "open");
  const answered = asks.length - pending.length;
  return (
    <QueueFrame
      theme={theme}
      lead={lead}
      tag={open > 0 ? "Decision" : "Recently answered"}
      tone={open > 0 ? "warn" : "success"}
      tagIcon="GitFork"
      scope={scope}
      meta={
        open > 0
          ? `${plural(open, "open ask")} · none waits on you${answered > 0 ? ` · ${answered} answered` : ""}`
          : `${plural(answered, "answer")}: the fleet reads them at its next tick`
      }
      title={open > 0 ? `Other decisions · ${scope}` : `Answered decisions · ${scope}`}
    >
      {shown ? null : (
        <View style={{ gap: space[1] }}>
          {pending.slice(0, 4).map((ask) => (
            <View
              key={`${ask.ledger}:${ask.id}`}
              style={{ flexDirection: "row", gap: space[2], alignItems: "flex-start" }}
            >
              <Text
                style={[t.meta, { color: ask.waiting ? theme.colors.statusWarning : theme.colors.foregroundMuted }]}
              >
                {ask.waiting ? "Waits" : "Open"}
              </Text>
              <Text style={[t.body, { flex: 1 }]}>
                {cutWords(ask.headline ?? ask.question ?? ask.id, phone ? 44 : 96)}
              </Text>
            </View>
          ))}
          {pending.length > 4 ? <Text style={t.meta}>{`and ${pending.length - 4} more`}</Text> : null}
        </View>
      )}
      <View style={{ flexDirection: "row" }}>
        <Verb
          theme={theme}
          weight={shown ? "quiet" : lead ? "primary" : "secondary"}
          icon={shown ? "ChevronUp" : "MessageSquare"}
          label={shown ? "Fold them" : open > 0 ? "Read and answer" : "Show the answers"}
          phone={phone}
          accessibilityLabel={`${shown ? "Fold" : open > 0 ? "Read and answer" : "Show the answers to"} the fleet's decisions, ${scope}`}
          onPress={() => setShown((now) => !now)}
        />
      </View>
      {shown ? (
        <DecisionGroups
          theme={theme}
          asks={asks}
          where={() => ({ kind: "fleet", scope })}
          compact={phone}
          navigation={navigation}
          onAnswered={(answered) => applyAnswer(scope, answered)}
        />
      ) : null}
    </QueueFrame>
  );
}

/** One decision ask that waits on you (`waiting`), answered in place: one card, one count. */
function WaitingDecisionCard({
  theme,
  scope,
  ask,
  lead,
  phone,
  navigation,
}: {
  theme: PluginTheme;
  scope: string;
  ask: DecisionAsk;
  lead: boolean;
  phone: boolean;
  navigation: Navigation;
}) {
  const applyAnswer = useApplyAnswer();
  const t = ramp(theme);
  const [shown, setShown] = useState(false);
  const headline = ask.headline ?? ask.question ?? ask.id;
  return (
    <QueueFrame
      theme={theme}
      lead={lead}
      tag={ask.blocking ? "Decision · blocks" : "Decision · waits on you"}
      tone="warn"
      tagIcon="GitFork"
      scope={scope}
      meta={ask.arc ?? ask.ledger}
      title={cutWords(headline, 140)}
    >
      {shown ? null : (
        <Text style={t.muted}>
          {ask.stakes ? cutWords(ask.stakes, 160) : "Open it to see what it costs and each option."}
        </Text>
      )}
      <View style={{ flexDirection: "row" }}>
        <Verb
          theme={theme}
          weight={shown ? "quiet" : lead ? "primary" : "secondary"}
          icon={shown ? "ChevronUp" : "MessageSquare"}
          label={shown ? "Fold it" : "Read and answer"}
          phone={phone}
          accessibilityLabel={`${shown ? "Fold" : "Read and answer"} ${ask.id}, ${scope}`}
          onPress={() => setShown((now) => !now)}
        />
      </View>
      {shown ? (
        // The Decisions tab's own card (#24): its in-flight lock and drafts come with it.
        <AskCardOfDecisions
          theme={theme}
          ask={ask}
          where={{ kind: "fleet", scope }}
          compact={phone}
          navigation={navigation}
          onAnswered={(answered) => applyAnswer(scope, answered)}
        />
      ) : null}
    </QueueFrame>
  );
}

function QueueCardView({
  theme,
  card,
  lead,
  phone,
  context,
  navigation,
  onSelect,
  onOpenTick,
}: {
  theme: PluginTheme;
  card: QueueCard;
  lead: boolean;
  phone: boolean;
  context: ScopeContext;
  navigation: Navigation;
  onSelect: (id: string) => void;
  onOpenTick: (sheet: TickSheetState) => void;
}) {
  switch (card.kind) {
    case "health":
      return (
        <HealthCard
          theme={theme}
          scope={card.scope}
          health={card.health}
          lastTick={context.lastTick(card.scope)}
          lead={lead}
          phone={phone}
          onOpenTick={onOpenTick}
          onSelect={onSelect}
        />
      );
    case "alert":
      return (
        <AlertCard theme={theme} scope={card.scope} item={card.item} lead={lead} phone={phone} onSelect={onSelect} />
      );
    case "ask":
      return (
        <AskCard
          theme={theme}
          scope={card.scope}
          ask={card.ask}
          more={card.asks.slice(1)}
          lead={lead}
          phone={phone}
          context={context}
          navigation={navigation}
          onSelect={onSelect}
        />
      );
    case "decision":
      return (
        <WaitingDecisionCard
          theme={theme}
          scope={card.scope}
          ask={card.ask}
          lead={lead}
          phone={phone}
          navigation={navigation}
        />
      );
    case "decisions":
      return (
        <DecisionsCard
          theme={theme}
          scope={card.scope}
          asks={card.asks}
          open={card.open}
          lead={false}
          phone={phone}
          navigation={navigation}
        />
      );
    default:
      return (
        <ProposalCard
          theme={theme}
          scope={card.scope}
          group={card.group}
          dryRun={context.dryRun(card.scope)}
          phone={phone}
          navigation={navigation}
        />
      );
  }
}

/**
 * Needs you: one card per thing the count counts (fleetNeedsYou), the first
 * leading with the page's one filled verb; then, apart and uncounted, what
 * the fleet holds open that does not need you now.
 */
export function NeedsYouQueue({
  theme,
  cards,
  also,
  context,
  phone,
  navigation,
  onSelect,
  onOpenTick,
}: {
  theme: PluginTheme;
  cards: readonly QueueCard[];
  also: readonly QueueCard[];
  context: ScopeContext;
  phone: boolean;
  navigation: Navigation;
  onSelect: (id: string) => void;
  onOpenTick: (sheet: TickSheetState) => void;
}) {
  const t = ramp(theme);
  // Asks the fleet has not raised as work yet are said apart, with when it will.
  const notRaised = also.filter((card) => card.kind === "ask");
  const rest = also.filter((card) => card.kind !== "ask");
  const next =
    notRaised
      .map((card) => context.next(card.scope))
      .filter((at): at is number => at !== null)
      .sort((a, b) => a - b)[0] ?? null;
  const view = (card: QueueCard, lead: boolean) => (
    <QueueCardView
      key={card.key}
      theme={theme}
      card={card}
      lead={lead}
      phone={phone}
      context={context}
      navigation={navigation}
      onSelect={onSelect}
      onOpenTick={onOpenTick}
    />
  );
  return (
    <View style={{ gap: space[3] }}>
      <View style={{ gap: space[3] }} accessibilityLabel={`Needs you: ${plural(cards.length, "card")}`}>
        {cards.length === 0 ? (
          <View
            style={{
              padding: space[4],
              borderRadius: radius.card,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface1,
            }}
          >
            <Text style={t.cardTitle}>Nothing needs you</Text>
            <Text style={t.muted}>No tick, ask, alert or decision of the fleet's waits on you.</Text>
          </View>
        ) : null}
        {cards.map((card, index) => view(card, index === 0))}
      </View>
      {notRaised.length > 0 ? (
        <View style={{ gap: space[3], paddingTop: space[2] }}>
          <View style={{ gap: 2 }}>
            <Text style={t.cardTitle} accessibilityRole="header">
              Not raised to you yet
            </Text>
            <Text style={t.meta}>
              {`The fleet raises these as work at its next tick${next ? ` (~${timeText(new Date(next).toISOString())})` : ""}; until then they aren't counted.`}
            </Text>
          </View>
          {notRaised.map((card) => view(card, false))}
        </View>
      ) : null}
      {rest.length > 0 ? (
        <View style={{ gap: space[3], paddingTop: space[2] }}>
          <View style={{ gap: 2 }}>
            <Text style={[t.cardTitle, { color: theme.colors.foregroundMuted }]} accessibilityRole="header">
              Also open
            </Text>
            <Text style={t.meta}>
              Alerts the fleet holds at rest and decisions that do not wait on you. Not counted.
            </Text>
          </View>
          {rest.map((card) => view(card, false))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Teach the fleet: the dry-run proposals, below the sessions, uncounted. A
 * verdict here is never the page's filled verb: it changes nothing now.
 */
export function TeachTheFleet({
  theme,
  teach,
  reviewed,
  context,
  phone,
  navigation,
}: {
  theme: PluginTheme;
  teach: readonly Extract<QueueCard, { kind: "proposal" }>[];
  /** Groups you already gave a verdict, behind "Show reviewed". */
  reviewed: readonly { scope: string; group: ProposalGroup }[];
  context: ScopeContext;
  phone: boolean;
  navigation: Navigation;
}) {
  const t = ramp(theme);
  const [showReviewed, setShowReviewed] = useState(false);
  if (teach.length === 0 && reviewed.length === 0) return null;
  return (
    <View style={{ gap: space[3] }}>
      <View style={{ gap: 2 }}>
        <Text style={t.section} accessibilityRole="header">
          Teach the fleet
        </Text>
        <Text style={t.meta}>
          {`What the fleet would do, not done: your verdict teaches it and changes nothing now. ${REPORT_MEANS} Not counted.`}
        </Text>
      </View>
      {teach.map((card) => (
        <ProposalCard
          key={card.key}
          theme={theme}
          scope={card.scope}
          group={card.group}
          dryRun={context.dryRun(card.scope)}
          phone={phone}
          navigation={navigation}
        />
      ))}
      {reviewed.length > 0 ? (
        <View style={{ gap: space[3] }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
            <Text style={[t.meta, { flex: 1 }]}>{`${plural(reviewed.length, "proposal")} you already judged`}</Text>
            <Verb
              theme={theme}
              weight="quiet"
              icon={showReviewed ? "ChevronUp" : "ChevronDown"}
              label={showReviewed ? "Hide reviewed" : "Show reviewed"}
              phone={phone}
              onPress={() => setShowReviewed((open) => !open)}
            />
          </View>
          {showReviewed
            ? reviewed.map(({ scope, group }) => (
                <ProposalCard
                  key={`${scope}:${group.key}`}
                  theme={theme}
                  scope={scope}
                  group={group}
                  dryRun={context.dryRun(scope)}
                  phone={phone}
                  navigation={navigation}
                />
              ))
            : null}
        </View>
      ) : null}
    </View>
  );
}
