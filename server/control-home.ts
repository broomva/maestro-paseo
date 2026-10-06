// The workspace's decision asks: every `.control/asks` ledger of the control
// repo, each ask read at its home and answered there, under the control
// interface's contract (workspace#861, docs/specs/2026-10-01-maestro-control-
// interface.html §5.2, "Which checkout: the home rule"):
//
// - Sources. origin/main's blobs (`git cat-file`, never a working tree), and
//   the working tree of every checkout `git worktree list` names, the main
//   checkout among them. Maestro's answers worktree is not a source. origin/
//   main is fetched at most once every 5 minutes.
// - The rule, per ask, first step that applies. In checkout W, B is
//   merge-base(HEAD, origin/main).
//   1. Main's outcome wins: main holds the same ask and records an outcome, so
//      it is closed, whatever any checkout holds.
//   2. W's copy is local when it differs from B's in some field and that change
//      has not landed (every field W changed reads, on main now, as W gave it).
//   3. Stamped first: the local copy in the checkout the ask's origin.cwd names.
//   4. The single local copy.
//   5. Two or more: diverged, listed, and answered nowhere until one is chosen.
//   6. Otherwise origin/main, whose answers go to the answers worktree,
//      `~/.local/state/maestro-paseo/control-answers` on `maestro/answers`.
// - Identity. The uid; an ask without one is (ledger, id), under the same-ask
//   test: W's entry existed at B, or equals main's, or (beyond the spec's
//   letter, for §5.2's squash-merged worktree that outlives the merge) W added
//   it and main holds it asked at the same time in the same words. Such an
//   ask's B, for step 2, is its entry as it first landed: the oldest of main's
//   last 200 first-parent commits to that ledger whose entry passes that test.
//   When that window does not reach the landing, W's copy counts only for an
//   outcome it records and main does not. Two entries with one handle that
//   fail it are an id collision: both shown, neither answered. So is a handle
//   two entries of one copy share, and an id with a uid in one copy and none
//   in another.
// - The main checkout is never a fallback: it is one checkout under the rule.
//
// An answer on maestro/answers is committed there and waits for the loop: it
// lands the batch through one gated PR (server/answers-landing.ts) and routes
// each answer once it is where it belongs (server/answer-routes.ts). Not here:
// re-application from receipts.

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { type AskHome, type AskNotice, askNotice, type DecisionAsk, homeKey } from "../shared/fleet";
import {
  type AnswerInput,
  ambiguity,
  answerDecision,
  canonical,
  decisionOf,
  isRow,
  LEDGER,
  parsed,
  type Row,
  readLedger,
  rowsOf,
  shown,
  stateOf,
  text,
} from "./control-asks";
import { UserError } from "./engine";

export const ASKS_DIR = join(".control", "asks");
export const MAIN_REF = "origin/main";
export const ANSWERS_BRANCH = "maestro/answers";
/** origin/main is fetched at most this often (§5.2). */
export const FETCH_EVERY_MS = 5 * 60_000;
/** A read is reused this long: the header count polls it from every client. */
export const READ_TTL_MS = 10_000;
const LEDGER_LIMIT = 1024 * 1024;
/** A `git cat-file --batch` of every ledger blob takes well under a second; past this it is stuck. */
const CAT_FILE_MS = 30_000;
/** An answer fetches origin/main first, unless it was fetched this recently. */
const ANSWER_FETCH_FRESH_MS = 30_000;
/** How far back main's history of a ledger is read for where a squash-merged ask first landed. */
export const LANDED_WINDOW = 200;

/** One ledger as parsed: its top level (for `arc`) and its asks list, in order. */
export interface Ledger {
  data: Row;
  rows: (Row | null)[];
}
export type Ledgers = Map<string, Ledger>;

export interface CheckoutCopy {
  path: string;
  branch: string | null;
  /** Its ledgers whose bytes differ from B's, as they read in its working tree. */
  tree: Ledgers;
  /** Those ledgers at B; one B lacks is absent. */
  base: Ledgers;
}

/** A ledger's copies on origin/main's first-parent history, oldest first; null where a commit removed it or it reads as no ledger. */
export interface MainHistory {
  copies: (Ledger | null)[];
  /** The oldest copy is the one that made the ledger, so nothing before it held an ask. */
  complete: boolean;
}

export interface Sources {
  controlRepo: string;
  /** Every ledger on origin/main. */
  main: Ledgers;
  checkouts: CheckoutCopy[];
  /** The answers worktree's ledgers that differ from main's. */
  answers: Ledgers;
  /** Main's history (the last LANDED_WINDOW commits to it) of each ledger landedLedgers names. */
  landed: Map<string, MainHistory>;
}

// ── The rule (pure) ──────────────────────────────────────────────────────────

/** Two parsed values alike: key order and whitespace aside, and a null key the same as none. */
function same(a: unknown, b: unknown): boolean {
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** The entries in a ledger that go by a handle: its uid, else its id among the asks without one. */
function entriesOf(ledger: Ledger | undefined, uid: string | null, id: string): Row[] {
  if (!ledger) return [];
  return ledger.rows.filter(
    (row): row is Row => row !== null && (uid ? text(row.uid) === uid : !text(row.uid) && text(row.id) === id),
  );
}

/**
 * Whether W's copy is local: it changed some field from B's (an ask B lacks
 * changed every field), and not every field it changed reads on main as W gave
 * it. Per field, so a squash merge that folded W's edit in with main's later
 * edit to another field has still landed.
 */
export function isLocal(base: Row | null, mine: Row, main: Row | null): boolean {
  const keys = new Set([...Object.keys(base ?? {}), ...Object.keys(mine)]);
  const changed = [...keys].filter((key) => !same(base?.[key], mine[key]));
  if (changed.length === 0) return false;
  if (!main) return true;
  return !changed.every((key) => same(main[key], mine[key]));
}

interface Copy {
  /** Index into sources.checkouts. */
  at: number;
  row: Row;
  ledger: Ledger;
  local: boolean;
}

function checkoutHome(copy: CheckoutCopy): AskHome {
  return { kind: "checkout", path: copy.path, branch: copy.branch };
}

/** The checkout a path lies in: the deepest one whose folder holds it. */
function checkoutAt(checkouts: readonly CheckoutCopy[], path: string): number {
  let best = -1;
  checkouts.forEach((copy, at) => {
    const inside = path === copy.path || path.startsWith(copy.path.endsWith(sep) ? copy.path : `${copy.path}${sep}`);
    if (inside && (best < 0 || copy.path.length > (checkouts[best]?.path.length ?? 0))) best = at;
  });
  return best;
}

function placeOf(sources: Sources, copy: CheckoutCopy): string {
  const rel = relative(sources.controlRepo, copy.path);
  const where = rel === "" ? "the main checkout" : copy.path;
  return copy.branch ? `${where} (${copy.branch})` : where;
}

function askOf(row: Row, ledger: Ledger, name: string, home: AskHome): DecisionAsk | null {
  return decisionOf(row, ledger.data, name, ambiguity(ledger.rows), home);
}

/** Its open asks refused, in words; an answered or retired one stays as it reads. */
function refuse(asks: readonly DecisionAsk[], refusal: string): DecisionAsk[] {
  return asks.map((ask) => (ask.state === "open" ? { ...ask, refusal } : ask));
}

/**
 * W added this ask (B lacks it) and main holds one by the same handle, asked at
 * the same moment in the same words: W's ask landed and main has edited it
 * since. The spec's same-ask test (W's entry equals main's) misses that case and
 * would call it a collision, where §5.2 says a squash-merged worktree that
 * outlives the merge must not. Both `asked_at` and the words must agree:
 * `asked_at` alone is shared by a batch of asks raised in one minute.
 */
function landedAndEdited(mine: Row, main: Row): boolean {
  if (text(mine.asked_at) === null || !same(mine.asked_at, main.asked_at)) return false;
  const words = (["ask", "question", "headline"] as const).filter(
    (key) => text(mine[key]) !== null && text(main[key]) !== null,
  );
  return words.length > 0 && words.every((key) => same(mine[key], main[key]));
}

/**
 * The ledgers whose history main's must be read for: some checkout holds an
 * ask without a uid that B lacks, that landed and was edited on main since,
 * and that reads unlike main's. Scan reads those, and only those.
 */
export function landedLedgers(sources: Pick<Sources, "main" | "checkouts">): string[] {
  const names = new Set<string>();
  for (const checkout of sources.checkouts) {
    for (const [name, ledger] of checkout.tree) {
      const mainLedger = sources.main.get(name);
      if (names.has(name) || !mainLedger) continue;
      const landed = ledger.rows.some((mine) => {
        const id = mine ? text(mine.id) : null;
        if (!mine || !id || text(mine.uid)) return false;
        const [main] = entriesOf(mainLedger, null, id);
        const [base] = entriesOf(checkout.base.get(name), null, id);
        return main !== undefined && base === undefined && !same(mine, main) && landedAndEdited(mine, main);
      });
      if (landed) names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * W's added ask as it first landed on main: the entry in the oldest copy of
 * main's history that passes landedAndEdited. Null when none does, or when the
 * oldest that does is the window's first and the window does not reach the
 * ledger's making, so an older copy may hold it.
 */
function firstLanded(history: MainHistory | undefined, id: string, mine: Row): Row | null {
  const copies = history?.copies ?? [];
  for (const [at, copy] of copies.entries()) {
    const row = entriesOf(copy ?? undefined, null, id).find((entry) => landedAndEdited(mine, entry));
    if (row) return at > 0 || history?.complete ? row : null;
  }
  return null;
}

/** One ledger's copy in one source: its rows that go by a handle, and where an answer to them would go. */
interface Held {
  ledger: Ledger;
  rows: Row[];
  home: AskHome;
}

/**
 * Every ask in the sources, each read at its home (the rule above), with a
 * refusal on one that may not be answered: diverged, an id collision, a handle
 * two entries of one copy share, or one ask that reads at two homes because a
 * copy carries a uid and another, changed, does not.
 */
export function resolveHomes(sources: Sources): DecisionAsk[] {
  const mainHome: AskHome = { kind: "main", path: sources.controlRepo, branch: null };
  const names = new Set<string>([
    ...sources.main.keys(),
    ...sources.checkouts.flatMap((copy) => [...copy.tree.keys()]),
  ]);
  const out: DecisionAsk[] = [];
  for (const name of [...names].sort()) {
    const ledgers = [sources.main.get(name), ...sources.checkouts.map((copy) => copy.tree.get(name))];
    // Every handle any copy holds, in list order.
    const handles: { uid: string | null; id: string }[] = [];
    const seen = new Set<string>();
    for (const ledger of ledgers) {
      for (const row of ledger?.rows ?? []) {
        const id = row ? text(row.id) : null;
        if (!row || !id) continue;
        const uid = text(row.uid);
        const key = uid ? `u:${uid}` : `i:${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        handles.push({ uid, id });
      }
    }
    const resolved = handles.map((handle) => ({ handle, asks: resolveOne(sources, name, handle, mainHome) }));
    // An id that reads as an ask both by a uid and without one (one copy stamped, another changed and not):
    // perhaps one ask at two homes, so neither is answered. A copy without one that changed nothing reads as nothing.
    const byUid = new Set(resolved.filter((r) => r.handle.uid && r.asks.length > 0).map((r) => r.handle.id));
    const byId = new Set(resolved.filter((r) => !r.handle.uid && r.asks.length > 0).map((r) => r.handle.id));
    for (const { handle, asks } of resolved) {
      const split = byUid.has(handle.id) && byId.has(handle.id);
      const refusal = `The ask ${handle.id} in ${name} reads with a uid in one copy and without one in another, so it may be one ask at two homes. Bring the copies to one (merge origin/main into the checkout, or remove a worktree that is done); Maestro answers neither.`;
      out.push(...(split ? refuse(asks, refusal) : asks));
    }
  }
  return out;
}

function resolveOne(
  sources: Sources,
  name: string,
  { uid, id }: { uid: string | null; id: string },
  mainHome: AskHome,
): DecisionAsk[] {
  const mainLedger = sources.main.get(name);
  const mainRows = entriesOf(mainLedger, uid, id);
  const [main = null] = mainRows;
  // Step 1: main's outcome wins, for the same ask, whatever any checkout holds (a doubled copy included). A
  // different ask under its id in a checkout, beside a copy of main's or alone, is still listed, below, as a collision.
  const closedOnMain = main !== null && mainLedger !== undefined && mainRows.length === 1 && stateOf(main) !== "open";
  const held: Held[] = [
    ...(mainLedger ? [{ ledger: mainLedger, rows: mainRows, home: mainHome }] : []),
    ...sources.checkouts.flatMap((checkout) => {
      const ledger = checkout.tree.get(name);
      return ledger ? [{ ledger, rows: entriesOf(ledger, uid, id), home: checkoutHome(checkout) }] : [];
    }),
  ];
  // A handle two entries of one copy share names no one ask: every copy's rows are listed (a checkout's copy
  // only where it differs from main's), and none answered.
  const doubled = held.filter((copy) => copy.rows.length > 1);
  if (doubled.length > 0 && !closedOnMain) {
    const where = doubled.map((copy) => homeWords(copy.home)).join("; ");
    const refusal = `Two asks in ${name} go by ${uid ?? id} in ${where}, so an answer could land on the wrong one. Give one a uid or a new id; Maestro answers none of them.`;
    const listed = held.filter(
      (copy) =>
        copy.home.kind === "main" ||
        copy.rows.length > 1 ||
        (copy.rows.length === 1 && !(mainRows.length === 1 && same(copy.rows[0], main))),
    );
    return refuse(
      listed.flatMap((copy) => copy.rows.flatMap((row) => askOf(row, copy.ledger, name, copy.home) ?? [])),
      refusal,
    );
  }

  const copies: Copy[] = [];
  const collisions: Copy[] = [];
  sources.checkouts.forEach((checkout, at) => {
    const ledger = checkout.tree.get(name);
    const rows = entriesOf(ledger, uid, id);
    if (!ledger) return;
    const [base = null] = entriesOf(checkout.base.get(name), uid, id);
    // Two rows by one handle in one copy reach here only when main's outcome wins (else refused above). Each is
    // judged, whatever their order, so main's answer never hides a different ask added beside the one W inherited.
    for (const mine of rows) {
      // The same-ask test, for an ask without a uid: W inherited it from B, or W's added ask has landed. Of two
      // rows, only one that equals B's or main's entry, or was asked at the same time in the same words, is it.
      const edited = uid === null && main !== null && base === null && landedAndEdited(mine, main);
      const sameAsk =
        rows.length > 1
          ? uid !== null || [base, main].some((ref) => ref !== null && (same(mine, ref) || landedAndEdited(mine, ref)))
          : uid !== null || main === null || base !== null || same(mine, main) || edited;
      // Landed and edited on main since: its B is its entry as it first landed on main, which tells W's edits since
      // from main's. With none in main's history window, W's copy counts only for an outcome it records and main
      // does not; an edit W made to another field after its ask landed then reads as main's until W lands it.
      const landed = edited ? firstLanded(sources.landed.get(name), id, mine) : null;
      const local =
        edited && !landed
          ? stateOf(mine) !== "open" && stateOf(main as Row) === "open"
          : isLocal(landed ?? base, mine, main);
      const copy = { at, row: mine, ledger, local };
      if (sameAsk) copies.push(copy);
      else collisions.push(copy);
    }
  });

  const asks: DecisionAsk[] = [];
  const locals = closedOnMain ? [] : copies.filter((copy) => copy.local);
  // Step 3: the checkout the ask's stamp names, when it holds a local copy.
  const stamped = new Set(
    locals.flatMap((copy) => {
      const cwd = isRow(copy.row.origin) ? text(copy.row.origin.cwd) : null;
      const at = cwd ? checkoutAt(sources.checkouts, cwd) : -1;
      return locals.some((local) => local.at === at) ? [at] : [];
    }),
  );
  const [stampedAt] = [...stamped];
  const home =
    stamped.size === 1 ? locals.find((copy) => copy.at === stampedAt) : locals.length === 1 ? locals[0] : null;
  if (closedOnMain) {
    const ask = askOf(main as Row, mainLedger as Ledger, name, mainHome);
    if (ask) asks.push(ask);
  } else if (home) {
    // Steps 3 and 4.
    const ask = askOf(home.row, home.ledger, name, checkoutHome(sources.checkouts[home.at] as CheckoutCopy));
    if (ask) asks.push(ask);
  } else if (locals.length > 1) {
    // Step 5: diverged.
    const [first] = locals;
    const where = locals.map((copy) => placeOf(sources, sources.checkouts[copy.at] as CheckoutCopy));
    const ask = first ? askOf(first.row, first.ledger, name, mainHome) : null;
    if (ask) {
      asks.push(
        ...refuse(
          [ask],
          `This ask was changed differently in ${locals.length} checkouts: ${where.join("; ")}. Answer it in the one you mean, or bring them back to one copy; Maestro answers none of them.`,
        ),
      );
    }
  } else if (main && mainLedger) {
    // Step 6: origin/main, unless the answers batch holds its answer already.
    const answersLedger = sources.answers.get(name);
    const [batched] = entriesOf(answersLedger, uid, id);
    const ask =
      batched && answersLedger && stateOf(batched) !== "open"
        ? askOf(batched, answersLedger, name, mainHome)
        : askOf(main, mainLedger, name, mainHome);
    if (ask) asks.push(batched && ask.state !== "open" ? { ...ask, batched: true } : ask);
  }
  if (collisions.length === 0) return asks;
  // A handle that names two asks: every row it names is shown, none answered.
  const where = collisions.map((copy) => placeOf(sources, sources.checkouts[copy.at] as CheckoutCopy));
  const refusal = `Two different asks in ${name} are named ${id}: the one on origin/main and the one in ${where.join("; ")}. Give one a uid or a new id; Maestro answers neither.`;
  const theirs = collisions.flatMap(
    (copy) => askOf(copy.row, copy.ledger, name, checkoutHome(sources.checkouts[copy.at] as CheckoutCopy)) ?? [],
  );
  return refuse([...asks, ...theirs], refusal);
}

// ── Git ──────────────────────────────────────────────────────────────────────

/** Read at each call, so a test's isolated git config holds. No prompt, no optional locks, git's own words. */
const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" });

export function git(cwd: string, args: readonly string[], timeout = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { timeout, maxBuffer: 64 * 1024 * 1024, env: gitEnv() },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`git ${args[0]}: ${gitWords(stderr || error.message)}`));
        else resolve(stdout);
      },
    );
  });
}

/**
 * What git said, in a line: the first line that names a cause (`fatal:`,
 * `error:`, a hook's `[FAIL]`), else its last line that says anything. A
 * hook's banner comes first, so the first line alone would only name the hook.
 */
export function gitWords(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^=+.*=+$/.test(line));
  // git's own cause leads (`fatal:`, `error:`); a hook's reason is often marked; else its last word.
  const cause = lines.find((line) => /^(?:fatal:|error:|\[fail\])/i.test(line));
  return cause ?? lines.at(-1) ?? "it failed with no words";
}

/** Many objects in one `git cat-file --batch`: each spec's bytes, or null when git has none. */
export function catFiles(repo: string, specs: readonly string[]): Promise<Map<string, Buffer | null>> {
  const found = new Map<string, Buffer | null>();
  if (specs.length === 0) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repo, "cat-file", "--batch"], { env: gitEnv() });
    const chunks: Buffer[] = [];
    // A git that hangs is killed, so a stalled object read never holds every later read and answer.
    const timer = setTimeout(() => child.kill("SIGKILL"), CAT_FILE_MS);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stdin.on("error", () => undefined);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) {
        reject(new Error(`git cat-file was stopped (${signal}) after ${CAT_FILE_MS / 1000} s`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`git cat-file exited ${code}`));
        return;
      }
      const out = Buffer.concat(chunks);
      let at = 0;
      for (const spec of specs) {
        const end = out.indexOf(10, at);
        if (end < 0) break;
        const header = out.subarray(at, end).toString("utf8");
        at = end + 1;
        const match = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
        if (!match) {
          found.set(spec, null);
          continue;
        }
        const size = Number(match[2]);
        found.set(spec, match[1] === "blob" ? out.subarray(at, at + size) : null);
        at += size + 1;
      }
      resolve(found);
    });
    child.stdin.end(`${specs.join("\n")}\n`);
  });
}

/** git's blob id for some bytes, so a working file is compared with a tree's without reading the blob. */
export function blobId(bytes: Buffer, format: "sha1" | "sha256" = "sha1"): string {
  return createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

export interface Worktree {
  path: string;
  head: string | null;
  branch: string | null;
}

export function parseWorktrees(porcelain: string): Worktree[] {
  return porcelain
    .split(/\n\n+/)
    .map((block) => {
      const lines = block.split("\n");
      const value = (key: string) => lines.find((line) => line.startsWith(`${key} `))?.slice(key.length + 1) ?? null;
      const flag = (key: string) => lines.some((line) => line === key || line.startsWith(`${key} `));
      const path = value("worktree");
      if (!path || flag("bare") || flag("prunable")) return null;
      const branch = value("branch");
      return { path, head: value("HEAD"), branch: branch ? branch.replace(/^refs\/heads\//, "") : null };
    })
    .filter((tree): tree is Worktree => tree !== null);
}

// ── Reading the workspace ────────────────────────────────────────────────────

export interface WorkspaceAsksOptions {
  controlRepo: string;
  /** Maestro's answers worktree (§5.2): where an answer whose home is origin/main is written. */
  answersPath: string;
  lockRoot: string;
  receipts: string;
  /** Fetch origin/main (at most every FETCH_EVERY_MS); off for a test that has no remote. */
  fetch?: boolean;
  now?: () => number;
  log?: (message: string) => void;
  ttlMs?: number;
}

export interface WorkspaceRead {
  controlRepo: string;
  main: { sha: string; fetchedAt: string | null } | null;
  /** Every ask, at its home: shown() picks what the view lists. */
  all: DecisionAsk[];
  warnings: string[];
}

function ledgerOf(bytes: Buffer): Ledger {
  if (bytes.length > LEDGER_LIMIT) throw new Error(`it is over ${LEDGER_LIMIT} bytes`);
  const data = parsed(bytes.toString("utf8"));
  return { data, rows: rowsOf(data) };
}

/**
 * The workspace's asks, read from the control repo's checkouts and origin/main
 * and answered at their homes. Reads are cached by blob id, so a scan whose
 * files have not changed costs a worktree listing, a rev-parse and a stat per
 * ledger.
 */
export class WorkspaceAsks {
  private readonly options: WorkspaceAsksOptions;
  private readonly now: () => number;
  private readonly parsedBlobs = new Map<string, Ledger | Error>();
  private readonly trees = new Map<string, Map<string, string>>();
  private readonly bases = new Map<string, string | null>();
  private readonly histories = new Map<string, MainHistory>();
  private readonly files = new Map<string, { stamp: string; id: string; bytes: Buffer }>();
  private format: "sha1" | "sha256" | null = null;
  private lastFetch = 0;
  /** When a fetch last succeeded, and why the last one failed (null once one succeeds). */
  private lastFetchOk = 0;
  private lastFetchTry = 0;
  private lastFetchError: string | null = null;
  private fetchedAt: string | null = null;
  private fetching: Promise<string | null> | null = null;
  private cached: { at: number; read: Promise<WorkspaceRead> } | null = null;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(options: WorkspaceAsksOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** The workspace's asks, at most READ_TTL_MS old unless `fresh`. */
  read(fresh = false): Promise<WorkspaceRead> {
    const now = this.now();
    this.maybeFetch(now);
    if (!fresh && this.cached && now - this.cached.at < (this.options.ttlMs ?? READ_TTL_MS)) return this.cached.read;
    const read = this.scan();
    this.cached = { at: now, read };
    read.catch(() => {
      if (this.cached?.read === read) this.cached = null;
    });
    return read;
  }

  /** The view's list: the open asks, then the latest answered. */
  async view(): Promise<{
    controlRepo: string;
    main: WorkspaceRead["main"];
    decisions: DecisionAsk[];
    warnings: string[];
  }> {
    const read = await this.read();
    return { controlRepo: read.controlRepo, main: read.main, decisions: shown(read.all), warnings: read.warnings };
  }

  /** The asks that wait on you, for the header count. */
  async waiting(): Promise<AskNotice[]> {
    const read = await this.read();
    return read.all.filter((ask) => ask.waiting).map((ask) => askNotice(ask, null));
  }

  /** origin/main, fetched in the background at most every FETCH_EVERY_MS; a read never waits on it. */
  private maybeFetch(now: number): void {
    if (this.options.fetch === false || this.fetching || now - this.lastFetch < FETCH_EVERY_MS) return;
    void this.fetchNow();
  }

  /** Fetches origin/main (one fetch at a time); resolves to why it failed, or null. */
  private fetchNow(): Promise<string | null> {
    if (this.fetching) return this.fetching;
    this.lastFetch = this.now();
    this.lastFetchTry = this.now();
    const fetching = git(this.options.controlRepo, ["fetch", "--quiet", "origin", "main"], 60_000)
      .then(() => {
        this.fetchedAt = new Date(this.now()).toISOString();
        this.lastFetchOk = this.now();
        this.lastFetchError = null;
        this.cached = null;
        return null;
      })
      .catch((error) => {
        const message = (error as Error).message;
        this.lastFetchError = message;
        this.options.log?.(`asks: fetching origin/main: ${message}`);
        return message;
      })
      .finally(() => {
        this.fetching = null;
      });
    this.fetching = fetching;
    return fetching;
  }

  /** For a test: waits for a fetch in flight. */
  async settled(): Promise<void> {
    await this.fetching;
  }

  /** origin/main fetched now (one fetch at a time, shared with reads): why it failed, or null. Off for a test without a remote. */
  fetchMain(): Promise<string | null> {
    return this.options.fetch === false ? Promise.resolve(null) : this.fetchNow();
  }

  /**
   * Runs `run` in the answers' own queue, so nothing else writes the answers
   * worktree meanwhile (the landing step, server/answers-landing.ts), and the
   * next read is fresh.
   */
  exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.writes
      .catch(() => undefined)
      .then(run)
      .finally(() => {
        this.cached = null;
      });
    this.writes = next;
    return next;
  }

  private async scan(): Promise<WorkspaceRead> {
    const repo = this.options.controlRepo;
    const warnings: string[] = [];
    if (!(await lstat(repo).catch(() => null))?.isDirectory()) {
      return { controlRepo: repo, main: null, all: [], warnings: [] };
    }
    let worktrees: Worktree[];
    try {
      worktrees = parseWorktrees(await git(repo, ["worktree", "list", "--porcelain"]));
    } catch (error) {
      return {
        controlRepo: repo,
        main: null,
        all: [],
        warnings: [`The control repo ${repo} could not be read as a git repo: ${(error as Error).message}`],
      };
    }
    this.format ??=
      (await git(repo, ["rev-parse", "--show-object-format"]).catch(() => "")).trim() === "sha256" ? "sha256" : "sha1";
    const mainSha = (
      await git(repo, ["rev-parse", "--verify", "--quiet", `${MAIN_REF}^{commit}`]).catch(() => "")
    ).trim();
    if (!mainSha) {
      // Without main there is no B, so every copy would read as local and every ask as diverged.
      return {
        controlRepo: repo,
        main: null,
        all: [],
        warnings: [`${repo} has no ${MAIN_REF}, and the home rule needs it, so no ask was read. Fetch it there.`],
      };
    }
    const mainTree = await this.treeOf(mainSha);
    const answersReal = await realpath(this.options.answersPath).catch(() => this.options.answersPath);
    const checkouts: { tree: Worktree; base: string | null; files: Map<string, { id: string; bytes: Buffer }> }[] = [];
    for (const tree of worktrees) {
      const real = await realpath(tree.path).catch(() => null);
      if (!real || real === answersReal || !tree.head) continue;
      const base = await this.baseOf(tree.path, tree.head, mainSha);
      checkouts.push({ tree: { ...tree, path: real }, base, files: await this.ledgerFiles(real, warnings) });
    }
    const answerFiles = (await lstat(this.options.answersPath).catch(() => null))?.isDirectory()
      ? await this.ledgerFiles(answersReal, warnings)
      : new Map<string, { id: string; bytes: Buffer }>();
    // Every blob still to parse, in one cat-file: main's ledgers and each changed ledger's copy at B.
    const baseTrees = new Map<string, Map<string, string>>();
    for (const checkout of checkouts) {
      if (checkout.base && !baseTrees.has(checkout.base))
        baseTrees.set(checkout.base, await this.treeOf(checkout.base));
    }
    const wanted = new Set<string>([...mainTree.values()]);
    for (const checkout of checkouts) {
      const baseTree = checkout.base ? baseTrees.get(checkout.base) : undefined;
      for (const [name, file] of checkout.files) {
        const atBase = baseTree?.get(name);
        if (atBase && atBase !== file.id) wanted.add(atBase);
      }
    }
    await this.loadBlobs(repo, [...wanted]);

    const main: Ledgers = new Map();
    for (const [name, id] of mainTree) {
      const ledger = this.parsedBlobs.get(id);
      if (ledger instanceof Error)
        warnings.push(`The ask ledger ${name} on ${MAIN_REF} could not be read: ${ledger.message}`);
      else if (ledger) main.set(name, ledger);
    }
    const copies: CheckoutCopy[] = checkouts.map(({ tree, base, files }) => {
      const baseTree = base ? baseTrees.get(base) : undefined;
      const copy: CheckoutCopy = { path: tree.path, branch: tree.branch, tree: new Map(), base: new Map() };
      for (const [name, file] of files) {
        const atBase = baseTree?.get(name);
        if (atBase === file.id) continue;
        const ledger = this.parseFile(file);
        if (ledger instanceof Error) {
          warnings.push(`The ask ledger ${name} in ${tree.path} could not be read: ${ledger.message}`);
          continue;
        }
        copy.tree.set(name, ledger);
        const before = atBase ? this.parsedBlobs.get(atBase) : undefined;
        if (before && !(before instanceof Error)) copy.base.set(name, before);
      }
      return copy;
    });
    const answers: Ledgers = new Map();
    for (const [name, file] of answerFiles) {
      if (mainTree.get(name) === file.id) continue;
      const ledger = this.parseFile(file);
      if (ledger instanceof Error) {
        warnings.push(
          `The answers worktree's ${name} could not be read (${ledger.message}), so its answers are not shown.`,
        );
      } else answers.set(name, ledger);
    }
    // A second pass, only for a ledger holding a squash-merged ask a checkout has edited since: main's history of it.
    const landed = new Map<string, MainHistory>();
    for (const name of landedLedgers({ main, checkouts: copies })) {
      try {
        landed.set(name, await this.historyOf(name, mainSha));
      } catch (error) {
        warnings.push(`The history of ${name} on ${MAIN_REF} could not be read: ${(error as Error).message}`);
      }
    }
    this.trimCaches();
    return {
      controlRepo: repo,
      main: { sha: mainSha, fetchedAt: this.fetchedAt },
      all: resolveHomes({
        controlRepo: await realpath(repo).catch(() => repo),
        main,
        checkouts: copies,
        answers,
        landed,
      }),
      warnings,
    };
  }

  /**
   * A ledger's copies on main's first-parent history, the last LANDED_WINDOW
   * commits to it, oldest first; read once per (ledger, main sha), its blobs by id.
   */
  private async historyOf(name: string, mainSha: string): Promise<MainHistory> {
    const key = `${mainSha}:${name}`;
    const known = this.histories.get(key);
    if (known) return known;
    const repo = this.options.controlRepo;
    // Each commit, then its raw diff line against its first parent: `:mode mode old new status\tpath`.
    const log = await git(repo, [
      "log",
      "--first-parent",
      "--no-abbrev",
      "--format=%H",
      "--raw",
      "-n",
      String(LANDED_WINDOW),
      mainSha,
      "--",
      `${ASKS_DIR}/${name}`,
    ]);
    const changes = log
      .split("\n")
      .filter((line) => line.startsWith(":"))
      .map((line) => {
        const [, , before = "", after = ""] = line.slice(1).split("\t")[0]?.split(" ") ?? [];
        const none = (id: string) => /^0+$/.test(id);
        return { before: none(before) ? null : before, after: none(after) ? null : after };
      })
      .reverse();
    const ids = changes.flatMap((change) => (change.after ? [change.after] : []));
    await this.loadBlobs(repo, ids);
    const copies = changes.map((change) => {
      const ledger = change.after ? this.parsedBlobs.get(change.after) : undefined;
      return ledger && !(ledger instanceof Error) ? ledger : null;
    });
    const history = { copies, complete: changes.length > 0 && changes[0]?.before === null };
    this.histories.set(key, history);
    return history;
  }

  private parseFile(file: { id: string; bytes: Buffer }): Ledger | Error {
    const known = this.parsedBlobs.get(file.id);
    if (known) return known;
    let ledger: Ledger | Error;
    try {
      ledger = ledgerOf(file.bytes);
    } catch (error) {
      ledger = error as Error;
    }
    this.parsedBlobs.set(file.id, ledger);
    return ledger;
  }

  private async loadBlobs(repo: string, ids: readonly string[]): Promise<void> {
    const missing = ids.filter((id) => !this.parsedBlobs.has(id));
    const blobs = await catFiles(repo, missing);
    for (const id of missing) {
      const bytes = blobs.get(id);
      if (!bytes) continue;
      this.parseFile({ id, bytes });
    }
  }

  /** A commit's ledgers by name, to their blob ids. */
  private async treeOf(commit: string): Promise<Map<string, string>> {
    const known = this.trees.get(commit);
    if (known) return known;
    const listing = await git(this.options.controlRepo, ["ls-tree", "-z", "--full-tree", commit, "--", `${ASKS_DIR}/`]);
    const tree = new Map<string, string>();
    for (const entry of listing.split("\0")) {
      const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(entry);
      const name = match?.[2]?.split("/").pop();
      if (match?.[1] && name && LEDGER.test(name)) tree.set(name, match[1]);
    }
    this.trees.set(commit, tree);
    return tree;
  }

  private async baseOf(path: string, head: string, mainSha: string): Promise<string | null> {
    const key = `${head}:${mainSha}`;
    if (this.bases.has(key)) return this.bases.get(key) ?? null;
    const base = (await git(path, ["merge-base", head, mainSha]).catch(() => "")).trim() || null;
    this.bases.set(key, base);
    return base;
  }

  /** A checkout's ledger files, each with its blob id; read again only when its stat changes. */
  private async ledgerFiles(checkout: string, warnings: string[]): Promise<Map<string, { id: string; bytes: Buffer }>> {
    const folder = join(checkout, ASKS_DIR);
    const files = new Map<string, { id: string; bytes: Buffer }>();
    const names = await readdir(folder).catch(() => [] as string[]);
    for (const name of names.filter((entry) => LEDGER.test(entry)).sort()) {
      const path = join(folder, name);
      try {
        const info = await lstat(path);
        if (!info.isFile()) continue;
        const stamp = `${info.mtimeMs}:${info.size}:${info.ino}`;
        const known = this.files.get(path);
        if (known?.stamp === stamp) {
          files.set(name, known);
          continue;
        }
        if (info.size > LEDGER_LIMIT) throw new Error(`it is over ${LEDGER_LIMIT} bytes`);
        const bytes = await readFile(path);
        const file = { stamp, id: blobId(bytes, this.format ?? "sha1"), bytes };
        this.files.set(path, file);
        files.set(name, file);
      } catch (error) {
        warnings.push(`The ask ledger ${path} could not be read: ${(error as Error).message}`);
      }
    }
    return files;
  }

  /** Keeps the caches from growing without end over a long-lived daemon. */
  private trimCaches(): void {
    if (this.parsedBlobs.size > 4000) this.parsedBlobs.clear();
    if (this.trees.size > 200) this.trees.clear();
    if (this.bases.size > 500) this.bases.clear();
    if (this.histories.size > 200) this.histories.clear();
    if (this.files.size > 8000) this.files.clear();
  }

  // ── Your answer ────────────────────────────────────────────────────────────

  /**
   * Writes your answer at the ask's home, as you read it (`home`, homeKey):
   * a checkout's file in place, or for origin/main the answers worktree's,
   * committed on maestro/answers. An ask whose home has moved, or that changed
   * since you read it, is refused. Answers run one at a time.
   */
  answer(input: AnswerInput & { ledger: string; home: string }): Promise<{ ask: DecisionAsk; warning: string | null }> {
    const next = this.writes.catch(() => undefined).then(() => this.answerNow(input));
    this.writes = next;
    return next;
  }

  private async answerNow(
    input: AnswerInput & { ledger: string; home: string },
  ): Promise<{ ask: DecisionAsk; warning: string | null }> {
    if (!LEDGER.test(input.ledger)) throw new UserError(`${input.ledger} is not a ledger name.`);
    // The home is judged on origin/main as it is now: an ask closed or landed upstream since the last fetch moves.
    // A fetch in flight is waited on; one that last succeeded within ANSWER_FETCH_FRESH_MS is enough; else one runs.
    let unfetched: string | null = null;
    if (this.options.fetch !== false) {
      const now = this.now();
      if (this.fetching) unfetched = await this.fetching;
      else if (now - this.lastFetchOk < ANSWER_FETCH_FRESH_MS) unfetched = null;
      // A fetch that failed this recently is said, not run again: an offline daemon never makes each answer wait 60 s.
      else if (now - this.lastFetchTry < ANSWER_FETCH_FRESH_MS) unfetched = this.lastFetchError;
      else unfetched = await this.fetchNow();
    }
    const stale = unfetched
      ? `origin/main could not be fetched first (${unfetched}), so this was judged on origin/main as last fetched.`
      : null;
    const read = await this.read(true);
    const named = read.all.filter(
      (ask) => ask.ledger === input.ledger && (input.uid ? ask.uid === input.uid : !ask.uid && ask.id === input.id),
    );
    const found = named.find((ask) => homeKey(ask.home) === input.home);
    if (!found) {
      const [moved] = named;
      throw new UserError(
        moved
          ? `The ask ${input.id} now lives in ${homeWords(moved.home)}, not where you read it. Look at it again before answering.`
          : `The workspace no longer holds the ask ${input.id} in ${input.ledger}. Look at Decisions again.`,
      );
    }
    if (found.state !== "open") {
      throw new UserError(`The ask ${input.id} was already answered or retired; your answer was not written.`);
    }
    if (found.refusal) throw new UserError(found.refusal);
    if (found.hash !== input.hash) {
      throw new UserError(`The ask ${input.id} changed since you read it; look at it again before answering.`);
    }
    const answer = {
      uid: input.uid,
      id: input.id,
      hash: input.hash,
      option: input.option,
      note: input.note,
      wake: input.wake ?? null,
    };
    const write = {
      lockRoot: this.options.lockRoot,
      receipts: this.options.receipts,
      now: this.now,
      log: this.options.log,
    };
    if (found.home.kind === "checkout") {
      const path = await ledgerPathIn(found.home.path, input.ledger);
      const answered = await answerDecision(path, answer, { ...write, home: found.home });
      this.cached = null;
      this.options.log?.(`asks: you answered ${input.ledger} ${input.id} in ${found.home.path}`);
      return { ask: answered.ask, warning: [stale, answered.warning].filter(Boolean).join(" ") || null };
    }
    if (found.home.kind !== "main") throw new UserError(`The ask ${input.id} is not the workspace's to answer here.`);
    const answers = await this.answersWorktree();
    const path = await ledgerPathIn(answers, input.ledger);
    const answered = await answerDecision(path, answer, { ...write, home: found.home });
    this.cached = null;
    const committed = await this.commitAnswer(answers, input.ledger, answered.ask);
    this.options.log?.(`asks: you answered ${input.ledger} ${input.id}, in the answers batch`);
    return {
      ask: { ...answered.ask, batched: true },
      warning: [stale, answered.warning, committed].filter(Boolean).join(" ") || null,
    };
  }

  /**
   * Maestro's answers worktree on maestro/answers, made the first time it is
   * needed (from origin/main, or from the branch when it is there already) and
   * brought up to origin/main before each answer, by a merge that never
   * rewrites what the branch holds. A worktree that is not this repo's on that
   * branch, or a merge that conflicts, is refused.
   */
  private async answersWorktree(): Promise<string> {
    const repo = this.options.controlRepo;
    const path = this.options.answersPath;
    const mainSha = (
      await git(repo, ["rev-parse", "--verify", "--quiet", `${MAIN_REF}^{commit}`]).catch(() => "")
    ).trim();
    if (!mainSha) throw new UserError(`${repo} has no ${MAIN_REF}, so an answer for it has nowhere to go.`);
    if (!(await lstat(path).catch(() => null))) {
      const branch = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${ANSWERS_BRANCH}`]).catch(
        () => "",
      );
      const args = branch.trim()
        ? ["worktree", "add", "--quiet", path, ANSWERS_BRANCH]
        : ["worktree", "add", "--quiet", "--no-track", "-b", ANSWERS_BRANCH, path, mainSha];
      await git(repo, args, 60_000).catch(async (error) => {
        // The branch still registered at a worktree whose folder is gone (a cleared state dir): that registration
        // is dead, so git's own prune clears it, and the worktree is made again. One checked out anywhere live is refused.
        const holder = await this.answersHolder();
        if (holder && !(await lstat(holder).catch(() => null))) {
          await git(repo, ["worktree", "prune"]);
          await git(repo, args, 60_000).catch((again) => {
            throw new UserError(`Maestro's answers worktree could not be made at ${path}: ${(again as Error).message}`);
          });
          return;
        }
        throw new UserError(
          holder
            ? `${ANSWERS_BRANCH} is checked out at ${holder}, not at Maestro's answers worktree ${path}, so no answer was written. Remove that worktree, or point MAESTRO_PASEO_CONTROL_ANSWERS at it.`
            : `Maestro's answers worktree could not be made at ${path}: ${(error as Error).message}`,
        );
      });
    }
    if (!(await isAnswersWorktree(repo, path))) {
      throw new UserError(
        `${path} is not ${repo}'s answers worktree on ${ANSWERS_BRANCH}, so no answer was written there.`,
      );
    }
    // Anything uncommitted there (an earlier answer whose commit failed, a hand edit) is never swept into this answer's commit.
    const dirty = await uncommitted(path);
    if (dirty.length > 0) {
      throw new UserError(
        `Maestro's answers worktree has changes not committed (${dirty.join(", ")}), so no answer was written. Commit or discard them in ${path} first.`,
      );
    }
    const current = await git(path, ["merge-base", "--is-ancestor", mainSha, "HEAD"]).then(
      () => true,
      () => false,
    );
    if (!current) {
      await git(
        path,
        ["merge", "--quiet", "--no-edit", "-m", `Merge ${MAIN_REF} into ${ANSWERS_BRANCH}`, mainSha],
        60_000,
      ).catch(async (error) => {
        const conflicted = (await git(path, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ""))
          .split("\n")
          .filter(Boolean);
        await git(path, ["merge", "--abort"]).catch(() => undefined);
        const where = conflicted.length > 0 ? ` (it conflicts in ${conflicted.join(", ")})` : "";
        throw new UserError(
          `${ANSWERS_BRANCH} could not take ${MAIN_REF}'s latest${where}: ${(error as Error).message}. No answer was written, and no answer whose home is ${MAIN_REF} is, until that is settled by hand in ${path}.`,
        );
      });
    }
    return path;
  }

  /** Where git has maestro/answers checked out, by its listing (a worktree whose folder is gone included), or null. */
  private async answersHolder(): Promise<string | null> {
    const listing = await git(this.options.controlRepo, ["worktree", "list", "--porcelain"]).catch(() => "");
    const block = listing
      .split(/\n\n+/)
      .find((entry) => entry.split("\n").includes(`branch refs/heads/${ANSWERS_BRANCH}`));
    return (
      block
        ?.split("\n")
        .find((line) => line.startsWith("worktree "))
        ?.slice("worktree ".length) ?? null
    );
  }

  /**
   * Commits this answer's ledger, and only it, on maestro/answers. A commit
   * that fails (a hook refusing it, say) is said; the answer stays in the file,
   * and the next answer is refused until the worktree is clean again.
   */
  private async commitAnswer(answers: string, ledger: string, ask: DecisionAsk): Promise<string | null> {
    const file = join(ASKS_DIR, ledger);
    try {
      const message = `answer(${ledger}): ${ask.id}${ask.answerOption ? ` -> ${ask.answerOption}` : ""}\n\nAnswered-by: owner:maestro`;
      await git(answers, ["commit", "--quiet", "-m", message, "--", file], 120_000);
      return null;
    } catch (error) {
      const message = `Your answer is in the answers worktree, but its commit on ${ANSWERS_BRANCH} failed (${(error as Error).message}). Maestro writes no other answer there until ${file} is committed or discarded in ${answers}.`;
      this.options.log?.(`asks: ${message}`);
      return message;
    }
  }
}

/** Whether `path` is a worktree of `repo`'s own (one git common dir) with maestro/answers checked out. */
export async function isAnswersWorktree(repo: string, path: string): Promise<boolean> {
  const [ours, theirs, onBranch] = await Promise.all([
    git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => ""),
    git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => ""),
    git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => ""),
  ]);
  const [oursReal, theirsReal] = await Promise.all([
    realpath(ours.trim()).catch(() => ours.trim()),
    realpath(theirs.trim()).catch(() => theirs.trim()),
  ]);
  return Boolean(oursReal) && oursReal === theirsReal && onBranch.trim() === ANSWERS_BRANCH;
}

/** A checkout's files not committed, by path. Each line is `XY path`; X may be a space, so lines are never trimmed before the cut. */
export async function uncommitted(path: string): Promise<string[]> {
  return (await git(path, ["status", "--porcelain", "--untracked-files=all"]))
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3));
}

export function homeWords(home: AskHome): string {
  if (home.kind === "main") return MAIN_REF;
  if (home.kind === "root") return home.path;
  return home.branch ? `${home.path} (${home.branch})` : home.path;
}

/** A ledger's path in a checkout, whose `.control` and `.control/asks` are folders of its own, never links out of it. */
async function ledgerPathIn(checkout: string, ledger: string): Promise<string> {
  for (const folder of [join(checkout, ".control"), join(checkout, ASKS_DIR)]) {
    if ((await lstat(folder).catch(() => null))?.isDirectory() !== true) {
      throw new UserError(`${folder} is not a folder of the checkout's own, so no answer was written there.`);
    }
  }
  const path = join(checkout, ASKS_DIR, ledger);
  // The file itself is checked under the lock (answerDecision); a read here says early when it is gone.
  await readLedger(path).catch(() => {
    throw new UserError(`${ledger} is gone from ${checkout}, so nothing was written.`);
  });
  return path;
}
