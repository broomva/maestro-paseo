// The phone's tab bar (Pen P1PV0; M1b's bar, riding on M1's sheet): Feed,
// Decisions, Work and Health with their counts, and New work as the round ink
// button. A solid capsule (no blur on iOS). It does not place itself: the
// pull-up sheet carries it on its top edge (client/kit/pull-sheet.tsx).

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import { tint } from "../fleet-color";
import { focusRing, webAria } from "../ui";
import { TABULAR } from "./parts";
import { kitOf } from "./tokens";

export interface Tab {
  id: string;
  label: string;
  icon: string;
  /** The tab's count; none or 0 shows no badge. */
  badge?: number;
  /** Needs you counts are Tidepool; Health's notices are warn. */
  badgeTone?: "needs" | "warn";
}

/** The bar's height; the sheet reserves this plus its margins above its top edge. */
export const TAB_BAR_HEIGHT = 62;

export function TabBar({
  theme,
  tabs,
  active,
  onSelect,
  onNew,
}: {
  theme: PluginTheme;
  tabs: readonly Tab[];
  active: string;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const kit = kitOf(theme);
  return (
    <View
      accessibilityRole="tablist"
      testID="tab-bar"
      style={{
        height: TAB_BAR_HEIGHT,
        borderRadius: 9999,
        backgroundColor: kit.bg,
        borderWidth: 1,
        borderColor: kit.hairline,
        flexDirection: "row",
        alignItems: "center",
        gap: 2,
        paddingHorizontal: 8,
        shadowColor: "#0c101a",
        shadowOpacity: kit.dark ? 0.5 : 0.14,
        shadowRadius: 24,
        shadowOffset: { width: 0, height: 6 },
      }}
    >
      {tabs.map((tab) => {
        const on = tab.id === active;
        const ink = on ? kit.fg : kit.muted;
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityLabel={tab.badge ? `${tab.label}, ${tab.badge}` : tab.label}
            accessibilityState={{ selected: on }}
            {...webAria({ "aria-current": on })}
            onPress={() => onSelect(tab.id)}
            style={({ focused }: { pressed: boolean; focused?: boolean }) => ({
              ...focusRing(theme, focused),
              flex: 1,
              height: 50,
              borderRadius: 9999,
              backgroundColor: on ? tint(kit.fg, kit.dark ? 0.1 : 0.05) : "transparent",
              alignItems: "center",
              justifyContent: "center",
              gap: 2,
            })}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
              <Icon name={tab.icon} size={19} color={ink} />
              {tab.badge ? (
                <View
                  style={{
                    height: 15,
                    minWidth: 15,
                    paddingHorizontal: 4,
                    borderRadius: 9999,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: tab.badgeTone === "warn" ? kit.warn : kit.needs,
                  }}
                >
                  <Text style={{ color: "#ffffff", fontSize: 10, fontWeight: "700", ...TABULAR }}>{tab.badge}</Text>
                </View>
              ) : null}
            </View>
            <Text style={{ color: ink, fontSize: 10.5, fontWeight: on ? "600" : "500" }}>{tab.label}</Text>
          </Pressable>
        );
      })}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New work"
        onPress={onNew}
        style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({
          ...focusRing(theme, focused),
          width: 46,
          height: 46,
          borderRadius: 9999,
          backgroundColor: kit.ink,
          alignItems: "center",
          justifyContent: "center",
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <Icon name="Plus" size={22} color={kit.onInk} />
      </Pressable>
    </View>
  );
}
