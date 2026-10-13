import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newWorkSource } from "./frontmatter";
import { WorkStore } from "./store";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "maestro-store-"));
  roots.push(dir);
  const work = join(dir, "work");
  return { dir, work };
}
const input = (title: string, repo: string) => ({
  title,
  brief: "",
  repo,
  gate: "human" as const,
  check: "",
  initiative: "",
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const note = (text: string) => ({
  ts: new Date().toISOString(),
  type: "note" as const,
  actor: "maestro" as const,
  text,
});

describe("two stores on one work root (two daemons)", () => {
  test("changes to one item from both are each seen by the next: no receipt repeats the count it read", async () => {
    const { dir, work } = await setup();
    const a = new WorkStore(work);
    const b = new WorkStore(work);
    const made = await a.create(input("Shared", dir));
    const id = made.contract.id;
    const writes = [a, b].flatMap((store, side) =>
      Array.from({ length: 20 }, () =>
        store.mutate(id, async (item) => {
          await sleep(1);
          return { events: [note(`${side}:${item.events.length}`)], patch: { updated: "2026-10-13" } };
        }),
      ),
    );
    await Promise.all(writes);
    const item = await a.fresh(id, made.dir);
    const counts = item.events
      .filter((e) => e.type === "note")
      .map((e) => Number((e as { text: string }).text.split(":")[1]));
    expect(counts).toEqual(Array.from({ length: 40 }, (_, n) => n + 1));
    expect(item.badLines).toBe(0);
  });

  test("a read waits for a change in flight in the other store: it never pairs the new state with the old receipts", async () => {
    const { dir, work } = await setup();
    const a = new WorkStore(work);
    const b = new WorkStore(work);
    const made = await a.create(input("Pair", dir));
    const change = a.mutate(made.contract.id, async () => {
      await sleep(300);
      return { to: "reviewing" as const, reason: "go", events: [note("paired")] };
    });
    await sleep(100);
    const read = await b.load(made.dir);
    await change;
    // The change had begun and was not done when the read began: the read is of after it, state and receipts alike.
    expect([read.contract.state, read.events.map((e) => e.type)]).toEqual(["reviewing", ["created", "note", "state"]]);
  });

  test("two stores filing one title each get a folder of their own", async () => {
    const { dir, work } = await setup();
    const made = await Promise.all(
      [new WorkStore(work), new WorkStore(work)].flatMap((store) =>
        Array.from({ length: 4 }, () => store.create(input("Same title", dir))),
      ),
    );
    expect(new Set(made.map((item) => item.dir)).size).toBe(8);
    expect((await readdir(work)).sort()).toEqual(
      [".locks", "same-title", ...Array.from({ length: 7 }, (_, n) => `same-title-${n + 2}`)].sort(),
    );
    for (const item of made) expect((await readdir(item.dir)).sort()).toEqual(["_events.jsonl", "_work.md"]);
    expect((await new WorkStore(work).scan()).warnings).toEqual([]);
  });

  test("the lock folder is gone when the last writer is done, and a work item is only its two files", async () => {
    const { dir, work } = await setup();
    const store = new WorkStore(work);
    const made = await store.create(input("Clean", dir));
    await store.mutate(made.contract.id, () => ({ events: [note("x")] }));
    expect((await readdir(work)).sort()).toEqual([".locks", "clean"]);
    expect(await readdir(join(work, ".locks"))).toEqual([]);
  });
});

describe("a work folder written before the locks and the atomic writes still reads", () => {
  /** The live format: a contract with a body, receipts one JSON object a line, the last one torn by a crash. */
  async function legacy(work: string, repo: string) {
    const folder = join(work, "hawthorne", "old-item");
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "_work.md"),
      newWorkSource({
        id: "6f0d3f3a-0000-4000-8000-000000000001",
        title: "Old item",
        brief: "Written by an earlier Maestro.",
        kind: "task",
        state: "proposed",
        gate: "human",
        repo,
        check: "",
        date: "2026-09-01",
      }),
    );
    await writeFile(
      join(folder, "_events.jsonl"),
      `${JSON.stringify({ ts: "2026-09-01T10:00:00.000Z", type: "created", actor: "human" })}\n{"ts":"2026-09-01T10:05:00.000Z","type":"note","actor":"mae`,
    );
    return folder;
  }

  test("it is listed, with the torn receipt counted and skipped; the next change lands on a line of its own", async () => {
    const { dir, work } = await setup();
    const folder = await legacy(work, dir);
    const store = new WorkStore(work);
    const { items, warnings } = await store.scan();
    expect(items).toHaveLength(1);
    expect(items[0]?.contract.id).toBe("6f0d3f3a-0000-4000-8000-000000000001");
    expect(items[0]?.badLines).toBe(1);
    expect(warnings).toEqual(["hawthorne/old-item/_events.jsonl: 1 unreadable line(s) skipped"]);
    await store.mutate("6f0d3f3a-0000-4000-8000-000000000001", () => ({
      to: "reviewing",
      reason: "r",
      events: [note("after")],
    }));
    const lines = (await readFile(join(folder, "_events.jsonl"), "utf8")).split("\n").filter(Boolean);
    expect(lines).toHaveLength(4);
    expect(
      lines.map((line) => {
        try {
          return (JSON.parse(line) as { type: string }).type;
        } catch {
          return "torn";
        }
      }),
    ).toEqual(["created", "torn", "note", "state"]);
    expect((await store.scan()).items[0]?.contract.state).toBe("reviewing");
    expect((await readdir(folder)).sort()).toEqual(["_events.jsonl", "_work.md"]);
  });
});
