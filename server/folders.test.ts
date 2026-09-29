import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, inspectFolder, isGitFolder, repoRefusal, within } from "./folders";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "maestro-folders-")));
  roots.push(root);
  return root;
}

describe("folders", () => {
  test("canonical follows symlinks as far as the path exists, then keeps the rest", async () => {
    const root = await scratch();
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "alias"));
    expect(await canonical(join(root, "alias"))).toBe(join(root, "real"));
    expect(await canonical(join(root, "alias", "not", "yet"))).toBe(join(root, "real", "not", "yet"));
    expect(await canonical(join(root, "alias", "..", "real"))).toBe(join(root, "real"));
  });

  test("within is the folder or below it, never a sibling that shares a prefix", () => {
    expect(within("/a/b", "/a/b")).toBe(true);
    expect(within("/a/b/c", "/a/b")).toBe(true);
    expect(within("/a/bc", "/a/b")).toBe(false);
    expect(within("/a", "/a/b")).toBe(false);
    expect(within("/a/b", "/")).toBe(true);
  });

  test("a git work tree is a .git folder or file here or above", async () => {
    const root = await scratch();
    await mkdir(join(root, "repo", ".git"), { recursive: true });
    await mkdir(join(root, "repo", "packages", "app"), { recursive: true });
    await mkdir(join(root, "linked"));
    await writeFile(join(root, "linked", ".git"), "gitdir: /elsewhere\n");
    await mkdir(join(root, "plain"));
    expect(await isGitFolder(join(root, "repo"))).toBe(true);
    expect(await isGitFolder(join(root, "repo", "packages", "app"))).toBe(true);
    expect(await isGitFolder(join(root, "linked"))).toBe(true);
    expect(await isGitFolder(join(root, "plain"))).toBe(false);
  });

  test("inspect expands ~ the way the daemon does, and says what it found", async () => {
    const root = await scratch();
    await mkdir(join(root, "repo", ".git"), { recursive: true });
    expect(await inspectFolder(` ${join(root, "repo")} `)).toEqual({
      path: join(root, "repo"),
      directory: true,
      git: true,
    });
    expect(await inspectFolder(join(root, "missing"))).toEqual({
      path: join(root, "missing"),
      directory: false,
      git: false,
    });
    expect((await inspectFolder("~")).path).toBe(homedir());
    expect(await inspectFolder("relative/path")).toEqual({ path: "relative/path", directory: false, git: false });
    expect(await inspectFolder("  ")).toEqual({ path: "", directory: false, git: false });
  });

  test("a run never starts in home, in a folder holding the work folder, or inside it", async () => {
    const root = await scratch();
    const home = join(root, "home");
    const work = join(home, "maestro");
    const repo = join(home, "code", "project");
    expect(await repoRefusal(home, work, home)).toContain("home folder");
    expect(await repoRefusal(root, work, home)).toContain("holds the work folder");
    expect(await repoRefusal(work, work, home)).toContain("holds the work folder");
    expect(await repoRefusal(join(work, "item"), work, home)).toContain("inside the work folder");
    expect(await repoRefusal(repo, work, home)).toBeNull();
    expect(await repoRefusal(join(home, "maestro-other"), work, home)).toBeNull();
  });
});
