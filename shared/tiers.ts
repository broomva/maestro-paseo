// Delegation tiers (BRO-3118): how much model a piece of work is meant to get.
// A work declares one in `_work.md` (`tier`); Maestro also infers one from the
// model a session ran on, so work that declared none is still counted.

export const TIERS = ["mechanical", "standard", "frontier", "apex"] as const;
export type Tier = (typeof TIERS)[number];

export const isTier = (value: unknown): value is Tier =>
  typeof value === "string" && (TIERS as readonly string[]).includes(value);

/** Mechanical below standard below frontier below apex. */
export function tierRank(tier: string | null | undefined): number {
  const rank = TIERS.indexOf(tier as Tier);
  return rank;
}

/** The higher of two tiers; an unknown one never outranks a known one. */
export function higherTier(a: string | null, b: string | null): string | null {
  return tierRank(b) > tierRank(a) ? b : a;
}

/**
 * The tier a model id implies: haiku is mechanical, sonnet standard, opus
 * frontier, fable apex. Anything else (codex, antigravity, an inbox) is null.
 */
export function tierOfModel(model: string | null | undefined): Tier | null {
  const id = (model ?? "").toLowerCase();
  if (id.includes("haiku")) return "mechanical";
  if (id.includes("sonnet")) return "standard";
  if (id.includes("opus")) return "frontier";
  if (id.includes("fable")) return "apex";
  return null;
}

/** The model of a `provider/model` selection (`claude/claude-sonnet-5-5`), or null for a bare provider. */
export function modelOfProvider(provider: string | null | undefined): string | null {
  const text = (provider ?? "").trim();
  const slash = text.indexOf("/");
  return slash >= 0 && slash < text.length - 1 ? text.slice(slash + 1) : null;
}
