import { describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { controlAskPaths, controlRepoPaths, verbWindowMs } from "./paths";

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
