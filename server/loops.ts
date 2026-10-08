// The Loops view's read (BRO-2911 spec §2–§4): the intent ledger beside
// every loop observed on this machine, reconciled (server/loops-model.ts).
// The observations reuse the Timeline's adapters, so the two views never
// disagree on a run: launchd jobs and fleet ticks and Maestro's wake come from
// the Timeline's own view, Paseo schedules and heartbeats from the daemon's
// schedule files (the same files the Timeline reads, kept whole here: a
// bound row needs the schedule's name, target and prompt), launchd presence
// from `launchctl list` + `print-disabled`, and the two new substrates from
// server/gha.ts and server/p9.ts. Session crons are P3's (BRO-2932).
//
// Read-only, with one write: each drift transition appends one envelope line
// to ~/.broomva/ledger/loops/drift.jsonl through the workspace's own writer,
// scripts/broomva_home.py as origin/main has it (the hash chain and its lock
// stay that script's), and only transitions, never a line per read. Nothing
// here schedules, starts, stops or retargets a loop; a BOUND_SESSION_GONE
// carries the rollover seam for BRO-2933 and runs nothing.

import { execFile, spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import type {
  LoopIntent,
  LoopNotice,
  LoopObservation,
  LoopRow,
  LoopRun,
  LoopsView,
  SubstrateKind,
} from "../shared/loops";
import type { TimelineSource, TimelineView } from "../shared/timeline";
import type { GhaSchedules } from "./gha";
import type { LedgerRead, LedgerSource } from "./loops-ledger";
import {
  type AgentState,
  type Binding,
  loopNeeds,
  nextBaselines,
  type OpenDrift,
  openFrom,
  reconcile,
  type TickEvent,
  type Transition,
  transitions,
} from "./loops-model";
import { readP9 } from "./p9";
import { fleetLabel, StoredScheduleSchema, scheduleCadence, scheduleName } from "./timeline-model";

/** A view computed this recently is served as it is: several clients polling read once. */
export const LOOPS_VIEW_MS = 10_000;
/** A transition whose write failed is tried again this long after. */
export const WRITE_BACKOFF_MS = 5 * 60_000;
/** The header count waits this long for a read before it answers with the last one. */
export const LOOPS_NOTICE_WAIT_MS = 2_000;
/** The stream file's lines kept for the drift fold, ticks and rollovers: the tail. */
const STREAM_TAIL = 2 * 1024 * 1024;

/** Append one drift transition (spec §4): the envelope's writer, or a test's fake. */
export type DriftWriter = (line: Transition & { data?: Record<string, unknown> }) => Promise<void>;

export interface LoopsOptions {
  ledger: LedgerSource | null;
  /** The Timeline's view: its launchd, fleet and loop sources. */
  timeline: { get(): Promise<TimelineView> } | null;
  schedulesDir: string;
  /** Each label's presence; null on a host without launchd. */
  presence: ((labels: readonly string[]) => Promise<Map<string, "on" | "off" | "gone">>) | null;
  gha: Pick<GhaSchedules, "observe"> | null;
  /** `~/.config/broomva/p9`; null: not read. */
  p9Dir: string | null;
  /** `ledger/loops` and `notes/loops` under the .broomva home (loopPaths()). */
  streams: string;
  notes: string;
  /** Where drift.jsonl is read back from; defaults to `<streams>/drift.jsonl` (the writer's stream loops/drift). */
  driftFile?: string;
  /** Paseo agents by id, for bound rows; null: not looked up (BOUND_SESSION_GONE (a) not judged). */
  agents: ((ids: readonly string[]) => Promise<Map<string, AgentState>>) | null;
  /** Where transitions go; null: computed and not written (a read-only dogfood). */
  writer: DriftWriter | null;
  now?: () => number;
  log?: (message: string) => void;
}

// ── Observations from what the Timeline and the schedule files hold ─────────

const iso = (value: string | null | undefined) => {
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(at) ? null : new Date(at).toISOString();
};

const sriLabel = (label: string) => /(^|\.)sri($|\.)/.test(label);

/** A Timeline source as a loop observation: launchd jobs, fleet scopes (their launchd job), Maestro's wake. */
export function timelineObservation(
  source: TimelineSource,
  presence: ReadonlyMap<string, "on" | "off" | "gone">,
): LoopObservation | null {
  let kind: SubstrateKind;
  let ref: string;
  if (source.kind === "launchd" || source.kind === "fleet") {
    kind = "launchd";
    ref = source.kind === "fleet" ? fleetLabel(source.id.slice("fleet:".length)) : source.id.slice("launchd:".length);
  } else if (source.kind === "loop") {
    kind = "maestro-loop";
    ref = "wake";
  } else return null;
  const subject = kind === "maestro-loop" ? "loop:maestro/wake" : `loop:launchd/${ref}`;
  const present =
    kind === "maestro-loop"
      ? source.status === "off"
        ? "off"
        : "on"
      : (presence.get(ref) ?? (source.status === "off" ? "off" : "on"));
  return {
    subject,
    kind,
    ref,
    name: source.name,
    scope: sriLabel(ref) ? "sri" : "broomva",
    presence: present,
    status: source.status,
    reason: source.reason,
    since: source.since,
    cadence: source.cadence,
    next: source.next,
    last: source.last,
    runs: source.runs,
    ephemeral: false,
    where: source.where,
  };
}

/** A launchd label a ledger row names that the Timeline does not read (not broomva's prefix): presence only. */
export function labelObservation(label: string, presence: "on" | "off" | "gone"): LoopObservation | null {
  if (presence === "gone") return null;
  return {
    subject: `loop:launchd/${label}`,
    kind: "launchd",
    ref: label,
    name: label,
    scope: label.startsWith("com.broomva.") ? "broomva" : "external",
    presence,
    status: presence === "on" ? "unknown" : "off",
    reason:
      presence === "on"
        ? "Loaded; its runs are not read (outside the Timeline's prefix)."
        : "Present, not loaded or disabled.",
    since: null,
    cadence: "launchd",
    next: null,
    last: null,
    runs: [],
    ephemeral: false,
    where: null,
  };
}

const RUN_STATUS = { running: "running", succeeded: "ok", failed: "failed" } as const;
const SRI_CWD = /\/(work\/stimulus|getstimulus|sri)(\/|$)/i;

/**
 * One Paseo schedule file as an observation: presence from its status, the
 * runs with their scheduledFor (the tick join key), its name, target and
 * prompt. Status and next come from the Timeline's source when it has one
 * (the miss rule is its), else from the file.
 */
export function scheduleObservation(
  raw: unknown,
  file: string,
  source: TimelineSource | null,
  now: number,
): LoopObservation | null {
  const parsed = StoredScheduleSchema.safeParse(raw);
  if (!parsed.success) return null;
  const schedule = parsed.data;
  const extra = raw as { name?: unknown; createdAt?: unknown };
  const kind: SubstrateKind = schedule.target.type === "agent" ? "paseo-heartbeat" : "paseo-schedule";
  const expired = (Date.parse(schedule.expiresAt ?? "") || Number.POSITIVE_INFINITY) < now;
  const on = schedule.status === "active" && !expired;
  const runs: LoopRun[] = [...schedule.runs].reverse().flatMap((run) => {
    const at = iso(run.startedAt);
    if (!at) return [];
    const output = run.output?.trim();
    return [
      {
        at,
        endedAt: iso(run.endedAt),
        status: RUN_STATUS[run.status],
        exit: null,
        detail: run.status === "failed" ? run.error?.trim() || "failed" : null,
        ...(run.agentId ? { agentId: run.agentId } : {}),
        ...(output ? { output: output.slice(0, 280) } : {}),
        ...(iso(run.scheduledFor) ? { scheduledFor: iso(run.scheduledFor) as string } : {}),
      },
    ];
  });
  const cwd = schedule.target.type === "new-agent" ? (schedule.target.config.cwd ?? "") : "";
  return {
    subject: `loop:${kind}/${schedule.id}`,
    kind,
    ref: schedule.id,
    name: scheduleName(schedule),
    scope: SRI_CWD.test(cwd) ? "sri" : "broomva",
    presence: on ? "on" : "off",
    status: source?.status ?? (on ? (runs[0]?.status === "failed" ? "failed" : "ok") : "off"),
    reason:
      source?.reason ??
      (on ? "Active." : `${schedule.status === "paused" ? "Paused" : expired ? "Expired" : "Completed"}.`),
    since: source?.since ?? runs[0]?.at ?? null,
    cadence: scheduleCadence(schedule.cadence),
    next: source?.next ?? (on ? iso(schedule.nextRunAt) : null),
    last: runs[0] ?? null,
    runs: runs.slice(0, 50),
    // A one-shot (maxRuns 1) is a one-off, as a single /loop is: listed, never UNREGISTERED.
    ephemeral: schedule.maxRuns === 1,
    scheduleName: typeof extra.name === "string" ? extra.name : null,
    createdAt: typeof extra.createdAt === "string" ? iso(extra.createdAt) : null,
    expiresAt: iso(schedule.expiresAt),
    target: {
      agentId: schedule.target.type === "agent" ? schedule.target.agentId : null,
      prompt: schedule.prompt ?? null,
    },
    where: file,
  };
}

// ── The envelope streams (ticks, rollover, drift) ────────────────────────────

interface Envelope extends TickEvent {
  stream?: string;
}

/** The lines of an envelope stream that read; a torn one is skipped. */
export function envelopes(text: string): Envelope[] {
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const value = JSON.parse(line) as Envelope;
      return value && typeof value.type === "string" && typeof value.subject === "string"
        ? [{ ...value, cause: value.cause ?? null, data: value.data ?? {} }]
        : [];
    } catch {
      return [];
    }
  });
}

async function readTail(path: string, limit: number | null = STREAM_TAIL): Promise<string> {
  try {
    const text = await readFile(path, "utf8");
    return limit !== null && text.length > limit ? text.slice(text.indexOf("\n", text.length - limit) + 1) : text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/** A loop's carry-forward state file (§1a): ok, missing or unparseable. */
export async function stateOf(path: string): Promise<"ok" | "missing" | "unparseable"> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unparseable";
  }
  const doc = parseDocument(text);
  const value: unknown = doc.errors.length === 0 ? doc.toJS() : null;
  return value && typeof value === "object" && !Array.isArray(value) ? "ok" : "unparseable";
}

/**
 * The drift writer: `scripts/broomva_home.py append loops/drift …` as the
 * control repo's origin/main has it, its bytes piped to python3 (no working
 * tree is trusted to be on main). Actor daemon:maestro (spec §4).
 */
export function homeWriter(repo: string, env: NodeJS.ProcessEnv = process.env): DriftWriter {
  // Read once per batch of transitions, not once per line.
  let kept: { at: number; source: Promise<string> } | null = null;
  const script = () => {
    if (kept && Date.now() - kept.at < 60_000) return kept.source;
    const source = read();
    kept = { at: Date.now(), source };
    source.catch(() => {
      kept = null;
    });
    return source;
  };
  const read = () =>
    new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        ["-C", repo, "show", "origin/main:scripts/broomva_home.py"],
        { maxBuffer: 8 * 1024 * 1024 },
        (error, stdout) =>
          error ? reject(new Error(`reading broomva_home.py from origin/main: ${error.message}`)) : resolve(stdout),
      );
    });
  return async (line) => {
    const source = await script();
    const args = [
      "-",
      "append",
      "loops/drift",
      line.type,
      line.subject,
      "--actor",
      "daemon:maestro",
      "--data",
      JSON.stringify({ kind: line.kind, detail: line.detail.slice(0, 500), ...(line.data ?? {}) }),
    ];
    await new Promise<void>((resolve, reject) => {
      const child = spawn("python3", args, { env, stdio: ["pipe", "ignore", "pipe"] });
      let err = "";
      child.stderr.on("data", (chunk: Buffer) => {
        err += chunk.toString("utf8");
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`broomva_home.py append exited ${code}: ${err.trim().split("\n")[0] ?? ""}`));
      });
      child.stdin.end(source);
    });
  };
}

// ── The read ─────────────────────────────────────────────────────────────────

export class Loops {
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private computed: { at: number; view: LoopsView } | null = null;
  private computing: Promise<LoopsView> | null = null;
  /** What drift.jsonl leaves open; read once, then kept as each read writes. */
  private open: OpenDrift | null = null;
  private baselines = new Map<string, Binding>();
  /** Transition lines whose write failed, and when: retried after WRITE_BACKOFF_MS. */
  private readonly failed = new Map<string, number>();
  private logged = "";

  constructor(private readonly options: LoopsOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.log(`[maestro] ${message}`));
  }

  /** The view, computed at most every LOOPS_VIEW_MS; reads asked for while one runs get that one. */
  get(): Promise<LoopsView> {
    const last = this.computed;
    if (last && this.now() - last.at < LOOPS_VIEW_MS) return Promise.resolve(last.view);
    this.computing ??= this.compute().finally(() => {
      this.computing = null;
    });
    return this.computing;
  }

  /** What needs you (loopNeeds()), waiting LOOPS_NOTICE_WAIT_MS at most, else the last view's. */
  async notices(): Promise<LoopNotice[]> {
    const reading = this.get().catch(() => null);
    const timeout = new Promise<null>((done) => {
      setTimeout(() => done(null), LOOPS_NOTICE_WAIT_MS).unref?.();
    });
    const view = (await Promise.race([reading, timeout])) ?? this.computed?.view ?? null;
    return view ? loopNeeds(view.rows) : [];
  }

  private async compute(): Promise<LoopsView> {
    const warnings: string[] = [];
    const now = this.now();
    const unread = new Set<string>();
    let ledger: LedgerRead | null = null;
    if (this.options.ledger) {
      try {
        ledger = await this.options.ledger.read();
      } catch (error) {
        warnings.push(`The loop ledger could not be read: ${(error as Error).message}`);
      }
    } else warnings.push("No control repo: the loop ledger is not read.");
    const intents = ledger?.intents ?? [];
    const schedulesBroken = { value: false };
    const [timeline, schedules, gha, p9] = await Promise.all([
      this.options.timeline?.get().catch((error) => {
        warnings.push(`The Timeline could not be read: ${(error as Error).message}`);
        return null;
      }) ?? Promise.resolve(null),
      this.schedules(warnings, schedulesBroken),
      this.gha(intents, warnings),
      this.p9(now, warnings),
    ]);
    if (!timeline) unread.add("launchd").add("maestro-loop");
    // A Timeline that read but could not read launchd or the fleet leaves those jobs out: unread, not gone.
    if (timeline?.warnings.some((line) => /^(launchd|the fleet) could not be read/i.test(line))) unread.add("launchd");
    if (!schedules) unread.add("paseo-heartbeat").add("paseo-schedule");
    if (gha.unread === "all") unread.add("gha-schedule");
    else for (const repo of gha.unread) unread.add(`gha-schedule:${repo}`);
    if (!p9) unread.add("p9");
    // Session crons are P3's adapter (BRO-2932): until it lands, not read.
    unread.add("session-cron");
    const sources = timeline?.sources ?? [];
    const labels = new Set(
      [
        ...sources.filter((one) => one.kind === "launchd").map((one) => one.id.slice("launchd:".length)),
        ...sources.filter((one) => one.kind === "fleet").map((one) => fleetLabel(one.id.slice("fleet:".length))),
        ...intents.filter((one) => one.substrate.kind === "launchd").map((one) => one.substrate.ref),
      ].sort(),
    );
    let presence = new Map<string, "on" | "off" | "gone">();
    if (this.options.presence) {
      try {
        presence = await this.options.presence([...labels]);
      } catch (error) {
        warnings.push(`launchd presence could not be read: ${(error as Error).message}`);
        unread.add("launchd");
      }
    } else unread.add("launchd");
    const fromTimeline = sources.flatMap((source) => timelineObservation(source, presence) ?? []);
    const seen = new Set(fromTimeline.map((one) => one.ref));
    const extraLaunchd = [...labels]
      .filter((label) => !seen.has(label))
      .flatMap((label) => labelObservation(label, presence.get(label) ?? "gone") ?? []);
    const scheduleObservations = (schedules ?? []).map(({ raw, file }) => {
      const id = (raw as { id?: string }).id ?? "";
      const source = sources.find((one) => one.id === `heartbeat:${id}` || one.id === `schedule:${id}`) ?? null;
      return scheduleObservation(raw, file, source, now);
    });
    // A schedule file that would not read or parse leaves its loop out: the Paseo substrates are unread this time.
    if (schedulesBroken.value || scheduleObservations.some((one) => one === null)) {
      unread.add("paseo-heartbeat").add("paseo-schedule");
    }
    const observations = [
      ...fromTimeline,
      ...extraLaunchd,
      ...scheduleObservations.flatMap((one) => one ?? []),
      ...gha.observations,
      ...(p9 ?? []),
    ];
    const evidence = await this.evidence(intents, observations, warnings);
    // Read back what is open first: a restart judges against the baselines it had.
    const canWrite = ledger ? await this.loadOpen(warnings) : false;
    const rows = reconcile(intents, observations, now, { ...evidence, unread, baselines: this.baselines });
    this.baselines = nextBaselines(rows, this.baselines, now, evidence.rollovers);
    // An unread ledger judges nothing: every observation would read as unregistered.
    const judged = ledger ? rows : rows.map((row) => ({ ...row, drift: [], unread: true }));
    if (canWrite) await this.record(judged, unread, warnings);
    const said = warnings.join("\n");
    if (said && said !== this.logged) this.log(`loops: ${warnings.join("; ")}`);
    this.logged = said;
    const view: LoopsView = {
      now: new Date(now).toISOString(),
      ledger: this.options.ledger
        ? { repo: this.options.ledger.where.repo, sha: ledger?.sha ?? null, path: this.options.ledger.where.path }
        : null,
      rows: judged,
      ledgerErrors: ledger?.errors ?? [],
      warnings,
    };
    this.computed = { at: this.now(), view };
    return view;
  }

  private async schedules(
    warnings: string[],
    broken: { value: boolean },
  ): Promise<{ raw: unknown; file: string }[] | null> {
    const dir = this.options.schedulesDir;
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      warnings.push(`Paseo's schedules could not be read: ${(error as Error).message}`);
      return null;
    }
    const out: { raw: unknown; file: string }[] = [];
    for (const name of names) {
      const file = join(dir, name);
      try {
        out.push({ raw: JSON.parse(await readFile(file, "utf8")), file });
      } catch (error) {
        warnings.push(`Paseo schedule ${name} could not be read: ${(error as Error).message}`);
        broken.value = true;
      }
    }
    return out;
  }

  private async gha(intents: readonly LoopIntent[], warnings: string[]) {
    const refs = intents.filter((one) => one.substrate.kind === "gha-schedule").map((one) => one.substrate.ref);
    if (!this.options.gha) return { observations: [], unread: "all" as const };
    return this.options.gha.observe(refs, warnings);
  }

  private async p9(now: number, warnings: string[]): Promise<LoopObservation[] | null> {
    if (!this.options.p9Dir) return null;
    try {
      return await readP9(this.options.p9Dir, now);
    } catch (error) {
      warnings.push(`p9's watchers could not be read: ${(error as Error).message}`);
      return null;
    }
  }

  private async evidence(intents: readonly LoopIntent[], observations: readonly LoopObservation[], warnings: string[]) {
    const { streams, notes } = this.options;
    const [ticks, rollovers] = await Promise.all(
      ["ticks.jsonl", "rollover.jsonl"].map((name) =>
        readTail(join(streams, name)).then(envelopes, (error) => {
          warnings.push(`${name} could not be read: ${(error as Error).message}`);
          return [] as Envelope[];
        }),
      ),
    );
    const prompted = intents.filter((one) => one.prompt);
    const states = new Map(
      await Promise.all(
        prompted.map(async (one) => [one.id, await stateOf(join(notes, one.id, "state.yaml"))] as const),
      ),
    );
    let agents: Map<string, AgentState> | undefined;
    const bound = intents
      .filter((one) => one.session === "bound")
      .map((one) => one.substrate.ref.slice("name:".length));
    const ids = observations
      .filter((one) => one.scheduleName && bound.includes(one.scheduleName))
      .flatMap((one) => one.target?.agentId ?? []);
    if (this.options.agents && ids.length > 0) {
      agents = await this.options.agents(ids).catch((error) => {
        warnings.push(`Paseo's sessions could not be read for the bound loops: ${(error as Error).message}`);
        return undefined;
      });
    }
    return { ticks, rollovers, states, agents };
  }

  /**
   * What drift.jsonl leaves open, read once before the first reconcile, so a
   * restart neither re-detects what is open nor judges an open TARGET_CHANGED
   * without the binding it was detected against. The whole file is folded: it
   * holds transitions only.
   */
  private async loadOpen(warnings: string[]): Promise<boolean> {
    if (this.open) return true;
    try {
      const lines = envelopes(
        await readTail(this.options.driftFile ?? join(this.options.streams, "drift.jsonl"), null),
      );
      const open = openFrom(lines);
      for (const line of lines) {
        const base = line.data.baseline as Binding | undefined;
        const id = line.subject.startsWith("loop:") ? line.subject.slice(5) : null;
        if (line.data.kind === "target_changed" && id && base && open.has(`${line.subject}#target_changed`)) {
          this.baselines.set(id, base);
        }
      }
      this.open = open;
      return true;
    } catch (error) {
      warnings.push(`drift.jsonl could not be read, so no transition is written: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Append each transition since the last read. A line that fails is said and
   * stays pending (tried again after WRITE_BACKOFF_MS); the lines after it are
   * still written, so one bad line never holds the rest.
   */
  private async record(rows: readonly LoopRow[], unread: ReadonlySet<string>, warnings: string[]): Promise<void> {
    if (!this.open) return;
    const { lines, open } = transitions(this.open, rows, unread);
    if (lines.length === 0 || !this.options.writer) {
      this.open = open;
      return;
    }
    const written: OpenDrift = new Map(this.open);
    const now = this.now();
    for (const line of lines) {
      const key = `${line.type} ${line.subject}#${line.kind}`;
      const failed = this.failed.get(key);
      if (failed && now - failed < WRITE_BACKOFF_MS) continue;
      const id = line.subject.startsWith("loop:") ? line.subject.slice(5) : "";
      const base =
        line.kind === "target_changed" && line.type === "loop.drift.detected" ? this.baselines.get(id) : undefined;
      try {
        await this.options.writer({ ...line, ...(base ? { data: { baseline: base } } : {}) });
        this.failed.delete(key);
        if (line.type === "loop.drift.detected") {
          written.set(`${line.subject}#${line.kind}`, { subject: line.subject, kind: line.kind, detail: line.detail });
        } else written.delete(`${line.subject}#${line.kind}`);
      } catch (error) {
        this.failed.set(key, now);
        warnings.push(`A drift transition could not be written: ${(error as Error).message}`);
      }
    }
    this.open = written;
  }
}
