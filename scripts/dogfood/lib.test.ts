// The harness's safety rules: never hand a child the real daemon's
// environment, never delete a directory it did not make, and stop waiting as
// soon as the thing waited on is known to be dead.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ancestors,
  clearPointer,
  type DogfoodState,
  daemonGroup,
  deletable,
  Fatal,
  fileProblem,
  isDaemonOf,
  liveDaemon,
  MARKER,
  pointerProblem,
  readState,
  resolveStateDir,
  sandboxEnv,
  sandboxProcesses,
  waitFor,
  writeState,
} from "./lib";

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
    // Counted, not timed: a wall-clock bound failed on a loaded machine. Retrying would call the probe again.
    let calls = 0;
    const probe = async (): Promise<boolean> => {
      calls += 1;
      throw new Fatal("the daemon exited");
    };
    await expect(waitFor("the daemon", probe, 2000, 50)).rejects.toThrow("the daemon exited");
    expect(calls).toBe(1);
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

// The daemon's command line exactly as `ps -axww -o command=` printed it for a live sandbox (paseo 0.9.2):
// the wrapper execs the Electron helper with "$@" last.
const HOME = "/private/tmp/maestro-dogfood-F4CaCa/paseo-home";
const DAEMON_LINE =
  "/Applications/Paseo.app/Contents/Resources/../Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper " +
  "--disable-warning=DEP0040 /Applications/Paseo.app/Contents/Resources/app.asar.unpacked/dist/daemon/node-entrypoint-runner.js " +
  `node-script /Applications/Paseo.app/Contents/Resources/app.asar/node_modules/@getpaseo/cli/dist/index.js daemon run --home ${HOME}`;
const p = (pid: number, ppid: number, pgid: number, command: string) => ({ pid, ppid, pgid, command });

describe("isDaemonOf", () => {
  const is = (command: string) => isDaemonOf(p(1, 1, 1, command), { paseoHome: HOME });

  test("accepts the sandbox's own daemon invocation", () => {
    expect(is(DAEMON_LINE)).toBe(true);
    expect(is(`paseo daemon run --home ${HOME}`)).toBe(true);
  });

  test("rejects anything else that mentions the home", () => {
    expect(is(`paseo daemon run --home ${HOME}2`)).toBe(false);
    expect(is(`paseo daemon run --home ${HOME}/nested`)).toBe(false);
    expect(is(`paseo daemon start --home ${HOME}`)).toBe(false);
    expect(is(`paseo plugin install /plugin --home ${HOME}`)).toBe(false);
    expect(is(`zsh -c paseo daemon run --home ${HOME}; bun scripts/dogfood/down.ts`)).toBe(false);
    expect(is(`tail -f ${HOME}/daemon.log`)).toBe(false);
    expect(is("paseo daemon run --home /Users/someone/.paseo")).toBe(false);
    expect(is("Paseo Daemon")).toBe(false);
  });
});

describe("daemon selection", () => {
  const state = { daemonPid: 200, paseoHome: HOME };
  // The sandbox's tree as ps shows it: the runner (the recorded pid) leads its own group.
  const sandbox = [
    p(200, 1, 200, DAEMON_LINE),
    p(201, 200, 200, "Paseo Supervisor"),
    p(202, 201, 200, "Paseo Daemon"),
    p(
      203,
      202,
      200,
      "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper plugin-process.js",
    ),
    p(204, 202, 200, "/Users/x/.bun/bin/bun /private/tmp/maestro-dogfood-F4CaCa/bin/fake-acp.ts"),
  ];
  // The real daemon, started by launchd in a group of its own.
  const real = [p(89846, 1, 89846, "Paseo Supervisor"), p(89847, 89846, 89846, "Paseo Daemon")];
  const pids = (procs: readonly { pid: number }[]) => procs.map((proc) => proc.pid);

  test("selects the verified daemon's whole group and nothing outside it", () => {
    expect(pids(daemonGroup([...sandbox, ...real], state, new Set()))).toEqual([200, 201, 202, 203, 204]);
  });

  test("a process in the daemon's group but in the skip set is never selected", () => {
    const selected = pids(daemonGroup([...sandbox, ...real], state, new Set([203, 999])));
    expect(selected).toEqual([200, 201, 202, 204]);
  });

  test("a process whose pid is the group's id but whose own group differs is not selected", () => {
    // The recorded daemon is not a group leader here: it sits in group 150, and pid 150 is unrelated.
    const procs = [
      p(150, 1, 99, "vim notes.md"),
      p(300, 1, 150, `paseo daemon run --home ${HOME}`),
      p(301, 300, 150, "Paseo Supervisor"),
      p(302, 1, 300, "a process in a group numbered like the daemon's pid"),
    ];
    expect(pids(daemonGroup(procs, { daemonPid: 300, paseoHome: HOME }, new Set()))).toEqual([300, 301]);
  });

  test("the real daemon is never selected, even if the recorded pid now belongs to it", () => {
    // A reused pid (or an edited state file) points at the real daemon, whose group holds its supervisor.
    const reused = { daemonPid: 89847, paseoHome: HOME };
    expect(liveDaemon([...sandbox, ...real], reused)).toBeNull();
    expect(daemonGroup([...sandbox, ...real], reused, new Set())).toEqual([]);
  });

  test("a group member that is another Paseo daemon invocation is not selected, even with a matching group", () => {
    const procs = [
      ...sandbox,
      p(205, 1, 200, "paseo daemon run --home /Users/someone/.paseo"),
      p(206, 1, 200, "paseo daemon start"),
    ];
    expect(pids(daemonGroup(procs, state, new Set()))).toEqual([200, 201, 202, 203, 204]);
  });

  test("up.ts treats a sandbox as live only while its recorded pid runs its daemon", () => {
    expect(liveDaemon(sandbox, state)?.pid).toBe(200);
    expect(liveDaemon([p(200, 1, 200, "vim notes.md")], state)).toBeNull();
    expect(liveDaemon(sandbox, { daemonPid: null, paseoHome: HOME })).toBeNull();
  });
});

describe("trusted state and pointer files", () => {
  const uid = 501;
  const file = (mode: number, owner = uid, isFile = true) => ({ isFile, uid: owner, mode: 0o100000 | mode });

  test("fileProblem accepts only a regular file of this user that the group and world cannot write", () => {
    expect(fileProblem(file(0o600), uid)).toBeNull();
    expect(fileProblem(file(0o644), uid)).toBeNull();
    expect(fileProblem(null, uid)).not.toBeNull();
    expect(fileProblem(file(0o600, uid, false), uid)).not.toBeNull();
    expect(fileProblem(file(0o600, 0), uid)).not.toBeNull();
    expect(fileProblem(file(0o620), uid)).not.toBeNull();
    expect(fileProblem(file(0o602), uid)).not.toBeNull();
  });

  const state = (dir: string): DogfoodState =>
    ({ marker: MARKER, dir, paseoHome: `${dir}/paseo-home` }) as unknown as DogfoodState;

  test("pointerProblem follows only a marked pointer whose directory's state carries the same marker and dir", () => {
    const dir = "/private/tmp/maestro-dogfood-AbC123";
    expect(pointerProblem({ marker: MARKER, dir }, state(dir))).toBeNull();
    expect(pointerProblem({ dir }, state(dir))).not.toBeNull();
    expect(pointerProblem({ marker: "something-else", dir }, state(dir))).not.toBeNull();
    expect(pointerProblem({ marker: MARKER }, state(dir))).not.toBeNull();
    expect(pointerProblem({ marker: MARKER, dir }, null)).not.toBeNull();
    expect(pointerProblem({ marker: MARKER, dir }, state("/private/tmp/maestro-dogfood-Other"))).not.toBeNull();
    expect(
      pointerProblem({ marker: MARKER, dir }, { ...state(dir), marker: "old" } as unknown as DogfoodState),
    ).not.toBeNull();
    expect(pointerProblem("not an object", state(dir))).not.toBeNull();
  });

  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test("readState refuses a state.json the group or world can write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dogfood-state-"));
    dirs.push(dir);
    const path = join(dir, "state.json");
    await writeFile(path, JSON.stringify({ marker: MARKER, dir }), { mode: 0o600 });
    expect(readState(dir)?.dir).toBe(dir);
    await chmod(path, 0o622);
    expect(readState(dir)).toBeNull();
  });
});

// The call sites, end to end on real files. Each test gets its own pointer path, never this checkout's real one.
describe("state and pointer files on disk", () => {
  const roots: string[] = [];
  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  async function sandbox() {
    delete process.env.MAESTRO_DOGFOOD_STATE;
    const root = realpathSync(await mkdtemp(join(tmpdir(), "dogfood-pointer-")));
    roots.push(root);
    const dir = join(root, "maestro-dogfood-AbC123");
    await mkdir(dir, { mode: 0o700 });
    const pointer = join(root, "pointer.json");
    const state = { marker: MARKER, dir, paseoHome: join(dir, "paseo-home") } as unknown as DogfoodState;
    const warnings: string[] = [];
    const resolve = () => resolveStateDir(undefined, (line) => warnings.push(line), pointer);
    return { root, dir, pointer, state, warnings, resolve };
  }
  const modeOf = (path: string) => statSync(path).mode & 0o777;

  test("writeState writes state.json and the pointer 0600, even over a loose file already there", async () => {
    const { dir, pointer, state } = await sandbox();
    await writeFile(pointer, "{}");
    await chmod(pointer, 0o666);
    await writeState(state, pointer);
    expect(modeOf(pointer)).toBe(0o600);
    expect(modeOf(join(dir, "state.json"))).toBe(0o600);
    expect(JSON.parse(await readFile(pointer, "utf8"))).toEqual({ marker: MARKER, dir });
  });

  test("a trusted pointer resolves", async () => {
    const { dir, pointer, state, warnings, resolve } = await sandbox();
    await writeState(state, pointer);
    expect(resolve()).toBe(dir);
    expect(warnings).toEqual([]);
  });

  test("a group-writable pointer is refused", async () => {
    const { pointer, state, warnings, resolve } = await sandbox();
    await writeState(state, pointer);
    await chmod(pointer, 0o620);
    expect(resolve()).toBeNull();
    expect(warnings.join()).toContain("writable by the group or the world");
  });

  test("a pointer without the marker is refused", async () => {
    const { dir, pointer, state, warnings, resolve } = await sandbox();
    await writeState(state, pointer);
    await writeFile(pointer, JSON.stringify({ dir }));
    expect(resolve()).toBeNull();
    expect(warnings.join()).toContain("marker");
  });

  test("a pointer whose state.json carries a different marker is refused", async () => {
    const { dir, pointer, state, warnings, resolve } = await sandbox();
    await writeState(state, pointer);
    await writeFile(join(dir, "state.json"), JSON.stringify({ ...state, marker: "someone-else/v1" }));
    expect(resolve()).toBeNull();
    expect(warnings.join()).toContain("holds no trusted state.json");
  });

  test("a pointer whose state.json names a different dir is refused", async () => {
    const { dir, pointer, state, warnings, resolve } = await sandbox();
    await writeState(state, pointer);
    await writeFile(join(dir, "state.json"), JSON.stringify({ ...state, dir: "/Users/someone/maestro" }));
    expect(resolve()).toBeNull();
    expect(warnings.join()).toContain("does not match");
  });

  test("a pointer whose state.json is missing is refused, and kept", async () => {
    const { dir, pointer, state, warnings, resolve } = await sandbox();
    await writeState(state, pointer);
    await rm(join(dir, "state.json"));
    expect(resolve()).toBeNull();
    expect(warnings.join()).toContain("holds no trusted state.json");
    expect(existsSync(pointer)).toBe(true);
  });

  test("a trusted pointer to a directory that is gone is dropped quietly", async () => {
    const { dir, pointer, state, warnings, resolve } = await sandbox();
    await writeState(state, pointer);
    await rm(dir, { recursive: true });
    expect(resolve()).toBeNull();
    expect(existsSync(pointer)).toBe(false);
    expect(warnings).toEqual([]);
  });

  test("clearPointer removes only a trusted pointer naming the dir, and is idempotent", async () => {
    const { dir, pointer, state } = await sandbox();
    await writeState(state, pointer);
    await clearPointer("/private/tmp/maestro-dogfood-Other", pointer);
    expect(existsSync(pointer)).toBe(true);
    await chmod(pointer, 0o622);
    await clearPointer(dir, pointer);
    expect(existsSync(pointer)).toBe(true);
    await chmod(pointer, 0o600);
    await clearPointer(dir, pointer);
    expect(existsSync(pointer)).toBe(false);
    await clearPointer(dir, pointer);
    await clearPointer(dir, pointer);
    expect(existsSync(pointer)).toBe(false);
  });
});
