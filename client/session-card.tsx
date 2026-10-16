// The Maestro card in a Paseo session (BRO-3008, K0–K2): where you act from a push. One component for every kind
// (an approval, an ask, an owner step, finished work, stuck work, and the inbox digest), one anatomy: what it is,
// the one decision, at most two verbs, and Open in Maestro. It carries only {kind, key, version} and reads the hold
// live by key, so it is true on a phone or a desktop, after a daemon restart, and when another surface answered
// first (client/card-model.ts decides what it shows). The same card is on the session page (client/session-screen.tsx).
//
// Every verb is the adapter's (client/verbs.ts): approval.decide, ask.answer, session.prompt… through plugin RPC,
// never straight to Paseo. Each keeps its 8 s undo, here in place, and leaves a receipt that the card then shows.

import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { type ComponentType, type ReactNode, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { type CardData, type GateCardData, legacyCard } from "../shared/card";
import type { WorkItem } from "../shared/contracts";
import type { NeedRow } from "../shared/needs";
import { ArcReport } from "./arc-report";
import { CARD_POLL_MS, type CardActions, readOf, useCardLedger, useCardRunner, useCardWork } from "./card-hooks";
import { type CardState, cardLive, cardState, cardVerbs, openTarget } from "./card-model";
import {
  CARD_LOOK,
  CardFrame,
  clockOf,
  EvidenceRow,
  LogWell,
  OpenLink,
  SettledLine,
  UndoCapsule,
  Well,
} from "./card-parts";
import { useWorkspaceAsks } from "./decisions";
import { decisionAsks } from "./decisions-model";
import { needsSection } from "./feed-model";
import { ago } from "./format";
import { LookView, VERBS_MEAN, verbsNeedSaying } from "./gate-look";
import { heldByWords, holdKicker } from "./home-model";
import { useNeeds } from "./hooks";
import { wordsPlaceholder } from "./kit/inspector-model";
import { Kicker, Pill, TABULAR } from "./kit/parts";
import { kitOf } from "./kit/tokens";
import { titleText } from "./records-text";
import { DigestCard } from "./session-digest";
import { CHOICE_ROLE, focusRing } from "./ui";
import { useTick } from "./use-tick";
import { planVerb, type VerbTarget } from "./verbs";

export type { CardActions };

export interface CardProps {
  data: CardData;
  /** The session whose timeline carries the card: finished and stuck work are only current in their own session. */
  host: string | null;
  theme: PluginTheme;
  compact: boolean;
  actions: CardActions;
}

/** The renderer, bound to how this plugin opens its own screens (a timeline item gets no navigation). */
export function createSessionCard(actions: CardActions): ComponentType<PluginTimelineItemProps<CardData>> {
  function MaestroCard({ item, agentId, theme, layout }: PluginTimelineItemProps<CardData>) {
    return <SessionCard data={item.data} host={agentId} theme={theme} compact={layout.compact} actions={actions} />;
  }
  return MaestroCard;
}

/** The renderer for the card of an earlier build (`maestro-gate`): the finished card it was, read the same way. */
export function createLegacyCard(actions: CardActions): ComponentType<PluginTimelineItemProps<GateCardData>> {
  function MaestroGateCard({ item, agentId, theme, layout }: PluginTimelineItemProps<GateCardData>) {
    const data = legacyCard(item.data);
    return <SessionCard data={data} host={agentId} theme={theme} compact={layout.compact} actions={actions} />;
  }
  return MaestroGateCard;
}

/** The target a verb acts on, from the one read that showed it: the row's text and its ids come together. */
function targetOf(
  state: Extract<CardState, { phase: "open" }>,
  ask: NonNullable<VerbTarget["ask"]> | null,
): VerbTarget {
  return { row: state.row, item: state.item, ask };
}

// ── The card ─────────────────────────────────────────────────────────────────

export function SessionCard(props: CardProps) {
  const { kind } = props.data;
  if (kind === "digest") return <DigestCard {...props} />;
  if (kind === "finished" || kind === "health") return <WorkCard {...props} />;
  return <HoldCard {...props} />;
}

/** Why the card shows nothing to act on yet: reading, or a read that failed (never "nothing pending"). */
function Reading({
  theme,
  data,
  words,
  onRetry,
  open,
}: {
  theme: PluginTheme;
  data: CardData;
  words: string | null;
  onRetry: () => void;
  open: () => void;
}) {
  const kit = kitOf(theme);
  return (
    <CardFrame theme={theme} ring={false} testID={`card-${data.key}`}>
      <Kicker
        theme={theme}
        icon={CARD_LOOK[data.kind].icon}
        iconColor={kit.muted}
        parts={[CARD_LOOK[data.kind].label]}
      />
      {words === null ? (
        <ActivityIndicator color={kit.muted} />
      ) : (
        <>
          <Text testID="card-unread" style={{ color: kit.fg2, fontSize: 14, lineHeight: 20 }}>
            {words}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Pill theme={theme} label="Try again" height={40} onPress={onRetry} />
            <OpenLink theme={theme} onPress={open} />
          </View>
        </>
      )}
    </CardFrame>
  );
}

function openIn(
  actions: CardActions,
  data: CardData,
  props: { host: string | null; row: NeedRow | null; item: WorkItem | null },
) {
  const target = openTarget(data, props.host, props.row, props.item);
  return () => (target.to === "session" ? actions.session(target.agentId) : actions.hold(target.key));
}

function HoldCard({ data, host, theme, compact, actions }: CardProps) {
  const [live, setLive] = useState(true);
  const needs = useNeeds(live ? CARD_POLL_MS : false);
  const ledger = useCardLedger();
  const state = cardState({
    card: data,
    host,
    needs: readOf(needs),
    ledger: ledger.read,
    work: { status: "loading" },
  });
  useEffect(() => setLive(cardLive(state)), [state]);
  const runner = useCardRunner(actions, data.key);
  const row = state.phase === "open" ? state.row : null;
  const open = openIn(actions, data, { host, row, item: null });
  const retry = () => {
    void needs.refetch();
    ledger.retry();
  };
  return (
    <CardBody
      state={state}
      data={data}
      theme={theme}
      compact={compact}
      open={open}
      retry={retry}
      runner={runner}
      kind={data.kind}
      actions={actions}
    />
  );
}

function WorkCard({ data, host, theme, compact, actions }: CardProps) {
  const [live, setLive] = useState(true);
  const work = useCardWork(data.key, live);
  const ledger = useCardLedger();
  const state = cardState({
    card: data,
    host,
    needs: { status: "loading" },
    ledger: ledger.read,
    work: readOf<WorkItem>({ data: work.data?.item, isError: work.isError, error: work.error }),
  });
  useEffect(() => setLive(cardLive(state)), [state]);
  const runner = useCardRunner(actions, data.key);
  const item = state.phase === "open" ? state.item : null;
  const open = openIn(actions, data, { host, row: null, item: item ?? work.data?.item ?? null });
  const retry = () => {
    void work.refetch();
    ledger.retry();
  };
  return (
    <CardBody
      state={state}
      data={data}
      theme={theme}
      compact={compact}
      open={open}
      retry={retry}
      runner={runner}
      kind={data.kind}
      actions={actions}
    />
  );
}

type Runner = ReturnType<typeof useCardRunner>;

/** Draws a card's state: the pending card with its verbs, the undo capsule, or the line it settles into. */
function CardBody({
  state,
  data,
  theme,
  compact,
  open,
  retry,
  runner,
  kind,
  actions,
}: {
  state: CardState;
  data: CardData;
  theme: PluginTheme;
  compact: boolean;
  open: () => void;
  retry: () => void;
  runner: Runner;
  kind: CardData["kind"];
  actions: CardActions;
}) {
  const link = <OpenLink theme={theme} onPress={open} />;
  switch (state.phase) {
    case "loading":
      return <Reading theme={theme} data={data} words={null} onRetry={retry} open={open} />;
    case "unread":
      return <Reading theme={theme} data={data} words={state.words} onRetry={retry} open={open} />;
    case "undo":
      return (
        <UndoCapsule
          theme={theme}
          label={state.label}
          appliesAt={state.appliesAt}
          busy={runner.undoing}
          onUndo={() => void runner.undo(state.receipt)}
        />
      );
    case "receipt":
      return (
        <SettledLine
          theme={theme}
          kind={kind}
          head="receipt"
          words={state.words}
          at={clockOf(state.at)}
          tone={state.tone}
        />
      );
    case "resolved":
      return <SettledLine theme={theme} kind={kind} head="resolved elsewhere" words={state.words} tone="muted" />;
    case "superseded":
      return (
        <SettledLine
          theme={theme}
          kind={kind}
          head="superseded"
          words={state.words}
          tone="muted"
          after={<View style={{ flexDirection: "row" }}>{link}</View>}
        />
      );
    case "held":
      return (
        <SettledLine
          theme={theme}
          kind={kind}
          head="held"
          words={state.words}
          tone="muted"
          after={<View style={{ flexDirection: "row" }}>{link}</View>}
        />
      );
    case "open":
      return (
        <OpenCard
          state={state}
          data={data}
          theme={theme}
          compact={compact}
          link={link}
          runner={runner}
          actions={actions}
        />
      );
  }
}

function OpenCard({
  state,
  data,
  theme,
  compact,
  link,
  runner,
  actions,
}: {
  state: Extract<CardState, { phase: "open" }>;
  data: CardData;
  theme: PluginTheme;
  compact: boolean;
  link: ReactNode;
  runner: Runner;
  actions: CardActions;
}) {
  const kit = kitOf(theme);
  const look = CARD_LOOK[data.kind];
  const now = useTick(30_000);
  const { row, item } = state;
  const [choice, setChoice] = useState<string | undefined>(undefined);
  const [course, setCourse] = useState<string | null>(null);
  // Your note beside the option this card answers with (BRO-3146): it offers no Other row, so words are a note.
  const [note, setNote] = useState("");
  const asks = useWorkspaceAsks();
  const ask =
    row?.kind === "ask" && asks.data ? (needsSection([row], [], decisionAsks(asks.data))[0]?.ask ?? null) : null;
  const target = { ...targetOf(state, ask), notice: data.kind === "health" ? { key: data.key } : null };
  const verbs = cardVerbs(data.kind, row);
  const chosen = choice ?? (row?.kind === "ask" ? row.body.recommended : undefined);
  const run = (id: string) =>
    void runner.act(planVerb(id as never, target, chosen, id === "answer" ? note : (course ?? "")));
  const kicker = row
    ? holdKicker({ row, item: null, ask })
    : item
      ? [item.display?.fleet?.scope ?? item.project ?? "work", ...(item.ticket ? [item.ticket] : [])]
      : [];
  const since = row?.since ?? item?.updatedAt ?? null;
  return (
    <CardFrame theme={theme} ring={Boolean(row)} testID={`card-${data.key}`}>
      <Kicker
        theme={theme}
        icon={look.icon}
        iconColor={data.kind === "health" ? kit.warn : data.kind === "finished" ? kit.ok : kit.needs}
        parts={[look.label, ...kicker]}
        age={since ? ago(since, now) : undefined}
      />
      <Text accessibilityRole="header" style={{ color: kit.fg, fontSize: 17, fontWeight: "600", lineHeight: 23 }}>
        {row ? row.title : item ? titleText(item) : ""}
      </Text>
      {row?.kind === "approval" ? (
        <>
          <Well theme={theme} value={row.body.action} />
          <EvidenceRow theme={theme} facts={row.body.evidence} />
          <Text style={{ color: kit.muted, fontSize: 12.5 }}>{`Held by ${heldByWords(row.body.heldBy)}`}</Text>
        </>
      ) : null}
      {row?.kind === "ask" ? (
        <>
          <AskOptions row={row} ask={ask} chosen={chosen} onChoose={setChoice} theme={theme} />
          <TextInput
            value={note}
            onChangeText={setNote}
            multiline
            placeholder={wordsPlaceholder(row.body.options, chosen)}
            placeholderTextColor={kit.muted}
            accessibilityLabel={`A note on your answer for ${row.title} (optional)`}
            style={{
              minHeight: 44,
              padding: 10,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: kit.border,
              backgroundColor: kit.sunken,
              color: kit.fg,
              fontSize: 14,
              textAlignVertical: "top",
            }}
          />
        </>
      ) : null}
      {row?.kind === "owner_step" ? (
        <>
          <Well theme={theme} value={row.body.where} label="Where" />
          <Text style={{ color: kit.fg2, fontSize: 12.5, lineHeight: 17 }}>{row.body.doneCheck}</Text>
        </>
      ) : null}
      {item && data.kind === "finished" ? (
        <FinishedBody item={item} theme={theme} compact={compact} actions={actions} />
      ) : null}
      {item && data.kind === "health" ? (
        <LogWell
          theme={theme}
          lines={[item.reason ?? "The run stopped without a reason.", ...(item.look?.ran ? [item.look.ran] : [])]}
        />
      ) : null}
      {course !== null ? <CourseNote value={course} onChange={setCourse} theme={theme} /> : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {verbs.map((verb) => {
          if (verb.id === "course" && course !== null) {
            return (
              <Pill
                key={verb.id}
                theme={theme}
                label="Send"
                primary
                height={compact ? 44 : 40}
                busy={runner.busy}
                disabled={!course.trim()}
                onPress={() => run("course")}
              />
            );
          }
          return (
            <Pill
              key={verb.id}
              theme={theme}
              label={verb.label}
              primary={verb.primary}
              tone={verb.tone}
              height={compact ? 44 : 40}
              busy={runner.busy && verb.primary}
              disabled={
                runner.busy ||
                (verb.id === "answer" && Boolean(row?.kind === "ask" && row.body.options.length > 0 && !chosen))
              }
              onPress={() => (verb.id === "course" ? setCourse("") : run(verb.id))}
            />
          );
        })}
        {course !== null ? (
          <Pill theme={theme} label="Keep it here" height={compact ? 44 : 40} onPress={() => setCourse(null)} />
        ) : null}
        {link}
      </View>
      {data.kind === "finished" && course === null && verbsNeedSaying(item?.look ?? null) ? (
        <Text style={{ color: kit.muted, fontSize: 12.5, lineHeight: 17 }}>{VERBS_MEAN}</Text>
      ) : null}
    </CardFrame>
  );
}

/** An ask's options, the recommended one chosen to begin with: the answer is the one the pill says. */
function AskOptions({
  row,
  ask,
  chosen,
  onChoose,
  theme,
}: {
  row: Extract<NeedRow, { kind: "ask" }>;
  ask: {
    options: readonly { id: string; label: string; consequence: string | null; reversible?: boolean | null }[];
  } | null;
  chosen: string | undefined;
  onChoose: (id: string) => void;
  theme: PluginTheme;
}) {
  const kit = kitOf(theme);
  const options = ask ? ask.options : row.body.options;
  return (
    <View style={{ gap: 8 }}>
      {row.body.why ? <Text style={{ color: kit.fg2, fontSize: 13, lineHeight: 18 }}>{row.body.why}</Text> : null}
      {options.map((option) => {
        const selected = option.id === chosen;
        const oneWay = "reversible" in option && option.reversible === false;
        return (
          <Pressable
            key={option.id}
            role={CHOICE_ROLE}
            aria-checked={selected}
            accessibilityLabel={option.label}
            onPress={() => onChoose(option.id)}
            style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({
              ...focusRing(theme, focused),
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              minHeight: 44,
              paddingHorizontal: 12,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: selected ? kit.needsLine : kit.hairline,
              backgroundColor: selected ? kit.needsSoft : kit.bg,
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <Icon name={selected ? "CircleCheck" : "Circle"} size={18} color={selected ? kit.needs : kit.muted} />
            <Text style={{ flex: 1, color: kit.fg, fontSize: 14.5 }}>{option.label}</Text>
            {option.id === row.body.recommended ? (
              <Text style={{ color: kit.muted, fontSize: 12 }}>recommended</Text>
            ) : null}
            {oneWay ? <Text style={{ color: kit.warn, fontSize: 12 }}>cannot be undone</Text> : null}
          </Pressable>
        );
      })}
      {row.body.default ? (
        <Text style={{ color: kit.muted, fontSize: 12.5 }}>
          {`Default: ${options.find((option) => option.id === row.body.default?.option)?.label ?? row.body.default.option}, taken if you stay silent.`}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Finished work, in the session's own words: what it asks, the block it handed you, what it decided, and what it
 * reports of its arc (client/gate-look.tsx, client/arc-report.tsx), then what it ran. The card says what to decide
 * on, never a percentage.
 */
function FinishedBody({
  item,
  theme,
  compact,
  actions,
}: {
  item: WorkItem;
  theme: PluginTheme;
  compact: boolean;
  actions: CardActions;
}) {
  const kit = kitOf(theme);
  const facts = [
    ...(item.verdict
      ? [
          {
            label: "Checks",
            value: item.verdict,
            tone: /\bchecks? failed\b/.test(item.verdict) ? ("danger" as const) : ("ok" as const),
          },
        ]
      : []),
    ...(item.changed
      ? [{ label: "Diff", value: `+${item.changed.additions} −${item.changed.deletions}`, tone: "muted" as const }]
      : []),
  ];
  return (
    <>
      {item.look ? <LookView look={item.look} theme={theme} compact={compact} /> : null}
      <ArcReport item={item} theme={theme} compact={compact} open={actions.intent} />
      <EvidenceRow theme={theme} facts={facts} />
      {item.look ? <Text style={{ color: kit.muted, fontSize: 12.5, ...TABULAR }}>{item.look.ran}</Text> : null}
    </>
  );
}

function CourseNote({
  value,
  onChange,
  theme,
}: {
  value: string;
  onChange: (value: string) => void;
  theme: PluginTheme;
}) {
  const kit = kitOf(theme);
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      multiline
      autoFocus
      placeholder="What should change?"
      placeholderTextColor={kit.muted}
      accessibilityLabel="What should change"
      style={{
        minHeight: 72,
        padding: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: kit.border,
        backgroundColor: kit.sunken,
        color: kit.fg,
        fontSize: 14,
        textAlignVertical: "top",
      }}
    />
  );
}
