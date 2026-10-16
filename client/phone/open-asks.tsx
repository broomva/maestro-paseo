// The ledgers asks.workspace could not read, over the Decisions deck (BRO-3108, BRO-3140): their asks are missing
// from it because the read failed, not because they were answered. Every open ask itself is a card on the deck.

import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import { kitOf } from "../kit/tokens";

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
