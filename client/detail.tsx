// One work item: where it stands, the verb it needs from you, and its
// receipts. The verb block changes with the state; everything below it is the
// record, newest first.

import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginSurfaceProps, usePaseo } from "@getpaseo/plugin/client";
import { ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { type CheckResult, NOT_STOPPED, type Pending, type WorkEventWire, type WorkItem } from "../shared/contracts";
import { nextRunCopy } from "../shared/run";
import { ChangeText, WithChange } from "./changed";
import { FilesSection } from "./files";
import { ago, basename, errorText } from "./format";
import { useRefresh, useVerbs, useWorkDetail } from "./hooks";
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
        {item.worker ? (
          <Text style={text.mono}>
            {[item.worker.branch, item.worker.startedWith ?? item.worker.provider].filter(Boolean).join(" · ")}
          </Text>
        ) : null}
      </View>

      {/* The loop flagged it: why it is in Needs you though it is not at your gate or stuck. */}
      {item.flag ? <FlagNotice item={item} theme={theme} compact={compact} /> : null}

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

      <FilesSection key={item.id} id={item.id} theme={theme} />

      <Receipts theme={theme} events={events} />

      <Text style={text.small} selectable>
        {item.path}/_work.md
      </Text>
    </ScrollView>
  );
}

/**
 * Why the loop flagged the work. A quiet run offers Leave it running, which
 * writes your receipt and clears the flag; a `yours` or `failed` flag clears
 * when you dispatch or cancel, so it offers nothing of its own.
 */
function FlagNotice({ item, theme, compact }: { item: WorkItem; theme: PluginTheme; compact: boolean }) {
  const verbs = useVerbs();
  const toast = useToast();
  const quiet = item.flag?.kind === "quiet" && item.state === "running";
  return (
    <Notice
      theme={theme}
      tone="warn"
      action={
        quiet ? (
          <Button
            theme={theme}
            icon="Check"
            label="Leave it running"
            compact={compact}
            busy={verbs.leaveRunning.isPending}
            onPress={() =>
              verbs.leaveRunning.mutate({ id: item.id }, { onError: (error) => toast.error(errorText(error)) })
            }
          />
        ) : undefined
      }
    >
      {item.flag?.reason}
    </Notice>
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
  // The item whose Stop run is being confirmed, so an open confirm never carries over to another item.
  const [confirmStop, setConfirmStop] = useState<string | null>(null);
  // A Stop refused because it would delete work that is not committed: the second confirm says what goes.
  const [stopLoss, setStopLoss] = useState<{ id: string; text: string } | null>(null);
  const closeStop = () => {
    setStopLoss(null);
    setConfirmStop(null);
  };

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

  // A decision you made that has not taken effect sits on top. It replaces only the gate's own
  // verbs: answering a question, stopping a run, or unblocking stay where they are.
  const pendingCard = item.pending ? (
    <PendingDecision item={item} pending={item.pending} theme={theme} compact={compact} />
  ) : null;
  const withPending = (node: ReactNode) =>
    pendingCard ? (
      <View style={{ gap: space[3] }}>
        {pendingCard}
        {node}
      </View>
    ) : (
      node
    );

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
    return withPending(
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
      </Card>,
    );
  }

  if (item.state === "review") {
    if (pendingCard) return pendingCard;
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
        <WithChange workspaceId={item.worker?.workspaceId} stat={item.changed}>
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
    const restart = nextRunCopy(item.nextRun, "stuck");
    return withPending(
      <Card theme={theme}>
        <Text style={text.label}>Stuck</Text>
        <Text style={text.body}>{item.reason ?? "The run stopped without a reason."}</Text>
        <Text style={text.muted}>{restart.line}</Text>
        {restart.warning ? (
          <Notice theme={theme} tone="warn">
            {restart.warning}
          </Notice>
        ) : null}
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
      </Card>,
    );
  }

  if (item.state === "proposed" || item.state === "reviewing" || item.state === "triggered") {
    const queued = nextRunCopy(item.nextRun, "queued");
    return (
      <Card theme={theme}>
        <Text style={text.body}>{queued.line}</Text>
        {queued.warning ? (
          <Notice theme={theme} tone="warn">
            {queued.warning}
          </Notice>
        ) : null}
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
    // While checks run the session is already done: nothing to stop, and the checks decide where it lands.
    const stoppable = item.phase !== "checking";
    return withPending(
      <View style={{ gap: space[3] }}>
        <Text style={text.muted}>
          {item.phase === "checking"
            ? "The run finished. Checks are running in its worktree."
            : `Working${item.worker?.provider ? ` with ${item.worker.provider}` : ""}. It comes back to you when the run ends.`}
        </Text>
        {!stoppable ? null : stopLoss?.id === item.id ? (
          <Card theme={theme}>
            <Text style={text.body}>{stopLoss.text}</Text>
            <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap" }}>
              <Button
                theme={theme}
                variant="primary"
                label="Discard and stop"
                compact={compact}
                busy={verbs.stop.isPending}
                onPress={() =>
                  verbs.stop.mutate({ id: item.id, discard: true }, { onSuccess: closeStop, onError: fail })
                }
              />
              <Button theme={theme} variant="quiet" label="Keep it running" compact={compact} onPress={closeStop} />
            </View>
          </Card>
        ) : confirmStop === item.id ? (
          <Card theme={theme}>
            <Text style={text.body}>
              {item.worker?.branch
                ? "Stopping archives the session. The branch and its commits stay."
                : "Stopping archives the session."}
            </Text>
            <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap" }}>
              <Button
                theme={theme}
                variant="primary"
                label="Stop run"
                compact={compact}
                busy={verbs.stop.isPending}
                onPress={() =>
                  verbs.stop.mutate(
                    { id: item.id },
                    {
                      onSuccess: () => setConfirmStop(null),
                      onError: (error) => {
                        const said = errorText(error);
                        if (said.startsWith(NOT_STOPPED)) setStopLoss({ id: item.id, text: said });
                        else fail(error);
                      },
                    },
                  )
                }
              />
              <Button
                theme={theme}
                variant="quiet"
                label="Keep it running"
                compact={compact}
                onPress={() => setConfirmStop(null)}
              />
            </View>
          </Card>
        ) : (
          <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap" }}>
            <Button
              theme={theme}
              icon="Square"
              label="Stop run"
              compact={compact}
              onPress={() => setConfirmStop(item.id)}
            />
          </View>
        )}
      </View>,
    );
  }

  return withPending(item.verdict ? <Text style={text.muted}>{item.verdict}</Text> : null);
}

const PENDING_WORDS: Record<Pending["verdict"], string> = {
  approve: "Approving",
  revise: "Sending it back",
  block: "Canceling the work",
};

/** A decision inside its undo window, counting down to when it takes effect. */
function PendingDecision({
  item,
  pending,
  theme,
  compact,
}: {
  item: WorkItem;
  pending: Pending;
  theme: PluginTheme;
  compact: boolean;
}) {
  const verbs = useVerbs();
  const refresh = useRefresh();
  const toast = useToast();
  const text = useText(theme);
  // Counted from what the host said was left, so a clock that differs from the host's does not skew it.
  const { remainingMs } = pending;
  const deadline = useMemo(() => Date.now() + remainingMs, [remainingMs]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.ceil((deadline - now) / 1000));
  const due = left === 0;
  useEffect(() => {
    if (!due) return;
    // The host applies it on its own timer; look again just after, instead of waiting for the next poll.
    const timer = setTimeout(() => void refresh(), 500);
    return () => clearTimeout(timer);
  }, [due, refresh]);
  const words = PENDING_WORDS[pending.verdict];
  return (
    <Card theme={theme}>
      <Text style={text.label}>Needs you</Text>
      <Text style={text.body}>{due ? `${words} now.` : `${words} in ${left}s.`}</Text>
      {pending.note ? <Text style={text.muted}>{pending.note}</Text> : null}
      <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap" }}>
        <Button
          theme={theme}
          variant="primary"
          icon="Undo2"
          label={due ? "Undo" : `Undo (${left}s)`}
          accessibilityLabel="Undo"
          compact={compact}
          busy={verbs.undo.isPending}
          onPress={() => verbs.undo.mutate({ id: item.id }, { onError: (error) => toast.error(errorText(error)) })}
        />
      </View>
    </Card>
  );
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
