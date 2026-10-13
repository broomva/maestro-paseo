// The one lock discipline (BRO-2997). Every file Maestro shares with another process, whether that process is a
// second plugin daemon on the same work root or a bstack writer of the ask ledgers, is written under the same lock:
// the control interface's §5.5 lock. `<lock root>/<k>.d`, k the first 16 hex of the SHA-256 of
// realpath(dirname(file)) + "/" + basename(file); made by mkdir, holding a `pid` (`<pid> <start>`) and a `token`.
// A live holder is never reclaimed. A dead one is, by capture: the directory is renamed aside under a reclaim mutex
// and judged again as captured, never removed and re-made, so a lock released and taken anew between the look and the
// rename goes back to its holder instead of being taken away from it.
//
// Within one process the lock is queued first, in memory, so two writers of one file in one daemon never poll for
// it; the file lock is what the other daemon, and bstack's ledger writer, meet.

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** A lock this old whose holder is dead is reclaimed; one with no pid yet counts as live until then. */
export const LOCK_STALE_MS = 120_000;
/** A plugin-owned lock (the work items, the ledgers) is reclaimed sooner: no other writer reads its pid file. */
export const PLUGIN_LOCK_STALE_MS = 10_000;
/** The reclaim mutex is broken past this, as tick.sh does. */
const RECLAIM_STALE_MS = 60_000;

/** Another writer holds the lock, and held it for the whole wait. */
export class LockBusyError extends Error {
  constructor(
    readonly holder: string,
    what = "this ledger",
  ) {
    super(`Another writer holds ${what}'s lock (${holder}), so nothing was written. Try again in a moment.`);
    this.name = "LockBusyError";
  }
}

/** `<k>`: the first 16 hex of the SHA-256 of realpath(dirname(L)) + "/" + basename(L). */
export async function lockKey(ledgerPath: string): Promise<string> {
  const dir = await realpath(dirname(ledgerPath));
  return createHash("sha256")
    .update(`${dir}/${basename(ledgerPath)}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

/**
 * This process's start, in whole seconds since the epoch. A holder's pid file
 * is `<pid> <start>\n`, both decimal, the start in seconds since the epoch, so a
 * reused pid with another start is not the holder. Other writers taking this
 * lock write the same grammar; a file without a start is judged by its pid alone.
 */
let ownStart: number | null = null;
/**
 * Read from ps, as other writers will read it: Node's uptime stops while the
 * Mac sleeps, ps's does not. Kept once ps answers; until then each take asks it
 * again, and uptime stands in.
 */
export async function started(): Promise<number> {
  ownStart ??= await startOf(process.pid);
  return ownStart ?? Math.round(Date.now() / 1000 - process.uptime());
}

/** `ps -o etime=`'s `[[dd-]hh:]mm:ss` in seconds: elapsed time, which no time zone shifts (lstart's local time does). */
export function etimeSeconds(etime: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

/** When a pid's process started (whole seconds), from ps; null when it cannot be told. */
function startOf(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("/bin/ps", ["-o", "etime=", "-p", String(pid)], { timeout: 2000 }, (error, stdout) => {
      const elapsed = error ? null : etimeSeconds(stdout);
      resolve(elapsed === null ? null : Math.round(Date.now() / 1000 - elapsed));
    });
  });
}

export function pidOf(pidFile: string): { pid: number; start: number | null } | null {
  const [pidText, startText] = pidFile.trim().split(/\s+/);
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const start = Number(startText);
  return { pid, start: startText !== undefined && Number.isFinite(start) ? start : null };
}

/** Whether the holder a pid file names is alive: its pid answers, and it started when it said. */
export async function holderAlive(pidFile: string): Promise<boolean> {
  const holder = pidOf(pidFile);
  if (!holder) return false;
  try {
    process.kill(holder.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (holder.start === null) return true;
  const actual = await startOf(holder.pid);
  return actual === null || Math.abs(actual - holder.start) <= 2;
}

export interface Lock {
  dir: string;
  token: string;
}

/** The locks this process holds now. One of its own it does not hold was left behind (§5.5: dropped at once). */
const held = new Set<string>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function ageOf(path: string, now: number): Promise<number | null> {
  try {
    return now - (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

interface Judge {
  now: number;
  staleMs: number;
}

/**
 * Whether a lock may be taken away, and by whom it is held: null when it is gone.
 * Stale: its holder is dead and it is `staleMs` old (one with no pid yet is live for
 * its first `staleMs`), or it is this process's own and this process holds it no more.
 * A live holder is never stale, however old. `at` is the path this process would
 * know it by: a lock captured aside is judged as the lock it was.
 */
async function staleness(dir: string, judge: Judge, at = dir): Promise<{ stale: boolean; holder: string } | null> {
  const age = await ageOf(dir, judge.now);
  if (age === null) return null;
  const pidFile = await readFile(join(dir, "pid"), "utf8").catch(() => null);
  const holder = pidFile ? pidOf(pidFile) : null;
  const words = holder ? `pid ${holder.pid}` : "a writer starting up";
  if (holder?.pid === process.pid && holder.start !== null && Math.abs(holder.start - (await started())) <= 2) {
    return { stale: !held.has(at), holder: words };
  }
  const alive = pidFile === null ? age < judge.staleMs : await holderAlive(pidFile);
  return { stale: !alive && age >= judge.staleMs, holder: words };
}

/**
 * Takes a stale lock away by capture, under its reclaim mutex: the directory is renamed aside, then judged again as
 * captured. One that reads live (it was released and taken anew between the look and the rename) goes back; if
 * another writer has made its own meanwhile, the captured holder finds its token gone and writes nothing.
 */
async function reclaim(dir: string, judge: () => Judge, beforeCapture?: () => Promise<void>): Promise<void> {
  const mutex = `${dir.replace(/\.d$/, "")}.reclaim.d`;
  try {
    await mkdir(mutex);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const age = await ageOf(mutex, judge().now);
    if (age !== null && age >= RECLAIM_STALE_MS) await rm(mutex, { recursive: true, force: true });
    return;
  }
  try {
    if (!(await staleness(dir, judge()))?.stale) return;
    await beforeCapture?.();
    const aside = `${dir}.stale-${randomBytes(4).toString("hex")}`;
    if (
      !(await rename(dir, aside).then(
        () => true,
        () => false,
      ))
    )
      return;
    if ((await staleness(aside, judge(), dir))?.stale !== false) {
      await rm(aside, { recursive: true, force: true });
      return;
    }
    // Captured alive: back it goes. A writer that made a lock meanwhile leaves this one nowhere to return to.
    await rename(aside, dir).catch(() => rm(aside, { recursive: true, force: true }));
  } finally {
    await rm(mutex, { recursive: true, force: true });
  }
}

export interface AcquireOptions {
  waitMs?: number;
  now?: () => number;
  /** How old a dead holder's lock must be before it is reclaimed: LOCK_STALE_MS (the spec's 120 s) unless given. */
  staleMs?: number;
  /** What the lock covers, for the refusal's words. */
  what?: string;
  /** For a test: runs between judging a lock stale and capturing it, where a holder may release and a writer take it anew. */
  beforeCapture?: () => Promise<void>;
}

export async function acquireLock(ledgerPath: string, lockRoot: string, options: AcquireOptions = {}): Promise<Lock> {
  const now = options.now ?? Date.now;
  const judge = () => ({ now: now(), staleMs: options.staleMs ?? LOCK_STALE_MS });
  const deadline = now() + (options.waitMs ?? 5000);
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const dir = join(lockRoot, `${await lockKey(ledgerPath)}.d`);
  let holder = "another writer";
  for (;;) {
    let made = false;
    try {
      await mkdir(dir);
      made = true;
      // Held from the moment it is made: a pid of ours on a lock not yet marked held would read as left behind.
      held.add(dir);
      const token = randomBytes(16).toString("hex");
      await writeFile(join(dir, "pid"), `${process.pid} ${await started()}\n`);
      await writeFile(join(dir, "token"), `${token}\n`);
      return { dir, token };
    } catch (error) {
      // Made but not finished: taken back, so no half-written lock is left to wedge the ledger.
      if (made) {
        held.delete(dir);
        await rm(dir, { recursive: true, force: true });
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const state = await staleness(dir, judge());
    if (state?.stale) await reclaim(dir, judge, options.beforeCapture);
    else if (state) holder = state.holder;
    if (now() >= deadline) throw new LockBusyError(holder, options.what);
    await sleep(50 + Math.floor(Math.random() * 50));
  }
}

/**
 * Every lock step of this process on the ask ledgers' lock root, one at a time: an answer (take, write, release) and
 * a sweep of leftovers, so a sweep never reads a lock released and taken again meanwhile as left behind.
 */
let lockSteps: Promise<unknown> = Promise.resolve();
export function exclusive<T>(run: () => Promise<T>): Promise<T> {
  const next = lockSteps.catch(() => undefined).then(run);
  lockSteps = next;
  return next;
}

/**
 * Drops every lock in the root that this process left behind: its own pid and
 * start, not held now. Run by each plugin sweep (§5.5's "at each scan"; server/sweep.ts), so another
 * writer is never kept waiting on a lock of Maestro's that only Maestro's next answer would clear.
 * It runs between this process's answers, never during one (exclusive): a lock
 * released and taken again meanwhile would otherwise read as left behind.
 */
export function dropLeftovers(lockRoot: string): Promise<void> {
  return exclusive(() => dropNow(lockRoot));
}

async function dropNow(lockRoot: string): Promise<void> {
  const names = await readdir(lockRoot).catch(() => [] as string[]);
  for (const name of names.filter((entry) => entry.endsWith(".d") && !entry.endsWith(".reclaim.d"))) {
    const dir = join(lockRoot, name);
    if (held.has(dir)) continue;
    const holder = pidOf((await readFile(join(dir, "pid"), "utf8").catch(() => "")) ?? "");
    if (holder?.pid === process.pid && holder.start !== null && Math.abs(holder.start - (await started())) <= 2) {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** Whether the lock is still the one this holder took: a lock taken over has another token. */
export async function stillOurs(lock: Lock): Promise<boolean> {
  const token = await readFile(join(lock.dir, "token"), "utf8").catch(() => null);
  return token?.trim() === lock.token;
}

export async function releaseLock(lock: Lock): Promise<void> {
  // No longer held here, whatever follows: a lock of ours left behind is then stale to our next write.
  held.delete(lock.dir);
  if (!(await stillOurs(lock))) return;
  await rm(join(lock.dir, "token"), { force: true });
  await rm(join(lock.dir, "pid"), { force: true });
  await rm(lock.dir, { recursive: true, force: true });
}

// ── One file at a time, in this process and in any other ─────────────────────

/** Writers queued in this process on one lock, by lock directory. */
const queues = new Map<string, Promise<unknown>>();

/**
 * Runs `run` holding the file lock of `path`: queued behind this process's own writers of it, then taken on disk, so
 * a second daemon on the same file waits its turn. `run` is told if the lock was taken from under it (`ok()`), so a
 * writer that renames a temp over the file as its last step can check first.
 */
export async function withFileLock<T>(
  path: string,
  lockRoot: string,
  run: (lock: Lock) => Promise<T>,
  options: AcquireOptions = {},
): Promise<T> {
  return inOrder(`${lockRoot}|${path}`, async () => {
    await mkdir(dirname(path), { recursive: true });
    const lock = await acquireLock(path, lockRoot, { staleMs: PLUGIN_LOCK_STALE_MS, ...options });
    try {
      return await run(lock);
    } finally {
      await releaseLock(lock);
    }
  });
}

/**
 * Runs `run` after every earlier call with the same key, in the order they were made, whatever each awaits first:
 * queued before anything is awaited. The one in-memory queue, under withFileLock and for what must keep a caller's order.
 */
export async function inOrder<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  queues.set(key, next);
  try {
    return await next;
  } finally {
    if (queues.get(key) === next) queues.delete(key);
  }
}

/**
 * Waits until no other writer holds the lock of `path`, up to `waitMs`: a read that must not pair one writer's
 * half-done change with the files as they were. A lock whose holder is gone does not hold a reader up.
 */
export async function awaitUnlocked(
  path: string,
  lockRoot: string,
  options: { waitMs?: number; staleMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (options.waitMs ?? 2000);
  // This process's own writers first: they hold the file lock, and they are in memory.
  const queued = queues.get(`${lockRoot}|${path}`)?.catch(() => undefined);
  if (queued) await Promise.race([queued, sleep(options.waitMs ?? 2000)]);
  const key = await lockKey(path).catch(() => null);
  // No folder for the locks yet: nothing has ever been locked there.
  if (key === null) return;
  const dir = join(lockRoot, `${key}.d`);
  while (Date.now() < deadline) {
    const state = await staleness(dir, { now: Date.now(), staleMs: options.staleMs ?? PLUGIN_LOCK_STALE_MS });
    if (!state || state.stale) return;
    await sleep(20);
  }
}
