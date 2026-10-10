#!/usr/bin/env bun
// Start a throwaway Paseo daemon with its own home, install the Maestro plugin
// from any checkout, and seed work in every state. See README.md beside this file.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type DogfoodState,
  Fatal,
  flag,
  freePort,
  hasFlag,
  liveDaemon,
  MARKER,
  paseoBin,
  portOpen,
  processes,
  RESERVED_PORTS,
  readState,
  resolveStateDir,
  sandboxEnv,
  sleep,
  waitFor,
  webDist,
  writeState,
} from "./lib";
import { ASK_MARKER, buildSeeds, RPC_SEED, type Seed, type SeedExpect, writeSeeds } from "./seed";
import { teardown } from "./teardown";

const USAGE = `bun scripts/dogfood/up.ts --plugin <dir> [--port N] [--sweep-seconds N] [--no-live] [--keep-on-failure]

  --plugin <dir>        The Maestro checkout to install (any worktree with node_modules)
  --port N              Daemon port (default: a free one; never 6767 or 6799)
  --sweep-seconds N     The plugin sweep's period in the sandbox (default 30), for reads-pure.ts
  --no-live             Skip the two live dispatches to the stand-in agent
  --keep-on-failure     Leave the sandbox up when a step fails, to inspect it
`;

/** The wire item fields this script reads back from work.list. */
interface ListedItem {
  id: string;
  title: string;
  state: string;
  group: string;
  phase: string | null;
  reason: string | null;
  verdict: string | null;
  initiative: string | null;
  project: string | null;
  look: { ran: string; decided: string[]; ask: string } | null;
}

interface Listed {
  root: string;
  items: ListedItem[];
  warnings: string[];
}

const PROVIDER = "dogfood";
const MODEL = "stand-in";

function fail(message: string): never {
  console.error(`up: ${message}`);
  process.exit(1);
}

function git(cwd: string, env: Record<string, string>, ...args: string[]): void {
  const result = spawnSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "user.name=dogfood", "-c", "user.email=dogfood@localhost", ...args],
    { cwd, env, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
}

async function makeRepo(path: string, readme: string, env: Record<string, string>): Promise<void> {
  await mkdir(path, { recursive: true });
  git(path, env, "init", "-q", "-b", "main");
  await writeFile(join(path, "README.md"), `${readme}\n`, "utf8");
  git(path, env, "add", "README.md");
  git(path, env, "commit", "-q", "-m", "Initial commit");
}

function paseoConfig(port: number, dist: string | null, fakeAcp: string): Record<string, unknown> {
  const off = { enabled: false };
  return {
    version: 1,
    daemon: { listen: `127.0.0.1:${port}`, relay: { enabled: false }, cors: { allowedOrigins: [] } },
    pluginsEnabled: true,
    features: {
      // Local speech would download a ~1 GB model into the sandbox home; nothing here needs it.
      dictation: off,
      voiceMode: off,
      webUi: dist ? { enabled: true, distDir: dist } : { enabled: true },
    },
    agents: {
      providers: {
        // No real provider: a Dispatch clicked while dogfooding must never start a paid session.
        claude: off,
        codex: off,
        copilot: off,
        opencode: off,
        pi: off,
        omp: off,
        [PROVIDER]: {
          extends: "acp",
          label: "Dogfood stand-in",
          description: "Holds its turn open without a model (scripts/dogfood/fake-acp.ts)",
          command: [process.execPath, fakeAcp],
          models: [{ id: MODEL, label: "Stand-in", isDefault: true }],
        },
      },
    },
  };
}

function tail(path: string, lines = 30): string {
  try {
    return readFileSync(path, "utf8").split("\n").slice(-lines).join("\n");
  } catch {
    return "(no log)";
  }
}

function check(expect: SeedExpect, item: ListedItem | undefined): string[] {
  if (!item) return ["missing from work.list"];
  const problems: string[] = [];
  const same = (name: string, want: unknown, got: unknown) => {
    if (want !== undefined && want !== got)
      problems.push(`${name} ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  };
  same("group", expect.group, item.group);
  same("phase", expect.phase, item.phase);
  same("reason", expect.reason, item.reason);
  same("verdict", expect.verdict, item.verdict);
  same("initiative", expect.initiative, item.initiative);
  same("project", expect.project, item.project);
  if (expect.decided !== undefined) same("decisions at the gate", expect.decided, item.look?.decided.length);
  return problems;
}

const LABEL: Record<string, string> = {
  review: "Needs you",
  blocked: "Stuck",
  running: "Running",
  queued: "Queued",
  done: "Done",
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (hasFlag(args, "help") || hasFlag(args, "h")) {
    console.log(USAGE);
    return;
  }
  const pluginArg = flag(args, "plugin");
  if (!pluginArg) fail(`--plugin is required\n\n${USAGE}`);
  const pluginDir = realpathSync(resolve(pluginArg));
  const manifestPath = join(pluginDir, "paseo-plugin.json");
  if (!existsSync(manifestPath)) fail(`${pluginDir} has no paseo-plugin.json`);
  const pluginId = (JSON.parse(readFileSync(manifestPath, "utf8")) as { id?: string }).id;
  if (pluginId !== "maestro") fail(`${manifestPath} declares plugin id ${JSON.stringify(pluginId)}, not "maestro"`);
  if (!existsSync(join(pluginDir, "node_modules"))) {
    fail(`${pluginDir} has no node_modules: run npm ci there (or symlink another checkout's node_modules)`);
  }
  const portArg = flag(args, "port");
  const port = portArg ? Number(portArg) : await freePort();
  if (!Number.isInteger(port) || port <= 0) fail(`--port must be a port number, got ${portArg}`);
  if (RESERVED_PORTS.has(port)) fail(`port ${port} is reserved for the real daemon; pick another`);
  if (await portOpen(port)) fail(`port ${port} is already in use; pick another, or leave out --port`);

  const previous = resolveStateDir(undefined);
  if (previous && existsSync(previous)) {
    const before = readState(previous);
    // Live only if the recorded pid still runs this sandbox's daemon: a reused pid is not a running sandbox.
    if (before && liveDaemon(processes(), before)) {
      fail(`a sandbox is already up at ${before.url} (${previous}). Run bun scripts/dogfood/down.ts first.`);
    }
    console.log(`Clearing a stale sandbox first: ${previous}`);
    await teardown(previous);
  }

  const paseo = paseoBin();
  const dist = webDist(paseo);
  if (!dist) console.warn("up: no bundled web client found; relying on the daemon's default (set DOGFOOD_WEB_DIST)");

  // /tmp, not os.tmpdir(): unix socket paths are capped at 104 bytes on macOS.
  const dir = realpathSync(mkdtempSync("/tmp/maestro-dogfood-"));
  const state: DogfoodState = {
    marker: MARKER,
    dir,
    paseoHome: join(dir, "paseo-home"),
    home: join(dir, "home"),
    maestroConfig: join(dir, "maestro", "config.json"),
    socket: join(dir, "maestro", "maestro.sock"),
    workRoot: join(dir, "work"),
    pluginDir,
    port,
    url: `http://127.0.0.1:${port}`,
    serverId: null,
    daemonPid: null,
    log: join(dir, "daemon.log"),
    startedAt: new Date().toISOString(),
  };
  await writeState(state);
  console.log(`Sandbox ${dir}`);

  const keep = hasFlag(args, "keep-on-failure");
  let daemon: ChildProcess | null = null;
  let client: { close(): Promise<void> } | null = null;
  try {
    for (const path of [state.paseoHome, state.home, join(dir, "maestro"), state.workRoot, join(dir, "bin")]) {
      await mkdir(path, { recursive: true });
    }
    const gitEnv = sandboxEnv({ HOME: state.home, GIT_CONFIG_NOSYSTEM: "1" });
    const repos = {
      checkout: join(dir, "repos", "checkout"),
      platform: join(dir, "repos", "platform"),
      infra: join(dir, "repos", "infra"),
    };
    await makeRepo(repos.checkout, "# checkout\n\nThe storefront checkout service.", gitEnv);
    await makeRepo(repos.platform, "# platform\n\nShared platform services.", gitEnv);
    await makeRepo(repos.infra, "# infra\n\nBuild and deploy infrastructure.", gitEnv);
    await writeFile(join(repos.infra, ASK_MARKER), "The stand-in agent asks for permission in this repo.\n");

    // Copied into the sandbox so its command line names the sandbox and down.ts can find it.
    const fakeAcp = join(dir, "bin", "fake-acp.ts");
    await copyFile(join(import.meta.dir, "fake-acp.ts"), fakeAcp);

    // No run cap: the seed's stuck, running and asking items hold four slots (BRO-2990 counts each), so the
    // default of 3 would refuse the seed's own last dispatch. Settings in the sandbox can set one to try it.
    const maestroConfig = {
      workRoot: state.workRoot,
      provider: `${PROVIDER}/${MODEL}`,
      modeId: null,
      isolation: "directory",
      concurrencyCap: null,
    };
    await writeFile(state.maestroConfig, `${JSON.stringify(maestroConfig, null, 2)}\n`);
    await writeFile(
      join(state.paseoHome, "config.json"),
      `${JSON.stringify(paseoConfig(port, dist, fakeAcp), null, 2)}\n`,
    );

    const now = new Date();
    const seeds = buildSeeds(now, repos);
    await writeSeeds(state.workRoot, seeds, now);

    const sweepSeconds = flag(args, "sweep-seconds");
    const daemonEnv = sandboxEnv({
      HOME: state.home,
      MAESTRO_PASEO_CONFIG: state.maestroConfig,
      MAESTRO_PASEO_SOCKET: state.socket,
      ...(sweepSeconds ? { MAESTRO_PASEO_SWEEP_SECONDS: sweepSeconds } : {}),
    });
    const logFd = openSync(state.log, "a");
    daemon = spawn(paseo, ["daemon", "run", "--home", state.paseoHome], {
      cwd: dir,
      env: daemonEnv,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    closeSync(logFd);
    // The exit event, not kill(pid, 0): an exited child stays a zombie of this process until it is reaped.
    let exited: string | null = null;
    daemon.once("exit", (code, signal) => {
      exited = signal ? `signal ${signal}` : `code ${code}`;
    });
    daemon.unref();
    if (!daemon.pid) throw new Error("the daemon did not start");
    state.daemonPid = daemon.pid;
    await writeState(state);
    console.log(`Daemon pid ${daemon.pid} starting on ${state.url} (log: ${state.log})`);

    await waitFor(
      "the daemon to serve its web client",
      async () => {
        if (exited) throw new Fatal(`the daemon exited with ${exited} before it was ready`);
        const response = await fetch(`${state.url}/`).catch(() => null);
        return response?.ok && (await response.text()).includes("__PASEO_INITIAL_DAEMON_CONNECTION__");
      },
      180_000,
    );

    // The web client is served before the daemon's socket takes connections: while its other plugins
    // load, the upgrade answers 503 and `plugin install` reports DAEMON_UNREACHABLE. Retry that one
    // failure until the socket is up; any other failure is real.
    await waitFor(
      "the daemon to accept the plugin install",
      async () => {
        const install = spawnSync(paseo, ["plugin", "install", pluginDir, "--host", `127.0.0.1:${port}`, "--json"], {
          env: sandboxEnv({ HOME: state.home }),
          encoding: "utf8",
          timeout: 180_000,
        });
        if (install.status === 0) return true;
        if (`${install.stdout}${install.stderr}`.includes("DAEMON_UNREACHABLE")) return false;
        throw new Fatal(`plugin install failed:\n${install.stdout}\n${install.stderr}`);
      },
      120_000,
      2_000,
    );
    console.log(`Installed the plugin from ${pluginDir}`);

    const { DaemonClient } = await import("@getpaseo/client/internal/daemon-client");
    const daemonClient = new DaemonClient({
      url: `ws://127.0.0.1:${port}/ws`,
      clientId: `dogfood-${randomUUID()}`,
      clientType: "cli",
      reconnect: { enabled: false },
    });
    client = daemonClient;
    await daemonClient.connect();
    state.serverId = await waitFor(
      "the daemon's server id",
      async () => daemonClient.getLastServerInfoMessage()?.serverId,
      15_000,
    );
    await writeState(state);
    const rpc = <T>(method: string, input: unknown) =>
      daemonClient.invokePluginRpc("maestro", method, input) as Promise<T>;

    // The plugin must be reading the sandbox config, never ~/.config/maestro-paseo: check before writing anything.
    const config = await waitFor(
      "the Maestro plugin to answer",
      () => rpc<{ workRoot: string; provider: string }>("config.get", {}),
      90_000,
      1000,
    );
    if (config.workRoot !== state.workRoot) {
      throw new Error(`the plugin reads work from ${config.workRoot}, not the sandbox ${state.workRoot}; stopping`);
    }
    await waitFor("the Maestro agent socket in the sandbox", async () => existsSync(state.socket), 15_000);

    const created = await rpc<{ item: ListedItem }>("work.create", {
      title: RPC_SEED.title,
      brief: RPC_SEED.brief,
      repo: repos.platform,
      gate: "human",
      check: "",
      initiative: RPC_SEED.initiative,
      dispatch: false,
    });
    console.log(`Created "${RPC_SEED.title}" over work.create`);

    const live = hasFlag(args, "no-live") ? [] : seeds.filter((seed) => seed.live);
    const dispatchErrors = new Map<string, string>();
    for (const seed of live) {
      try {
        await rpc("work.dispatch", { id: seed.id });
        console.log(`Dispatched "${seed.title}" to the stand-in agent`);
      } catch (error) {
        dispatchErrors.set(seed.key, (error as Error).message);
      }
    }
    const settled = (listed: Listed) =>
      live.every(
        (seed) =>
          dispatchErrors.has(seed.key) ||
          check(
            seed.expect,
            listed.items.find((item) => item.id === seed.id),
          ).length === 0,
      );
    let listed = await rpc<Listed>("work.list", {});
    if (live.length > 0) {
      listed = await waitFor(
        "the live runs to settle",
        async () => {
          const next = await rpc<Listed>("work.list", {});
          return settled(next) ? next : null;
        },
        60_000,
        1000,
      ).catch(async (error) => {
        console.warn(`up: ${(error as Error).message}`);
        return rpc<Listed>("work.list", {});
      });
    }

    const rows: Array<{ seed: Pick<Seed, "key" | "title">; expect: SeedExpect; id: string; note?: string }> = [
      ...seeds.map((seed) => ({
        seed,
        id: seed.id,
        expect:
          seed.live && !live.includes(seed)
            ? { ...seed.expect, group: "queued" as const, phase: undefined }
            : seed.expect,
        note: dispatchErrors.get(seed.key),
      })),
      { seed: RPC_SEED, id: created.item.id, expect: RPC_SEED.expect },
    ];
    let mismatches = 0;
    console.log("");
    for (const row of rows) {
      const item = listed.items.find((candidate) => candidate.id === row.id);
      const problems = check(row.expect, item);
      if (row.note) problems.push(`dispatch failed: ${row.note}`);
      if (problems.length > 0) mismatches += 1;
      const label = item ? (LABEL[item.group] ?? item.group) + (item.phase ? ` (${item.phase})` : "") : "missing";
      const where = [row.expect.initiative, row.expect.project].filter(Boolean).join("/");
      console.log(
        `  ${problems.length === 0 ? "ok " : "BAD"}  ${label.padEnd(20)} ${row.seed.title}  [${where}]${problems.length > 0 ? `\n         ${problems.join("; ")}` : ""}`,
      );
    }
    for (const warning of listed.warnings) console.log(`  warning: ${warning}`);

    const surface = `${state.url}/h/${encodeURIComponent(state.serverId)}/plugin/maestro/sidebar/maestro`;
    console.log(`
Maestro dogfood sandbox is up${mismatches > 0 ? `, with ${mismatches} item(s) not as seeded (see BAD above)` : ""}.
  daemon   ${state.url}  (pid ${state.daemonPid}, server ${state.serverId})
  maestro  ${surface}
  state    ${dir}
  plugin   ${pluginDir}
  log      ${state.log}

  export MAESTRO_DOGFOOD_STATE=${dir}
  bun scripts/dogfood/shot.ts --out <dir>
  bun scripts/dogfood/down.ts`);
    await daemonClient.close();
    client = null;
    if (mismatches > 0) process.exitCode = 2;
  } catch (error) {
    console.error(`up: ${(error as Error).message}`);
    if (existsSync(state.log)) console.error(`--- daemon log (tail) ---\n${tail(state.log)}`);
    await client?.close().catch(() => undefined);
    if (keep) {
      console.error(`Left up for inspection (--keep-on-failure): ${dir}. Run bun scripts/dogfood/down.ts when done.`);
    } else {
      await sleep(200);
      await teardown(dir, (line) => console.error(`up: ${line}`));
    }
    process.exit(1);
  }
}

await main();
