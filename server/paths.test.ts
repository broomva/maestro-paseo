import { describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  ASKS_DIR,
  broomvaHome,
  controlAskPaths,
  controlRepoPaths,
  fleetPaths,
  launchAgentsDir,
  lockRootBeside,
  p9Dir,
  verbWindowMs,
  workLockRoot,
} from "./paths";

describe("every path Maestro writes or reads comes from here, and honours its override (BRO-2997)", () => {
  test("LaunchAgents, p9 and the loop home: the override when named, the default otherwise", () => {
    expect(launchAgentsDir({})).toBe(join(homedir(), "Library", "LaunchAgents"));
    expect(launchAgentsDir({ MAESTRO_PASEO_FLEET_AGENTS: "/x/agents" })).toBe("/x/agents");
    expect(launchAgentsDir({ MAESTRO_PASEO_FLEET_AGENTS: "~/agents" })).toBe(join(homedir(), "agents"));
    expect(fleetPaths({ MAESTRO_PASEO_FLEET_AGENTS: "/x/agents" }).agents).toBe("/x/agents");
    expect(p9Dir({})).toBe(join(homedir(), ".config", "broomva", "p9"));
    expect(p9Dir({ MAESTRO_PASEO_P9_DIR: "/x/p9" })).toBe("/x/p9");
    expect(broomvaHome({})).toBe(join(homedir(), ".broomva"));
    expect(broomvaHome({ BROOMVA_HOME: "~/elsewhere" })).toBe(join(homedir(), "elsewhere"));
  });

  test("locks sit beside what they guard; the asks folder is defined once", () => {
    expect(lockRootBeside("/s/state/asks.jsonl")).toBe("/s/state/.locks");
    expect(workLockRoot("/w/maestro")).toBe("/w/maestro/.locks");
    expect(ASKS_DIR).toBe(join(".control", "asks"));
  });
});

describe("the owner's control repo and receipts are never a test's by default", () => {
  test("outside a test: ~/broomva, its answers worktree and receipts under ~/.local/state", () => {
    expect(controlRepoPaths({})).toEqual({
      repo: join(homedir(), "broomva"),
      answers: join(homedir(), ".local", "state", "maestro-paseo", "control-answers"),
    });
    expect(controlAskPaths({}).receipts).toBe(join(homedir(), ".local", "state", "maestro-paseo", "asks.jsonl"));
  });

  test("under bun test, naming none: no control repo, and receipts and answers in a scratch folder", () => {
    const env = { NODE_ENV: "test" };
    const paths = controlRepoPaths(env);
    expect(paths.repo).toBeNull();
    expect(paths.answers.startsWith(tmpdir())).toBe(true);
    const asks = controlAskPaths(env);
    expect([asks.receipts.startsWith(tmpdir()), asks.locks.startsWith(tmpdir())]).toEqual([true, true]);
  });

  test("a test that names its own gets its own", () => {
    const env = {
      NODE_ENV: "test",
      MAESTRO_PASEO_CONTROL_REPO: "/x/repo",
      MAESTRO_PASEO_CONTROL_ANSWERS: "/x/answers",
      MAESTRO_PASEO_ASK_RECEIPTS: "/x/asks.jsonl",
    };
    expect(controlRepoPaths(env)).toEqual({ repo: "/x/repo", answers: "/x/answers" });
    expect(controlAskPaths(env).receipts).toBe("/x/asks.jsonl");
  });
});

describe("the undo window cannot be taken away outside a test (BRO-2999, B4)", () => {
  test("a daemon keeps its 8 s whatever the variable says; only a test may shorten it", () => {
    for (const value of ["0", "1", "100", "8000"]) {
      expect(verbWindowMs({ MAESTRO_PASEO_VERB_WINDOW_MS: value })).toBeUndefined();
      expect(verbWindowMs({ MAESTRO_PASEO_VERB_WINDOW_MS: value, NODE_ENV: "production" })).toBeUndefined();
    }
    expect(verbWindowMs({ NODE_ENV: "test", MAESTRO_PASEO_VERB_WINDOW_MS: "0" })).toBe(0);
    expect(verbWindowMs({ NODE_ENV: "test", MAESTRO_PASEO_VERB_WINDOW_MS: "250" })).toBe(250);
    expect(verbWindowMs({ NODE_ENV: "test", MAESTRO_PASEO_VERB_WINDOW_MS: "-5" })).toBeUndefined();
    expect(verbWindowMs({ NODE_ENV: "test" })).toBeUndefined();
  });
});
