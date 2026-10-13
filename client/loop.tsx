// The loop in Maestro's plane: a control in the header that says when the
// loop wakes next, and the panel it opens, with Wake now, the recent wakes in
// plain words, and how often it wakes. The loop itself runs on the daemon
// (server/loop.ts); its period is chosen in Settings.

import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import type { WakeEntry } from "../shared/contracts";
import { errorText } from "./format";
import { useLoop, useVerbs } from "./hooks";
import {
  causeText,
  keyedLines,
  type LoopState,
  periodText,
  skippedText,
  wakeLines,
  wakesShown,
  wokeText,
} from "./loop-model";
import { PendingVerbs } from "./pending-verbs";
import { settingsOpener } from "./settings-link";
import { Button, Card, IconButton, Notice, space, useText } from "./ui";

/** The loop's panel: how often it wakes, Wake now, and the recent wakes, newest first. */
export function LoopPanel({ theme, onClose }: { theme: PluginTheme; onClose: () => void }) {
  const loop = useLoop();
  const verbs = useVerbs();
  const text = useText(theme);
  const [failure, setFailure] = useState<string | null>(null);
  const openSettings = settingsOpener();
  const state: LoopState | undefined = loop.data;
  const wakes = state ? wakesShown(state.recent, null) : [];
  // A wake asked for while another ran is recorded as skipped, and says why: the newest wake is the one asked for.
  const skipped = wakes[0] ? skippedText(wakes[0]) : null;
  const wake = () => {
    setFailure(null);
    // The wake runs 8 s from now unless undone (B4); its entry is listed here once it has run.
    verbs.wake.mutate(undefined, { onError: (error) => setFailure(errorText(error)) });
  };
  return (
    <Card theme={theme}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
        <Text style={[text.label, { flex: 1 }]} accessibilityRole="header">
          The loop
        </Text>
        <IconButton theme={theme} icon="X" label="Close the loop" onPress={onClose} />
      </View>
      {loop.isPending ? (
        <ActivityIndicator color={theme.colors.foregroundMuted} />
      ) : loop.isError ? (
        <Notice theme={theme} tone="danger">
          {errorText(loop.error)}
        </Notice>
      ) : (
        <>
          <View style={{ gap: space[1] }}>
            <Text style={text.body}>{periodText(state?.minutes ?? null)}</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}>
              <Text style={text.small}>
                It flags quiet runs and acts on your answers; it never starts work. Its period is set in Settings.
              </Text>
              {openSettings ? (
                <Button theme={theme} variant="quiet" icon="Settings" label="Open Settings" onPress={openSettings} />
              ) : null}
            </View>
          </View>
          <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap" }}>
            {/* Never disabled: pressed while a wake runs, the answer says it was not woken and why. */}
            <Button theme={theme} icon="AlarmClock" label="Wake now" busy={verbs.wake.isPending} onPress={wake} />
          </View>
          <PendingVerbs theme={theme} compact={false} keys={["loop"]} />
          {failure ? (
            <Notice theme={theme} tone="danger">
              {failure}
            </Notice>
          ) : skipped ? (
            <Notice theme={theme} tone="warn">
              {skipped}
            </Notice>
          ) : null}
          <View style={{ gap: space[2] }}>
            <Text style={text.label} accessibilityRole="header">
              Recent wakes
            </Text>
            {wakes.length === 0 ? (
              <Text style={text.muted}>
                No wakes yet. Each one is listed here: what needs you, what went quiet, and what became of your answers.
              </Text>
            ) : (
              wakes.map((entry) => <WakeRow key={entry.tickId} theme={theme} entry={entry} />)
            )}
          </View>
        </>
      )}
    </Card>
  );
}

function WakeRow({ theme, entry }: { theme: PluginTheme; entry: WakeEntry }) {
  const text = useText(theme);
  const when = wokeText(entry.wokeAt);
  const cause = causeText(entry.cause);
  return (
    <View
      accessibilityLabel={`Wake, ${when}, ${cause}`}
      style={{ gap: 2, paddingTop: space[2], borderTopWidth: 1, borderTopColor: theme.colors.border }}
    >
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: space[2], flexWrap: "wrap" }}>
        <Text style={[text.small, text.tabular, { color: theme.colors.foreground, fontWeight: "600" }]}>{when}</Text>
        <Text style={text.small}>{cause}</Text>
      </View>
      {keyedLines(wakeLines(entry)).map(({ key, line }) => {
        // The narrative indents what belongs under a heading ("Did:", "Left alone:") by two spaces.
        const nested = line.startsWith("  ");
        return (
          <Text key={key} style={[nested ? text.small : text.body, nested ? { paddingLeft: space[3] } : null]}>
            {line.trim()}
          </Text>
        );
      })}
    </View>
  );
}
