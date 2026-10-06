// One work item: where it stands, the verb it needs from you, and its
// receipts. The verb block changes with the state; everything below it is the
// record, newest first.

import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginSurfaceProps, usePaseo } from "@getpaseo/plugin/client";
import { ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { type CheckResult, NOT_STOPPED, type Pending, type WorkEventWire, type WorkItem } from "../shared/contracts";
import { fleetDetail, parseFleetBrief } from "../shared/fleet-item";
import { nextRunCopy } from "../shared/run";
import { PLAIN_VOICE } from "../shared/states";
import { ArcReport } from "./arc-report";
import { ChangeText, WithChange } from "./changed";
import { FilesSection } from "./files";
import { FleetBriefView } from "./fleet-brief";
import { ago, agoWords, basename, errorText } from "./format";
import { LookView, VERBS_MEAN, verbsNeedSaying } from "./gate-look";
import { useRefresh, useVerbs, useWorkDetail } from "./hooks";
import type { MaestroIntent } from "./intent";
import { changedVisible } from "./plane-model";
import { collapseRepeats, fleetOriginOf, placeText, repeatText, repeatWords, titleText } from "./records-text";
import { Button, Card, IconButton, Notice, radius, StateLabel, space, Unbroken, useText } from "./ui";

type Navigation = PluginSurfaceProps["navigation"];

export function WorkDetail({
  id,
  theme,
  compact,
  navigation,
  onBack,
  open,
}: {
  id: string;
  theme: PluginTheme;
  compact: boolean;
  navigation: Navigation;
  onBack?: () => void;
  /** How this place opens another Maestro view: inside Maestro, an intent; beside a session, the intent and Maestro with it. */
  open: (intent: MaestroIntent) => void;
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
  // Work the fleet raised reads by where it came from; its run folder says nothing to a person.
  const fleet = fleetOriginOf(item);
  const fleetBrief = fleet ? parseFleetBrief(brief) : null;
  const shownTitle = titleText(item);
  const where = fleet
    ? placeText(item)
    : [item.initiative && item.project ? `${item.initiative} / ${item.project}` : item.initiative, basename(item.repo)]
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
          <Unbroken>{shownTitle}</Unbroken>
        </Text>
        {where ? <Text style={text.muted}>{where}</Text> : null}
        {fleet ? <Text style={[text.small, text.tabular]}>{fleetDetail(fleet)}</Text> : null}
        {item.worker ? (
          <Text style={text.mono}>
            {[item.worker.branch, item.worker.startedWith ?? item.worker.provider].filter(Boolean).join(" · ")}
          </Text>
        ) : null}
      </View>

      {/* The loop flagged it: why it is in Needs you though it is not at your gate or stuck. */}
      {item.flag ? <FlagNotice item={item} theme={theme} compact={compact} /> : null}

      <Verbs item={item} theme={theme} compact={compact} open={open} />

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

      {fleet && fleetBrief ? (
        <FleetBriefView theme={theme} brief={fleetBrief} origin={fleet} title={shownTitle} />
      ) : brief ? (
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

/** Whether Stop run acts on the work now: its session is working, or paused on a question for you. */
export function stoppable(item: WorkItem): boolean {
  if (item.state === "running") return item.phase !== "checking";
  return item.state === "review" && item.permission !== null;
}

/** What an open Stop confirm turns into when the run leaves every state Stop acts on before you confirm. */
export function movedOnText(item: WorkItem): string {
  const lead = "The run moved on before you confirmed:";
  // Still Running by its label, but the session is done and the checks decide where it lands.
  if (item.state === "running") return `${lead} it finished, and its checks are running.`;
  const { label } = PLAIN_VOICE[item.state];
  return `${lead} it is now ${label === "Needs you" ? "in Needs you" : label}.`;
}

function Verbs({
  item,
  theme,
  compact,
  open,
}: {
  item: WorkItem;
  theme: PluginTheme;
  compact: boolean;
  open: (intent: MaestroIntent) => void;
}) {
  const verbs = useVerbs();
  const toast = useToast();
  const paseo = usePaseo();
  const text = useText(theme);
  const [note, setNote] = useState("");
  const [sendingBack, setSendingBack] = useState(false);
  const [answering, setAnswering] = useState(false);
  // Stop run's confirm lives here, above the per-state cards, so a move between the states it acts on
  // (working, asking) keeps it open. Each piece names its item, so none carries over to another item.
  // The item whose Stop run is being confirmed.
  const [confirmStop, setConfirmStop] = useState<string | null>(null);
  // A Stop refused because it would delete work that is not committed: the second confirm says what goes.
  const [stopLoss, setStopLoss] = useState<{ id: string; text: string } | null>(null);
  // A confirm that was open when the run left every state Stop acts on: said, never dropped silently.
  const [movedOn, setMovedOn] = useState<{ id: string; text: string } | null>(null);
  const closeStop = () => {
    setStopLoss(null);
    setConfirmStop(null);
  };
  const openStop = () => {
    setMovedOn(null);
    setConfirmStop(item.id);
  };

  const fail = (error: unknown) => toast.error(errorText(error));
  const stopRun = (discard: boolean) =>
    verbs.stop.mutate(discard ? { id: item.id, discard: true } : { id: item.id }, {
      onSuccess: closeStop,
      onError: (error) => {
        const said = errorText(error);
        if (!discard && said.startsWith(NOT_STOPPED)) setStopLoss({ id: item.id, text: said });
        else fail(error);
      },
    });
  const lossText = stopLoss?.id === item.id ? stopLoss.text : null;
  const stopOpen = confirmStop === item.id || lossText !== null;
  // The run left every state Stop acts on with the confirm open: swap it for the Notice. Set while
  // rendering (React's way to adjust state to new props), so no frame shows neither. Not while your own
  // Stop is in flight: that move is the one you confirmed.
  if (stopOpen && !stoppable(item) && !verbs.stop.isPending) {
    closeStop();
    setMovedOn({ id: item.id, text: movedOnText(item) });
  }
  const stopConfirm = stopOpen ? (
    <StopConfirm
      item={item}
      theme={theme}
      compact={compact}
      loss={lossText}
      busy={verbs.stop.isPending}
      onConfirm={stopRun}
      onClose={closeStop}
    />
  ) : null;
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
  const movedOnCard =
    movedOn?.id === item.id ? (
      <Notice
        theme={theme}
        tone="warn"
        action={
          <Button theme={theme} variant="quiet" label="Dismiss" compact={compact} onPress={() => setMovedOn(null)} />
        }
      >
        {movedOn.text}
      </Notice>
    ) : null;
  // What sits above the state's own verbs: a Stop that the run outran, then a decision in its undo window.
  const withTop = (node: ReactNode) =>
    movedOnCard || pendingCard ? (
      <View style={{ gap: space[3] }}>
        {movedOnCard}
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
    return withTop(
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
        {/* Or end the run without answering. No Cancel here: it would close the work and leave the
            session waiting on this question (server/engine.ts STOP_BEFORE_CANCEL). Stop, then cancel from Stuck. */}
        {stopConfirm ?? (
          <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap" }}>
            <Button theme={theme} icon="Square" label="Stop run" compact={compact} onPress={openStop} />
          </View>
        )}
      </Card>,
    );
  }

  if (item.state === "review") {
    if (pendingCard) return withTop(null);
    const look = item.look;
    return withTop(
      <Card theme={theme}>
        <Text style={text.label}>Needs you</Text>
        {look ? (
          <View style={{ gap: space[3] }}>
            <Text style={[text.muted, text.tabular]}>{look.ran}</Text>
            <LookView look={look} theme={theme} compact={compact} />
            <ArcReport item={item} theme={theme} compact={compact} open={open} />
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
        {!sendingBack && verbsNeedSaying(look) ? <Text style={text.small}>{VERBS_MEAN}</Text> : null}
      </Card>,
    );
  }

  if (item.state === "blocked") {
    const restart = nextRunCopy(item.nextRun, "stuck");
    return withTop(
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
    return withTop(
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
      </Card>,
    );
  }

  if (item.state === "running") {
    // While checks run the session is already done: nothing to stop, and the checks decide where it lands.
    return withTop(
      <View style={{ gap: space[3] }}>
        <Text style={text.muted}>
          {item.phase === "checking"
            ? "The run finished. Checks are running in its worktree."
            : `Working${item.worker?.provider ? ` with ${item.worker.provider}` : ""}. It comes back to you when the run ends.`}
        </Text>
        {!stoppable(item)
          ? null
          : (stopConfirm ?? (
              <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap" }}>
                <Button theme={theme} icon="Square" label="Stop run" compact={compact} onPress={openStop} />
              </View>
            ))}
      </View>,
    );
  }

  return withTop(item.verdict ? <Text style={text.muted}>{item.verdict}</Text> : null);
}

/**
 * Stop run's confirm: one piece for every state Stop acts on, so it stays open when a working run
 * asks a question, or a question is answered, before you confirm. The first step says what stopping
 * does; the second, after a Stop refused because the worktree holds work that is not committed,
 * says what goes and asks again (`loss`).
 */
function StopConfirm({
  item,
  theme,
  compact,
  loss,
  busy,
  onConfirm,
  onClose,
}: {
  item: WorkItem;
  theme: PluginTheme;
  compact: boolean;
  loss: string | null;
  busy: boolean;
  onConfirm: (discard: boolean) => void;
  onClose: () => void;
}) {
  const text = useText(theme);
  const keep = item.permission ? "Keep it waiting" : "Keep it running";
  const archives = item.permission
    ? "Stopping archives the session and leaves its question unanswered."
    : "Stopping archives the session.";
  return (
    <Card theme={theme}>
      <Text style={text.body}>
        {loss ?? (item.worker?.branch ? `${archives} The branch and its commits stay.` : archives)}
      </Text>
      <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap" }}>
        <Button
          theme={theme}
          variant="primary"
          label={loss ? "Discard and stop" : "Stop run"}
          compact={compact}
          busy={busy}
          onPress={() => onConfirm(loss !== null)}
        />
        <Button theme={theme} variant="quiet" label={keep} compact={compact} onPress={onClose} />
      </View>
    </Card>
  );
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

/** An age in words for a range: "3 hours ago", "just now" (agoWords without its "updated"). */
function spokenAge(ts: string): string {
  return agoWords(ts).replace(/^updated /, "");
}

function Receipts({ theme, events }: { theme: PluginTheme; events: WorkEventWire[] }) {
  const text = useText(theme);
  // Newest first, a run of identical receipts said once with its count.
  const newest = collapseRepeats([...events].reverse());
  return (
    <View style={{ gap: space[2] }}>
      <Text style={text.label} accessibilityRole="header">
        Receipts
      </Text>
      <View style={{ gap: space[3] }}>
        {newest.map((run) => {
          const { event, count } = run;
          return (
            <View
              key={`${event.ts}-${event.type}-${event.text}-${event.detail ?? ""}`}
              style={{ flexDirection: "row", gap: space[3] }}
              accessibilityLabel={count > 1 ? `${event.text}, ${repeatWords(run, spokenAge)}` : undefined}
            >
              <Text style={[text.small, text.tabular, { width: 40 }]}>{ago(event.ts)}</Text>
              <View style={{ flex: 1, gap: 2 }}>
                <View style={{ flexDirection: "row", alignItems: "baseline", gap: space[2], flexWrap: "wrap" }}>
                  <Text style={text.body}>{event.text}</Text>
                  {count > 1 ? <Text style={[text.small, text.tabular]}>{repeatText(run, ago)}</Text> : null}
                </View>
                {event.detail ? (
                  <Text style={text.small} numberOfLines={3}>
                    {event.detail}
                  </Text>
                ) : null}
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}
