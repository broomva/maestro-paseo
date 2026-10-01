import { afterAll, describe, expect, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv, type RunWorktree, worktreeStatus } from "./worktree";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** git for setting fixtures up, with none of this machine's config (no signing, no hooks). */
function sh(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync(["git", "-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
    env: gitEnv() as Record<string, string>,
  });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString();
}

/** git with no overrides at all, as a daemon that trusted the repository would run it. */
function naiveStatus(cwd: string): void {
  Bun.spawnSync(["git", "-C", cwd, "status", "--porcelain"], { env: gitEnv() as Record<string, string> });
}

/**
 * What a dispatch leaves: a repository with one committed file, and a run
 * worktree of it on a `run/` branch, the folder the session works in. Plus a
 * script that leaves a marker when anything runs it.
 */
async function repo(options: { relative?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "maestro-worktree-"));
  roots.push(root);
  const main = join(root, "repo");
  sh(root, "init", "-q", main);
  await writeFile(join(main, "a.txt"), "hello\n");
  sh(main, "add", "a.txt");
  sh(main, "commit", "-q", "-m", "init");
  const branch = `run/${Math.random().toString(16).slice(2, 10)}`;
  const cwd = join(root, "wt");
  const relative = options.relative ? ["-c", "worktree.useRelativePaths=true"] : [];
  sh(main, ...relative, "worktree", "add", "-q", "-b", branch, cwd);
  const run: RunWorktree = { repo: main, cwd, branch };
  const marker = join(root, "ran");
  const script = join(root, "hostile.sh");
  await writeFile(script, `#!/bin/sh\necho ran >> "${marker}"\ncat\n`);
  await chmod(script, 0o755);
  /** Change a.txt's stat without changing its content, so git has to look at the file again. */
  const touch = async () => {
    const later = new Date(Date.now() + 60_000 * Math.ceil(Math.random() * 100));
    await utimes(join(cwd, "a.txt"), later, later);
  };
  return { root, main, cwd, run, marker, script, touch };
}

/** A repository of the session's own whose one commit holds exactly `files`; its git folder. */
async function decoyOf(root: string, files: Record<string, string>): Promise<string> {
  const decoy = join(root, "decoy");
  sh(root, "init", "-q", decoy);
  for (const [name, contents] of Object.entries(files)) await writeFile(join(decoy, name), contents);
  sh(decoy, "add", "-A");
  sh(decoy, "commit", "-q", "-m", "decoy");
  return join(decoy, ".git");
}

describe("checking a worktree the session wrote", () => {
  test("a repository's fsmonitor never runs, and the answer is still right", async () => {
    const { cwd, run, marker, script, touch } = await repo();
    sh(cwd, "config", "core.fsmonitor", script);
    // The vector is live: git with no overrides runs it.
    await touch();
    naiveStatus(cwd);
    expect(await exists(marker)).toBe(true);
    await rm(marker);

    await touch();
    expect(await worktreeStatus(run)).toMatchObject({ dirty: false });
    await writeFile(join(cwd, "a.txt"), "hello\nchanged\n");
    expect(await worktreeStatus(run)).toMatchObject({ dirty: true });
    expect(await exists(marker)).toBe(false);
  });

  test("a clean filter the repository names never runs, whatever it is called", async () => {
    const { cwd, run, marker, script, touch } = await repo();
    await writeFile(join(cwd, ".gitattributes"), "* filter=anything-at-all\n");
    sh(cwd, "add", ".gitattributes");
    sh(cwd, "commit", "-q", "-m", "attributes");
    // Configured after the commit, as a session would: from here git runs it on status.
    sh(cwd, "config", "filter.anything-at-all.clean", script);
    sh(cwd, "config", "filter.anything-at-all.process", script);
    sh(cwd, "config", "filter.anything-at-all.required", "true");
    await touch();
    naiveStatus(cwd);
    expect(await exists(marker)).toBe(true);
    await rm(marker);

    await touch();
    expect(await worktreeStatus(run)).toMatchObject({ dirty: false });
    await writeFile(join(cwd, "a.txt"), "hello\nchanged\n");
    expect(await worktreeStatus(run)).toMatchObject({ dirty: true });
    expect(await exists(marker)).toBe(false);
  });

  test("a hook the repository installs never runs", async () => {
    const { main, cwd, run, marker, touch } = await repo();
    // A worktree's hooks are the repository's.
    const hooks = join(main, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    await writeFile(join(hooks, "post-index-change"), `#!/bin/sh\necho ran >> "${marker}"\n`);
    await chmod(join(hooks, "post-index-change"), 0o755);
    // The vector is live: a status free to rewrite the index runs the hook.
    await touch();
    const { GIT_OPTIONAL_LOCKS: _, ...locking } = gitEnv();
    Bun.spawnSync(["git", "-C", cwd, "status", "--porcelain"], { env: locking as Record<string, string> });
    expect(await exists(marker)).toBe(true);
    await rm(marker);

    await touch();
    expect(await worktreeStatus(run)).toMatchObject({ dirty: false });
    await writeFile(join(cwd, "a.txt"), "hello\nchanged\n");
    expect(await worktreeStatus(run)).toMatchObject({ dirty: true });
    expect(await exists(marker)).toBe(false);
  });

  test("git runs with a minimal environment: no daemon secrets, no user or system config", async () => {
    const { root, run, marker, script } = await repo();
    const real = Bun.which("git");
    if (!real) throw new Error("git is not on PATH");
    const bin = join(root, "bin");
    const seen = join(root, "env");
    await Bun.write(join(bin, "git"), `#!/bin/sh\nenv >> "${seen}"\nexec "${real}" "$@"\n`);
    await chmod(join(bin, "git"), 0o755);
    const saved = { ...process.env };
    process.env.PATH = `${bin}:${saved.PATH ?? ""}`;
    process.env.PASEO_DAEMON_TOKEN = "secret-token";
    process.env.GIT_CONFIG_PARAMETERS = `'core.fsmonitor=${script}'`;
    process.env.GIT_DIR = "/elsewhere";
    try {
      expect(await worktreeStatus(run)).toMatchObject({ dirty: false });
    } finally {
      for (const name of ["PATH", "PASEO_DAEMON_TOKEN", "GIT_CONFIG_PARAMETERS", "GIT_DIR"]) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
    const recorded = await readFile(seen, "utf8");
    expect(recorded).not.toContain("secret-token");
    expect(recorded).not.toContain("GIT_CONFIG_PARAMETERS");
    expect(recorded).not.toContain("GIT_DIR=");
    for (const line of ["HOME=/nonexistent", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "LANG=C"]) {
      expect(recorded).toContain(line);
    }
    expect(await exists(marker)).toBe(false);
  });

  test("a git that does not answer in time is 'cannot check', not a hang", async () => {
    const { root, run } = await repo();
    const bin = join(root, "bin");
    await Bun.write(join(bin, "git"), "#!/bin/sh\nsleep 30\n");
    await chmod(join(bin, "git"), 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved ?? ""}`;
    const started = Date.now();
    try {
      const result = await worktreeStatus(run, 300);
      expect(result).toEqual({ error: "the repository cannot be read: git did not answer within 0.3s" });
    } finally {
      process.env.PATH = saved;
    }
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a worktree with submodules is not checked: they are repositories with config of their own", async () => {
    const { cwd, run } = await repo();
    const head = sh(cwd, "rev-parse", "HEAD").trim();
    sh(cwd, "update-index", "--add", "--cacheinfo", `160000,${head},vendor/lib`);
    sh(cwd, "commit", "-q", "-m", "a gitlink");
    expect(await worktreeStatus(run)).toEqual({ error: "it has submodules, which are not checked" });
  });

  test("staged changes and untracked files count as uncommitted; a folder that is no repository cannot be checked", async () => {
    const staged = await repo();
    await writeFile(join(staged.cwd, "b.txt"), "new\n");
    sh(staged.cwd, "add", "b.txt");
    expect(await worktreeStatus(staged.run)).toMatchObject({ dirty: true });
    const untracked = await repo();
    await writeFile(join(untracked.cwd, "notes.txt"), "draft\n");
    expect(await worktreeStatus(untracked.run)).toMatchObject({ dirty: true });
    const result = await worktreeStatus({ ...untracked.run, repo: untracked.root });
    expect("error" in result && result.error).toContain("not a git repository");
  });

  test("a worktree git recorded with relative paths reads the same: clean, then dirty", async () => {
    const { cwd, run } = await repo({ relative: true });
    expect(await worktreeStatus(run)).toMatchObject({ dirty: false });
    await writeFile(join(cwd, "notes.txt"), "draft\n");
    expect(await worktreeStatus(run)).toMatchObject({ dirty: true });
  });

  test("a commit changes the digest, so two reads either side of it differ", async () => {
    const { cwd, run } = await repo();
    const before = await worktreeStatus(run);
    expect(await worktreeStatus(run)).toEqual(before);
    await writeFile(join(cwd, "b.txt"), "b\n");
    sh(cwd, "add", "b.txt");
    sh(cwd, "commit", "-q", "-m", "b");
    const after = await worktreeStatus(run);
    expect(after).toMatchObject({ dirty: false });
    expect(after).not.toEqual(before);
  });
});

describe("git is pinned to the run's own entry in the repository", () => {
  test("a .git pointed at a decoy whose commit matches the folder is 'cannot check', not clean", async () => {
    const { root, cwd, run } = await repo();
    await writeFile(join(cwd, "notes.txt"), "not committed\n");
    const decoy = await decoyOf(root, { "a.txt": "hello\n", "notes.txt": "not committed\n" });
    await writeFile(join(cwd, ".git"), `gitdir: ${decoy}\n`);
    // The attack is live: git that follows the folder's .git reads the uncommitted work as clean.
    expect(sh(cwd, "status", "--porcelain")).toBe("");
    expect(await worktreeStatus(run)).toEqual({ error: "its .git does not point at its own entry in the repository" });
  });

  test("git never reads the folder's .git: one that points at a decoy only while git runs changes nothing", async () => {
    const { root, cwd, run } = await repo();
    await writeFile(join(cwd, "notes.txt"), "not committed\n");
    const decoy = await decoyOf(root, { "a.txt": "hello\n", "notes.txt": "not committed\n" });
    const own = join(root, "own-pointer");
    const swapped = join(root, "decoy-pointer");
    await cp(join(cwd, ".git"), own);
    await writeFile(swapped, `gitdir: ${decoy}\n`);
    const real = Bun.which("git");
    if (!real) throw new Error("git is not on PATH");
    // Every git call in the worktree (all but finding the repository) runs with the folder pointed at the decoy.
    const bin = join(root, "bin");
    await Bun.write(
      join(bin, "git"),
      [
        "#!/bin/sh",
        `case "$*" in *rev-parse*) exec "${real}" "$@";; esac`,
        `cp "${swapped}" "${cwd}/.git"`,
        `"${real}" "$@"`,
        "code=$?",
        `cp "${own}" "${cwd}/.git"`,
        "exit $code",
        "",
      ].join("\n"),
    );
    await chmod(join(bin, "git"), 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved ?? ""}`;
    try {
      expect(await worktreeStatus(run)).toMatchObject({ dirty: true });
    } finally {
      process.env.PATH = saved;
    }
    expect(await readFile(join(cwd, ".git"), "utf8")).toBe(await readFile(own, "utf8"));
  });

  test("a worktree that left its branch is 'cannot check': a commit on no branch would go with the folder", async () => {
    const { cwd, run } = await repo();
    sh(cwd, "switch", "-q", "--detach");
    await writeFile(join(cwd, "b.txt"), "on no branch\n");
    sh(cwd, "add", "b.txt");
    sh(cwd, "commit", "-q", "-m", "detached");
    // Clean as git sees it, but removing the worktree orphans the commit.
    expect(sh(cwd, "status", "--porcelain")).toBe("");
    expect(await worktreeStatus(run)).toEqual({ error: `it is not on its branch ${run.branch}` });
    sh(cwd, "switch", "-q", "-c", "elsewhere");
    expect(await worktreeStatus(run)).toEqual({ error: `it is not on its branch ${run.branch}` });
  });

  test("an entry that leads to another repository, or two entries for one folder, is 'cannot check'", async () => {
    const elsewhere = await repo();
    const { root, main, run } = await repo();
    const entries = join(main, ".git", "worktrees");
    const [name] = await readdir(entries);
    const entry = join(entries, name as string);
    const commondir = await readFile(join(entry, "commondir"), "utf8");
    await writeFile(join(entry, "commondir"), `${join(elsewhere.main, ".git")}\n`);
    expect(await worktreeStatus(run)).toEqual({ error: "its entry in the repository leads to another repository" });
    await writeFile(join(entry, "commondir"), commondir);
    expect(await worktreeStatus(run)).toMatchObject({ dirty: false });
    await cp(entry, join(entries, "copy"), { recursive: true });
    expect(await worktreeStatus(run)).toEqual({ error: "the repository names this folder as more than one worktree" });
    await rm(join(entries, "copy"), { recursive: true });
    expect(await worktreeStatus({ ...run, cwd: root })).toEqual({
      error: "the repository has no worktree at this folder",
    });
  });
});
