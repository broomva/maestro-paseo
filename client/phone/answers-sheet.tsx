// What the Decisions sheet holds (M5 frame 2): "Your answers", four tiles with the stranded ones loudest (Waiting to
// land is a warn tile with its verb, which opens the landing PR and never merges it), then where your last answers
// went, each with the one word for its stage. The tiles and rows are J5's models (client/decisions-stage-model.ts);
// nothing is recounted here.

import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import type { StageTiles, WentRow } from "../decisions-stage-model";
import { GlanceTile } from "../kit/glance-tile";
import { Pill } from "../kit/parts";
import { kitOf } from "../kit/tokens";
import type { OpenAskRow } from "./model";
import { LedgerWarnings, OpenAsks } from "./open-asks";

const CHIP_TONE = { ok: "ok", info: "info", warn: "warn", muted: "muted" } as const;

export function AnswersSheet({
  theme,
  tiles,
  held,
  went,
  open,
  warnings,
  onOpenAsk,
  onOpenPr,
}: {
  theme: PluginTheme;
  tiles: StageTiles;
  /** answers.status's `held`: answers waiting for the conductor to give them to a lane (A8); null when unread. */
  held: number | null;
  /** Where your last answers went; null when answers.status could not be read (said, never an empty list). */
  went: readonly WentRow[] | null;
  /** The open asks that do not wait on you (BRO-3108); null when asks.workspace could not be read (said, never "none"). */
  open: readonly OpenAskRow[] | null;
  /** asks.workspace's ledger read warnings; null when it could not be read. */
  warnings: readonly string[] | null;
  onOpenAsk: (key: string) => void;
  onOpenPr: (url: string) => void;
}) {
  const kit = kitOf(theme);
  const color = (tone: keyof typeof CHIP_TONE) =>
    tone === "ok" ? kit.ok : tone === "info" ? kit.info : tone === "warn" ? kit.warn : kit.muted;
  const verb = tiles.landing.verb;
  return (
    <View style={{ gap: 14 }}>
      {warnings ? <LedgerWarnings theme={theme} warnings={warnings} /> : null}
      {open === null ? (
        <Text accessibilityRole="alert" style={{ color: kit.warn, fontSize: 13.5, paddingHorizontal: 4 }}>
          Couldn't read the open asks: the ones that do not block you may be missing.
        </Text>
      ) : (
        <OpenAsks theme={theme} rows={open} onOpen={onOpenAsk} />
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        {(
          [
            ["TriangleAlert", "Waiting to land", tiles.landing],
            ["Send", "Routed", tiles.routed],
            ["Check", "Acted on", tiles.acted],
            [
              "Lock",
              "Held",
              {
                value: held ?? 0,
                unit: "for the conductor",
                line: held === null ? "Not read yet." : "Nothing starts until a lane takes them (A8).",
                tone: "plain" as const,
              },
            ],
          ] as const
        ).map(([icon, label, tile]) => (
          <View key={label} style={{ flexBasis: "47%", flexGrow: 1, flexDirection: "row" }}>
            <GlanceTile
              theme={theme}
              compact
              icon={icon}
              label={label}
              value={String(tile.value)}
              unit={"unit" in tile ? tile.unit : undefined}
              line={tile.line}
              tone={tile.tone}
              lines={3}
            />
          </View>
        ))}
      </View>
      {verb ? (
        <View style={{ flexDirection: "row" }}>
          <Pill theme={theme} label={verb.label} primary height={44} onPress={() => onOpenPr(verb.url)} />
        </View>
      ) : null}
      <Text accessibilityRole="header" style={{ color: kit.fg, fontSize: 15, fontWeight: "600", paddingHorizontal: 4 }}>
        Where your last answers went
      </Text>
      {went === null ? (
        <Text style={{ color: kit.warn, fontSize: 13.5, paddingHorizontal: 4 }}>
          Couldn't read where your answers went. Nothing is hidden: it reads again in a moment.
        </Text>
      ) : went.length === 0 ? (
        <Text style={{ color: kit.muted, fontSize: 13.5, paddingHorizontal: 4 }}>
          You haven't answered anything yet.
        </Text>
      ) : (
        <View style={{ borderRadius: 14, overflow: "hidden", gap: 1, backgroundColor: kit.hairline }}>
          {went.map((row) => (
            <View
              key={row.key}
              accessible
              accessibilityLabel={`${row.title}. ${row.line}. ${row.chip.word}`}
              style={{
                backgroundColor: kit.bg,
                paddingVertical: 10,
                paddingHorizontal: 14,
                flexDirection: "row",
                gap: 10,
              }}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <Text numberOfLines={2} style={{ color: kit.fg, fontSize: 15 }}>
                  {row.title}
                </Text>
                <Text numberOfLines={2} style={{ color: kit.muted, fontSize: 12.5 }}>
                  {row.line}
                </Text>
              </View>
              <Text style={{ color: color(row.chip.tone), fontSize: 12.5, fontWeight: "600" }}>{row.chip.word}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
