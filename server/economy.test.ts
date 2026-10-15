import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EconomyFile, type EconomyTimer } from "./economy";
import type { EconomyWork } from "./economy-model";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(options: { refreshMs?: number; scanMs?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "maestro-economy-file-"));
  dirs.push(dir);
  let clock = Date.parse("2026-10-15T12:00:00.000Z");
  const timers: Array<{ run: () => void; ms: number; canceled: boolean }> = [];
  const timer: EconomyTimer = (run, ms) => {
    const entry = { run, ms, canceled: false };
    timers.push(entry);
    return () => {
      entry.canceled = true;
    };
  };
  const logged: string[] = [];
  const file = new EconomyFile({
    path: join(dir, "economy.json"),
    now: () => new Date(clock),
    timer,
    log: (message) => logged.push(message),
    ...options,
  });
  let scans = 0;
  const works =
    (rows: EconomyWork[] = []) =>
    async () => {
      scans += 1;
      return rows;
    };
  return {
    file,
    path: join(dir, "economy.json"),
    logged,
    tick: (ms: number) => {
      clock += ms;
    },
    scans: () => scans,
    works,
    live: () => timers.filter((entry) => !entry.canceled),
    fire: async () => {
      for (const entry of timers.splice(0)) if (!entry.canceled) entry.run();
      await file.settled();
    },
  };
}

describe("EconomyFile", () => {
  test("a write lands whole, and the first one is not made to wait", async () => {
    const f = await fixture();
    const summary = await f.file.write(f.works(), true);
    expect(summary?.windowDays).toBe(7);
    expect(JSON.parse(await readFile(f.path, "utf8")).generatedAt).toBe("2026-10-15T12:00:00.000Z");
    expect(f.scans()).toBe(1);
  });

  test("requests inside the scan interval make one trailing scan, so the last reading lands", async () => {
    const f = await fixture();
    await f.file.write(f.works(), true);
    for (let at = 0; at < 5; at += 1) {
      f.tick(2_000);
      expect(await f.file.write(f.works(), true)).toBeNull();
    }
    // Five readings, one scan waiting for the interval's end; none has scanned yet.
    expect(f.scans()).toBe(1);
    expect(f.live()).toHaveLength(1);
    // Set at the first request, two seconds after the scan, for the rest of the interval.
    expect(f.live()[0]?.ms).toBe(28_000);
    f.tick(20_000);
    await f.fire();
    expect(f.scans()).toBe(2);
    expect(f.live()).toHaveLength(0);
    // The trailing write is the later one.
    expect(JSON.parse(await readFile(f.path, "utf8")).generatedAt).toBe("2026-10-15T12:00:30.000Z");
  });

  test("scans never overlap: a request during one is answered by one more after it", async () => {
    const f = await fixture({ scanMs: 0 });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let running = 0;
    let most = 0;
    const slow = async () => {
      running += 1;
      most = Math.max(most, running);
      await gate;
      running -= 1;
      return [];
    };
    const first = f.file.write(slow, true);
    expect(await f.file.write(slow, true)).toBeNull();
    expect(await f.file.write(slow, true)).toBeNull();
    release();
    await first;
    await f.file.settled();
    expect(most).toBe(1);
  });

  test("an unforced write waits for the minute, counted from the last write that landed", async () => {
    const f = await fixture({ scanMs: 0 });
    expect(await f.file.write(f.works(), false)).not.toBeNull();
    f.tick(59_000);
    expect(await f.file.write(f.works(), false)).toBeNull();
    f.tick(2_000);
    expect(await f.file.write(f.works(), false)).not.toBeNull();
    expect(f.scans()).toBe(2);
  });

  test("a scan that fails does not count as a write: the next unforced one is not made to wait for the minute", async () => {
    const f = await fixture({ scanMs: 0 });
    await expect(
      f.file.write(async () => {
        throw new Error("the work root is gone");
      }, false),
    ).rejects.toThrow("the work root is gone");
    f.tick(1_000);
    expect(await f.file.write(f.works(), false)).not.toBeNull();
  });

  test("stopping cancels the trailing scan", async () => {
    const f = await fixture();
    await f.file.write(f.works(), true);
    await f.file.write(f.works(), true);
    expect(f.live()).toHaveLength(1);
    f.file.stop();
    expect(f.live()).toHaveLength(0);
  });
});
