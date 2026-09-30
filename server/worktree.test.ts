import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv, worktreeStatus } from "./worktree";

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

/** A repository with one committed file, and a script that leaves a marker when anything runs it. */
async function repo() {
  const root = await mkdtemp(join(tmpdir(), "maestro-worktree-"));
  roots.push(root);
  const cwd = join(root, "repo");
  sh(root, "init", "-q", cwd);
  await writeFile(join(cwd, "a.txt"), "hello\n");
  sh(cwd, "add", "a.txt");
  sh(cwd, "commit", "-q", "-m", "init");
  const marker = join(root, "ran");
  const script = join(root, "hostile.sh");
  await writeFile(script, `#!/bin/sh\necho ran >> "${marker}"\ncat\n`);
  await chmod(script, 0o755);
  /** Change a.txt's stat without changing its content, so git has to look at the file again. */
  const touch = async () => {
    const later = new Date(Date.now() + 60_000 * Math.ceil(Math.random() * 100));
    await utimes(join(cwd, "a.txt"), later, later);
  };
  return { root, cwd, marker, script, touch };
}

describe("checking a worktree the session wrote", () => {
  test("a repository's fsmonitor never runs, and the answer is still right", async () => {
    const { cwd, marker, script, touch } = await repo();
    sh(cwd, "config", "core.fsmonitor", script);
    // The vector is live: git with no overrides runs it.
    await touch();
    naiveStatus(cwd);
    expect(await exists(marker)).toBe(true);
    await rm(marker);

    await touch();
    expect(await worktreeStatus(cwd)).toEqual({ dirty: false });
    await writeFile(join(cwd, "a.txt"), "hello\nchanged\n");
    expect(await worktreeStatus(cwd)).toEqual({ dirty: true });
    expect(await exists(marker)).toBe(false);
  });

  test("a clean filter the repository names never runs, whatever it is called", async () => {
    const { cwd, marker, script, touch } = await repo();
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
    expect(await worktreeStatus(cwd)).toEqual({ dirty: false });
    await writeFile(join(cwd, "a.txt"), "hello\nchanged\n");
    expect(await worktreeStatus(cwd)).toEqual({ dirty: true });
    expect(await exists(marker)).toBe(false);
  });

  test("a hook the repository installs never runs", async () => {
    const { cwd, marker, touch } = await repo();
    const hooks = join(cwd, ".git", "hooks");
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
    expect(await worktreeStatus(cwd)).toEqual({ dirty: false });
    await writeFile(join(cwd, "a.txt"), "hello\nchanged\n");
    expect(await worktreeStatus(cwd)).toEqual({ dirty: true });
    expect(await exists(marker)).toBe(false);
  });

  test("git runs with a minimal environment: no daemon secrets, no user or system config", async () => {
    const { root, cwd, marker, script } = await repo();
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
      expect(await worktreeStatus(cwd)).toEqual({ dirty: false });
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
    const { root, cwd } = await repo();
    const bin = join(root, "bin");
    await Bun.write(join(bin, "git"), "#!/bin/sh\nsleep 30\n");
    await chmod(join(bin, "git"), 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved ?? ""}`;
    const started = Date.now();
    try {
      const result = await worktreeStatus(cwd, 300);
      expect(result).toEqual({ error: "git did not answer within 0.3s" });
    } finally {
      process.env.PATH = saved;
    }
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a worktree with submodules is not checked: they are repositories with config of their own", async () => {
    const { cwd } = await repo();
    const head = sh(cwd, "rev-parse", "HEAD").trim();
    sh(cwd, "update-index", "--add", "--cacheinfo", `160000,${head},vendor/lib`);
    sh(cwd, "commit", "-q", "-m", "a gitlink");
    expect(await worktreeStatus(cwd)).toEqual({ error: "it has submodules, which are not checked" });
  });

  test("staged changes and untracked files count as uncommitted; a folder that is no repository cannot be checked", async () => {
    const staged = await repo();
    await writeFile(join(staged.cwd, "b.txt"), "new\n");
    sh(staged.cwd, "add", "b.txt");
    expect(await worktreeStatus(staged.cwd)).toEqual({ dirty: true });
    const untracked = await repo();
    await writeFile(join(untracked.cwd, "notes.txt"), "draft\n");
    expect(await worktreeStatus(untracked.cwd)).toEqual({ dirty: true });
    const result = await worktreeStatus(untracked.root);
    expect("error" in result && result.error).toContain("not a git repository");
  });
});
