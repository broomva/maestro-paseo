// Whether a run's worktree holds work that was never committed, asked before
// anything removes the worktree. Archiving a worktree deletes its files; only
// the branch survives, so uncommitted changes would be lost with it.

import { execFile } from "node:child_process";

export type WorktreeStatus = { dirty: boolean } | { error: string };

/** `git status --porcelain` in `cwd`: tracked edits and untracked files both count as uncommitted. */
export function worktreeStatus(cwd: string, timeoutMs = 10_000): Promise<WorktreeStatus> {
  // The daemon's own git variables must not point this at another repository.
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[name];
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "status", "--porcelain", "--untracked-files=normal"],
      { env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || error.message)
            .trim()
            .split("\n")[0];
          resolve({ error: detail || "git status failed" });
          return;
        }
        resolve({ dirty: stdout.trim().length > 0 });
      },
    );
  });
}
