// fleet-reconcile's hourly runs, read from the files the fleet writes: its
// config (~/.config/ctx/fleet.json), and per scope its ledger, its tick
// reports (ticks/NNNNN/report.{json,md}) and its LaunchAgent. Read-only, with
// one exception: your verdicts on the dry run's proposals, appended to
// `proposal-reviews.jsonl` in the scope's state dir. The fleet has no verb
// that records a review, so Maestro writes this one file, in a format the
// fleet owns (BRO-2764) and reads once BRO-2766 lands. Nothing here runs a
// fleet verb, writes the fleet's ledger, or changes its mode, dry run or kill
// switch.
//
// A missed tick is measured against time the Mac was awake: launchd skips an
// interval that falls while it sleeps, and the next tick can come up to an
// interval after it wakes (spec §5.7). A heartbeat sees the wake as a gap in
// its own timer.

import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { WorkItem } from "../shared/contracts";
import {
  FLEET_REPORT_BYTES,
  FLEET_TICKS,
  type FleetDetail,
  type FleetHealth,
  type FleetNotice,
  type FleetProposal,
  type FleetScope,
  type FleetTick,
  type FleetView,
  type ReviewVerdict,
} from "../shared/fleet";
import { UserError } from "./engine";
import {
  actProposals,
  asksOf,
  coverOf,
  fleetItem,
  foldLedger,
  foldReviews,
  healthOf,
  type LedgerFold,
  openAlerts,
  parseJsonLines,
  type ReportSummary,
  reviewRecord,
  SCOPE_ID,
  summarizeReport,
  tickRows,
  withReviews,
} from "./fleet-model";
import { expandHome, fleetPaths } from "./paths";
import { endsWithNewline } from "./store";

export const REVIEWS_FILE = "proposal-reviews.jsonl";
/** tick.sh leaves this in the state dir while the kill switch is off. */
export const DISABLED_NOTICE = ".disabled-notice";
/** install.sh's LaunchAgent for a scope. */
export const plistName = (scope: string) => `com.broomva.fleet-reconcile.${scope}.plist`;

/** The heartbeat that notices the Mac slept: a beat this late means the process was suspended. */
const BEAT_MS = 60_000;
const SLEEP_GAP_MS = 5 * 60_000;
/** A tick past its config budget by this much, with no exit recorded, died. */
const BUDGET_GRACE_MS = 5 * 60_000;
const DEFAULT_TICK_MINUTES = 15;

export interface FleetOptions {
  /** The fleet config, its state root and its LaunchAgents: server/paths.ts fleetPaths when not given. */
  configPath?: string;
  /** Where state dirs live when the config names none, or cannot be read. */
  stateRoot?: string;
  agentsDir?: string;
  /** Maestro's work, from the files alone (no session reconcile): the fleet's asks and alerts are items in it. */
  items: () => Promise<readonly WorkItem[]>;
  now?: () => number;
  log?: (message: string) => void;
}

interface ScopeConfig {
  id: string;
  stateDir: string;
  mode: string | null;
  dryRun: boolean | null;
  budgetMs: number;
}

interface ScopeRead {
  config: ScopeConfig;
  fold: LedgerFold;
  tickDirs: number[];
  schedule: { scheduled: boolean; intervalMs: number | null; at: number | null };
  disabled: boolean;
  warnings: string[];
}

type Stamp = string;
const stampOf = (info: { mtimeMs: number; size: number }): Stamp => `${info.mtimeMs}:${info.size}`;
const CACHE_LIMIT = 400;

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

export class Fleet {
  private readonly configPath: string;
  private readonly stateRoot: string;
  private readonly agentsDir: string;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly ledgers = new Map<string, { stamp: Stamp; fold: LedgerFold; bad: number }>();
  /** Each report.json read, by path, until it changes: one that would not parse is kept as its error. */
  private readonly reports = new Map<string, { stamp: Stamp; summary: ReportSummary | null; error: string | null }>();
  private writes: Promise<unknown> = Promise.resolve();
  private awakeSince: number | null = null;
  private lastBeat: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: FleetOptions) {
    const paths = fleetPaths();
    this.configPath = options.configPath ?? paths.config;
    this.stateRoot = options.stateRoot ?? paths.stateRoot;
    this.agentsDir = options.agentsDir ?? paths.agents;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.log(`[maestro] ${message}`));
    this.lastBeat = this.now();
  }

  /** Starts the heartbeat. */
  start(): void {
    if (this.timer) return;
    this.lastBeat = this.now();
    this.timer = setInterval(() => this.beat(), BEAT_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One heartbeat: a gap far past the beat means the host slept, and it woke now. */
  beat(now: number = this.now()): void {
    if (now - this.lastBeat > SLEEP_GAP_MS) this.awakeSince = now;
    this.lastBeat = now;
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  /** The scopes, from the fleet config, else from the state dirs under the state root. */
  private async scopes(): Promise<{ scopes: ScopeConfig[]; error: string | null }> {
    let raw: string;
    try {
      raw = await readFile(this.configPath, "utf8");
    } catch (error) {
      if (code(error) === "ENOENT") return { scopes: await this.discovered(), error: null };
      return {
        scopes: await this.discovered(),
        error: `The fleet config could not be read: ${(error as Error).message}`,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { scopes: await this.discovered(), error: `The fleet config (${this.configPath}) is not valid JSON.` };
    }
    const sections = (parsed as { scopes?: unknown })?.scopes;
    if (typeof sections !== "object" || sections === null || Array.isArray(sections)) {
      return { scopes: await this.discovered(), error: `The fleet config (${this.configPath}) has no scopes.` };
    }
    const scopes: ScopeConfig[] = [];
    for (const [id, value] of Object.entries(sections)) {
      if (!SCOPE_ID.test(id) || typeof value !== "object" || value === null) continue;
      const section = value as Record<string, unknown>;
      const dir = typeof section.state_dir === "string" && section.state_dir ? section.state_dir : null;
      const minutes = typeof section.tick_timeout_min === "number" ? section.tick_timeout_min : DEFAULT_TICK_MINUTES;
      scopes.push({
        id,
        stateDir: dir ? expandHome(dir) : join(this.stateRoot, id),
        mode: typeof section.mode === "string" ? section.mode : null,
        dryRun: section.dry_run === undefined ? null : section.dry_run !== 0,
        budgetMs: minutes * 60_000 + BUDGET_GRACE_MS,
      });
    }
    return { scopes, error: null };
  }

  /** State dirs that hold a ledger or ticks: what the fleet wrote, when its config says nothing. */
  private async discovered(): Promise<ScopeConfig[]> {
    let names: string[];
    try {
      names = await readdir(this.stateRoot);
    } catch {
      return [];
    }
    const found: ScopeConfig[] = [];
    for (const id of names.sort()) {
      if (!SCOPE_ID.test(id)) continue;
      const stateDir = join(this.stateRoot, id);
      const has = await Promise.all(
        ["ledger.jsonl", "ticks"].map((name) =>
          stat(join(stateDir, name)).then(
            () => true,
            () => false,
          ),
        ),
      );
      if (has.some(Boolean)) {
        found.push({
          id,
          stateDir,
          mode: null,
          dryRun: null,
          budgetMs: DEFAULT_TICK_MINUTES * 60_000 + BUDGET_GRACE_MS,
        });
      }
    }
    return found;
  }

  private async ledger(path: string, warnings: string[]): Promise<LedgerFold> {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(path);
    } catch (error) {
      if (code(error) !== "ENOENT") warnings.push(`The ledger could not be read: ${(error as Error).message}`);
      return foldLedger([]);
    }
    const stamp = stampOf(info);
    let cached = this.ledgers.get(path);
    if (cached?.stamp !== stamp) {
      try {
        const { records, bad } = parseJsonLines(await readFile(path, "utf8"));
        cached = { stamp, fold: foldLedger(records), bad };
        this.ledgers.set(path, cached);
      } catch (error) {
        warnings.push(`The ledger could not be read: ${(error as Error).message}`);
        return foldLedger([]);
      }
    }
    if (cached.bad > 0) warnings.push(`The ledger has ${cached.bad} line(s) that did not parse; they are left out.`);
    return cached.fold;
  }

  private async report(scope: string, stateDir: string, tick: number, warnings: string[]) {
    const path = join(stateDir, "ticks", String(tick).padStart(5, "0"), "report.json");
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(path);
    } catch {
      return null;
    }
    const stamp = stampOf(info);
    let cached = this.reports.get(path);
    if (cached?.stamp !== stamp) {
      // A report being written reads torn: read again once it changes.
      cached = { stamp, summary: null, error: null };
      try {
        cached.summary = summarizeReport(JSON.parse(await readFile(path, "utf8")), scope, tick);
      } catch (error) {
        cached.error = `Tick ${tick}'s report.json could not be read: ${(error as Error).message}`;
      }
      if (this.reports.size >= CACHE_LIMIT) this.reports.delete(this.reports.keys().next().value as string);
      this.reports.set(path, cached);
    }
    if (cached.error) warnings.push(cached.error);
    return cached.summary;
  }

  private async schedule(scope: string): Promise<ScopeRead["schedule"]> {
    const path = join(this.agentsDir, plistName(scope));
    try {
      const [info, text] = await Promise.all([stat(path), readFile(path, "utf8")]);
      const interval = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(text)?.[1];
      return { scheduled: true, intervalMs: interval ? Number(interval) * 1000 : null, at: info.mtimeMs };
    } catch {
      return { scheduled: false, intervalMs: null, at: null };
    }
  }

  private async readScope(config: ScopeConfig): Promise<ScopeRead> {
    const warnings: string[] = [];
    const [fold, tickDirs, schedule, disabled] = await Promise.all([
      this.ledger(join(config.stateDir, "ledger.jsonl"), warnings),
      readdir(join(config.stateDir, "ticks")).then(
        (names) => names.filter((name) => /^\d+$/.test(name)).map(Number),
        (error) => {
          if (code(error) !== "ENOENT")
            warnings.push(`The ticks folder could not be read: ${(error as Error).message}`);
          return [] as number[];
        },
      ),
      this.schedule(config.id),
      stat(join(config.stateDir, DISABLED_NOTICE)).then(
        () => true,
        () => false,
      ),
    ]);
    return { config, fold, tickDirs, schedule, disabled, warnings };
  }

  /** The newest report there is, searching back from the newest tick. */
  private async newestReport(read: ScopeRead, warnings: string[]): Promise<ReportSummary | null> {
    const ticks = [...new Set([...read.fold.ticks.keys(), ...read.tickDirs])].sort((a, b) => b - a);
    for (const tick of ticks.slice(0, 5)) {
      const summary = await this.report(read.config.id, read.config.stateDir, tick, warnings);
      if (summary) return summary;
    }
    return null;
  }

  private async reviews(stateDir: string, scope: string, warnings: string[]) {
    try {
      const { records, bad } = parseJsonLines(await readFile(join(stateDir, REVIEWS_FILE), "utf8"));
      if (bad > 0) warnings.push(`${REVIEWS_FILE} has ${bad} line(s) that did not parse; they are left out.`);
      return foldReviews(records, scope);
    } catch (error) {
      if (code(error) !== "ENOENT") warnings.push(`${REVIEWS_FILE} could not be read: ${(error as Error).message}`);
      return foldReviews([], scope);
    }
  }

  /** Health and the newest tick, which every poll of the header count reads: the ledger, two stats and a listing. */
  private healthOf(
    read: ScopeRead,
    items: readonly WorkItem[],
    now: number,
  ): { health: FleetHealth; latest: FleetTick | null } {
    const [latest = null] = tickRows(read.fold, new Map(), read.tickDirs, now, read.config.budgetMs, 1);
    const base = healthOf({
      disabled: read.disabled,
      scheduled: read.schedule.scheduled,
      intervalMs: read.schedule.intervalMs,
      scheduledAt: read.schedule.at,
      latest,
      awakeSince: this.awakeSince,
      now,
    });
    const cover = coverOf(read.config.id, base.status, latest?.failedStep ?? null, items);
    const item = cover ? fleetItem(cover) : null;
    const urgent = base.status === "missed" || base.status === "failing";
    return { health: { ...base, item, needsYou: urgent && !item?.needsYou }, latest };
  }

  /** What needs you on its own (work.attention): each scope's missed or failing tick not already in Needs you as the fleet's item. */
  async notices(items: readonly WorkItem[]): Promise<FleetNotice[]> {
    const { scopes } = await this.scopes();
    const now = this.now();
    const reads = await Promise.all(scopes.map((scope) => this.readScope(scope)));
    return reads.flatMap((read) => {
      const { health } = this.healthOf(read, items, now);
      if (!health.needsYou || (health.status !== "missed" && health.status !== "failing")) return [];
      return [{ scope: read.config.id, status: health.status, reason: health.reason, since: health.since }];
    });
  }

  /** Every scope's summary, and one scope in full: `scope`, else the first. */
  async get(scope?: string, ticks: number = FLEET_TICKS.default): Promise<FleetView> {
    const [{ scopes, error }, items] = await Promise.all([this.scopes(), this.options.items()]);
    const now = this.now();
    const reads = await Promise.all(scopes.map((config) => this.readScope(config)));
    const summaries: FleetScope[] = [];
    let detail: FleetDetail | null = null;
    const chosen = reads.find((read) => read.config.id === scope) ?? reads[0];
    for (const read of reads) {
      const { id, stateDir } = read.config;
      const warnings = [...read.warnings];
      const { health, latest } = this.healthOf(read, items, now);
      const newest = await this.newestReport(read, warnings);
      const reviews = await this.reviews(stateDir, id, warnings);
      const proposals = withReviews(
        [...(newest?.proposals ?? []), ...actProposals(read.fold.dryActs, (latest?.tick ?? 0) - 24)],
        reviews,
      );
      const asks = asksOf(id, newest?.asksOpen ?? [], read.fold, items);
      summaries.push({
        id,
        mode: read.config.mode ?? newest?.mode ?? null,
        dryRun: read.config.dryRun ?? newest?.dryRun ?? null,
        health,
        lastTick: latest ? { tick: latest.tick, at: latest.at, status: latest.status } : null,
        unreviewed: proposals.filter((proposal) => proposal.review === null).length,
        openAsks: asks.length,
      });
      if (read !== chosen) continue;
      const numbers = [...new Set([...read.fold.ticks.keys(), ...read.tickDirs])].sort((a, b) => b - a).slice(0, ticks);
      const reports = new Map<number, ReportSummary>();
      for (const tick of numbers) {
        const summary = await this.report(id, stateDir, tick, warnings);
        if (summary) reports.set(tick, summary);
      }
      detail = {
        id,
        stateDir,
        schedule: {
          scheduled: read.schedule.scheduled,
          intervalMinutes: read.schedule.intervalMs !== null ? Math.round(read.schedule.intervalMs / 60_000) : null,
        },
        ticks: tickRows(read.fold, reports, read.tickDirs, now, read.config.budgetMs, ticks),
        report: newest ? await this.markdown(stateDir, newest.tick, warnings) : null,
        proposals,
        asks,
        alerts: openAlerts(id, items).map(fleetItem),
        // One file read twice (the newest report, then the tick rows) is said once.
        warnings: [...new Set(warnings)],
      };
    }
    return { scopes: summaries, detail, error };
  }

  private async markdown(stateDir: string, tick: number, warnings: string[]): Promise<FleetDetail["report"]> {
    const path = join(stateDir, "ticks", String(tick).padStart(5, "0"), "report.md");
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, "r");
      const { size } = await handle.stat();
      const length = Math.min(size, FLEET_REPORT_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, 0);
      return { tick, markdown: buffer.toString("utf8"), truncated: size > FLEET_REPORT_BYTES };
    } catch (error) {
      if (code(error) !== "ENOENT")
        warnings.push(`Tick ${tick}'s report.md could not be read: ${(error as Error).message}`);
      return null;
    } finally {
      await handle?.close();
    }
  }

  // ── Your verdict ───────────────────────────────────────────────────────────

  /**
   * Records your verdict on one proposal in the scope's review file, and
   * returns the proposal with it. Only a proposal the fleet makes now can be
   * reviewed. Writes run one at a time, each one line, fsynced.
   */
  review(input: {
    scope: string;
    key: string;
    verdict: ReviewVerdict;
    note: string;
  }): Promise<{ proposal: FleetProposal }> {
    const next = this.writes.catch(() => undefined).then(() => this.reviewNow(input));
    this.writes = next;
    return next;
  }

  private async reviewNow(input: { scope: string; key: string; verdict: ReviewVerdict; note: string }) {
    const { scopes } = await this.scopes();
    const config = scopes.find((scope) => scope.id === input.scope);
    if (!config) throw new UserError(`The fleet has no scope named ${input.scope}.`);
    const view = await this.get(config.id, 1);
    const proposal = view.detail?.proposals.find((entry) => entry.key === input.key);
    if (!proposal) {
      throw new UserError(
        "The fleet no longer proposes this: its latest report changed. Look at the Fleet view again.",
      );
    }
    try {
      if (!(await stat(config.stateDir)).isDirectory()) throw new Error("not a folder");
    } catch {
      throw new UserError(
        `The fleet's state dir for ${config.id} is gone (${config.stateDir}), so nothing was recorded.`,
      );
    }
    const at = new Date(this.now());
    const record = reviewRecord({ scope: config.id, proposal, verdict: input.verdict, note: input.note, at });
    const path = join(config.stateDir, REVIEWS_FILE);
    const lead = (await endsWithNewline(path)) ? "" : "\n";
    const handle = await open(path, "a", 0o600);
    try {
      await handle.write(`${lead}${JSON.stringify(record)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.log(
      `fleet ${config.id}: you ${input.verdict === "accept" ? "accepted" : "rejected"} "${proposal.action}" (${proposal.key})`,
    );
    const review = {
      verdict: input.verdict,
      note: (record.note as string | null) ?? null,
      at: at.toISOString(),
      tick: proposal.tick,
    };
    return { proposal: { ...proposal, review } };
  }
}
