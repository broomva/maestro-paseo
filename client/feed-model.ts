// The Feed home as the chosen design lays it out (docs/design/feed/feed-column.png,
// BRO-2906): Decide (the asks that wait on you, a few inline), At your gate
// (each card says where it came from, what it shows, what it asks, and the one
// verb), Running, Queued, Handled for you (what Maestro closed on its own,
// rolled up by who handed it over), and Done as a count. Pure: the view only
// renders these.

import type { WorkItem } from "../shared/contracts";
import type { DecisionAsk } from "../shared/fleet";
import { needsYouOf, sectionOf } from "../shared/needs-you";
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

/** Decide: the open asks, those that block work first, then oldest first; a few inline and how many more. Pure. */
export function decideOf(asks: readonly DecisionAsk[]): { rows: DecideRow[]; more: number; blocking: number } {
  const open = asks.filter(isTriaged);
  const ordered = [...open].sort(
    (a, b) => Number(b.blocking) - Number(a.blocking) || (a.askedAt ?? "￿").localeCompare(b.askedAt ?? "￿"),
  );
  const rows = ordered.slice(0, DECIDE_INLINE).map((ask) => {
    const silence = silenceOf(ask);
    return {
      ask,
      headline: headlineOf(ask).headline,
      blocks: ask.blocking,
      where: ledgerName(ledgerOf(ask)),
      silent: silence ? `silent → ${silence.text.replace(/^If you say nothing: /, "")}` : null,
    };
  });
  return { rows, more: open.length - rows.length, blocking: open.filter((ask) => ask.blocking).length };
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
          ? { label: "Needs you", tone: "success" }
          : item.state === "running"
            ? { label: flagged ? "Quiet" : "Running", tone: flagged ? "warning" : "accent" }
            : item.state === "done"
              ? { label: "Done", tone: "muted" }
              : { label: "Queued", tone: "muted" };
  const action = item.state === "review" ? (asked ? "Answer" : "Review") : stuck ? (fleet ? "Open log" : "Look") : null;
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

export interface HandledGroup {
  by: string;
  items: WorkItem[];
}

export interface FeedSections {
  gate: WorkItem[];
  running: WorkItem[];
  queued: WorkItem[];
  /** Finished work Maestro closed on its own evidence this week, by who handed it over, newest first. */
  handled: { count: number; groups: HandledGroup[] };
  /** Finished work you closed: how many, today and this week. */
  done: { count: number; today: number; week: number; items: WorkItem[] };
}

const closedAt = (item: WorkItem) => Date.parse(item.closed?.at ?? item.updatedAt);

/** The Feed's sections, each item once. Pure. */
export function sectionsOf(items: readonly WorkItem[], now: number = Date.now()): FeedSections {
  const finished = items.filter((item) => item.state === "done" || item.state === "canceled");
  const handled = finished
    .filter((item) => item.closed?.by === "maestro" && now - closedAt(item) < WEEK_MS)
    .sort((a, b) => closedAt(b) - closedAt(a));
  const groups = new Map<string, WorkItem[]>();
  for (const item of handled) {
    const by = item.adoptedBy ? (item.adoptedBy.by ?? "Their orchestrators") : "Maestro";
    groups.set(by, [...(groups.get(by) ?? []), item]);
  }
  const yours = finished.filter((item) => !handled.includes(item)).sort((a, b) => closedAt(b) - closedAt(a));
  return {
    gate: needsYouOf(items),
    running: items.filter((item) => sectionOf(item) === "running"),
    queued: items.filter((item) => sectionOf(item) === "queued"),
    handled: { count: handled.length, groups: [...groups].map(([by, list]) => ({ by, items: list })) },
    done: {
      count: yours.length,
      today: yours.filter((item) => now - closedAt(item) < DAY_MS).length,
      week: yours.filter((item) => now - closedAt(item) < WEEK_MS).length,
      items: yours,
    },
  };
}

/** The header's line: what needs you, what runs, and what Maestro handled for you this week. Pure. */
export function headerLine(needsYou: number | null, sections: FeedSections): string {
  const parts = [
    needsYou ? `${needsYou} ${needsYou === 1 ? "needs" : "need"} you` : "Nothing needs you",
    sections.running.length ? `${sections.running.length} running` : null,
    sections.handled.count ? `${sections.handled.count} handled for you` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

/** A handled group's title: who closed how many. Pure. */
export function handledTitle(group: HandledGroup): string {
  const n = group.items.length;
  // Who handed them over, not who closed them: Maestro closes them, on receipts that say why (BRO-2928).
  return group.by === "Maestro"
    ? `Maestro closed ${plural(n, "arc")} that finished on ${n === 1 ? "its" : "their"} own`
    : `From ${group.by}: ${plural(n, "arc")} closed`;
}
