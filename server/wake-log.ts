// The loop's wake log: one JSON line per wake (shared/contracts.ts
// WakeEntry), in `wake-log.jsonl` beside the config (server/paths.ts). It is
// the loop's receipt, and where it reads its cadence back after a restart.
//
// A torn or garbage line is skipped with a warning, never fatal. The file is
// bounded: past WAKE_LOG_MAX lines it is rewritten, through a temporary file
// and a rename, to the newest WAKE_LOG_KEEP entries. Appends in this process
// run one at a time, so a trim never drops one; a second process writing the
// same file (a second daemon on the same config) can lose an entry to a trim.

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type WakeEntry, WakeEntrySchema } from "../shared/contracts";
import { wakeLogPath } from "./paths";
import { endsWithNewline } from "./store";

/** Lines the file may hold before it is trimmed. */
export const WAKE_LOG_MAX = 1000;
/** Entries a trim keeps, the newest. */
export const WAKE_LOG_KEEP = 500;

export class WakeLog {
  private chain: Promise<unknown> = Promise.resolve();
  /** The unreadable-line count last warned about, so a poll does not repeat the same warning. */
  private warned = 0;

  constructor(
    readonly path: string = wakeLogPath(),
    private readonly log: (message: string) => void = (message) => console.log(`[maestro] ${message}`),
  ) {}

  /** Every entry that reads, oldest first, and how many lines the file holds. */
  private async readAll(): Promise<{ entries: WakeEntry[]; lines: number }> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], lines: 0 };
      throw error;
    }
    const entries: WakeEntry[] = [];
    let lines = 0;
    let bad = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      lines += 1;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        bad += 1;
        continue;
      }
      const parsed = WakeEntrySchema.safeParse(value);
      if (parsed.success) entries.push(parsed.data);
      else bad += 1;
    }
    if (bad > 0 && bad !== this.warned) this.log(`${this.path}: skipped ${bad} unreadable line(s)`);
    this.warned = bad;
    return { entries, lines };
  }

  /** The newest `limit` entries, newest first. */
  async recent(limit: number): Promise<WakeEntry[]> {
    const { entries } = await this.readAll();
    return entries.slice(-limit).reverse();
  }

  /** The newest wake that ran (not one skipped because another was running), or null. */
  async lastRun(): Promise<WakeEntry | null> {
    const { entries } = await this.readAll();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry && entry.skipped === undefined) return entry;
    }
    return null;
  }

  /** Add one entry; appends in this process run in order, one at a time. */
  append(entry: WakeEntry): Promise<void> {
    const next = this.chain.catch(() => undefined).then(() => this.appendNow(entry));
    this.chain = next;
    return next;
  }

  private async appendNow(entry: WakeEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const lead = (await endsWithNewline(this.path)) ? "" : "\n";
    await appendFile(this.path, `${lead}${JSON.stringify(entry)}\n`, "utf8");
    const { entries, lines } = await this.readAll();
    if (lines <= WAKE_LOG_MAX) return;
    const kept = entries.slice(-WAKE_LOG_KEEP);
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, kept.map((one) => `${JSON.stringify(one)}\n`).join(""), "utf8");
    await rename(tmp, this.path);
  }
}
