// Shared plumbing for the dogfood harness (up.ts, shot.ts, down.ts): where the
// sandbox state lives, a clean environment for anything spawned against it,
// and small process helpers. Nothing here may reach the real Paseo daemon.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/** Written into every state file: down.ts deletes only a directory that carries it. */
export const MARKER = "maestro-paseo-dogfood/v1";

/** Ports the harness never takes: the real daemon's default and the one earlier sandboxes used. */
export const RESERVED_PORTS = new Set([6767, 6799]);

export interface DogfoodState {
  marker: typeof MARKER;
  /** The sandbox root, a mktemp directory. Everything below is deleted by down.ts. */
  dir: string;
  paseoHome: string;
  /** HOME for the daemon, so anything that falls back to the home folder stays in the sandbox. */
  home: string;
  maestroConfig: string;
  socket: string;
  workRoot: string;
  pluginDir: string;
  port: number;
  url: string;
  serverId: string | null;
  daemonPid: number | null;
  log: string;
  startedAt: string;
}

/** One pointer per harness checkout, so two worktrees can each run their own sandbox. */
export function pointerPath(): string {
  const scripts = realpathSync(import.meta.dir);
  const hash = createHash("sha256").update(scripts).digest("hex").slice(0, 12);
  return join(tmpdir(), `maestro-paseo-dogfood-${hash}.json`);
}

/** The fields of an lstat that decide whether a file the harness reads can be trusted. */
export interface FileFacts {
  isFile: boolean;
  uid: number;
  mode: number;
}

/**
 * Why a state or pointer file must not be trusted, or null. It must be a
 * regular file (lstat: a symlink is not one), owned by this user, and not
 * writable by the group or the world, or anyone could aim down.ts elsewhere.
 */
export function fileProblem(facts: FileFacts | null, uid: number): string | null {
  if (!facts) return "it does not exist";
  if (!facts.isFile) return "it is not a regular file";
  if (facts.uid !== uid) return `it is owned by uid ${facts.uid}, not ${uid}`;
  if ((facts.mode & 0o022) !== 0) return "it is writable by the group or the world";
  return null;
}

function factsOf(path: string): FileFacts | null {
  try {
    const stat = lstatSync(path);
    return { isFile: stat.isFile(), uid: stat.uid, mode: stat.mode };
  } catch {
    return null;
  }
}

const currentUid = () => process.getuid?.() ?? -1;

function readTrusted(path: string): { value: unknown } | { problem: string } {
  const problem = fileProblem(factsOf(path), currentUid());
  if (problem) return { problem };
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { problem: "it is not valid JSON" };
  }
}

export function readState(dir: string): DogfoodState | null {
  const read = readTrusted(join(dir, "state.json"));
  if (!("value" in read)) return null;
  const state = read.value as DogfoodState | null;
  return state && typeof state === "object" && state.marker === MARKER ? state : null;
}

/**
 * Why the pointer must not be followed, or null: it must carry the marker and
 * name a directory whose own state.json carries the marker and the same dir.
 */
export function pointerProblem(pointer: unknown, state: DogfoodState | null): string | null {
  const found = pointer as { marker?: unknown; dir?: unknown } | null;
  if (!found || typeof found !== "object") return "it is not a JSON object";
  if (found.marker !== MARKER) return "it does not carry the dogfood marker";
  if (typeof found.dir !== "string" || !found.dir) return "it names no directory";
  if (!state) return `${found.dir} holds no trusted state.json`;
  if (state.marker !== MARKER || state.dir !== found.dir) return `${found.dir}/state.json does not match it`;
  return null;
}

export async function writeState(state: DogfoodState): Promise<void> {
  const own = { encoding: "utf8", mode: 0o600 } as const;
  await writeFile(join(state.dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, own);
  await writeFile(pointerPath(), `${JSON.stringify({ marker: MARKER, dir: state.dir }, null, 2)}\n`, own);
}

/**
 * The sandbox to act on: `--state <dir>`, then MAESTRO_DOGFOOD_STATE, then
 * this checkout's pointer, which is followed only if it passes fileProblem and
 * pointerProblem. A trusted pointer to a directory that is gone is dropped.
 */
export function resolveStateDir(flag: string | undefined, warn: (line: string) => void = console.warn): string | null {
  const explicit = flag ?? process.env.MAESTRO_DOGFOOD_STATE;
  if (explicit) return existsSync(explicit) ? realpathSync(explicit) : explicit;
  const path = pointerPath();
  if (!factsOf(path)) return null;
  const read = readTrusted(path);
  if (!("value" in read)) {
    warn(`Ignoring ${path}: ${read.problem}.`);
    return null;
  }
  const value = read.value as { marker?: unknown; dir?: unknown } | null;
  const dir = typeof value?.dir === "string" && value.dir ? value.dir : null;
  if (value?.marker === MARKER && dir && !existsSync(dir)) {
    rmSync(path, { force: true });
    return null;
  }
  const problem = pointerProblem(read.value, dir ? readState(dir) : null);
  if (problem || !dir) {
    warn(`Ignoring ${path}: ${problem ?? "it names no directory"}.`);
    return null;
  }
  return dir;
}

/** Drop this checkout's pointer if it is a trusted one naming `dir`; anything else is left alone. */
export async function clearPointer(dir: string): Promise<void> {
  const path = pointerPath();
  const read = readTrusted(path);
  if (!("value" in read)) return;
  if ((read.value as { dir?: unknown } | null)?.dir !== dir) return;
  await rm(path, { force: true });
}

/**
 * The environment for every process spawned against the sandbox. Paseo sets
 * PASEO_HOME, PASEO_AGENT_ID and friends in its sessions, and each of them
 * would steer a child toward the real daemon, so all PASEO_* and
 * MAESTRO_PASEO_* variables are dropped before the sandbox's own are added.
 */
export function sandboxEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("PASEO_") || key.startsWith("MAESTRO_PASEO_")) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

export async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const chosen = typeof address === "object" && address ? address.port : 0;
        server.close(() => resolve(chosen));
      });
    });
    if (port > 0 && !RESERVED_PORTS.has(port)) return port;
  }
  throw new Error("Could not find a free port");
}

export async function portOpen(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Thrown from a waitFor probe to stop waiting at once; any other error is retried until the deadline. */
export class Fatal extends Error {}

export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      if (error instanceof Fatal) throw error;
      lastError = error;
    }
    await sleep(intervalMs);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}${detail}`);
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

export function processes(): Proc[] {
  const out = spawnSync("ps", ["-axww", "-o", "pid=,ppid=,pgid=,command="], { encoding: "utf8" }).stdout ?? "";
  return out
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      command: match[4] ?? "",
    }));
}

/** This process and every process above it: never signalled, whatever their command lines say. */
export function ancestors(procs: readonly Proc[], pid: number = process.pid): Set<number> {
  const parent = new Map(procs.map((proc) => [proc.pid, proc.ppid]));
  const chain = new Set<number>();
  for (let at: number | undefined = pid; at !== undefined && at > 1 && !chain.has(at); at = parent.get(at)) {
    chain.add(at);
  }
  return chain;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The exact invocation up.ts starts, `… daemon run --home <paseoHome>`, as
 * the final arguments (the paseo wrapper execs with "$@" last). A longer home,
 * a path below it, `daemon start`, or a shell line that runs more after it do
 * not match.
 */
export function isDaemonOf(proc: Proc, state: Pick<DogfoodState, "paseoHome">): boolean {
  return new RegExp(`(^|\\s)daemon run --home ${escapeRegExp(state.paseoHome)}$`).test(proc.command);
}

/** Any Paseo daemon invocation, whatever home it names. */
const DAEMON_INVOCATION = /(^|\s)daemon (run|start)(\s|$)/;

/** The recorded daemon, only while its pid still runs this sandbox's own daemon invocation. */
export function liveDaemon(procs: readonly Proc[], state: Pick<DogfoodState, "daemonPid" | "paseoHome">): Proc | null {
  if (!state.daemonPid) return null;
  const daemon = procs.find((proc) => proc.pid === state.daemonPid);
  return daemon && isDaemonOf(daemon, state) ? daemon : null;
}

/**
 * What down.ts stops first: the verified daemon's process group. up.ts spawns
 * the daemon detached, so that group is the daemon and everything it started.
 * Never a pid in `skip` (this process and its ancestors), and never a member
 * that is itself a Paseo daemon invocation for another home.
 */
export function daemonGroup(
  procs: readonly Proc[],
  state: Pick<DogfoodState, "daemonPid" | "paseoHome">,
  skip: ReadonlySet<number>,
): Proc[] {
  const daemon = liveDaemon(procs, state);
  if (!daemon) return [];
  return procs.filter(
    (proc) =>
      proc.pgid === daemon.pgid &&
      !skip.has(proc.pid) &&
      (!DAEMON_INVOCATION.test(proc.command) || isDaemonOf(proc, state)),
  );
}

/**
 * Whether the sandbox started this process: its daemon, the stand-in agent
 * copied into its bin/, a browser profile inside it. A shell or editor that
 * merely mentions the sandbox's path does not match.
 */
export function ownedBySandbox(proc: Proc, state: Pick<DogfoodState, "dir" | "paseoHome">): boolean {
  return (
    isDaemonOf(proc, state) ||
    proc.command.includes(`${state.dir}/bin/`) ||
    proc.command.includes(`--user-data-dir=${state.dir}/`)
  );
}

/** The processes the sandbox started, minus this process and its ancestors. */
export function sandboxProcesses(
  state: Pick<DogfoodState, "dir" | "paseoHome">,
  procs: readonly Proc[] = processes(),
  self: number = process.pid,
): Proc[] {
  const skip = ancestors(procs, self);
  return procs.filter((proc) => !skip.has(proc.pid) && ownedBySandbox(proc, state));
}

/** The Paseo CLI, never through $PASEO_CLI (a session's pointer at the real install is fine, but explicit is safer). */
export function paseoBin(): string {
  const candidates = [
    process.env.DOGFOOD_PASEO_BIN,
    Bun.which("paseo"),
    "/Applications/Paseo.app/Contents/Resources/bin/paseo",
  ];
  const found = candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
  if (!found) throw new Error("No paseo CLI found. Install Paseo, or set DOGFOOD_PASEO_BIN.");
  return found;
}

/** The web client bundled with the desktop app; the sandbox daemon serves it on its own origin. */
export function webDist(paseo: string): string | null {
  const fromEnv = process.env.DOGFOOD_WEB_DIST;
  if (fromEnv) return fromEnv;
  let real: string;
  try {
    real = realpathSync(paseo);
  } catch {
    return null;
  }
  const dist = join(dirname(dirname(real)), "app-dist");
  return existsSync(join(dist, "index.html")) ? dist : null;
}

/** Only a mktemp sandbox this harness made may be deleted. */
export function deletable(dir: string, state: DogfoodState | null): boolean {
  if (!state || state.dir !== dir) return false;
  if (!basename(dir).startsWith("maestro-dogfood-")) return false;
  const roots = ["/tmp/", "/private/tmp/", `${realpathSync(tmpdir())}/`];
  return roots.some((root) => dir.startsWith(root));
}

export function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}

export function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}
