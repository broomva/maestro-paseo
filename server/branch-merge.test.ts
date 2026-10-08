import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IllegalTransitionError, transition } from "../shared/states";
import {
  archivedBetweenTurns,
  branchMerged,
  gitOf,
  MERGED_EVERY_MS,
  mergedPrs,
  repoOf,
  WATCH_STUCK_MS,
  watchedBranch,
} from "./branch-merge";
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

test("a cached answer is dropped once WATCH_STUCK_MS old: it is asked again, not served", async () => {
  let at = 0;
  const run = async (args: readonly string[]) => JSON.stringify(args.includes("--base") ? [] : [ROW]);
  const lookup = mergedPrs(run, () => at);
  await lookup("acme/app", "feature/x");
  await lookup.settled();
  at = WATCH_STUCK_MS;
  expect(await lookup("acme/app", "feature/x")).toBeNull();
});

test("git that echoes --path-format back (older than 2.31) records nothing", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "maestro-oldgit-")));
  roots.push(root);
  const real = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
  const main = join(root, "main");
  const tree = join(root, "tree");
  execFileSync(real, ["init", "-q", "-b", "main", main]);
  execFileSync(real, [
    "-C",
    main,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "first",
  ]);
  execFileSync(real, ["-C", main, "remote", "add", "origin", "https://github.com/acme/app.git"]);
  execFileSync(real, ["-C", main, "worktree", "add", "-q", "-b", "feature/x", tree]);
  const bin = join(root, "bin");
  await mkdir(bin);
  // As git before 2.31 does: an unknown --path-format is printed back as-is, and the rest still runs.
  await writeFile(
    join(bin, "git"),
    `#!/bin/bash\nout=(); hit=0\nfor a in "$@"; do if [ "$a" = "--path-format=absolute" ]; then hit=1; else out+=("$a"); fi; done\n[ $hit = 1 ] && echo "--path-format=absolute"\nexec ${real} "\${out[@]}"\n`,
    { mode: 0o755 },
  );
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before}`;
  try {
    // A linked worktree of its own, so the test holds wherever the suite runs: in a plain clone (CI) both git
    // dirs are ".git" and compare equal before the absolute-path check matters (P20 round 4).
    expect(await gitOf(tree)).toEqual({ branch: null, githubRepo: null });
  } finally {
    process.env.PATH = before;
  }
});

describe("an orchestrator's child archived between turns (BRO-2928)", () => {
  const turn = (type: "turn.started" | "turn.ended", ts: string, outcome = "completed"): WorkEvent =>
    (type === "turn.started"
      ? { ts, type, actor: "agent", agentId: "a" }
      : {
          ts,
          type,
          actor: "agent",
          agentId: "a",
          outcome,
          error: null,
          summary: "Step done.",
          turnId: null,
        }) as WorkEvent;
  const ended = turn("turn.ended", "2026-10-08T00:50:00Z");
  const started = turn("turn.started", "2026-10-08T00:40:00Z");

  test("closes only an agent's adoption, archived after a turn that ended cleanly, untouched by you", () => {
    expect(archivedBetweenTurns([bind(), started, ended, stopped(ENDED)], NOW)).toBe(true);
    // Archived mid-turn: a turn started after the last end, so something was cut off.
    expect(
      archivedBetweenTurns([bind(), ended, turn("turn.started", "2026-10-08T00:55:00Z"), stopped(ENDED)], NOW),
    ).toBe(false);
    // The last turn failed or was stopped: that is a reason to look, not a close.
    expect(
      archivedBetweenTurns(
        [bind(), started, turn("turn.ended", "2026-10-08T00:50:00Z", "failed"), stopped(ENDED)],
        NOW,
      ),
    ).toBe(false);
    // Interrupted (canceled): not a clean end either.
    const interrupted = turn("turn.ended", "2026-10-08T00:50:00Z", "canceled");
    expect(archivedBetweenTurns([bind(), started, interrupted, stopped(ENDED)], NOW)).toBe(false);
    // No turn since the adoption: nothing says it was between turns, whatever ended before it was adopted.
    expect(archivedBetweenTurns([bind(), stopped(ENDED)], NOW)).toBe(false);
    const before = turn("turn.ended", "2026-10-07T23:00:00Z");
    expect(archivedBetweenTurns([before, bind(), stopped(ENDED)], NOW)).toBe(false);
  });

  test("never your own work, never once you touched it, never a session that merely ended, never a stale card", () => {
    expect(archivedBetweenTurns([bind({ actor: "human", by: null }), started, ended, stopped(ENDED)], NOW)).toBe(false);
    expect(
      archivedBetweenTurns([{ ...bind(), type: "dispatched" } as WorkEvent, started, ended, stopped(ENDED)], NOW),
    ).toBe(false);
    const note = { ts: "2026-10-08T00:45:00Z", type: "note", actor: "human", text: "mine" } as WorkEvent;
    expect(archivedBetweenTurns([bind(), started, note, ended, stopped(ENDED)], NOW)).toBe(false);
    expect(
      archivedBetweenTurns([bind(), started, ended, stopped("The session ended before the run finished")], NOW),
    ).toBe(false);
    expect(archivedBetweenTurns([bind(), started, ended, stopped(ENDED)], Date.parse(STOPPED) + WATCH_STUCK_MS)).toBe(
      false,
    );
  });
});
