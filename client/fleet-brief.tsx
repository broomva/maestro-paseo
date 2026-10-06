// The brief of work fleet-reconcile raised, read for the owner: what the fleet
// asks, one short paragraph per ask, what each verb means here, and the words
// addressed to the run agent folded away (shared/fleet-item.ts reads them).

import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import type { FleetBrief } from "../shared/fleet-item";
import { Disclosure, radius, size, space, useText } from "./ui";

/** What each verb at the gate does to a fleet item (fleetlib/paseo_ask.py: the fleet reads them back). */
export const FLEET_VERBS = "Approve acknowledges · Send back answers with your note · Cancel dismisses";

export function FleetBriefView({ theme, brief }: { theme: PluginTheme; brief: FleetBrief }) {
  const text = useText(theme);
  const many = brief.asks.length > 1;
  return (
    <View style={{ gap: space[3] }}>
      <Text style={text.label} accessibilityRole="header">
        {many ? `The fleet asks you ${brief.asks.length} things` : "The fleet asks you"}
      </Text>
      {brief.lead ? <Text style={text.muted}>{brief.lead}</Text> : null}
      <View style={{ gap: space[3] }}>
        {brief.asks.map((ask) => (
          <View key={`${ask.id ?? ""}:${ask.question}`} style={{ gap: space[1] }}>
            {ask.kind || (many && ask.id) ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
                {many && ask.id ? <Text style={[text.small, text.tabular]}>{ask.id}</Text> : null}
                {ask.kind ? <Tag theme={theme} label={ask.kind} /> : null}
              </View>
            ) : null}
            <Text style={text.body} selectable>
              {ask.question}
            </Text>
          </View>
        ))}
      </View>
      <Text style={text.small}>{FLEET_VERBS}</Text>
      {brief.instructions ? (
        <Disclosure theme={theme} label="Instructions to the run">
          <Text style={[text.small, { color: theme.colors.foregroundMuted }]} selectable>
            {brief.instructions}
          </Text>
        </Disclosure>
      ) : null}
    </View>
  );
}

/** A quiet word in an outline: the class of an ask. The word carries it; the outline only groups it. */
function Tag({ theme, label }: { theme: PluginTheme; label: string }) {
  return (
    <View
      style={{
        paddingHorizontal: space[2],
        minHeight: 20,
        justifyContent: "center",
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: theme.colors.border,
      }}
    >
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: size.xs, lineHeight: 16 }}>{label}</Text>
    </View>
  );
}
