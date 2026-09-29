import { describe, expect, test } from "bun:test";
import {
  briefOf,
  newWorkSource,
  parseWorkDoc,
  readChecks,
  readContract,
  readFeatures,
  renderWorkDoc,
  setFields,
  TITLE_MAX,
  titleOf,
  WorkFileError,
  workTitle,
} from "./frontmatter";

const base = {
  id: "7d0c",
  title: "Persist run transcripts",
  brief: "Store the transcript on the Run record.",
  kind: "task" as const,
  state: "proposed" as const,
  gate: "human" as const,
  repo: "/tmp/repo",
  check: "bun test",
  date: "2026-09-22",
};

describe("_work.md", () => {
  test("a new file round-trips through the Maestro contract fields", () => {
    const work = parseWorkDoc(newWorkSource(base));
    const contract = readContract(work);
    expect(contract).toMatchObject({ id: "7d0c", kind: "task", state: "proposed", gate: "human", repo: "/tmp/repo" });
    expect(contract.checks).toEqual([{ name: "check", run: "bun test", timeoutS: 600, required: true }]);
    expect(titleOf(work.body, "x")).toBe("Persist run transcripts");
    expect(briefOf(work.body)).toBe("Store the transcript on the Run record.");
  });

  test("no check means no done block", () => {
    const source = newWorkSource({ ...base, check: "  " });
    expect(source).not.toContain("done:");
    expect(readContract(parseWorkDoc(source)).checks).toEqual([]);
  });

  test("editing state keeps the author's comments and the body", () => {
    const source =
      "---\n# owned by ops\nid: a1\nkind: task\nstate: running\ngate: human # keep\ncreated: 2026-09-01\nupdated: 2026-09-01\n---\n\n# Title\n\nBody text\n";
    const work = parseWorkDoc(source);
    setFields(work, { state: "review", updated: "2026-09-22" });
    const out = renderWorkDoc(work);
    expect(out).toContain("# owned by ops");
    expect(out).toContain("gate: human # keep");
    expect(out).toContain("state: review");
    expect(out.endsWith("\n# Title\n\nBody text\n")).toBe(true);
  });

  test("broken files are errors, not silent defaults", () => {
    expect(() => parseWorkDoc("no fence here")).toThrow(WorkFileError);
    expect(() => readContract(parseWorkDoc("---\nid: a\nstate: nope\ngate: human\n---\n"))).toThrow(WorkFileError);
    expect(() => readContract(parseWorkDoc("---\nstate: running\ngate: human\n---\n"))).toThrow(WorkFileError);
  });

  test("named checks keep timeout caps and the required flag", () => {
    const checks = readChecks([
      { name: "unit", run: "bun test", timeout_s: 5000 },
      { name: "lint", run: "biome ci", required: false },
    ]);
    expect(checks[0]).toEqual({ name: "unit", run: "bun test", timeoutS: 1800, required: true });
    expect(checks[1]).toEqual({ name: "lint", run: "biome ci", timeoutS: 600, required: false });
    expect(() => readChecks([{ name: "x" }])).toThrow(WorkFileError);
  });
});

describe("how runs start, as the work chose", () => {
  test("every run key round-trips; the file says it in plain keys", () => {
    const source = newWorkSource({
      ...base,
      run: {
        provider: "codex/gpt-5.5",
        isolation: "directory",
        modeId: "full-access",
        thinkingOptionId: "high",
        featureValues: { fast: true, plan: false, effort: "max", budget: 3, tier: null },
      },
    });
    expect(source).toContain("provider: codex/gpt-5.5\n");
    expect(source).toContain("isolation: directory\n");
    expect(source).toContain("mode: full-access\n");
    expect(source).toContain("thinking: high\n");
    const contract = readContract(parseWorkDoc(source));
    expect(contract).toMatchObject({
      provider: "codex/gpt-5.5",
      isolation: "directory",
      modeId: "full-access",
      thinkingOptionId: "high",
      featureValues: { fast: true, plan: false, effort: "max", budget: 3, tier: null },
    });
  });

  test("choices not made are not written, and read back as Settings (null)", () => {
    const source = newWorkSource({ ...base, run: { provider: " ", modeId: "", featureValues: {} } });
    for (const key of ["provider:", "isolation:", "mode:", "thinking:", "features:"]) {
      expect(source).not.toContain(key);
    }
    expect(readContract(parseWorkDoc(source))).toMatchObject({
      provider: null,
      isolation: null,
      modeId: null,
      thinkingOptionId: null,
      featureValues: null,
    });
    expect(readContract(parseWorkDoc(newWorkSource(base))).isolation).toBeNull();
  });

  test("a hand-edited isolation or features block that does not fit is an error, not a silent default", () => {
    const file = (extra: string) => `---\nid: a\nstate: proposed\ngate: human\n${extra}\n---\n`;
    expect(() => readContract(parseWorkDoc(file("isolation: sandbox")))).toThrow("unknown isolation");
    expect(readContract(parseWorkDoc(file("isolation: worktree"))).isolation).toBe("worktree");
    expect(() => readContract(parseWorkDoc(file("features: [fast]")))).toThrow("features must be a mapping");
    expect(() => readContract(parseWorkDoc(file("features:\n  fast:\n    on: true")))).toThrow("features.fast");
    expect(() => readFeatures({ when: new Date() })).toThrow(WorkFileError);
    expect(() => readFeatures("fast")).toThrow(WorkFileError);
    expect(() => readFeatures(new Date())).toThrow("features must be a mapping");
    expect(() => readFeatures({ budget: Number.POSITIVE_INFINITY })).toThrow("features.budget");
    expect(() => readFeatures({ budget: Number.NaN })).toThrow("features.budget");
    expect(() => readContract(parseWorkDoc(file("features:\n  budget: .inf")))).toThrow("features.budget");
    expect(readFeatures({})).toBeNull();
  });

  test("features are bounded: 32 values, 200 characters each", () => {
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, n) => [`f${n}`, true]));
    expect(() => readFeatures(many)).toThrow("at most 32");
    expect(readFeatures(Object.fromEntries(Object.entries(many).slice(0, 32)))).not.toBeNull();
    expect(() => readFeatures({ effort: "x".repeat(201) })).toThrow("longer than 200");
    expect(readFeatures({ effort: "x".repeat(200) })).toEqual({ effort: "x".repeat(200) });
    expect(() => readFeatures({ ["k".repeat(201)]: true })).toThrow("longer than 200");
  });
});

describe("the work's name", () => {
  test("a written title wins, on one line", () => {
    expect(workTitle("  Persist   run\ntranscripts ", "Something else")).toBe("Persist run transcripts");
  });

  test("a blank title takes the brief's first non-empty line, without a heading marker", () => {
    expect(workTitle("", "\n\n  Store the transcript on each run.\nDone when it renders.")).toBe(
      "Store the transcript on each run.",
    );
    expect(workTitle(undefined, "## Trim the cache\nbody")).toBe("Trim the cache");
    expect(workTitle("   ", "#hashtag first")).toBe("#hashtag first");
  });

  test("a long first line is clipped at a word, near the limit", () => {
    const line = `${"word ".repeat(40)}end`;
    const title = workTitle("", line) ?? "";
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(title.endsWith("word\u2026")).toBe(true);
    // A space too early to cut at would leave a stub: the line is cut hard instead.
    expect(workTitle("", `a ${"x".repeat(200)}`)).toBe(`a ${"x".repeat(TITLE_MAX - 3)}\u2026`);
    const unbroken = "x".repeat(200);
    expect(workTitle("", unbroken)).toBe(`${"x".repeat(TITLE_MAX - 1)}\u2026`);
    expect(workTitle("", "x".repeat(TITLE_MAX))).toBe("x".repeat(TITLE_MAX));
  });

  test("nothing to name it by is null", () => {
    expect(workTitle("", "")).toBeNull();
    expect(workTitle("  ", " \n\t\n # \n")).toBeNull();
  });
});
