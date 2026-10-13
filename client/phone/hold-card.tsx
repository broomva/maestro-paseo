// A hold as the phone's deck draws it (M1 frames 1, 3 and 4; M5; M8 frame 1): the kicker, a large title, why it
// is yours, the kind's evidence (an approval's four facts, an ask's options as 44 pt rows with the silent
// default's countdown, an owner step's where, a review's three answers) and the kind's verbs as 52 pt pills.
// The model decides what is offered (client/phone/model.ts); this draws it and hands every press up.

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import { tint } from "../fleet-color";
import { DeckHold } from "../kit/deck";
import type { Choice, InspectorItem } from "../kit/inspector";
import { KIND_LOOK } from "../kit/inspector-model";
import { Dot, MONO, TABULAR } from "../kit/parts";
import { kitOf } from "../kit/tokens";
import type { DeckVerbSpec } from "./model";

/** An option's row is at least this tall: 1–3 have no phone equivalent, so the rows are the thumb's (M5). */
const OPTION_HEIGHT = 44;

function OptionRows({
  theme,
  title,
  options,
  chosen,
  armed,
  disabled,
  onChoose,
}: {
  theme: PluginTheme;
  title: string;
  options: readonly Choice[];
  chosen: string | undefined;
  /** The chosen option cannot be undone and its first press was made: the rows say so. */
  armed: boolean;
  disabled: boolean;
  onChoose: (id: string) => void;
}) {
  const kit = kitOf(theme);
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={`Options for ${title}`} style={{ gap: 8 }}>
      {options.map((option) => {
        const on = option.id === chosen;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="radio"
            accessibilityLabel={`${option.label}${option.recommended ? ", recommended" : ""}${option.irreversible ? ", cannot be undone" : ""}`}
            accessibilityState={{ checked: on, disabled }}
            disabled={disabled}
            onPress={() => onChoose(option.id)}
            style={({ pressed }: { pressed: boolean }) => ({
              minHeight: OPTION_HEIGHT,
              borderRadius: 12,
              borderWidth: on ? 1.5 : 1,
              borderColor: on ? (armed ? kit.warn : kit.info) : kit.hairline,
              backgroundColor: on ? (armed ? kit.warnSoft : kit.needsSoft) : kit.bg,
              paddingVertical: 8,
              paddingHorizontal: 12,
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <View
              style={{
                width: 20,
                height: 20,
                borderRadius: 10,
                borderWidth: 1.5,
                borderColor: on ? kit.info : tint(kit.fg, 0.35),
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {on ? <Icon name="Check" size={13} color={kit.info} /> : null}
            </View>
            <View style={{ flex: 1, gap: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <Text style={{ color: kit.fg, fontSize: 15, fontWeight: "600" }}>{option.label}</Text>
                {option.recommended ? (
                  <Text style={{ color: kit.ok, fontSize: 11, fontWeight: "600" }}>Rec.</Text>
                ) : null}
              </View>
              {option.note ? (
                <Text style={{ color: kit.muted, fontSize: 12.5, lineHeight: 17 }}>{option.note}</Text>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The silent default and how far its countdown has run, as M5 draws it under the options. */
function Silence({ theme, line, elapsed }: { theme: PluginTheme; line: string; elapsed?: number }) {
  const kit = kitOf(theme);
  return (
    <View style={{ gap: 6 }}>
      {elapsed !== undefined ? (
        <View style={{ height: 3, borderRadius: 2, backgroundColor: tint(kit.fg, 0.1) }}>
          <View
            style={{
              height: 3,
              borderRadius: 2,
              width: `${Math.round(Math.min(1, Math.max(0, elapsed)) * 100)}%`,
              backgroundColor: kit.info,
            }}
          />
        </View>
      ) : null}
      <Text style={{ color: kit.muted, fontSize: 12.5, lineHeight: 17 }}>{line}</Text>
    </View>
  );
}

function Facts({ theme, item }: { theme: PluginTheme; item: Extract<InspectorItem, { kind: "approval" }> }) {
  const kit = kitOf(theme);
  if (item.evidence.length === 0) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {item.evidence.map((fact) => (
        <View
          key={fact.label}
          style={{ flexBasis: "46%", flexGrow: 1, backgroundColor: kit.sunken, borderRadius: 10, padding: 10, gap: 2 }}
        >
          <Text style={{ color: kit.muted, fontSize: 11.5 }}>{fact.label}</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Dot color={fact.tone === "warn" ? kit.warn : fact.tone === "danger" ? kit.danger : kit.ok} />
            <Text style={{ color: kit.fg, fontSize: 15, fontWeight: "600", ...TABULAR }}>{fact.value}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

export function HoldCard({
  theme,
  item,
  verbs,
  choice,
  armed,
  waiting,
  busy,
  words,
  onChoose,
  onWords,
  onDetails,
  onVerb,
}: {
  theme: PluginTheme;
  item: InspectorItem;
  verbs: readonly DeckVerbSpec[];
  /** The option an ask or a review has chosen now. */
  choice: string | undefined;
  /** An option that cannot be undone has had its first press: the primary asks for the second. */
  armed: boolean;
  /** What waits out its undo window on this hold ("Allowed · applies in 6 s"): its verbs cannot be pressed again. */
  waiting: string | null;
  /** A call on this hold is in flight. */
  busy: boolean;
  /** Your words, for an ask written with no options: the only way to answer it (M3 has no field when there are options). */
  words: string;
  onChoose: (id: string) => void;
  onWords: (text: string) => void;
  onDetails: () => void;
  onVerb: (id: string) => void;
}) {
  const kit = kitOf(theme);
  const look = KIND_LOOK[item.kind];
  const options = item.kind === "ask" || item.kind === "review" ? item.options : [];
  const chosen = options.find((option) => option.id === choice);
  const locked = waiting !== null || busy;
  const inWords = item.kind === "ask" && options.length === 0;
  const summary =
    item.kind === "ask"
      ? [item.cost ? `Waiting costs: ${item.cost}` : null, item.whyYou ? `Why you: ${item.whyYou}` : null]
          .filter(Boolean)
          .join(" ") || item.summary
      : item.summary;
  return (
    <DeckHold
      theme={theme}
      icon={look.icon}
      kicker={[look.label, ...item.kicker]}
      age={item.age}
      title={item.title}
      summary={summary}
      onDetails={onDetails}
      verbs={verbs.map((verb) => {
        const answer = verb.id === "answer";
        // An answer names the option it sends (J3), and asks for a second press when it cannot be undone.
        const label = answer && chosen && armed ? `Confirm: ${chosen.label}` : verb.label;
        return {
          label,
          primary: verb.primary,
          accessibilityLabel: answer && chosen ? `${armed ? "Confirm" : "Answer"} with ${chosen.label}` : undefined,
          disabled: locked || (answer && options.length > 0 && !chosen) || (answer && inWords && words.trim() === ""),
          onPress: () => onVerb(verb.id),
        };
      })}
    >
      {item.kind === "approval" ? <Facts theme={theme} item={item} /> : null}
      {item.kind === "owner_step" ? (
        <View style={{ backgroundColor: kit.sunken, borderRadius: 10, padding: 10, gap: 3 }}>
          <Text style={{ color: kit.muted, fontSize: 11.5 }}>Where</Text>
          <Text style={{ color: kit.fg, fontSize: 13, fontFamily: MONO }}>{item.where}</Text>
        </View>
      ) : null}
      {item.kind === "review" && item.hanging?.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {item.hanging.map((tile) => (
            <View
              key={tile.label}
              style={{
                height: 28,
                paddingHorizontal: 10,
                borderRadius: 9999,
                backgroundColor: kit.sunken,
                justifyContent: "center",
              }}
            >
              <Text style={{ color: kit.fg2, fontSize: 12.5, ...TABULAR }}>{`${tile.value} ${tile.label}`}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {inWords ? (
        <View style={{ gap: 6 }}>
          <Text style={{ color: kit.muted, fontSize: 12.5 }}>
            No options were written for this ask: answer it in your own words.
          </Text>
          <TextInput
            accessibilityLabel={`Your words for ${item.title}`}
            value={words}
            onChangeText={onWords}
            editable={!locked}
            multiline
            placeholder="Your words"
            placeholderTextColor={kit.muted}
            style={{
              minHeight: 76,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: kit.hairline,
              backgroundColor: kit.bg,
              color: kit.fg,
              fontSize: 15,
              paddingHorizontal: 12,
              paddingVertical: 10,
            }}
          />
        </View>
      ) : null}
      {options.length > 0 ? (
        <OptionRows
          theme={theme}
          title={item.title}
          options={options}
          chosen={choice}
          armed={armed}
          disabled={locked}
          onChoose={onChoose}
        />
      ) : null}
      {armed ? (
        <Text accessibilityLiveRegion="polite" style={{ color: kit.warn, fontSize: 13, fontWeight: "600" }}>
          This cannot be undone. Press again to confirm.
        </Text>
      ) : null}
      {item.kind === "ask" && item.fallback ? (
        <Silence theme={theme} line={item.fallback.line} elapsed={item.fallback.elapsed} />
      ) : null}
      {waiting ? (
        <Text accessibilityLiveRegion="polite" style={{ color: kit.info, fontSize: 13, fontWeight: "600" }}>
          {waiting}
        </Text>
      ) : null}
    </DeckHold>
  );
}
