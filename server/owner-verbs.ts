// The owner's verbs and their undo window (BRO-2999, B4). One ledger holds every
// verb of yours that changes state. A verb is recorded when you make it, takes
// effect UNDO_MS later unless you undo it, and leaves a receipt: what you did,
// what it did, or why it was dropped. A decision at the gate (server/engine.ts
// verdict) keeps its own window on the work's own events; everything else is
// here: Allow and Deny on a held action, a prompt to a session, cancel for
// queued work, stop, unblock, leave-running, an answer, a review, Settings and
// the loop's wake.
//
// The ledger is one append-only file (`verbs.jsonl`): `verb.pending` when you
// decide, then `verb.undone`, `verb.applied` or `verb.dropped`. A timer applies
// the verb when its window closes; the plugin sweep (server/sweep.ts), from
// load on, applies anything overdue and arms the rest, so a restart inside the
// window still applies it. Every guard is checked again when it applies: the
// verb is about the thing you saw, and when that has moved the verb is dropped,
// with a receipt that says why, never applied to something else.
//
// Applied once, across processes (BRO-3080): two daemons can read one ledger (a reload that overlaps the old
// daemon), and both would find the same verb due. Every write here is made under the ledger's file lock
// (server/locks.ts), and a verb about to apply is first claimed with a `verb.claimed` line carrying the claimant's
// pid and start. A process that reads a claim by a live process leaves the verb to it; one by a dead process
// settles it as dropped, since whether it took effect is not known and a second prompt is worse than none.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { UNDO_MS } from "../shared/undo";
import { ALREADY_PENDING, type OwnerVerb, type PendingVerb, RECENT_VERBS_MS, type SettledVerb } from "../shared/verbs";
import { CLIENT_WAIT_MS, realTimer, type Timer, UserError } from "./engine";
import { appendLinesLocked } from "./jsonl";
import { holderAlive, started, withFileLock } from "./locks";
import { lockRootBeside } from "./paths";
import type { Paseo } from "./runs";

/** What a verb's apply needs, and says. */
export interface VerbSpec<Args> {
  /**
   * Run at the call, before anything is recorded: refuse what cannot work now
   * (throw a UserError), so a refusal reaches you at once and not as a dropped
   * receipt eight seconds later.
   */
  check?: (args: Args, paseo: Paseo | null) => Promise<void>;
  /**
   * Run once the window closes, re-checking every guard. Throw a UserError when
   * what you decided on has moved: the verb is dropped with that reason. Returns
   * what it did, in words, for the receipt.
   */
  apply: (args: Args, paseo: Paseo | null, receipt: string) => Promise<string>;
  /** True when apply needs the daemon client: with none, a due verb waits for one. */
  client?: boolean;
  /** A newer verb on the same key replaces a pending one (Settings toggled twice). */
  supersedes?: boolean;
}

type Line =
  | {
      kind: "verb.pending";
      receipt: string;
      verb: OwnerVerb;
      key: string;
      label: string;
      at: string;
      appliesAt: string;
      args: unknown;
    }
  | { kind: "verb.claimed"; receipt: string; at: string; pid: number; start: number }
  | { kind: "verb.undone" | "verb.applied" | "verb.dropped"; receipt: string; at: string; detail: string };

interface Entry {
  receipt: string;
  verb: OwnerVerb;
  key: string;
  label: string;
  at: string;
  appliesAt: string;
  args: unknown;
  /** The process taking it into effect, once one has claimed it. */
  claim: { pid: number; start: number } | null;
  settled: { outcome: "applied" | "undone" | "dropped"; at: string; detail: string } | null;
}

export interface OwnerVerbsOptions {
  /** The ledger's file. */
  path: string;
  now?: () => Date;
  client?: () => Paseo | null;
  /** Schedules the undo window. Tests pass their own, driven by the same clock as `now`. */
  timer?: Timer;
  /** How long a verb waits before it takes effect: UNDO_MS (8 s, B4). Only a test's or a dogfood's passes another. */
  windowMs?: number;
  log?: (message: string) => void;
}

/** What a settled verb's text says when apply returned nothing. */
const DID = "Done.";
/** What a verb says when the process that was applying it is gone: whether it took effect is not known. */
const CLAIMANT_GONE =
  "Maestro stopped while it was taking effect, so it is not known whether it did. It was not applied again.";

export class OwnerVerbs {
  private readonly path: string;
  private readonly now: () => Date;
  private readonly client: () => Paseo | null;
  private readonly timer: Timer;
  private readonly windowMs: number;
  private readonly log: (message: string) => void;
  private readonly specs = new Map<OwnerVerb, VerbSpec<never>>();
  /** Windows armed, by receipt, to the timer's cancel. */
  private readonly armed = new Map<string, () => void>();
  private readonly applying = new Set<string>();
  private closed = false;

  constructor(options: OwnerVerbsOptions) {
    this.path = options.path;
    this.now = options.now ?? (() => new Date());
    this.client = options.client ?? (() => null);
    this.timer = options.timer ?? realTimer;
    this.windowMs = options.windowMs ?? UNDO_MS;
    this.log = options.log ?? (() => undefined);
  }

  /** Teach the ledger what a verb does. Called once per verb, before the first schedule. */
  register<Args>(verb: OwnerVerb, spec: VerbSpec<Args>): void {
    this.specs.set(verb, spec as unknown as VerbSpec<never>);
  }

  /** The plugin is shutting down: clear every window's timer. What is pending stays on disk. */
  stop(): void {
    this.closed = true;
    for (const cancel of this.armed.values()) cancel();
    this.armed.clear();
  }

  /**
   * Run `work` holding the ledger's lock, after every writer before it, in this process and in any other: a verb is
   * read, decided and recorded without another writer between. Every `write` is made inside one.
   */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    return withFileLock(this.path, lockRootBeside(this.path), work, { what: "the verbs ledger" });
  }

  /** Protected so a test can hold a read open: the race with another process's write is its to stage. */
  protected async read(): Promise<Map<string, Entry>> {
    const entries = new Map<string, Entry>();
    let text = "";
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      let line: Line;
      try {
        line = JSON.parse(raw) as Line;
      } catch {
        continue;
      }
      if (line.kind === "verb.pending") {
        if (typeof line.receipt === "string" && !entries.has(line.receipt)) {
          entries.set(line.receipt, { ...line, claim: null, settled: null });
        }
        continue;
      }
      const entry = entries.get(line.receipt);
      if (!entry || entry.settled) continue;
      if (line.kind === "verb.claimed") {
        entry.claim = { pid: line.pid, start: line.start };
        continue;
      }
      entry.settled = {
        outcome: line.kind.slice("verb.".length) as "applied" | "undone" | "dropped",
        at: line.at,
        detail: line.detail,
      };
    }
    return entries;
  }

  /** Only inside `serial`, which holds the ledger's lock. */
  private async write(line: Line): Promise<void> {
    await appendLinesLocked(this.path, [line]);
  }

  /** Whether the process that claimed a verb is still taking it into effect. */
  private async claimLive(receipt: string, claim: { pid: number; start: number }): Promise<boolean> {
    if (claim.pid === process.pid) return this.applying.has(receipt);
    return holderAlive(`${claim.pid} ${claim.start}`);
  }

  /**
   * Record a verb: it takes effect UNDO_MS from now unless undone. `check` runs
   * first, so a refusal is immediate. A verb already waiting on the same key is
   * refused (Undo it first), or replaced when the verb says a newer one does.
   */
  async schedule<Args>(
    verb: OwnerVerb,
    request: { key: string; label: string; args: Args },
  ): Promise<{ receipt: string; appliesAt: string }> {
    const spec = this.specs.get(verb) as unknown as VerbSpec<Args> | undefined;
    if (!spec) throw new Error(`no verb ${verb} is registered`);
    const paseo = this.client();
    await spec.check?.(request.args, paseo);
    const { receipt, appliesAt } = await this.serial(async () => {
      const entries = await this.read();
      for (const entry of entries.values()) {
        if (entry.settled || entry.verb !== verb || entry.key !== request.key) continue;
        if (!spec.supersedes) throw new UserError(ALREADY_PENDING);
        // One taking effect this moment cannot be replaced: it applies, and the newer one waits its own window.
        if (this.applying.has(entry.receipt) || (entry.claim && (await this.claimLive(entry.receipt, entry.claim)))) {
          continue;
        }
        await this.write({
          kind: "verb.undone",
          receipt: entry.receipt,
          at: this.stamp(),
          detail: "Replaced by a newer one.",
        });
        this.disarm(entry.receipt);
      }
      const at = this.now();
      const made = { receipt: randomUUID(), appliesAt: new Date(at.getTime() + this.windowMs).toISOString() };
      await this.write({
        kind: "verb.pending",
        receipt: made.receipt,
        verb,
        key: request.key,
        label: request.label,
        at: at.toISOString(),
        appliesAt: made.appliesAt,
        args: request.args,
      });
      return made;
    });
    this.arm(receipt, appliesAt);
    return { receipt, appliesAt };
  }

  /** Whether this ledger holds a verb with this receipt (a work's gate decision keeps its own window). */
  async knows(receipt: string): Promise<boolean> {
    return (await this.read()).has(receipt);
  }

  /** Take a verb back while its window runs. Idempotent for one already undone. */
  async undo(receipt: string): Promise<{ undone: boolean }> {
    return this.serial(async () => {
      const entry = (await this.read()).get(receipt);
      if (!entry) throw new UserError("There is no such decision to undo.");
      if (entry.settled?.outcome === "undone") return { undone: true };
      if (entry.settled?.outcome === "applied") throw new UserError("Too late to undo: it already took effect.");
      if (entry.settled) throw new UserError(`There is nothing to undo: ${entry.settled.detail}`);
      // Being applied this moment, here or by another process: the window has closed.
      if (this.applying.has(receipt) || (entry.claim && (await this.claimLive(receipt, entry.claim)))) {
        throw new UserError("Too late to undo: it is taking effect.");
      }
      await this.write({ kind: "verb.undone", receipt, at: this.stamp(), detail: "You undid it." });
      this.disarm(receipt);
      return { undone: true };
    });
  }

  /** What waits to take effect, and what settled in the last day, newest first. */
  async list(): Promise<{ pending: PendingVerb[]; recent: SettledVerb[] }> {
    const now = this.now().getTime();
    const pending: PendingVerb[] = [];
    const recent: SettledVerb[] = [];
    for (const entry of (await this.read()).values()) {
      const { args: _args, settled, ...head } = entry;
      if (!settled) {
        pending.push({ ...head, remainingMs: Math.max(0, Date.parse(entry.appliesAt) - now) });
      } else if (now - Date.parse(settled.at) < RECENT_VERBS_MS) {
        recent.push({ ...head, settledAt: settled.at, outcome: settled.outcome, detail: settled.detail });
      }
    }
    pending.sort((a, b) => b.at.localeCompare(a.at));
    recent.sort((a, b) => b.settledAt.localeCompare(a.settledAt));
    return { pending, recent: recent.slice(0, 50) };
  }

  /**
   * Apply every verb whose window has closed, and arm a timer for the rest.
   * Runs in every sweep, the first one at load, so a restart inside the window
   * still applies the verb. Never from a read. True when any settled.
   */
  async resume(): Promise<boolean> {
    const now = this.now().getTime();
    let changed = false;
    for (const entry of (await this.read()).values()) {
      if (entry.settled) continue;
      if (Date.parse(entry.appliesAt) > now) {
        this.arm(entry.receipt, entry.appliesAt);
        continue;
      }
      const outcome = await this.applyDue(entry.receipt).catch((error) => {
        this.log(`applying ${entry.verb} ${entry.receipt}: ${(error as Error).message}`);
        return "settled" as const;
      });
      if (outcome === "waiting") this.arm(entry.receipt, entry.appliesAt, CLIENT_WAIT_MS);
      if (outcome === "applied" || outcome === "dropped") changed = true;
    }
    return changed;
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  /** Apply the verb when its window closes, or after `delay` when given (waiting for a client). */
  private arm(receipt: string, appliesAt: string, delay?: number): void {
    if (this.closed || this.armed.has(receipt)) return;
    const wait = delay ?? Math.max(0, Date.parse(appliesAt) - this.now().getTime());
    const cancel = this.timer(async () => {
      const outcome = await this.applyDue(receipt).catch((error) => {
        this.log(`applying ${receipt}: ${(error as Error).message}`);
        return "settled" as const;
      });
      if (this.armed.get(receipt) === cancel) this.armed.delete(receipt);
      // Fired before the clock reached it: wait out the rest.
      if (outcome === "early") this.arm(receipt, appliesAt);
      if (outcome === "waiting") this.arm(receipt, appliesAt, CLIENT_WAIT_MS);
    }, wait);
    this.armed.set(receipt, cancel);
  }

  private disarm(receipt: string): void {
    this.armed.get(receipt)?.();
    this.armed.delete(receipt);
  }

  /** Take a due verb for this process: "claimed", or why not ("settled" for another's, or its own undo). */
  private claim(receipt: string): Promise<"claimed" | "settled" | "dropped"> {
    return this.serial(async () => {
      const entry = (await this.read()).get(receipt);
      if (!entry || entry.settled) return "settled";
      if (entry.claim) {
        // Another process is taking it into effect: leave it. A claimant that is gone left it unknown: settled, not repeated.
        if (await this.claimLive(receipt, entry.claim)) return "settled";
        await this.write({ kind: "verb.dropped", receipt, at: this.stamp(), detail: CLAIMANT_GONE });
        return "dropped";
      }
      await this.write({ kind: "verb.claimed", receipt, at: this.stamp(), pid: process.pid, start: await started() });
      return "claimed";
    });
  }

  /** Apply one verb once it is due, re-checking every guard, and record how it ended. */
  private async applyDue(receipt: string): Promise<"applied" | "dropped" | "early" | "waiting" | "settled"> {
    // Claimed first, before any await: the window's timer and the sweep both reach a due verb, and only one of them
    // may take it. An undo that finds it claimed is too late, and a replacement leaves it alone.
    if (this.applying.has(receipt)) return "settled";
    this.applying.add(receipt);
    try {
      const entry = (await this.read()).get(receipt);
      if (!entry || entry.settled) return "settled";
      if (Date.parse(entry.appliesAt) > this.now().getTime()) return "early";
      const spec = this.specs.get(entry.verb) as unknown as VerbSpec<unknown> | undefined;
      if (!spec) return "settled";
      // Read the client now, not when the timer was armed: one may have arrived since.
      const paseo = this.client();
      if (spec.client && !paseo) return "waiting";
      // Claimed under the ledger's lock, in line with every writer: an undo, or another process that found it due,
      // may have settled or claimed it since, and only one claimant takes it into effect.
      const claimed = await this.claim(receipt);
      if (claimed !== "claimed") return claimed;
      let detail: string;
      let outcome: "applied" | "dropped";
      try {
        detail = (await spec.apply(entry.args, paseo, receipt)) || DID;
        outcome = "applied";
      } catch (error) {
        detail = error instanceof UserError ? error.message : `It could not be done: ${(error as Error).message}`;
        outcome = "dropped";
        if (!(error instanceof UserError)) this.log(`${entry.verb} ${receipt}: ${(error as Error).message}`);
      }
      await this.serial(() =>
        this.write({
          kind: outcome === "applied" ? "verb.applied" : "verb.dropped",
          receipt,
          at: this.stamp(),
          detail,
        }),
      );
      return outcome;
    } finally {
      this.applying.delete(receipt);
    }
  }
}
