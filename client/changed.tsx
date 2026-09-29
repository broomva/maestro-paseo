// The changed line: lines added and removed in a worker's workspace, read from
// Paseo's client state with useWorkspace. Paseo hands that state to workspace
// panels but not to surfaces (0.9.2), and there useWorkspace throws. So the
// surface wraps itself in ChangeScope, which probes once: without the state
// every read reports "unknown" instead of every card throwing.

import type { PluginTheme } from "@getpaseo/plugin";
import { useWorkspace } from "@getpaseo/plugin/client";
import { Component, createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { Text } from "react-native";
import { changeLabel, changeText, type DiffStat } from "./plane-model";
import { size } from "./ui";

// false until the probe reads state; null means no scope above (a workspace
// panel), where each read tries on its own.
const ReachContext = createContext<boolean | null>(null);

/** Renders `fallback` once a child throws. */
class Quiet extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
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
      <Quiet fallback={null}>
        <Probe onReach={() => setReached(true)} />
      </Quiet>
      {children}
    </ReachContext.Provider>
  );
}

/** Hands the workspace's diff stat to `children`: null while it is unknown or unreadable. */
export function WithChange({
  workspaceId,
  children,
}: {
  workspaceId: string | null | undefined;
  children: (stat: DiffStat | null) => ReactNode;
}) {
  const reach = useContext(ReachContext);
  const unknown = children(null);
  if (!workspaceId || reach === false) return unknown;
  return (
    <Quiet fallback={unknown}>
      <Read workspaceId={workspaceId} render={children} />
    </Quiet>
  );
}

function Read({ workspaceId, render }: { workspaceId: string; render: (stat: DiffStat | null) => ReactNode }) {
  return render(useWorkspace(workspaceId, (workspace) => workspace.diffStat));
}

/** "+a −d", spoken as lines added and removed. */
export function ChangeText({ theme, stat }: { theme: PluginTheme; stat: DiffStat }) {
  return (
    <Text
      accessibilityLabel={changeLabel(stat)}
      style={{ color: theme.colors.foregroundMuted, fontSize: size.xs, lineHeight: 16, fontVariant: ["tabular-nums"] }}
    >
      {changeText(stat)}
    </Text>
  );
}
