import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEnv, runCheck, runChecks } from "./checks";

const check = (run: string, extra: Partial<{ timeoutS: number; required: boolean }> = {}) => ({
  name: "c",
  run,
  timeoutS: extra.timeoutS ?? 10,
  required: extra.required ?? true,
});

describe("checks", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "maestro-checks-"));

  test("exit code decides, output tail is kept", async () => {
    const pass = await runCheck(check("echo hello"), cwd);
    expect(pass).toMatchObject({ ok: true, exit: 0, timedOut: false });
    expect(pass.tail).toContain("hello");
    const fail = await runCheck(check("echo boom >&2; exit 3"), cwd);
    expect(fail).toMatchObject({ ok: false, exit: 3 });
    expect(fail.tail).toContain("boom");
  });

  test("runs in the run directory", async () => {
    const result = await runCheck(check("pwd"), cwd);
    expect(result.tail).toContain(cwd.split("/").pop() ?? "");
  });

  test("a hung check times out and fails", async () => {
    const result = await runCheck(check("sleep 5", { timeoutS: 0.2 }), cwd);
    expect(result).toMatchObject({ ok: false, timedOut: true });
  });

  test("the daemon's credentials never reach a check", async () => {
    expect(checkEnv({ PATH: "/bin", HOME: "/h", PASEO_PASSWORD: "x", ANTHROPIC_API_KEY: "k" })).toEqual({
      CI: "1",
      PATH: "/bin",
      HOME: "/h",
    });
    process.env.MAESTRO_TEST_SECRET = "leak";
    const result = await runCheck(check('echo "secret=[$MAESTRO_TEST_SECRET]"'), cwd);
    delete process.env.MAESTRO_TEST_SECRET;
    expect(result.tail).toContain("secret=[]");
  });

  test("the first required failure stops the list, advisory failures do not", async () => {
    const results = await runChecks([check("exit 1", { required: false }), check("exit 2"), check("echo never")], cwd);
    expect(results.map((r) => r.exit)).toEqual([1, 2]);
  });
});
