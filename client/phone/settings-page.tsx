// The phone's Settings (M11, BRO-3037; docs/design/next/m11-settings-mobile.png): a card from the presence
// menu's foot, grouped rows in the iPhone pattern, one level deep. It draws only what has data: Presence (read,
// BRO-2987 gives it a switch), Runs and gate (config.get / config.set, the 8 s undo and a receipt), the loop and
// its lanes (loop.get, fleet.get), Loops (loops.get) and Notices (notices.list). Notifications, Approvals,
// Credentials and Appearance have no read or write behind them yet and are not drawn; Run tick has no call.

import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { NoticeKind } from "../../shared/notices";
import { useFleet } from "../fleet";
import { modeBadge } from "../fleet-cockpit-model";
import { ago } from "../format";
import { useConfig, useLoop, useNotices } from "../hooks";
import { Dot } from "../kit/parts";
import { kitOf } from "../kit/tokens";
import { LoopPanel } from "../loop";
import { LoopsView, useLoops } from "../loops";
import { sections } from "../loops-model";
import { PRESENCE_SIGNALS, PRESENCE_STATES, type PresenceRead, presenceFace } from "../presence";
import { MaestroSettings } from "../settings";
import type { SettingsPageId } from "./settings-trail";

const KIND_WORDS: Record<NoticeKind, string> = {
  stuck: "Stuck runs",
  quiet: "Quiet runs",
  schedule: "Schedules that failed or were missed",
  loop: "Loops that drifted",
  initiative: "Initiatives past their review date",
};

function Group({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  const kit = kitOf(theme);
  return (
    <View style={{ borderRadius: 14, overflow: "hidden", gap: 1, backgroundColor: kit.hairline }}>{children}</View>
  );
}

function Line({
  theme,
  icon,
  label,
  value,
  onPress,
}: {
  theme: PluginTheme;
  icon: string;
  label: string;
  value?: string;
  onPress?: () => void;
}) {
  const kit = kitOf(theme);
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : "text"}
      accessibilityLabel={value ? `${label}, ${value}` : label}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }: { pressed: boolean }) => ({
        minHeight: 52,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingHorizontal: 14,
        backgroundColor: kit.bg,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <View
        style={{
          width: 30,
          height: 30,
          borderRadius: 8,
          backgroundColor: kit.sunken,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name={icon} size={16} color={kit.fg2} />
      </View>
      <Text style={{ flex: 1, color: kit.fg, fontSize: 16 }}>{label}</Text>
      {value ? (
        <Text numberOfLines={1} style={{ color: kit.muted, fontSize: 15, maxWidth: 150 }}>
          {value}
        </Text>
      ) : null}
      {onPress ? <Icon name="ChevronRight" size={16} color={kit.muted} /> : null}
    </Pressable>
  );
}

function Heading({ theme, children }: { theme: PluginTheme; children: string }) {
  const kit = kitOf(theme);
  return (
    <Text accessibilityRole="header" style={{ color: kit.fg, fontSize: 28, fontWeight: "600", letterSpacing: -0.3 }}>
      {children}
    </Text>
  );
}

function Root({
  theme,
  presence,
  onPage,
}: {
  theme: PluginTheme;
  presence: PresenceRead;
  onPage: (page: SettingsPageId) => void;
}) {
  const kit = kitOf(theme);
  const config = useConfig();
  const loop = useLoop();
  const fleet = useFleet(null);
  const loops = useLoops();
  const notices = useNotices();
  const lanes = fleet.data ? `conductor + ${fleet.data.scopes.length}` : fleet.isError ? "not read" : "";
  const loopRows = loops.data ? sections(loops.data.rows).loops.length : null;
  return (
    <View style={{ gap: 12 }} testID="settings-root">
      <Heading theme={theme}>Settings</Heading>
      <Group theme={theme}>
        <Line
          theme={theme}
          icon="CircleDot"
          label="Presence"
          value={presenceFace(presence).label}
          onPress={() => onPage("presence")}
        />
      </Group>
      <Text style={{ color: kit.muted, fontSize: 12, fontWeight: "600", letterSpacing: 0.6 }}>ORCHESTRATION</Text>
      <Group theme={theme}>
        <Line
          theme={theme}
          icon="SlidersHorizontal"
          label="Runs and gate"
          value={config.data ? config.data.provider : config.isError ? "not read" : ""}
          onPress={() => onPage("runs")}
        />
        <Line theme={theme} icon="Radio" label="Lanes" value={lanes} onPress={() => onPage("lanes")} />
        <Line
          theme={theme}
          icon="Repeat"
          label="Loops"
          value={loopRows === null ? (loops.isError ? "not read" : "") : String(loopRows)}
          onPress={() => onPage("loops")}
        />
        <Line
          theme={theme}
          icon="CircleAlert"
          label="Notices"
          value={notices.data ? String(notices.data.summary.total) : notices.isError ? "not read" : ""}
          onPress={() => onPage("notices")}
        />
      </Group>
      <Text style={{ color: kit.muted, fontSize: 12.5, lineHeight: 17 }}>
        {loop.data && loop.data.minutes !== null
          ? `The loop wakes every ${loop.data.minutes} min. `
          : loop.data
            ? "The loop is off. "
            : ""}
        Changes apply after the 8 s undo and leave a receipt.
      </Text>
    </View>
  );
}

function PresencePage({ theme, presence }: { theme: PluginTheme; presence: PresenceRead }) {
  const kit = kitOf(theme);
  const tone = { present: kit.ok, away: kit.warn, off: kit.muted } as const;
  return (
    <View style={{ gap: 12 }}>
      <Heading theme={theme}>Presence</Heading>
      <Group theme={theme}>
        {PRESENCE_STATES.map((entry) => (
          <View
            key={entry.id}
            accessibilityLabel={`${entry.label}: ${entry.line}${entry.id === presence.state ? ", current" : ""}`}
            style={{ flexDirection: "row", gap: 12, padding: 14, backgroundColor: kit.bg, alignItems: "center" }}
          >
            <Dot color={tone[entry.id]} size={9} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: kit.fg, fontSize: 16, fontWeight: "600" }}>{entry.label}</Text>
              <Text style={{ color: kit.muted, fontSize: 13, lineHeight: 18 }}>{entry.line}</Text>
            </View>
            {entry.id === presence.state ? <Icon name="Check" size={16} color={kit.fg} /> : null}
          </View>
        ))}
      </Group>
      {presence.settable ? null : (
        <Text style={{ color: kit.warn, fontSize: 13, lineHeight: 18 }}>
          Choosing a state lands with BRO-2987. Until then Maestro reads you as present, from signals.
        </Text>
      )}
      <Text style={{ color: kit.muted, fontSize: 12.5, lineHeight: 17 }}>{PRESENCE_SIGNALS}</Text>
    </View>
  );
}

function LanesPage({ theme, onBack }: { theme: PluginTheme; onBack: () => void }) {
  const kit = kitOf(theme);
  const fleet = useFleet(null);
  const scopes = fleet.data?.scopes ?? [];
  const mode = modeBadge(scopes);
  return (
    <View style={{ gap: 12 }} testID="settings-lanes">
      <Heading theme={theme}>Lanes</Heading>
      <Text style={{ color: kit.muted, fontSize: 12, fontWeight: "600", letterSpacing: 0.6 }}>CONDUCTOR</Text>
      <LoopPanel theme={theme} onClose={onBack} />
      <Text style={{ color: kit.muted, fontSize: 12, fontWeight: "600", letterSpacing: 0.6 }}>LANES</Text>
      {fleet.isError && !fleet.data ? (
        <Text accessibilityRole="alert" style={{ color: kit.danger, fontSize: 14 }}>
          Couldn't read the fleet, so its lanes are not listed.
        </Text>
      ) : scopes.length === 0 ? (
        <Text style={{ color: kit.muted, fontSize: 14 }}>
          {fleet.isPending ? "Reading the fleet…" : "No fleet scope is configured."}
        </Text>
      ) : (
        <Group theme={theme}>
          {scopes.map((scope) => (
            <View key={scope.id} style={{ padding: 14, gap: 3, backgroundColor: kit.bg }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Dot color={scope.health.status === "ok" ? kit.ok : kit.warn} size={9} />
                <Text style={{ flex: 1, color: kit.fg, fontSize: 16, fontWeight: "600" }}>{`${scope.id} lane`}</Text>
                <Text style={{ color: kit.muted, fontSize: 12.5 }}>{scope.dryRun ? "Dry run" : "Live"}</Text>
              </View>
              <Text style={{ color: kit.fg2, fontSize: 13, lineHeight: 18 }}>
                {[
                  scope.lastTick ? `tick ${scope.lastTick.tick} · ${ago(scope.lastTick.at)}` : "no tick yet",
                  scope.health.reason,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </View>
          ))}
        </Group>
      )}
      {mode ? <Text style={{ color: kit.muted, fontSize: 12.5 }}>{mode}</Text> : null}
      <Text style={{ color: kit.muted, fontSize: 12.5, lineHeight: 17 }}>
        A lane never starts work by rule; the conductor allocates and the lane launches (A8). Running a tick from the
        phone waits for a call that does not exist yet.
      </Text>
    </View>
  );
}

function NoticesPage({ theme }: { theme: PluginTheme }) {
  const kit = kitOf(theme);
  const notices = useNotices();
  const summary = notices.data?.summary;
  return (
    <View style={{ gap: 12 }}>
      <Heading theme={theme}>Notices</Heading>
      {!summary ? (
        <Text accessibilityRole="alert" style={{ color: kit.danger, fontSize: 14 }}>
          {notices.isError ? "Couldn't read the notices." : "Reading the notices…"}
        </Text>
      ) : (
        <>
          <Group theme={theme}>
            {(Object.keys(KIND_WORDS) as NoticeKind[]).map((kind) => (
              <Line
                key={kind}
                theme={theme}
                icon="CircleAlert"
                label={KIND_WORDS[kind]}
                value={String(summary.byKind[kind])}
              />
            ))}
          </Group>
          <Text style={{ color: kit.muted, fontSize: 12.5, lineHeight: 17 }}>
            {`${summary.total} open · ${summary.snoozed} snoozed. A notice closes by itself when its source does.`}
            {summary.unread.length > 0 ? ` Couldn't read ${summary.unread.join(", ")}.` : ""}
          </Text>
        </>
      )}
    </View>
  );
}

export function SettingsPage({
  theme,
  page,
  presence,
  onPage,
}: {
  theme: PluginTheme;
  page: SettingsPageId;
  presence: PresenceRead;
  onPage: (page: SettingsPageId) => void;
}) {
  switch (page) {
    case "root":
      return <Root theme={theme} presence={presence} onPage={onPage} />;
    case "presence":
      return <PresencePage theme={theme} presence={presence} />;
    case "runs":
      return (
        <View style={{ gap: 12 }}>
          <Heading theme={theme}>Runs and gate</Heading>
          <MaestroSettings {...({ theme } as PluginSurfaceProps)} />
        </View>
      );
    case "lanes":
      return <LanesPage theme={theme} onBack={() => onPage("root")} />;
    case "loops":
      return (
        <View style={{ gap: 12 }}>
          <Heading theme={theme}>Loops</Heading>
          <LoopsView theme={theme} />
        </View>
      );
    case "notices":
      return <NoticesPage theme={theme} />;
  }
}
