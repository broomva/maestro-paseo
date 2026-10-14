// What the Decisions sheet adds above "Where your last answers went" (BRO-3108): the open asks that do not wait on you
// ("Open, not blocking": answerable, but never a hold, so never on the deck), and the ledgers that could not be read.
// A row opens the same inspector card a deck hold does, so an answer is the same verb. The rows are model.ts's
// openAsks; nothing is recounted here.

import type { PluginTheme } from "@getpaseo/plugin";
import { Pressable, Text, View } from "react-native";
import { kitOf } from "../kit/tokens";
import type { OpenAskRow } from "./model";

/** Ledger files Maestro could not read, in words: their asks are missing because the read failed, not because they were answered. */
export function LedgerWarnings({ theme, warnings }: { theme: PluginTheme; warnings: readonly string[] }) {
  const kit = kitOf(theme);
  if (warnings.length === 0) return null;
  return (
    <View
      accessibilityRole="alert"
      style={{ borderRadius: 14, backgroundColor: kit.hairline, paddingVertical: 10, paddingHorizontal: 14, gap: 4 }}
    >
      <Text style={{ color: kit.warn, fontSize: 13.5, fontWeight: "600" }}>
        {`${warnings.length === 1 ? "A read warning" : `${warnings.length} read warnings`}: some asks may be missing.`}
      </Text>
      {warnings.map((warning) => (
        <Text key={warning} numberOfLines={2} style={{ color: kit.muted, fontSize: 12.5 }}>
          {warning}
        </Text>
      ))}
    </View>
  );
}

export function OpenAsks({
  theme,
  rows,
  onOpen,
}: {
  theme: PluginTheme;
  rows: readonly OpenAskRow[];
  onOpen: (key: string) => void;
}) {
  const kit = kitOf(theme);
  if (rows.length === 0) return null;
  return (
    <View style={{ gap: 8 }}>
      <View
        style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", paddingHorizontal: 4 }}
      >
        <Text accessibilityRole="header" style={{ color: kit.fg, fontSize: 15, fontWeight: "600" }}>
          Open, not blocking
        </Text>
        <Text style={{ color: kit.muted, fontSize: 13, fontVariant: ["tabular-nums"] }}>{rows.length}</Text>
      </View>
      <View style={{ borderRadius: 14, overflow: "hidden", gap: 1, backgroundColor: kit.hairline }}>
        {rows.map((row) => (
          <Pressable
            key={row.key}
            accessibilityRole="button"
            accessibilityLabel={`${row.title}. ${row.meta}${row.age ? `. asked ${row.age === "now" ? "just now" : `${row.age} ago`}` : ""}. Open to answer`}
            onPress={() => onOpen(row.key)}
            style={({ pressed }) => ({
              minHeight: 44,
              backgroundColor: kit.bg,
              paddingVertical: 10,
              paddingHorizontal: 14,
              flexDirection: "row",
              gap: 10,
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Text numberOfLines={2} style={{ color: kit.fg, fontSize: 15 }}>
                {row.title}
              </Text>
              <Text numberOfLines={1} style={{ color: kit.muted, fontSize: 12.5 }}>
                {row.meta}
              </Text>
              {row.silent ? (
                <Text numberOfLines={1} style={{ color: kit.muted, fontSize: 12.5 }}>
                  {row.silent}
                </Text>
              ) : null}
            </View>
            {row.age ? <Text style={{ color: kit.muted, fontSize: 12.5 }}>{row.age}</Text> : null}
          </Pressable>
        ))}
      </View>
    </View>
  );
}
