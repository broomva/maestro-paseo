// The parts every Maestro card is drawn from (BRO-3008, K1): one anatomy for every kind. A frame with a kicker,
// the one decision, a well for the exact action, evidence, at most two verbs and Open in Maestro; and its other
// faces: the undo capsule, the one-line receipt, and "couldn't read". The model decides which face
// (client/card-model.ts); nothing here reads or counts. React Native primitives and the kit's tokens only.

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { CardKind } from "../shared/card";
import type { Evidence } from "../shared/needs";
import { KIND_LOOK } from "./kit/inspector-model";
import { Dot, MONO, TABULAR } from "./kit/parts";
import { kitOf } from "./kit/tokens";
import { secondsLeft } from "./pending-model";
import { focusRing } from "./ui";
import { useTick } from "./use-tick";

/** What each card kind is called and drawn with (K1's kickers). */
export const CARD_LOOK: Record<CardKind, { label: string; icon: string }> = {
  approval: KIND_LOOK.approval,
  ask: KIND_LOOK.ask,
  owner_step: KIND_LOOK.owner_step,
  finished: { label: "Finished", icon: "CircleCheck" },
  health: { label: "Health", icon: "TriangleAlert" },
  digest: { label: "Needs you", icon: "Inbox" },
};

/** The time of day a receipt was written, as the card says it ("15:12"). */
export function clockOf(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** The card's box: a hold wears the Tidepool ring, watched work the whisper line (K1). */
export function CardFrame({
  theme,
  ring,
  testID,
  children,
}: {
  theme: PluginTheme;
  ring: boolean;
  testID?: string;
  children: ReactNode;
}) {
  const kit = kitOf(theme);
  return (
    <View
      testID={testID}
      style={{
        borderRadius: 16,
        borderWidth: ring ? 1.5 : 1,
        borderColor: ring ? kit.needsLine : kit.hairline,
        backgroundColor: kit.bg,
        padding: 16,
        gap: 10,
        maxWidth: 560,
        marginVertical: 8,
        shadowColor: "#0c101a",
        shadowOpacity: 0.05,
        shadowRadius: 3,
        shadowOffset: { width: 0, height: 1 },
      }}
    >
      {children}
    </View>
  );
}

/** The exact action or place, in a mono well (K1's `gh pr merge 933 …`). */
export function Well({ theme, value, label }: { theme: PluginTheme; value: string; label?: string }) {
  const kit = kitOf(theme);
  return (
    <View style={{ flexDirection: "row", gap: 10, padding: 10, borderRadius: 10, backgroundColor: kit.sunken }}>
      {label ? <Text style={{ color: kit.muted, fontSize: 12.5 }}>{label}</Text> : null}
      <Text selectable style={{ flex: 1, color: kit.fg, fontSize: 12.5, fontFamily: MONO }} numberOfLines={4}>
        {value}
      </Text>
    </View>
  );
}

/** A dark log block (K1's Health card): what the session printed when it stopped. */
export function LogWell({ theme, lines }: { theme: PluginTheme; lines: readonly string[] }) {
  const kit = kitOf(theme);
  return (
    <View style={{ padding: 12, borderRadius: 10, backgroundColor: kit.toastBg, gap: 2 }}>
      {lines.map((line, at) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: a log is positional and never reorders.
          key={`${at}:${line}`}
          selectable
          style={{ color: kit.toastFg, fontSize: 12, fontFamily: MONO, lineHeight: 17 }}
        >
          {line}
        </Text>
      ))}
    </View>
  );
}

const TONE_ICON: Record<Evidence["tone"], string | null> = {
  ok: "CircleCheck",
  warn: "CircleAlert",
  danger: "CircleX",
  muted: null,
};

/** The facts a hold's evidence names: "✓ checks 7/7 · ✓ P20 8·9·8", each with its color and its words. */
export function EvidenceRow({ theme, facts }: { theme: PluginTheme; facts: readonly Evidence[] }) {
  const kit = kitOf(theme);
  if (facts.length === 0) return null;
  const tone = (fact: Evidence) =>
    fact.tone === "ok" ? kit.ok : fact.tone === "warn" ? kit.warn : fact.tone === "danger" ? kit.danger : kit.muted;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 4 }}>
      {facts.map((fact) => {
        const icon = TONE_ICON[fact.tone];
        return (
          <View
            key={`${fact.label}:${fact.value}`}
            style={{ flexDirection: "row", alignItems: "center", gap: 5, flexShrink: 1, maxWidth: "100%" }}
          >
            {icon ? <Icon name={icon} size={13} color={tone(fact)} /> : null}
            <Text style={{ color: kit.fg2, fontSize: 12.5, flexShrink: 1 }}>{`${fact.label} ${fact.value}`}</Text>
          </View>
        );
      })}
    </View>
  );
}

/** Open in Maestro: the link at the end of every card's verbs (K1). */
export function OpenLink({
  theme,
  onPress,
  label = "Open in Maestro",
}: {
  theme: PluginTheme;
  onPress: () => void;
  label?: string;
}) {
  const kit = kitOf(theme);
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({
        ...focusRing(theme, focused),
        marginLeft: "auto",
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        borderRadius: 6,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ color: kit.info, fontSize: 13.5, fontWeight: "500" }}>{label}</Text>
      <Icon name="ArrowUpRight" size={14} color={kit.info} />
    </Pressable>
  );
}

/**
 * The 8 s window, in place (K1's "After you act"): what was done and when it takes effect, with Undo. It counts to
 * the ledger's own `appliesAt`, so the card, J1's toast and the other surface count down together.
 */
export function UndoCapsule({
  theme,
  label,
  appliesAt,
  busy,
  onUndo,
}: {
  theme: PluginTheme;
  label: string;
  appliesAt: string;
  busy: boolean;
  onUndo: () => void;
}) {
  const kit = kitOf(theme);
  const now = useTick(250);
  const left = secondsLeft(Date.parse(appliesAt) - now);
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      testID="card-undo"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        minHeight: 54,
        borderRadius: 16,
        paddingVertical: 8,
        paddingLeft: 16,
        paddingRight: 8,
        marginVertical: 8,
        maxWidth: 560,
        backgroundColor: kit.toastBg,
      }}
    >
      <Icon name="Check" size={16} color={kit.toastOk} />
      <View style={{ flex: 1 }}>
        <Text numberOfLines={2} style={{ color: kit.toastFg, fontSize: 14, fontWeight: "600" }}>
          {label}
        </Text>
        <Text style={{ color: kit.toastFg, opacity: 0.7, fontSize: 12.5, ...TABULAR }}>
          {left > 0 ? `takes effect in ${left} s` : "taking effect now"}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Undo: ${label}`}
        accessibilityState={{ disabled: busy, busy }}
        disabled={busy || left <= 0}
        onPress={onUndo}
        style={({ pressed }) => ({
          height: 36,
          paddingHorizontal: 16,
          borderRadius: 9999,
          justifyContent: "center",
          backgroundColor: kit.dark ? "rgba(12, 16, 26, 0.1)" : "rgba(255, 255, 255, 0.15)",
          opacity: busy || left <= 0 ? 0.5 : pressed ? 0.7 : 1,
        })}
      >
        <Text style={{ color: kit.toastFg, fontSize: 13.5, fontWeight: "600" }}>Undo</Text>
      </Pressable>
    </View>
  );
}

/**
 * What a card becomes once it settles: one quiet line under its kicker (K1's receipt, answered elsewhere). A
 * warm tone marks a decision that was dropped, so a dropped Allow never reads like a done one.
 */
export function SettledLine({
  theme,
  kind,
  head,
  words,
  at,
  tone = "ok",
  after,
}: {
  theme: PluginTheme;
  kind: CardKind;
  /** "receipt", "answered elsewhere", "superseded": what became of it, after the kind. */
  head: string;
  words: string;
  at?: string;
  tone?: "ok" | "warn" | "muted";
  after?: ReactNode;
}) {
  const kit = kitOf(theme);
  const color = tone === "ok" ? kit.ok : tone === "warn" ? kit.warn : kit.muted;
  return (
    <View
      testID="card-settled"
      style={{
        borderRadius: 14,
        borderWidth: 1,
        borderColor: kit.hairline,
        backgroundColor: kit.sunken,
        paddingVertical: 10,
        paddingHorizontal: 14,
        gap: 4,
        maxWidth: 560,
        marginVertical: 8,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name={tone === "warn" ? "CircleAlert" : "Check"} size={14} color={color} />
        <Text style={{ flex: 1, color: kit.muted, fontSize: 12.5 }} numberOfLines={1}>
          {`${CARD_LOOK[kind].label} · ${head}`}
        </Text>
        {at ? <Text style={{ color: kit.muted, fontSize: 12.5, ...TABULAR }}>{at}</Text> : null}
      </View>
      <Text selectable style={{ color: kit.fg2, fontSize: 14, lineHeight: 20 }}>
        {words}
      </Text>
      {after}
    </View>
  );
}

/** "Needs you · …": the chip that says a hold is yours, with its dot. */
export function NeedsChip({ theme, words }: { theme: PluginTheme; words: string }) {
  const kit = kitOf(theme);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 10,
        height: 24,
        borderRadius: 9999,
        backgroundColor: kit.needsSoft,
        alignSelf: "flex-start",
      }}
    >
      <Dot color={kit.needs} size={6} />
      <Text style={{ color: kit.needs, fontSize: 12.5, fontWeight: "500" }}>{words}</Text>
    </View>
  );
}
