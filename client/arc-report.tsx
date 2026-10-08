// What a finished arc left you, under the Ask wherever work waits at your gate
// (the detail view and the session's gate card): whether its session is
// archived, its last words: the block above its ARC-STATUS line verbatim
// (Look.closing), and
// the open decisions it handed you, linked exactly (handedAsks: a ledger whose
// arc is the run's folder), one press
// from the Decisions tab.

import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Text, View } from "react-native";
import type { WorkItem } from "../shared/contracts";
import { useWorkspaceAsks } from "./decisions";
import { askKey, decisionAsks, handedAsks, ledgerOf } from "./decisions-model";
import { clampedBody } from "./fleet-cockpit-model";
import { plural } from "./format";
import type { MaestroIntent } from "./intent";
import { MarkdownView } from "./markdown-view";
import { Button, space, useText } from "./ui";

/** How tall a long closing shows before Show all. */
const CLAMP = { phone: 180, desktop: 260 } as const;

export function ArcReport({
  item,
  theme,
  compact,
  open,
}: {
  item: WorkItem;
  theme: PluginTheme;
  compact: boolean;
  /** How this place opens Decisions: inside Maestro, an intent; from a session's gate card, the intent and Maestro with it. */
  open: (intent: MaestroIntent) => void;
}) {
  const text = useText(theme);
  const read = useWorkspaceAsks();
  const look = item.look;
  if (!look) return null;
  const handed = read.data ? handedAsks(decisionAsks(read.data), item.worker?.cwd) : [];
  const [first] = handed;
  // One ledger: open at it. More: open at the first ask with every ledger listed, so none is filtered away.
  const oneLedger = first && handed.every((ask) => ledgerOf(ask) === ledgerOf(first)) ? ledgerOf(first) : null;
  const closing = look.closing ?? null;
  if (!look.archived && !closing && !first) return null;
  return (
    <View style={{ gap: space[2] }}>
      {look.archived ? <Text style={text.small}>Its session is archived.</Text> : null}
      {closing ? (
        <ClampedMarkdown
          label={look.arc ? `Its last words · ${look.arc.line}` : "Its last words"}
          source={closing}
          what="its last words"
          theme={theme}
          compact={compact}
        />
      ) : null}
      {first ? (
        <View style={{ flexDirection: "row" }}>
          <Button
            theme={theme}
            icon="ArrowRight"
            label={`Answer its ${plural(handed.length, "decision")} in Decisions`}
            compact={compact}
            onPress={() =>
              open({
                kind: "decisions",
                ledger: oneLedger,
                id: first.id,
                key: askKey(first),
              })
            }
          />
        </View>
      ) : null}
    </View>
  );
}

/**
 * Text a session wrote, verbatim, under a label: clamped when long, with Show
 * all. Its last words (ArcReport) and what it handed you (the gate's ask) both
 * read this way, so neither is ever rewritten for display.
 */
export function ClampedMarkdown({
  label,
  source,
  what,
  theme,
  compact,
}: {
  label: string;
  source: string;
  /** What Show all reveals, for its accessibility label ("its last words"). */
  what: string;
  theme: PluginTheme;
  compact: boolean;
}) {
  const text = useText(theme);
  const [all, setAll] = useState(false);
  const clamped = !all && clampedBody(source, compact);
  return (
    <View style={{ gap: space[1] }}>
      <Text style={text.label}>{label}</Text>
      <View style={clamped ? { maxHeight: compact ? CLAMP.phone : CLAMP.desktop, overflow: "hidden" } : null}>
        <MarkdownView source={source} theme={theme} compact={compact} />
      </View>
      {clamped ? (
        <View style={{ flexDirection: "row" }}>
          <Button
            theme={theme}
            variant="quiet"
            icon="ChevronDown"
            label="Show all"
            compact={compact}
            accessibilityLabel={`Show all of ${what}`}
            onPress={() => setAll(true)}
          />
        </View>
      ) : null}
    </View>
  );
}
