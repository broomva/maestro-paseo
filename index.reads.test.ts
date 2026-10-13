// Reads are pure (BRO-2995). Through the plugin's own handlers, work.list,
// work.attention and loops.get (and the fleet and timeline views they reach),
// each polled 50 times over work that a write would change, leave the work
// store, the ledgers and Paseo exactly as they were: no file written, no git
// fetch, no drift line, no session created, prompted, archived or labelled.
// Then the plugin sweep, and only it, does what a read used to do on the
// side: it reconciles the work with Paseo, applies the decisions that came
// due (a send back is a prompt to the session), records the loops' drift
// and clears this process's leftover ledger locks.

import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "./index.server";
import { loadConfig } from "./server/config";
import { Engine } from "./server/engine";
import { fakePaseo } from "./server/fake-paseo";
import { acquireLock, releaseLock } from "./server/locks";
import { LOOPS_VIEW_MS } from "./server/loops";
import type { Paseo } from "./server/runs";

setDefaultTimeout(120_000);

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** What Paseo's client may be asked by a read: reads only. Any other call is a write, whatever it is named. */
const PASEO_READS = new Set([
  "agents.ref().refresh",
  "agents.ref().timeline.refetch",
  "agents.list",
  "workspaces.list",
  "workspaces.ref().refresh",
  "providers.listModels",
]);

/** The client, every call recorded by its path (`agents.ref().send`); a handle (`ref(id)`) is not a call. */
function spied<T extends object>(target: T, calls: string[], path = ""): T {
  return new Proxy(target, {
    get(object, key, receiver) {
      const value = Reflect.get(object, key, receiver);
      if (typeof key !== "string") return value;
      const at = path ? `${path}.${key}` : key;
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          if (!at.endsWith(".ref")) calls.push(at);
          const result = value.apply(object, args);
          return result && typeof result === "object" && !(result instanceof Promise)
            ? spied(result as object, calls, `${at}()`)
            : result;
        };
      }
      return value && typeof value === "object" ? spied(value as object, calls, at) : value;
    },
  });
}

/** Every path under `root`: a file by its mtime, size and bytes, a folder by its mtime. */
async function fingerprint(root: string): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isSocket()) continue;
      const info = await stat(path).catch(() => null);
      if (!info) continue;
      if (entry.isDirectory()) {
        seen.set(path, `dir ${info.mtimeMs}`);
        await walk(path);
      } else if (entry.isFile()) {
        const digest = createHash("sha1")
          .update(await readFile(path))
          .digest("hex");
        seen.set(path, `${info.mtimeMs} ${info.size} ${digest}`);
      }
    }
  };
  await walk(root);
  return seen;
}

/** The paths that differ between two fingerprints, each with how. */
function differences(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [path, was] of before) {
    const now = after.get(path);
    if (now === undefined) out.push(`removed ${path}`);
    else if (now !== was) out.push(`changed ${path}`);
  }
  for (const path of after.keys()) if (!before.has(path)) out.push(`added ${path}`);
  return out;
}

/** Waits until nothing under `root` changes for a second: the plugin's start-up sweep is done. */
async function quiet(root: string): Promise<void> {
  let last = await fingerprint(root);
  let still = 0;
  for (let tries = 0; tries < 120 && still < 4; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const now = await fingerprint(root);
    still = differences(last, now).length === 0 ? still + 1 : 0;
    last = now;
  }
  if (still < 4) throw new Error("the plugin never went quiet after starting");
}

const FAKE_BROOMVA_HOME = `import json, os, sys
args = sys.argv[1:]
stream = args[1]
path = os.path.join(os.environ["BROOMVA_HOME"], "ledger", stream + ".jsonl")
os.makedirs(os.path.dirname(path), exist_ok=True)
line = {"v": 1, "id": str(os.getpid()), "ts": "2026-10-10T00:00:00.000Z", "stream": stream, "type": args[2],
        "actor": args[args.index("--actor") + 1], "subject": args[3], "refs": {}, "cause": None,
        "data": json.loads(args[args.index("--data") + 1]), "prev": None}
with open(path, "a") as out:
    out.write(json.dumps(line) + "\\n")
`;

type Handler = (input: unknown, context: unknown) => unknown;

test("work.list, work.attention and loops.get, polled 50 times, leave the store, the ledgers and Paseo untouched; the sweep then does the work", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "maestro-reads-")));
  roots.push(root);
  const gitConfig = join(root, "gitconfig");
  await writeFile(gitConfig, "[user]\n\tname = Maestro Test\n\temail = maestro@example.invalid\n");
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv }).trim();

  // The control repo: origin/main holds a loops ledger row and the drift writer the sweep runs.
  const origin = join(root, "origin.git");
  const control = join(root, "broomva");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: gitEnv });
  execFileSync("git", ["clone", "-q", origin, control], { env: gitEnv, stdio: "pipe" });
  await mkdir(join(control, ".broomva", "loops"), { recursive: true });
  await cp(
    join(import.meta.dir, "server/testdata/loops-ledger/kg-lint.yaml"),
    join(control, ".broomva/loops/kg-lint.yaml"),
  );
  await mkdir(join(control, "scripts"), { recursive: true });
  await writeFile(join(control, "scripts", "broomva_home.py"), FAKE_BROOMVA_HOME);
  git(control, "add", ".");
  git(control, "commit", "-qm", "ledger", "--no-verify");
  git(control, "push", "-q", "origin", "HEAD:main");
  // The paseo CLI the sweep labels sessions with: this test's own, which only records.
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "paseo"), `#!/bin/sh\necho "$@" >> "${join(root, "paseo-cli.log")}"\n`);
  await chmod(join(bin, "paseo"), 0o755);
  const repo = join(root, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  const config = join(root, "config.json");
  await writeFile(
    config,
    JSON.stringify({ workRoot: join(root, "work"), provider: "claude/test-model", modeId: null }),
  );

  const env: Record<string, string | undefined> = {
    MAESTRO_PASEO_CONFIG: config,
    MAESTRO_PASEO_SOCKET: join(root, "m.sock"),
    MAESTRO_PASEO_WAKE_LOG: undefined,
    MAESTRO_PASEO_INBOX: undefined,
    MAESTRO_PASEO_FLEET_CONFIG: join(root, "fleet", "fleet.json"),
    MAESTRO_PASEO_FLEET_STATE: join(root, "fleet", "state"),
    MAESTRO_PASEO_FLEET_AGENTS: join(root, "fleet", "agents"),
    MAESTRO_PASEO_FLEET_AWAKE_CLOCK: "wall",
    MAESTRO_PASEO_SCHEDULES: join(root, "schedules"),
    MAESTRO_PASEO_LAUNCHD: "off",
    MAESTRO_PASEO_CONTROL_REPO: control,
    MAESTRO_PASEO_CONTROL_ANSWERS: join(root, "control-answers"),
    MAESTRO_PASEO_ASK_LOCKS: join(root, "locks"),
    MAESTRO_PASEO_ASK_RECEIPTS: join(root, "asks.jsonl"),
    MAESTRO_PASEO_LOOP_REPOS: "off",
    BROOMVA_HOME: join(root, "home"),
    // The sweep's own timer never fires inside the test: only the wake below runs one after start-up.
    MAESTRO_PASEO_SWEEP_SECONDS: "3600",
    // Every sweep may fetch, so the start-up sweep's fetch arms no throttle that would hide one a read makes.
    MAESTRO_PASEO_FETCH_SECONDS: "0",
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const handlers = new Map<string, Handler>();
  const hooks = new Map<string, Handler>();
  const host = {
    handle: (contract: { name: string }, handler: Handler) => handlers.set(contract.name, handler),
    on: (name: string, handler: Handler) => {
      hooks.set(name, handler);
      return () => hooks.delete(name);
    },
    before: () => () => undefined,
    registerProvider: () => undefined,
    registerSettings: () => undefined,
  } as unknown as PluginServerContext;
  const cleanup = contribute(host);
  try {
    await quiet(root);

    // Work a write would change: a run whose session closed, one whose end was missed, and two decisions at
    // your gate (approve, send back) whose undo window closed while the plugin was down.
    const fake = fakePaseo();
    const past = Date.now() - 10 * 60_000;
    const before = new Engine({
      now: () => new Date(past),
      config: () => loadConfig(config),
      log: () => undefined,
      timer: () => () => undefined,
    });
    const run = async (title: string) => {
      const item = await before.create(fake.paseo, {
        title,
        brief: "",
        repo,
        gate: "human",
        check: "",
        initiative: "",
        dispatch: true,
      });
      return { id: item.id, agentId: item.worker?.agentId ?? "" };
    };
    const atGate = async (title: string) => {
      const item = await run(title);
      const agent = fake.agents.get(item.agentId);
      if (agent) agent.status = "idle";
      await before.onTurnEnded({ id: item.agentId }, { kind: "completed" }, []);
      return item;
    };
    const closed = await run("Its session closed");
    const missed = await run("Its end was missed");
    const canceled = await atGate("Canceled");
    const revised = await atGate("Sent back");
    await before.verdict(fake.paseo, canceled.id, "block", "");
    await before.verdict(fake.paseo, revised.id, "revise", "Rename the flag");
    before.stop();
    const closedAgent = fake.agents.get(closed.agentId);
    if (closedAgent) closedAgent.status = "closed";
    const missedAgent = fake.agents.get(missed.agentId);
    if (missedAgent) missedAgent.status = "idle";
    // A Paseo heartbeat no ledger row names: UNREGISTERED drift, which only the sweep records.
    await mkdir(join(root, "schedules"), { recursive: true });
    await cp(
      join(import.meta.dir, "server/testdata/heartbeat-103a1850.json"),
      join(root, "schedules", "103a1850.json"),
    );
    // A ledger lock this process left behind (a release that could not read its token).
    const ledger = join(root, "asks-ledger.yaml");
    await writeFile(ledger, "asks: []\n");
    const lock = await acquireLock(ledger, join(root, "locks"));
    await writeFile(join(lock.dir, "token"), "garbled\n");
    await releaseLock(lock);
    // origin/main moves on: a read that fetched would bring it here.
    const upstream = join(root, "upstream");
    execFileSync("git", ["clone", "-q", origin, upstream], { env: gitEnv, stdio: "pipe" });
    git(upstream, "commit", "-q", "--allow-empty", "-m", "upstream moved", "--no-verify");
    git(upstream, "push", "-q", "origin", "HEAD:main");
    const fetched = git(control, "rev-parse", "origin/main");

    // The daemon's client, spied: every call by its path. The inbox opens its session with agents.create.
    const calls: string[] = [];
    const raw = fake.paseo as unknown as { agents: Record<string, unknown> };
    raw.agents.create = async (options: Record<string, unknown>) => {
      fake.created.push(options);
      fake.addSession("inbox-1");
      return { id: "inbox-1", cwd: "/tmp" };
    };
    const paseo = spied(fake.paseo, calls) as Paseo;
    const context = { paseo, signal: new AbortController().signal };
    const call = async (name: string, input: unknown = {}) => {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`${name} is not handled`);
      return handler(input, context);
    };
    const counts = () => ({
      created: fake.created.length,
      sent: fake.sent.length,
      archived: fake.archived.length,
      workspaces: fake.archivedWorkspaces.length,
    });
    const startCounts = counts();
    const start = await fingerprint(root);
    const state = async (id: string) => ((await call("work.get", { id })) as { item: { state: string } }).item.state;

    // The polls: the reads the client makes, 50 times each, spread past the Loops view's cache (LOOPS_VIEW_MS)
    // so the reads compute it themselves, and do not only serve the start-up sweep's.
    let attention: { loops: Array<{ subject: string }>; waiting: unknown[] } = { loops: [], waiting: [] };
    let loops: { rows: Array<{ ref: string; drift: Array<{ kind: string }> }> } = { rows: [] };
    const spread = (LOOPS_VIEW_MS * 1.3) / 50;
    for (let poll = 0; poll < 50; poll += 1) {
      await call("work.list");
      attention = (await call("work.attention")) as typeof attention;
      loops = (await call("loops.get")) as typeof loops;
      await call("fleet.get", {});
      await call("timeline.get");
      await new Promise((resolve) => setTimeout(resolve, spread));
    }
    // The reads saw what a write would change, and left it: the new heartbeat's drift is judged by a read (it was
    // seeded after the last sweep), and the decisions are still pending.
    const heartbeat = loops.rows.find((row) => row.ref === "103a1850");
    expect(heartbeat?.drift.map((drift) => drift.kind)).toEqual(["unregistered"]);
    expect(attention.loops.length).toBeGreaterThan(0);
    expect(await state(canceled.id)).toBe("review");
    expect(await state(closed.id)).toBe("running");

    const writes = calls.filter((path) => !PASEO_READS.has(path));
    expect(writes).toEqual([]);
    expect(counts()).toEqual(startCounts);
    expect(differences(start, await fingerprint(root))).toEqual([]);
    expect(git(control, "rev-parse", "origin/main")).toBe(fetched);

    // The sweep: the loop's wake (Settings' Wake now) runs one, under its lease, and its background steps after.
    calls.length = 0;
    await call("loop.wake");
    const drift = join(root, "home", "ledger", "loops", "drift.jsonl");
    for (let tries = 0; tries < 200; tries += 1) {
      const recorded = await readFile(drift, "utf8").catch(() => "");
      const locks = await readdir(join(root, "locks")).catch(() => []);
      const landed = fake.created.length > startCounts.created;
      const pulled = git(control, "rev-parse", "origin/main") !== fetched;
      const labelled = (await readFile(join(root, "paseo-cli.log"), "utf8").catch(() => "")).includes("agent update");
      if (
        recorded.includes("103a1850") &&
        !locks.length &&
        landed &&
        pulled &&
        labelled &&
        (await state(revised.id)) === "running"
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(await state(closed.id)).toBe("blocked");
    // The missed end, recovered by the sweep, lands at your gate: its card goes in the session, and the inbox opens
    // its session to tell you. The read that used to do this (listWork → reconcile → endTurn → inbox) now cannot.
    expect(await state(missed.id)).toBe("review");
    expect(calls).toContain("agents.ref().timeline.append");
    expect(calls).toContain("agents.create");
    expect(fake.created).toHaveLength(startCounts.created + 1);
    expect(await state(canceled.id)).toBe("canceled");
    expect(await state(revised.id)).toBe("running");
    expect(fake.sent.map((sent) => sent.agentId)).toContain(revised.agentId);
    expect(calls).toContain("agents.ref().send");
    const recorded = (await readFile(drift, "utf8")).split("\n").filter((line) => line.includes("103a1850"));
    expect(recorded.map((line) => JSON.parse(line).type)).toEqual(["loop.drift.detected"]);
    expect(await readdir(join(root, "locks"))).toEqual([]);
    // The sweep fetched origin/main (the reads did not), and labelled the sessions through this test's paseo CLI.
    expect(git(control, "rev-parse", "origin/main")).toBe(git(upstream, "rev-parse", "HEAD"));
    expect(await readFile(join(root, "paseo-cli.log"), "utf8")).toContain("agent update");
  } finally {
    await cleanup();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
