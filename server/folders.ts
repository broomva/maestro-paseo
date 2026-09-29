// Folders a run may start in. A run is an agent working as you in that folder,
// so the folder must be a repository the work changes: never your home folder,
// and never one that holds the work folder, where a run could edit its own
// contract and receipts.

import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
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

/** Why runs may not start in `repo`, or null. `home` is injectable for tests. */
export async function repoRefusal(repo: string, workRoot: string, home: string = homedir()): Promise<string | null> {
  const [target, root, own] = await Promise.all([canonical(repo), canonical(workRoot), canonical(home)]);
  if (target === own) return "Runs cannot start in your home folder. Choose the repository the work changes.";
  if (within(root, target)) {
    return "That folder holds the work folder, where a run could edit its own contract. Choose the repository the work changes.";
  }
  if (within(target, root)) {
    return "That folder is inside the work folder, where a run could edit its own contract. Choose the repository the work changes.";
  }
  return null;
}
