import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paseoLabel, workLabels } from "./labels";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** Runs `run` with a fake `paseo` first on PATH that records its arguments, one per line. */
async function withFakePaseo(run: (argsFile: string) => Promise<void>, exit = 0): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "maestro-labels-"));
  roots.push(dir);
  const argsFile = join(dir, "args");
  const bin = join(dir, "paseo");
  await writeFile(bin, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${argsFile}"; done\nexit ${exit}\n`);
  await chmod(bin, 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${dir}:${before}`;
  try {
    await run(argsFile);
  } finally {
    process.env.PATH = before;
  }
}

describe("labelling a session through the paseo CLI (BRO-2908)", () => {
  test("one --label per key, as key=value", async () => {
    await withFakePaseo(async (argsFile) => {
      await paseoLabel("agent-9", workLabels({ id: "w1", ticket: "BRO-2908", parentWork: "w0" }));
      expect((await readFile(argsFile, "utf8")).trim().split("\n")).toEqual([
        "agent",
        "update",
        "agent-9",
        "--label",
        "maestro.work=w1",
        "--label",
        "ticket=BRO-2908",
        "--label",
        "maestro.parent-work=w0",
      ]);
    });
  });

  test("a value the CLI would split on its commas is refused before anything runs; a failed call rejects", async () => {
    await withFakePaseo(async (argsFile) => {
      await expect(paseoLabel("agent-9", { ticket: "BRO-1,maestro.work=hijacked" })).rejects.toThrow("comma");
      expect(await readFile(argsFile, "utf8").catch(() => "")).toBe("");
    });
    await withFakePaseo(async () => {
      await expect(paseoLabel("agent-9", { "maestro.work": "w1" })).rejects.toThrow();
    }, 1);
  });

  test("only the labels it has a value for", () => {
    expect(workLabels({ id: "w1", ticket: null, parentWork: null })).toEqual({ "maestro.work": "w1" });
  });
});
