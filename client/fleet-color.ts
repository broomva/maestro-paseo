// The cockpit's color arithmetic, pure so it is tested (client/fleet-color.test.ts):
// reading a theme color in any of the forms a theme may give it, mixing a tint,
// whether the theme is dark, the info blue (Paseo has no info token), and the
// WCAG contrast that proves a pill's word reads on its own tint.

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** A color as `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(…)` or `rgba(…)`; null for anything else. */
export function parseColor(color: string): Rgba | null {
  const text = color.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
    const at = (index: number) => Number.parseInt(full.slice(index, index + 2), 16);
    return { r: at(0), g: at(2), b: at(4), a: full.length === 8 ? at(6) / 255 : 1 };
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(text);
  if (fn) {
    const alpha = fn[4] === undefined ? 1 : fn[4].endsWith("%") ? Number.parseFloat(fn[4]) / 100 : Number(fn[4]);
    return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]), a: Math.min(1, Math.max(0, alpha)) };
  }
  return null;
}

/** A color at `alpha`, as `rgba(…)`; a color it cannot read comes back as given. */
export function tint(color: string, alpha: number): string {
  const parsed = parseColor(color);
  if (!parsed) return color;
  return `rgba(${parsed.r}, ${parsed.g}, ${parsed.b}, ${alpha})`;
}

const channel = (value: number) => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** Relative luminance (WCAG), of an opaque color. */
export function luminance(color: Rgba): number {
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** `top` laid over `bottom` at `alpha`. */
export function over(top: Rgba, bottom: Rgba, alpha: number): Rgba {
  const mix = (a: number, b: number) => Math.round(a * alpha + b * (1 - alpha));
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

/** WCAG contrast ratio between two opaque colors (1 to 21). */
export function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Whether a theme is dark: its base surface's luminance; a surface it cannot read counts as dark. */
export function isDarkSurface(surface: string): boolean {
  const parsed = parseColor(surface);
  return parsed ? luminance(parsed) < 0.4 : true;
}

/**
 * Info blue: what is running. The one color not from the theme (Paseo has no
 * info token, and its accent can be the success green). Each holds 4.5:1 as
 * a pill's word on its own 14% tint over the theme's surfaces
 * (client/fleet-color.test.ts).
 */
export const INFO = { dark: "#7cb2ff", light: "#1a4fae" } as const;

export function infoFor(surface: string): string {
  return isDarkSurface(surface) ? INFO.dark : INFO.light;
}
