// The broomva launchd jobs, read from the Mac: `launchctl list` and
// `launchctl print` for each job, its plist through `plutil`, its own log's
// tail, the run ends the unified log keeps (`log show`), and how far back
// that log reaches; when the Mac last woke is the Fleet view's own read
// (server/fleet.ts kernelAwakeSince). The parsing is pure
// (server/launchd-model.ts); this is only the reading.
//
// Read-only, and held to it: every command goes through `readOnly`, which
// runs a fixed binary only with a verb that reads (list, print, show,
// -convert to stdout, -o) and refuses anything else, so nothing here can
// load, unload, bootstrap, kickstart or kill a job.
//
// The unified log costs seconds to search a day of, so it is read once in
// full and then only from where the last read ended, its run ends kept in
// memory for a day and an hour.

import { spawn } from "node:child_process";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { TIMELINE_WINDOW_MS } from "../shared/timeline";
import { kernelAwakeSince } from "./fleet";
import {
  elapsedMs,
  exitKey,
  type LaunchdExit,
  logStartArg,
  logTime,
  type PrintedJob,
  parseExits,
  parseList,
  parsePrint,
} from "./launchd-model";
import { expandHome } from "./paths";

export interface RunResult {
  stdout: string;
  code: number | null;
}

/** Run a command; with `firstLine`, stop it once its first line is out and answer with that line. */
export type Runner = (
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; firstLine?: boolean },
) => Promise<RunResult>;

export const LAUNCHCTL = "/bin/launchctl";
export const PLUTIL = "/usr/bin/plutil";
export const LOG = "/usr/bin/log";
export const PS = "/bin/ps";

/** The commands the timeline may run, each only with the verb that reads. */
const READS: Record<string, (args: readonly string[]) => boolean> = {
  [LAUNCHCTL]: (args) => (args[0] === "list" && args.length === 1) || (args[0] === "print" && args.length === 2),
  [PLUTIL]: (args) => args.length === 5 && args[0] === "-convert" && args[2] === "-o" && args[3] === "-",
  [LOG]: (args) => args[0] === "show",
  [PS]: (args) => args[0] === "-o" && args[1] === "etime=" && args[2] === "-p" && args.length === 4,
};

export class NotARead extends Error {}

/** A runner that runs only the reads above, and refuses anything else before it starts. */
export function readOnly(run: Runner): Runner {
  return (command, args, options) => {
    const allowed = READS[command];
    if (!allowed?.(args)) {
      return Promise.reject(new NotARead(`Refused to run ${command} ${args.join(" ")}: the timeline only reads.`));
    }
    return run(command, args, options);
  };
}

/** The real runner: no shell, a bounded output, killed at its timeout. */
export const execRunner: Runner = (command, args, { timeoutMs, firstLine }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (result: RunResult | Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`${command} took longer than ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) {
        child.kill("SIGKILL");
        finish(new Error(`${command} wrote more than 32 MB`));
        return;
      }
      chunks.push(chunk);
      if (firstLine) {
        const text = Buffer.concat(chunks).toString("utf8");
        const end = text.indexOf("\n");
        if (end >= 0) {
          child.kill("SIGTERM");
          finish({ stdout: text.slice(0, end), code: 0 });
        }
      }
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish({ stdout: Buffer.concat(chunks).toString("utf8"), code }));
  });

/** One job as the Mac has it. */
export interface LaunchdJob {
  label: string;
  /** In `launchctl list`: launchd will run it. A plist in LaunchAgents that is not loaded is listed too. */
  loaded: boolean;
  printed: PrintedJob | null;
  /** Its plist, as plutil reads it. */
  plist: Record<string, unknown> | null;
  /** When the run going now started, if one is. */
  runningSince: number | null;
  running: boolean;
  logPath: string | null;
  /** The end of its log, up to LOG_TAIL_BYTES. */
  logText: string | null;
  logWrittenAt: number | null;
}

export interface LaunchdRead {
  readAt: number;
  jobs: LaunchdJob[];
  /** Every run end known, oldest first. */
  exits: LaunchdExit[];
  /** How far back run ends are known: absence before it proves nothing. */
  coverage: number | null;
  awakeSince: number | null;
  warnings: string[];
}

export const LOG_TAIL_BYTES = 64 * 1024;
/** Run ends are kept this long. */
const KEEP_MS = TIMELINE_WINDOW_MS + 60 * 60_000;
/** An incremental read starts this far before the last one ended, so a run end on the edge is not lost. */
const OVERLAP_MS = 2 * 60_000;
const SHORT_MS = 10_000;
const LOG_MS = 90_000;

export interface LaunchdOptions {
  run?: Runner;
  uid?: number;
  /** Labels that start with this are read. */
  prefix?: string;
  agentsDir?: string;
  /** When the Mac last woke or booted: server/fleet.ts kernelAwakeSince when not given. */
  awakeSince?: () => Promise<number | null>;
  now?: () => number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Launchd {
  private readonly run: Runner;
  private readonly uid: number;
  private readonly prefix: string;
  private readonly agentsDir: string;
  private readonly now: () => number;
  private readonly awakeSince: () => Promise<number | null>;
  private readonly exits = new Map<string, LaunchdExit>();
  /** Where the last successful read of the unified log ended. */
  private readTo: number | null = null;
  /** How far back the first read reached; the reads since keep it continuous. */
  private reach: number | null = null;
  private inFlight: Promise<LaunchdRead> | null = null;

  constructor(options: LaunchdOptions = {}) {
    this.run = readOnly(options.run ?? execRunner);
    this.uid = options.uid ?? process.getuid?.() ?? 501;
    this.prefix = options.prefix ?? "com.broomva.";
    this.agentsDir = options.agentsDir ?? expandHome("~/Library/LaunchAgents");
    this.now = options.now ?? Date.now;
    this.awakeSince = options.awakeSince ?? (() => kernelAwakeSince());
  }

  /** One read of everything; a read asked for while one runs gets that one. */
  read(): Promise<LaunchdRead> {
    this.inFlight ??= this.readNow().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async readNow(): Promise<LaunchdRead> {
    const readAt = this.now();
    const warnings: string[] = [];
    const [listed, plists, awakeSince] = await Promise.all([
      this.run(LAUNCHCTL, ["list"], { timeoutMs: SHORT_MS }).then(
        (result) => parseList(result.stdout, this.prefix),
        (error) => {
          warnings.push(`launchctl list could not be read: ${errorText(error)}`);
          return null;
        },
      ),
      readdir(this.agentsDir).then(
        (names) => names.filter((name) => name.startsWith(this.prefix) && name.endsWith(".plist")),
        () => [] as string[],
      ),
      this.awakeSince().catch(() => null),
      this.readExits(readAt, warnings),
    ]);
    const loaded = new Map((listed ?? []).map((job) => [job.label, job]));
    const labels = new Set([...loaded.keys(), ...plists.map((name) => name.slice(0, -".plist".length))]);
    const jobs = await Promise.all(
      [...labels].sort().map((label) => this.job(label, listed === null ? null : loaded.has(label), warnings)),
    );
    return {
      readAt,
      // When launchctl list itself failed, whether a job is loaded is not known: only the listed ones are kept.
      jobs: jobs.filter((job): job is LaunchdJob => job !== null),
      exits: [...this.exits.values()].sort((a, b) => a.endedAt - b.endedAt),
      coverage: this.reach === null ? null : Math.max(this.reach, readAt - KEEP_MS),
      awakeSince,
      warnings,
    };
  }

  private async job(label: string, loaded: boolean | null, warnings: string[]): Promise<LaunchdJob | null> {
    if (loaded === null) return null;
    const printed = loaded
      ? await this.run(LAUNCHCTL, ["print", `gui/${this.uid}/${label}`], { timeoutMs: SHORT_MS }).then(
          (result) => parsePrint(result.stdout),
          (error) => {
            warnings.push(`launchctl print ${label} could not be read: ${errorText(error)}`);
            return null;
          },
        )
      : null;
    const plistPath = printed?.path ?? join(this.agentsDir, `${label}.plist`);
    const plist = await this.run(PLUTIL, ["-convert", "json", "-o", "-", plistPath], { timeoutMs: SHORT_MS }).then(
      (result) => {
        const value = JSON.parse(result.stdout) as unknown;
        return typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : null;
      },
      (error) => {
        warnings.push(`The plist of ${label} could not be read: ${errorText(error)}`);
        return null;
      },
    );
    const pid = printed?.pid ?? null;
    const running = printed?.state === "running" || pid !== null;
    const runningSince =
      running && pid !== null
        ? await this.run(PS, ["-o", "etime=", "-p", String(pid)], { timeoutMs: SHORT_MS }).then(
            (result) => {
              const elapsed = elapsedMs(result.stdout);
              return elapsed === null ? null : this.now() - elapsed;
            },
            () => null,
          )
        : null;
    const outPath =
      (typeof plist?.StandardOutPath === "string" ? plist.StandardOutPath : null) ?? printed?.stdout ?? null;
    const tail = outPath ? await readTail(expandHome(outPath)) : null;
    return {
      label,
      loaded,
      printed,
      plist,
      running,
      runningSince,
      logPath: outPath,
      logText: tail?.text ?? null,
      logWrittenAt: tail && tail.size > 0 ? tail.mtimeMs : null,
    };
  }

  /** New run ends since the last read (a day of them the first time), and how far back the log reaches. */
  private async readExits(readAt: number, warnings: string[]): Promise<void> {
    const predicate = `process == "launchd" AND subsystem BEGINSWITH "gui/${this.uid}/${this.prefix}" AND eventMessage BEGINSWITH "exited"`;
    const range = this.readTo === null ? ["--last", "24h"] : ["--start", logStartArg(this.readTo - OVERLAP_MS)];
    const first = this.reach === null;
    const [shown, probe] = await Promise.allSettled([
      this.run(LOG, ["show", ...range, "--style", "ndjson", "--predicate", predicate], { timeoutMs: LOG_MS }),
      // The oldest launchd event the log still holds, read once: before it, no run end could have been seen.
      first
        ? this.run(LOG, ["show", "--last", "24h", "--style", "ndjson", "--predicate", 'process == "launchd"'], {
            timeoutMs: LOG_MS,
            firstLine: true,
          })
        : Promise.resolve(null),
    ]);
    if (shown.status === "rejected") {
      warnings.push(`The unified log could not be read, so launchd runs are not all shown: ${errorText(shown.reason)}`);
      return;
    }
    const found = parseExits(shown.value.stdout);
    for (const exit of found) this.exits.set(exitKey(exit), exit);
    for (const [key, exit] of this.exits) if (exit.endedAt < readAt - KEEP_MS) this.exits.delete(key);
    if (first) {
      const oldestFound = found[0]?.endedAt ?? null;
      const probed = probe.status === "fulfilled" && probe.value ? probeTime(probe.value.stdout) : null;
      const reaches = [oldestFound, probed].filter((at): at is number => at !== null);
      this.reach = reaches.length > 0 ? Math.min(...reaches) : null;
    }
    this.readTo = readAt;
  }
}

function probeTime(line: string): number | null {
  try {
    const event = JSON.parse(line) as { timestamp?: unknown };
    return typeof event.timestamp === "string" ? logTime(event.timestamp) : null;
  } catch {
    return null;
  }
}

/** The last LOG_TAIL_BYTES of a file, from a whole line, with its mtime and size; null when it cannot be read. */
async function readTail(path: string): Promise<{ text: string; mtimeMs: number; size: number } | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    handle = await open(path, "r");
    const length = Math.min(info.size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    let text = buffer.toString("utf8");
    if (length < info.size) text = text.slice(text.indexOf("\n") + 1);
    return { text, mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}
