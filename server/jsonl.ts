// Append one JSON line to a log file that a crash may have torn (BRO-2999): a process that died mid-append leaves a
// partial last line, and the next append would join it, so a good record is lost with the bad one. A file that does
// not end in a newline gets one first, so the torn fragment stays a line of its own, which readers skip.

import { appendFile, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

/** Whether the file is empty or missing, or ends in a newline. */
async function endsClean(path: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    await handle.close();
  }
}

export async function appendJsonLine(path: string, record: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const lead = (await endsClean(path)) ? "" : "\n";
  await appendFile(path, `${lead}${JSON.stringify(record)}\n`);
}
