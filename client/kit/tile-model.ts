// The glance tile (JE rule "Glance tiles only where a number drives action"):
// a number, a line of context and a tap target, four per screen at most. A tile
// is tinted only when it needs you (Tidepool) or something is late or stranded
// (warn); every other tile is plain. Pure (client/kit/glance-tile.test.ts).

import type { Kit } from "./tokens";

export type TileTone = "plain" | "needs" | "warn";

/** At most this many tiles in a row (JE rule). */
export const MAX_TILES = 4;

export interface TileLook {
  fill: string;
  border: string;
  /** The label's and icon's color. */
  label: string;
  tinted: boolean;
}

export function tileLook(kit: Kit, tone: TileTone): TileLook {
  switch (tone) {
    case "needs":
      return { fill: kit.needsSoft, border: kit.needsLine, label: kit.needs, tinted: true };
    case "warn":
      return { fill: kit.warnSoft, border: kit.warnSoft, label: kit.warn, tinted: true };
    default:
      return { fill: kit.bg, border: kit.hairline, label: kit.fg, tinted: false };
  }
}

/** The tiles a screen shows: the first MAX_TILES, so a fifth never crowds the row. */
export function glanceRow<T>(tiles: readonly T[]): T[] {
  return tiles.slice(0, MAX_TILES);
}
