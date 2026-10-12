// The parts of J1's main column and rail (BRO-3035): a hold as a full card, a finished arc and a watched
// item as rows, the section heading, and the rail's three lists. Each draws what home-model.ts decided and
// calls what the screen hands it; nothing here counts or reads.

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { WorkItem } from "../shared/contracts";
import type { DecisionAsk } from "../shared/fleet";
import { holdOf } from "../shared/needs";
import type { NeedEntry } from "./feed-model";
import { type DecideRow, HANDLED_NAMED, type HandledGroup, handledTitle } from "./feed-model";
import { ago, plural } from "./format";
import {
  evidenceLine,
  type HealthRow,
  holdChipWords,
  holdKicker,
  holdKindOf,
  primaryLabel,
  workScope,
} from "./home-model";
import { KIND_LOOK, verbsFor } from "./kit/inspector-model";
import { Dot, Kicker, MONO, Pill, TABULAR } from "./kit/parts";
import { kitOf } from "./kit/tokens";
import { Undertow } from "./kit/undertow";
import { titleText } from "./records-text";
import { focusRing } from "./ui";

/** A section's heading: its title, its count and, when it has one, the words after it. */
export function SectionHeading({
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
  const kit = kitOf(theme);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <Text accessibilityRole="header" style={{ color: kit.fg, fontSize: 15, fontWeight: "600" }}>
        {title}
      </Text>
      <View
        style={{
          minWidth: 22,
          height: 20,
          borderRadius: 9999,
          paddingHorizontal: 7,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: kit.sunken,
        }}
      >
        <Text style={{ color: kit.fg2, fontSize: 12, fontWeight: "600", ...TABULAR }}>{count}</Text>
      </View>
      {hint ? <Text style={{ color: kit.muted, fontSize: 12.5, flexShrink: 1 }}>{hint}</Text> : null}
    </View>
  );
}

const cardBox = (kit: ReturnType<typeof kitOf>, selected: boolean, hold: boolean) => ({
  borderRadius: 16,
  borderWidth: selected ? 2 : hold ? 1.5 : 1,
  borderColor: selected ? kit.needs : hold ? kit.needsLine : kit.hairline,
  backgroundColor: selected ? kit.needsSoft : kit.bg,
  padding: 16,
  gap: 10,
  shadowColor: "#0c101a",
  shadowOpacity: selected ? 0 : 0.05,
  shadowRadius: 3,
  shadowOffset: { width: 0, height: 1 },
});

/** The card's well: a label and a monospace line ("Action  gh pr merge 933"). */
function Well({ theme, label, value }: { theme: PluginTheme; label: string; value: string }) {
  const kit = kitOf(theme);
  return (
    <View style={{ flexDirection: "row", gap: 10, padding: 10, borderRadius: 10, backgroundColor: kit.sunken }}>
      <Text style={{ color: kit.muted, fontSize: 12.5 }}>{label}</Text>
      <Text style={{ flex: 1, color: kit.fg, fontSize: 12.5, fontFamily: MONO }} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

/** The verbs of a card, secondary first and the one primary last: `onVerb` with the verb's id. */
function Verbs({
  theme,
  kind,
  label,
  onVerb,
}: {
  theme: PluginTheme;
  kind: Parameters<typeof verbsFor>[0];
  label?: string;
  onVerb: (id: string) => void;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      {verbsFor(kind, label).map((verb) => (
        <Pill
          key={verb.id}
          theme={theme}
          label={verb.label}
          primary={verb.primary}
          height={40}
          onPress={() => onVerb(verb.id)}
        />
      ))}
    </View>
  );
}

/** A hold as a full card (J1's Needs you): its kind's body, what it waits on, and its verbs. */
export function HoldCard({
  theme,
  entry,
  now,
  selected,
  onSelect,
  onVerb,
}: {
  theme: PluginTheme;
  entry: NeedEntry;
  now: number;
  selected: boolean;
  onSelect: () => void;
  onVerb: (id: string) => void;
}) {
  const kit = kitOf(theme);
  const { row } = entry;
  const kind = holdKindOf(row);
  const look = KIND_LOOK[kind];
  const evidence = evidenceLine(row);
  const session = row.session
    ? `session ${row.session.name} is ${row.session.waiting ? "waiting" : "not waiting"}`
    : null;
  return (
    <View testID={`hold-${row.key}`} style={cardBox(kit, selected, true)}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${look.label}: ${row.title}`}
        accessibilityState={{ selected }}
        onPress={onSelect}
        style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({
          ...focusRing(theme, focused),
          opacity: pressed ? 0.85 : 1,
          gap: 10,
          borderRadius: 12,
        })}
      >
        <Kicker theme={theme} icon={look.icon} parts={holdKicker(entry)} age={ago(row.since, now)} />
        <Text style={{ color: kit.fg, fontSize: 18, fontWeight: "600", lineHeight: 24 }}>{row.title}</Text>
        {row.kind === "approval" ? <Well theme={theme} label="Action" value={row.body.action} /> : null}
        {row.kind === "owner_step" ? <Well theme={theme} label="Where" value={row.body.where} /> : null}
        {evidence ? (
          <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
            <Icon name="CircleCheck" size={14} color={kit.ok} />
            <Text style={{ flex: 1, color: kit.fg2, fontSize: 12.5, lineHeight: 17 }} numberOfLines={2}>
              {evidence}
            </Text>
          </View>
        ) : null}
        {row.kind === "owner_step" ? (
          <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
            <Icon name="Info" size={14} color={kit.info} />
            <Text style={{ flex: 1, color: kit.fg2, fontSize: 12.5, lineHeight: 17 }} numberOfLines={2}>
              {row.body.doneCheck}
            </Text>
          </View>
        ) : null}
        {row.kind === "ask" ? (
          <Text style={{ color: kit.fg2, fontSize: 13, lineHeight: 18 }} numberOfLines={2}>
            {row.body.why || row.body.cost || `${plural(row.body.options.length, "option")}`}
          </Text>
        ) : null}
      </Pressable>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingHorizontal: 10,
            height: 26,
            borderRadius: 9999,
            backgroundColor: kit.needsSoft,
          }}
        >
          <Dot color={kit.needs} size={6} />
          <Text style={{ color: kit.needs, fontSize: 12.5, fontWeight: "500" }}>Needs you · {holdChipWords(row)}</Text>
        </View>
        {session ? (
          <Text style={{ flex: 1, color: kit.muted, fontSize: 12.5 }} numberOfLines={1}>
            {session}
          </Text>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        <Verbs theme={theme} kind={kind} label={primaryLabel(row)} onVerb={onVerb} />
      </View>
    </View>
  );
}

/** A row of watched things: a card without a ring, two lines, its verbs at the end. */
function WatchedShell({
  theme,
  selected,
  icon,
  iconColor,
  kicker,
  age,
  title,
  line,
  onSelect,
  label,
  trailing,
}: {
  theme: PluginTheme;
  selected: boolean;
  icon: string;
  iconColor: string;
  kicker: readonly string[];
  age?: string;
  title: string;
  line?: string | null;
  onSelect: () => void;
  label: string;
  trailing: ReactNode;
}) {
  const kit = kitOf(theme);
  return (
    <View
      style={{ ...cardBox(kit, selected, false), padding: 14, flexDirection: "row", alignItems: "center", gap: 12 }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected }}
        onPress={onSelect}
        style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({
          ...focusRing(theme, focused),
          opacity: pressed ? 0.85 : 1,
          flex: 1,
          gap: 4,
          borderRadius: 10,
        })}
      >
        <Kicker theme={theme} icon={icon} iconColor={iconColor} parts={kicker} age={age} />
        <Text style={{ color: kit.fg, fontSize: 15, fontWeight: "600" }} numberOfLines={1}>
          {title}
        </Text>
        {line ? (
          <Text style={{ color: kit.fg2, fontSize: 12.5 }} numberOfLines={1}>
            {line}
          </Text>
        ) : null}
      </Pressable>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>{trailing}</View>
    </View>
  );
}

/** Work that landed with nothing held on you: Continue and Change course when a session can be prompted, else Open. */
export function FinishedRow({
  theme,
  item,
  now,
  selected,
  canPrompt,
  onSelect,
  onVerb,
}: {
  theme: PluginTheme;
  item: WorkItem;
  now: number;
  selected: boolean;
  /** Whether Continue and Change course have a call yet (BRO-2999's session.prompt). */
  canPrompt: boolean;
  onSelect: () => void;
  onVerb: (id: "open" | "continue" | "course") => void;
}) {
  const kit = kitOf(theme);
  return (
    <WatchedShell
      theme={theme}
      selected={selected}
      icon="CircleCheck"
      iconColor={kit.ok}
      kicker={[workScope(item), item.ticket ?? ""].filter(Boolean)}
      age={ago(item.updatedAt, now)}
      title={titleText(item)}
      line={item.phase ? `Next ${item.phase}` : null}
      onSelect={onSelect}
      label={`Finished: ${titleText(item)}`}
      trailing={
        canPrompt ? (
          <>
            <Pill theme={theme} label="Change course" height={40} onPress={() => onVerb("course")} />
            <Pill theme={theme} label="Continue" primary height={40} onPress={() => onVerb("continue")} />
          </>
        ) : (
          <Pill theme={theme} label="Open" primary height={40} onPress={() => onVerb("open")} />
        )
      }
    />
  );
}

/** What you watch that went wrong: a notice row. Stuck work opens its inspector (Unblock); a schedule or loop opens its tab. */
export function HealthRowView({
  theme,
  row,
  now,
  selected,
  onSelect,
  onVerb,
}: {
  theme: PluginTheme;
  row: HealthRow;
  now: number;
  selected: boolean;
  onSelect: () => void;
  onVerb: (id: "open" | "unblock") => void;
}) {
  const kit = kitOf(theme);
  return (
    <WatchedShell
      theme={theme}
      selected={selected}
      icon="CircleAlert"
      iconColor={kit.warn}
      kicker={[row.item ? workScope(row.item) : "health"]}
      age={row.since ? ago(row.since, now) : undefined}
      title={row.title}
      line={row.detail}
      onSelect={onSelect}
      label={`Health: ${row.title}`}
      trailing={
        row.item ? (
          <Pill theme={theme} label="Unblock…" primary height={40} onPress={() => onVerb("unblock")} />
        ) : (
          <Pill theme={theme} label="Open" height={40} onPress={() => onVerb("open")} />
        )
      }
    />
  );
}

/** Running work: its card wears the Undertow (B1: Running only). */
export function RunningRow({
  theme,
  item,
  now,
  selected,
  onSelect,
}: {
  theme: PluginTheme;
  item: WorkItem;
  now: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const kit = kitOf(theme);
  return (
    <Undertow theme={theme} state={item.state} radius={18}>
      <WatchedShell
        theme={theme}
        selected={selected}
        icon="LoaderCircle"
        iconColor={kit.blue}
        kicker={[workScope(item), item.ticket ?? ""].filter(Boolean)}
        age={ago(item.updatedAt, now)}
        title={titleText(item)}
        line={item.phase}
        onSelect={onSelect}
        label={`Running: ${titleText(item)}`}
        trailing={null}
      />
    </Undertow>
  );
}

/** Queued work, grouped on one line each. */
export function QueuedList({
  theme,
  items,
  now,
  onSelect,
}: {
  theme: PluginTheme;
  items: readonly WorkItem[];
  now: number;
  onSelect: (id: string) => void;
}) {
  const kit = kitOf(theme);
  return (
    <View
      style={{
        borderRadius: 14,
        borderWidth: 1,
        borderColor: kit.hairline,
        backgroundColor: kit.bg,
        overflow: "hidden",
      }}
    >
      {items.map((item, at) => (
        <Pressable
          key={item.id}
          accessibilityRole="button"
          accessibilityLabel={`Queued: ${titleText(item)}`}
          onPress={() => onSelect(item.id)}
          style={({ pressed }: { pressed: boolean }) => ({
            minHeight: 40,
            paddingHorizontal: 14,
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            borderTopWidth: at === 0 ? 0 : 1,
            borderTopColor: kit.hairline,
            backgroundColor: pressed ? kit.sunken : "transparent",
          })}
        >
          <Text style={{ color: kit.muted, fontSize: 12, fontFamily: MONO }}>{workScope(item)}</Text>
          <Text style={{ flex: 1, color: kit.fg, fontSize: 13.5 }} numberOfLines={1}>
            {titleText(item)}
          </Text>
          <Text style={{ color: kit.muted, fontSize: 12, ...TABULAR }}>{ago(item.updatedAt, now)}</Text>
        </Pressable>
      ))}
    </View>
  );
}

// ── The rail ─────────────────────────────────────────────────────────────────

function RailCard({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  const kit = kitOf(theme);
  return (
    <View
      style={{
        borderRadius: 16,
        borderWidth: 1,
        borderColor: kit.hairline,
        backgroundColor: kit.bg,
        padding: 14,
        gap: 8,
      }}
    >
      {children}
    </View>
  );
}

/** Decide: the open asks that do not wait on you, a few, and the way to the rest. */
export function DecideRail({
  theme,
  rows,
  more,
  onOpen,
}: {
  theme: PluginTheme;
  rows: readonly DecideRow[];
  more: number;
  onOpen: (ask: DecisionAsk | null) => void;
}) {
  const kit = kitOf(theme);
  if (rows.length === 0) return null;
  return (
    <RailCard theme={theme}>
      <SectionHeading theme={theme} title="Decide" count={rows.length + more} hint="open, not waiting on you" />
      {rows.map((row) => (
        <Pressable
          key={row.ask.id + row.ask.ledger}
          accessibilityRole="button"
          accessibilityLabel={`Decide: ${row.headline}`}
          onPress={() => onOpen(row.ask)}
          style={({ pressed }: { pressed: boolean }) => ({
            gap: 2,
            padding: 8,
            borderRadius: 10,
            backgroundColor: pressed ? kit.sunken : "transparent",
          })}
        >
          <Text style={{ color: kit.fg, fontSize: 13.5, fontWeight: "500" }} numberOfLines={2}>
            {row.headline}
          </Text>
          <Text style={{ color: kit.muted, fontSize: 12 }} numberOfLines={1}>
            {[row.where, row.silent].filter(Boolean).join(" · ")}
          </Text>
        </Pressable>
      ))}
      {more > 0 ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`${more} more in Decisions`}
          onPress={() => onOpen(null)}
        >
          <Text style={{ color: kit.info, fontSize: 12.5, fontWeight: "500" }}>{more} more in Decisions ›</Text>
        </Pressable>
      ) : null}
    </RailCard>
  );
}

/** Handled for you: who closed what without you this week. */
export function HandledRail({
  theme,
  groups,
  onOpenWork,
}: {
  theme: PluginTheme;
  groups: readonly HandledGroup[];
  onOpenWork: (id: string) => void;
}) {
  const kit = kitOf(theme);
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);
  if (total === 0) return null;
  return (
    <RailCard theme={theme}>
      <SectionHeading theme={theme} title="Handled for you" count={total} hint="closed without you this week" />
      {groups.map((group) => (
        <View key={group.by} style={{ gap: 2 }}>
          <Text style={{ color: kit.fg2, fontSize: 12.5, fontWeight: "600", paddingVertical: 4 }}>
            {handledTitle(group)}
          </Text>
          {group.rows.slice(0, HANDLED_NAMED).map((row) => {
            const hold = holdOf(row.key);
            return (
              <Pressable
                key={row.key}
                accessibilityRole="button"
                accessibilityLabel={`Handled: ${row.title}`}
                disabled={hold?.kind !== "work"}
                onPress={() => hold?.kind === "work" && onOpenWork(hold.id)}
                style={({ pressed }: { pressed: boolean }) => ({
                  padding: 6,
                  borderRadius: 8,
                  backgroundColor: pressed ? kit.sunken : "transparent",
                })}
              >
                <Text style={{ color: kit.fg, fontSize: 12.5 }} numberOfLines={1}>
                  {row.title}
                </Text>
              </Pressable>
            );
          })}
          {group.rows.length > HANDLED_NAMED ? (
            <Text style={{ color: kit.muted, fontSize: 12, paddingHorizontal: 6 }}>
              and {group.rows.length - HANDLED_NAMED} more
            </Text>
          ) : null}
        </View>
      ))}
    </RailCard>
  );
}

/** Proposals: answers that wait for the conductor, filed as work or dismissed (BRO-2990). */
export function ProposalsRail({
  theme,
  asks,
  onVerb,
}: {
  theme: PluginTheme;
  asks: readonly DecisionAsk[];
  onVerb: (key: string, verb: "file" | "dismiss") => void;
}) {
  const kit = kitOf(theme);
  if (asks.length === 0) return null;
  return (
    <RailCard theme={theme}>
      <SectionHeading theme={theme} title="Proposals" count={asks.length} hint="waiting for the conductor" />
      {asks.map((ask) => {
        const key = ask.fate?.key ?? "";
        return (
          <View key={key || ask.id} style={{ gap: 8, padding: 8 }}>
            <Text style={{ color: kit.fg, fontSize: 13.5, fontWeight: "500" }} numberOfLines={2}>
              {ask.headline || ask.id}
            </Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Pill theme={theme} label="Dismiss" height={34} disabled={!key} onPress={() => onVerb(key, "dismiss")} />
              <Pill
                theme={theme}
                label="File as work"
                primary
                height={34}
                disabled={!key}
                onPress={() => onVerb(key, "file")}
              />
            </View>
          </View>
        );
      })}
    </RailCard>
  );
}
