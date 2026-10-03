// The changed line: lines added and removed in a worker's workspace. The
// server reads it for every item (item.changed, server/changed.ts), and that
// comes first. Without it, the stat is read from Paseo's client state with
// useWorkspace, as the agent panel can. Paseo hands that state to workspace
// panels but not to surfaces (0.9.2), and there useWorkspace throws. So the
// surface wraps itself in ChangeScope, which probes once: without the state
// every read reports "unknown" instead of every card throwing.

import type { PluginTheme } from "@getpaseo/plugin";
import { useWorkspace } from "@getpaseo/plugin/client";
import {
  Component,
  type ComponentClass,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Text } from "react-native";
import { changeLabel, changeText, type DiffStat } from "./plane-model";
import { size } from "./ui";

// false until the probe reads state; null means no scope above (a workspace
// panel), where each read tries on its own.
const ReachContext = createContext<boolean | null>(null);

type QuietProps = { children: ReactNode; fallback: ReactNode };
type QuietState = { failed: boolean };

/**
 * Renders `fallback` once a child throws. An error boundary has to be a class
 * component, but Paseo evaluates the client bundle with Hermes on iOS, which
 * rejects class syntax and would drop the whole plugin there. So this is the
 * ES5 form React also accepts: a constructor whose prototype is Component's.
 */
function QuietBoundary(this: Component<QuietProps, QuietState>, props: QuietProps) {
  (Component as unknown as (this: unknown, props: QuietProps) => void).call(this, props);
  this.state = { failed: false };
}
QuietBoundary.prototype = Object.create(Component.prototype);
QuietBoundary.prototype.constructor = QuietBoundary;
QuietBoundary.prototype.render = function render(this: Component<QuietProps, QuietState>) {
  return this.state.failed ? this.props.fallback : this.props.children;
};
const Quiet = Object.assign(QuietBoundary, {
  getDerivedStateFromError: (): QuietState => ({ failed: true }),
}) as unknown as ComponentClass<QuietProps, QuietState>;

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

/**
 * Hands the workspace's diff stat to `children`: `stat` when the server read
 * one, else the client state's, null while it is unknown or unreadable.
 */
export function WithChange({
  workspaceId,
  stat,
  children,
}: {
  workspaceId: string | null | undefined;
  stat?: DiffStat | null;
  children: (stat: DiffStat | null) => ReactNode;
}) {
  const reach = useContext(ReachContext);
  if (stat) return children(stat);
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
