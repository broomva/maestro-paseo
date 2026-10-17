// The Decisions dashboard's series (BRO-3172, docs/specs/2026-10-17-maestro-ask-sheet-default.md): the Decisions cards
// grouped by the ledger they were asked in, and a visit through one series in the focused card. A visit keeps an
// answered ask's place, so answering 1 of 12 reads 2 of 12, and still does when the ask leaves the read. Pure.

import { holdOf } from "../../shared/needs";
import { ledgerName, ledgerOf } from "../decisions-model";
import { ago } from "../format";
import type { DecisionCard } from "./model";

export interface AskSeries {
  /** `scope/ledger` for an ask's ledger; a hold's own key for a series of one. */
  id: string;
  /** "sri · lucky-mule-closeout-20261016", the card's kicker. */
  title: string;
  /** Its holds' keys, in the deck's order. */
  keys: string[];
  open: number;
  waits: number;
  ideas: number;
  /** Any hold in it stops work until it is answered. */
  blocking: boolean;
  /** When its oldest hold started waiting, ISO; "" when none says. */
  oldest: string;
}

/** The home and ledger an ask hold's key names (`ask:` and the JSON of [home, ledger, uid, id]), or null. */
function ledgerOfKey(key: string): { home: string; ledger: string } | null {
  const hold = holdOf(key);
  if (hold?.kind !== "ask") return null;
  try {
    const parts = JSON.parse(hold.askKey) as unknown;
    if (!Array.isArray(parts) || typeof parts[1] !== "string" || !parts[1]) return null;
    return { home: typeof parts[0] === "string" ? parts[0] : "", ledger: parts[1] };
  } catch {
    return null;
  }
}

/** The series a Decisions card belongs to: its scope, ledger and home (askKey keeps two homes apart), else itself. */
export function seriesOfCard(card: DecisionCard): { id: string; title: string } {
  const { row } = card.entry;
  const at = ledgerOfKey(row.key);
  if (at === null) return { id: row.key, title: row.title };
  return {
    id: `${row.scope}/${at.ledger}${at.home ? `@${at.home}` : ""}`,
    title: `${row.scope} · ${ledgerName(at.ledger)}`,
  };
}

/** Whether an ask is in a ledger as a caller names it: `scope/ledger.yaml`, or the file alone (Initiatives' refs). */
export function inLedger(ask: NonNullable<DecisionCard["entry"]["ask"]>, ledger: string): boolean {
  return ledgerOf(ask) === ledger || ask.ledger === ledger;
}

/** An open ask's hold key by its ledger and id (Initiatives opens one so): only when exactly one matches. */
export function keyOfDecision(cards: readonly DecisionCard[], ledger: string, id: string): string | null {
  const found = cards.filter(({ entry }) => entry.ask && inLedger(entry.ask, ledger) && entry.ask.id === id);
  return found.length === 1 ? (found[0]?.entry.row.key ?? null) : null;
}

/** The Decisions cards as series, in the order their first card has on the deck; no card is dropped. */
export function askSeries(cards: readonly DecisionCard[]): AskSeries[] {
  const byId = new Map<string, AskSeries>();
  for (const card of cards) {
    const { id, title } = seriesOfCard(card);
    const { row } = card.entry;
    let series = byId.get(id);
    if (!series) {
      series = { id, title, keys: [], open: 0, waits: 0, ideas: 0, blocking: false, oldest: "" };
      byId.set(id, series);
    }
    series.keys.push(row.key);
    series.open += 1;
    if (card.lane === "waits") series.waits += 1;
    if (card.lane === "idea") series.ideas += 1;
    if (row.blocksWork) series.blocking = true;
    if (row.since && (series.oldest === "" || row.since < series.oldest)) series.oldest = row.since;
  }
  return [...byId.values()];
}

/** A series row's line: "12 open · 2 wait on you · 3 ideas · 12h". */
export function seriesLine(series: AskSeries, now: number): string {
  return [
    `${series.open} open`,
    series.waits > 0 ? `${series.waits} ${series.waits === 1 ? "waits" : "wait"} on you` : null,
    series.ideas > 0 ? `${series.ideas} ${series.ideas === 1 ? "idea" : "ideas"}` : null,
    series.oldest ? ago(series.oldest, now) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The series holding a key, or null. */
export function seriesWith(series: readonly AskSeries[], key: string): AskSeries | null {
  return series.find((one) => one.keys.includes(key)) ?? null;
}

/** An open card's walk through one series. */
export interface Visit {
  series: string;
  title: string;
  /** The series' keys when the visit started. */
  snapshot: string[];
  /** The keys answered in this visit. */
  answered: string[];
  /** The keys skipped in this visit. */
  skipped: string[];
}

export function startVisit(series: AskSeries): Visit {
  return { series: series.id, title: series.title, snapshot: [...series.keys], answered: [], skipped: [] };
}

/**
 * The card's list on a visit: the snapshot's keys still live or answered in it (an answer keeps its place), then any
 * key that joined the series since, at the end.
 */
export function visitKeys(visit: Visit, live: readonly string[]): string[] {
  const kept = visit.snapshot.filter((key) => live.includes(key) || visit.answered.includes(key));
  return [...kept, ...live.filter((key) => !visit.snapshot.includes(key))];
}

/**
 * Whether the card may show a key: live, not waiting out an undo window, and neither answered (a read can still list
 * an answered ask after its window closed) nor skipped in this visit. An undone answer leaves `answered`.
 */
export function navigable(key: string, live: readonly string[], waiting: ReadonlySet<string>, visit: Visit): boolean {
  return live.includes(key) && !waiting.has(key) && !visit.answered.includes(key) && !visit.skipped.includes(key);
}

/** The visit after an answer, a skip, or an answer undone. */
export function marked(visit: Visit, key: string, how: "answered" | "skipped" | "undone"): Visit {
  if (how === "undone") return { ...visit, answered: visit.answered.filter((one) => one !== key) };
  if (visit[how].includes(key)) return visit;
  return { ...visit, [how]: [...visit[how], key] };
}

/** The next key the card shows after `from`, never wrapping to earlier ones; null at the end of the series. */
export function nextInVisit(
  keys: readonly string[],
  from: string,
  ok: (key: string) => boolean,
  step: 1 | -1 = 1,
): string | null {
  const at = keys.indexOf(from);
  if (at < 0) return keys.find(ok) ?? null;
  for (let i = at + step; i >= 0 && i < keys.length; i += step) {
    const key = keys[i];
    if (key !== undefined && key !== from && ok(key)) return key;
  }
  return null;
}

/** Where a visit opens: the first key the card may show, else the series' first. */
export function firstOfVisit(keys: readonly string[], ok: (key: string) => boolean): string | null {
  return keys.find(ok) ?? keys[0] ?? null;
}

/** What the toast says when a visit runs out. */
export function endWords(visit: Visit): string {
  const skipped = visit.skipped.length;
  return skipped > 0
    ? `${visit.title}: nothing left to answer · ${skipped} skipped`
    : `${visit.title}: nothing left to answer`;
}
