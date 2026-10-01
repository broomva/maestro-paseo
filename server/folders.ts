// Folders a run may start in. A run is an agent working as you in that folder,
// so the folder must be a repository the work changes: never your home folder,
// and never one that holds the work folder, where a run could edit its own
// contract and receipts. `create` refuses such a folder early, as you choose
// it; `runFolder` is the check every run passes before it starts, however it
// was reached (dispatch, unblock, or work adopted from a session, which
// records the session's folder unchecked because adopting starts nothing).

import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Isolation } from "../shared/contracts";
import { expandHome } from "./paths";

/** The real path, following symlinks as far as the path exists; the rest is appended as written. */
export async function canonical(path: string): Promise<string> {
  let head = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(await realpath(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(path);
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

/** Whether `inner` is `outer` or below it. Both canonical. */
export function within(inner: string, outer: string): boolean {
  if (inner === outer) return true;
  return inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);
}

/** Inside a git work tree: a `.git` folder or file here or in a parent. */
export async function isGitFolder(path: string): Promise<boolean> {
  const exists = (target: string) => stat(target).then(Boolean, () => false);
  let dir = resolve(path);
  for (;;) {
    if (await exists(join(dir, ".git"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

export interface FolderInfo {
  /** `~` expanded: the path the daemon and Paseo will use. */
  path: string;
  directory: boolean;
  git: boolean;
}

export async function inspectFolder(raw: string): Promise<FolderInfo> {
  const path = expandHome(raw.trim());
  if (!path || !isAbsolute(path)) return { path, directory: false, git: false };
  const info = await stat(path).catch(() => null);
  const directory = Boolean(info?.isDirectory());
  return { path, directory, git: directory && (await isGitFolder(path)) };
}

export type FolderRule = "home" | "holds" | "inside";

/** Which rule a run in `repo` would break, or null. `home` is injectable for tests. */
export async function brokenRule(repo: string, workRoot: string, home: string = homedir()): Promise<FolderRule | null> {
  const [target, root, own] = await Promise.all([canonical(repo), canonical(workRoot), canonical(home)]);
  if (target === own) return "home";
  if (within(root, target)) return "holds";
  if (within(target, root)) return "inside";
  return null;
}

/** Said while you choose the folder. */
const CHOOSING: Record<FolderRule, string> = {
  home: "Runs cannot start in your home folder. Choose the repository the work changes.",
  holds:
    "That folder holds the work folder, where a run could edit its own contract. Choose the repository the work changes.",
  inside:
    "That folder is inside the work folder, where a run could edit its own contract. Choose the repository the work changes.",
};

/** Why runs may not start in `repo`, said as you choose it; null when they may. */
export async function repoRefusal(repo: string, workRoot: string, home: string = homedir()): Promise<string | null> {
  const rule = await brokenRule(repo, workRoot, home);
  return rule ? CHOOSING[rule] : null;
}

/** Said of a folder the work already records (its `repo:`), when a run would start there. */
const STORED: Record<FolderRule, string> = {
  home: "This work's folder is your home folder; set a repository to run it in.",
  holds:
    "This work's folder holds the work folder, where a run could edit its own contract; set a repository to run it in.",
  inside:
    "This work's folder is inside the work folder, where a run could edit its own contract; set a repository to run it in.",
};

/**
 * The check every run passes before it starts: the folder it would start in
 * (`~` expanded), or why it may not. With worktree isolation the folder must
 * also be a git repository, since each run branches a worktree from it.
 */
export async function runFolder(
  raw: string,
  input: { workRoot: string; isolation: Isolation; home?: string },
): Promise<{ path: string; refusal: string | null }> {
  const folder = await inspectFolder(raw);
  const path = folder.path;
  if (!isAbsolute(path))
    return { path, refusal: "This work's folder is not an absolute path; set a repository to run it in." };
  if (!folder.directory) return { path, refusal: `There is no folder at ${path}; set a repository to run it in.` };
  const rule = await brokenRule(path, input.workRoot, input.home);
  if (rule) return { path, refusal: STORED[rule] };
  if (input.isolation === "worktree" && !folder.git) {
    return {
      path,
      refusal:
        "This work's folder is not a git repository, and each run gets a new worktree; set a repository to run it in, or run it in the folder itself.",
    };
  }
  return { path, refusal: null };
}
