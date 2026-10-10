// JE rule 9: the Undertow marks Running, and nothing else. A running card wears
// the halo, a running row the tidepool dot; standing work (alive, between
// turns) gets the quiet pulse. Never on hover, never on Needs you (that stays
// Tidepool cyan), never as a percentage. view-models.md invariant 4: they read
// `state == "running"` and `standing` only. Pure (client/kit/undertow.test.ts).

export interface UndertowMarks {
  /** The card's halo: pools, tide and orbit. */
  halo: boolean;
  /** The row's 15 px tidepool dot. */
  dot: boolean;
  /** The standing pulse. */
  pulse: boolean;
}

export const RUNNING = "running";
export const STANDING = "standing";

/** What a card or row in this state wears. Any state other than running or standing wears nothing. */
export function undertowMarks(state: string): UndertowMarks {
  const running = state === RUNNING;
  return { halo: running, dot: running, pulse: state === STANDING };
}

/** The halo's three motions (broomva-design, agentic-work extension), in ms. */
export const UNDERTOW_MS = { pools: 4_200, tide: 3_400, orbit: 9_000 } as const;
