// Owner presence (P1; D5, A3): Present, Away or Off decides how long Maestro waits for you and whether it
// pushes. The pill in Maestro's header says it and its menu overrides it. The state lives on the plugin's
// side (presence.get and presence.set, BRO-2987), which does not exist yet: `usePresence` is the seam. Until
// BRO-2987 it reads Present from signals, and the menu says so instead of offering a switch that changes nothing.

export const PRESENCE_STATES = [
  {
    id: "present",
    label: "Present",
    line: "at the desk or in the app · finished work continues after 10 min",
  },
  { id: "away", label: "Away", line: "reachable on the phone · approvals and owner steps push" },
  { id: "off", label: "Off", line: "asleep or busy · held for the morning digest" },
] as const;
export type PresenceState = (typeof PRESENCE_STATES)[number]["id"];

/** How long a manual override lasts. */
export const PRESENCE_FOR = ["1 hour", "until 8:00", "until I change it"] as const;

export const PRESENCE_SIGNALS = "Signals: Paseo in front, your last tap or answer, calendar, opt-in sleep.";

export interface PresenceRead {
  state: PresenceState;
  from: "signals" | "manual";
  /** Whether presence.set exists: false until BRO-2987, so the menu shows the states and sets none. */
  settable: boolean;
}

/** BRO-2987 reads presence.get here. */
export function usePresence(): PresenceRead {
  return { state: "present", from: "signals", settable: false };
}

/** The pill's face, and what a screen reader hears. */
export function presenceFace(read: PresenceRead): { label: string; tone: "ok" | "warn" | "muted" } {
  const label = PRESENCE_STATES.find((entry) => entry.id === read.state)?.label ?? "Present";
  return { label, tone: read.state === "present" ? "ok" : read.state === "away" ? "warn" : "muted" };
}
