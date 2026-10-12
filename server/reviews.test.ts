import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewReceipts, reviewId } from "./reviews";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const file = async () => {
  const root = await mkdtemp(join(tmpdir(), "maestro-reviews-"));
  roots.push(root);
  return join(root, "asks.jsonl");
};

test("an answer to a review is a receipt line, read back by its initiative and the date it answered", async () => {
  const path = await file();
  const receipts = new ReviewReceipts(path);
  expect(await receipts.read()).toEqual(new Map());
  await receipts.record({
    initiative: "skene",
    date: "2026-10-07",
    answer: "keep",
    note: "",
    at: "2026-10-09T10:00:00.000Z",
  });
  const read = await receipts.read();
  expect(read.get(reviewId("skene", "2026-10-07"))).toMatchObject({ answer: "keep" });
  // A later review date is a new review: the old answer does not cover it.
  expect(read.has(reviewId("skene", "2026-10-14"))).toBe(false);
});

test("the newest answer for a review wins; lines of other kinds and torn ones are skipped", async () => {
  const path = await file();
  await writeFile(
    path,
    [
      JSON.stringify({ kind: "ask.answered", ledger: "x.yaml", id: "A1" }),
      JSON.stringify({
        kind: "initiative.reviewed",
        initiative: "holon",
        date: "2026-10-08",
        answer: "park",
        note: "later",
        at: "t1",
      }),
      JSON.stringify({
        kind: "initiative.reviewed",
        initiative: "holon",
        date: "2026-10-08",
        answer: "close",
        note: "done",
        at: "t2",
      }),
      JSON.stringify({
        kind: "initiative.reviewed",
        initiative: "holon",
        date: "2026-10-09",
        answer: "nonsense",
        note: "",
        at: "t3",
      }),
      '{"kind":"initiative.reviewed","initiative":"kin',
      "",
    ].join("\n"),
  );
  const read = await new ReviewReceipts(path).read();
  expect([...read.keys()]).toEqual([reviewId("holon", "2026-10-08")]);
  expect(read.get(reviewId("holon", "2026-10-08"))).toMatchObject({ answer: "close", note: "done" });
});
