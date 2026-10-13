// The one appender of Maestro's JSON-lines ledgers (BRO-2997; the torn-line repair is BRO-2999). Every line is added
// under the file's lock (server/locks.ts), so two daemons, or a daemon and its second plugin process, never
// interleave: a record is whole lines, in one write.
//
// A process that died mid-append leaves a partial last line, and the next append would join it, so a good record is
// lost with the bad one. A file that does not end in a newline gets one first, so the torn fragment stays a line of
// its own, which readers skip.

import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileLock } from "./locks";
import { lockRootBeside } from "./paths";

export interface AppendOptions {
  /** The file's mode when it is made (0o600 for a ledger that holds your words). */
  mode?: number;
  /** The folder's mode when it is made. */
  dirMode?: number;
  /** Flush to disk before returning: a verdict that must survive a crash. */
  sync?: boolean;
  /**
   * The file is one the fleet's sessions could have replaced: never followed as a link, one hard link only,
   * and a regular file. A path that is not is refused, not written through.
   */
  guarded?: boolean;
  /** Where the lock lives: beside the file unless given. */
  lockRoot?: string;
}

/**
 * Appends whole lines, all or none: a short write is taken back out. The caller holds the file's lock, or another
 * that covers it (the work store appends under its item's lock); a caller with none uses appendJsonLines.
 */
export async function appendLinesLocked(
  path: string,
  records: readonly unknown[],
  options: AppendOptions = {},
): Promise<void> {
  if (records.length === 0) return;
  const flags =
    constants.O_RDWR |
    constants.O_APPEND |
    constants.O_CREAT |
    constants.O_NONBLOCK |
    (options.guarded ? constants.O_NOFOLLOW : 0);
  const handle = await open(path, flags, options.mode ?? 0o644);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${path} is not a regular file`);
    if (options.guarded && info.nlink > 1) throw new Error(`${path} has another hard link`);
    let lead = "";
    if (info.size > 0) {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, info.size - 1);
      lead = last[0] === 0x0a ? "" : "\n";
    }
    const lines = Buffer.from(`${lead}${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    try {
      const { bytesWritten } = await handle.write(lines);
      if (bytesWritten !== lines.length) throw new Error(`wrote ${bytesWritten} of ${lines.length} bytes`);
      if (options.sync) await handle.sync();
    } catch (error) {
      await handle.truncate(info.size).catch(() => undefined);
      throw error;
    }
  } finally {
    await handle.close();
  }
}

/** Appends whole lines under the file's own lock (beside it unless given). */
export async function appendJsonLines(
  path: string,
  records: readonly unknown[],
  options: AppendOptions = {},
): Promise<void> {
  if (records.length === 0) return;
  await mkdir(dirname(path), { recursive: true, ...(options.dirMode ? { mode: options.dirMode } : {}) });
  await withFileLock(path, options.lockRoot ?? lockRootBeside(path), () => appendLinesLocked(path, records, options), {
    what: "this ledger",
  });
}

export function appendJsonLine(path: string, record: unknown, options: AppendOptions = {}): Promise<void> {
  return appendJsonLines(path, [record], options);
}
