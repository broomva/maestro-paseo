// What each page holds (client/phone/model.ts PhonePage): the phone's own Initiatives (M8) and Settings (M11),
// and the views Health's sheet reaches, which are the desktop's own (Fleet, Timeline, Loops) drawn at the phone's
// width. A hold or work they open rises as the surface's card, over the page.

import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { FleetView } from "../fleet";
import { LoopsView } from "../loops";
import type { PresenceRead } from "../presence";
import { TimelineView } from "../timeline";
import { InitiativesPage } from "./initiatives-page";
import type { PhonePage } from "./model";
import { SettingsPage } from "./settings-page";

type Navigation = PluginSurfaceProps["navigation"];

export function PageBody({
  theme,
  page,
  navigation,
  presence,
  onPage,
  onOpenHold,
  onOpenDecision,
  onOpenWork,
}: {
  theme: PluginTheme;
  page: PhonePage;
  navigation: Navigation;
  presence: PresenceRead;
  onPage: (page: PhonePage | null) => void;
  /** A due review opens as the hold the Feed's deck shows. */
  onOpenHold: (key: string) => void;
  onOpenDecision: (ledger: string, askId: string | null) => void;
  /** Work opens as the card (or its page when it has no card). */
  onOpenWork: (id: string) => void;
}) {
  switch (page.kind) {
    case "initiatives":
      return (
        <InitiativesPage
          theme={theme}
          navigation={navigation}
          onOpenHold={onOpenHold}
          onOpenDecision={onOpenDecision}
          onOpenWork={onOpenWork}
        />
      );
    case "fleet":
      return (
        <FleetView
          theme={theme}
          compact
          scope={page.scope}
          tick={page.tick}
          navigation={navigation}
          onScope={(scope) => onPage({ kind: "fleet", scope, tick: null })}
          onSelect={onOpenWork}
        />
      );
    case "timeline":
      return (
        <TimelineView
          theme={theme}
          compact
          navigation={navigation}
          onOpenFleet={(scope, tick = null) => onPage({ kind: "fleet", scope, tick })}
          onOpenLoop={() => onPage({ kind: "settings", page: "lanes" })}
        />
      );
    case "loops":
      return <LoopsView theme={theme} />;
    case "settings":
      return (
        <SettingsPage
          theme={theme}
          page={page.page}
          presence={presence}
          onPage={(next) => onPage({ kind: "settings", page: next })}
        />
      );
  }
}
