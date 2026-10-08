// p9 watchers as loop observations (BRO-2911 spec §1, §3): the PR watchers
// of `~/.config/broomva/p9/state.jsonl` and the waits of `waits.jsonl`, each
// folded to its latest transition. They are ephemeral: listed under Session &
// watchers, never UNREGISTERED. Read-only; only each file's last P9_TAIL_BYTES
// are read, which hold days of transitions. The fold is pure (p9Observations).

import { open } from "node:fs/promises";
import { join } from "node:path";
import type { LoopObservation, LoopRun } from "../shared/loops";

export const P9_TAIL_BYTES = 512 * 1024;
/** A watcher that stopped is still listed this long after, so its end is seen. */
export const P9_RECENT_MS = 24 * 60 * 60_000;
/** States in which a watcher or a wait is still going. */
const GOING = new Set(["PUSHED", "WATCHING", "WAITING"]);
const FAILED = new Set(["RED_UNCLASSIFIED", "ABANDONED", "TIMED_OUT", "KILLED"]);

export interface P9Transition {
  ts: string;
  to_state: string;
  from_state?: string | null;
  watcher_id?: string;
  wait_id?: string;
  pr?: number;
  repo?: string;
  name?: string;
  session_id?: string;
  extra?: { pid?: number; log?: string; cmd?: string } | null;
}

/** JSON lines, a torn first or last line skipped. */
export function parseLines(text: string): P9Transition[] {
  return text.split("\n").flatMap((line) => {
    try {
      const value = JSON.parse(line) as P9Transition;
      return value && typeof value.ts === "string" && typeof value.to_state === "string" ? [value] : [];
    } catch {
      return [];
    }
  });
}

/** Each watcher and wait at its latest transition, going or ended within P9_RECENT_MS. */
export function p9Observations(
  transitions: readonly P9Transition[],
  now: number,
  alive: (pid: number) => boolean,
  dir: string,
): LoopObservation[] {
  const groups = new Map<string, P9Transition[]>();
  for (const one of transitions) {
    const key = one.watcher_id ?? one.wait_id;
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(one);
    groups.set(key, list);
  }
  const out: LoopObservation[] = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const first = list[0] as P9Transition;
    const last = list.at(-1) as P9Transition;
    const pid = list.map((one) => one.extra?.pid).findLast((one) => typeof one === "number") ?? null;
    let going = GOING.has(last.to_state);
    // A watcher whose process is gone is not going, whatever its last line said.
    if (going && pid !== null && !alive(pid)) going = false;
    if (!going && now - Date.parse(last.ts) > P9_RECENT_MS) continue;
    const isWait = Boolean(last.wait_id);
    const name = isWait ? `p9 wait ${last.name ?? key}` : `p9 PR #${last.pr} ${last.repo ?? ""}`.trim();
    const run: LoopRun = {
      at: new Date(Date.parse(first.ts)).toISOString(),
      endedAt: going ? null : new Date(Date.parse(last.ts)).toISOString(),
      status: going ? "running" : FAILED.has(last.to_state) ? "failed" : "ok",
      exit: null,
      detail: going && GOING.has(last.to_state) ? last.to_state : `${last.to_state}${pid !== null && !alive(pid) && GOING.has(last.to_state) ? " (its process is gone)" : ""}`,
    };
    out.push({
      subject: `loop:p9/${key}`,
      kind: "p9",
      ref: key,
      name,
      scope: "broomva",
      presence: going ? "on" : "off",
      status: going ? "running" : run.status === "failed" ? "failed" : "off",
      reason: going ? `${last.to_state} since ${last.ts}.` : `Ended ${last.to_state} at ${last.ts}.`,
      since: run.at,
      cadence: isWait ? "until its condition holds" : "until the PR's checks settle",
      next: null,
      last: run,
      runs: [run],
      ephemeral: true,
      session: last.session_id
        ? { id: last.session_id, agentId: null, pid, alive: pid === null ? null : alive(pid), endedAt: null }
        : undefined,
      where: last.extra?.log ?? join(dir, isWait ? "waits.jsonl" : "state.jsonl"),
    });
  }
  return out.sort((a, b) => (b.since ?? "").localeCompare(a.since ?? ""));
}

/** The end of a file, up to `bytes`; null when there is none. */
export async function tailText(path: string, bytes: number): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    // A cut first line is not a line.
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The p9 watchers and waits now. */
export async function readP9(dir: string, now: number, alive = pidAlive): Promise<LoopObservation[]> {
  const [state, waits] = await Promise.all([
    tailText(join(dir, "state.jsonl"), P9_TAIL_BYTES),
    tailText(join(dir, "waits.jsonl"), P9_TAIL_BYTES),
  ]);
  return p9Observations([...parseLines(state ?? ""), ...parseLines(waits ?? "")], now, alive, dir);
}
