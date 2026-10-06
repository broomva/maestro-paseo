// Work that fleet-reconcile raised, read for a person. Its title ends with a
// marker the fleet finds it by (`[fleet-reconcile <scope> <what>]`, skills
// fleet-reconcile fleetlib/paseo_ask.py marker()), and its brief is written
// for the run agent as well as the owner. This reads both so the surfaces can
// show what is asked: the title without its marker, the asks as a list, the
// producer's own verbs line, and the run's instructions apart. Data is never
// changed: the raw title stays, since the fleet matches it with
// endswith(marker).
//
// The contract (BRO-2839/BRO-2840, the same words as fleet-reconcile's SKILL.md):
//
//   new  `## For you` (column 0, outside any fence): a lead line, the asks one
//        per line as `- [<id>] (<class>) <question>` (id like a1 or a12, or
//        `alert`; the class may be empty, `()`), optionally inside a ```text fence, then
//        exactly one verbs line. Then `## For the run`: everything for the
//        agent, never read for asks.
//   old  a lead paragraph, a line for the agent, a fenced block of
//        `[a1] (class) question` lines, then the run's instructions.
//
// A brief that has `## For you` but no ask line in it, or an old brief with
// no fence holding an ask line, reads as null: the surface shows it as written.
// Every function here is pure, total, never throws, and bounded in cost: the
// title and each line are capped before any regex runs.

import { clipWords, flat, inlinePlain, LINE_CAP, plainMarkdown } from "./text";

/** How long a title built from an ask's question may be, before "(+N more)". */
export const ASK_TITLE_MAX = 90;
/** The most of a title or brief read; past it, a title's start or a brief's end is left out. */
export const TITLE_CAP = 2000;
export const BRIEF_CAP = 64 * 1024;

const MARKER_HEAD = "[fleet-reconcile ";
const MARKER = /^\[fleet-reconcile ([^\s\]]{1,80}) ([^\]\n]{1,200})\]\s*$/;
const OLD_TITLE = /^(\d{1,4})\s+asks?\s+\(tick\s+([^)\s]{1,20})\)$/i;
// An id is a few letters and a number (a1, a12), or `alert` (paseo_ask.alert): never `x` (a checkbox) or a word (a link).
const ASK_LINE = /^\s{0,3}(?:[-*+]\s+)?\[([A-Za-z]{0,3}\d{1,4}|alert)\]\s+\(([^()\n]{0,40})\)(?:\s+(.*))?$/;
// A fence opens or closes only at column 0: an indented one inside an ask is the ask's words.
const FENCE = /^(`{3,}|~{3,})/;
const FOR_YOU = /^#{1,3} For you\s*:?\s*$/;
const FOR_RUN = /^#{1,3} For the run\s*:?\s*$/;
const TICK = /\(tick\s+([^)\s]{1,20})\)/i;

export interface FleetMarker {
  scope: string;
  /** What the item carries: `batch 7-3`, `alert tick-observe`. */
  what: string;
  /** The title before the marker. */
  rest: string;
}

/** One ask quoted in the brief: its id (`a1`), its class (`observe`, or null when empty), and the question. */
export interface FleetAsk {
  id: string;
  kind: string | null;
  question: string;
}

export interface FleetBrief {
  /** The words for the owner before the asks, as plain prose. */
  lead: string;
  asks: FleetAsk[];
  /** The producer's own line on what the verbs do, as plain prose; null when it wrote none (old briefs). */
  verbs: string | null;
  /** What the run agent is told, shown apart: null when the brief has none. */
  instructions: string | null;
  /** Which shape was read. */
  shape: "old" | "new";
}

/** Where a fleet item comes from: its scope, what it carries, and the tick that raised it when known. */
export interface FleetOrigin {
  scope: string;
  what: string;
  tick: string | null;
}

export interface FleetHeading {
  /** The title a person reads. */
  title: string;
  origin: FleetOrigin;
}

export function fleetMarker(title: unknown): FleetMarker | null {
  if (typeof title !== "string") return null;
  // The marker is at the end: only the last TITLE_CAP characters are searched, from its last opening.
  const offset = Math.max(0, title.length - TITLE_CAP);
  const at = title.lastIndexOf(MARKER_HEAD);
  if (at < offset) return null;
  const match = MARKER.exec(title.slice(at));
  if (!match?.[1] || !match[2]) return null;
  const rest = title.slice(Math.max(0, at - TITLE_CAP), at);
  return { scope: match[1], what: flat(match[2]), rest: flat(rest) };
}

/** The title without a trailing fleet marker; any other title as it is. */
export function withoutMarker(title: string): string {
  const mark = fleetMarker(title);
  return mark?.rest ? mark.rest : title;
}

/** The kind of an alert item (`tick-observe`), or null for any other fleet item. */
export function alertKind(origin: Pick<FleetOrigin, "what">): string | null {
  return /^alert (.+)$/.exec(origin.what)?.[1] ?? null;
}

/** The place a card or the detail shows for fleet work: `fleet · sri`, `fleet · sri · alert`. */
export function fleetMeta(origin: Pick<FleetOrigin, "scope" | "what">): string {
  return `fleet · ${origin.scope}${alertKind(origin) !== null ? " · alert" : ""}`;
}

/** The detail's secondary line: `tick 7 · batch 7-3`, or an alert's kind (`tick-observe`). */
export function fleetDetail(origin: FleetOrigin): string {
  return alertKind(origin) ?? [origin.tick ? `tick ${origin.tick}` : null, origin.what].filter(Boolean).join(" · ");
}

/**
 * Whether a brief's lead only restates what the detail shows above it (the
 * scope or the tick, which sit under the title): such a lead is not shown.
 */
export function leadRestates(lead: string, origin: Pick<FleetOrigin, "scope" | "tick">): boolean {
  return lead.includes(`scope ${origin.scope}`) || (origin.tick !== null && lead.includes(`(tick ${origin.tick})`));
}

/** The brief's lines, at most BRIEF_CAP characters, each at most LINE_CAP. */
function linesOf(brief: string): string[] {
  return brief
    .slice(0, BRIEF_CAP)
    .split(/\r?\n/)
    .map((line) => (line.length > LINE_CAP ? line.slice(0, LINE_CAP) : line));
}

/** A fence that opens or closes: its marker run (```` ``` ````, `~~~`). */
function fenceMark(line: string): string | null {
  return FENCE.exec(line)?.[1] ?? null;
}

/** Whether `mark` closes a fence opened with `open`: the same character, at least as long. */
function closes(open: string, mark: string): boolean {
  return mark[0] === open[0] && mark.length >= open.length;
}

function askOf(line: string): FleetAsk | null {
  const match = ASK_LINE.exec(line);
  if (!match?.[1]) return null;
  const kind = flat(match[2] ?? "");
  return { id: match[1], kind: kind || null, question: flat(match[3] ?? "") };
}

/**
 * Reads the lines of one region: ask lines (inside or outside a fence), an
 * indented line continuing the ask above it, and the prose outside fences
 * before the first ask and after it.
 */
function readRegion(lines: readonly string[]): { asks: FleetAsk[]; before: string[]; after: string[] } {
  const asks: FleetAsk[] = [];
  const before: string[] = [];
  const after: string[] = [];
  let fence: string | null = null;
  let open: FleetAsk | null = null;
  for (const line of lines) {
    const mark = fenceMark(line);
    if (mark && (fence === null || closes(fence, mark))) {
      fence = fence === null ? mark : null;
      open = null;
      continue;
    }
    const ask = askOf(line);
    if (ask) {
      asks.push(ask);
      open = ask;
      continue;
    }
    if (open && /^\s{2,}\S/.test(line)) {
      open.question = flat(`${open.question} ${line}`);
      continue;
    }
    open = null;
    if (fence !== null) continue;
    (asks.length === 0 ? before : after).push(line);
  }
  // Code ticks and links read as words; an ask with no question left is dropped.
  const read = asks.map((ask) => ({ ...ask, question: flat(inlinePlain(ask.question)) }));
  return { asks: read.filter((ask) => ask.question), before, after };
}

/** Paragraphs as plain prose, joined with a blank line; empty when there are none. */
function prose(lines: readonly string[]): string {
  return plainMarkdown(lines.join("\n"))
    .split(/\n\s*\n/)
    .map(flat)
    .filter(Boolean)
    .join("\n\n");
}

/** Where `## For you` and `## For the run` start, at column 0 outside any fence; -1 when absent. */
function sections(lines: readonly string[]): { you: number; run: number } {
  let fence: string | null = null;
  let you = -1;
  let run = -1;
  lines.forEach((line, index) => {
    const mark = fenceMark(line);
    if (mark && (fence === null || closes(fence, mark))) {
      fence = fence === null ? mark : null;
      return;
    }
    if (fence !== null) return;
    if (you < 0 && FOR_YOU.test(line)) you = index;
    else if (you >= 0 && run < 0 && FOR_RUN.test(line)) run = index;
  });
  return { you, run };
}

function readNew(lines: readonly string[], you: number, run: number): FleetBrief | null {
  const region = readRegion(lines.slice(you + 1, run < 0 ? lines.length : run));
  if (region.asks.length === 0) return null;
  const instructions =
    run < 0
      ? ""
      : lines
          .slice(run + 1)
          .join("\n")
          .trim();
  return {
    lead: prose([...lines.slice(0, you), "", ...region.before]),
    asks: region.asks,
    verbs: prose(region.after) || null,
    instructions: instructions || null,
    shape: "new",
  };
}

function readOld(lines: readonly string[]): FleetBrief | null {
  // The fence that holds ask lines, not merely the first one.
  let fence: string | null = null;
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const mark = fenceMark(lines[index] ?? "");
    if (!mark || (fence !== null && !closes(fence, mark))) continue;
    if (fence === null) {
      fence = mark;
      start = index;
      continue;
    }
    fence = null;
    const asks = readRegion(lines.slice(start + 1, index)).asks;
    if (asks.length > 0) return oldParts(lines, start, index, asks);
  }
  if (fence !== null) {
    const asks = readRegion(lines.slice(start + 1)).asks;
    if (asks.length > 0) return oldParts(lines, start, lines.length, asks);
  }
  return null;
}

function oldParts(lines: readonly string[], from: number, to: number, asks: FleetAsk[]): FleetBrief {
  const paragraphs = lines
    .slice(0, from)
    .join("\n")
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  const after = lines
    .slice(to + 1)
    .join("\n")
    .trim();
  const instructions = [...paragraphs.slice(1), after].filter(Boolean).join("\n\n");
  return { lead: prose([paragraphs[0] ?? ""]), asks, verbs: null, instructions: instructions || null, shape: "old" };
}

/** The brief of a fleet item, in parts; null when it is neither shape or quotes no ask. */
export function parseFleetBrief(brief: unknown): FleetBrief | null {
  if (typeof brief !== "string" || !brief.trim()) return null;
  try {
    const lines = linesOf(brief);
    const { you, run } = sections(lines);
    return you >= 0 ? readNew(lines, you, run) : readOld(lines);
  } catch {
    return null;
  }
}

/** The most of an alert's message a title shows. */
export const ALERT_TITLE_MAX = 160;

/** A title from the asks: the first question cut at a word, and how many more there are. */
export function askTitle(asks: readonly FleetAsk[], total = asks.length): string | null {
  const first = asks[0]?.question;
  if (!first) return null;
  const more = Math.max(total, asks.length) - 1;
  return `${clipWords(first, ASK_TITLE_MAX)}${more > 0 ? ` (+${more} more)` : ""}`;
}

/**
 * How a fleet item's title reads, and where it came from; null for a title
 * with no fleet marker. An old count title (`1 ask (tick 7)`) becomes its
 * first ask's question; an alert, its message alone (the scope and kind are
 * its meta); any other keeps its words without the marker. The tick is the
 * fleet's own: the old title's or the batch id's, never one quoted in an
 * ask's words.
 */
export function fleetHeading(title: unknown, brief: unknown): FleetHeading | null {
  const mark = fleetMarker(title);
  if (!mark) return null;
  const old = OLD_TITLE.exec(mark.rest);
  const kind = alertKind(mark);
  const parsed = old || kind !== null ? parseFleetBrief(brief) : null;
  const firstLine = typeof brief === "string" ? (/^[^\n]{0,400}/.exec(brief.trimStart())?.[0] ?? "") : "";
  const tick = old?.[2] ?? /^batch\s+(\d{1,9})-\d{1,9}$/i.exec(mark.what)?.[1] ?? TICK.exec(firstLine)?.[1] ?? null;
  const message = kind !== null ? parsed?.asks.find((ask) => ask.id === "alert")?.question : undefined;
  const prefix = `fleet ${mark.scope}: ${kind} \u2014 `;
  const shown =
    old && parsed
      ? askTitle(parsed.asks, Number(old[1]))
      : message
        ? clipWords(message, ALERT_TITLE_MAX)
        : kind !== null && mark.rest.startsWith(prefix)
          ? mark.rest.slice(prefix.length)
          : null;
  return {
    title: shown || mark.rest || (title as string).slice(-TITLE_CAP),
    origin: { scope: mark.scope, what: mark.what, tick },
  };
}
