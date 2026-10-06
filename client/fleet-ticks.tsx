// A scope's ticks in the cockpit: the latest tick's card (its steps, each with
// what tick.log says it did), the sheet a tick opens in (its report and log
// lines, read only then), and the list of every tick read.

import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { type FleetDetail, type FleetTick, getFleetTick } from "../shared/fleet";
import { tickLine, tickSteps } from "./fleet-cockpit-model";
import { classText, TICK_LABEL, tickFacts, tickLabel, tickTone, tickWhen } from "./fleet-model";
import { Pill, ramp, type Tone, tint, toneInk, Verb } from "./fleet-ui";
import { errorText, plural } from "./format";
import { MarkdownView } from "./markdown-view";
import { Card, Notice, radius, space, useText } from "./ui";

/** A tick's tone, with running in info blue rather than the accent. */
function tickPill(status: FleetTick["status"]): Tone {
  const tone = tickTone(status);
  return tone === "accent" ? "info" : tone;
}

/** Ticks come hourly: a read every 30 s is plenty, and the reads are files. */
export const POLL_MS = 30_000;

/** One tick's report and log lines, read when it is opened (and for the latest tick's step words). */
export function useFleetTick(scope: string, tick: number, enabled: boolean) {
  const get = useRpc(getFleetTick);
  return useQuery({
    queryKey: ["maestro", "fleet-tick", scope, tick],
    queryFn: () => get({ scope, tick }),
    enabled,
    staleTime: POLL_MS,
  });
}

/** A tick's report, failed step, exit and log lines: what opening a tick shows, and an ask's details. */
export function TickDetail({
  theme,
  scope,
  tick,
  facts,
  compact,
  first = "log",
}: {
  theme: PluginTheme;
  scope: string;
  tick: number;
  facts: string | null;
  compact: boolean;
  /** Which comes first: the log lines or the report. */
  first?: "log" | "report";
}) {
  const text = useText(theme);
  const read = useFleetTick(scope, tick, true);
  if (read.isPending) {
    return (
      <View style={{ gap: space[2], paddingVertical: space[2] }}>
        {facts ? <Text style={[text.small, text.tabular, { color: theme.colors.foreground }]}>{facts}</Text> : null}
        <ActivityIndicator color={theme.colors.foregroundMuted} />
      </View>
    );
  }
  if (read.isError) {
    return (
      <Notice theme={theme} tone="danger">
        {errorText(read.error)}
      </Notice>
    );
  }
  const log = read.data.log ? (
    <View key="log" style={{ gap: space[1] }}>
      <Text style={text.label}>{`What tick ${tick} logged`}</Text>
      <View
        style={{
          padding: space[2],
          borderRadius: radius.control,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface0,
        }}
      >
        <Text style={text.mono} selectable numberOfLines={compact ? 16 : 40}>
          {read.data.log.text}
        </Text>
      </View>
      <Text style={text.small} selectable numberOfLines={1}>
        {read.data.log.truncated ? `The end of it, from ${read.data.log.path}` : read.data.log.path}
      </Text>
    </View>
  ) : (
    <Text key="log" style={text.small}>{`tick.log holds no lines for tick ${tick}.`}</Text>
  );
  const report = read.data.report ? (
    <View key="report" style={{ gap: space[1] }}>
      <Text style={text.label}>{`Tick ${tick}'s report`}</Text>
      <Card theme={theme}>
        <MarkdownView source={read.data.report.markdown} theme={theme} compact={compact} />
        {read.data.report.truncated ? <Text style={text.small}>The report is longer than this.</Text> : null}
      </Card>
    </View>
  ) : (
    <Text key="report" style={text.small}>{`Tick ${tick} wrote no report.`}</Text>
  );
  return (
    <View style={{ gap: space[2], paddingVertical: space[2] }}>
      {facts ? <Text style={[text.small, text.tabular, { color: theme.colors.foreground }]}>{facts}</Text> : null}
      {read.data.notes.map((note) => (
        <Notice key={note} theme={theme} tone="warn">
          {note}
        </Notice>
      ))}
      {first === "report" ? [report, log] : [log, report]}
    </View>
  );
}

/** One tick in the list: its number, when, its status in words, its classes; opened, its detail. */
export function TickRow({
  theme,
  scope,
  tick,
  compact,
  open,
  onToggle,
}: {
  theme: PluginTheme;
  scope: string;
  tick: FleetTick;
  compact: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const t = ramp(theme);
  const tone = tickPill(tick.status);
  const classes = <Text style={[t.meta, compact ? null : { flex: 1 }]}>{classText(tick.classCounts)}</Text>;
  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        accessibilityLabel={`${tickLabel(tick)}. ${classText(tick.classCounts)}`}
        onPress={onToggle}
        style={({ pressed }) => ({
          minHeight: 44,
          justifyContent: "center",
          paddingVertical: space[2],
          gap: 2,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[3], flexWrap: "wrap" }}>
          <Text style={[t.body, t.tabular, { fontWeight: "600", minWidth: 36 }]}>{tick.tick}</Text>
          <Text style={[t.meta, t.tabular, { minWidth: 96 }]}>{tickWhen(tick.at)}</Text>
          <Pill
            theme={theme}
            tone={tone}
            label={`${TICK_LABEL[tick.status]}${tick.failedStep ? ` at ${tick.failedStep}` : ""}`}
          />
          {compact ? null : classes}
        </View>
        {compact ? classes : null}
      </Pressable>
      {open ? (
        <TickDetail theme={theme} scope={scope} tick={tick.tick} facts={tickFacts(tick)} compact={compact} />
      ) : null}
    </View>
  );
}

/** What a tick sheet shows: one tick opened on its report or its log, or every tick read. */
export type TickSheetState = { scope: string; tick: number; first: "log" | "report" } | { scope: string; all: true };

/** The sheet a tick opens in: the host's modal, so it sits over the cockpit on every client. */
export function TickSheet({
  theme,
  compact,
  sheet,
  detail,
  openTick,
  onOpenTick,
  onClose,
}: {
  theme: PluginTheme;
  compact: boolean;
  sheet: TickSheetState | null;
  /** The scope's detail, for the list of every tick. */
  detail: FleetDetail | null;
  openTick: number | null;
  onOpenTick: (tick: number | null) => void;
  onClose: () => void;
}) {
  const t = ramp(theme);
  const title = !sheet ? "Tick" : "all" in sheet ? `Ticks · ${sheet.scope}` : `Tick ${sheet.tick} · ${sheet.scope}`;
  const row = sheet && "tick" in sheet ? (detail?.ticks.find((entry) => entry.tick === sheet.tick) ?? null) : null;
  return (
    <Modal
      title={title}
      icon={<Icon name="Activity" size={18} color={theme.colors.foreground} />}
      open={sheet !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal.Content>
        {sheet === null ? null : "all" in sheet ? (
          detail && detail.id === sheet.scope ? (
            <View>
              <Text
                style={[t.meta, { marginBottom: space[2] }]}
              >{`The last ${plural(detail.ticks.length, "tick")}, newest first.`}</Text>
              {detail.ticks.map((entry) => (
                <TickRow
                  key={entry.tick}
                  theme={theme}
                  scope={sheet.scope}
                  tick={entry}
                  compact={compact}
                  open={openTick === entry.tick}
                  onToggle={() => onOpenTick(openTick === entry.tick ? null : entry.tick)}
                />
              ))}
            </View>
          ) : (
            <ActivityIndicator color={theme.colors.foregroundMuted} />
          )
        ) : (
          <TickDetail
            theme={theme}
            scope={sheet.scope}
            tick={sheet.tick}
            facts={row ? tickFacts(row) : null}
            compact={compact}
            first={sheet.first}
          />
        )}
      </Modal.Content>
    </Modal>
  );
}

/**
 * The side column's card: the latest tick of one scope, its status, when and
 * how long, and each step with a check (or skipped, or failed) and one line.
 */
export function LatestTick({
  theme,
  scope,
  detail,
  others = [],
  phone,
  onOpen,
}: {
  theme: PluginTheme;
  scope: string;
  detail: FleetDetail | null;
  /** Under All, every other scope's latest tick as a compact row that opens it. */
  others?: readonly { scope: string; detail: FleetDetail | null }[];
  phone: boolean;
  onOpen: (sheet: TickSheetState) => void;
}) {
  const t = ramp(theme);
  const latest = detail?.ticks[0] ?? null;
  // What each step said comes with the read (the end of tick.log); the report and the log wait to be opened.
  const said = detail?.stepWords && detail.stepWords.tick === latest?.tick ? detail.stepWords.said : {};
  const steps = latest ? tickSteps(latest, said) : [];
  return (
    <View
      style={{
        padding: space[4],
        gap: space[3],
        borderRadius: radius.card,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
        <Text style={[t.cardTitle, { flex: 1 }]} accessibilityRole="header" numberOfLines={1}>
          {`Latest tick · ${scope}`}
        </Text>
        {latest ? <Pill theme={theme} tone={tickPill(latest.status)} label={TICK_LABEL[latest.status]} /> : null}
      </View>
      {!detail ? (
        <ActivityIndicator color={theme.colors.foregroundMuted} />
      ) : !latest ? (
        <Text style={t.muted}>No tick has run in this scope yet.</Text>
      ) : (
        <>
          <Text style={[t.meta, t.tabular]}>{tickLine(latest)}</Text>
          {steps.length === 0 ? (
            <Text style={t.meta}>{tickFacts(latest)}</Text>
          ) : (
            <View style={{ gap: space[2] }} accessibilityLabel={`Tick ${latest.tick}'s steps`}>
              {steps.map((step) => {
                const tone = !step.ok ? "danger" : step.skipped ? "muted" : "success";
                const ink = toneInk(theme, tone);
                const word = !step.ok ? "failed" : step.skipped ? "skipped" : "passed";
                return (
                  <View
                    key={step.name}
                    style={{ flexDirection: "row", gap: space[3], alignItems: "flex-start" }}
                    accessible
                    accessibilityLabel={`${step.name}, ${word}: ${step.detail}`}
                  >
                    <View
                      style={{
                        width: 20,
                        height: 20,
                        marginTop: 1,
                        borderRadius: 20,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: tint(ink, 0.16),
                      }}
                    >
                      <Icon name={!step.ok ? "X" : step.skipped ? "Minus" : "Check"} size={12} color={ink} />
                    </View>
                    <View style={{ flex: 1, gap: 1 }}>
                      <Text style={[t.mono, { fontWeight: "600" }]}>{step.name}</Text>
                      <Text style={t.meta} numberOfLines={2}>
                        {step.skipped ? `skipped: ${step.detail}` : step.detail}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </View>
          )}
          <View style={{ flexDirection: "row", gap: space[1], flexWrap: "wrap", marginLeft: -space[2] }}>
            <Verb
              theme={theme}
              weight="quiet"
              icon="FileText"
              label="Report"
              phone={phone}
              accessibilityLabel={`Open tick ${latest.tick}'s report`}
              onPress={() => onOpen({ scope, tick: latest.tick, first: "report" })}
            />
            <Verb
              theme={theme}
              weight="quiet"
              icon="SquareTerminal"
              label="Log"
              phone={phone}
              accessibilityLabel={`Open tick ${latest.tick}'s log`}
              onPress={() => onOpen({ scope, tick: latest.tick, first: "log" })}
            />
            <Verb
              theme={theme}
              weight="quiet"
              icon="History"
              label="All ticks"
              phone={phone}
              accessibilityLabel={`All ticks, ${scope}`}
              onPress={() => onOpen({ scope, all: true })}
            />
          </View>
        </>
      )}
      {others.map((other) => {
        const tick = other.detail?.ticks[0] ?? null;
        return (
          <Pressable
            key={other.scope}
            accessibilityRole="button"
            accessibilityLabel={
              tick
                ? `Latest tick · ${other.scope}: ${TICK_LABEL[tick.status]}, ${tickLine(tick)}. Open its log`
                : `Latest tick · ${other.scope}: none read`
            }
            disabled={!tick}
            onPress={() => (tick ? onOpen({ scope: other.scope, tick: tick.tick, first: "log" }) : undefined)}
            style={({ pressed }) => ({
              minHeight: 40,
              flexDirection: "row",
              alignItems: "center",
              gap: space[2],
              paddingTop: space[2],
              borderTopWidth: 1,
              borderTopColor: theme.colors.border,
              opacity: pressed ? 0.8 : 1,
            })}
          >
            <Text style={[t.body, { fontWeight: "600", minWidth: 56 }]}>{other.scope}</Text>
            <Text style={[t.meta, t.tabular, { flex: 1 }]} numberOfLines={1}>
              {tick ? tickLine(tick) : other.detail ? "No tick yet" : "Reading…"}
            </Text>
            {tick ? <Pill theme={theme} tone={tickPill(tick.status)} label={TICK_LABEL[tick.status]} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}
