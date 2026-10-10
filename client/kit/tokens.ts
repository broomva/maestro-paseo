// The kit's colors: the active Paseo theme first, then broomva-design's
// agentic-work extension for the few colors Paseo has no token for. Pure, so it
// is tested (client/kit/tokens.test.ts).
//
// Maestro follows the active theme: surfaces, text, border and the status
// colors come from theme.colors and nothing else. B1 (the owner, 2026-10-10):
// primaries are broomva ink, the theme's foreground on its base surface, never
// the theme's accent (Paseo's own theme paints that green). The extension adds
// Tidepool cyan (Needs you), the Undertow's blue and ice (Running only, JE rule
// 9), each in a light and a dark value from docs/design/maestro-next.pen's
// variables, picked by the surface's luminance because Paseo hands a plugin no
// appearance flag (paseo-plugin-capabilities.md §3).

import type { PluginTheme } from "@getpaseo/plugin";
import { isDarkSurface, over, parseColor, tint } from "../fleet-color";

/** The extension's colors, light and dark (maestro-next.pen variables needs, needs-soft, blue, ice, info). */
export const EXTENSION = {
  light: { needs: "#0072A3", needsSoft: "#E6F5FB", blue: "#5480C7", ice: "#B9D3F2", info: "#3E68AD" },
  dark: { needs: "#3DB5E8", needsSoft: "#052030", blue: "#5480C7", ice: "#9FC3F0", info: "#7FA2DD" },
} as const;

export interface Kit {
  dark: boolean;
  /** The base surface, and the card fill. */
  bg: string;
  /** A sunken well inside a card: the Action line, evidence tiles. */
  sunken: string;
  /** A control's fill: secondary buttons, the round header buttons. */
  control: string;
  border: string;
  /** The whisper line a card and a tile wear (the pen's #0C101A0F). */
  hairline: string;
  fg: string;
  /** Body text one step under fg (the pen's fg-2). */
  fg2: string;
  muted: string;
  /** B1: a primary's fill, and the word on it. */
  ink: string;
  onInk: string;
  /** Tidepool: Needs you. Its soft fill tints a Needs you tile; its line rings a hold. */
  needs: string;
  needsSoft: string;
  needsLine: string;
  warn: string;
  warnSoft: string;
  ok: string;
  danger: string;
  /** Links: "Details, session and history". */
  info: string;
  /** The Undertow's two colors. Running only (client/kit/undertow-model.ts). */
  blue: string;
  ice: string;
  /** The dimmed layer under a card that rose over the screen. */
  scrim: string;
  /** The undo toast: an ink capsule in both themes. */
  toastBg: string;
  toastFg: string;
  toastOk: string;
  shadow: string;
}

/** A color mixed toward another (alpha of `top`), as #rrggbb; `bottom` when either cannot be read. */
function mix(top: string, bottom: string, alpha: number): string {
  const a = parseColor(top);
  const b = parseColor(bottom);
  if (!a || !b) return bottom;
  const c = over(a, b, alpha);
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
}

export function kitOf(theme: PluginTheme): Kit {
  const c = theme.colors;
  const dark = isDarkSurface(c.surface0);
  const ext = dark ? EXTENSION.dark : EXTENSION.light;
  return {
    dark,
    bg: c.surface0,
    sunken: c.surface1,
    control: c.surface2,
    border: c.border,
    hairline: tint(c.foreground, dark ? 0.1 : 0.06),
    fg: c.foreground,
    fg2: mix(c.foreground, c.foregroundMuted, 0.55),
    muted: c.foregroundMuted,
    ink: c.foreground,
    onInk: c.surface0,
    needs: ext.needs,
    needsSoft: dark ? tint(ext.needs, 0.14) : ext.needsSoft,
    needsLine: tint(ext.needs, 0.35),
    warn: c.statusWarning,
    warnSoft: tint(c.statusWarning, dark ? 0.14 : 0.1),
    ok: c.statusSuccess,
    danger: c.statusDanger,
    info: ext.info,
    blue: ext.blue,
    ice: ext.ice,
    scrim: dark ? "rgba(0, 0, 0, 0.5)" : "rgba(12, 16, 26, 0.28)",
    toastBg: dark ? "rgba(242, 243, 246, 0.94)" : "rgba(12, 16, 26, 0.9)",
    toastFg: dark ? "#0c101a" : "#ffffff",
    toastOk: dark ? "#008039" : "#7fe0a8",
    shadow: dark ? "rgba(0, 0, 0, 0.5)" : "rgba(12, 16, 26, 0.12)",
  };
}
