// What you snoozed in Health (BRO-3036): `notice.snooze` quiets one notice for a few hours. A snooze is a line in
// an append-only file, `{ key, until, at }`; the newest line for a key wins, and one whose time is up is simply
// past. A read never writes (BRO-2995): the file is only read here, and only the verb, when its undo window
// closes, appends.

import { readFile } from "node:fs/promises";
import { appendJsonLine } from "./jsonl";

export class NoticeSnoozes {
  constructor(private readonly path: string) {}

  /** Every key snoozed, until when (ISO); a key's newest line wins. A file that is missing or torn reads as less. */
  async read(): Promise<Map<string, string>> {
    const text = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const out = new Map<string, string>();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { key?: unknown; until?: unknown };
        if (typeof row.key === "string" && typeof row.until === "string") out.set(row.key, row.until);
      } catch {
        // A torn line is skipped, as every log here.
      }
    }
    return out;
  }

  /** Quiet `key` until `until`. */
  async snooze(key: string, until: Date, now: Date): Promise<void> {
    await appendJsonLine(this.path, { key, until: until.toISOString(), at: now.toISOString() });
  }
}
