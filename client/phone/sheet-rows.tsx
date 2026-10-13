// What the pull-up sheet lists (M1 frame 2): each group as a title and a rounded stack of swipe rows. A row's
// swipe is the kit's (client/kit/swipe-row.tsx): on a phone it goes left only (Paseo's sidebar takes every
// rightward drag, BRO-3033 fact 3), so the default verb (Continue) joins Snooze and Open there. A hold never
// swipes, and none of these rows is one. The count under each title is the length of the rows it lists.

import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import type { Directions } from "../kit/assumptions";
import { Dot } from "../kit/parts";
import { SwipeRow } from "../kit/swipe-row";
import { kitOf } from "../kit/tokens";
import { StandingPulse, TidepoolDot, Undertow } from "../kit/undertow";
import type { RowLead, SheetGroup, SheetRow } from "./model";

/** What a row's verbs do: the screen sends them through the one adapter (client/verbs.ts). */
export interface RowHandlers {
  /** The row's own page: its work in the inspector card, or the view that handles a notice. */
  onOpen: (row: SheetRow) => void;
  onContinue: (row: SheetRow) => void;
  onSnooze: (row: SheetRow) => void;
  /** Open its session; absent when the row has none. */
  onSession: (row: SheetRow) => void;
}

function Lead({ theme, lead }: { theme: PluginTheme; lead: RowLead }) {
  const kit = kitOf(theme);
  if (lead === "running") return <TidepoolDot theme={theme} state="running" />;
  if (lead === "standing") return <StandingPulse theme={theme} state="standing" />;
  const color = lead === "ok" ? kit.ok : lead === "danger" ? kit.danger : lead === "warn" ? kit.warn : kit.muted;
  return <Dot color={color} size={9} />;
}

export function SheetRows({
  theme,
  groups,
  directions,
  handlers,
  canContinue,
  hasSession,
  halo,
}: {
  theme: PluginTheme;
  groups: readonly SheetGroup[];
  directions: Directions;
  handlers: RowHandlers;
  /** Whether a row's session can be prompted (Continue): the work has a session to send it to. */
  canContinue: (row: SheetRow) => boolean;
  hasSession: (row: SheetRow) => boolean;
  /** Rows that wear the Undertow: Running's alone (B1). */
  halo?: (row: SheetRow) => boolean;
}) {
  const kit = kitOf(theme);
  return (
    <>
      {groups.map((group) => (
        <View key={group.id} testID={`sheet-group-${group.id}`} style={{ gap: 6 }}>
          {group.title ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4 }}>
              <Text accessibilityRole="header" style={{ color: kit.fg, fontSize: 15, fontWeight: "600" }}>
                {group.title}
              </Text>
              <Text style={{ color: kit.muted, fontSize: 13, fontVariant: ["tabular-nums"] }}>{group.rows.length}</Text>
            </View>
          ) : null}
          <View style={{ borderRadius: 14, overflow: "hidden", gap: 1, backgroundColor: kit.hairline }}>
            {group.rows.map((row) => {
              const swipe = (
                <SwipeRow
                  key={row.key}
                  theme={theme}
                  directions={directions}
                  kind={row.kind}
                  title={row.title}
                  meta={row.meta}
                  age={row.age}
                  lead={<Lead theme={theme} lead={row.lead} />}
                  onPress={() => handlers.onOpen(row)}
                  primary={
                    row.verbs.continue && canContinue(row)
                      ? { label: "Continue", icon: "Check", onPress: () => handlers.onContinue(row) }
                      : undefined
                  }
                  snooze={
                    row.verbs.snooze
                      ? { label: "Snooze 4h", icon: "AlarmClock", onPress: () => handlers.onSnooze(row) }
                      : undefined
                  }
                  open={{
                    label: "Open",
                    icon: "ArrowUpRight",
                    onPress: () => (hasSession(row) ? handlers.onSession(row) : handlers.onOpen(row)),
                  }}
                />
              );
              return halo?.(row) ? (
                <Undertow key={row.key} theme={theme} state="running" radius={18}>
                  {swipe}
                </Undertow>
              ) : (
                swipe
              );
            })}
          </View>
        </View>
      ))}
    </>
  );
}
