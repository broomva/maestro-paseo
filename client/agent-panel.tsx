// Beside an agent: the work it is running, or a way to start tracking it.

import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { ActivityIndicator, Text, View } from "react-native";
import { WorkDetail } from "./detail";
import { errorText } from "./format";
import { useAgentWork, useVerbs } from "./hooks";
import { Button, Card, Notice, space, useText } from "./ui";

export function WorkPanel({ theme, layout, agentId, navigation }: PluginAgentPanelProps) {
  const found = useAgentWork(agentId);
  const verbs = useVerbs();
  const toast = useToast();
  const text = useText(theme);
  const pad = layout.compact ? space[4] : space[6];

  if (found.isPending) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surface0 }}>
        <ActivityIndicator color={theme.colors.foregroundMuted} />
      </View>
    );
  }
  if (found.isError) {
    return (
      <View style={{ flex: 1, padding: pad, backgroundColor: theme.colors.surface0 }}>
        <Notice theme={theme} tone="danger">
          {errorText(found.error)}
        </Notice>
      </View>
    );
  }
  const item = found.data.item;
  if (item) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
        <WorkDetail id={item.id} theme={theme} compact={layout.compact} navigation={navigation} />
      </View>
    );
  }
  return (
    <View style={{ flex: 1, padding: pad, backgroundColor: theme.colors.surface0 }}>
      <Card theme={theme}>
        <Text style={text.title}>Not tracked as work</Text>
        <Text style={text.muted}>
          Track this session and Maestro keeps its receipts. When it stops, it lands at your gate instead of scrolling
          away.
        </Text>
        <View style={{ flexDirection: "row" }}>
          <Button
            theme={theme}
            variant="primary"
            icon="ListPlus"
            label="Track as work"
            compact={layout.compact}
            busy={verbs.adopt.isPending}
            onPress={() => verbs.adopt.mutate({ agentId, title: "" }, { onError: (e) => toast.error(errorText(e)) })}
          />
        </View>
      </Card>
    </View>
  );
}
