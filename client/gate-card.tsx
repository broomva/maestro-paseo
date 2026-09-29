// The approval card Maestro leaves in a worker's timeline when its run lands
// at your gate (server/gate-card.ts appends it). It reads the work live: while
// the work waits on you it carries the look and the verbs, and once the work
// has left the gate it says how, with no verb left to press.

import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginTimelineItemProps, usePaseo } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { type ComponentType, type ReactNode, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import type { Look, WorkItem } from "../shared/contracts";
import type { GateCardData } from "../shared/gate-card";
import { errorText } from "./format";
import { gateMode, resolution } from "./gate-state";
import { useVerbs, useWorkDetail } from "./hooks";
import type { MaestroIntent } from "./intent";
import { Button, Card, Notice, radius, StateLabel, space, useText } from "./ui";

type Open = (intent: MaestroIntent) => void;

/** The renderer, bound to how this plugin opens Maestro (timeline items get no navigation). */
export function createGateCard(open: Open): ComponentType<PluginTimelineItemProps<GateCardData>> {
  function MaestroGateCard({ item, theme, layout }: PluginTimelineItemProps<GateCardData>) {
    return <GateCard workId={item.data.workId} theme={theme} compact={layout.compact} open={open} />;
  }
  return MaestroGateCard;
}

function GateCard({
  workId,
  theme,
  compact,
  open,
}: {
  workId: string;
  theme: PluginTheme;
  compact: boolean;
  open: Open;
}) {
  const detail = useWorkDetail(workId);
  const text = useText(theme);
  return (
    <Card theme={theme} style={{ marginVertical: space[2], maxWidth: 560 }}>
      <Text style={text.label}>Maestro gate</Text>
      {detail.isPending ? (
        <ActivityIndicator color={theme.colors.foregroundMuted} />
      ) : detail.isError ? (
        <View style={{ gap: space[2] }}>
          <Notice theme={theme} tone="danger">
            {errorText(detail.error)}
          </Notice>
          <View style={{ flexDirection: "row" }}>
            <Button theme={theme} label="Try again" compact={compact} onPress={() => void detail.refetch()} />
          </View>
        </View>
      ) : (
        <GateBody item={detail.data.item} theme={theme} compact={compact} open={open} />
      )}
    </Card>
  );
}

function GateBody({
  item,
  theme,
  compact,
  open,
}: {
  item: WorkItem;
  theme: PluginTheme;
  compact: boolean;
  open: Open;
}) {
  const text = useText(theme);
  const mode = gateMode(item);
  const openInMaestro = (
    <Button
      theme={theme}
      variant="quiet"
      icon="LayoutDashboard"
      label="Open in Maestro"
      compact={compact}
      onPress={() => open({ kind: "select", id: item.id })}
    />
  );
  return (
    <View style={{ gap: space[3] }}>
      <View style={{ gap: space[1] }}>
        <StateLabel theme={theme} state={item.state} />
        <Text style={[text.body, { fontWeight: "600" }]} numberOfLines={2}>
          {item.title}
        </Text>
      </View>
      {mode === "asking" ? (
        <Asking item={item} theme={theme} compact={compact} after={openInMaestro} />
      ) : mode === "deciding" ? (
        <Deciding item={item} theme={theme} compact={compact} after={openInMaestro} />
      ) : (
        <View style={{ gap: space[2] }}>
          <Text style={text.muted}>{resolution(item)}</Text>
          <View style={{ flexDirection: "row" }}>{openInMaestro}</View>
        </View>
      )}
    </View>
  );
}

function LookView({ look, theme }: { look: Look; theme: PluginTheme }) {
  const text = useText(theme);
  return (
    <View style={{ gap: space[2] }}>
      <Text style={text.small}>{look.ran}</Text>
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
      {look.ask ? (
        <View style={{ gap: space[1] }}>
          <Text style={text.label}>Ask</Text>
          <Text style={text.body}>{look.ask}</Text>
        </View>
      ) : null}
    </View>
  );
}

function Deciding({
  item,
  theme,
  compact,
  after,
}: {
  item: WorkItem;
  theme: PluginTheme;
  compact: boolean;
  after: ReactNode;
}) {
  const verbs = useVerbs();
  const toast = useToast();
  const [note, setNote] = useState("");
  const [sendingBack, setSendingBack] = useState(false);
  const fail = (error: unknown) => toast.error(errorText(error));
  return (
    <View style={{ gap: space[3] }}>
      {item.look ? <LookView look={item.look} theme={theme} /> : null}
      {sendingBack ? (
        <View style={{ gap: space[2] }}>
          <TextInput
            value={note}
            onChangeText={setNote}
            multiline
            placeholder="What should change?"
            placeholderTextColor={theme.colors.foregroundMuted}
            accessibilityLabel="What should change"
            style={{
              minHeight: 72,
              padding: space[3],
              borderRadius: radius.control,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface2,
              color: theme.colors.foreground,
              fontSize: 14,
              textAlignVertical: "top",
            }}
          />
          <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap" }}>
            <Button
              theme={theme}
              variant="primary"
              label="Send it back"
              compact={compact}
              busy={verbs.verdict.isPending}
              disabled={!note.trim()}
              onPress={() =>
                verbs.verdict.mutate(
                  { id: item.id, verdict: "revise", note },
                  {
                    onSuccess: () => {
                      setNote("");
                      setSendingBack(false);
                    },
                    onError: fail,
                  },
                )
              }
            />
            <Button
              theme={theme}
              variant="quiet"
              label="Keep it here"
              compact={compact}
              onPress={() => setSendingBack(false)}
            />
          </View>
        </View>
      ) : (
        <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap" }}>
          <Button
            theme={theme}
            variant="primary"
            icon="Check"
            label="Approve"
            compact={compact}
            busy={verbs.verdict.isPending}
            onPress={() => verbs.verdict.mutate({ id: item.id, verdict: "approve", note: "" }, { onError: fail })}
          />
          <Button
            theme={theme}
            icon="Undo2"
            label="Send back"
            compact={compact}
            disabled={verbs.verdict.isPending}
            onPress={() => setSendingBack(true)}
          />
          {after}
        </View>
      )}
    </View>
  );
}

function Asking({
  item,
  theme,
  compact,
  after,
}: {
  item: WorkItem;
  theme: PluginTheme;
  compact: boolean;
  after: ReactNode;
}) {
  const paseo = usePaseo();
  const toast = useToast();
  const text = useText(theme);
  const [answering, setAnswering] = useState(false);
  const permission = item.permission;
  const worker = item.worker;
  if (!permission) return null;
  const answer = async (allow: boolean) => {
    if (!worker) return;
    setAnswering(true);
    try {
      await paseo.agents.ref(worker.agentId).respondToPermission({
        requestId: permission.requestId,
        response: allow ? { behavior: "allow" } : { behavior: "deny", message: "Declined from Maestro" },
      });
      toast.show(allow ? "Allowed" : "Declined", { variant: "success" });
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setAnswering(false);
    }
  };
  return (
    <View style={{ gap: space[3] }}>
      <View style={{ gap: space[1] }}>
        <Text style={text.label}>The agent is asking</Text>
        <Text style={text.body}>{item.look?.ask ?? permission.title}</Text>
      </View>
      <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap" }}>
        <Button
          theme={theme}
          variant="primary"
          label="Allow"
          busy={answering}
          disabled={!worker}
          compact={compact}
          onPress={() => void answer(true)}
        />
        <Button
          theme={theme}
          label="Deny"
          disabled={answering || !worker}
          compact={compact}
          onPress={() => void answer(false)}
        />
        {after}
      </View>
    </View>
  );
}
