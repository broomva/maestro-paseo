// The broomva launchd jobs, read from the Mac: `launchctl list` and
// `launchctl print` for each job, its plist through `plutil`, its own log's
// tail, the run ends the unified log keeps (`log show`), and how far back
// that log reaches. Awake time is the plugin's one clock (server/fleet.ts
// AwakeClock), not read here. The parsing is pure (server/launchd-model.ts);
// this is only the reading.
//
// Read-only, and held to it: every command goes through `readOnly`, which
// runs a fixed binary only with a verb that reads (list, print, show,
// -convert to stdout, -o) and refuses anything else, so nothing here can
// load, unload, bootstrap, kickstart or kill a job.
//
// The unified log costs seconds to search a day of, so it is read once in
// full and then only from where the last read ended. Its run ends are kept in
// memory as long as the stretch they prove (EVIDENCE_MS, eight days): the two
// are one record, so the stretch can never claim a time whose run ends were
// let go.
//
// What the log saw is observed, never inferred (LaunchdRead.seen): each read
// asks the log for the first launchd event at or after where it starts, and
// only when that event is no later than where the last read ended (the log
// still held it) does the read extend the stretch the last one proved. A gap the log no longer holds,
// a probe that fails, or a first read starts the stretch again at what the
// log proves it holds now. A job's loaded-since is the first read that saw it
// loaded, never a file's date, and it starts again at a read that finds an
// unload of it in the log, or that had to start the stretch again (an unload
// in a gap the log no longer holds could not be seen).

import { spawn } from "node:child_process";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  EVIDENCE_MS,
  elapsedMs,
  exitKey,
  type LaunchdExit,
  logStartArg,
  logTime,
  type PrintedJob,
  parseExits,
  parseList,
  parsePrint,
  parseUnloads,
  type Seen,
} from "./launchd-model";
import { expandHome, LABEL_PREFIX } from "./paths";

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
          // One that ignores SIGTERM is not left running.
          const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
          kill.unref?.();
          child.once("close", () => clearTimeout(kill));
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
  /**
   * Since when it is proven loaded: the first read that saw it loaded, after
   * which every list that read saw it loaded, the log showed no unload of it,
   * and the stretch never started over. No miss before it is judged (a due
   * time there reads as not known). Null when it is not loaded.
   */
  loadedSince: number | null;
  /**
   * launchd's last exit code since the job was loaded: print's, else (print
   * failed) a non-zero status from the list. The list says 0 also for a job
   * that never exited, so its 0 is not taken as a pass.
   */
  lastExit: number | null;
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
  /**
   * The stretch the unified log is proven to have held, unbroken, through
   * the reads so far, and whose run ends `exits` still holds all of; null when
   * nothing is proven (no good read yet, or the last probe failed). Inside it,
   * a run that ended would be in `exits`.
   */
  seen: Seen | null;
  warnings: string[];
}

export const LOG_TAIL_BYTES = 64 * 1024;

/** An incremental read starts this far before the last one ended, so a run end on the edge is not lost. */
const OVERLAP_MS = 2 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const SHORT_MS = 10_000;
const LOG_MS = 90_000;

export interface LaunchdOptions {
  run?: Runner;
  uid?: number;
  /** Labels that start with this are read. */
  prefix?: string;
  agentsDir?: string;
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
  private readonly exits = new Map<string, LaunchdExit>();
  /** Where the last successful read of the unified log ended. */
  private readTo: number | null = null;
  /** What the log is proven to have held, unbroken, up to readTo (LaunchdRead.seen). */
  private stretch: Seen | null = null;
  /** The jobs the last list that read saw: shown, as last read, while a list fails. */
  private lastJobs: LaunchdJob[] = [];
  /** Each loaded job's loaded-since (LaunchdJob.loadedSince). */
  private readonly loadedSince = new Map<string, number>();
  /** Unloads already seen, by label and time, so the overlap of two reads counts one once. */
  private readonly unloads = new Map<string, number>();
  /**
   * What the log said about loading that no list has yet been read to apply:
   * the stretch started again, and the jobs it showed unloaded. Kept until a
   * list reads, so a list that fails loses neither.
   */
  private pending = { restarted: false, unloaded: new Set<string>() };
  private inFlight: Promise<LaunchdRead> | null = null;

  constructor(options: LaunchdOptions = {}) {
    this.run = readOnly(options.run ?? execRunner);
    this.uid = options.uid ?? process.getuid?.() ?? 501;
    this.prefix = options.prefix ?? "com.broomva.";
    if (!LABEL_PREFIX.test(this.prefix)) throw new Error(`Not a launchd label prefix: ${JSON.stringify(this.prefix)}`);
    this.agentsDir = options.agentsDir ?? expandHome("~/Library/LaunchAgents");
    this.now = options.now ?? Date.now;
  }

  /** A read that exited non-zero is a failed read, never an empty answer. */
  private async stdout(command: string, args: readonly string[], timeoutMs: number): Promise<string> {
    const result = await this.run(command, args, { timeoutMs });
    if (result.code !== 0) {
      throw new Error(`${command.split("/").pop()} ${args[0]} exited ${result.code ?? "on a signal"}`);
    }
    return result.stdout;
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
    const [listed, plists, logged] = await Promise.all([
      this.stdout(LAUNCHCTL, ["list"], SHORT_MS).then(
        (text) => parseList(text, this.prefix),
        (error) => {
          warnings.push(`launchctl list could not be read: ${errorText(error)}`);
          return null;
        },
      ),
      readdir(this.agentsDir).then(
        (names) => names.filter((name) => name.startsWith(this.prefix) && name.endsWith(".plist")),
        (error) => {
          // No LaunchAgents folder is no unloaded plists; one that cannot be read is said.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            warnings.push(`${this.agentsDir} could not be read, so jobs not loaded are not shown: ${errorText(error)}`);
          }
          return [] as string[];
        },
      ),
      this.readExits(readAt, warnings),
    ]);
    const loaded = new Map((listed ?? []).map((job) => [job.label, job]));
    // What the log said waits for a list to read: one that failed says nothing, and loses nothing.
    if (logged.restarted) this.pending.restarted = true;
    for (const label of logged.unloaded) this.pending.unloaded.add(label);
    if (listed) {
      for (const label of [...this.loadedSince.keys()]) if (!loaded.has(label)) this.loadedSince.delete(label);
      for (const label of loaded.keys()) {
        // Proven loaded from here: first seen, unloaded and back since, or nothing proves it stayed.
        if (!this.loadedSince.has(label) || this.pending.restarted || this.pending.unloaded.has(label)) {
          this.loadedSince.set(label, readAt);
        }
      }
      this.pending = { restarted: false, unloaded: new Set() };
    }
    const labels = new Set([...loaded.keys(), ...plists.map((name) => name.slice(0, -".plist".length))]);
    const jobs = await Promise.all(
      [...labels]
        .sort()
        .map((label) => this.job(label, listed === null ? null : (loaded.get(label) ?? false), warnings)),
    );
    // A list that fails keeps the jobs as the last one read them: a failed job's notice does not vanish with it.
    const read = jobs.filter((job): job is LaunchdJob => job !== null);
    if (listed) this.lastJobs = read;
    else if (this.lastJobs.length > 0) warnings.push("launchd's jobs are shown as the last list read them.");
    return {
      readAt,
      // Kept rows prove nothing about loading meanwhile: no loaded-since, so a failure still shows and no miss is judged.
      jobs: listed ? read : this.lastJobs.map((job) => ({ ...job, loadedSince: null })),
      exits: [...this.exits.values()].sort((a, b) => a.endedAt - b.endedAt),
      seen: this.stretch ? { ...this.stretch } : null,
      warnings,
    };
  }

  /**
   * One job. `listed` is its `launchctl list` row (false: not loaded; null:
   * the list could not be read, so the job is not shown). Each read that
   * fails costs only what it would have said, with a warning, never the job.
   */
  private async job(
    label: string,
    listed: { pid: number | null; status: number | null } | false | null,
    warnings: string[],
  ): Promise<LaunchdJob | null> {
    if (listed === null) return null;
    const loaded = listed !== false;
    const printed = loaded
      ? await this.stdout(LAUNCHCTL, ["print", `gui/${this.uid}/${label}`], SHORT_MS).then(parsePrint, (error) => {
          warnings.push(`launchctl print ${label} could not be read: ${errorText(error)}`);
          return null;
        })
      : null;
    const plistPath = printed?.path ?? join(this.agentsDir, `${label}.plist`);
    const plist = await this.plist(plistPath).catch((error) => {
      warnings.push(`The plist of ${label} could not be read: ${errorText(error)}`);
      return null;
    });
    // When print failed, the list's pid still says whether a run is going.
    const pid = printed ? printed.pid : listed ? listed.pid : null;
    const running = printed?.state === "running" || pid !== null;
    const runningSince =
      running && pid !== null
        ? await this.stdout(PS, ["-o", "etime=", "-p", String(pid)], SHORT_MS).then(
            (text) => {
              const elapsed = elapsedMs(text);
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
      loadedSince: loaded ? (this.loadedSince.get(label) ?? null) : null,
      lastExit: printed ? printed.lastExit : listed && listed.status !== 0 ? listed.status : null,
      running,
      runningSince,
      logPath: outPath,
      logText: tail?.text ?? null,
      logWrittenAt: tail && tail.size > 0 ? tail.mtimeMs : null,
    };
  }

  /** A plist as JSON; one that will not convert or is not a dictionary is an error. */
  private async plist(path: string): Promise<Record<string, unknown>> {
    const value = JSON.parse(await this.stdout(PLUTIL, ["-convert", "json", "-o", "-", path], SHORT_MS)) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("it is not a dictionary");
    return value as Record<string, unknown>;
  }

  /**
   * New run ends since the last read (a day of them the first time), and
   * what the log is proven to hold. Both queries start at the same second, a
   * little before the last read ended: the run ends, and the first launchd
   * event of any kind, which says where the log really begins now. The
   * stretch extends only when that event is no later than where the last
   * read ended; launchd writes every few seconds, so a quiet log only starts
   * the stretch again, which costs judging, never a page. A probe that fails
   * changes nothing but the run ends: the next read proves the same range.
   */
  private async readExits(
    readAt: number,
    warnings: string[],
  ): Promise<{ restarted: boolean; unloaded: ReadonlySet<string> }> {
    const own = `subsystem BEGINSWITH "gui/${this.uid}/${this.prefix}" AND (eventMessage BEGINSWITH "exited" OR eventMessage BEGINSWITH "bootout initiated")`;
    const predicate = `process == "launchd" AND ((${own}) OR eventMessage BEGINSWITH "removing service: ${this.prefix}")`;
    // To the second, as `log show --start` reads it.
    const start = Math.floor((this.readTo === null ? readAt - DAY_MS : this.readTo - OVERLAP_MS) / 1000) * 1000;
    const from = ["--start", logStartArg(start)];
    const [shown, probe] = await Promise.allSettled([
      this.stdout(LOG, ["show", ...from, "--style", "ndjson", "--predicate", predicate], LOG_MS),
      this.run(LOG, ["show", ...from, "--style", "ndjson", "--predicate", 'process == "launchd"'], {
        timeoutMs: LOG_MS,
        firstLine: true,
      }),
    ]);
    if (shown.status === "rejected") {
      // Nothing new was read: the stretch and where reads end stay put.
      warnings.push(`The unified log could not be read, so launchd runs are not all shown: ${errorText(shown.reason)}`);
      return { restarted: false, unloaded: new Set() };
    }
    for (const exit of parseExits(shown.value)) this.exits.set(exitKey(exit), exit);
    const keepFrom = readAt - EVIDENCE_MS;
    for (const [key, exit] of this.exits) if (exit.endedAt < keepFrom) this.exits.delete(key);
    // An unload is new once: the read overlaps the last, which may have seen it already.
    const unloaded = new Set<string>();
    for (const unload of parseUnloads(shown.value)) {
      const key = `${unload.label}:${unload.at}`;
      if (this.unloads.has(key)) continue;
      this.unloads.set(key, unload.at);
      unloaded.add(unload.label);
    }
    for (const [key, at] of this.unloads) if (at < keepFrom) this.unloads.delete(key);
    const held = probe.status === "fulfilled" ? probeTime(probe.value.stdout) : null;
    if (held === null) {
      // Nothing is proven, and nothing is given up: the stretch stays where it was, and the next read starts from
      // the same place and proves it then. Its run ends are kept; they are evidence either way.
      warnings.push("How far back the unified log reaches could not be read; nothing since its last read is judged.");
      return { restarted: false, unloaded };
    }
    let restarted = true;
    if (this.stretch && this.readTo !== null && held <= this.readTo) {
      // The log still holds an event from before the last read ended: nothing between is unseen.
      // The stretch keeps no further back than its run ends are kept.
      this.stretch = { from: Math.max(this.stretch.from, keepFrom), to: readAt };
      restarted = false;
    } else {
      // The first read, or a gap the log no longer holds: only what it holds now is proven.
      this.stretch = { from: Math.min(Math.max(held, start, keepFrom), readAt), to: readAt };
    }
    this.readTo = readAt;
    return { restarted, unloaded };
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
