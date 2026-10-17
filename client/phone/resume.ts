// Where you left Maestro on the phone, and what you had typed, as pure rules (BRO-3180 B; spec
// docs/specs/2026-10-17-maestro-persistence-offline.md, "Part B"). client/phone/resume-store.ts keeps them on the
// device (client/kit/durable.ts); the screens read and write through it.
//
// An ask is named by its identity (ledger, uid or id, fleet scope), never by its hold key, which embeds the ask's
// home and changes when the ask moves between a checkout and origin/main. A draft is deleted only on positive
// evidence: a fresh, warning-free read showing its ask answered or archived. An ask simply missing from a read
// (asks.workspace lists only the ten latest answered, and a failed fleet read lists none) keeps its draft.

import { z } from "zod";
import type { DecisionAsk } from "../../shared/fleet";
import { PHONE_TABS, type PhonePage, type PhoneTab } from "./model";

/** Drafts not touched for this long are dropped. */
export const DRAFT_TTL_MS = 14 * 24 * 3600 * 1000;
/** At most this many drafts are kept, the newest. */
export const DRAFT_LIMIT = 50;

export const AskRefSchema = z.object({
  ledger: z.string(),
  uid: z.string().nullable(),
  id: z.string(),
  fleet: z.string().nullable(),
});
export type AskRef = z.infer<typeof AskRefSchema>;

const TAB_IDS = PHONE_TABS.map((tab) => tab.id) as [PhoneTab, ...PhoneTab[]];

export const ResumeSchema = z.object({
  tab: z.enum(TAB_IDS),
  page: z.unknown().nullable(),
  workspace: z.string().nullable(),
  card: z.object({ series: z.string().nullable(), ask: AskRefSchema }).nullable(),
  consumed: z.object({ hold: z.string().nullable(), tab: z.string().nullable() }),
});
export type Resume = Omit<z.infer<typeof ResumeSchema>, "page"> & { page: PhonePage | null };

export const DraftSchema = z.object({
  ask: AskRefSchema,
  hash: z.string(),
  chosen: z.string().nullable(),
  words: z.string().max(2000),
  at: z.number(),
});
export type Draft = z.infer<typeof DraftSchema>;
export type Drafts = Record<string, Draft>;

export const EMPTY_RESUME: Resume = {
  tab: "feed",
  page: null,
  workspace: null,
  card: null,
  consumed: { hold: null, tab: null },
};

const PAGE_KINDS = new Set(["initiatives", "fleet", "timeline", "loops", "settings"]);

/** A stored resume record, or the empty one when it is not one (an older shape, a corrupt value). */
export function parseResume(raw: unknown): Resume | undefined {
  const parsed = ResumeSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const page = parsed.data.page as { kind?: unknown } | null;
  return { ...parsed.data, page: page && PAGE_KINDS.has(String(page.kind)) ? (page as PhonePage) : null };
}

/** Stored drafts, each checked on its own: one bad entry drops itself, never the rest. */
export function parseDrafts(raw: unknown): Drafts | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Drafts = {};
  for (const [key, value] of Object.entries(raw)) {
    const one = DraftSchema.safeParse(value);
    if (one.success && draftKey(one.data.ask) === key) out[key] = one.data;
  }
  return out;
}

export function askRefOf(ask: Pick<DecisionAsk, "ledger" | "uid" | "id"> & { scope?: string | null }): AskRef {
  return { ledger: ask.ledger, uid: ask.uid, id: ask.id, fleet: ask.scope ?? null };
}

/** The key an ask's draft is kept under: its identity, so it survives the ask moving home. */
export function draftKey(ref: AskRef): string {
  return JSON.stringify([ref.fleet, ref.ledger, ref.uid ?? ref.id]);
}

export function sameAsk(a: AskRef, b: AskRef): boolean {
  return draftKey(a) === draftKey(b);
}

/**
 * The tab to open on: a route's tab you have not already acted on, else where you left it. `consumed` is the route
 * tab acted on last; a route keeps its params, so a remount after a push would otherwise jump back every time.
 */
export function openingTab(param: PhoneTab | null, resume: Resume): { tab: PhoneTab; consumed: string | null } {
  if (param && param !== resume.consumed.tab) return { tab: param, consumed: param };
  // Opened with no route tab: the last one is forgotten, so a later push to the same tab acts (P20 B round 1).
  return { tab: resume.tab, consumed: param ? resume.consumed.tab : null };
}

/** Whether a route's hold should open now: once per distinct value. */
export function holdIsNew(param: string | undefined, resume: Resume): boolean {
  return Boolean(param) && param !== resume.consumed.hold;
}

/** What one hold's draft says now; null when there is nothing to keep (no pick of yours, no words). */
export function draftOf(
  ask: Pick<DecisionAsk, "ledger" | "uid" | "id" | "hash"> & { scope?: string | null },
  chosen: string | undefined,
  words: string | undefined,
  now: number,
): Draft | null {
  const text = words ?? "";
  if (!chosen && !text) return null;
  return { ask: askRefOf(ask), hash: ask.hash, chosen: chosen ?? null, words: text.slice(0, 2000), at: now };
}

/** Drafts with `next` written for `key` (or removed, when null), newest DRAFT_LIMIT kept. */
export function withDraft(drafts: Drafts, key: string, next: Draft | null): Drafts {
  const out = { ...drafts };
  if (next) out[key] = next;
  else delete out[key];
  const keys = Object.keys(out);
  if (keys.length <= DRAFT_LIMIT) return out;
  const keep = new Set(keys.sort((a, b) => (out[b]?.at ?? 0) - (out[a]?.at ?? 0)).slice(0, DRAFT_LIMIT));
  return Object.fromEntries(Object.entries(out).filter(([one]) => keep.has(one)));
}

/**
 * Drafts after a read of the asks. Only a read that is fresh and carries no warning may delete: a draft goes when
 * its ask is in the read and no longer open, or when it is older than DRAFT_TTL_MS. An ask missing from the read
 * keeps its draft (no conclusion from absence).
 */
export function sweepDrafts(
  drafts: Drafts,
  read: { asks: readonly DecisionAsk[]; fresh: boolean; warnings: number },
  now: number,
): Drafts {
  const out: Drafts = {};
  const trusted = read.fresh && read.warnings === 0;
  for (const [key, draft] of Object.entries(drafts)) {
    if (now - draft.at > DRAFT_TTL_MS) continue;
    const found = read.asks.find((ask) => sameAsk(askRefOf(ask), draft.ask));
    if (trusted && found && found.state !== "open") continue;
    out[key] = draft;
  }
  return out;
}

/** Where the card reopens: the hold key of the ask it was on, if a read still holds it. */
export function cardTarget(
  card: Resume["card"],
  holds: readonly { key: string; ask: DecisionAsk | null }[],
): string | null {
  if (!card) return null;
  return holds.find((hold) => hold.ask && sameAsk(askRefOf(hold.ask), card.ask))?.key ?? null;
}
