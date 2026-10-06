// The brief of work fleet-reconcile raised, read for the owner: what the fleet
// asks, one short paragraph per ask, the producer's own line on what each verb
// does (an alert's differs: a note sent back is not read), and the words
// addressed to the run agent folded away (shared/fleet-item.ts reads them).

import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import { alertKind, type FleetBrief, type FleetOrigin, leadRestates } from "../shared/fleet-item";
import { noFlagBreaks } from "../shared/text";
import { Disclosure, radius, size, space, useText } from "./ui";

/**
 * Says each thing once. The lead is left out when it restates the scope or
 * tick shown under the title; an alert's message is its title, so it is not
 * listed again (unless the title had to cut it), and its kind is the
 * detail's own line, not a tag.
 */
export function FleetBriefView({
  theme,
  brief,
  origin,
  title,
}: {
  theme: PluginTheme;
  brief: FleetBrief;
  origin: FleetOrigin;
  /** The title the detail shows above this. */
  title: string;
}) {
  const text = useText(theme);
  const alert = alertKind(origin) !== null;
  const asks = alert ? brief.asks.filter((ask) => ask.question !== title) : brief.asks;
  const many = asks.length > 1;
  const lead = brief.lead && !leadRestates(brief.lead, origin) ? brief.lead : null;
  return (
    <View style={{ gap: space[3] }}>
      {asks.length > 0 ? (
        <Text style={text.label} accessibilityRole="header">
          {alert ? "The alert" : many ? `The fleet asks you ${asks.length} things` : "The fleet asks you"}
        </Text>
      ) : null}
      {lead ? <Text style={text.muted}>{lead}</Text> : null}
      {asks.length > 0 ? (
        <View style={{ gap: space[3] }}>
          {asks.map((ask) => {
            const tag = alert ? null : ask.kind;
            return (
              <View key={`${ask.id}:${ask.question}`} style={{ gap: space[1] }}>
                {tag || (many && !alert) ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
                    {many && !alert ? <Text style={[text.small, text.tabular]}>{ask.id}</Text> : null}
                    {tag ? <Tag theme={theme} label={tag} /> : null}
                  </View>
                ) : null}
                <Text style={text.body} selectable>
                  {noFlagBreaks(ask.question)}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}
      {brief.verbs ? <Text style={text.small}>{brief.verbs}</Text> : null}
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
