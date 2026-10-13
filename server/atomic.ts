// The one way Maestro replaces a whole file (BRO-2997): the new content goes to a temp file beside it, flushed, then
// renamed over it, so a reader, a crash or a second daemon sees the old file or the new one and never half of
// either. The temp file is named for its writer, and removed if the write fails.

import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeFileAtomic(
  path: string,
  content: string | Uint8Array,
  options: { mode?: number; dirMode?: number } = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, ...(options.dirMode ? { mode: options.dirMode } : {}) });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const handle = await open(temp, "wx", options.mode ?? 0o644);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
