// The Fleet's Economy section (BRO-3118): what each tier of model cost over the last week and how often its work
// passed, one row per tier that ran and a line for the whole. Read only: it reads economy.get, which computes from
// the receipts and writes nothing (the sweep writes economy.json for the coordinator). Words, not charts: every row
// is text a screen reader says as it reads.

import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { ActivityIndicator, Text, View } from "react-native";
import { getEconomy } from "../shared/economy";
import { economyRows, totalWords } from "./economy-model";
import { POLL_MS } from "./fleet-ticks";
import { ramp, SectionHead } from "./fleet-ui";
import { errorText } from "./format";
import { Notice, space } from "./ui";

export function useEconomy() {
  const get = useRpc(getEconomy);
  return useQuery({ queryKey: ["maestro", "economy"], queryFn: () => get({}), refetchInterval: POLL_MS });
}

export function EconomySection({ theme, phone }: { theme: PluginTheme; phone: boolean }) {
  const t = ramp(theme);
  const economy = useEconomy();
  const rows = economy.data ? economyRows(economy.data) : [];
  return (
    <View style={{ gap: space[3] }}>
      <SectionHead theme={theme} title="Economy" />
      {economy.isPending ? <ActivityIndicator color={theme.colors.foregroundMuted} /> : null}
      {economy.isError && !economy.data ? (
        <Notice theme={theme} tone="warn">
          {`Could not read the economy: ${errorText(economy.error)}`}
        </Notice>
      ) : null}
      {economy.data ? (
        <View style={{ gap: space[2] }}>
          <Text style={[t.meta, t.tabular]} accessibilityRole="text">
            {totalWords(economy.data)}
          </Text>
          {rows.map((row) => (
            <View
              key={row.name}
              accessible
              accessibilityRole="text"
              accessibilityLabel={row.words}
              style={{
                flexDirection: phone ? "column" : "row",
                alignItems: phone ? "flex-start" : "baseline",
                gap: phone ? space[1] : space[3],
                flexWrap: "wrap",
              }}
            >
              <Text style={[t.cardTitle, { minWidth: 110 }]}>{row.title}</Text>
              <Text style={[t.meta, t.tabular, { flex: 1 }]}>{row.parts.join(" · ")}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
