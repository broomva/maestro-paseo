// Where you are inside the phone's Settings (M11), pure: the page ids and the header's words.

export type SettingsPageId = "root" | "presence" | "runs" | "lanes" | "loops" | "notices";

const TITLES: Record<SettingsPageId, string> = {
  root: "Settings",
  presence: "Presence",
  runs: "Runs and gate",
  lanes: "Lanes",
  loops: "Loops",
  notices: "Notices",
};

/** Where you are, for the card's header: "Settings", then "Settings › Lanes" one level deep. */
export function settingsTrail(page: SettingsPageId): string[] {
  return page === "root" ? ["Settings"] : ["Settings", TITLES[page]];
}
