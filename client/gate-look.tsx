// What a run at your gate asks of you, wherever it waits (the session's gate
// card and the detail view), in the session's own words: its ask, the block it
// handed you verbatim, what it decided. A run that asked nothing gets no
// invented question: its last words show (ArcReport) and the verbs say what
// they do (VERBS_MEAN).

import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import type { Look } from "../shared/contracts";
import { ClampedMarkdown } from "./arc-report";
import { space, useText } from "./ui";

/**
 * What a finished card's verbs do, said beside them when the session's own ask does not say it (an arc's does).
 * Work is never approved (A1): gates merge it, so there is no Approve.
 */
export const VERBS_MEAN =
  "Change course reopens its session with your note. Gates merge finished work; you do not approve it.";

/** Whether the verbs need VERBS_MEAN beside them: an arc's ask already names them (server/events.ts arcAsk). */
export const verbsNeedSaying = (look: Look | null): boolean => !look?.arc;

export function LookView({ look, theme, compact }: { look: Look; theme: PluginTheme; compact: boolean }) {
  const text = useText(theme);
  return (
    <View style={{ gap: space[3] }}>
      {look.ask ? (
        <View style={{ gap: space[1] }}>
          <Text style={text.label}>Ask</Text>
          <Text style={text.body}>{look.ask}</Text>
        </View>
      ) : null}
      {look.handed ? (
        <ClampedMarkdown
          label="What it handed you"
          source={look.handed}
          what="what it handed you"
          theme={theme}
          compact={compact}
        />
      ) : null}
      {look.decided.length > 0 ? (
        <View style={{ gap: space[1] }}>
          <Text style={text.label}>Decided</Text>
          {look.decided.map((line) => (
            <View key={line} style={{ flexDirection: "row", gap: space[2] }}>
              <Text style={text.muted}>•</Text>
              <Text style={[text.body, { flex: 1 }]}>{line}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
