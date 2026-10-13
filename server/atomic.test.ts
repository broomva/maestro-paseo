import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});
async function root() {
  const dir = await mkdtemp(join(tmpdir(), "maestro-atomic-"));
  roots.push(dir);
  return dir;
}

describe("writeFileAtomic", () => {
  test("a reader sees the old file or the new one, never a part of either, while it is replaced again and again", async () => {
    const dir = await root();
    const path = join(dir, "file.txt");
    const size = 4 * 1024 * 1024;
    const old = "A".repeat(size);
    const fresh = "B".repeat(size);
    await writeFile(path, old);
    let writing = true;
    const writer = (async () => {
      for (let n = 0; n < 12; n += 1) await writeFileAtomic(path, n % 2 === 0 ? fresh : old);
      writing = false;
    })();
    const seen = new Set<number>();
    let reads = 0;
    while (writing) {
      const text = await readFile(path, "utf8");
      reads += 1;
      // Whole, and one letter throughout.
      seen.add(text.length);
      expect(text === old || text === fresh).toBe(true);
    }
    await writer;
    expect(reads).toBeGreaterThan(0);
    expect([...seen]).toEqual([size]);
  }, 60_000);

  test("a write that fails leaves the file as it was and no temp file beside it", async () => {
    const dir = await root();
    // The target is a folder: the rename cannot replace it.
    await mkdir(join(dir, "target"));
    await writeFile(join(dir, "target", "keep"), "kept");
    await expect(writeFileAtomic(join(dir, "target"), "new")).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["target"]);
    expect(await readFile(join(dir, "target", "keep"), "utf8")).toBe("kept");
  });

  test("it makes the folder, keeps the mode asked for, and leaves one file", async () => {
    const dir = await root();
    const path = join(dir, "a", "b", "file.json");
    await writeFileAtomic(path, "{}\n", { mode: 0o600, dirMode: 0o700 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(dir, "a", "b"))).toEqual(["file.json"]);
  });
});
