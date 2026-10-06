import { describe, expect, test } from "bun:test";
import { clipWords, inlinePlain, plainMarkdown, tailWords } from "./text";

describe("clipWords", () => {
  test("text that fits is flattened and kept whole", () => {
    expect(clipWords("  Ship  the\ncart  ", 80)).toBe("Ship the cart");
  });

  test("a cut lands on a word, with a trailing ellipsis inside the limit", () => {
    const text = "Build the factory cell in six slices (S1-S6): one eve app driving holon worker units";
    const cut = clipWords(text, 80);
    expect(cut).toBe("Build the factory cell in six slices (S1-S6): one eve app driving holon worker…");
    expect(cut.length).toBeLessThanOrEqual(80);
    expect(clipWords("one two three four", 12)).toBe("one two…");
  });

  test("a dangling comma or colon is dropped before the ellipsis", () => {
    expect(clipWords("Scope sri: the comparison is not run", 12)).toBe("Scope sri…");
    expect(clipWords("alpha, beta, gamma, delta", 13)).toBe("alpha, beta…");
  });

  test("one long word is cut where it must be", () => {
    expect(clipWords("a".repeat(30), 10)).toBe(`${"a".repeat(9)}…`);
  });
});

describe("tailWords", () => {
  test("text that fits is returned as it is", () => {
    expect(tailWords("short\ntext", 100)).toBe("short\ntext");
  });

  test("a tail starts at a line when one is near, so a heading still parses", () => {
    const text = `${"x".repeat(50)} words\nNext line here.\n## Decided\n- kept`;
    const tail = tailWords(text, 40);
    expect(tail.startsWith("…\n")).toBe(true);
    expect(tail).toContain("\n## Decided\n- kept");
    expect(tail.length).toBeLessThanOrEqual(40);
  });

  test("else at a sentence, else at a word; never mid-word", () => {
    const sentence = tailWords(`${"lorem ".repeat(20)}ends here. Then the rest of it goes on and on`, 60);
    expect(sentence.startsWith("… ")).toBe(true);
    expect(sentence.length).toBeLessThanOrEqual(60);
    // The live case: "…t ignores major-version bumps" must not start mid-word.
    const live = `Dependabot now ${"skips patches and ".repeat(10)}it ignores major-version bumps from now on.`;
    const word = tailWords(live, 70);
    expect(word.startsWith("… ")).toBe(true);
    expect(live.endsWith(word.slice(2))).toBe(true);
    const first = word.slice(2).split(" ")[0] ?? "";
    expect(live).toMatch(new RegExp(`(^|\\s)${first}\\s`));
  });

  test("a tail with no break anywhere near its start keeps its characters, marked", () => {
    expect(tailWords("y".repeat(100), 20)).toBe(`…${"y".repeat(18)}`);
  });
});

describe("plainMarkdown", () => {
  test("a table reads as its header cells, not pipe rows", () => {
    const md = [
      "Yes, there are two now.",
      "",
      "| Orchestrator | Scope | What it's driving now |",
      "|---|---|---|",
      "| f5307ce7 (me) | **every** broomva/* repo | BRO-2830 |",
      "| SRI | sri | STI-3165 |",
      "",
      "I never touch Stimulus.",
    ].join("\n");
    expect(plainMarkdown(md)).toBe(
      "Yes, there are two now.\n\n(table: Orchestrator, Scope, What it's driving now)\n\nI never touch Stimulus.",
    );
  });

  test("headings, emphasis, code, quotes, lists and rules lose their markers; links read as their text", () => {
    const md = [
      "## Shipped",
      "> **Note** _this_ is ~~old~~ new",
      "- Upgrades tracked in [BRO-2830](https://linear.app/broomva/issue/BRO-2830/x_(y))",
      "1. Run `ctx doctor` and *then* register",
      "- [x] done item",
      "---",
      "![chart](a.png) see <https://example.com>",
    ].join("\n");
    expect(plainMarkdown(md)).toBe(
      [
        "Shipped",
        "Note this is old new",
        "Upgrades tracked in BRO-2830",
        "Run ctx doctor and then register",
        "done item",
        "chart see https://example.com",
      ].join("\n"),
    );
  });

  test("snake_case, a*b and file paths are left alone", () => {
    expect(inlinePlain("set max_tokens_per_run and 2*3*4 in src/a_b/c.ts")).toBe(
      "set max_tokens_per_run and 2*3*4 in src/a_b/c.ts",
    );
  });

  test("fenced code keeps its lines; garbage does not throw", () => {
    expect(plainMarkdown("```sh\nbun test\n```")).toBe("bun test");
    expect(plainMarkdown("")).toBe("");
    expect(plainMarkdown(undefined as unknown as string)).toBe("");
    expect(plainMarkdown("| lone pipe")).toBe("| lone pipe");
  });
});
