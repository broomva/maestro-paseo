import { afterAll, describe, expect, test } from "bun:test";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLock,
  awaitUnlocked,
  etimeSeconds,
  holderAlive,
  LockBusyError,
  lockKey,
  releaseLock,
  withFileLock,
} from "./locks";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "maestro-locks-"));
  roots.push(dir);
  const file = join(dir, "shared.jsonl");
  await writeFile(file, "");
  return { dir, file, locks: join(dir, ".locks") };
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("withFileLock", () => {
  test("writers of one file run one at a time, in the order they asked, and leave no lock behind", async () => {
    const { dir, file, locks } = await setup();
    const order: number[] = [];
    let inside = 0;
    await Promise.all(
      Array.from({ length: 8 }, (_, n) =>
        withFileLock(file, locks, async () => {
          inside += 1;
          expect(inside).toBe(1);
          await sleep(5);
          order.push(n);
          inside -= 1;
        }),
      ),
    );
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect((await readdir(dir)).sort()).toEqual([".locks", "shared.jsonl"]);
    expect(await readdir(locks)).toEqual([]);
  });

  test("a failing writer releases the lock for the next", async () => {
    const { dir, file, locks } = await setup();
    await expect(
      withFileLock(file, locks, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await withFileLock(file, locks, async () => "next")).toBe("next");
    expect(await readdir(locks)).toEqual([]);
    expect((await readdir(dir)).sort()).toEqual([".locks", "shared.jsonl"]);
  });

  test("a live holder in another process is waited on, never reclaimed, however old; the refusal names it", async () => {
    const { file, locks } = await setup();
    const holder = spawn("/bin/sleep", ["30"]);
    try {
      await mkdir(locks, { recursive: true });
      const dir = join(locks, `${await lockKey(file)}.d`);
      await mkdir(dir);
      await writeFile(join(dir, "pid"), `${holder.pid}\n`);
      await writeFile(join(dir, "token"), "theirs\n");
      const old = new Date(Date.now() - 3_600_000);
      await utimes(dir, old, old);
      const error = await withFileLock(file, locks, async () => "never", { waitMs: 300, what: "work item w1" }).catch(
        (caught) => caught,
      );
      expect(error).toBeInstanceOf(LockBusyError);
      expect((error as Error).message).toBe(
        `Another writer holds work item w1's lock (pid ${holder.pid}), so nothing was written. Try again in a moment.`,
      );
      expect((await readFile(join(dir, "token"), "utf8")).trim()).toBe("theirs");
    } finally {
      holder.kill();
    }
  });

  test("a dead holder's lock is reclaimed once it is old enough, and the write goes ahead", async () => {
    const { file, locks } = await setup();
    await mkdir(locks, { recursive: true });
    const dir = join(locks, `${await lockKey(file)}.d`);
    await mkdir(dir);
    await writeFile(join(dir, "pid"), "999999 1\n");
    await writeFile(join(dir, "token"), "gone\n");
    const old = new Date(Date.now() - 60_000);
    await utimes(dir, old, old);
    expect(await withFileLock(file, locks, async () => "ran", { waitMs: 2000 })).toBe("ran");
    // Fresh and dead: still waited on until it is old enough.
    await mkdir(locks, { recursive: true });
    await mkdir(dir);
    await writeFile(join(dir, "pid"), "999999 1\n");
    await expect(withFileLock(file, locks, async () => "never", { waitMs: 150 })).rejects.toThrow("pid 999999");
    await rm(dir, { recursive: true, force: true });
  });

  test("a pid that is alive but started at another time is a reused pid: its lock is stale, and one that started when it said is live", async () => {
    const { file, locks } = await setup();
    const holder = spawn("/bin/sleep", ["30"]);
    try {
      await mkdir(locks, { recursive: true });
      const dir = join(locks, `${await lockKey(file)}.d`);
      const etime = await new Promise<string>((resolve) =>
        execFile("/bin/ps", ["-o", "etime=", "-p", String(holder.pid)], (_error, out) => resolve(out)),
      );
      const start = Math.round(Date.now() / 1000 - (etimeSeconds(etime) ?? 0));
      const old = new Date(Date.now() - 60_000);
      const lockOf = async (claimed: number) => {
        await rm(dir, { recursive: true, force: true });
        await mkdir(dir);
        await writeFile(join(dir, "pid"), `${holder.pid} ${claimed}\n`);
        await writeFile(join(dir, "token"), "theirs\n");
        await utimes(dir, old, old);
      };
      // The pid answers, and it started when the lock says: the holder, live however old.
      expect(await holderAlive(`${holder.pid} ${start}`)).toBe(true);
      await lockOf(start);
      await expect(acquireLock(file, locks, { waitMs: 200, staleMs: 10_000 })).rejects.toBeInstanceOf(LockBusyError);
      // The pid answers, but the process started an hour before the lock says it did: another process holds the pid now.
      expect(await holderAlive(`${holder.pid} ${start - 3600}`)).toBe(false);
      await lockOf(start - 3600);
      const lock = await acquireLock(file, locks, { waitMs: 2000, staleMs: 10_000 });
      expect((await readFile(join(lock.dir, "pid"), "utf8")).split(" ")[0]).toBe(String(process.pid));
      await releaseLock(lock);
    } finally {
      holder.kill();
    }
  });

  test("a stale lock is captured by rename and judged again: one taken anew in between is put back, not removed", async () => {
    const { file, locks } = await setup();
    await mkdir(locks, { recursive: true });
    const dir = join(locks, `${await lockKey(file)}.d`);
    await mkdir(dir);
    await writeFile(join(dir, "pid"), "999999 1\n");
    await writeFile(join(dir, "token"), "old\n");
    const old = new Date(Date.now() - 60_000);
    await utimes(dir, old, old);
    const holder = spawn("/bin/sleep", ["30"]);
    try {
      const error = await acquireLock(file, locks, {
        waitMs: 300,
        staleMs: 10_000,
        // The dead holder releases and a live one takes the lock, between the look and the capture.
        beforeCapture: async () => {
          await writeFile(join(dir, "pid"), `${holder.pid}\n`);
          await writeFile(join(dir, "token"), "fresh\n");
        },
      }).catch((caught) => caught);
      expect(error).toBeInstanceOf(LockBusyError);
      // It was captured and judged live: it is where it was, with its holder's token, and no leftover beside it.
      expect((await readFile(join(dir, "token"), "utf8")).trim()).toBe("fresh");
      expect(await readdir(locks)).toEqual([`${await lockKey(file)}.d`]);
    } finally {
      holder.kill();
    }
  });

  test("a lock taken over while its holder works is noticed: the token no longer matches", async () => {
    const { file, locks } = await setup();
    const lock = await acquireLock(file, locks);
    await writeFile(join(lock.dir, "token"), "another\n");
    const { stillOurs } = await import("./locks");
    expect(await stillOurs(lock)).toBe(false);
    await releaseLock(lock);
    // A lock that is not ours is left alone by its former holder.
    expect(await readdir(locks)).toHaveLength(1);
  });
});

describe("awaitUnlocked", () => {
  test("returns at once when nothing is locked, and waits for this process's own writer", async () => {
    const { file, locks } = await setup();
    const started = Date.now();
    await awaitUnlocked(file, locks);
    expect(Date.now() - started).toBeLessThan(200);
    let done = false;
    const writer = withFileLock(file, locks, async () => {
      await sleep(150);
      done = true;
    });
    await sleep(20);
    await awaitUnlocked(file, locks);
    expect(done).toBe(true);
    await writer;
  });

  test("gives up after its wait on a lock a live process holds", async () => {
    const { file, locks } = await setup();
    const holder = spawn("/bin/sleep", ["30"]);
    try {
      await mkdir(locks, { recursive: true });
      const dir = join(locks, `${await lockKey(file)}.d`);
      await mkdir(dir);
      await writeFile(join(dir, "pid"), `${holder.pid}\n`);
      const started = Date.now();
      await awaitUnlocked(file, locks, { waitMs: 200 });
      expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    } finally {
      holder.kill();
    }
  });
});
