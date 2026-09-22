import { describe, expect, test } from "bun:test";
import {
  briefOf,
  newWorkSource,
  parseWorkDoc,
  readChecks,
  readContract,
  renderWorkDoc,
  setFields,
  titleOf,
  WorkFileError,
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
