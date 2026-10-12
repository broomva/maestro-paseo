// What you decided that has not taken effect yet (B4: 8 s everywhere). Every owner verb that changes state waits
// out its undo window on the server and answers with a receipt; this strip counts each one down and holds the
// one Undo. It reads the ledger (verbs.list), so every surface that mounts it, the Maestro screen, a work's
// detail, a card in a session, shows the same countdown, and an Undo anywhere takes it back.

import type { PluginTheme } from "@getpaseo/plugin";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { OwnerVerb, PendingVerb } from "../shared/verbs";
import { errorText } from "./format";
import { useVerbLedger, useVerbs } from "./hooks";
import { pendingFor, pendingWords, secondsLeft, settledWords } from "./pending-model";
import { Button, Card, space, useText } from "./ui";

/**
 * The countdown, from what the host said was left when it was read, so a clock that differs from the host's
 * does not skew it.
 */
function useLeft(remainingMs: number, readAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  return secondsLeft(readAt + remainingMs - now);
}

function PendingRow({
  verb,
  readAt,
  theme,
  compact,
}: {
  verb: PendingVerb;
  readAt: number;
  theme: PluginTheme;
  compact: boolean;
}) {
  const text = useText(theme);
  const verbs = useVerbs();
  const toast = useToast();
  const left = useLeft(verb.remainingMs, readAt);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[3], flexWrap: "wrap" }}>
      <Text style={[text.body, { flex: 1, minWidth: 160 }]} accessibilityRole="text">
        {pendingWords(verb, left)}
      </Text>
      <Button
        theme={theme}
        variant="primary"
        icon="Undo2"
        label={left > 0 ? `Undo (${left}s)` : "Undo"}
        accessibilityLabel={`Undo: ${verb.label}`}
        compact={compact}
        busy={verbs.undoVerb.isPending}
        onPress={() =>
          verbs.undoVerb.mutate({ receipt: verb.receipt }, { onError: (error) => toast.error(errorText(error)) })
        }
      />
    </View>
  );
}

/** The waiting verbs as one card, or nothing when none waits. */
export function PendingVerbs({
  theme,
  compact,
  keys,
  skip,
  except,
}: {
  theme: PluginTheme;
  compact: boolean;
  /** Only the verbs on these keys; every waiting verb when absent. */
  keys?: readonly string[];
  /** Verbs this place already counts down itself (a work's own decision at the gate, in its detail). */
  skip?: readonly OwnerVerb[];
  /** Keys whose countdown is shown beside this one already (the open work's, in its detail pane). */
  except?: readonly string[];
}) {
  const ledger = useVerbLedger();
  const shown = pendingFor(ledger.data?.pending ?? [], keys, skip).filter((verb) => !except?.includes(verb.key));
  if (shown.length === 0) return null;
  return (
    <Card theme={theme} style={{ gap: space[2] }}>
      {shown.map((verb) => (
        <PendingRow key={verb.receipt} verb={verb} readAt={ledger.dataUpdatedAt} theme={theme} compact={compact} />
      ))}
    </Card>
  );
}

/** Receipts for your verbs on `keys`, newest first: nothing when there are none. */
export function SettledVerbs({ theme, keys }: { theme: PluginTheme; keys: readonly string[] }) {
  const text = useText(theme);
  const ledger = useVerbLedger();
  const shown = (ledger.data?.recent ?? []).filter((verb) => keys.includes(verb.key)).slice(0, 8);
  if (shown.length === 0) return null;
  return (
    <View style={{ gap: space[2] }}>
      <Text style={text.label} accessibilityRole="header">
        Your decisions
      </Text>
      {shown.map((verb) => (
        <Text key={verb.receipt} style={text.body} accessibilityLabel={settledWords(verb)}>
          {settledWords(verb)}
        </Text>
      ))}
    </View>
  );
}
