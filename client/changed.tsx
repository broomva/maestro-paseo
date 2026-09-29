// The changed line: lines added and removed in a worker's workspace, read from
// Paseo's client state with useWorkspace. Paseo hands that state to workspace
// panels but not to surfaces (0.9.2), and there useWorkspace throws. So the
// surface wraps itself in ChangeScope, which probes once: without the state
// the line stays empty instead of every card throwing.

import type { PluginTheme } from "@getpaseo/plugin";
import { useWorkspace } from "@getpaseo/plugin/client";
import { Component, createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { Text } from "react-native";
import { changeLabel, changeText } from "./plane-model";
import { size } from "./ui";

// false until the probe reads state; null means no scope above (a workspace
// panel), where each line tries on its own.
const ReachContext = createContext<boolean | null>(null);

/** Renders nothing once a child throws. */
class Quiet extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function Probe({ onReach }: { onReach: () => void }) {
  useWorkspace("", () => null);
  const reach = useRef(onReach);
  useEffect(() => reach.current(), []);
  return null;
}

export function ChangeScope({ children }: { children: ReactNode }) {
  const [reached, setReached] = useState(false);
  return (
    <ReachContext.Provider value={reached}>
      <Quiet>
        <Probe onReach={() => setReached(true)} />
      </Quiet>
      {children}
    </ReachContext.Provider>
  );
}

/** "+a −d" for the workspace, or nothing while it is unknown. */
export function ChangeStat({ theme, workspaceId }: { theme: PluginTheme; workspaceId: string | null | undefined }) {
  const reach = useContext(ReachContext);
  if (!workspaceId || reach === false) return null;
  return (
    <Quiet>
      <Stat theme={theme} workspaceId={workspaceId} />
    </Quiet>
  );
}

function Stat({ theme, workspaceId }: { theme: PluginTheme; workspaceId: string }) {
  const stat = useWorkspace(workspaceId, (workspace) => workspace.diffStat);
  if (!stat) return null;
  return (
    <Text
      accessibilityLabel={changeLabel(stat)}
      style={{ color: theme.colors.foregroundMuted, fontSize: size.xs, lineHeight: 16, fontVariant: ["tabular-nums"] }}
    >
      {changeText(stat)}
    </Text>
  );
}
