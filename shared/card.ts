// The card Maestro leaves in a Paseo session (BRO-3008, K0–K2): where you act from a push. The daemon appends it
// to the session that asked (server/session-cards.ts, timeline.append) and the app draws it (client/session-card.tsx);
// both read the kind, version and data shape here.
//
// A card carries only what finds its hold again: `{ kind, key, version }`. A timeline row's data is held in
// memory (at most 64 KiB) and lost when the daemon restarts, so the card keeps nothing to go stale: it reads the
// hold live by `key` (needs.list for a hold, work.get for finished and stuck work) and shows what is true now.
// `version` names which raise of that key the card was left for, so a card for an earlier one says it was
// superseded instead of offering a verb on a newer hold.
//
// The renderer's kind is a contribution id to the Paseo app, which accepts only lowercase letters, digits and
// dashes: "maestro.card" would stop the whole client bundle from loading. Items are already scoped to this plugin.

import { z } from "zod";
import { type NeedRow, workKey } from "./needs";

/** The page Open in Maestro opens for a session: `openScreen({ screenId: "session", params: { agentId } })` (K2). */
export const SESSION_SCREEN = "session";

export const CARD_KIND = "maestro-card";
export const CARD_VERSION = 1;

/**
 * The six kinds (K1): the three holds, finished work, work that is stuck, and the digest the inbox session holds.
 * Every one has one anatomy: what it is, the one decision, at most two verbs, and Open in Maestro.
 */
export const CARD_KINDS = ["approval", "ask", "owner_step", "finished", "health", "digest"] as const;
export type CardKind = (typeof CARD_KINDS)[number];

export const CardSchema = z.object({
  kind: z.enum(CARD_KINDS),
  /**
   * What it reads: a hold's key (`work:<id>`, `approval:<id>`, `ask:[…]`) for the three holds, the work's key for
   * finished and stuck work, and for the digest the work whose landing it accompanies (or `needs`).
   */
  key: z.string().min(1),
  /**
   * Which raise of that key this card is for. A permission prompt: its request id. Another hold: when it began
   * waiting. Finished work: the landing's index in the event log. Stuck work and a digest: when they were raised
   * (they are current for as long as the work stays stuck, and the digest reads needs.list live).
   */
  version: z.string(),
});
export type CardData = z.infer<typeof CardSchema>;

/** The timeline item's id: one card for one raise, so a card appended again (after a restart) replaces itself. */
export const cardId = (card: CardData): string => `${CARD_KIND}:${card.kind}:${card.key}:${card.version}`;

/** The key a digest has when it accompanies no one landing. */
export const DIGEST_KEY = "needs";

/** A short stable word for some content: FNV-1a over its JSON, as eight hex digits. */
export function wordOf(value: unknown): string {
  let hash = 0x811c9dc5;
  for (const char of JSON.stringify(value) ?? "") hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

/**
 * Which raise of its key a hold is, from durable data only: a permission prompt is its request id (a session that
 * raises another prompt is another hold under the same key); an `approval:<id>` already names its request; any
 * other hold is a word of what it says (its key, its title and its body). Never a first-seen time kept in memory:
 * an undated ask or the answers batch would then get a new version, and a new card, with every daemon restart. The
 * same hold says the same words, so a card appended again after a restart replaces itself; a hold whose question
 * was edited is another raise, which the older card says.
 */
export function holdVersion(row: NeedRow): string {
  if (row.kind === "approval") return row.body.requestId ?? row.key;
  return wordOf([row.key, row.title, row.body]);
}

/** The card a hold gets in its own session, or null when it has none (a hold that names no session). */
export function holdCard(row: NeedRow): { agentId: string; card: CardData } | null {
  if (!row.session) return null;
  return { agentId: row.session.agentId, card: { kind: row.kind, key: row.key, version: holdVersion(row) } };
}

// ── The card of an earlier build ─────────────────────────────────────────────

/**
 * Before BRO-3008 the card was `maestro-gate`, left when a run landed at the gate: `{ workId, landing, agentId }`.
 * Sessions keep their timelines, so those rows still render, as the finished card they were (client/session-card.tsx).
 * One written before landings were recorded has no landing: it reads as superseded.
 */
export const GATE_CARD_KIND = "maestro-gate";
export const GATE_CARD_VERSION = 1;
export const GateCardSchema = z.object({
  workId: z.string(),
  landing: z.number().int().nonnegative().optional(),
  agentId: z.string().optional(),
});
export type GateCardData = z.infer<typeof GateCardSchema>;

export function legacyCard(data: GateCardData): CardData {
  return {
    kind: "finished",
    key: workKey(data.workId),
    version: data.landing === undefined ? "" : String(data.landing),
  };
}
