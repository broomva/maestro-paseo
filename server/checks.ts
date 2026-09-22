// Runs a work item's `done.check` commands in the run's directory.
//
// The commands come from the human-written contract, but they execute inside a
// tree the agent just edited: a changed test script runs with whatever
// environment it is given. So checks get a minimal environment, never the
// daemon's, which can hold credentials.

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

export function runCheck(check: CheckRun, cwd: string, signal?: AbortSignal): Promise<CheckResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;
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
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, check.timeoutS * 1000);
    const onAbort = () => kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (exit: number | null, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
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
    child.on("error", (error) => finish(null, `\n${error.message}`));
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
