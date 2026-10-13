// Two processes on one store (BRO-2997, BRO-3080). The in-process tests cannot show a second daemon: this spawns two
// bun processes on one work root and one set of ledgers, starts them together, and reads back what is on disk.
//
// Each holds only what a daemon would: the work store, the JSON-lines appender, the owner-verb ledger. The lock is
// the one thing between them, so each test fails when it is taken out.

import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEvents } from "./events";
import { WorkStore } from "./store";

const WORKER = join(import.meta.dir, "testdata", "store-worker.ts");
const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "maestro-mp-"));
  roots.push(dir);
  return dir;
}

/** Runs the workers together: all are started, then released at once. Resolves when every one has exited. */
async function together(workers: string[][], go: string): Promise<void> {
  const exits = workers.map(
    (args) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [WORKER, ...args], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`worker ${args[0]} exited ${code}: ${stderr}`)),
        );
      }),
  );
  // Let each one load its modules and reach the barrier.
  await new Promise((resolve) => setTimeout(resolve, 600));
  await writeFile(go, "go");
  await Promise.all(exits);
}

const lines = async (path: string) => (await readFile(path, "utf8")).split("\n").filter(Boolean);

describe("two processes on one work item", () => {
  test("every change is seen by the next: no receipt repeats a count, none is lost, nothing is torn", async () => {
    const dir = await root();
    const work = join(dir, "work");
    const store = new WorkStore(work);
    const made = await store.create({
      title: "Shared",
      brief: "",
      repo: dir,
      gate: "human",
      check: "",
      initiative: "",
    });
    const id = made.contract.id;
    const each = 25;
    const go = join(dir, "go");
    await together(
      [
        ["events", work, id, String(each), "a", go],
        ["events", work, id, String(each), "b", go],
      ],
      go,
    );
    const item = await store.fresh(id, made.dir);
    const { events, bad } = parseEvents(await readFile(join(made.dir, "_events.jsonl"), "utf8"));
    expect(bad).toBe(0);
    const counts = events
      .filter((e) => e.type === "note")
      .map((e) => Number((e as { text: string }).text.split(":")[1]));
    // The created receipt is first, so the counts read 1, 2, 3 ... 2 * each, each once, in order.
    expect(counts).toEqual(Array.from({ length: 2 * each }, (_, n) => n + 1));
    expect(item.contract.id).toBe(id);
    // No temp file and no lock is left: the item is its two files, and the folder of locks is empty.
    expect((await readdir(made.dir)).sort()).toEqual(["_events.jsonl", "_work.md"]);
    expect((await readdir(work)).sort()).toEqual([".locks", made.rel]);
    expect(await readdir(join(work, ".locks"))).toEqual([]);
  }, 60_000);

  test("two processes filing one title each get a folder of their own: none is overwritten", async () => {
    const dir = await root();
    const work = join(dir, "work");
    const go = join(dir, "go");
    await together(
      [
        ["create", work, "8", "a", go],
        ["create", work, "8", "b", go],
      ],
      go,
    );
    const { items, warnings } = await new WorkStore(work).scan();
    expect(warnings).toEqual([]);
    expect(items).toHaveLength(16);
    expect(new Set(items.map((item) => item.contract.id)).size).toBe(16);
    expect(items.every((item) => item.events.length === 1 && item.badLines === 0)).toBe(true);
    expect(new Set(items.map((item) => item.work.body.match(/[ab] \d/)?.[0])).size).toBe(16);
  }, 60_000);
});

describe("two processes on one ledger", () => {
  for (const mode of ["ledger", "receipts"] as const) {
    test(`${mode}: every line is whole, in one piece, and none is lost (lines of 6 KB, past one write)`, async () => {
      const dir = await root();
      const path = join(dir, "state", "log.jsonl");
      const go = join(dir, "go");
      const each = 60;
      await together(
        [
          [mode, path, String(each), "a", go],
          [mode, path, String(each), "b", go],
        ],
        go,
      );
      const rows = (await lines(path)).map((line) => JSON.parse(line) as { tag: string; i: number; pad: string });
      expect(rows).toHaveLength(2 * each);
      for (const tag of ["a", "b"]) {
        expect(rows.filter((row) => row.tag === tag).map((row) => row.i)).toEqual(
          Array.from({ length: each }, (_, n) => n),
        );
      }
      expect(rows.every((row) => row.pad.length === 6000)).toBe(true);
      expect((await readdir(join(dir, "state"))).sort()).toEqual([".locks", "log.jsonl"]);
      expect(await readdir(join(dir, "state", ".locks"))).toEqual([]);
    }, 60_000);
  }
});

describe("two processes on the wake log, which rewrites itself", () => {
  test("a trim by one never drops an entry the other has just added: each one's survivors have no gap", async () => {
    const dir = await root();
    const path = join(dir, "wake-log.jsonl");
    const go = join(dir, "go");
    const each = 900;
    await together(
      [
        ["wake", path, String(each), "a", go],
        ["wake", path, String(each), "b", go],
      ],
      go,
    );
    const ids = (await lines(path)).map((line) => (JSON.parse(line) as { tickId: string }).tickId);
    expect(ids.length).toBeLessThanOrEqual(1000);
    for (const tag of ["a", "b"]) {
      const mine = ids.filter((id) => id.startsWith(tag)).map((id) => Number(id.slice(1)));
      // A trim keeps the newest, so one writer may have none left; what is left of a writer's is one unbroken run, in
      // order. An entry another process's trim dropped from the middle would leave a gap.
      const first = mine[0] ?? 0;
      expect(mine).toEqual(Array.from({ length: mine.length }, (_, n) => first + n));
    }
    expect(ids.length).toBeGreaterThan(0);
    expect((await readdir(dir)).sort()).toEqual([".locks", "go", "wake-log.jsonl"]);
    expect(await readdir(join(dir, ".locks"))).toEqual([]);
  }, 120_000);
});

describe("two processes reading one owner-verb ledger (BRO-3080)", () => {
  test("a verb due in both is applied once, by one of them, and settled once", async () => {
    const dir = await root();
    const path = join(dir, "verbs.jsonl");
    const log = join(dir, "applied.log");
    const go = join(dir, "go");
    const verbs = 12;
    const past = new Date(Date.now() - 60_000).toISOString();
    const pending = Array.from({ length: verbs }, (_, n) => ({
      kind: "verb.pending",
      receipt: `r-${n}`,
      verb: "work.cancel",
      key: `work:${n}`,
      label: `Cancel ${n}`,
      at: past,
      appliesAt: past,
      args: {},
    }));
    await writeFile(path, `${pending.map((line) => JSON.stringify(line)).join("\n")}\n`);
    await writeFile(log, "");
    await together(
      [
        ["verbs", path, log, go],
        ["verbs", path, log, go],
      ],
      go,
    );
    const applied = (await lines(log)).map((line) => line.split(" ")[1]);
    expect(applied.sort()).toEqual(Array.from({ length: verbs }, (_, n) => `r-${n}`).sort());
    const ledger = (await lines(path)).map(
      (line) => JSON.parse(line) as { kind: string; receipt: string; pid?: number },
    );
    const settled = ledger.filter((line) => line.kind === "verb.applied");
    expect(settled.map((line) => line.receipt).sort()).toEqual(applied.sort());
    expect(ledger.filter((line) => line.kind === "verb.dropped")).toEqual([]);
    // Each was claimed once, by the process that applied it, and that is one of the two.
    const claims = ledger.filter((line) => line.kind === "verb.claimed");
    expect(claims.map((line) => line.receipt).sort()).toEqual(applied.sort());
    expect(new Set(claims.map((line) => line.pid)).size).toBeGreaterThanOrEqual(1);
    expect(await readdir(dir).then((names) => names.sort())).toEqual([".locks", "applied.log", "go", "verbs.jsonl"]);
    expect(await readdir(join(dir, ".locks"))).toEqual([]);
  }, 60_000);

  test("a claimant that died is not applied again: the verb settles as dropped, saying it is not known", async () => {
    const dir = await root();
    const path = join(dir, "verbs.jsonl");
    const log = join(dir, "applied.log");
    const go = join(dir, "go");
    const past = new Date(Date.now() - 60_000).toISOString();
    const pending = {
      kind: "verb.pending",
      receipt: "r-dead",
      verb: "work.cancel",
      key: "work:x",
      label: "Cancel x",
      at: past,
      appliesAt: past,
      args: {},
    };
    const claim = { kind: "verb.claimed", receipt: "r-dead", at: past, pid: 999999, start: 1 };
    await writeFile(path, `${JSON.stringify(pending)}\n${JSON.stringify(claim)}\n`);
    await writeFile(log, "");
    await together([["verbs", path, log, go]], go);
    expect(await lines(log)).toEqual([]);
    const ledger = (await lines(path)).map((line) => JSON.parse(line) as { kind: string; detail?: string });
    expect(ledger.at(-1)).toMatchObject({ kind: "verb.dropped", detail: expect.stringContaining("not known") });
  }, 60_000);
});
