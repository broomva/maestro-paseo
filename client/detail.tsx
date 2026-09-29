// One work item: where it stands, the verb it needs from you, and its
// receipts. The verb block changes with the state; everything below it is the
// record, newest first.

import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginSurfaceProps, usePaseo } from "@getpaseo/plugin/client";
import { ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import type { CheckResult, WorkEventWire, WorkItem } from "../shared/contracts";
import { ChangeText, WithChange } from "./changed";
import { ago, basename, errorText } from "./format";
import { useVerbs, useWorkDetail } from "./hooks";
import { changedVisible } from "./plane-model";
import { Button, Card, IconButton, Notice, radius, StateLabel, space, useText } from "./ui";

type Navigation = PluginSurfaceProps["navigation"];

export function WorkDetail({
  id,
  theme,
  compact,
  navigation,
  onBack,
}: {
  id: string;
  theme: PluginTheme;
  compact: boolean;
  navigation: Navigation;
  onBack?: () => void;
}) {
  const detail = useWorkDetail(id);
  const text = useText(theme);
  const pad = compact ? space[4] : space[6];

  if (detail.isPending) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={theme.colors.foregroundMuted} />
      </View>
    );
  }
  if (detail.isError) {
    return (
      <View style={{ padding: pad, gap: space[3] }}>
        {onBack ? <BackRow theme={theme} onBack={onBack} /> : null}
        <Notice theme={theme} tone="danger">
          {errorText(detail.error)}
        </Notice>
        <Button theme={theme} label="Try again" onPress={() => void detail.refetch()} />
      </View>
    );
  }

  const { item, brief, events, checkResults } = detail.data;
  const where = [
    item.initiative && item.project ? `${item.initiative} / ${item.project}` : item.initiative,
    basename(item.repo),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: pad, gap: space[5] }}>
      {onBack ? <BackRow theme={theme} onBack={onBack} /> : null}
      <View style={{ gap: space[2] }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[3], flexWrap: "wrap" }}>
          <StateLabel theme={theme} state={item.state} />
          <Text style={[text.small, text.tabular]}>{ago(item.updatedAt)}</Text>
          <Text style={text.small}>{item.gate === "human" ? "You approve" : "Checks decide"}</Text>
        </View>
        <Text style={text.heading} accessibilityRole="header">
          {item.title}
        </Text>
        {where ? <Text style={text.muted}>{where}</Text> : null}
        {item.worker?.branch ? <Text style={text.mono}>{item.worker.branch}</Text> : null}
      </View>

      <Verbs item={item} theme={theme} compact={compact} />

      {navigation && item.worker ? (
        <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap" }}>
          <Button
            theme={theme}
            icon="MessageSquare"
            label="Open session"
            compact={compact}
            onPress={() => item.worker && navigation.openAgent({ agentId: item.worker.agentId })}
          />
          {item.worker.workspaceId ? (
            <Button
              theme={theme}
              icon="FolderGit2"
              label="Open workspace"
              compact={compact}
              onPress={() =>
                item.worker?.workspaceId && navigation.openWorkspace({ workspaceId: item.worker.workspaceId })
              }
            />
          ) : null}
        </View>
      ) : null}

      {item.checks.length > 0 ? <Checks theme={theme} item={item} results={checkResults} /> : null}

      {brief ? (
        <View style={{ gap: space[2] }}>
          <Text style={text.label} accessibilityRole="header">
            Brief
          </Text>
          <Text style={text.body} selectable>
            {brief}
          </Text>
        </View>
      ) : null}

      <Receipts theme={theme} events={events} />

      <Text style={text.small} selectable>
        {item.path}/_work.md
      </Text>
    </ScrollView>
  );
}

function BackRow({ theme, onBack }: { theme: PluginTheme; onBack: () => void }) {
  const text = useText(theme);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[1], marginLeft: -space[2] }}>
      <IconButton theme={theme} icon="ChevronLeft" label="Back to all work" onPress={onBack} />
      <Text style={text.muted}>All work</Text>
    </View>
  );
}

function Verbs({ item, theme, compact }: { item: WorkItem; theme: PluginTheme; compact: boolean }) {
  const verbs = useVerbs();
  const toast = useToast();
  const paseo = usePaseo();
  const text = useText(theme);
  const [note, setNote] = useState("");
  const [sendingBack, setSendingBack] = useState(false);
  const [answering, setAnswering] = useState(false);

  const fail = (error: unknown) => toast.error(errorText(error));
  const inputStyle = {
    minHeight: 72,
    padding: space[3],
    borderRadius: radius.control,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
    fontSize: 14,
    textAlignVertical: "top" as const,
  };

  if (item.state === "review" && item.permission) {
    const { requestId } = item.permission;
    const answer = async (allow: boolean) => {
      if (!item.worker) return;
      setAnswering(true);
      try {
        await paseo.agents.ref(item.worker.agentId).respondToPermission({
          requestId,
          response: allow ? { behavior: "allow" } : { behavior: "deny", message: "Declined from Maestro" },
        });
        toast.show(allow ? "Allowed" : "Declined", { variant: "success" });
      } catch (error) {
        fail(error);
      } finally {
        setAnswering(false);
      }
    };
    return (
      <Card theme={theme}>
        <Text style={text.label}>The agent is asking</Text>
        <Text style={text.body}>{item.look?.ask ?? item.permission.title}</Text>
        {item.look ? <Text style={text.small}>{item.look.ran}</Text> : null}
        <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap" }}>
          <Button
            theme={theme}
            variant="primary"
            label="Allow"
            busy={answering}
            compact={compact}
            onPress={() => void answer(true)}
          />
          <Button
            theme={theme}
            label="Deny"
            disabled={answering}
            compact={compact}
            onPress={() => void answer(false)}
          />
        </View>
      </Card>
    );
  }

  if (item.state === "review") {
    const look = item.look;
    return (
      <Card theme={theme}>
        <Text style={text.label}>Needs you</Text>
        {look ? (
          <View style={{ gap: space[3] }}>
            <Text style={text.muted}>{look.ran}</Text>
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
            <View style={{ gap: space[1] }}>
              <Text style={text.label}>Ask</Text>
              <Text style={text.body}>{look.ask}</Text>
            </View>
          </View>
        ) : null}
        <WithChange workspaceId={item.worker?.workspaceId}>
          {(stat) =>
            changedVisible(item.worker?.branch, stat) ? (
              <View style={{ gap: space[1] }}>
                <Text style={text.label}>Changed</Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}>
                  {item.worker?.branch ? <Text style={text.mono}>{item.worker.branch}</Text> : null}
                  {stat ? <ChangeText theme={theme} stat={stat} /> : null}
                </View>
              </View>
            ) : null
          }
        </WithChange>
        {item.verdict ? <Text style={text.small}>{item.verdict}</Text> : null}
        {sendingBack ? (
          <View style={{ gap: space[2] }}>
            <TextInput
              value={note}
              onChangeText={setNote}
              multiline
              placeholder="What should change?"
              placeholderTextColor={theme.colors.foregroundMuted}
              accessibilityLabel="What should change"
              style={inputStyle}
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
              onPress={() => setSendingBack(true)}
            />
            <Button
              theme={theme}
              variant="quiet"
              label="Cancel work"
              compact={compact}
              onPress={() => verbs.verdict.mutate({ id: item.id, verdict: "block", note: "" }, { onError: fail })}
            />
          </View>
        )}
      </Card>
    );
  }

  if (item.state === "blocked") {
    return (
      <Card theme={theme}>
        <Text style={text.label}>Stuck</Text>
        <Text style={text.body}>{item.reason ?? "The run stopped without a reason."}</Text>
        <TextInput
          value={note}
          onChangeText={setNote}
          multiline
          placeholder="Anything the agent should know before it continues"
          placeholderTextColor={theme.colors.foregroundMuted}
          accessibilityLabel="Note for the agent"
          style={inputStyle}
        />
        <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap" }}>
          <Button
            theme={theme}
            variant="primary"
            icon="Play"
            label="Unblock"
            compact={compact}
            busy={verbs.unblock.isPending}
            onPress={() => verbs.unblock.mutate({ id: item.id, note }, { onSuccess: () => setNote(""), onError: fail })}
          />
          <Button
            theme={theme}
            variant="quiet"
            label="Cancel work"
            compact={compact}
            onPress={() => verbs.cancel.mutate({ id: item.id }, { onError: fail })}
          />
        </View>
      </Card>
    );
  }

  if (item.state === "proposed" || item.state === "reviewing" || item.state === "triggered") {
    return (
      <Card theme={theme}>
        <Text style={text.body}>Queued. Dispatching starts an agent in a fresh worktree on its own run branch.</Text>
        <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap" }}>
          <Button
            theme={theme}
            variant="primary"
            icon="Play"
            label="Dispatch"
            compact={compact}
            busy={verbs.dispatch.isPending}
            onPress={() => verbs.dispatch.mutate({ id: item.id }, { onError: fail })}
          />
          <Button
            theme={theme}
            variant="quiet"
            label="Cancel work"
            compact={compact}
            onPress={() => verbs.cancel.mutate({ id: item.id }, { onError: fail })}
          />
        </View>
      </Card>
    );
  }

  if (item.state === "running") {
    return (
      <Text style={text.muted}>
        {item.phase === "checking"
          ? "The run finished. Checks are running in its worktree."
          : `Working${item.worker?.provider ? ` with ${item.worker.provider}` : ""}. It comes back to you when the run ends.`}
      </Text>
    );
  }

  return item.verdict ? <Text style={text.muted}>{item.verdict}</Text> : null;
}

function Checks({ theme, item, results }: { theme: PluginTheme; item: WorkItem; results: CheckResult[] }) {
  const text = useText(theme);
  return (
    <View style={{ gap: space[2] }}>
      <Text style={text.label} accessibilityRole="header">
        Checks
      </Text>
      <Card theme={theme} style={{ gap: space[3] }}>
        {item.checks.map((check) => {
          const result = results.find((r) => r.name === check.name);
          const status = !result
            ? "Not run yet"
            : result.ok
              ? `Passed in ${Math.max(1, Math.round(result.durationMs / 1000))}s`
              : result.timedOut
                ? "Timed out"
                : `Failed with exit ${result.exit ?? "?"}`;
          const color = !result
            ? theme.colors.foregroundMuted
            : result.ok
              ? theme.colors.statusSuccess
              : theme.colors.statusDanger;
          return (
            <View key={check.name} style={{ gap: space[1] }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space[2] }}>
                <Text style={[text.body, { fontWeight: "600" }]}>{check.name}</Text>
                <Text style={{ color, fontSize: 12, fontWeight: "600" }}>{status}</Text>
              </View>
              <Text style={text.mono} selectable>
                {check.run}
              </Text>
              {result && !result.ok && result.tail ? (
                <Text style={[text.mono, { color: theme.colors.foregroundMuted }]} selectable numberOfLines={12}>
                  {result.tail.trim().split("\n").slice(-12).join("\n")}
                </Text>
              ) : null}
            </View>
          );
        })}
      </Card>
    </View>
  );
}

function Receipts({ theme, events }: { theme: PluginTheme; events: WorkEventWire[] }) {
  const text = useText(theme);
  const newest = [...events].reverse();
  return (
    <View style={{ gap: space[2] }}>
      <Text style={text.label} accessibilityRole="header">
        Receipts
      </Text>
      <View style={{ gap: space[3] }}>
        {newest.map((event) => (
          <View
            key={`${event.ts}-${event.type}-${event.text}-${event.detail ?? ""}`}
            style={{ flexDirection: "row", gap: space[3] }}
          >
            <Text style={[text.small, text.tabular, { width: 40 }]}>{ago(event.ts)}</Text>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={text.body}>{event.text}</Text>
              {event.detail ? (
                <Text style={text.small} numberOfLines={3}>
                  {event.detail}
                </Text>
              ) : null}
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}
