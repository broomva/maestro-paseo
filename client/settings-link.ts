// How a surface opens Maestro's Settings screen. Opening Settings is the
// client context's (openSettings), which a surface does not receive, so the
// plugin's entry leaves an opener here when it starts and takes it back when
// it stops. Without one (an older host, a test) the surfaces say where
// Settings are instead of offering a press.

let opener: (() => void) | null = null;

/** Leaves the opener; returns what takes it back. */
export function linkSettings(open: () => void): () => void {
  opener = open;
  return () => {
    if (opener === open) opener = null;
  };
}

/**
 * Links the plugin context's opener for Settings screen `id`, only when the
 * host really has one: an older host's context has no openSettings, and
 * linking a call to it would offer a press that throws.
 */
export function linkSettingsOf(context: { openSettings?: (id: string) => void }, id: string): () => void {
  const open = context.openSettings;
  if (typeof open !== "function") return () => undefined;
  return linkSettings(() => open.call(context, id));
}

/** Opens Maestro's Settings, or null when nothing can. */
export function settingsOpener(): (() => void) | null {
  return opener;
}
