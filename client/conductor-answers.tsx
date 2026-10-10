// Decisions' "For the conductor" block (BRO-2990, owner answer A8): your
// answers whose askers are gone and that no session on their arcs could take.
// Nothing was started for them; each waits for the conductor (BRO-2989) to
// give it to a lane. Until the conductor exists, they are also yours to act
// on: File as work queues it (gate human, never dispatched: you or a lane
// start it), Dismiss closes it. Either takes effect after the undo window
// (UNDO_MS), with Undo until then, and leaves a receipt in the asks' log.

import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation } from "@tanstack/react-query";
import { useEffect } from "react";
import { Text, View } from "react-native";
import { type ConductorVerb, decideConductor, undoConductor } from "../shared/answers";
import type { DecisionAsk } from "../shared/fleet";
import { UNDO_MS } from "../shared/undo";
import { Verb } from "./decision-card";
import { answeredLine, askKey, headlineOf, ledgerName, ledgerOf } from "./decisions-model";
import { errorText } from "./format";
import { useRefresh } from "./hooks";
import { space, useText } from "./ui";

/** What a pending decision says while its undo window runs. */
const PENDING_WORDS: Record<ConductorVerb, string> = {
  file: "Filing it as work: it is queued, never started, once the undo window closes.",
  dismiss: "Dismissing it: nothing follows from it once the undo window closes.",
};

export function ConductorAnswers({
  theme,
  asks,
  compact,
}: {
  theme: PluginTheme;
  asks: readonly DecisionAsk[];
  compact: boolean;
}) {
  const text = useText(theme);
  if (asks.length === 0) return null;
  return (
    <View style={{ gap: space[2] }} accessibilityLabel={`For the conductor · ${asks.length}`}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[1] }}>
        <Icon name="Clock" size={14} color={theme.colors.statusWarning} />
        <Text style={[text.small, text.tabular, { fontWeight: "600" }]}>{`For the conductor · ${asks.length}`}</Text>
      </View>
      <Text style={text.small}>
        Their askers are gone and no session on their arcs could take them. Nothing was started: each waits for the
        conductor to give it to a lane, or for you to file it as work or dismiss it.
      </Text>
      {asks.map((ask) => (
        <ConductorAnswer key={askKey(ask)} theme={theme} ask={ask} compact={compact} />
      ))}
    </View>
  );
}

function ConductorAnswer({ theme, ask, compact }: { theme: PluginTheme; ask: DecisionAsk; compact: boolean }) {
  const text = useText(theme);
  const toast = useToast();
  const refresh = useRefresh();
  const decide = useRpc(decideConductor);
  const undo = useRpc(undoConductor);
  const deciding = useMutation({
    mutationFn: decide,
    onError: (error) => toast.error(errorText(error)),
    onSettled: () => void refresh(),
  });
  const undoing = useMutation({
    mutationFn: undo,
    onError: (error) => toast.error(errorText(error)),
    onSettled: () => void refresh(),
  });
  const key = ask.fate?.key;
  const pending = ask.fate?.pending ?? null;
  // Once the window closes the decision applies on the daemon: read again then, so the answer leaves the block.
  useEffect(() => {
    if (!pending) return;
    const wait = Math.max(0, Date.parse(pending.appliesAt) - Date.now()) + 500;
    const handle = setTimeout(() => void refresh(), Math.min(wait, UNDO_MS + 2_000));
    return () => clearTimeout(handle);
  }, [pending, refresh]);
  const headline = headlineOf(ask).headline;
  const busy = deciding.isPending || undoing.isPending;
  return (
    <View style={{ gap: 2, paddingLeft: space[4] }}>
      <Text style={[text.body, { fontSize: 13 }]}>{headline}</Text>
      <Text style={[text.small, { color: theme.colors.statusWarning }]}>
        {`${answeredLine(ask)} · ${ledgerName(ledgerOf(ask))}`}
      </Text>
      {ask.answer ? (
        <Text style={text.small} selectable>
          {ask.answer}
        </Text>
      ) : null}
      {key ? (
        pending ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}>
            <Text style={text.small}>{PENDING_WORDS[pending.verb]}</Text>
            <Verb
              theme={theme}
              label="Undo"
              icon="Undo2"
              compact={compact}
              busy={busy}
              accessibilityLabel={`Undo, ${headline}`}
              onPress={() => undoing.mutate({ receipt: pending.receipt })}
            />
          </View>
        ) : (
          <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap" }}>
            <Verb
              theme={theme}
              label="File as work"
              icon="FilePlus"
              compact={compact}
              busy={busy}
              accessibilityLabel={`File as work, ${headline}`}
              onPress={() => deciding.mutate({ key, verb: "file" })}
            />
            <Verb
              theme={theme}
              label="Dismiss"
              icon="X"
              compact={compact}
              busy={busy}
              accessibilityLabel={`Dismiss, ${headline}`}
              onPress={() => deciding.mutate({ key, verb: "dismiss" })}
            />
          </View>
        )
      ) : null}
    </View>
  );
}
