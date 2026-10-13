// The one writer of the fleet's `proposal-reviews.jsonl` (BRO-2997): your verdicts on its proposals (server/fleet.ts
// decides what may be recorded; this writes it). The fleet CLI has no verb for a verdict yet (BRO-3098), so Maestro
// writes the file itself, and only here: under the ask ledgers' lock root, one hard link and never a followed link
// (the fleet's sessions can write the state dir), all lines or none, flushed before it says so.

import { appendJsonLines } from "./jsonl";

export function appendReviews(path: string, records: readonly object[], lockRoot: string): Promise<void> {
  return appendJsonLines(path, records, { mode: 0o600, sync: true, guarded: true, lockRoot });
}
