// Open in Maestro (K2, BRO-3008): everything Maestro knows about one session, opened with
// `openScreen({ screenId: "session", params: { agentId } })` from a card's Open in Maestro. Identity and state; the
// holds on this session, each the same card as in the chat (client/session-card.tsx); the work it runs (brief,
// what changed, checks); its history; and the controls: send it a prompt, stop it, cancel the work, each with the
// 8 s undo and a receipt here (client/pending-verbs.tsx). A session Maestro does not track still shows its holds and
// offers to track it. Every read is live and every verb is the adapter's (client/verbs.ts).

import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { holdCard } from "../shared/card";
import type { WorkItem } from "../shared/contracts";
import { CARD_POLL_MS, type CardActions, useCardRunner } from "./card-hooks";
import { clockOf } from "./card-parts";
import { agoWords, duration, errorText } from "./format";
import { useAgentWork, useNeeds, useVerbs, useWorkDetail } from "./hooks";
import { Dot, Pill, SectionLabel, TABULAR } from "./kit/parts";
import { kitOf } from "./kit/tokens";
import { PendingVerbs, SettledVerbs } from "./pending-verbs";
import { titleText } from "./records-text";
import { SessionCard } from "./session-card";
import { Button, StateLabel, useText } from "./ui";
import { planVerb } from "./verbs";

/** The page's title in Paseo's header: it names the session by its short id until the work says more. */
export function sessionTitle(params: Record<string, string> | undefined): string {
  const id = params?.agentId;
  return id ? `Maestro · ${id.slice(0, 8)}` : "Maestro · session";
}

/** The screen, bound to how this plugin opens its own screens (a timeline card's Open in Maestro). */
export function createSessionScreen(actions: CardActions) {
  return function MaestroSessionScreen(props: PluginScreenProps) {
    return <SessionScreen {...props} actions={actions} />;
  };
}

function Panel({ theme, label, children }: { theme: PluginTheme; label: string; children: React.ReactNode }) {
  const kit = kitOf(theme);
  return (
    <View
      style={{
        borderRadius: 16,
        borderWidth: 1,
        borderColor: kit.hairline,
        backgroundColor: kit.bg,
        padding: 16,
        gap: 10,
      }}
    >
      <SectionLabel theme={theme}>{label}</SectionLabel>
      {children}
    </View>
  );
}

function Chip({ theme, label, icon }: { theme: PluginTheme; label: string; icon: string }) {
  const kit = kitOf(theme);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        height: 28,
        paddingHorizontal: 11,
        borderRadius: 9999,
        backgroundColor: kit.sunken,
      }}
    >
      <Icon name={icon} size={13} color={kit.muted} />
      <Text style={{ color: kit.fg2, fontSize: 12.5 }}>{label}</Text>
    </View>
  );
}

/** The first line of a brief that says something: its heading marks are not words. */
export function briefLine(brief: string): string {
  const line = brief
    .split("\n")
    .map((one) => one.replace(/^[#>*\-\s]+/, "").trim())
    .find((one) => one.length > 0);
  return line ?? "";
}

/** What changed, in a line: "+96 −41". */
export function changedLine(item: Pick<WorkItem, "changed">): string | null {
  return item.changed ? `+${item.changed.additions} −${item.changed.deletions}` : null;
}

export function SessionScreen({
  theme,
  layout,
  navigation,
  params,
  actions,
}: PluginScreenProps & { actions: CardActions }) {
  const kit = kitOf(theme);
  const text = useText(theme);
  const agentId = params?.agentId ?? "";
  const found = useAgentWork(agentId);
  const item = found.data?.item ?? null;
  const detail = useWorkDetail(item?.id ?? null);
  const needs = useNeeds(CARD_POLL_MS);
  const verbs = useVerbs();
  const runner = useCardRunner(actions, `session:${agentId}`);
  const [prompt, setPrompt] = useState("");
  const wide = !layout.compact;

  if (!agentId) {
    return (
      <View style={{ flex: 1, padding: 24, backgroundColor: kit.sunken }}>
        <Text style={text.body}>No session was named. Open a session from a card's Open in Maestro.</Text>
      </View>
    );
  }
  const holds = (needs.data?.rows ?? []).flatMap((row) => {
    const card = holdCard(row);
    return card && card.agentId === agentId ? [{ row, card: card.card }] : [];
  });
  const events = [...(detail.data?.events ?? [])].reverse().slice(0, 8);
  const key = item ? `work:${item.id}` : `session:${agentId}`;
  const going = item?.state === "running" || item?.state === "review";
  const send = () => {
    if (!prompt.trim()) return;
    void runner.act(planVerb("prompt", { agentId, item }, undefined, prompt));
    setPrompt("");
  };

  const header = (
    <View
      style={{
        borderRadius: 16,
        borderWidth: 1,
        borderColor: kit.hairline,
        backgroundColor: kit.bg,
        padding: 16,
        gap: 10,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        {item ? <StateLabel theme={theme} state={item.state} /> : <Dot color={kit.muted} />}
        <Text
          accessibilityRole="header"
          style={{ ...(wide ? { flex: 1 } : { flexBasis: "100%" }), color: kit.fg, fontSize: 22, fontWeight: "600" }}
          numberOfLines={3}
        >
          {item ? titleText(item) : `Session ${agentId.slice(0, 8)}`}
        </Text>
        <Pill theme={theme} label="Open the chat" height={40} onPress={() => navigation?.openAgent({ agentId })} />
      </View>
      {detail.data?.brief ? (
        <Text style={{ color: kit.fg2, fontSize: 14.5, lineHeight: 21 }} numberOfLines={3}>
          {briefLine(detail.data.brief)}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {item ? (
          <>
            <Chip theme={theme} icon="GitBranch" label={item.display?.fleet?.scope ?? item.project ?? "work"} />
            {item.ticket ? <Chip theme={theme} icon="Ticket" label={item.ticket} /> : null}
            {item.worker?.branch ? <Chip theme={theme} icon="GitFork" label={item.worker.branch} /> : null}
            {item.worker?.startedWith ? <Chip theme={theme} icon="Cpu" label={item.worker.startedWith} /> : null}
            <Chip theme={theme} icon="Timer" label={duration(Date.now() - Date.parse(item.createdAt))} />
          </>
        ) : (
          <Chip theme={theme} icon="CircleDashed" label="Not tracked as work" />
        )}
      </View>
    </View>
  );

  const heldBy = (
    <Panel theme={theme} label={`Holds on this session${holds.length ? " · the same card as in the chat" : ""}`}>
      {needs.isError ? (
        <Text testID="session-holds-unread" style={{ color: kit.fg2, fontSize: 14 }}>
          {`Couldn't read what holds this session: ${errorText(needs.error)}`}
        </Text>
      ) : needs.isPending ? (
        <ActivityIndicator color={kit.muted} />
      ) : holds.length === 0 ? (
        <Text testID="session-no-holds" style={{ color: kit.fg2, fontSize: 14 }}>
          Nothing holds on this session.
        </Text>
      ) : (
        holds.map(({ card }) => (
          <SessionCard
            key={`${card.key}:${card.version}`}
            data={card}
            host={agentId}
            theme={theme}
            compact={!wide}
            actions={actions}
          />
        ))
      )}
    </Panel>
  );

  const work = item ? (
    <Panel theme={theme} label="Work">
      <Fact theme={theme} label="Brief" value={detail.data?.brief ? briefLine(detail.data.brief) : "—"} />
      <Fact theme={theme} label="Changed" value={changedLine(item) ?? "nothing read yet"} />
      <Fact
        theme={theme}
        label="Checks"
        value={item.verdict ?? (item.checks.length ? `${item.checks.length} to run` : "none set")}
      />
    </Panel>
  ) : (
    <Panel theme={theme} label="Work">
      <Text style={{ color: kit.fg2, fontSize: 14, lineHeight: 20 }}>
        Maestro keeps no work for this session. Track it and Maestro keeps its receipts, and it lands at your gate when
        it stops.
      </Text>
      <View style={{ flexDirection: "row" }}>
        <Button
          theme={theme}
          variant="primary"
          icon="ListPlus"
          label="Track as work"
          compact={!wide}
          busy={verbs.adopt.isPending}
          onPress={() => verbs.adopt.mutate({ agentId, title: "" })}
        />
      </View>
    </Panel>
  );

  const history = (
    <Panel theme={theme} label="History">
      {detail.isError ? (
        <Text style={{ color: kit.fg2, fontSize: 14 }}>{`Couldn't read its history: ${errorText(detail.error)}`}</Text>
      ) : events.length === 0 ? (
        <Text style={{ color: kit.muted, fontSize: 13.5 }}>
          {item ? "Nothing recorded yet." : "No history without work."}
        </Text>
      ) : (
        events.map((event) => (
          <View key={`${event.ts}:${event.type}:${event.text}`} style={{ flexDirection: "row", gap: 10 }}>
            <Text
              style={{ color: kit.muted, fontSize: 12.5, fontFamily: "ui-monospace, Menlo, monospace", ...TABULAR }}
            >
              {clockOf(event.ts)}
            </Text>
            <Text style={{ flex: 1, color: kit.fg, fontSize: 14 }}>{event.text}</Text>
          </View>
        ))
      )}
      {item?.lastEventAt ? (
        <Text style={{ color: kit.muted, fontSize: 12 }}>{`Last event ${agoWords(item.lastEventAt)}`}</Text>
      ) : null}
    </Panel>
  );

  const controls = (
    <Panel theme={theme} label="Controls">
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          minHeight: 48,
          paddingLeft: 14,
          paddingRight: 6,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: kit.border,
          backgroundColor: kit.sunken,
        }}
      >
        <TextInput
          value={prompt}
          onChangeText={setPrompt}
          placeholder="Send this session a prompt…"
          placeholderTextColor={kit.muted}
          accessibilityLabel="Send this session a prompt"
          onSubmitEditing={send}
          style={{ flex: 1, color: kit.fg, fontSize: 14.5, paddingVertical: 10 }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send the prompt"
          accessibilityState={{ disabled: !prompt.trim() || runner.busy }}
          disabled={!prompt.trim() || runner.busy}
          onPress={send}
          style={({ pressed }) => ({
            width: 36,
            height: 36,
            borderRadius: 9999,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: kit.ink,
            opacity: !prompt.trim() || runner.busy ? 0.4 : pressed ? 0.8 : 1,
          })}
        >
          <Icon name="ArrowUp" size={18} color={kit.onInk} />
        </Pressable>
      </View>
      {item ? (
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          <Pill
            theme={theme}
            label="Stop"
            height={40}
            disabled={runner.busy || !going}
            onPress={() => void runner.act(planVerb("stop", { item }))}
          />
          <Pill
            theme={theme}
            label="Cancel the work"
            height={40}
            disabled={runner.busy || item.state === "done" || item.state === "canceled"}
            onPress={() => void runner.act(planVerb("cancel", { item }))}
          />
        </View>
      ) : null}
      <PendingVerbs theme={theme} compact={!wide} keys={[key, `session:${agentId}`]} />
      <SettledVerbs theme={theme} keys={[key, `session:${agentId}`]} />
      <Text style={{ color: kit.muted, fontSize: 12.5 }}>
        Stop and cancel keep an 8 s undo and leave a receipt here.
      </Text>
    </Panel>
  );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: kit.sunken }}
      contentContainerStyle={{ padding: wide ? 24 : 16, gap: 12 }}
    >
      {wide ? (
        <View style={{ flexDirection: "row", gap: 16, alignItems: "flex-start" }}>
          <View style={{ flex: 3, gap: 12 }}>
            {header}
            {heldBy}
            {work}
          </View>
          <View style={{ flex: 2, gap: 12 }}>
            {history}
            {controls}
          </View>
        </View>
      ) : (
        <>
          {header}
          {heldBy}
          {work}
          {controls}
          {history}
        </>
      )}
    </ScrollView>
  );
}

function Fact({ theme, label, value }: { theme: PluginTheme; label: string; value: string }) {
  const kit = kitOf(theme);
  return (
    <View style={{ flexDirection: "row", gap: 16 }}>
      <Text style={{ width: 70, color: kit.muted, fontSize: 13.5 }}>{label}</Text>
      <Text style={{ flex: 1, color: kit.fg, fontSize: 14 }}>{value}</Text>
    </View>
  );
}
