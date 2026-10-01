import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_READ_BYTES } from "../shared/records";
import { listFiles, readText, unsafeName } from "./files";

let root = "";
let folder = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "maestro-files-"));
  folder = join(root, "hawthorne", "persist-run-transcripts");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "_work.md"), "---\nid: w1\n---\n# Persist run transcripts\n");
  await writeFile(join(folder, "notes.md"), "Decided: store it on the Run record.\n");
  await writeFile(join(folder, ".secret"), "hidden\n");
  await writeFile(join(folder, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]));
  await writeFile(join(folder, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  await writeFile(join(folder, "big.log"), "a".repeat(FILE_READ_BYTES + 5_000));
  await writeFile(join(folder, "empty.txt"), "");
  await mkdir(join(folder, "sub"));
  await writeFile(join(folder, "sub", "inner.md"), "inside a subfolder\n");
  await writeFile(join(root, "outside.txt"), "a file outside the work folder\n");
  await symlink(join(root, "outside.txt"), join(folder, "escape.txt"));
  await symlink(join(folder, "notes.md"), join(folder, "alias.md"));
  await symlink(join(folder, "missing.md"), join(folder, "dangling.md"));
  // A sibling whose name starts with this folder's: a bare prefix check would take it for inside.
  await mkdir(`${folder}-2`);
  await writeFile(join(`${folder}-2`, "secret.md"), "the next work's notes\n");
  await symlink(join(`${folder}-2`, "secret.md"), join(folder, "prefix.md"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("a work folder that leads outside the work root", () => {
  test("is refused, whether the item folder is a symlink or sits under one", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "maestro-elsewhere-"));
    try {
      await writeFile(join(elsewhere, "ssh-key"), "not for Maestro\n");
      const linked = join(root, "hawthorne", "linked-work");
      await symlink(elsewhere, linked);
      await expect(listFiles(root, linked)).rejects.toThrow("outside the work root");
      await expect(readText(root, linked, "ssh-key")).rejects.toThrow("outside the work root");
      const parent = join(root, "linked-initiative");
      await symlink(elsewhere, parent);
      await expect(listFiles(root, parent)).rejects.toThrow("outside the work root");
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("the files in a work folder", () => {
  test("lists the plain files directly in it: no hidden files, subfolders or links out of it", async () => {
    const files = await listFiles(root, folder);
    expect(files.map((file) => file.name)).toEqual([
      "_work.md",
      "alias.md",
      "big.log",
      "empty.txt",
      "image.png",
      "latin1.txt",
      "notes.md",
    ]);
    const notes = files.find((file) => file.name === "notes.md");
    expect(notes?.size).toBe(37);
    expect(Number.isNaN(Date.parse(notes?.mtime ?? ""))).toBe(false);
  });

  test("reads a text file", async () => {
    expect(await readText(root, folder, "notes.md")).toEqual({
      name: "notes.md",
      text: "Decided: store it on the Run record.\n",
      truncated: false,
    });
    expect((await readText(root, folder, "empty.txt")).text).toBe("");
  });

  test("a link that stays inside the folder is read", async () => {
    expect((await readText(root, folder, "alias.md")).text).toContain("Run record");
  });
});

describe("path safety", () => {
  test.each([
    ["../outside.txt", "not a path"],
    ["..", "'..'"],
    ["a..b", "'..'"],
    ["sub/inner.md", "not a path"],
    ["sub\\inner.md", "not a path"],
    ["/etc/passwd", "not a path"],
    [".secret", "Hidden"],
    ["notes.md\0.png", "NUL"],
    ["", "1 to 255"],
    ["x".repeat(256), "1 to 255"],
  ])("refuses %p", async (name, why) => {
    expect(unsafeName(name)).toContain(why);
    await expect(readText(root, folder, name)).rejects.toThrow(why);
  });

  test("a symlink that leads out of the folder is refused, not read", async () => {
    await expect(readText(root, folder, "escape.txt")).rejects.toThrow("points outside the work folder");
    await expect(readText(root, folder, "prefix.md")).rejects.toThrow("points outside the work folder");
  });

  test("a folder is not a file, and a missing or dangling name says so", async () => {
    await expect(readText(root, folder, "sub")).rejects.toThrow("is not a file");
    await expect(readText(root, folder, "nope.md")).rejects.toThrow("No file named nope.md");
    await expect(readText(root, folder, "dangling.md")).rejects.toThrow("No file named dangling.md");
  });

  test("a plain name is fine", () => {
    expect(unsafeName("_events.jsonl")).toBeNull();
    expect(unsafeName("notes.v2.md")).toBeNull();
  });
});

describe("text only, and only so much of it", () => {
  test("a file with a NUL byte is binary, and refused", async () => {
    await expect(readText(root, folder, "image.png")).rejects.toThrow("binary");
  });

  test("bytes that are not UTF-8 are refused", async () => {
    await expect(readText(root, folder, "latin1.txt")).rejects.toThrow("not UTF-8");
  });

  test("a file over 64 KB is cut at 64 KB and says so", async () => {
    const read = await readText(root, folder, "big.log");
    expect(read.truncated).toBe(true);
    expect(read.text).toHaveLength(FILE_READ_BYTES);
  });

  test("a cut through a multi-byte character drops the partial character instead of refusing the file", async () => {
    // Two ASCII bytes, then U+10348 (four bytes each): a 9-byte cut lands inside the second one.
    const name = "wide.txt";
    await writeFile(join(folder, name), `ab${"\u{10348}".repeat(10)}`);
    const read = await readText(root, folder, name, 9);
    expect(read.truncated).toBe(true);
    expect(read.text).toBe("ab\u{10348}");
    await rm(join(folder, name));
  });
});
