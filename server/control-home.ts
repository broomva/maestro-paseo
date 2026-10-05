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
//   test: W's entry existed at B, or equals main's. Two entries with one handle
//   that fail it are an id collision: both shown, neither answered.
// - The main checkout is never a fallback: it is one checkout under the rule.
//
// Not here: landing the answers batch (a gated work item, §5.2 "The answers
// batch"), re-application from receipts, and routing an answer to the session
// that asked. An answer on maestro/answers is committed there and waits.

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

export interface Sources {
  controlRepo: string;
  /** Every ledger on origin/main; empty when there is no origin/main. */
  main: Ledgers;
  checkouts: CheckoutCopy[];
  /** The answers worktree's ledgers that differ from main's. */
  answers: Ledgers;
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

/**
 * Every ask in the sources, each read at its home (the rule above), with a
 * refusal on one that may not be answered: diverged, or an id collision.
 */
export function resolveHomes(sources: Sources): DecisionAsk[] {
  const mainHome: AskHome = { kind: "main", path: sources.controlRepo, branch: null };
  // Every handle in every ledger any source holds, in ledger then list order.
  const names = new Set<string>([
    ...sources.main.keys(),
    ...sources.checkouts.flatMap((copy) => [...copy.tree.keys()]),
  ]);
  const out: DecisionAsk[] = [];
  for (const name of [...names].sort()) {
    const handles: { uid: string | null; id: string }[] = [];
    const seen = new Set<string>();
    const sourcesOf = [sources.main.get(name), ...sources.checkouts.map((copy) => copy.tree.get(name))];
    for (const ledger of sourcesOf) {
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
    for (const handle of handles) out.push(...resolveOne(sources, name, handle, mainHome));
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
  const [main = null] = entriesOf(mainLedger, uid, id);
  const copies: Copy[] = [];
  const collisions: Copy[] = [];
  sources.checkouts.forEach((checkout, at) => {
    const ledger = checkout.tree.get(name);
    const [mine] = entriesOf(ledger, uid, id);
    if (!ledger || !mine) return;
    const [base = null] = entriesOf(checkout.base.get(name), uid, id);
    // The same-ask test, for an ask without a uid: W inherited it from B, or W's added ask has landed.
    const sameAsk = uid !== null || main === null || base !== null || same(mine, main);
    const copy = { at, row: mine, ledger, local: isLocal(base, mine, main) };
    if (sameAsk) copies.push(copy);
    else collisions.push(copy);
  });

  const asks: DecisionAsk[] = [];
  // Step 1: main's outcome wins.
  if (main && mainLedger && stateOf(main) !== "open") {
    const ask = askOf(main, mainLedger, name, mainHome);
    if (ask) asks.push(ask);
  } else {
    const locals = copies.filter((copy) => copy.local);
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
    if (home) {
      // Steps 3 and 4.
      const ask = askOf(home.row, home.ledger, name, checkoutHome(sources.checkouts[home.at] as CheckoutCopy));
      if (ask) asks.push(ask);
    } else if (locals.length > 1) {
      // Step 5: diverged.
      const [first] = locals;
      const where = locals.map((copy) => placeOf(sources, sources.checkouts[copy.at] as CheckoutCopy));
      const ask = first ? askOf(first.row, first.ledger, name, mainHome) : null;
      if (ask) {
        asks.push({
          ...ask,
          refusal: `This ask was changed differently in ${locals.length} checkouts: ${where.join("; ")}. Answer it in the one you mean, or bring them back to one copy; Maestro answers none of them.`,
        });
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
  }
  if (collisions.length === 0) return asks;
  // A handle that names two asks: every row it names is shown, none answered.
  const where = collisions.map((copy) => placeOf(sources, sources.checkouts[copy.at] as CheckoutCopy));
  const refusal = `Two different asks in ${name} are named ${id}: the one on origin/main and the one in ${where.join("; ")}. Give one a uid or a new id; Maestro answers neither.`;
  const flagged = asks.map((ask) => (ask.state === "open" ? { ...ask, refusal } : ask));
  for (const copy of collisions) {
    const ask = askOf(copy.row, copy.ledger, name, checkoutHome(sources.checkouts[copy.at] as CheckoutCopy));
    if (ask) flagged.push(ask.state === "open" ? { ...ask, refusal } : ask);
  }
  return flagged;
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
        if (error) reject(new Error(`git ${args[0]}: ${(stderr || error.message).trim().split("\n")[0]}`));
        else resolve(stdout);
      },
    );
  });
}

/** Many objects in one `git cat-file --batch`: each spec's bytes, or null when git has none. */
export function catFiles(repo: string, specs: readonly string[]): Promise<Map<string, Buffer | null>> {
  const found = new Map<string, Buffer | null>();
  if (specs.length === 0) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repo, "cat-file", "--batch"], { env: gitEnv() });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
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
  private readonly files = new Map<string, { stamp: string; id: string; bytes: Buffer }>();
  private format: "sha1" | "sha256" | null = null;
  private lastFetch = 0;
  private fetchedAt: string | null = null;
  private fetching: Promise<void> | null = null;
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
    this.lastFetch = now;
    this.fetching = git(this.options.controlRepo, ["fetch", "--quiet", "origin", "main"], 60_000)
      .then(() => {
        this.fetchedAt = new Date(this.now()).toISOString();
        this.cached = null;
      })
      .catch((error) => this.options.log?.(`asks: fetching origin/main: ${(error as Error).message}`))
      .finally(() => {
        this.fetching = null;
      });
  }

  /** For a test: waits for a fetch in flight. */
  async settled(): Promise<void> {
    await this.fetching;
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
    if (!mainSha) warnings.push(`${repo} has no ${MAIN_REF}, so only its checkouts' own copies are read.`);
    const mainTree = mainSha ? await this.treeOf(mainSha) : new Map<string, string>();
    const answersReal = await realpath(this.options.answersPath).catch(() => this.options.answersPath);
    const checkouts: { tree: Worktree; base: string | null; files: Map<string, { id: string; bytes: Buffer }> }[] = [];
    for (const tree of worktrees) {
      const real = await realpath(tree.path).catch(() => null);
      if (!real || real === answersReal || !tree.head) continue;
      const base = mainSha ? await this.baseOf(tree.path, tree.head, mainSha) : null;
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
      if (!(ledger instanceof Error)) answers.set(name, ledger);
    }
    this.trimCaches();
    return {
      controlRepo: repo,
      main: mainSha ? { sha: mainSha, fetchedAt: this.fetchedAt } : null,
      all: resolveHomes({ controlRepo: await realpath(repo).catch(() => repo), main, checkouts: copies, answers }),
      warnings,
    };
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
    const answer = { uid: input.uid, id: input.id, hash: input.hash, option: input.option, note: input.note };
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
      return answered;
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
      warning: [answered.warning, committed].filter(Boolean).join(" ") || null,
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
      await git(repo, args, 60_000).catch((error) => {
        throw new UserError(`Maestro's answers worktree could not be made at ${path}: ${(error as Error).message}`);
      });
    }
    const [ours, theirs, onBranch] = await Promise.all([
      git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => ""),
      git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => ""),
      git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => ""),
    ]);
    const [oursReal, theirsReal] = await Promise.all([
      realpath(ours.trim()).catch(() => ours.trim()),
      realpath(theirs.trim()).catch(() => theirs.trim()),
    ]);
    if (!oursReal || oursReal !== theirsReal || onBranch.trim() !== ANSWERS_BRANCH) {
      throw new UserError(
        `${path} is not ${repo}'s answers worktree on ${ANSWERS_BRANCH}, so no answer was written there.`,
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
        await git(path, ["merge", "--abort"]).catch(() => undefined);
        throw new UserError(
          `${ANSWERS_BRANCH} could not take ${MAIN_REF}'s latest (${(error as Error).message}), so no answer was written. It needs a hand in ${path}.`,
        );
      });
    }
    return path;
  }

  /** Commits the answers worktree's ledgers on maestro/answers; a commit that fails is said, and the answer stays in its file. */
  private async commitAnswer(answers: string, ledger: string, ask: DecisionAsk): Promise<string | null> {
    try {
      await git(answers, ["add", "--", ASKS_DIR]);
      const message = `answer(${ledger}): ${ask.id}${ask.answerOption ? ` -> ${ask.answerOption}` : ""}\n\nAnswered-by: owner:maestro`;
      await git(answers, ["commit", "--quiet", "-m", message, "--", ASKS_DIR], 120_000);
      return null;
    } catch (error) {
      const message = `Your answer is in the answers worktree, but its commit on ${ANSWERS_BRANCH} failed (${(error as Error).message}).`;
      this.options.log?.(`asks: ${message}`);
      return message;
    }
  }
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
