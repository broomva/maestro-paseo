// Stop everything a sandbox started and delete its directory. Shared by
// down.ts and by up.ts when it fails part way. Safe to run twice: a sandbox
// that is already gone is reported, not an error.

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import {
  alive,
  ancestors,
  clearPointer,
  deletable,
  isDaemonOf,
  type Proc,
  portOpen,
  processes,
  readState,
  sandboxProcesses,
  sleep,
} from "./lib";

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // Already gone.
  }
}

async function settle(pids: readonly number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let left = pids.filter(alive);
  while (left.length > 0 && Date.now() < deadline) {
    await sleep(200);
    left = left.filter(alive);
  }
  return left;
}

/** TERM, then KILL whatever is left. Returns the pids that were running. Callers never pass an ancestor. */
async function stop(procs: readonly Proc[], timeoutMs: number): Promise<number[]> {
  const pids = procs.map((proc) => proc.pid);
  if (pids.length === 0) return [];
  for (const pid of pids) signal(pid, "SIGTERM");
  const left = await settle(pids, timeoutMs);
  for (const pid of left) signal(pid, "SIGKILL");
  await settle(left, 3000);
  return pids;
}

export async function teardown(dir: string, log: (line: string) => void = console.log): Promise<boolean> {
  if (!existsSync(dir)) {
    await clearPointer(dir);
    log(`Nothing to tear down: ${dir} does not exist.`);
    return true;
  }
  const state = readState(dir);
  if (!state) {
    await clearPointer(dir);
    log(`${dir} holds no dogfood state.json, so it was left alone.`);
    return false;
  }

  // The daemon runs in its own process group (spawned detached), with its plugin processes in it.
  // Stop that group only if the pid still belongs to this sandbox's daemon.
  const all = processes();
  const skip = ancestors(all);
  const daemon = state.daemonPid ? all.find((proc) => proc.pid === state.daemonPid) : undefined;
  const owned =
    daemon && isDaemonOf(daemon, state) ? all.filter((proc) => proc.pgid === daemon.pgid && !skip.has(proc.pid)) : [];
  if (daemon && owned.length === 0) log(`pid ${daemon.pid} is no longer this sandbox's daemon; left alone.`);
  const stoppedDaemon = await stop(owned, 15_000);

  // What else the sandbox started: stand-in agents, a browser left by an interrupted shot.ts.
  const stoppedOthers = await stop(
    sandboxProcesses(state).filter((proc) => !stoppedDaemon.includes(proc.pid)),
    5000,
  );
  const stopped = [...stoppedDaemon, ...stoppedOthers];
  log(
    stopped.length > 0
      ? `Stopped ${stopped.length} process(es): ${stopped.join(", ")}`
      : "No sandbox process was running.",
  );

  const leftover = sandboxProcesses(state);
  if (leftover.length > 0) {
    log(`Still running after SIGKILL: ${leftover.map((proc) => proc.pid).join(", ")}. The directory is kept.`);
    return false;
  }
  if (await portOpen(state.port)) {
    log(`Port ${state.port} still answers. It is no longer this sandbox's daemon; the directory is deleted anyway.`);
  }

  if (!deletable(dir, state)) {
    log(`${dir} is not a mktemp dogfood sandbox; it was not deleted.`);
    return false;
  }
  await rm(dir, { recursive: true, force: true });
  await clearPointer(dir);
  log(`Deleted ${dir}`);
  return true;
}
