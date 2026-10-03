import { describe, expect, test } from "bun:test";
import { parseInline, parseMarkdown, plainText, tableCells } from "./markdown";

// The shapes a fleet report is written in (fleetlib/report.py), cut down.
const REPORT = `# fleet-reconcile · broomva · tick 35 · 2026-10-02T20:34:45.030Z

Report only (phase 1). Nothing was sent, spawned, labelled or resumed.
The "would do" column is what phase 3 would do.

**Open asks: 3** (0 new this tick). Read them with \`fleet asks\`.

## Classes

| # | class | sessions |
|---|---|---|
| 1 | out of scope | 53 |
| 4 | error | 1 |

Out of scope (class 1): 53 session(s):
- 06b3726d bad-goat (background, done), cwd ~/x
  - agent 04c3a553: claude agents lists no live process for it
- 07fe7c90 octopus

\`\`\`
fleet ack 7
\`\`\`
---
`;

describe("a fleet report", () => {
  const blocks = parseMarkdown(REPORT);

  test("reads as headings, paragraphs, a table, a nested list, code and a rule, in order", () => {
    expect(blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "paragraph",
      "heading",
      "table",
      "paragraph",
      "list",
      "code",
      "rule",
    ]);
  });

  test("lines of one paragraph join; a blank line starts the next", () => {
    const [, first] = blocks;
    expect(first?.type === "paragraph" && plainText(first.spans)).toBe(
      'Report only (phase 1). Nothing was sent, spawned, labelled or resumed. The "would do" column is what phase 3 would do.',
    );
  });

  test("bold and inline code are marked inside a line", () => {
    const third = blocks[2];
    expect(third?.type === "paragraph" && third.spans).toEqual([
      { text: "Open asks: 3", bold: true },
      { text: " (0 new this tick). Read them with " },
      { text: "fleet asks", code: true },
      { text: "." },
    ]);
  });

  test("a table keeps its header and rows, cell by cell", () => {
    const table = blocks.find((block) => block.type === "table");
    expect(table?.type === "table" && table.header.map(plainText)).toEqual(["#", "class", "sessions"]);
    expect(table?.type === "table" && table.rows.map((row) => row.map(plainText))).toEqual([
      ["1", "out of scope", "53"],
      ["4", "error", "1"],
    ]);
  });

  test("a list nests by indent", () => {
    const list = blocks.find((block) => block.type === "list");
    expect(list?.type === "list" && list.items.map((item) => [item.depth, plainText(item.spans).slice(0, 8)])).toEqual([
      [0, "06b3726d"],
      [1, "agent 04"],
      [0, "07fe7c90"],
    ]);
  });

  test("a fenced block is kept as written", () => {
    const code = blocks.find((block) => block.type === "code");
    expect(code?.type === "code" && code.text).toBe("fleet ack 7");
  });
});

describe("edges", () => {
  test("an escaped pipe stays in its cell; outer pipes are dropped", () => {
    expect(tableCells("| a \\| b | c |")).toEqual(["a | b", "c"]);
    expect(tableCells("a | b")).toEqual(["a", "b"]);
  });

  test("an unclosed mark is text, not lost", () => {
    expect(parseInline("a **b and `c")).toEqual([{ text: "a **b and `c" }]);
  });

  test("a pipe line with no separator under it is a paragraph, not a table", () => {
    expect(parseMarkdown("| a | b |\nnot a separator").map((block) => block.type)).toEqual(["paragraph"]);
  });

  test("Windows line ends read the same", () => {
    expect(parseMarkdown("# A\r\n\r\ntext\r\n").map((block) => block.type)).toEqual(["heading", "paragraph"]);
  });
});
