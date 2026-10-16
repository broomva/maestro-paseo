// J5's parts (BRO-3036; docs/design/next/j5-decisions.png): the four tiles, the order and ledger chips with
// the stage's progress, the decision at full width, and the column beside it (Up next, where your last answers
// went). They draw what client/decisions-stage-model.ts decided; the tab's state (the queue, the pinned ask, the
// keys, an answer's flight) stays in client/decision-triage.tsx, which hands each part what it needs.
//
// The decision is J3's inspector at full width: the same body the Feed's inspector draws (InspectorBody), so
// answering in the Feed and here is one act with one set of words. Its answer goes through the card's own
// logic (useDecisionCard): the deliberate confirm for an option that cannot be undone, one answer in flight,
// and the keys.

import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { type MutableRefObject, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { DecisionAsk } from "../shared/fleet";
import { type CardKeys, DecisionDetails, type Draft, useDecisionCard } from "./decision-card";
import { answeredLine, fateLine, ledgerRail, ORDERINGS, type Ordering, railName } from "./decisions-model";
import { railLabel, type StageTiles, stageItem, type UpNextRow, type WentRow } from "./decisions-stage-model";
import { SectionHeading } from "./home-cards";
import { InspectorBody } from "./kit/inspector";
import { answerLabel, OTHER_CHOICE } from "./kit/inspector-model";
import { Dot, MONO, Pill, TABULAR } from "./kit/parts";
import { kitOf } from "./kit/tokens";
import { type ChipOption, ChipRow, Segments, TileWithVerb } from "./stage-parts";
import { focusRing, Notice, webAria } from "./ui";

type Navigation = PluginSurfaceProps["navigation"];

/** The four tiles: Open, Waiting to land (with its verb), Routed in progress, Acted on. */
export function StageTilesRow({
  theme,
  tiles,
  onOpenPr,
}: {
  theme: PluginTheme;
  tiles: StageTiles;
  /** Opens the landing PR; Maestro never merges it. */
  onOpenPr: (url: string) => void;
}) {
  const kit = kitOf(theme);
  return (
    <View style={{ flexDirection: "row", gap: 14, flexWrap: "wrap" }}>
      <TileWithVerb
        theme={theme}
        icon="MessagesSquare"
        label="Open"
        value={String(tiles.open.value)}
        unit={tiles.open.unit}
        line={tiles.open.line}
        tone={tiles.open.tone}
      >
        {tiles.open.extra ? (
          <Text numberOfLines={2} style={{ color: kit.fg2, fontSize: 12.5 }}>
            {tiles.open.extra}
          </Text>
        ) : null}
      </TileWithVerb>
      <TileWithVerb
        theme={theme}
        icon="TriangleAlert"
        label="Waiting to land"
        value={String(tiles.landing.value)}
        unit={tiles.landing.unit}
        line={tiles.landing.line}
        tone={tiles.landing.tone}
        verb={tiles.landing.verb?.label}
        onVerb={tiles.landing.verb ? () => onOpenPr(tiles.landing.verb?.url ?? "") : undefined}
      />
      <TileWithVerb
        theme={theme}
        icon="Send"
        label="Routed, in progress"
        value={String(tiles.routed.value)}
        line={tiles.routed.line}
        tone={tiles.routed.tone}
      />
      <TileWithVerb
        theme={theme}
        icon="Check"
        label="Acted on"
        value={String(tiles.acted.value)}
        line={tiles.acted.line}
        tone={tiles.acted.tone}
      />
    </View>
  );
}

/** How far one press of a rail arrow scrolls the ledger chips, in px. */
const RAIL_STEP = 320;

/**
 * The stage's controls, in two rows. First: the order, a words filter, "Waits on you", and the stage's progress.
 * Second: every ledger as a chip on one line that scrolls sideways (a trackpad, a shift-wheel, a drag on a phone, or
 * the arrows at its ends), so none is cut off at the edge or folded behind "+N more". Each chip counts the asks the
 * filter leaves in it.
 */
export function StageControls({
  theme,
  ordering,
  onOrdering,
  asks,
  ledger,
  onLedger,
  query,
  onQuery,
  waitingOnly,
  onWaitingOnly,
  progress,
  segments,
}: {
  theme: PluginTheme;
  ordering: Ordering;
  onOrdering: (next: Ordering) => void;
  /** Every decision the tab can walk (isTriaged), all ledgers, already narrowed by the filter: the chips count them. */
  asks: readonly DecisionAsk[];
  ledger: string | null;
  onLedger: (next: string | null) => void;
  query: string;
  onQuery: (next: string) => void;
  waitingOnly: boolean;
  onWaitingOnly: (next: boolean) => void;
  progress: string;
  segments: readonly boolean[];
}) {
  const kit = kitOf(theme);
  const rail = ledgerRail(asks);
  const total = rail.reduce((sum, entry) => sum + entry.open, 0);
  const waiting = rail.reduce((sum, entry) => sum + entry.waiting, 0);
  const ALL = "__all__";
  // A chosen ledger the filter emptied still shows, at 0, so it can be seen and cleared.
  const chosenGone = ledger !== null && !rail.some((entry) => entry.ledger === ledger);
  const options = [
    { id: ALL, label: "All", count: total, aria: railLabel("All ledgers", total, waiting) },
    ...rail.map((entry) => ({
      id: entry.ledger,
      label: railName(entry.ledger, 30),
      count: entry.open,
      aria: railLabel(entry.ledger, entry.open, entry.waiting),
    })),
    ...(chosenGone && ledger
      ? [{ id: ledger, label: railName(ledger, 30), count: 0, aria: railLabel(ledger, 0, 0) }]
      : []),
  ];
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <ChipRow
          theme={theme}
          label="Order"
          variant="segment"
          options={ORDERINGS}
          value={ordering}
          onChange={onOrdering}
        />
        <FilterField theme={theme} value={query} onChange={onQuery} />
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: waitingOnly }}
          {...webAria({ "aria-checked": waitingOnly })}
          accessibilityLabel={`Only the decisions that wait on you${waitingOnly ? ", on" : ""}`}
          onPress={() => onWaitingOnly(!waitingOnly)}
          style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({
            ...focusRing(theme, focused),
            height: 30,
            paddingHorizontal: 12,
            borderRadius: 9999,
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            backgroundColor: waitingOnly ? kit.needsSoft : kit.sunken,
            borderWidth: 1,
            borderColor: waitingOnly ? kit.needsLine : "transparent",
            opacity: pressed ? 0.8 : 1,
          })}
        >
          <Icon name="Hand" size={13} color={waitingOnly ? kit.needs : kit.muted} />
          <Text
            style={{ color: waitingOnly ? kit.needs : kit.fg2, fontSize: 13, fontWeight: waitingOnly ? "600" : "400" }}
          >
            Waits on you
          </Text>
        </Pressable>
        <View style={{ flex: 1 }} />
        <Text accessibilityLiveRegion="polite" style={{ color: kit.muted, fontSize: 12.5, ...TABULAR }}>
          {progress}
        </Text>
        <Segments theme={theme} filled={segments} />
      </View>
      <LedgerRail
        theme={theme}
        options={options}
        value={ledger ?? ALL}
        onChange={(next) => onLedger(next === ALL ? null : next)}
      />
    </View>
  );
}

/** The words filter: narrows every count and the queue as you type; Escape or the x clears it. */
function FilterField({
  theme,
  value,
  onChange,
}: {
  theme: PluginTheme;
  value: string;
  onChange: (next: string) => void;
}) {
  const kit = kitOf(theme);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        height: 30,
        minWidth: 200,
        flexGrow: 0,
        flexShrink: 1,
        paddingLeft: 10,
        paddingRight: value ? 4 : 10,
        borderRadius: 9999,
        backgroundColor: kit.sunken,
      }}
    >
      <Icon name="Search" size={13} color={kit.muted} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder="Filter decisions"
        placeholderTextColor={kit.muted}
        accessibilityLabel="Filter decisions by their words"
        onKeyPress={(event: { nativeEvent: { key: string } }) => {
          if (event.nativeEvent.key === "Escape") onChange("");
        }}
        style={
          { flex: 1, minWidth: 140, color: kit.fg, fontSize: 13, paddingVertical: 0, outlineStyle: "none" } as never
        }
      />
      {value ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear the filter"
          onPress={() => onChange("")}
          style={{ width: 24, height: 24, alignItems: "center", justifyContent: "center", borderRadius: 12 }}
        >
          <Icon name="X" size={13} color={kit.muted} />
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * Every ledger on one line that scrolls sideways. On the desktop an arrow shows at each end that has more past it,
 * since a mouse wheel scrolls up and down: one press moves the chips RAIL_STEP px. The chosen chip is scrolled into
 * view when it is chosen from elsewhere (a focus from the Feed).
 */
function LedgerRail({
  theme,
  options,
  value,
  onChange,
}: {
  theme: PluginTheme;
  options: readonly ChipOption<string>[];
  value: string;
  onChange: (next: string) => void;
}) {
  const kit = kitOf(theme);
  const scroller = useRef<ScrollView>(null);
  const [view, setView] = useState({ x: 0, width: 0, content: 0 });
  const canLeft = view.x > 4;
  const canRight = view.x + view.width < view.content - 4;
  const step = (by: number) =>
    scroller.current?.scrollTo({ x: Math.max(0, Math.min(view.content - view.width, view.x + by)), animated: true });
  const arrow = (side: "left" | "right") => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={side === "left" ? "Earlier ledgers" : "More ledgers"}
      onPress={() => step(side === "left" ? -RAIL_STEP : RAIL_STEP)}
      style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({
        ...focusRing(theme, focused),
        width: 30,
        height: 30,
        borderRadius: 15,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: kit.sunken,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Icon name={side === "left" ? "ChevronLeft" : "ChevronRight"} size={15} color={kit.fg2} />
    </Pressable>
  );
  return (
    <View testID="ledger-rail" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      {canLeft ? arrow("left") : null}
      <ScrollView
        ref={scroller}
        horizontal
        showsHorizontalScrollIndicator={Platform.OS === "web"}
        style={{ flex: 1, minWidth: 0 }}
        contentContainerStyle={{ paddingBottom: Platform.OS === "web" ? 6 : 0 }}
        scrollEventThrottle={32}
        onScroll={(event) => {
          const x = event.nativeEvent.contentOffset.x;
          setView((now) => (now.x === x ? now : { ...now, x }));
        }}
        onLayout={(event) => {
          const width = event.nativeEvent.layout.width;
          setView((now) => (now.width === width ? now : { ...now, width }));
        }}
        onContentSizeChange={(content) => setView((now) => (now.content === content ? now : { ...now, content }))}
      >
        <ChipRow theme={theme} label="Ledger" options={options} value={value} onChange={onChange} wrap={false} />
      </ScrollView>
      {canRight ? arrow("right") : null}
    </View>
  );
}

/** The decision at full width: J3's body, its words field, and the bar (Skip, Answer with N). */
export function StageCard({
  theme,
  ask,
  where,
  navigation,
  now,
  onAnswered,
  onSkip,
  keys,
  draft,
  onDraft,
  frozen,
  onNext,
}: {
  theme: PluginTheme;
  ask: DecisionAsk;
  where: Parameters<typeof useDecisionCard>[0]["where"];
  navigation: Navigation;
  now: number;
  onAnswered: (answered: DecisionAsk, warning: string | null, queued?: boolean) => void;
  onSkip?: () => void;
  keys: MutableRefObject<CardKeys | null>;
  draft: Draft;
  onDraft: (draft: Draft) => void;
  frozen: string | null;
  onNext?: () => void;
}) {
  const kit = kitOf(theme);
  const card = useDecisionCard({ ask, where, onAnswered, keys, draft, onDraft, frozen });
  const item = useMemo(
    // An Other answer marks the Other row (BRO-3146): it took no option, so answerOption alone would mark none.
    () => stageItem(ask, card.open ? card.chosen : (ask.answerOption ?? (ask.answerOther ? OTHER_CHOICE : null)), now),
    [ask, card.open, card.chosen, now],
  );
  const hints = Platform.OS === "web";
  const answerable = card.open && !ask.refusal;
  const fate = fateLine(ask);
  const label = card.confirming
    ? "Confirm — cannot be undone"
    : item.kind === "ask" && item.options.length > 0
      ? answerLabel(item.options, card.chosen ?? undefined)
      : "Answer";
  return (
    <View
      testID="decision-stage"
      style={{
        flex: 1,
        minWidth: 0,
        borderRadius: 18,
        borderWidth: card.open && ask.waiting ? 1.5 : 1,
        borderColor: card.open && ask.waiting ? kit.needsLine : kit.border,
        backgroundColor: kit.bg,
        padding: 24,
        gap: 16,
      }}
    >
      {card.open && ask.waiting ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon name="TriangleAlert" size={14} color={kit.warn} />
          <Text style={{ color: kit.warn, fontSize: 12.5, fontWeight: "600" }}>
            {ask.blocking
              ? "Waits on you: it blocks until you answer."
              : "Waits on you: what it recommends cannot be undone."}
          </Text>
        </View>
      ) : null}
      <InspectorBody
        theme={theme}
        item={item.kind === "ask" ? { ...item, summary: card.lead.rest ?? undefined } : item}
        choice={card.chosen ?? ""}
        onChoose={card.setChosen}
        locked={!answerable || card.anyInFlight}
        keys
        words={card.note}
        onWords={answerable ? card.setNote : undefined}
      />
      {frozen ? (
        <View style={{ gap: 8 }}>
          <Notice theme={theme} tone="warn">
            {frozen}
          </Notice>
          {onNext ? (
            <View style={{ flexDirection: "row" }}>
              <Pill theme={theme} primary label="Next decision" height={36} onPress={onNext} />
            </View>
          ) : null}
        </View>
      ) : !card.open ? (
        <View style={{ gap: 2 }}>
          <Text style={{ color: kit.ok, fontSize: 13, fontWeight: "600" }}>{answeredLine(ask)}</Text>
          {ask.answer ? (
            <Text selectable style={{ color: kit.fg2, fontSize: 13 }}>
              {ask.answer}
            </Text>
          ) : null}
          {fate ? <Text style={{ color: kit.muted, fontSize: 12.5 }}>{fate.words}</Text> : null}
        </View>
      ) : ask.refusal ? (
        <Notice theme={theme} tone="warn">
          {`This ask cannot be answered here. ${ask.refusal}`}
        </Notice>
      ) : null}
      {card.confirming ? (
        <Text style={{ color: kit.warn, fontSize: 12.5 }}>
          {`“${card.option?.label ?? ""}” cannot be undone. Press again to send it, or Esc (or another option) to stop.`}
        </Text>
      ) : null}
      {card.failure ? (
        <Notice theme={theme} tone="danger">
          {`Not answered: ${card.failure instanceof Error ? card.failure.message : String(card.failure)}`}
        </Notice>
      ) : null}
      {card.open && !frozen ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            borderTopWidth: 1,
            borderTopColor: kit.hairline,
            paddingTop: 14,
          }}
        >
          {hints ? <Text style={{ color: kit.muted, fontSize: 12 }}>1–4 choose · J / K move</Text> : null}
          <View style={{ flex: 1 }} />
          {onSkip ? (
            <Pill
              theme={theme}
              label="Skip"
              keyCap="S"
              height={36}
              onPress={onSkip}
              accessibilityLabel={`Skip ${ask.id} for now`}
            />
          ) : null}
          {answerable ? (
            <Pill
              theme={theme}
              primary
              label={label}
              keyCap="↵"
              height={36}
              disabled={!card.canAnswer}
              busy={card.pendingHere}
              accessibilityLabel={
                card.confirming
                  ? `Confirm ${ask.id}: ${card.option?.label ?? ""}, cannot be undone`
                  : `Answer ${ask.id}${card.option ? `: ${card.option.label}` : ""}`
              }
              onPress={card.submit}
            />
          ) : null}
        </View>
      ) : null}
      <DecisionDetails
        theme={theme}
        ask={ask}
        lead={card.lead}
        open={card.open}
        compact={false}
        navigation={navigation}
      />
    </View>
  );
}

/** The column beside the stage: Up next, and where your last answers went. */
export function StageSide({
  theme,
  next,
  nextTotal,
  went,
  onGo,
}: {
  theme: PluginTheme;
  next: readonly UpNextRow[];
  /** How many decisions are left behind this one: the heading's number, of which `next` lists the first few. */
  nextTotal: number;
  /** Null until answers.status is read. */
  went: readonly WentRow[] | null;
  onGo: (at: number) => void;
}) {
  const kit = kitOf(theme);
  const blockers = next.filter((row) => row.blocks).length;
  const chipColor = (tone: WentRow["chip"]["tone"]) =>
    tone === "ok" ? kit.ok : tone === "warn" ? kit.warn : tone === "info" ? kit.info : kit.muted;
  return (
    <View style={{ width: 380, gap: 18 }}>
      {next.length > 0 ? (
        <View style={{ gap: 10 }}>
          <SectionHeading
            theme={theme}
            title="Up next"
            count={nextTotal}
            hint={blockers > 0 ? "blocks work" : undefined}
          />
          {next.map((row, at) => (
            <Pressable
              key={row.key}
              accessibilityRole="button"
              accessibilityLabel={row.label}
              onPress={() => onGo(at)}
              style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({
                ...focusRing(theme, focused),
                borderRadius: 14,
                borderWidth: 1,
                borderColor: kit.hairline,
                backgroundColor: kit.bg,
                padding: 12,
                gap: 6,
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                {row.blocks ? (
                  <View
                    style={{ borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1, backgroundColor: kit.warnSoft }}
                  >
                    <Text style={{ color: kit.warn, fontSize: 11.5, fontWeight: "600" }}>blocks work</Text>
                  </View>
                ) : null}
                <Text numberOfLines={1} style={{ flex: 1, color: kit.muted, fontSize: 11.5, fontFamily: MONO }}>
                  {row.ledger}
                </Text>
                {at === 0 ? (
                  <View style={{ borderWidth: 1, borderColor: kit.border, borderRadius: 5, paddingHorizontal: 6 }}>
                    <Text style={{ color: kit.muted, fontSize: 11, fontFamily: MONO }}>J</Text>
                  </View>
                ) : null}
              </View>
              <Text numberOfLines={3} style={{ color: kit.fg, fontSize: 14, fontWeight: "600", lineHeight: 19 }}>
                {row.title}
              </Text>
              {row.silent ? <Text style={{ color: kit.muted, fontSize: 12 }}>{row.silent}</Text> : null}
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={{ gap: 10 }}>
        <SectionHeading theme={theme} title="Where your last answers went" count={went?.length ?? 0} />
        {went === null ? (
          <Text style={{ color: kit.muted, fontSize: 12.5 }}>Where your answers went is not read yet.</Text>
        ) : went.length === 0 ? (
          <Text style={{ color: kit.muted, fontSize: 12.5 }}>
            Nothing you answered here has been routed yet. Answers show where they went once you give one.
          </Text>
        ) : (
          <View style={{ borderRadius: 14, borderWidth: 1, borderColor: kit.hairline, backgroundColor: kit.bg }}>
            {went.map((row, at) => (
              <View
                key={row.key}
                style={{
                  flexDirection: "row",
                  gap: 10,
                  padding: 12,
                  borderTopWidth: at === 0 ? 0 : 1,
                  borderTopColor: kit.hairline,
                }}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Text numberOfLines={2} style={{ color: kit.fg, fontSize: 13.5, fontWeight: "600" }}>
                    {row.title}
                  </Text>
                  <Text numberOfLines={1} style={{ color: kit.fg2, fontSize: 12.5 }}>
                    {row.line}
                  </Text>
                  <Text numberOfLines={2} style={{ color: kit.muted, fontSize: 12 }}>
                    {row.words}
                  </Text>
                </View>
                <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 5 }}>
                  <View style={{ paddingTop: 5 }}>
                    <Dot color={chipColor(row.chip.tone)} size={6} />
                  </View>
                  <Text style={{ color: chipColor(row.chip.tone), fontSize: 12, fontWeight: "600" }}>
                    {row.chip.word}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}
