import { describe, expect, test } from "bun:test";
import { clipWords, flagRuns, inlinePlain, linksAndBold, plainMarkdown, tailWords, ticketOf } from "./text";

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

  test("a surrogate pair is never split", () => {
    const emoji = "\u{1F600}";
    const cut = clipWords(`${"a".repeat(8)}${emoji.repeat(10)}`, 10);
    expect(cut).toBe(`${"a".repeat(8)}\u2026`);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(cut)).toBe(false);
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

  test("a cut that already lands at a line start keeps that line", () => {
    const text = `${"x".repeat(30)}\n## Decided\n- kept it small`;
    const tail = tailWords(text, "## Decided\n- kept it small".length + 2);
    expect(tail).toBe("\u2026\n## Decided\n- kept it small");
    const word = tailWords(`${"x".repeat(30)} words follow here`, "words follow here".length + 2);
    expect(word).toBe("\u2026 words follow here");
  });

  test("a tail never starts with half a surrogate pair", () => {
    const tail = tailWords(`${"\u{1F600}".repeat(20)}`, 9);
    expect(/^\u2026[\udc00-\udfff]/.test(tail)).toBe(false);
  });

  test("100k characters cost under 50ms a call", () => {
    const huge = "word ".repeat(20_000);
    for (const run of [
      () => clipWords(huge, 280),
      () => tailWords(huge, 8000),
      () => plainMarkdown(`${"[a](".repeat(25_000)}`),
      () => plainMarkdown(`${"**a ".repeat(25_000)}`),
      () => inlinePlain(`${"[x](".repeat(25_000)}`),
      () => plainMarkdown(`| a |\n${"| b ".repeat(25_000)}`),
    ]) {
      const start = performance.now();
      run();
      expect(performance.now() - start).toBeLessThan(50);
    }
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

  test("headings, bold, code, quotes, lists and rules lose their markers; links read as their text", () => {
    const md = [
      "## Shipped",
      "> **Note** this is new",
      "- Upgrades tracked in [BRO-2830](https://linear.app/broomva/issue/BRO-2830/x_(y))",
      "1. Run `ctx doctor` and *then* register",
      "- [x] done item",
      "---",
      "![chart](a.png) see <https://example.com>",
    ].join("\n");
    expect(plainMarkdown(md)).toBe(
      [
        "Shipped",
        "Note this is new",
        "Upgrades tracked in BRO-2830",
        "Run ctx doctor and *then* register",
        "done item",
        "chart see https://example.com",
      ].join("\n"),
    );
  });

  test("globs, dunder names, snake_case and a*b are the agent's words: left alone", () => {
    const words = "edit src/*.ts and lib/*.js, __init__ and __main__, max_tokens_per_run, 2*3*4, _private_";
    expect(inlinePlain(words)).toBe(words);
    expect(plainMarkdown(words)).toBe(words);
  });

  test("a link can keep where it points, as text (host)", () => {
    expect(inlinePlain("see [BRO-1](https://www.linear.app/b/BRO-1) and [x](relative.md)", { hosts: true })).toBe(
      "see BRO-1 (linear.app) and x",
    );
    expect(inlinePlain("see [BRO-1](https://linear.app/b/BRO-1)")).toBe("see BRO-1");
  });

  test("flag tokens are their own runs; the runs join back to the source byte for byte", () => {
    const source = "ctx doctor --compare (-v) on ctx-core, see a-b";
    const runs = flagRuns(source);
    expect(runs.filter((run) => run.flag).map((run) => run.text)).toEqual(["--compare", "-v"]);
    expect(runs.map((run) => run.text).join("")).toBe(source);
    expect(runs.map((run) => run.text).join("")).not.toContain("\u2011");
    for (const plain of ["", "no flags here", "ctx-core"])
      expect(
        flagRuns(plain)
          .map((run) => run.text)
          .join(""),
      ).toBe(plain);
  });

  test("a gate bullet keeps code ticks and globs; only links and bold change", () => {
    expect(linksAndBold("**Kept** `src/*.ts` and `__init__` per [BRO-1](https://x.y/1)")).toBe(
      "Kept `src/*.ts` and `__init__` per BRO-1",
    );
  });

  test("fenced code keeps its lines; garbage does not throw", () => {
    expect(plainMarkdown("```sh\nbun test\n```")).toBe("bun test");
    expect(plainMarkdown("")).toBe("");
    expect(plainMarkdown(undefined as unknown as string)).toBe("");
    expect(plainMarkdown("| lone pipe")).toBe("| lone pipe");
  });
});

describe("a ticket id (BRO-2908)", () => {
  test("the first ticket-shaped id, never a standard such as UTF-8 or SHA-256", () => {
    expect(
      [
        "SRI: STI-3508 Enroll",
        "Act on BRO-2827 now",
        "UTF-8 decode for STI-12",
        "SHA-256 and ISO-8601 only",
        "no ticket",
      ].map(ticketOf),
    ).toEqual(["STI-3508", "BRO-2827", "STI-12", null, null]);
    // A team whose key reads like a standard keeps its tickets.
    expect(["MD-12 notes", "ISO-12 audit", "RFC-9110 header"].map(ticketOf)).toEqual(["MD-12", "ISO-12", null]);
  });
});
