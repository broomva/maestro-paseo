import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoticeSnoozes } from "./notice-snoozes";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const file = async () => {
  const root = await mkdtemp(join(tmpdir(), "maestro-snooze-"));
  roots.push(root);
  return join(root, "state", "snoozes.jsonl");
};

test("a snooze is kept, the newest for a key wins, and reading a missing file is nothing", async () => {
  const path = await file();
  const snoozes = new NoticeSnoozes(path);
  expect(await snoozes.read()).toEqual(new Map());
  const at = new Date("2026-10-12T15:00:00.000Z");
  await snoozes.snooze("work:q1", new Date("2026-10-12T19:00:00.000Z"), at);
  await snoozes.snooze("work:q2", new Date("2026-10-12T17:00:00.000Z"), at);
  await snoozes.snooze("work:q1", new Date("2026-10-12T21:00:00.000Z"), at);
  expect(await snoozes.read()).toEqual(
    new Map([
      ["work:q1", "2026-10-12T21:00:00.000Z"],
      ["work:q2", "2026-10-12T17:00:00.000Z"],
    ]),
  );
});

test("a torn line is skipped, never read as a snooze, and the next snooze starts a line of its own", async () => {
  const path = await file();
  const snoozes = new NoticeSnoozes(path);
  await snoozes.snooze("work:a", new Date("2026-10-12T19:00:00.000Z"), new Date());
  await writeFile(path, `${await Bun.file(path).text()}{"key":"work:b","unt`);
  await snoozes.snooze("work:c", new Date("2026-10-12T20:00:00.000Z"), new Date());
  expect([...(await snoozes.read()).keys()]).toEqual(["work:a", "work:c"]);
});
