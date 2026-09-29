// The harness's safety rules: never hand a child the real daemon's
// environment, never delete a directory it did not make, and stop waiting as
// soon as the thing waited on is known to be dead.

import { afterEach, describe, expect, test } from "bun:test";
import { ancestors, type DogfoodState, deletable, Fatal, MARKER, sandboxEnv, sandboxProcesses, waitFor } from "./lib";

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe("sandboxEnv", () => {
  test("drops every PASEO_* and MAESTRO_PASEO_* variable, then adds the sandbox's own", () => {
    process.env.PASEO_HOME = "/Users/someone/.paseo";
    process.env.PASEO_AGENT_ID = "6d1930cd";
    process.env.PASEO_AGENT_CWD = "/somewhere";
    process.env.MAESTRO_PASEO_CONFIG = "/Users/someone/.config/maestro-paseo/config.json";
    process.env.KEEP_ME = "yes";
    const env = sandboxEnv({ MAESTRO_PASEO_CONFIG: "/tmp/maestro-dogfood-x/maestro/config.json" });
    expect(Object.keys(env).filter((key) => key.startsWith("PASEO_"))).toEqual([]);
    expect(env.MAESTRO_PASEO_CONFIG).toBe("/tmp/maestro-dogfood-x/maestro/config.json");
    expect(env.KEEP_ME).toBe("yes");
  });
});

describe("deletable", () => {
  const state = (dir: string): DogfoodState => ({
    marker: MARKER,
    dir,
    paseoHome: `${dir}/paseo-home`,
    home: `${dir}/home`,
    maestroConfig: `${dir}/maestro/config.json`,
    socket: `${dir}/maestro/maestro.sock`,
    workRoot: `${dir}/work`,
    pluginDir: "/plugin",
    port: 1,
    url: "http://127.0.0.1:1",
    serverId: null,
    daemonPid: null,
    log: `${dir}/daemon.log`,
    startedAt: "",
  });

  test("allows only a marked mktemp sandbox under a temp root", () => {
    expect(deletable("/private/tmp/maestro-dogfood-AbC123", state("/private/tmp/maestro-dogfood-AbC123"))).toBe(true);
    expect(deletable("/Users/someone/maestro", state("/Users/someone/maestro"))).toBe(false);
    expect(deletable("/private/tmp/other-AbC123", state("/private/tmp/other-AbC123"))).toBe(false);
    expect(deletable("/private/tmp/maestro-dogfood-AbC123", null)).toBe(false);
    expect(deletable("/private/tmp/maestro-dogfood-AbC123", state("/private/tmp/maestro-dogfood-Other"))).toBe(false);
  });
});

describe("sandboxProcesses", () => {
  const sandbox = {
    dir: "/private/tmp/maestro-dogfood-AbC123",
    paseoHome: "/private/tmp/maestro-dogfood-AbC123/paseo-home",
  };
  const proc = (pid: number, ppid: number, command: string) => ({ pid, ppid, pgid: pid, command });
  const helper = "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper";
  const table = [
    // The caller's own shell line named the sandbox; down.ts once killed it (exit 144).
    proc(100, 1, "zsh -c ls /private/tmp/maestro-dogfood-AbC123; bun scripts/dogfood/down.ts"),
    proc(101, 100, "zsh -c ls /private/tmp/maestro-dogfood-AbC123; bun scripts/dogfood/down.ts"),
    proc(102, 101, "bun scripts/dogfood/down.ts"),
    proc(200, 1, `${helper} node-script cli.js daemon run --home /private/tmp/maestro-dogfood-AbC123/paseo-home`),
    proc(201, 200, "/Users/x/.bun/bin/bun /private/tmp/maestro-dogfood-AbC123/bin/fake-acp.ts"),
    proc(
      300,
      1,
      "Google Chrome for Testing --headless=new --user-data-dir=/private/tmp/maestro-dogfood-AbC123/chrome-1",
    ),
    proc(400, 1, "tail -f /private/tmp/maestro-dogfood-AbC123/daemon.log"),
    proc(500, 1, `${helper} node-script cli.js daemon run --home /private/tmp/maestro-dogfood-XyZ789/paseo-home`),
  ];

  test("finds the daemon, the stand-in agents and the browser, nothing that merely names the sandbox", () => {
    expect(sandboxProcesses(sandbox, table, 102).map((p) => p.pid)).toEqual([200, 201, 300]);
  });

  test("never includes the caller or an ancestor, even one whose command line carries a signature", () => {
    const withSignature = [
      proc(100, 1, "zsh -c bun shot.ts --chrome x --user-data-dir=/private/tmp/maestro-dogfood-AbC123/p"),
      ...table.slice(1),
    ];
    const found = sandboxProcesses(sandbox, withSignature, 102).map((p) => p.pid);
    expect(found).not.toContain(100);
    expect(found).not.toContain(101);
    expect(found).not.toContain(102);
    expect([...ancestors(withSignature, 102)].sort()).toEqual([100, 101, 102]);
  });
});

describe("waitFor", () => {
  test("a Fatal from the probe stops the wait at once", async () => {
    const started = Date.now();
    const probe = async (): Promise<boolean> => {
      throw new Fatal("the daemon exited");
    };
    await expect(waitFor("the daemon", probe, 10_000, 50)).rejects.toThrow("the daemon exited");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("any other error is retried until the probe answers", async () => {
    let calls = 0;
    const value = await waitFor(
      "a flaky probe",
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("not yet");
        return "ready";
      },
      5000,
      10,
    );
    expect(value).toBe("ready");
    expect(calls).toBe(3);
  });
});
