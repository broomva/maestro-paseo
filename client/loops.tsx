// The Loops tab (BRO-2911): every loop on this machine, one row each, its
// intent from the ledger beside what is observed, a badge per drift class,
// its last and next run, its owner and purpose. Pressing a row opens what
// each drift means and its pinned fix, to copy: Maestro runs none of it.
// Ledger rows that could not be read are listed, never dropped.
//
// LoopsNotices is the same where the rest of Maestro shows what needs you.

import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { attentionWork } from "../shared/contracts";
import { getLoops, type LoopDrift, type LoopRow } from "../shared/loops";
import { errorText } from "./format";
import { keyedLines } from "./loop-model";
import {
  DRIFT_WORDS,
  driftTone,
  intentWords,
  KIND_WORDS,
  LOOPS_POLL_MS,
  noticeWords,
  observedWords,
  rowLabel,
  runWords,
  sections,
  summary,
} from "./loops-model";
import { Button, Card, IconButton, Notice, radius, Section, size, space, useText } from "./ui";

export function useLoops() {
  const get = useRpc(getLoops);
  return useQuery({ queryKey: ["maestro", "loops"], queryFn: () => get({}), refetchInterval: LOOPS_POLL_MS });
}

function Badge({ theme, drift }: { theme: PluginTheme; drift: LoopDrift }) {
  const color = driftTone(drift) === "danger" ? theme.colors.statusDanger : theme.colors.statusWarning;
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: color,
        borderRadius: radius.pill,
        paddingHorizontal: space[2],
        paddingVertical: 1,
      }}
    >
      <Text style={{ color, fontSize: size.xs, fontWeight: "600" }}>{DRIFT_WORDS[drift.kind]}</Text>
    </View>
  );
}

function Fact({ theme, label, value }: { theme: PluginTheme; label: string; value: string | null | undefined }) {
  const text = useText(theme);
  if (!value) return null;
  return (
    <Text style={text.small}>
      <Text style={text.label}>{label} </Text>
      {value}
    </Text>
  );
}

function LoopRowView({
  theme,
  row,
  now,
  open,
  onToggle,
}: {
  theme: PluginTheme;
  row: LoopRow;
  now: number;
  open: boolean;
  onToggle: () => void;
}) {
  const text = useText(theme);
  const runs = runWords(row, now);
  return (
    <View style={{ gap: space[2], paddingTop: space[3], borderTopWidth: 1, borderTopColor: theme.colors.border }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        accessibilityLabel={rowLabel(row)}
        onPress={onToggle}
        style={({ pressed }) => ({ gap: space[1], opacity: pressed ? 0.85 : 1 })}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}>
          <Text style={[text.body, { flexShrink: 1, fontWeight: "600" }]} numberOfLines={1}>
            {row.id ?? row.name}
          </Text>
          {row.drift.map((drift) => (
            <Badge key={drift.kind} theme={theme} drift={drift} />
          ))}
        </View>
        <Text style={text.small} numberOfLines={1}>
          {KIND_WORDS[row.kind]} · {row.observed?.cadence ?? row.intent?.cadence ?? row.ref}
        </Text>
        <View style={{ flexDirection: "row", gap: space[3], flexWrap: "wrap" }}>
          <Text style={text.small}>
            <Text style={text.label}>Intent </Text>
            {intentWords(row)}
          </Text>
          <Text style={text.small}>
            <Text style={text.label}>Observed </Text>
            {observedWords(row)}
          </Text>
        </View>
        {runs ? <Text style={[text.small, text.tabular]}>{runs}</Text> : null}
        {row.purpose ? (
          <Text style={text.small} numberOfLines={open ? undefined : 1}>
            {row.purpose}
          </Text>
        ) : null}
      </Pressable>
      {open ? (
        <View style={{ gap: space[2], paddingLeft: space[2] }}>
          {row.drift.map((drift) => (
            <View key={drift.kind} style={{ gap: space[1] }}>
              <Text style={[text.body, { fontWeight: "600" }]}>
                {DRIFT_WORDS[drift.kind]}
                {drift.needsYou ? "" : " (shown, not raised)"}
              </Text>
              <Text style={text.small}>{drift.detail}</Text>
              <View
                style={{
                  padding: space[2],
                  borderRadius: radius.control,
                  backgroundColor: theme.colors.surface2 ?? theme.colors.surface1,
                }}
              >
                <Text style={text.mono} selectable accessibilityLabel={`Pinned fix: ${drift.fix}`}>
                  {drift.fix}
                </Text>
              </View>
            </View>
          ))}
          <Fact theme={theme} label="Substrate" value={`${row.kind} ${row.ref}`} />
          <Fact theme={theme} label="Status" value={row.observed?.reason} />
          <Fact theme={theme} label="Ledger" value={row.intent?.file} />
          <Fact theme={theme} label="Reason" value={row.intent?.reason} />
          <Fact theme={theme} label="Prompt" value={row.intent?.prompt} />
          <Fact theme={theme} label="Bound to" value={row.observed?.target?.agentId} />
          <Fact theme={theme} label="Record" value={row.observed?.where} />
        </View>
      ) : null}
    </View>
  );
}

export function LoopsView({ theme }: { theme: PluginTheme }) {
  const text = useText(theme);
  const loops = useLoops();
  const [open, setOpen] = useState<string | null>(null);
  if (loops.isPending) return <ActivityIndicator color={theme.colors.foregroundMuted} />;
  if (loops.isError) {
    return (
      <View style={{ gap: space[3] }}>
        <Notice theme={theme} tone="danger">
          {errorText(loops.error)}
        </Notice>
        <Button theme={theme} label="Try again" onPress={() => void loops.refetch()} />
      </View>
    );
  }
  const view = loops.data;
  const now = Date.parse(view.now);
  const { loops: standing, ephemeral } = sections(view.rows);
  const rowOf = (row: LoopRow) => (
    <LoopRowView
      key={row.subject}
      theme={theme}
      row={row}
      now={now}
      open={open === row.subject}
      onToggle={() => setOpen((current) => (current === row.subject ? null : row.subject))}
    />
  );
  return (
    <Card theme={theme}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space[2] }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={text.title} accessibilityRole="header">
            Loops
          </Text>
          <Text style={text.small}>
            Each loop's intent, from{" "}
            {view.ledger
              ? `${view.ledger.path}${view.ledger.sha ? ` @ ${view.ledger.sha.slice(0, 7)}` : ""}`
              : "no ledger"}
            , beside what runs. {summary(view.rows)}
          </Text>
        </View>
        <IconButton theme={theme} icon="RefreshCw" label="Refresh the loops" onPress={() => void loops.refetch()} />
      </View>
      {view.ledgerErrors.map((error) => (
        <Notice key={error.file} theme={theme} tone="warn">
          {`${error.file}: ${error.error}`}
        </Notice>
      ))}
      {keyedLines(view.warnings.slice(0, 3)).map(({ key, line }) => (
        <Notice key={key} theme={theme} tone="warn">
          {line}
        </Notice>
      ))}
      {view.warnings.length > 3 ? (
        <Text style={text.small}>{`And ${view.warnings.length - 3} more that could not be read.`}</Text>
      ) : null}
      {standing.length === 0 ? <Text style={text.muted}>No loop is registered or observed.</Text> : standing.map(rowOf)}
      {ephemeral.length > 0 ? (
        <Section theme={theme} title="Session & watchers" meta={`${ephemeral.length} ephemeral, never registered`}>
          {ephemeral.map(rowOf)}
        </Section>
      ) : null}
    </Card>
  );
}

/** A loop drift that needs you, above the other views, with a way to the tab. */
export function LoopsNotices({ theme, compact, onOpen }: { theme: PluginTheme; compact: boolean; onOpen: () => void }) {
  const read = useRpc(attentionWork);
  const attention = useQuery({
    queryKey: ["maestro", "attention"],
    queryFn: () => read({}),
    refetchInterval: LOOPS_POLL_MS,
  });
  const notices = attention.data?.loops ?? [];
  if (notices.length === 0) return null;
  return (
    <View style={{ gap: space[2] }}>
      {notices.map((notice) => (
        <Notice
          key={notice.id}
          theme={theme}
          tone="warn"
          action={
            <Button
              theme={theme}
              icon="Repeat"
              label="Open Loops"
              compact={compact}
              accessibilityLabel={`Open Loops, ${notice.loop}`}
              onPress={onOpen}
            />
          }
        >
          {noticeWords(notice)}
        </Notice>
      ))}
    </View>
  );
}
