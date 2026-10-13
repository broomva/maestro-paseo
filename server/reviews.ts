// Your answers to due initiative reviews (B2, J8, BRO-3036). An answer is a receipt line in the asks' receipt log
// (`initiative.reviewed`, written when its undo window closes): the initiative, the review date it answers, what
// you chose and your words. Maestro never edits an initiative file (A8): the conductor and the owner's own
// tooling read the receipt and move the file. A review whose answer is on record is not due any more, until its
// review date moves (a new date is a new review).

import { readFile } from "node:fs/promises";
import type { ReviewAnswer } from "../shared/initiatives";
import { appendAskReceipt } from "./ask-receipts";

export interface ReviewReceipt {
  initiative: string;
  /** The review date answered (Initiative.stale.date). */
  date: string;
  answer: ReviewAnswer;
  note: string;
  at: string;
}

const KIND = "initiative.reviewed";
const ANSWERS: readonly string[] = ["keep", "park", "close"];

/** The key one review answers: its initiative and the date it was due. */
export const reviewId = (initiative: string, date: string) => `${initiative}@${date}`;

export class ReviewReceipts {
  constructor(private readonly path: string) {}

  /** Every review answered, by `initiative@date`; the newest answer wins. */
  async read(): Promise<Map<string, ReviewReceipt>> {
    const text = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const out = new Map<string, ReviewReceipt>();
    for (const line of text.split("\n")) {
      if (!line.includes(KIND)) continue;
      try {
        const row = JSON.parse(line) as Partial<ReviewReceipt> & { kind?: string };
        if (
          row.kind === KIND &&
          typeof row.initiative === "string" &&
          typeof row.date === "string" &&
          typeof row.answer === "string" &&
          ANSWERS.includes(row.answer)
        ) {
          out.set(reviewId(row.initiative, row.date), {
            initiative: row.initiative,
            date: row.date,
            answer: row.answer as ReviewAnswer,
            note: typeof row.note === "string" ? row.note : "",
            at: typeof row.at === "string" ? row.at : "",
          });
        }
      } catch {
        // A torn line is skipped.
      }
    }
    return out;
  }

  async record(receipt: ReviewReceipt): Promise<void> {
    await appendAskReceipt(this.path, { kind: KIND, ...receipt });
  }
}
