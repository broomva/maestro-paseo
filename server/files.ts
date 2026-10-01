// The files directly in one work folder, and reading one of them as text.
// Read-only, and strict about paths: a name is one plain path segment, and
// what it resolves to must still be inside the folder once every symlink is
// followed. A symlink that leads out of the folder is refused, never read.

import { constants } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { FILE_READ_BYTES, type WorkFile } from "../shared/records";
import { UserError } from "./engine";

const MAX_NAME = 255;

/** Why `name` is not one plain file name in the folder, or null when it is. */
export function unsafeName(name: string): string | null {
  if (!name || name.length > MAX_NAME) return "A file name is 1 to 255 characters.";
  if (name.includes("\0")) return "A file name cannot hold a NUL byte.";
  if (name.includes("/") || name.includes("\\")) return "Name one file in the work folder, not a path.";
  if (name.includes("..")) return "A file name cannot contain '..'.";
  if (name.startsWith(".")) return "Hidden files are not shown.";
  return null;
}

/** `path` is `folder` itself or somewhere under it. Both are real paths. */
function inside(folder: string, path: string): boolean {
  return path.startsWith(folder.endsWith(sep) ? folder : folder + sep);
}

/**
 * The file `name` in `dir`, resolved through any symlink, or a refusal. The
 * returned path has no symlinks left in it, so what is opened is what was checked.
 */
async function resolveIn(dir: string, name: string): Promise<{ folder: string; path: string }> {
  const problem = unsafeName(name);
  if (problem) throw new UserError(problem);
  const folder = await realpath(dir);
  let path: string;
  try {
    path = await realpath(join(folder, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new UserError(`No file named ${name} in this work.`);
    throw error;
  }
  if (!inside(folder, path)) throw new UserError(`${name} points outside the work folder, so it is not read.`);
  return { folder, path };
}

/** The regular files directly in `dir`, by name. Hidden files and links out of the folder are left out. */
export async function listFiles(dir: string): Promise<WorkFile[]> {
  const folder = await realpath(dir);
  const entries = await readdir(folder, { withFileTypes: true });
  const files: WorkFile[] = [];
  for (const entry of entries) {
    if (!(entry.isFile() || entry.isSymbolicLink()) || unsafeName(entry.name)) continue;
    try {
      const path = await realpath(join(folder, entry.name));
      if (!inside(folder, path)) continue;
      const info = await stat(path);
      if (!info.isFile()) continue;
      files.push({ name: entry.name, size: info.size, mtime: info.mtime.toISOString() });
    } catch {
      // A dangling link or a file removed while listing: not a file to show.
    }
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/** Drops a multi-byte UTF-8 sequence cut off at the end of `bytes`. */
function wholeCharacters(bytes: Uint8Array): Uint8Array {
  let start = bytes.length - 1;
  // Walk back over continuation bytes (10xxxxxx) to the lead byte of the last character.
  while (start >= 0 && start > bytes.length - 4 && ((bytes[start] ?? 0) & 0xc0) === 0x80) start -= 1;
  if (start < 0) return bytes;
  const lead = bytes[start] ?? 0;
  const needs = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return bytes.length - start < needs ? bytes.subarray(0, start) : bytes;
}

/**
 * Reads `name` in `dir` as UTF-8 text, up to FILE_READ_BYTES. A file with a
 * NUL byte or bytes that are not UTF-8 is binary, and refused.
 */
export async function readText(
  dir: string,
  name: string,
  limit: number = FILE_READ_BYTES,
): Promise<{ name: string; text: string; truncated: boolean }> {
  const { path } = await resolveIn(dir, name);
  // O_NOFOLLOW: if the last segment was swapped for a symlink since it was checked, the open fails.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new UserError(`${name} changed while it was read.`);
    throw error;
  });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new UserError(`${name} is not a file.`);
    const buffer = Buffer.alloc(Math.min(limit, info.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const truncated = info.size > bytesRead;
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) throw new UserError(`${name} is a binary file, so it is not shown.`);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(truncated ? wholeCharacters(bytes) : bytes);
    } catch {
      throw new UserError(`${name} is not UTF-8 text, so it is not shown.`);
    }
    return { name, text, truncated };
  } finally {
    await handle.close();
  }
}
