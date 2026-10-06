// What a finished arc left you, under the Ask wherever work waits at your gate
// (the detail view and the session's gate card): whether its session is
// archived, the block above its ARC-STATUS line verbatim (Look.closing), and
// the open decisions it handed you, linked exactly (handedAsks: a ledger whose
// arc is the run's folder), one press
// from the Decisions tab.

import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Text, View } from "react-native";
import type { WorkItem } from "../shared/contracts";
import { useWorkspaceAsks } from "./decisions";
import { decisionAsks, handedAsks, ledgerOf } from "./decisions-model";
import { clampedBody } from "./fleet-cockpit-model";
import { plural } from "./format";
import { requestIntent } from "./intent";
import { MarkdownView } from "./markdown-view";
import { Button, space, useText } from "./ui";

/** How tall a long closing shows before Show all. */
const CLAMP = { phone: 180, desktop: 260 } as const;

export function ArcReport({ item, theme, compact }: { item: WorkItem; theme: PluginTheme; compact: boolean }) {
  const text = useText(theme);
  const read = useWorkspaceAsks();
  const [all, setAll] = useState(false);
  const look = item.look;
  if (!look) return null;
  const handed = read.data ? handedAsks(decisionAsks(read.data), item.worker?.cwd) : [];
  const [first] = handed;
  // One ledger: open at it. More: open at the first ask with every ledger listed, so none is filtered away.
  const oneLedger = first && handed.every((ask) => ledgerOf(ask) === ledgerOf(first)) ? ledgerOf(first) : null;
  const closing = look.closing ?? null;
  const clamped = !all && clampedBody(closing, compact);
  if (!look.archived && !closing && !first) return null;
  return (
    <View style={{ gap: space[2] }}>
      {look.archived ? <Text style={text.small}>Its session is archived.</Text> : null}
      {closing ? (
        <View style={{ gap: space[1] }}>
          <Text style={text.label}>{look.arc ? `What it left you · ${look.arc.line}` : "What it left you"}</Text>
          <View style={clamped ? { maxHeight: compact ? CLAMP.phone : CLAMP.desktop, overflow: "hidden" } : null}>
            <MarkdownView source={closing} theme={theme} compact={compact} />
          </View>
          {clamped ? (
            <View style={{ flexDirection: "row" }}>
              <Button
                theme={theme}
                variant="quiet"
                icon="ChevronDown"
                label="Show all"
                compact={compact}
                accessibilityLabel="Show all of what the arc left you"
                onPress={() => setAll(true)}
              />
            </View>
          ) : null}
        </View>
      ) : null}
      {first ? (
        <View style={{ flexDirection: "row" }}>
          <Button
            theme={theme}
            icon="ArrowRight"
            label={`Answer its ${plural(handed.length, "decision")} in Decisions`}
            compact={compact}
            onPress={() =>
              requestIntent({
                kind: "decisions",
                ledger: oneLedger,
                id: first.id,
                askLedger: ledgerOf(first),
              })
            }
          />
        </View>
      ) : null}
    </View>
  );
}
