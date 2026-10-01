// The loop in Maestro's plane: a control in the header that says when the
// loop wakes next, and the panel it opens, with Wake now, the recent wakes in
// plain words, and how often it wakes. The loop itself runs on the daemon
// (server/loop.ts); its period is chosen in Settings.

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { WakeEntry } from "../shared/contracts";
import { errorText } from "./format";
import { useLoop, useVerbs } from "./hooks";
import {
  causeText,
  keyedLines,
  type LoopState,
  loopChipText,
  periodText,
  skippedText,
  wakeLines,
  wakesShown,
  wokeText,
} from "./loop-model";
import { settingsOpener } from "./settings-link";
import { Button, Card, IconButton, Notice, radius, size, space, useText } from "./ui";

/** The time now, moved on every `ms` while mounted, so a countdown counts down between reads. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** "Loop off", "Next wake in 12 min" or "Waking…". Pressing it opens or closes the loop's panel. */
export function LoopControl({ theme, open, onToggle }: { theme: PluginTheme; open: boolean; onToggle: () => void }) {
  const loop = useLoop();
  const now = useNow(15_000);
  const label = loopChipText(loop.data ?? null, now);
  const ink = loop.data?.minutes == null ? theme.colors.foregroundMuted : theme.colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      aria-expanded={open}
      accessibilityLabel={`${label}. ${open ? "Hide" : "Show"} the loop`}
      onPress={onToggle}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        gap: space[1],
        minHeight: 28,
        paddingHorizontal: space[3],
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: open ? theme.colors.accent : theme.colors.border,
        backgroundColor: open || pressed ? theme.colors.surface2 : "transparent",
      })}
    >
      {loop.data?.ticking ? (
        <ActivityIndicator size="small" color={ink} />
      ) : (
        <Icon name="Timer" size={14} color={ink} />
      )}
      <Text style={{ color: ink, fontSize: size.xs, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{label}</Text>
    </Pressable>
  );
}

/** The loop's panel: how often it wakes, Wake now, and the recent wakes, newest first. */
export function LoopPanel({ theme, onClose }: { theme: PluginTheme; onClose: () => void }) {
  const loop = useLoop();
  const verbs = useVerbs();
  const text = useText(theme);
  // The entry Wake now returned, shown at once and kept until the next read lists it.
  const [latest, setLatest] = useState<WakeEntry | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const openSettings = settingsOpener();
  const state: LoopState | undefined = loop.data;
  const wakes = state ? wakesShown(state.recent, latest) : [];
  const skipped = latest ? skippedText(latest) : null;
  const wake = () => {
    setFailure(null);
    verbs.wake.mutate(undefined, {
      onSuccess: (entry) => setLatest(entry),
      onError: (error) => setFailure(errorText(error)),
    });
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
              <Text style={text.small}>It starts Queued work under the run cap. Its period is set in Settings.</Text>
              {openSettings ? (
                <Button theme={theme} variant="quiet" icon="Settings" label="Open Settings" onPress={openSettings} />
              ) : null}
            </View>
          </View>
          <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap" }}>
            {/* Never disabled: pressed while a wake runs, the answer says it was not woken and why. */}
            <Button theme={theme} icon="AlarmClock" label="Wake now" busy={verbs.wake.isPending} onPress={wake} />
          </View>
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
                No wakes yet. Each one is listed here: what it started, what it left to you and why.
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
