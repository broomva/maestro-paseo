// Cutting text a person reads: never mid-word, and an ellipsis wherever text
// was left out. Pure; compiled into both bundles.

const ELLIPSIS = "…";

/** Whitespace runs as one space, trimmed. */
export function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The start of `text` on one line, at most `max` characters: cut at the last
 * space before the limit (when that keeps at least half of it) with a
 * trailing "…", and a dangling comma, colon or stop dropped before the ellipsis.
 */
export function clipWords(text: string, max: number): string {
  const one = flat(text);
  if (one.length <= max) return one;
  const room = Math.max(1, max - 1);
  const cut = one.slice(0, room);
  // A cut that ends a word keeps it; otherwise back to the last space, when that keeps at least half.
  const space = one.charAt(room) === " " ? room : cut.lastIndexOf(" ");
  const kept = space >= room / 2 ? cut.slice(0, space) : cut;
  return `${kept.replace(/[\s,;:.([{-]+$/, "")}${ELLIPSIS}`;
}

/**
 * The end of `text`, at most `max` characters, starting where a reader can:
 * the first line break, else the first sentence end, else the first space in
 * the opening fifth of the tail, with "…" in front. Line breaks are kept, so
 * a `## Decided` heading near the end still parses. Text that fits is
 * returned as it is.
 */
export function tailWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = Math.max(1, max - 2);
  const tail = text.slice(text.length - room);
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

/**
 * Markdown as plain prose for a one-paragraph excerpt: headings, emphasis,
 * code ticks, blockquote and list markers dropped, links read as their text,
 * images as their alt text, and a table summarised by its header cells
 * ("(table: Orchestrator, Scope)") instead of pipe rows. Line breaks stay;
 * the caller flattens. Never throws.
 */
export function plainMarkdown(markdown: string): string {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const out: string[] = [];
  let fence = false;
  let table = false;
  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = !fence;
      continue;
    }
    if (fence) {
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
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) continue; // a horizontal rule
    const line = raw
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/\s+#+\s*$/, "")
      .replace(/^\s*>\s?/, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "");
    out.push(inlinePlain(line));
  }
  return out.join("\n").trim();
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.length > 1 && (t.match(/\|/g)?.length ?? 0) >= 2;
}

/** One line of Markdown without its inline markers. */
export function inlinePlain(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/(^|[^\w*])\*(\S(?:[^*]*?\S)?)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^\w_])_(\S(?:[^_]*?\S)?)_(?!\w)/g, "$1$2")
    .replace(/~~(\S(?:.*?\S)?)~~/g, "$1");
}
