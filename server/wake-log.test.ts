import { afterAll, expect, test } from "bun:test";
import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WakeEntry } from "../shared/contracts";
import { wakeLogPath } from "./paths";
import { WAKE_LOG_KEEP, WAKE_LOG_MAX, WakeLog } from "./wake-log";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function fresh(): Promise<{ path: string; logs: string[]; log: WakeLog }> {
  const root = await mkdtemp(join(tmpdir(), "maestro-wake-log-"));
  roots.push(root);
  const path = join(root, "wake-log.jsonl");
  const logs: string[] = [];
  return { path, logs, log: new WakeLog(path, (message) => logs.push(message)) };
}

function entry(n: number, extra: Partial<WakeEntry> = {}): WakeEntry {
  return {
    tickId: `t${n}`,
    cause: "timer",
    wokeAt: new Date(Date.UTC(2026, 8, 22, 9, 0, n)).toISOString(),
    dispatched: [],
    deferred: [],
    needsYou: { gate: 0, stuck: 0, asking: 0 },
    quiet: [],
    narrative: ["Woke on a scheduled check.", "Did nothing new this tick."],
    ...extra,
  };
}

const lines = async (path: string) => (await readFile(path, "utf8")).split("\n").filter((line) => line.trim());

test("it lives beside the config, or where MAESTRO_PASEO_WAKE_LOG says", () => {
  expect(wakeLogPath({ MAESTRO_PASEO_CONFIG: "/x/maestro/config.json" })).toBe("/x/maestro/wake-log.jsonl");
  expect(wakeLogPath({ MAESTRO_PASEO_CONFIG: "/x/config.json", MAESTRO_PASEO_WAKE_LOG: "/y/w.jsonl" })).toBe(
    "/y/w.jsonl",
  );
});

test("a missing file reads as no wakes; recent is the newest first", async () => {
  const { log } = await fresh();
  expect(await log.recent(5)).toEqual([]);
  expect(await log.lastRun()).toBeNull();
  for (const n of [1, 2, 3]) await log.append(entry(n));
  expect((await log.recent(2)).map((one) => one.tickId)).toEqual(["t3", "t2"]);
  expect((await log.lastRun())?.tickId).toBe("t3");
});

test("a torn or garbage line is skipped with one warning, and the next append still lands on its own line", async () => {
  const { path, logs, log } = await fresh();
  await log.append(entry(1));
  await appendFile(path, 'not json\n{"tickId":"t9"}\n{"tickId":"torn","cause":"ti');
  expect((await log.recent(10)).map((one) => one.tickId)).toEqual(["t1"]);
  expect(logs).toEqual([`${path}: skipped 3 unreadable line(s)`]);
  // Polling again does not repeat the same warning.
  await log.recent(10);
  expect(logs).toHaveLength(1);
  await log.append(entry(2));
  expect((await log.recent(10)).map((one) => one.tickId)).toEqual(["t2", "t1"]);
});

test(`past ${WAKE_LOG_MAX} lines it is rewritten to the newest ${WAKE_LOG_KEEP}; at ${WAKE_LOG_MAX} it is not`, async () => {
  const { path, log } = await fresh();
  const many = Array.from({ length: WAKE_LOG_MAX - 1 }, (_, n) => `${JSON.stringify(entry(n))}\n`).join("");
  await writeFile(path, many);
  await log.append(entry(5000));
  expect(await lines(path)).toHaveLength(WAKE_LOG_MAX);
  await log.append(entry(5001));
  const kept = await lines(path);
  expect(kept).toHaveLength(WAKE_LOG_KEEP);
  expect(JSON.parse(kept.at(-1) ?? "{}").tickId).toBe("t5001");
  expect(JSON.parse(kept[0] ?? "{}").tickId).toBe(`t${WAKE_LOG_MAX - WAKE_LOG_KEEP + 1}`);
  // No temporary file is left beside it.
  expect(await readdir(join(path, ".."))).toEqual(["wake-log.jsonl"]);
});

test("appends at once land in order, none lost", async () => {
  const { log } = await fresh();
  await Promise.all([1, 2, 3, 4, 5].map((n) => log.append(entry(n))));
  expect((await log.recent(10)).map((one) => one.tickId)).toEqual(["t5", "t4", "t3", "t2", "t1"]);
});

test("the newest wake that ran skips the ones that were skipped", async () => {
  const { log } = await fresh();
  await log.append(entry(1));
  await log.append(entry(2, { skipped: "another check was already running" }));
  expect((await log.lastRun())?.tickId).toBe("t1");
});
