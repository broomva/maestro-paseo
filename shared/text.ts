// Cutting text a person reads: never mid-word or mid-character, and an
// ellipsis wherever text was left out. Pure; compiled into both bundles.
// Every regex here runs on input already capped (LINE_CAP), so its cost is
// bounded whatever an agent wrote.

const ELLIPSIS = "…";

/** The longest line any inline regex here sees; the rest of a longer line is left out. */
export const LINE_CAP = 2000;

/** Whitespace runs as one space, trimmed. */
export function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isHigh(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLow(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** `text` cut to at most `max` UTF-16 units without leaving half a surrogate pair at the end. */
function headUnits(text: string, max: number): string {
  const cut = text.slice(0, max);
  return cut.length > 0 && isHigh(cut.charCodeAt(cut.length - 1)) ? cut.slice(0, -1) : cut;
}

/**
 * The start of `text` on one line, at most `max` characters: a cut that ends
 * a word keeps it, else back to the last space before the limit (when that
 * keeps at least half of it), with a trailing "…", and a dangling comma,
 * colon or stop dropped before the ellipsis. A surrogate pair is never split.
 */
export function clipWords(text: string, max: number): string {
  const one = flat(text);
  if (one.length <= max) return one;
  const room = Math.max(1, max - 1);
  const cut = headUnits(one, room);
  const space = one.charAt(room) === " " ? cut.length : cut.lastIndexOf(" ");
  const kept = space >= room / 2 ? cut.slice(0, space) : cut;
  return `${kept.replace(/[\s,;:.([{-]+$/, "")}${ELLIPSIS}`;
}

/**
 * The end of `text`, at most `max` characters, starting where a reader can:
 * where the cut already lands at a line or word start, there; else the first
 * line break, else the first sentence end, else the first space in the
 * opening fifth of the tail, with "…" in front. Line breaks are kept, so a
 * `## Decided` heading near the end still parses. Text that fits is returned
 * as it is. A surrogate pair is never split.
 */
export function tailWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = Math.max(1, max - 2);
  let from = text.length - room;
  if (isLow(text.charCodeAt(from))) from += 1;
  const tail = text.slice(from);
  const before = text.charAt(from - 1);
  if (before === "\n") return `${ELLIPSIS}\n${tail}`;
  if (/\s/.test(before) && !/^\s/.test(tail)) return `${ELLIPSIS} ${tail}`;
  const reach = Math.max(1, Math.floor(room / 5));
  const head = tail.slice(0, reach);
  const line = head.indexOf("\n");
  if (line >= 0) return `${ELLIPSIS}\n${tail.slice(line + 1).replace(/^\n+/, "")}`;
  const sentence = /[.!?]["')\]]?\s+(?=\S)/.exec(head);
  if (sentence) return `${ELLIPSIS} ${tail.slice(sentence.index + sentence[0].length)}`;
  const space = head.search(/\s/);
  if (space >= 0) return `${ELLIPSIS} ${tail.slice(space).trimStart()}`;
  return `${ELLIPSIS}${tail}`;
}

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * Markdown as plain prose for a one-paragraph excerpt: headings, quote and
 * list markers, code ticks and **bold** dropped, links read as their text,
 * images as their alt text, and a table summarised by its header cells
 * ("(table: Orchestrator, Scope)") instead of pipe rows. Single `*` and `_`
 * are left alone: in agent text they are globs and names (`src/*.ts`,
 * `__init__`) far more often than emphasis. Line breaks stay; the caller
 * flattens. Never throws.
 */
export function plainMarkdown(markdown: string): string {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const out: string[] = [];
  let fence: string | null = null;
  let table = false;
  for (const whole of lines) {
    const raw = whole.length > LINE_CAP ? headUnits(whole, LINE_CAP) : whole;
    const mark = FENCE_OPEN.exec(raw)?.[1];
    if (mark && (fence === null || (mark[0] === fence[0] && mark.length >= fence.length))) {
      fence = fence === null ? mark : null;
      continue;
    }
    if (fence !== null) {
      out.push(raw);
      continue;
    }
    if (isTableRow(raw)) {
      if (!table) {
        const cells = raw
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((cell) => inlinePlain(cell).trim())
          .filter((cell) => cell && !/^:?-{2,}:?$/.test(cell));
        out.push(cells.length > 0 ? `(table: ${cells.join(", ")})` : "(table)");
        table = true;
      }
      continue;
    }
    table = false;
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(raw)) continue; // a horizontal rule
    const line = raw
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/\s+#+\s*$/, "")
      .replace(/^\s{0,3}>\s?/, "")
      .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/, "");
    out.push(inlinePlain(line));
  }
  return out.join("\n").trim();
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.length > 1 && (t.match(/\|/g)?.length ?? 0) >= 2;
}

/** A link's host for reading beside its text: `linear.app`, without `www.`; null when it has none. */
function hostOf(url: string): string | null {
  return /^[a-z][a-z0-9+.-]{0,20}:\/\/(?:www\.)?([^/\s?#:]{1,200})/i.exec(url)?.[1] ?? null;
}

/**
 * Links as their text and **bold** without its markers, nothing else, so
 * globs and names (`src/*.ts`, `__init__`) stay. `hosts`: a link keeps where
 * it points as "text (host)", for words a person decides on.
 */
export function linksAndBold(line: string, options: { hosts?: boolean } = {}): string {
  const capped = line.length > LINE_CAP ? headUnits(line, LINE_CAP) : line;
  const link = (_: string, text: string, url: string) => {
    const host = options.hosts ? hostOf(url) : null;
    return host && host !== text ? `${text} (${host})` : text;
  };
  return capped
    .replace(/!\[([^\]\n]{0,500})\]\([^)\n]{0,2000}\)/g, "$1")
    .replace(/\[([^\]\n]{1,500})\]\(((?:[^()\n]|\([^()\n]{0,500}\)){0,2000})\)/g, link)
    .replace(/\[([^\]\n]{1,500})\]\[[^\]\n]{0,200}\]/g, "$1")
    .replace(/<(https?:\/\/[^>\s]{1,2000})>/g, "$1")
    .replace(/\*\*(\S(?:[^*\n]{0,2000}?\S)?)\*\*/g, "$1");
}

/** One line of Markdown without its inline markers: links and bold (linksAndBold), and code ticks. */
export function inlinePlain(line: string, options: { hosts?: boolean } = {}): string {
  return linksAndBold(line, options).replace(/`([^`\n]{1,2000})`/g, "$1");
}

/**
 * `text` split into runs, each flag-like token (`--compare`, `-v`) its own
 * run, so a surface can keep that token from wrapping at its hyphen. The runs
 * join back to `text` exactly: the words are never changed.
 */
export function flagRuns(text: string): Array<{ text: string; flag: boolean }> {
  const runs: Array<{ text: string; flag: boolean }> = [];
  const pattern = /(^|[\s(])(--?[A-Za-z][\w-]{0,200})/g;
  let at = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const start = match.index + (match[1] ?? "").length;
    if (start > at) runs.push({ text: text.slice(at, start), flag: false });
    runs.push({ text: match[2] ?? "", flag: true });
    at = start + (match[2] ?? "").length;
  }
  if (at < text.length || runs.length === 0) runs.push({ text: text.slice(at), flag: false });
  return runs;
}
