// The Feed home (BRO-2906), as the chosen design draws it
// (docs/design/feed/feed-column.png): Needs you (needs.list's holds, BRO-3001),
// Decide, Stuck, Running, Queued, Handled for you (handled.list) and Done.
// client/feed-model.ts decides what each shows; this file only draws it. A
// card's verb opens the item, where the verbs are.

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { WorkItem } from "../shared/contracts";
import type { DecisionAsk } from "../shared/fleet";
import { type HandledRow, KIND_WORDS, kindWords, type NeedRow } from "../shared/needs";
import { ChangeText, WithChange } from "./changed";
import { askKey } from "./decisions-model";
import {
  type CardModel,
  cardHint,
  cardOf,
  type DecideRow,
  decideOf,
  decideRowOf,
  type FeedSections,
  HANDLED_NAMED,
  type HandledGroup,
  handledForYou,
  handledGroups,
  handledTitle,
  kindsOf,
  type NeedEntry,
  type Tone,
} from "./feed-model";
import { ago, plural } from "./format";
import { cardLabel, changedVisible, groupHint, type Initiative } from "./plane-model";
import { placeText, titleText } from "./records-text";
import { CHOICE_ROLE, radius, StateDot, space, Unbroken, useText, webAria } from "./ui";

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

/** Decide: the open asks that do not wait on you (those that do are under Needs you), a few inline, and the way to the rest. */
export function DecideSection({
  theme,
  asks,
  onOpen,
}: {
  theme: PluginTheme;
  asks: readonly DecisionAsk[];
  onOpen: (ask: DecisionAsk | null) => void;
}) {
  const text = useText(theme);
  const decide = decideOf(asks);
  if (decide.rows.length === 0) return null;
  return (
    <View style={{ gap: space[2] }}>
      <Header theme={theme} title="Decide" count={decide.rows.length + decide.more} hint="open, not waiting on you" />
      {decide.rows.map((row) => (
        <DecideRowView key={askKey(row.ask)} theme={theme} row={row} onOpen={() => onOpen(row.ask)} />
      ))}
      {decide.more > 0 ? (
        <Pressable
          accessibilityRole="link"
          onPress={() => onOpen(null)}
          style={{ flexDirection: "row", alignItems: "center", gap: space[1], paddingVertical: space[1] }}
        >
          <Text style={[text.body, { color: theme.colors.accent, fontWeight: "500" }]}>
            {decide.more} more in Decisions
          </Text>
          <Icon name="ArrowRight" size={14} color={theme.colors.accent} />
        </Pressable>
      ) : null}
    </View>
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

/** Handled for you: handled.list's rows that closed without you this week, one card per who closed them. */
function HandledCard({
  theme,
  group,
  onSelect,
}: {
  theme: PluginTheme;
  group: HandledGroup;
  onSelect: (id: string) => void;
}) {
  const text = useText(theme);
  const [open, setOpen] = useState(false);
  const shown = open ? group.rows : group.rows.slice(0, HANDLED_NAMED);
  return (
    <View
      style={{
        gap: space[2],
        padding: space[4],
        borderRadius: radius.card,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${handledTitle(group)}: ${open ? "show fewer" : "show all"}`}
        onPress={() => setOpen((value) => !value)}
        style={{ flexDirection: "row", alignItems: "center", gap: space[3] }}
      >
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: radius.control,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: `${theme.colors.statusSuccess}1F`,
          }}
        >
          <Icon name="Workflow" size={16} color={theme.colors.statusSuccess} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[text.body, { fontWeight: "600" }]}>{handledTitle(group)}</Text>
          <Text style={text.small}>Closed on their own evidence; each receipt says how</Text>
        </View>
        <Icon name={open ? "ChevronUp" : "ChevronRight"} size={16} color={theme.colors.foregroundMuted} />
      </Pressable>
      {shown.map((row) => (
        <HandledLine key={row.key} theme={theme} row={row} onSelect={onSelect} />
      ))}
      {!open && group.rows.length > HANDLED_NAMED ? (
        <Text style={[text.small, { paddingLeft: space[2] }]}>and {group.rows.length - HANDLED_NAMED} more</Text>
      ) : null}
    </View>
  );
}

/** One closed arc: its title and when; it opens its work item. */
function HandledLine({
  theme,
  row,
  onSelect,
}: {
  theme: PluginTheme;
  row: HandledRow;
  onSelect: (id: string) => void;
}) {
  const text = useText(theme);
  const id = row.key.startsWith("work:") ? row.key.slice("work:".length) : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Done: ${row.title}. ${row.reason}`}
      onPress={() => (id ? onSelect(id) : undefined)}
      style={{ flexDirection: "row", alignItems: "center", gap: space[2], paddingLeft: space[2] }}
    >
      <Icon name="Check" size={14} color={theme.colors.statusSuccess} />
      <Text style={[text.body, { flex: 1 }]} numberOfLines={1}>
        {row.title.replace(/^SRI:\s*/, "")}
      </Text>
      <Text style={[text.small, text.tabular]}>{ago(row.at)}</Text>
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

/** Done: yours, as a count with today and this week; the list opens on demand. */
function DoneSection({
  theme,
  done,
  onSelect,
}: {
  theme: PluginTheme;
  done: FeedSections["done"];
  onSelect: (id: string) => void;
}) {
  const text = useText(theme);
  const [open, setOpen] = useState(false);
  if (done.count === 0) return null;
  return (
    <View style={{ gap: space[2] }}>
      {/* The heading stays a heading; the toggle beside it is its own button. */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
        <Header theme={theme} title="Done" count={done.count} hint={`today ${done.today} · this week ${done.week}`} />
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          aria-expanded={open}
          accessibilityLabel={`${open ? "Hide" : "Show"} the ${plural(done.count, "done item")}`}
          onPress={() => setOpen((value) => !value)}
          style={TAP_BOX}
        >
          <Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>
      {open
        ? done.items.map((item) => (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              accessibilityLabel={`Done: ${titleText(item)}`}
              onPress={() => onSelect(item.id)}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: space[2],
                minHeight: 32,
                paddingHorizontal: space[2],
                borderRadius: radius.control,
                backgroundColor: pressed ? theme.colors.surface1 : "transparent",
              })}
            >
              <Text style={[text.body, { flex: 1 }]} numberOfLines={1}>
                {titleText(item)}
              </Text>
              <Text style={[text.small, text.tabular]}>{ago(item.closed?.at ?? item.updatedAt)}</Text>
            </Pressable>
          ))
        : null}
    </View>
  );
}

/** The Feed home's work sections, after Needs you and Decide: Stuck, Running, Queued, Handled for you, Done. */
export function FeedSectionsView({
  sections,
  handled,
  loopOn,
  ...pick
}: Pick & { sections: FeedSections; handled: readonly HandledRow[]; loopOn: boolean }) {
  const cards = (title: string, list: readonly WorkItem[], hint: string | null = null) =>
    list.length === 0 ? null : (
      <View key={title} style={{ gap: space[3] }}>
        <Header theme={pick.theme} title={title} count={list.length} hint={hint} />
        {list.map((item) => (
          <FeedCard key={item.id} {...pick} item={item} />
        ))}
      </View>
    );
  const forYou = handledForYou(handled);
  const groups = handledGroups(forYou);
  const count = forYou.length;
  return (
    <>
      {cards("Stuck", sections.stuck, groupHint("blocked", loopOn))}
      {cards("Finished", sections.finished, "At the gate, nothing asked of you: gates merge it")}
      {cards("Running", sections.running)}
      {cards("Queued", sections.queued, groupHint("queued", loopOn))}
      {count > 0 ? (
        <View style={{ gap: space[3] }}>
          <Header theme={pick.theme} title="Handled for you" count={count} hint="closed without you this week" />
          {groups.map((group) => (
            <HandledCard key={group.by} theme={pick.theme} group={group} onSelect={pick.onSelect} />
          ))}
        </View>
      ) : null}
      <DoneSection theme={pick.theme} done={sections.done} onSelect={pick.onSelect} />
    </>
  );
}

/** The scope menu and the search, one row: "All scopes" opens the initiatives under it. */
export function FeedControls({
  theme,
  initiatives,
  scope,
  onScope,
  query,
  onQuery,
}: {
  theme: PluginTheme;
  initiatives: readonly Initiative[];
  scope: string | null;
  onScope: (scope: string | null) => void;
  query: string;
  onQuery: (query: string) => void;
}) {
  const text = useText(theme);
  const [open, setOpen] = useState(false);
  const field = {
    minHeight: 40,
    borderRadius: radius.control,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  };
  const choose = (next: string | null) => {
    onScope(next);
    setOpen(false);
  };
  return (
    <View style={{ gap: space[2] }}>
      <View style={{ flexDirection: "row", gap: space[2] }}>
        {initiatives.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            accessibilityLabel={`Scope: ${scope ?? "all scopes"}`}
            onPress={() => setOpen((value) => !value)}
            style={{ ...field, flexDirection: "row", alignItems: "center", gap: space[2], paddingHorizontal: space[3] }}
          >
            <Icon name="Layers" size={14} color={theme.colors.foregroundMuted} />
            <Text style={[text.body, { fontWeight: "500" }]} numberOfLines={1}>
              {scope ?? "All scopes"}
            </Text>
            <Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} color={theme.colors.foregroundMuted} />
          </Pressable>
        ) : null}
        <View
          style={{
            ...field,
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            gap: space[2],
            paddingHorizontal: space[3],
          }}
        >
          <Icon name="Search" size={14} color={theme.colors.foregroundMuted} />
          <TextInput
            value={query}
            onChangeText={onQuery}
            placeholder="Find work, ticket or branch"
            placeholderTextColor={theme.colors.foregroundMuted}
            accessibilityLabel="Find work, ticket or branch"
            autoCorrect={false}
            autoCapitalize="none"
            style={[text.body, { flex: 1, paddingVertical: space[2] }]}
          />
          {query ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear the search"
              onPress={() => onQuery("")}
              style={TAP_BOX}
            >
              <Icon name="X" size={14} color={theme.colors.foregroundMuted} />
            </Pressable>
          ) : null}
        </View>
      </View>
      {open ? (
        <View style={{ ...field, padding: space[1] }} accessibilityRole="menu">
          {[null, ...initiatives.map((initiative) => initiative.name)].map((name) => {
            const initiative = initiatives.find((entry) => entry.name === name);
            const chosen = scope === name;
            return (
              <Pressable
                key={name ?? "all"}
                role={CHOICE_ROLE}
                accessibilityState={{ checked: chosen }}
                {...webAria({ "aria-checked": chosen })}
                onPress={() => choose(name)}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space[2],
                  minHeight: 36,
                  paddingHorizontal: space[3],
                  borderRadius: radius.control,
                  backgroundColor: chosen || pressed ? theme.colors.surface2 : "transparent",
                })}
              >
                <Text style={[text.body, { flex: 1 }]}>{name ?? "All scopes"}</Text>
                {initiative ? (
                  <Text style={[text.small, text.tabular]}>
                    {initiative.needsYou ? `${initiative.needsYou} need you · ` : ""}
                    {initiative.open}/{initiative.total}
                  </Text>
                ) : null}
                {chosen ? <Icon name="Check" size={14} color={theme.colors.accent} /> : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
