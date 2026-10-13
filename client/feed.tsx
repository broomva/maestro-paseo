// The Feed home (BRO-2906), as the chosen design draws it
// (docs/design/feed/feed-column.png): Needs you (needs.list's holds, BRO-3001),
// Decide, Stuck, Running, Queued, Handled for you (handled.list) and Done.
// client/feed-model.ts decides what each shows; this file only draws it. A
// card's verb opens the item, where the verbs are.

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import type { WorkItem } from "../shared/contracts";
import type { DecisionAsk } from "../shared/fleet";
import { KIND_WORDS, kindWords, type NeedRow } from "../shared/needs";
import { ChangeText, WithChange } from "./changed";
import {
  type CardModel,
  cardHint,
  cardOf,
  type DecideRow,
  decideRowOf,
  kindsOf,
  type NeedEntry,
  type Tone,
} from "./feed-model";
import { ago } from "./format";
import { cardLabel, changedVisible } from "./plane-model";
import { placeText, titleText } from "./records-text";
import { radius, StateDot, space, Unbroken, useText, webAria } from "./ui";

/** An icon-only control's target: a real box, since react-native-web ignores hitSlop. */
export const TAP_BOX = { minWidth: 32, minHeight: 32, alignItems: "center", justifyContent: "center" } as const;

type Pick = { theme: PluginTheme; selected: string | null; onSelect: (id: string) => void };

function tint(theme: PluginTheme, tone: Tone): string {
  switch (tone) {
    case "success":
      return theme.colors.statusSuccess;
    case "warning":
      return theme.colors.statusWarning;
    case "danger":
      return theme.colors.statusDanger;
    case "accent":
      return theme.colors.accent;
    default:
      return theme.colors.foregroundMuted;
  }
}

/** A section's header: its name, a count chip, and a muted hint. */
function Header({
  theme,
  title,
  count,
  hint,
}: {
  theme: PluginTheme;
  title: string;
  count: number;
  hint?: string | null;
}) {
  const text = useText(theme);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}>
      <Text style={[text.body, { fontWeight: "700" }]} accessibilityRole="header">
        {title}
      </Text>
      <View
        style={{
          paddingHorizontal: space[2],
          borderRadius: radius.pill,
          backgroundColor: theme.colors.surface2,
        }}
      >
        <Text style={[text.small, text.tabular, { fontWeight: "600", color: theme.colors.foreground }]}>{count}</Text>
      </View>
      {hint ? <Text style={text.small}>{hint}</Text> : null}
    </View>
  );
}

function DecideRowView({ theme, row, onOpen }: { theme: PluginTheme; row: DecideRow; onOpen: () => void }) {
  const text = useText(theme);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Decide: ${row.headline}`}
      onPress={onOpen}
      style={({ pressed }) => ({
        gap: space[2],
        padding: space[3],
        borderRadius: radius.card,
        backgroundColor: pressed ? theme.colors.surface2 : theme.colors.surface1,
      })}
    >
      <Text style={[text.body, { fontWeight: "500" }]} numberOfLines={2}>
        {row.headline}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
        {row.blocks ? (
          <View
            style={{
              paddingHorizontal: space[2],
              borderRadius: radius.control,
              backgroundColor: `${theme.colors.statusWarning}22`,
            }}
          >
            <Text style={[text.small, { color: theme.colors.statusWarning, fontWeight: "600" }]}>blocks work</Text>
          </View>
        ) : null}
        <Text style={[text.mono, { color: theme.colors.foregroundMuted, flexShrink: 1 }]} numberOfLines={1}>
          {row.where}
        </Text>
        <View style={{ flex: 1 }} />
        {row.silent ? (
          <Text style={text.small} numberOfLines={1}>
            {row.silent}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const ASK_ICON: Record<NonNullable<CardModel["ask"]>["kind"], string> = {
  ask: "CircleHelp",
  words: "Quote",
  reason: "CircleAlert",
};

/** One work card, in the design's anatomy: source, title, evidence, ask, then pill, session and verb. */
export function FeedCard(props: Pick & { item: WorkItem }) {
  return (
    <WithChange workspaceId={props.item.worker?.workspaceId} stat={props.item.changed}>
      {(stat) => <CardBody {...props} changed={stat ?? null} />}
    </WithChange>
  );
}

function CardBody({
  theme,
  item,
  selected,
  onSelect,
  changed,
}: Pick & { item: WorkItem; changed: { additions: number; deletions: number } | null }) {
  const text = useText(theme);
  const card = cardOf(item, Date.now(), changed);
  const isSelected = item.id === selected;
  const open = () => onSelect(item.id);
  const pill = tint(theme, card.pill.tone);
  // The verb and the ask describe the card's one button: native reads the hint, the web the drawn words by id.
  const ids = { verb: `feed-${item.id}-verb`, ask: `feed-${item.id}-ask` };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: isSelected }}
      {...webAria({ "aria-current": isSelected })}
      accessibilityHint={cardHint(card)}
      aria-describedby={
        [card.action ? ids.verb : null, card.ask ? ids.ask : null].filter(Boolean).join(" ") || undefined
      }
      accessibilityLabel={cardLabel({
        ...item,
        title: titleText(item),
        initiative: placeText(item),
        project: null,
        repo: null,
      })}
      onPress={open}
      style={({ pressed }) => ({
        gap: space[2],
        padding: space[4],
        borderRadius: radius.card,
        borderWidth: card.lead || isSelected ? 1.5 : 1,
        borderColor: isSelected ? theme.colors.accent : card.lead ? theme.colors.statusSuccess : theme.colors.border,
        backgroundColor: pressed ? theme.colors.surface2 : theme.colors.surface1,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
        <Icon name={card.icon} size={14} color={tint(theme, card.iconTone)} />
        <Text style={[text.mono, { color: theme.colors.foregroundMuted, flexShrink: 1 }]} numberOfLines={1}>
          {card.source.join(" · ")}
        </Text>
        {card.via ? (
          <Text style={[text.small, { flexShrink: 1 }]} numberOfLines={1}>
            {card.via}
          </Text>
        ) : null}
        <View style={{ flex: 1 }} />
        <Text style={[text.small, text.tabular]}>{ago(item.updatedAt)}</Text>
      </View>
      <Text style={[text.body, { fontSize: 16, lineHeight: 22, fontWeight: "600" }]} numberOfLines={2}>
        <Unbroken>{card.title}</Unbroken>
      </Text>
      {card.evidence || changedVisible(card.branch, card.changed) ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}>
          {card.evidence ? <Icon name={card.evidence.icon} size={14} color={tint(theme, card.evidence.tone)} /> : null}
          {card.branch ? (
            <Text style={[text.mono, { color: theme.colors.foregroundMuted, flexShrink: 1 }]} numberOfLines={1}>
              {card.branch}
            </Text>
          ) : null}
          {card.evidence ? (
            <Text style={[text.small, { flexShrink: 1, color: theme.colors.foreground }]} numberOfLines={1}>
              {card.evidence.text}
            </Text>
          ) : null}
          {card.changed ? <ChangeText theme={theme} stat={card.changed} /> : null}
        </View>
      ) : null}
      {card.ask ? (
        <View
          style={{
            flexDirection: "row",
            gap: space[2],
            padding: space[3],
            borderRadius: radius.control,
            backgroundColor: theme.colors.surface2,
          }}
        >
          <View style={{ paddingTop: 2 }}>
            <Icon
              name={ASK_ICON[card.ask.kind]}
              size={14}
              color={card.ask.kind === "reason" ? theme.colors.statusWarning : theme.colors.foregroundMuted}
            />
          </View>
          <Text nativeID={ids.ask} style={[text.body, { flex: 1 }]} numberOfLines={3}>
            {card.ask.text}
          </Text>
        </View>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space[1],
            paddingHorizontal: space[2],
            paddingVertical: 2,
            borderRadius: radius.pill,
            backgroundColor: `${pill}1F`,
          }}
        >
          <StateDot theme={theme} state={item.state} dim={6} />
          <Text style={[text.small, { color: pill, fontWeight: "600" }]}>{card.pill.label}</Text>
        </View>
        <Text style={[text.small, { flex: 1 }]} numberOfLines={1}>
          {card.session}
        </Text>
        {card.action ? (
          // The card is the button: its verb is drawn, not a second control inside it.
          <View
            style={{
              paddingHorizontal: space[4],
              minHeight: 32,
              justifyContent: "center",
              borderRadius: radius.pill,
              backgroundColor: theme.colors.accent,
            }}
          >
            <Text nativeID={ids.verb} style={[text.small, { color: theme.colors.accentForeground, fontWeight: "600" }]}>
              {card.action}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const HOLD_ICON: Record<NeedRow["kind"], string> = {
  approval: "ShieldCheck",
  ask: "CircleHelp",
  owner_step: "Hand",
};

/** What a hold's card says under its title: the action held, why an ask is yours, where a step is done. */
function holdLine(row: NeedRow): string {
  if (row.kind === "approval") return row.body.action;
  if (row.kind === "ask") return row.body.why || row.body.goesTo;
  return row.body.where;
}

/** A hold this client has no work item or ask for: its kind, where it is, its title, and what it holds. */
function HoldCard({ theme, row, onOpen }: { theme: PluginTheme; row: NeedRow; onOpen: (row: NeedRow) => void }) {
  const text = useText(theme);
  const kind = KIND_WORDS[row.kind].one;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${kind}: ${row.title}, ${row.scope}, waiting ${ago(row.since)}`}
      onPress={() => onOpen(row)}
      style={({ pressed }) => ({
        gap: space[2],
        padding: space[4],
        borderRadius: radius.card,
        borderWidth: 1,
        borderColor: theme.colors.accent,
        backgroundColor: pressed ? theme.colors.surface2 : theme.colors.surface1,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
        <Icon name={HOLD_ICON[row.kind]} size={14} color={theme.colors.accent} />
        <Text style={[text.mono, { color: theme.colors.foregroundMuted, flex: 1 }]} numberOfLines={1}>
          {[row.scope, row.ticket, kind].filter(Boolean).join(" · ")}
        </Text>
        <Text style={[text.small, text.tabular]}>{ago(row.since)}</Text>
      </View>
      <Text style={[text.body, { fontWeight: "600" }]} numberOfLines={2}>
        {row.title}
      </Text>
      <Text style={text.small} numberOfLines={2}>
        {holdLine(row)}
      </Text>
    </Pressable>
  );
}

/**
 * Needs you: every hold needs.list holds, in its order, as many as the header
 * counts. Work at your gate and what only you may start are work cards; an ask
 * is a Decide row; anything this client cannot join is its own hold card.
 */
export function NeedsSection({
  entries,
  onOpenAsk,
  onOpenHold,
  ...pick
}: Pick & {
  entries: readonly NeedEntry[];
  onOpenAsk: (ask: DecisionAsk) => void;
  onOpenHold: (row: NeedRow) => void;
}) {
  if (entries.length === 0) return null;
  // Its line says the rows it lists, so a scope or a search never puts a wider number beside them.
  const kinds = kindWords(kindsOf(entries.map((entry) => entry.row)));
  return (
    <View style={{ gap: space[3] }}>
      <Header theme={pick.theme} title="Needs you" count={entries.length} hint={kinds} />
      {entries.map(({ row, item, ask }) =>
        item ? (
          <FeedCard key={row.key} {...pick} item={item} />
        ) : ask ? (
          <DecideRowView key={row.key} theme={pick.theme} row={decideRowOf(ask)} onOpen={() => onOpenAsk(ask)} />
        ) : (
          <HoldCard key={row.key} theme={pick.theme} row={row} onOpen={onOpenHold} />
        ),
      )}
    </View>
  );
}
