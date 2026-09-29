// What the host draws for a tracked session's composer pill: the state dot as
// its icon, and the popover behind it. The popover reads its session's work
// live, so an open popover follows the work while it is open.

import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginButtonContentProps, PluginButtonIconProps } from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { ORCH_STATES, type OrchState } from "../shared/states";
import { errorText } from "./format";
import { useAgentWork } from "./hooks";
import type { MaestroIntent } from "./intent";
import { Button, Notice, StateDot, StateLabel, space, useText } from "./ui";

function dotFor(state: OrchState): ComponentType<PluginButtonIconProps> {
  function PillDot({ theme }: PluginButtonIconProps) {
    return <StateDot theme={theme} state={state} dim={6} />;
  }
  return PillDot;
}

/** One stable icon per state: the pill's label names the state, the dot repeats it in colour. */
export const PILL_ICONS = Object.fromEntries(ORCH_STATES.map((state) => [state, dotFor(state)])) as Record<
  OrchState,
  ComponentType<PluginButtonIconProps>
>;

/** The popover, bound to how this plugin opens Maestro (the host hands popovers no navigation). */
export function createPillContent(open: (intent: MaestroIntent) => void): ComponentType<PluginButtonContentProps> {
  function MaestroPillContent(props: PluginButtonContentProps) {
    if (props.context !== "agent") return null;
    return <PillBody agentId={props.agentId} theme={props.theme} close={props.close} open={open} />;
  }
  return MaestroPillContent;
}

function PillBody({
  agentId,
  theme,
  close,
  open,
}: {
  agentId: string;
  theme: PluginTheme;
  close: () => void;
  open: (intent: MaestroIntent) => void;
}) {
  const found = useAgentWork(agentId);
  const text = useText(theme);
  if (found.isPending) return <ActivityIndicator color={theme.colors.foregroundMuted} />;
  if (found.isError) {
    return (
      <Notice theme={theme} tone="danger">
        {errorText(found.error)}
      </Notice>
    );
  }
  const item = found.data.item;
  if (!item) return <Text style={text.muted}>This session is no longer tracked as work.</Text>;
  const ask = item.look?.ask;
  return (
    <View style={{ gap: space[3] }}>
      <View style={{ gap: space[1] }}>
        <StateLabel theme={theme} state={item.state} />
        <Text style={text.title} numberOfLines={2}>
          {item.title}
        </Text>
      </View>
      {ask ? (
        <View style={{ gap: space[1] }}>
          <Text style={text.label}>Ask</Text>
          <Text style={text.body} numberOfLines={4}>
            {ask}
          </Text>
        </View>
      ) : null}
      <View style={{ flexDirection: "row" }}>
        <Button
          theme={theme}
          variant="primary"
          icon="LayoutDashboard"
          label="Open in Maestro"
          onPress={() => {
            close();
            open({ kind: "select", id: item.id });
          }}
        />
      </View>
    </View>
  );
}
