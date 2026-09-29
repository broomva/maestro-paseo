// Runs a work item's `done.check` commands in the run's directory.
//
// The commands come from the contract a person wrote: the agent socket refuses
// a check from a session, since checks run as you with no session in the loop.
// (A process running as you can still edit `_work.md` directly.) They execute
// inside a tree the agent just edited, though: a changed test script runs with
// whatever environment it is given. So checks get a minimal environment, never
// the daemon's, which can hold credentials.

import { spawn } from "node:child_process";
import type { CheckResult } from "../shared/contracts";
import type { CheckRun } from "./frontmatter";

const PASSTHROUGH = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR"];
const TAIL_CHARS = 4000;

export function checkEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: "1" };
  for (const key of PASSTHROUGH) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** How long output may keep draining after the shell exits. */
const DRAIN_MS = 250;
/** Extra time after a timeout kill before giving up on the process entirely. */
const KILL_GRACE_MS = 2000;

/**
 * Runs one check. It settles on the shell's exit, not on its pipes closing: a
 * command that leaves a detached child holding stdout would otherwise keep the
 * check open forever. A hard deadline settles it even if the kill does not.
 */
export function runCheck(check: CheckRun, cwd: string, signal?: AbortSignal): Promise<CheckResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const child = spawn("/bin/sh", ["-c", check.run], {
      cwd,
      env: checkEnv(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-TAIL_CHARS * 2);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const kill = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const finish = (exit: number | null, extra = "") => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      // Anything the check left running in its process group goes with it.
      kill();
      signal?.removeEventListener("abort", onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        name: check.name,
        run: check.run,
        required: check.required,
        ok: !timedOut && exit === 0,
        exit,
        durationMs: Date.now() - started,
        timedOut,
        tail: (output + extra).slice(-TAIL_CHARS),
      });
    };
    const onAbort = () => kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    timers.push(
      setTimeout(() => {
        timedOut = true;
        kill();
        timers.push(setTimeout(() => finish(null, "\nThe check did not stop after it timed out."), KILL_GRACE_MS));
      }, check.timeoutS * 1000),
    );
    child.on("error", (error) => finish(null, `\n${error.message}`));
    child.on("exit", (code) => {
      timers.push(setTimeout(() => finish(code), DRAIN_MS));
    });
    child.on("close", (code) => finish(code));
  });
}

/** Required checks run in order; the first required failure stops the rest. */
export async function runChecks(
  checks: readonly CheckRun[],
  cwd: string,
  signal?: AbortSignal,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    const result = await runCheck(check, cwd, signal);
    results.push(result);
    if (check.required && !result.ok) break;
  }
  return results;
}
