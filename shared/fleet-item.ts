// Work that fleet-reconcile raised, read for a person. Its title ends with a
// marker the fleet finds it by (`[fleet-reconcile <scope> <what>]`, skills
// fleet-reconcile fleetlib/paseo_ask.py marker()), and its brief is written for
// the run agent first. This reads both so the surfaces can show what is asked:
// the title without its marker, the asks as a list, and the run's instructions
// apart. Data is never changed: the raw title stays, since the fleet matches it
// with endswith(marker).
//
// Two brief shapes are read (paseo_ask.py brief()):
//
//   old  <lead paragraph>, <a line for the agent>, a ```text fenced block of
//        asks as `[a1] (observe) <question>` lines, then the run's instructions.
//   new  `## For you` (prose, and the asks as `[a1] (class) question` lines,
//        bulleted or in a fenced block), then `## For the run` (everything for
//        the agent, which may repeat the asks as data).
//
// Old titles read `1 ask (tick 7) [marker]`; new ones `<first question…>
// (+N more) [marker]`. Every function here is pure, total, and never throws: a
// shape it does not know falls back to the raw title and brief.

import { clipWords, flat, inlinePlain } from "./text";

/** How long a title built from an ask's question may be, before "(+N more)". */
export const ASK_TITLE_MAX = 90;

const MARKER = /\s*\[fleet-reconcile\s+([^\s\]]+)\s+([^\]]+?)\s*\]\s*$/;
const OLD_TITLE = /^(\d+)\s+asks?\s+\(tick\s+([^)\s]+)\)$/i;
const ASK_LINE = /^\s*(?:[-*+]\s+)?\[([A-Za-z0-9][\w.-]{0,15})\]\s*(?:\(([^()\n]{1,32})\)\s*)?(.*)$/;
const FENCE = /^\s*(```|~~~)/;
const FOR_YOU = /^#{1,3}\s+For you\s*:?\s*$/im;
const FOR_RUN = /^#{1,3}\s+For the run\s*:?\s*$/im;

export interface FleetMarker {
  scope: string;
  /** What the item carries: `batch 7-3`, `alert tick-observe`. */
  what: string;
  /** The title before the marker. */
  rest: string;
}

/** One ask quoted in the brief: its id (`a1`), its class (`observe`), and the question. */
export interface FleetAsk {
  id: string | null;
  kind: string | null;
  question: string;
}

export interface FleetBrief {
  /** The words for the owner that are not asks: the old brief's lead paragraph, or `## For you` prose. */
  lead: string;
  asks: FleetAsk[];
  /** What the run agent is told, shown apart: null when the brief has none. */
  instructions: string | null;
  /** Which shape was read. */
  shape: "old" | "new";
}

/** Where a fleet item comes from, for its meta line. */
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
  const match = MARKER.exec(title);
  if (!match?.[1] || !match[2]) return null;
  return { scope: match[1], what: flat(match[2]), rest: flat(title.slice(0, match.index)) };
}

/** The title without a trailing fleet marker; any other title as it is. */
export function withoutMarker(title: string): string {
  const mark = fleetMarker(title);
  return mark?.rest ? mark.rest : title;
}

/** `fleet · sri · tick 7`, `fleet · sri · alert tick-observe`, or `fleet · sri`. */
export function fleetMeta(origin: FleetOrigin): string {
  const extra = origin.tick ? `tick ${origin.tick}` : origin.what.startsWith("alert ") ? origin.what : null;
  return ["fleet", origin.scope, extra].filter(Boolean).join(" · ");
}

/** The asks quoted in `text`: `[id] (class) question` lines, a following line that is not one continuing it. */
function asksIn(text: string): FleetAsk[] {
  const asks: FleetAsk[] = [];
  let open: FleetAsk | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (FENCE.test(line) || !line.trim()) {
      open = null;
      continue;
    }
    const match = ASK_LINE.exec(line);
    if (match?.[1]) {
      open = { id: match[1], kind: match[2] ? flat(match[2]) : null, question: flat(match[3] ?? "") };
      asks.push(open);
    } else if (open && !/^\s*#/.test(line)) {
      open.question = flat(`${open.question} ${line}`);
    } else {
      open = null;
    }
  }
  return asks.map((ask) => ({ ...ask, question: inlinePlain(ask.question) })).filter((ask) => ask.question);
}

/** The first fenced block: its body and where it starts and ends (line indexes), or null. */
function firstFence(lines: string[]): { from: number; to: number; body: string } | null {
  const from = lines.findIndex((line) => FENCE.test(line));
  if (from < 0) return null;
  let to = lines.findIndex((line, index) => index > from && FENCE.test(line));
  if (to < 0) to = lines.length;
  return { from, to, body: lines.slice(from + 1, to).join("\n") };
}

/** Paragraphs of `text`, blank-line separated and trimmed, the empty ones dropped. */
function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function readNew(brief: string): FleetBrief | null {
  const you = FOR_YOU.exec(brief);
  if (!you) return null;
  const start = you.index + you[0].length;
  const runHead = FOR_RUN.exec(brief.slice(start));
  const youText = runHead ? brief.slice(start, start + runHead.index) : brief.slice(start);
  const runText = runHead ? brief.slice(start + runHead.index + runHead[0].length).trim() : "";
  let asks = asksIn(youText);
  if (asks.length === 0 && runText) asks = asksIn(firstFence(runText.split(/\r?\n/))?.body ?? "");
  // The prose: what is left of For you once the ask lines and fences are out, with anything above it.
  const kept: string[] = [];
  let inFence = false;
  let inAsk = false;
  for (const line of youText.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (ASK_LINE.test(line)) {
      inAsk = true;
      continue;
    }
    if (!line.trim()) inAsk = false;
    else if (inAsk) continue;
    kept.push(line);
  }
  const above = brief.slice(0, you.index).trim();
  const lead = [above, kept.join("\n").trim()].filter(Boolean).join("\n\n");
  return { lead, asks, instructions: runText || null, shape: "new" };
}

function readOld(brief: string): FleetBrief | null {
  const lines = brief.split(/\r?\n/);
  const fence = firstFence(lines);
  if (!fence) return null;
  let asks = asksIn(fence.body);
  // An alert quotes one message, not `[id]` lines: the block is the one ask.
  if (asks.length === 0 && fence.body.trim()) asks = [{ id: null, kind: null, question: flat(fence.body) }];
  if (asks.length === 0) return null;
  const before = paragraphs(lines.slice(0, fence.from).join("\n"));
  const after = lines
    .slice(fence.to + 1)
    .join("\n")
    .trim();
  const lead = before[0] ?? "";
  const instructions = [...before.slice(1), after].filter(Boolean).join("\n\n");
  return { lead, asks, instructions: instructions || null, shape: "old" };
}

/** The brief of a fleet item, in parts; null when it is neither shape. */
export function parseFleetBrief(brief: unknown): FleetBrief | null {
  if (typeof brief !== "string" || !brief.trim()) return null;
  try {
    return readNew(brief) ?? readOld(brief);
  } catch {
    return null;
  }
}

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
 * first ask's question; an old alert title (`fleet sri: kind`) its message; a
 * new title keeps its words without the marker.
 */
export function fleetHeading(title: unknown, brief: unknown): FleetHeading | null {
  const mark = fleetMarker(title);
  if (!mark) return null;
  const parsed = parseFleetBrief(brief);
  const old = OLD_TITLE.exec(mark.rest);
  const lead = parsed?.lead ?? "";
  const tick =
    old?.[2] ??
    /\(tick\s+([^)\s]+)\)/i.exec(mark.rest)?.[1] ??
    /\(tick\s+([^)\s]+)\)/i.exec(lead)?.[1] ??
    /^batch\s+(\d+)-\d+$/i.exec(mark.what)?.[1] ??
    null;
  let shown: string | null = null;
  if (old && parsed) shown = askTitle(parsed.asks, Number(old[1]));
  else if (mark.what.startsWith("alert ") && /^fleet\s+\S+:/.test(mark.rest) && parsed?.asks[0]) {
    shown = clipWords(parsed.asks[0].question, ASK_TITLE_MAX);
  }
  return {
    title: shown || mark.rest || (title as string),
    origin: { scope: mark.scope, what: mark.what, tick },
  };
}
