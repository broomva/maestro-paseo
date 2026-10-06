// The approval card Maestro leaves in a worker's timeline when its run lands
// at your gate (server/gate-card.ts appends it). It reads the work live. The
// card for the current landing, in the current worker's session, carries the
// look and the verbs while the work waits on you, and says how it left the
// gate afterwards. Any other card says it was superseded and offers nothing
// (client/gate-state.ts decides which).

import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginTimelineItemProps, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { type ComponentType, type ReactNode, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { getWork, type WorkItem } from "../shared/contracts";
import type { GateCardData } from "../shared/gate-card";
import { ArcReport } from "./arc-report";
import { errorText } from "./format";
import { LookView, VERBS_MEAN, verbsNeedSaying } from "./gate-look";
import { answerTarget, cardSettled, cardView, resolution, SUPERSEDED } from "./gate-state";
import { useVerbs } from "./hooks";
import type { MaestroIntent } from "./intent";
import { titleText } from "./records-text";
import { Button, Card, Notice, radius, StateLabel, space, useText } from "./ui";

type Open = (intent: MaestroIntent) => void;

/**
 * The work behind a card, polled like the surfaces poll (and on the same cache
 * key, so a verb anywhere refreshes it) until the card can no longer change.
 */
function useCardWork(card: GateCardData) {
  const get = useRpc(getWork);
  return useQuery({
    queryKey: ["maestro", "item", card.workId],
    queryFn: () => get({ id: card.workId }),
    refetchInterval: (query) => {
      const item = query.state.data?.item;
      return item && cardSettled(card, item) ? false : 4000;
    },
  });
}

/** The renderer, bound to how this plugin opens Maestro (timeline items get no navigation). */
export function createGateCard(open: Open): ComponentType<PluginTimelineItemProps<GateCardData>> {
  function MaestroGateCard({ item, theme, layout }: PluginTimelineItemProps<GateCardData>) {
    return <GateCard card={item.data} theme={theme} compact={layout.compact} open={open} />;
  }
  return MaestroGateCard;
}

function GateCard({
  card,
  theme,
  compact,
  open,
}: {
  card: GateCardData;
  theme: PluginTheme;
  compact: boolean;
  open: Open;
}) {
  const detail = useCardWork(card);
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
        <GateBody card={card} item={detail.data.item} theme={theme} compact={compact} open={open} />
      )}
    </Card>
  );
}

function GateBody({
  card,
  item,
  theme,
  compact,
  open,
}: {
  card: GateCardData;
  item: WorkItem;
  theme: PluginTheme;
  compact: boolean;
  open: Open;
}) {
  const text = useText(theme);
  const view = cardView(card, item);
  const target = answerTarget(card, item);
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
        {view === "superseded" ? null : <StateLabel theme={theme} state={item.state} />}
        <Text style={[text.body, { fontWeight: "600" }]} numberOfLines={2}>
          {titleText(item)}
        </Text>
      </View>
      {view === "asking" && target ? (
        <Asking item={item} target={target} theme={theme} compact={compact} after={openInMaestro} />
      ) : view === "deciding" ? (
        <Deciding item={item} theme={theme} compact={compact} after={openInMaestro} open={open} />
      ) : (
        <View style={{ gap: space[2] }}>
          <Text style={text.muted}>{view === "superseded" ? SUPERSEDED : resolution(item)}</Text>
          <View style={{ flexDirection: "row" }}>{openInMaestro}</View>
        </View>
      )}
    </View>
  );
}

function Deciding({
  item,
  theme,
  compact,
  after,
  open,
}: {
  item: WorkItem;
  theme: PluginTheme;
  compact: boolean;
  after: ReactNode;
  open: Open;
}) {
  const verbs = useVerbs();
  const toast = useToast();
  const [note, setNote] = useState("");
  const [sendingBack, setSendingBack] = useState(false);
  const text = useText(theme);
  const fail = (error: unknown) => toast.error(errorText(error));
  // What it asks first, then its own words, then the verbs; how long it ran is the footer.
  return (
    <View style={{ gap: space[3] }}>
      {item.look ? <LookView look={item.look} theme={theme} compact={compact} /> : null}
      <ArcReport item={item} theme={theme} compact={compact} open={open} />
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
      {!sendingBack && verbsNeedSaying(item.look) ? <Text style={text.small}>{VERBS_MEAN}</Text> : null}
      {item.look ? <Text style={[text.small, text.tabular]}>{item.look.ran}</Text> : null}
    </View>
  );
}

/** Answers the question for `target`, the card's own session (answerTarget checked it is still the worker's). */
function Asking({
  item,
  target,
  theme,
  compact,
  after,
}: {
  item: WorkItem;
  target: string;
  theme: PluginTheme;
  compact: boolean;
  after: ReactNode;
}) {
  const paseo = usePaseo();
  const toast = useToast();
  const text = useText(theme);
  const [answering, setAnswering] = useState(false);
  const permission = item.permission;
  if (!permission) return null;
  const answer = async (allow: boolean) => {
    setAnswering(true);
    try {
      await paseo.agents.ref(target).respondToPermission({
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
          compact={compact}
          onPress={() => void answer(true)}
        />
        <Button theme={theme} label="Deny" disabled={answering} compact={compact} onPress={() => void answer(false)} />
        {after}
      </View>
    </View>
  );
}
