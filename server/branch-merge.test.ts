import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IllegalTransitionError, transition } from "../shared/states";
import { branchMerged, gitOf, MERGED_EVERY_MS, mergedPrs, repoOf, WATCH_STUCK_MS, watchedBranch } from "./branch-merge";
import type { WorkEvent } from "./events";

const ADOPTED = "2026-10-08T00:00:00Z";
const STOPPED = "2026-10-08T01:00:00Z";
const NOW = Date.parse("2026-10-08T02:00:00Z");
const bind = (extra: Record<string, unknown> = {}): WorkEvent =>
  ({
    ts: ADOPTED,
    type: "adopted",
    actor: "agent",
    by: "orchestrator",
    agentId: "a",
    workspaceId: null,
    provider: "claude",
    branch: "feature/x",
    cwd: "/w",
    githubRepo: "acme/app",
    ...extra,
  }) as unknown as WorkEvent;
const stopped = (reason: string, ts = STOPPED): WorkEvent =>
  ({ ts, type: "state", actor: "maestro", from: "running", to: "blocked", reason }) as WorkEvent;
const ENDED = "The session was archived before it finished";
const PR = { number: 9, mergedAt: "2026-10-08T00:30:00Z" };
const ROW = { ...PR, isCrossRepository: false };

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("the evidence a branch merged", () => {
  test("repoOf reads GitHub https and ssh remotes (a token is dropped), and nothing else", () => {
    expect(
      [
        "https://github.com/acme/app.git",
        "git@github.com:acme/app.git",
        "https://x-token:secret@github.com/acme/app",
        "https://evilgithub.com/acme/app.git",
        "https://gitlab.com/acme/app.git",
        null,
      ].map(repoOf),
    ).toEqual(["acme/app", "acme/app", "acme/app", null, null, null]);
  });

  test("only an agent's adoption, stopped because its session ended, untouched since, is watched", () => {
    const base = [bind(), stopped(ENDED)];
    expect(watchedBranch(base, NOW)).toEqual({ repo: "acme/app", branch: "feature/x" });
    expect(watchedBranch([bind(), stopped("rate limited")], NOW)).toBeNull();
    expect(watchedBranch([bind({ actor: "human", by: null }), stopped(ENDED)], NOW)).toBeNull();
    expect(watchedBranch([{ ...bind(), type: "dispatched" } as WorkEvent, stopped(ENDED)], NOW)).toBeNull();
    expect(watchedBranch([bind({ branch: null }), stopped(ENDED)], NOW)).toBeNull();
    expect(watchedBranch([bind({ githubRepo: null }), stopped(ENDED)], NOW)).toBeNull();
    const touched = [...base, { ts: "2026-10-08T01:30:00Z", type: "note", actor: "human", text: "mine" } as WorkEvent];
    expect(watchedBranch(touched, NOW)).toBeNull();
    // A Send back before it stopped makes it yours too, not only an action after.
    const sentBack = [
      bind(),
      { ts: "2026-10-08T00:20:00Z", type: "note", actor: "human", text: "Do not merge: change X first" } as WorkEvent,
      stopped(ENDED),
    ];
    expect(watchedBranch(sentBack, NOW)).toBeNull();
    const moved = [...base, { ...stopped(ENDED), from: "blocked", to: "running", reason: null } as WorkEvent];
    expect(watchedBranch(moved, NOW)).toBeNull();
    // The reason alone is not enough: the last move must be into Stuck.
    expect(watchedBranch([bind(), { ...stopped(ENDED), to: "review" } as WorkEvent], NOW)).toBeNull();
  });

  test("it is watched for WATCH_STUCK_MS after it stopped, and no longer", () => {
    const base = [bind(), stopped(ENDED)];
    expect(watchedBranch(base, Date.parse(STOPPED) + WATCH_STUCK_MS - 1)).not.toBeNull();
    expect(watchedBranch(base, Date.parse(STOPPED) + WATCH_STUCK_MS)).toBeNull();
  });

  test("it closes only on a PR merged after the adoption, never at the same instant or before", () => {
    const base = [bind(), stopped(ENDED)];
    expect(branchMerged(base, PR, NOW)).toEqual({ branch: "feature/x", repo: "acme/app", number: 9 });
    expect(branchMerged(base, { number: 9, mergedAt: ADOPTED }, NOW)).toBeNull();
    expect(branchMerged(base, { number: 9, mergedAt: "2026-10-07T23:00:00Z" }, NOW)).toBeNull();
    expect(branchMerged(base, null, NOW)).toBeNull();
  });

  test("blocked work closes Done only with branchMerged", () => {
    expect(transition("blocked", "done", { gate: "human", branchMerged: true })).toBe("done");
    expect(() => transition("blocked", "done", { gate: "human" })).toThrow(IllegalTransitionError);
  });
});

describe("reading the worktree", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    })
      .toString()
      .trim();

  test("a separate worktree gives its branch and repo; a shared checkout and a detached HEAD give none", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "maestro-branch-")));
    roots.push(root);
    const main = join(root, "main");
    git(root, "init", "-q", "-b", "main", main);
    git(main, "commit", "-q", "--allow-empty", "-m", "first");
    git(main, "remote", "add", "origin", "https://x-token:secret@github.com/acme/app.git");
    const tree = join(root, "tree");
    git(main, "worktree", "add", "-q", "-b", "feature/x", tree);
    const detached = join(root, "detached");
    git(main, "worktree", "add", "-q", "--detach", detached);
    // A subdirectory of the shared checkout, reached through a symlink: still the shared checkout.
    await mkdir(join(main, "sub"));
    const linked = join(root, "linked");
    await symlink(join(main, "sub"), linked);
    expect([
      await gitOf(tree),
      await gitOf(main),
      await gitOf(detached),
      await gitOf(linked),
      await gitOf(null),
    ]).toEqual([
      { branch: "feature/x", githubRepo: "acme/app" },
      { branch: null, githubRepo: null },
      { branch: null, githubRepo: "acme/app" },
      { branch: null, githubRepo: null },
      { branch: null, githubRepo: null },
    ]);
  });
});

describe("asking gh", () => {
  /** A gh double: merged PRs by head branch, and the branches some PR targets as its base. */
  const gh = (merged: Record<string, unknown[]>, bases: string[], fail = false) => {
    const calls: string[][] = [];
    const run = async (args: readonly string[]) => {
      calls.push([...args]);
      if (fail) throw new Error("gh: not logged in");
      const at = (flag: string) => args[args.indexOf(flag) + 1] ?? "";
      if (args.includes("--base")) return JSON.stringify(bases.includes(at("--base")) ? [{ number: 1 }] : []);
      return JSON.stringify(merged[at("--head")] ?? []);
    };
    return { run, calls };
  };

  test("it never waits on gh: null now, the answer once asked, asked again after MERGED_EVERY_MS", async () => {
    let at = 0;
    const { run, calls } = gh({ "feature/x": [ROW] }, []);
    const lookup = mergedPrs(run, () => at);
    expect(await lookup("acme/app", "feature/x")).toBeNull();
    await lookup.settled();
    expect([await lookup("acme/app", "feature/x"), calls.length]).toEqual([PR, 2]);
    at = MERGED_EVERY_MS;
    await lookup("acme/app", "feature/x");
    await lookup.settled();
    expect(calls.length).toBe(4);
  });

  test("a failure is remembered like an answer: gh is not asked again until MERGED_EVERY_MS", async () => {
    const logged: string[] = [];
    const { run, calls } = gh({}, [], true);
    const lookup = mergedPrs(
      run,
      () => 0,
      (message) => logged.push(message),
    );
    await lookup("acme/app", "feature/x");
    await lookup.settled();
    await lookup("acme/app", "feature/x");
    await lookup.settled();
    expect([calls.length, logged.length, await lookup("acme/app", "feature/x")]).toEqual([2, 1, null]);
  });

  test("a branch some PR targets as its base (dev, main) never counts, though its promotions merged", async () => {
    const { run } = gh({ dev: [{ number: 3, mergedAt: PR.mergedAt, isCrossRepository: false }], "feature/x": [ROW] }, [
      "dev",
    ]);
    const lookup = mergedPrs(run, () => 0);
    await lookup("acme/app", "dev");
    await lookup("acme/app", "feature/x");
    await lookup.settled();
    expect([await lookup("acme/app", "dev"), await lookup("acme/app", "feature/x")]).toEqual([null, PR]);
  });
});

test("a fork's PR with the same branch name is someone else's: only one from the repo itself counts", async () => {
  const run = async (args: readonly string[]) =>
    JSON.stringify(
      args.includes("--base")
        ? []
        : [
            { number: 11, mergedAt: "2026-10-08T00:40:00Z", isCrossRepository: true },
            { ...ROW, number: 9 },
          ],
    );
  const lookup = mergedPrs(run, () => 0);
  await lookup("acme/app", "feature/x");
  await lookup.settled();
  expect(await lookup("acme/app", "feature/x")).toEqual(PR);
});
