// What a Maestro card in a Paseo session says now, decided from what it reads live (BRO-3008, K1). Pure: the
// component reads, this decides, and every rule is a test (card-model.test.ts).
//
// A card carries only {kind, key, version} (shared/card.ts), so it is never true by itself: it is true as of the
// reads. Four states (K1): pending (the hold, with its verbs), undo window (someone decided, 8 s to take it back),
// receipt (it took effect) and resolved elsewhere (it left the hold without a receipt of ours). Three more say
// what the card cannot honestly offer: it could not read, a newer one replaced it, or the work holds it elsewhere.
//
// The rule behind most of them: a read that failed is "couldn't read", never "nothing pending" or "resolved". A hold
// that is missing from needs.list is only resolved when the source it comes from was read (`needs.unread`).

import type { CardData, CardKind } from "../shared/card";
import { holdVersion } from "../shared/card";
import type { WorkItem } from "../shared/contracts";
import { holdOf, type NeedRow, type Needs, sourceOf } from "../shared/needs";
import { SNOOZE_HOURS } from "../shared/notices";
import type { OwnerVerb, PendingVerb, SettledVerb } from "../shared/verbs";
import { primaryLabel } from "./home-model";
import { settledWords } from "./pending-model";

/** One read, as a hook reports it. */
export type Read<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; value: T };

export interface Ledger {
  pending: readonly PendingVerb[];
  recent: readonly SettledVerb[];
}

/** The verbs of the ledger a kind's card answers for: a verb of any other is that hold's other business. */
export const CARD_VERBS: Record<CardKind, readonly OwnerVerb[]> = {
  approval: ["approval.decide"],
  ask: ["ask.answer"],
  owner_step: [],
  finished: ["session.prompt", "work.verdict", "work.cancel"],
  health: ["work.unblock", "work.cancel", "work.leave-running", "notice.snooze"],
  digest: [],
};

export type CardState =
  | { phase: "loading" }
  /** A read failed: nothing is offered and nothing is claimed. */
  | { phase: "unread"; words: string }
  /** The hold stands, as of the read: the card offers its verbs (`row` for a hold, `item` for work). */
  | { phase: "open"; row: NeedRow | null; item: WorkItem | null }
  /** A decision on it waits out its window, whoever made it; Undo takes it back. */
  | { phase: "undo"; receipt: string; label: string; appliesAt: string }
  /** It took effect (or was dropped): one line, with its receipt's words. */
  | { phase: "receipt"; words: string; at: string; tone: "ok" | "warn" }
  /** It left the hold with no receipt of ours: answered where Maestro could not see, or elsewhere. */
  | { phase: "resolved"; words: string }
  /** A newer raise of the same hold, or a later run, replaced it. Nothing is offered. */
  | { phase: "superseded"; words: string }
  /** Finished work that asks permission now: the approval's card holds it. */
  | { phase: "held"; words: string };

export const SUPERSEDED = "Superseded by a later run.";
export const SUPERSEDED_HOLD = "A newer request replaced this one. Open in Maestro for the current one.";
export const HELD_ELSEWHERE = "It is asking for permission now: the approval card holds it.";
export const GONE_ELSEWHERE = "Resolved elsewhere: it no longer waits on you.";
export const MOVED_ELSEWHERE = "The work moved to another session; its card is there.";

/** The decisions of yours on `key` that still wait, newest first, for the verbs this kind answers for. */
function pendingOn(ledger: Ledger, key: string, kind: CardKind): PendingVerb[] {
  const verbs = CARD_VERBS[kind];
  return ledger.pending.filter((verb) => verb.key === key && verbs.includes(verb.verb));
}

/** The newest decision of yours on `key` that settled, for the verbs this kind answers for. Undone ones left no change. */
function settledOn(ledger: Ledger, key: string, kind: CardKind, only?: readonly OwnerVerb[]): SettledVerb | null {
  const verbs = only ?? CARD_VERBS[kind];
  const found = ledger.recent
    .filter((verb) => verb.key === key && verbs.includes(verb.verb) && verb.outcome !== "undone")
    .sort((a, b) => Date.parse(b.settledAt) - Date.parse(a.settledAt));
  return found[0] ?? null;
}

function undoOf(verb: PendingVerb): CardState {
  return { phase: "undo", receipt: verb.receipt, label: verb.label, appliesAt: verb.appliesAt };
}

function receiptOf(verb: SettledVerb): CardState {
  return {
    phase: "receipt",
    words: settledWords(verb),
    at: verb.settledAt,
    tone: verb.outcome === "applied" ? "ok" : "warn",
  };
}

/** How the work left, in a sentence; shown for finished work that is no longer at the gate. */
export function resolution(item: Pick<WorkItem, "state" | "verdict" | "reason">): string {
  switch (item.state) {
    case "done":
      return item.verdict ?? "Closed.";
    case "canceled":
      return item.verdict ?? "Canceled.";
    case "blocked":
      return item.reason ?? "The run stopped without a reason.";
    case "running":
      return "Back with the agent. A new card lands here when the run ends.";
    case "review":
      return "Waiting on you.";
    default:
      return "Queued again.";
  }
}

/** Why a read failed, in the card's words. */
const couldNot = (what: string, message: string) => `Couldn't read ${what}: ${message}`;

/**
 * The state of an approval, an ask or an owner step: the hold as needs.list has it now, and the decisions of yours
 * in the ledger.
 */
export function holdState(input: { card: CardData; needs: Read<Needs>; ledger: Read<Ledger> }): CardState {
  const { card, needs, ledger } = input;
  if (needs.status === "error") return { phase: "unread", words: couldNot("what needs you", needs.message) };
  if (needs.status === "loading") return { phase: "loading" };
  const row = needs.value.rows.find((one) => one.key === card.key) ?? null;
  // A hold missing from needs.list is only resolved when the source it comes from was read: a read that failed lost
  // the row, not the hold. This is asked before anything that could say "resolved", whatever the ledger says.
  const source = sourceOf(card.key);
  if (!row && source && needs.value.unread?.includes(source)) {
    return { phase: "unread", words: couldNot(`the ${source} it comes from`, "try again in a moment") };
  }
  if (ledger.status === "loading") return { phase: "loading" };
  // Without the ledger a decision already waiting, or one that took effect, cannot be seen: a hold is not offered
  // again blind, and a missing one is not called resolved. Never "resolved" off a failed read.
  if (ledger.status === "error") return { phase: "unread", words: couldNot("your decisions", ledger.message) };
  const waiting = pendingOn(ledger.value, card.key, card.kind)[0];
  if (row) {
    if (holdVersion(row) !== card.version) return { phase: "superseded", words: SUPERSEDED_HOLD };
    return waiting ? undoOf(waiting) : { phase: "open", row, item: null };
  }
  if (waiting) return undoOf(waiting);
  const settled = settledOn(ledger.value, card.key, card.kind);
  return settled ? receiptOf(settled) : { phase: "resolved", words: GONE_ELSEWHERE };
}

/**
 * The state of finished work's card or stuck work's: the work as work.get has it, in the session the card is in
 * (`host`: a card for work that moved to another session offers nothing).
 */
export function workState(input: {
  card: CardData;
  host: string | null;
  work: Read<WorkItem>;
  ledger: Read<Ledger>;
  now?: number;
}): CardState {
  const { card, host, work, ledger, now = Date.now() } = input;
  if (work.status === "error") return { phase: "unread", words: couldNot("the work", work.message) };
  if (work.status === "loading" || ledger.status === "loading") return { phase: "loading" };
  if (ledger.status === "error") return { phase: "unread", words: couldNot("your decisions", ledger.message) };
  const item = work.value;
  if (host && item.worker?.agentId !== host) return { phase: "superseded", words: MOVED_ELSEWHERE };
  const waiting = pendingOn(ledger.value, card.key, card.kind)[0];
  if (card.kind === "finished") {
    // A card belongs to one landing; a card written before landings were recorded has none and reads as old.
    if (card.version === "" || item.landing !== Number(card.version)) return { phase: "superseded", words: SUPERSEDED };
    if (item.state !== "review") return waiting ? undoOf(waiting) : leftWords(item, ledger.value, card);
    if (item.permission) return { phase: "held", words: HELD_ELSEWHERE };
    return waiting ? undoOf(waiting) : { phase: "open", row: null, item };
  }
  // Stuck work is current for as long as it is stuck, unless you snoozed it: that quiets the notice, not the work.
  if (item.state === "blocked") {
    if (waiting) return undoOf(waiting);
    const quiet = settledOn(ledger.value, card.key, card.kind, ["notice.snooze"]);
    if (quiet?.outcome === "applied" && now - Date.parse(quiet.settledAt) < SNOOZE_HOURS * 3_600_000)
      return receiptOf(quiet);
    return { phase: "open", row: null, item };
  }
  return waiting ? undoOf(waiting) : leftWords(item, ledger.value, card);
}

/** Work that is no longer where the card found it: its receipt when it was your verb, else how it left. */
function leftWords(item: WorkItem, ledger: Ledger, card: CardData): CardState {
  const settled = settledOn(ledger, card.key, card.kind);
  if (settled?.outcome === "applied") return receiptOf(settled);
  return { phase: "resolved", words: resolution(item) };
}

/** The state of any card but the digest, which reads the whole of needs.list (digestOf). */
export function cardState(input: {
  card: CardData;
  host: string | null;
  needs: Read<Needs>;
  ledger: Read<Ledger>;
  work: Read<WorkItem>;
}): CardState {
  if (input.card.kind === "finished" || input.card.kind === "health") return workState(input);
  return holdState(input);
}

/** Whether the card can still change on its own: one that has settled stops asking. */
export function cardLive(state: CardState): boolean {
  return state.phase === "loading" || state.phase === "open" || state.phase === "undo" || state.phase === "unread";
}

// ── The verbs a card offers ──────────────────────────────────────────────────

export interface CardVerb {
  /** The adapter's verb id (client/verbs.ts). */
  id: "allow" | "deny" | "answer" | "done" | "continue" | "course" | "unblock" | "snooze";
  label: string;
  primary: boolean;
  tone?: "ok" | "warn";
}

/**
 * At most two verbs, and only verbs that change something (K1: one decision per card; anything longer opens the
 * session page). A kind's own Skip and Not now leave the hold where it is, so a card does not draw them.
 */
export function cardVerbs(kind: CardKind, row: NeedRow | null): CardVerb[] {
  switch (kind) {
    case "approval":
      return [
        { id: "allow", label: row ? (primaryLabel(row) ?? "Allow") : "Allow", primary: true },
        { id: "deny", label: "Deny", primary: false },
      ];
    case "ask":
      return [{ id: "answer", label: "Answer", primary: true }];
    case "owner_step":
      return [{ id: "done", label: row ? (primaryLabel(row) ?? "Done") : "Done", primary: true, tone: "ok" }];
    case "finished":
      return [
        { id: "continue", label: "Continue", primary: false },
        { id: "course", label: "Change course", primary: false },
      ];
    case "health":
      return [
        { id: "unblock", label: "Unblock", primary: true, tone: "warn" },
        { id: "snooze", label: `Snooze ${SNOOZE_HOURS} h`, primary: false },
      ];
    case "digest":
      return [];
  }
}

// ── The digest ───────────────────────────────────────────────────────────────

/** How many holds the digest names; the rest are "and N more" behind Open in Maestro. */
export const DIGEST_ROWS = 3;

export interface DigestRow {
  key: string;
  kind: "approval" | "ask" | "owner_step" | "finished";
  title: string;
  /** "Approval · bro-2917-ledger": what it is and where. */
  caption: string;
  /** The session it opens, when it names one: K2 for that session; otherwise the hold in Maestro. */
  agentId: string | null;
}

export type DigestState =
  | { phase: "loading" }
  | { phase: "unread"; words: string }
  | {
      phase: "rows";
      total: number;
      rows: DigestRow[];
      more: number;
      words: string;
      /** The sources needs.list could not read, named: the list is then not the whole of what needs you. */
      unread: string[];
    };

const KIND_WORD: Record<DigestRow["kind"], string> = {
  approval: "Approval",
  ask: "Ask",
  owner_step: "Owner step",
  finished: "Finished",
};

/** "3 things need you", "1 thing needs you"; "Nothing needs you now". */
export function digestWords(total: number): string {
  if (total <= 0) return "Nothing needs you now";
  return `${total} ${total === 1 ? "thing needs" : "things need"} you`;
}

/**
 * What the inbox digest lists, from needs.list now: every hold counts (the same number as the header), the first few
 * are named in deck order, each opening its own session. The landing the digest came with is named first when it
 * holds nothing: finished work is watched, not a hold, so it is listed but never counted.
 */
export function digestOf(input: { card: CardData; needs: Read<Needs>; work: Read<WorkItem> | null }): DigestState {
  const { card, needs, work } = input;
  if (needs.status === "error") return { phase: "unread", words: couldNot("what needs you", needs.message) };
  if (needs.status === "loading") return { phase: "loading" };
  const rows = needs.value.rows;
  const unread = [...(needs.value.unread ?? [])];
  // Nothing listed and a source unread is not "nothing needs you": it says what it could not read.
  if (rows.length === 0 && unread.length > 0) {
    return { phase: "unread", words: couldNot(`what needs you (${unread.join(", ")})`, "try again in a moment") };
  }
  const named: DigestRow[] = rows.map((row) => ({
    key: row.key,
    kind: row.kind,
    title: row.title,
    caption: [KIND_WORD[row.kind], row.ticket ?? row.scope].join(" · "),
    agentId: row.session?.agentId ?? null,
  }));
  const hold = holdOf(card.key);
  const landing = work?.status === "ok" ? work.value : null;
  if (
    hold?.kind === "work" &&
    landing &&
    landing.id === hold.id &&
    landing.state === "review" &&
    !landing.permission &&
    !rows.some((row) => row.key === card.key)
  ) {
    named.unshift({
      key: card.key,
      kind: "finished",
      title: landing.display?.title || landing.title,
      caption: ["Finished", landing.ticket ?? landing.project ?? "work"].join(" · "),
      agentId: landing.worker?.agentId ?? null,
    });
  }
  const total = rows.length;
  return {
    phase: "rows",
    total,
    rows: named.slice(0, DIGEST_ROWS),
    more: Math.max(0, named.length - DIGEST_ROWS),
    words: digestWords(total),
    unread,
  };
}

// ── Opening Maestro ──────────────────────────────────────────────────────────

/** Where Open in Maestro goes: the session's page (K2) for a card that names a session, else the hold in Maestro. */
export type OpenTarget = { to: "session"; agentId: string } | { to: "hold"; key: string };

/**
 * Open in Maestro: K2 for the session the card is in (`host`) or the one its hold names; with neither, the hold's
 * own inspector on the Feed (BRO-3033 fact 2).
 */
export function openTarget(
  card: CardData,
  host: string | null,
  row: NeedRow | null,
  item: WorkItem | null,
): OpenTarget {
  const agentId = host ?? row?.session?.agentId ?? item?.worker?.agentId ?? null;
  return agentId ? { to: "session", agentId } : { to: "hold", key: card.key };
}
