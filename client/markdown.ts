// The Markdown a fleet report is written in, parsed into blocks a native view
// can draw: headings, paragraphs, bullet lists (nested by indent), pipe
// tables, fenced code and rules, with bold and inline code inside a line.
// Nothing else of Markdown is needed there, so anything else reads as plain
// text, never dropped. No links are followed and no HTML is rendered. Pure.

export interface Span {
  text: string;
  bold?: boolean;
  code?: boolean;
}

export type Block =
  | { type: "heading"; level: number; spans: Span[] }
  | { type: "paragraph"; spans: Span[] }
  | { type: "list"; items: { depth: number; spans: Span[] }[] }
  | { type: "table"; header: Span[][]; rows: Span[][][] }
  | { type: "code"; text: string }
  | { type: "rule" };

/** Bold (`**x**`) and inline code (`` `x` ``) inside one line; an unclosed mark stays as text. */
export function parseInline(line: string): Span[] {
  const spans: Span[] = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) spans.push({ text: line.slice(last, at) });
    if (match[1] !== undefined) spans.push({ text: match[1], bold: true });
    else spans.push({ text: match[2] ?? "", code: true });
    last = at + match[0].length;
  }
  if (last < line.length) spans.push({ text: line.slice(last) });
  return spans;
}

/** The cells of one table row: split on pipes that are not escaped, outer pipes dropped. */
export function tableCells(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "\\" && body[index + 1] === "|") {
      cell += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

const isSeparator = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const isTableRow = (line: string) => line.trim().startsWith("|");
const bullet = /^(\s*)[-*]\s+(.*)$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ type: "paragraph", spans: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.trim().startsWith("```")) {
      flush();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trim().startsWith("```")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: "heading", level: heading[1]?.length ?? 1, spans: parseInline((heading[2] ?? "").trim()) });
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flush();
      blocks.push({ type: "rule" });
      continue;
    }
    if (isTableRow(line) && isSeparator(lines[index + 1] ?? "")) {
      flush();
      const header = tableCells(line).map(parseInline);
      const rows: Span[][][] = [];
      index += 2;
      while (index < lines.length && isTableRow(lines[index] ?? "")) {
        rows.push(tableCells(lines[index] ?? "").map(parseInline));
        index += 1;
      }
      index -= 1;
      blocks.push({ type: "table", header, rows });
      continue;
    }
    const item = bullet.exec(line);
    if (item) {
      flush();
      const items: { depth: number; spans: Span[] }[] = [];
      while (index < lines.length) {
        const next = bullet.exec(lines[index] ?? "");
        if (!next) break;
        items.push({ depth: Math.floor((next[1]?.length ?? 0) / 2), spans: parseInline(next[2] ?? "") });
        index += 1;
      }
      index -= 1;
      blocks.push({ type: "list", items });
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

/** A span list as plain text: for labels and for a table cell's width. */
export function plainText(spans: readonly Span[]): string {
  return spans.map((span) => span.text).join("");
}
