// The Feed home as the chosen design lays it out (docs/design/feed/feed-column.png,
// BRO-2906): Needs you (every hold needs.list holds, in its order: the work at
// your gate and what only you may start as cards that say where they came
// from, what they show, what they ask and the one verb; asks as Decide rows),
// Decide (open asks that do not wait on you, a few inline), Stuck, Running,
// Queued, Handled for you (handled.list: what closed without you, by who
// closed it), and Done as a count. Pure: the view only renders these.

import type { WorkItem } from "../shared/contracts";
import type { DecisionAsk } from "../shared/fleet";
import {
  askHoldKey,
  type Closer,
  type HandledRow,
  holdOf,
  NEED_KINDS,
  type NeedRow,
  type NeedSummary,
  needsWords,
} from "../shared/needs";
import { isFinished, sectionOf } from "../shared/needs-you";
import { ticketOf } from "../shared/text";
import { headlineOf, isTriaged, ledgerName, ledgerOf, silenceOf } from "./decisions-model";
import { ago, plural } from "./format";
import { flagText, stuckText, workerText } from "./plane-model";
import { placeText, titleText } from "./records-text";

/** How many asks Decide shows inline before "N more in Decisions". */
export const DECIDE_INLINE = 3;
/** How many closed arcs Handled for you names under each group. */
export const HANDLED_NAMED = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export { ticketOf };

/** Whether a search matches the work: its title, place, ticket, branch or id, case-folded. Pure. */
export function matchesQuery(item: WorkItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    titleText(item),
    item.title,
    placeText(item),
    item.initiative,
    item.worker?.branch,
    item.path,
    item.id,
    item.adoptedBy?.by,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return hay.includes(q);
}

export interface DecideRow {
  ask: DecisionAsk;
  headline: string;
  blocks: boolean;
  /** Where it was asked, as `sri · sti-3587`: the ledger as a person reads it. */
  where: string;
  /** What happens if you say nothing, as `silent → hold`; null when the ledger does not say. */
  silent: string | null;
}

/** One ask as a Decide row: its headline, whether it blocks work, its ledger, and what silence does. Pure. */
export function decideRowOf(ask: DecisionAsk): DecideRow {
  const silence = silenceOf(ask);
  return {
    ask,
    headline: headlineOf(ask).headline,
    blocks: ask.blocking,
    where: ledgerName(ledgerOf(ask)),
    silent: silence ? `silent → ${silence.text.replace(/^If you say nothing: /, "")}` : null,
  };
}

/**
 * Decide: the open asks that do not wait on you (the ones that do are holds,
 * under Needs you, and none of these blocks), oldest first; a few inline and
 * how many more. Pure.
 */
export function decideOf(asks: readonly DecisionAsk[]): { rows: DecideRow[]; more: number } {
  const open = asks.filter((ask) => isTriaged(ask) && !ask.waiting);
  const ordered = [...open].sort((a, b) => (a.askedAt ?? "￿").localeCompare(b.askedAt ?? "￿"));
  const rows = ordered.slice(0, DECIDE_INLINE).map(decideRowOf);
  return { rows, more: open.length - rows.length };
}

/** A hold as the Feed lists it: the row, and the work item or the ask it holds when this client has it. */
export interface NeedEntry {
  row: NeedRow;
  item: WorkItem | null;
  ask: DecisionAsk | null;
}

/**
 * The Feed's Needs you section: needs.list's rows in their order, each joined
 * to its work item or ask when this client has it. With no scope and no
 * search it is every row, so its length is needs.list's total (the header's
 * number). A scope keeps the holds of its initiative (its work, its asks, its
 * review); a search keeps the rows it matches. Pure.
 */
export function needsSection(
  rows: readonly NeedRow[],
  items: readonly WorkItem[],
  asks: readonly DecisionAsk[],
  scope: string | null = null,
  query = "",
): NeedEntry[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const byKey = new Map(asks.map((ask) => [askHoldKey(ask), ask]));
  const q = query.trim().toLowerCase();
  return rows
    .map((row) => {
      const hold = holdOf(row.key);
      return {
        row,
        item: hold?.kind === "work" ? (byId.get(hold.id) ?? null) : null,
        ask: hold?.kind === "ask" ? (byKey.get(row.key) ?? null) : null,
      };
    })
    .filter((entry) => {
      if (scope !== null && initiativeOfEntry(entry) !== scope) return false;
      if (!q) return true;
      return entry.item ? matchesQuery(entry.item, q) : entry.row.title.toLowerCase().includes(q);
    });
}

/** The initiative a hold belongs to: its work's, its ask's, or the one under review; null for none. */
export function initiativeOfEntry({ row, item, ask }: NeedEntry): string | null {
  const hold = holdOf(row.key);
  return item?.initiative ?? ask?.initiative ?? (hold?.kind === "review" ? hold.initiative : null) ?? null;
}

/**
 * How many holds each initiative has: the length of the Needs you section
 * that initiative's scope lists (needsSection), from needs.list's rows. Pure.
 */
export function needsByInitiative(entries: readonly NeedEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const initiative = initiativeOfEntry(entry);
    if (initiative) counts.set(initiative, (counts.get(initiative) ?? 0) + 1);
  }
  return counts;
}

export type Tone = "success" | "warning" | "danger" | "accent" | "muted";

export interface CardModel {
  icon: string;
  iconTone: Tone;
  /** The source line's parts, mono (`fleet`, `sri tick 37`; `broomva`, `BRO-2827`). */
  source: string[];
  /** After the parts, plain: `via SRI Orchestrator`, `your answer`. */
  via: string | null;
  title: string;
  /** What the run shows (its arc status, checks, how it ran); null when nothing is known. Its branch and diff sit beside it. */
  evidence: { icon: string; tone: Tone; text: string } | null;
  /** The run's branch, shown mono on the evidence row. */
  branch: string | null;
  /** What it asks you, or its own last words when it asked nothing. */
  ask: { kind: "ask" | "words" | "reason"; text: string } | null;
  pill: { label: string; tone: Tone };
  /** The session, in a few words: `session idle`, `no session`, `2m in · orchestrator decides`. */
  session: string;
  /** The one verb the card offers; it opens the item, where the verbs are. */
  action: string | null;
  /** The card is the one most needing you: its border is the accent. */
  lead: boolean;
}

/** Where an answer's work came from: Maestro files those as "Act on your answer: …". */
const ANSWER_TITLE = /^Act on your answer:\s*/;
/** An SRI arc the orchestrator titled `SRI: …`: the source line says sri, so the title drops it. */
const SRI_TITLE = /^SRI:\s*/;

function sourceOf(item: WorkItem): { source: string[]; via: string | null } {
  const fleet = item.display?.fleet;
  if (fleet)
    return {
      source: ["fleet", [fleet.scope, fleet.tick ? `tick ${fleet.tick}` : null].filter(Boolean).join(" ")],
      via: null,
    };
  const ticket = item.ticket ?? ticketOf(item.title);
  const via = ANSWER_TITLE.test(item.title)
    ? "your answer"
    : item.adoptedBy
      ? `via ${item.adoptedBy.by ?? "its orchestrator"}`
      : null;
  // The initiative, else the SRI scope its title names, else where it runs: an SRI arc's worktree path is noise beside its ticket.
  const scope = item.initiative || !SRI_TITLE.test(item.title) ? placeText(item) : "sri";
  return { source: [scope, ticket].filter((part): part is string => !!part), via };
}

/** `last activity 3m ago`, or `active just now` inside the minute. Pure. */
function activityText(iso: string, now: number): string {
  const since = ago(iso, now);
  return since === "now" ? "active just now" : `last activity ${since} ago`;
}

function sessionOf(item: WorkItem): string {
  if (!item.worker) return "no session";
  // How long it has run is not known here (lastEventAt is its last activity, which the evidence row says): who decides it is.
  if (item.state === "running") return item.adoptedBy ? "orchestrator decides" : "lands at your gate";
  if (item.look?.archived) return "session archived";
  return item.state === "review" ? "session idle" : "session ended";
}

/**
 * One card, as the design draws it. `changed` is the diff stat to show when the
 * client knows a fresher one than the server sent (client/changed.tsx). Pure.
 */
export function cardOf(
  item: WorkItem,
  now: number = Date.now(),
  changed: { additions: number; deletions: number } | null = item.changed ?? null,
): CardModel & { changed: { additions: number; deletions: number } | null } {
  const { source, via } = sourceOf(item);
  const fleet = !!item.display?.fleet;
  const stuck = item.state === "blocked";
  const flagged = flagText(item);
  const look = item.look;
  const asked = look?.ask?.trim() || look?.handed?.trim() || "";
  const words = look?.closing?.trim() || "";
  const ask: CardModel["ask"] = asked
    ? { kind: "ask", text: asked }
    : stuck
      ? { kind: "reason", text: stuckText(item) ?? item.reason ?? "It stopped." }
      : flagged
        ? { kind: "reason", text: flagged }
        : words
          ? { kind: "words", text: `No ask written. Its last words: "${words}"` }
          : null;
  const evidenceText =
    item.state === "running"
      ? [
          item.phase ? `${item.phase}` : null,
          workerText(item.worker),
          item.lastEventAt ? activityText(item.lastEventAt, now) : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : [look?.arc ? look.arc.status : null, item.verdict, look?.ran].filter(Boolean).join(" · ");
  // verdictOf words a failed run `N of M checks failed`: its evidence is not a pass.
  const failed = /\bchecks? failed\b/.test(item.verdict ?? "");
  const evidence: CardModel["evidence"] = evidenceText
    ? {
        icon: item.state === "running" ? "Activity" : stuck ? "Unplug" : failed ? "CircleX" : "CircleCheck",
        tone: item.state === "running" ? "accent" : stuck || failed ? "danger" : "success",
        text: evidenceText,
      }
    : null;
  const pill: CardModel["pill"] =
    stuck && fleet
      ? { label: "Alert", tone: "danger" }
      : stuck
        ? { label: "Stuck", tone: "warning" }
        : item.state === "review"
          ? item.permission
            ? { label: "Needs you", tone: "success" }
            : { label: "Finished", tone: "muted" }
          : item.state === "running"
            ? { label: flagged ? "Quiet" : "Running", tone: flagged ? "warning" : "accent" }
            : item.state === "done"
              ? { label: "Done", tone: "muted" }
              : { label: "Queued", tone: "muted" };
  const action =
    item.state === "review" ? (item.permission ? "Answer" : "Review") : stuck ? (fleet ? "Open log" : "Look") : null;
  return {
    icon: fleet
      ? "TriangleAlert"
      : via === "your answer"
        ? "CornerDownRight"
        : item.state === "running"
          ? "Loader"
          : "GitBranch",
    iconTone: fleet ? "danger" : item.state === "running" ? "accent" : "muted",
    source,
    via,
    title: titleText(item).replace(ANSWER_TITLE, "").replace(SRI_TITLE, ""),
    changed,
    evidence,
    branch: item.worker?.branch ?? null,
    ask,
    pill,
    session: sessionOf(item),
    action,
    lead: item.state === "review",
  };
}

/** What pressing a card does, for a screen reader: the verb it opens to, and what it asks. Pure. */
export function cardHint(card: Pick<CardModel, "action" | "ask">): string {
  const opens = card.action ? `Opens it to ${card.action.toLowerCase()}` : "Opens it";
  return card.ask ? `${opens}. ${card.ask.text}` : opens;
}

export interface FeedSections {
  /** Stuck work: watched (owner answer A1), each with its reason; Unblock is on its card. */
  stuck: WorkItem[];
  /** Work that finished and waits at the gate: watched (A1), never counted as needing you; Change course is on its card. */
  finished: WorkItem[];
  running: WorkItem[];
  queued: WorkItem[];
  /** Finished work you closed: how many, today and this week. */
  done: { count: number; today: number; week: number; items: WorkItem[] };
}

const closedAt = (item: WorkItem) => Date.parse(item.closed?.at ?? item.updatedAt);

/** The Feed's work sections, each item once (what needs you is needs.list's, needsSection). Pure. */
export function sectionsOf(items: readonly WorkItem[], now: number = Date.now()): FeedSections {
  // Not what handled.list holds for you (closed without you this week, server/needs.ts HANDLED_MS).
  const handled = (item: WorkItem) => item.closed?.by === "maestro" && now - closedAt(item) < WEEK_MS;
  const yours = items
    .filter((item) => (item.state === "done" || item.state === "canceled") && !handled(item))
    .sort((a, b) => closedAt(b) - closedAt(a));
  return {
    stuck: items.filter((item) => sectionOf(item) === "blocked"),
    finished: items.filter(isFinished),
    running: items.filter((item) => sectionOf(item) === "running"),
    queued: items.filter((item) => sectionOf(item) === "queued"),
    done: {
      count: yours.length,
      today: yours.filter((item) => now - closedAt(item) < DAY_MS).length,
      week: yours.filter((item) => now - closedAt(item) < WEEK_MS).length,
      items: yours,
    },
  };
}

/** Who closed what Handled for you lists, in the order the section shows them. */
const CLOSER_ORDER: readonly Exclude<Closer, "you">[] = ["gates", "orchestrator", "maestro"];

export interface HandledGroup {
  by: Exclude<Closer, "you">;
  rows: HandledRow[];
}

/**
 * The handled rows a scope or a search keeps: with neither, every row; with
 * either, the rows whose work the Feed's filtered list holds, as its other
 * sections do. Pure.
 */
export function handledShown(
  rows: readonly HandledRow[],
  shown: readonly WorkItem[],
  scope: string | null,
  query: string,
): HandledRow[] {
  if (scope === null && !query.trim()) return [...rows];
  const ids = new Set(shown.map((item) => item.id));
  return rows.filter((row) => {
    const hold = holdOf(row.key);
    return hold?.kind === "work" && ids.has(hold.id);
  });
}

/** How many of each kind a list of holds holds: the Needs you section's own rows, as its line says them. Pure. */
export function kindsOf(rows: readonly Pick<NeedRow, "kind">[]): NeedSummary["byKind"] {
  const byKind = Object.fromEntries(NEED_KINDS.map((kind) => [kind, 0])) as NeedSummary["byKind"];
  for (const row of rows) byKind[row.kind] += 1;
  return byKind;
}

/** What handled.list holds for you: its rows that closed without you. Pure. */
export function handledForYou(rows: readonly HandledRow[]): HandledRow[] {
  return rows.filter((row) => row.closedBy !== "you");
}

/** Handled for you (handledForYou), by who closed them, each newest first. Pure. */
export function handledGroups(rows: readonly HandledRow[]): HandledGroup[] {
  return CLOSER_ORDER.map((by) => ({ by, rows: rows.filter((row) => row.closedBy === by) })).filter(
    (group) => group.rows.length > 0,
  );
}

/**
 * The header's line, Maestro-wide: what needs you (needs.list's total), what
 * runs, and what was handled for you this week. Only once needs.list is read:
 * before that (or while it fails) the subtitle says what it can count itself
 * (plane-model.ts summaryText), never "Nothing needs you". Pure.
 */
export function headerLine(needsYou: number, running: number, handled: number): string {
  const parts = [
    needsWords(needsYou),
    running ? `${running} running` : null,
    handled ? `${handled} handled for you` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

/** A handled group's title: who closed the arcs, and how many. Pure. */
export function handledTitle(group: HandledGroup): string {
  const n = group.rows.length;
  if (group.by === "gates") return `The gates closed ${plural(n, "arc")}`;
  // Who handed them over: their orchestrators took back their own arcs (BRO-2903, BRO-2928).
  if (group.by === "orchestrator") return `From their orchestrators: ${plural(n, "arc")} closed`;
  return `Maestro closed ${plural(n, "arc")} that finished on ${n === 1 ? "its" : "their"} own`;
}
