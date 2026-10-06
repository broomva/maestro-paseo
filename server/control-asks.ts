// Decision asks in a `.control/asks` ledger, read for the Fleet view and
// answered from it, under the control interface's contract (workspace#861,
// docs/specs/2026-10-01-maestro-control-interface.html):
//
// - Which checkout (§5.2, §5.6). Here, a registered machine-local root (the
//   fleet's own, `<state dir>/.control/asks`), whose home is the root's file.
//   The control repo's asks take the full home rule first
//   (server/control-home.ts), then are written here, at the home it chose.
// - Identity (§5.2). An ask is its `uid`. One without a uid is its `id`, and
//   only while no other uid-less ask in the file shares it: a duplicate handle
//   is an id collision, shown and never answered.
// - The lock (§5.5). Every ledger writer takes `~/.local/state/control-asks/
//   locks/<k>.d` first: mkdir, a pid with its start time, a token. Under it the
//   ledger is re-read, only the target entry is edited, a temp file is written
//   beside it with its mode, the token is checked again, and the temp is renamed
//   over it. A live holder is never reclaimed; a dead one only after 120 s.
// - The answer (§5.5). `answer`, `answer_option` when you tapped one,
//   `answered_at`, `answered_by: owner:maestro` and `status: resolved`, as
//   minimal byte edits inside the entry (from the Asks plugin's ledger.ts), so
//   the diff stays within the entry's map. A receipt line records it.
//
// Not here: routing the answer to the session that asked (Send or Spawn). The
// writer reads the answer from its own file, the spec's "Record only".

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isMap, isSeq, parseDocument, type YAMLMap } from "yaml";
import {
  type AskAudit,
  type AskHome,
  type DecisionAsk,
  type DecisionOption,
  type Idea,
  isWaiting,
} from "../shared/fleet";
import { UserError } from "./engine";

/** A ledger is read up to this size; past it it is refused, not cut. */
const LEDGER_LIMIT = 1024 * 1024;
/** Answered asks shown per root, newest first: what you just did stays in view. */
export const ANSWERED_SHOWN = 10;

/** Keys that record an outcome (the Asks plugin's normaliser, which §5.4 adopts), and the terminal statuses. */
const OUTCOME_KEYS = ["answer", "answered", "resolution", "outcome", "answered_at", "defaulted_at"] as const;
const TERMINAL_STATUS = /^(resolved|answered|closed|rerouted|withdrawn|defaulted)/;
/** The answer's text, under whichever key the entry already uses; `answer` when none. */
const ANSWER_KEYS = ["answer", "answered", "resolution", "outcome"] as const;

export type Row = Record<string, unknown>;

export function text(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export const isRow = (value: unknown): value is Row =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function optionsOf(raw: unknown): DecisionOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRow).flatMap((option) => {
    const id = text(option.id);
    if (!id) return [];
    return [
      {
        id,
        label: text(option.label) ?? id,
        consequence: text(option.consequence),
        reversible: typeof option.reversible === "boolean" ? option.reversible : null,
        recommended: option.recommended === true,
      },
    ];
  });
}

/** The answers an idea takes (workspace#894 IDEA_OPTIONS). */
export const IDEA_OPTIONS: readonly string[] = ["develop", "park", "kill"];

/** A YYYY-MM-DD date as a ledger writes it: a string, or a date some parser made of it. */
export function dayOf(value: unknown): string | null {
  const day = value instanceof Date ? value.toISOString().slice(0, 10) : text(value);
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** An idea-triage ask's own fields (`class: idea`, workspace#894); null for any other ask. */
export function ideaOf(row: Row): Idea | null {
  if (text(row.class) !== "idea") return null;
  const source = isRow(row.source) ? row.source : null;
  const kind = source ? text(source.kind) : null;
  const ref = source ? text(source.ref) : null;
  return {
    initiative: text(row.initiative),
    idea: text(row.idea),
    source: kind && ref ? { kind, ref } : null,
    evidence: text(row.evidence),
    wake: dayOf(row.wake),
  };
}

/** The strings of a list a ledger writes (`gates: [a, b]`); a lone string is a list of one. */
function textsOf(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return list.flatMap((entry) => {
    const one = text(entry);
    return one ? [one] : [];
  });
}

/** The audit layer's lines that go to a client: this many, each cut to AUDIT_LINE_CHARS. */
export const AUDIT_LINES = 8;
export const AUDIT_LINE_CHARS = 240;
/**
 * A line that looks like it carries a secret or a path to one: an API key's
 * prefix (OpenAI/Anthropic `sk-`, GitHub `ghp_`/`gho_`/`github_pat_`, Slack
 * `xox`, AWS `AKIA`), a private key block, an SSH key path, or `token=`. Such a
 * line is dropped before the wire: the audit layer justifies an ask, it never
 * needs the secret itself.
 */
const SECRET_LIKE =
  /\bsk-[A-Za-z0-9_-]{6,}|\bgh[pousr]_[A-Za-z0-9]{6,}|github_pat_|\bxox[abposr]-|\bAKIA[0-9A-Z]{8,}|BEGIN [A-Z ]*PRIVATE KEY|\bid_(rsa|ed25519|ecdsa|dsa)\b|\.ssh\/|\btoken=/i;

/** The exhausted lines a client may see: none that look like a secret, at most AUDIT_LINES, each cut short. */
export function safeAuditLines(lines: readonly string[]): string[] {
  return lines
    .filter((line) => !SECRET_LIKE.test(line))
    .slice(0, AUDIT_LINES)
    .map((line) => (line.length > AUDIT_LINE_CHARS ? `${line.slice(0, AUDIT_LINE_CHARS - 1)}…` : line));
}

/** An ask's audit layer (class, gates, exhausted, made safe for the wire); null when it writes none of them. */
export function auditOf(row: Row): AskAudit | null {
  const audit = {
    class: text(row.class),
    gates: textsOf(row.gates).slice(0, AUDIT_LINES),
    exhausted: safeAuditLines(textsOf(row.exhausted)),
  };
  return audit.class || audit.gates.length > 0 || audit.exhausted.length > 0 ? audit : null;
}

export function stateOf(row: Row): DecisionAsk["state"] {
  const status = (text(row.status) ?? "").toLowerCase();
  if (text(row.archived_at) || status.startsWith("archived")) return "archived";
  if (OUTCOME_KEYS.some((key) => text(row[key]) !== null) || TERMINAL_STATUS.test(status)) return "answered";
  return "open";
}

/** The key that holds a ledger's asks: `asks`, or the corpus's other spelling `open_asks`. Reader and writer share it. */
function asksKey(data: unknown): "asks" | "open_asks" | null {
  if (!isRow(data)) return null;
  if (Array.isArray(data.asks)) return "asks";
  return Array.isArray(data.open_asks) ? "open_asks" : null;
}

/** One entry per item of the asks list, in order, null for an item that is not a mapping: indices match the YAML's. */
export function rowsOf(data: unknown): (Row | null)[] {
  const key = asksKey(data);
  if (!key || !isRow(data)) return [];
  return (data[key] as unknown[]).map((item) => (isRow(item) ? item : null));
}

/**
 * Handles that do not name one ask: an id two uid-less asks share, and a uid
 * two asks share. An answer to either could land on the wrong entry, so none is
 * written. (An id that a uid-less ask shares with asks that have a uid is not
 * ambiguous: the uid-less one is the only ask that goes by it.)
 */
export function ambiguity(rows: readonly (Row | null)[]): { ids: Set<string>; uids: Set<string> } {
  const twice = (values: (string | null)[]) => {
    const seen = new Set<string>();
    const again = new Set<string>();
    for (const value of values) {
      if (value === null) continue;
      if (seen.has(value)) again.add(value);
      seen.add(value);
    }
    return again;
  };
  const present = rows.filter((row): row is Row => row !== null);
  return {
    ids: twice(present.filter((row) => !text(row.uid)).map((row) => text(row.id))),
    uids: twice(present.map((row) => text(row.uid))),
  };
}

/** A value with its keys in order, so two readings of one entry serialize alike. */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value instanceof Date) return value.toISOString();
  if (!isRow(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

/** An entry as it reads now: the answer carries it, so an entry changed since you read it is not answered. */
export function entryHash(row: Row): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(row)))
    .digest("hex")
    .slice(0, 16);
}

export function decisionOf(
  row: Row,
  data: Row,
  ledger: string,
  ambiguous: { ids: Set<string>; uids: Set<string> },
  home: AskHome,
): DecisionAsk | null {
  const id = text(row.id);
  if (!id) return null;
  const uid = text(row.uid);
  const state = stateOf(row);
  const answerKey = ANSWER_KEYS.find((key) => text(row[key]) !== null);
  const origin = isRow(row.origin) ? row.origin : {};
  const originAgent = text(origin.agent_id);
  const refusal =
    state !== "open"
      ? null
      : uid && ambiguous.uids.has(uid)
        ? `Two asks in ${ledger} share the uid ${uid}, so an answer could land on the wrong one. Give one a new uid.`
        : !uid && ambiguous.ids.has(id)
          ? `Two asks in ${ledger} are named ${id} and neither has a uid, so an answer could land on the wrong one. Give one a uid or a new id.`
          : null;
  const options = optionsOf(row.options);
  const blocking = row.blocking === true;
  return {
    ledger,
    uid,
    id,
    hash: entryHash(row),
    arc: text(data.arc),
    headline: text(row.headline),
    question: text(row.question) ?? text(row.ask),
    stakes: text(row.stakes),
    whyYou: text(row.why_you),
    options,
    fallback: text(row.default) ?? text(row.default_if_silent),
    blocking,
    askedAt: text(row.asked_at),
    answeredAt: text(row.answered_at) ?? text(row.defaulted_at),
    answer: answerKey ? text(row[answerKey]) : null,
    answerOption: text(row.answer_option),
    state,
    origin: originAgent ? { agentId: originAgent, cwd: text(origin.cwd) } : null,
    refusal,
    home,
    batched: false,
    waiting: isWaiting({ state, blocking, options }),
    idea: ideaOf(row),
    audit: auditOf(row),
  };
}

export function parsed(source: string): Row {
  const doc = parseDocument(source);
  if (doc.errors.length > 0) throw new Error(`it has a YAML error: ${doc.errors[0]?.message}`);
  const data = doc.toJS() as unknown;
  if (!isRow(data)) throw new Error("its top level is not a mapping");
  return data;
}

/** One ledger's asks, as the Fleet view shows them. */
export function decisionsOf(source: string, ledger: string, home: AskHome = ROOTLESS): DecisionAsk[] {
  const data = parsed(source);
  const rows = rowsOf(data);
  const ambiguous = ambiguity(rows);
  return rows.flatMap((row) => {
    const ask = row ? decisionOf(row, data, ledger, ambiguous, home) : null;
    return ask ? [ask] : [];
  });
}

/** A home for a ledger read on its own, outside any root. */
const ROOTLESS: AskHome = { kind: "root", path: "", branch: null };

/** A ledger's file name: no folder, no dot file (a temp file of the lock's is `.<name>.tmp-…`). */
export const LEDGER = /^[^./][^/]*\.ya?ml$/;

/** The open asks, then the latest answered (ANSWERED_SHOWN), newest first. */
export function shown(all: readonly DecisionAsk[]): DecisionAsk[] {
  const answered = all
    .filter((ask) => ask.state === "answered")
    .sort((a, b) => (b.answeredAt ?? "").localeCompare(a.answeredAt ?? ""))
    .slice(0, ANSWERED_SHOWN);
  return [...all.filter((ask) => ask.state === "open"), ...answered];
}

/**
 * Every ask in a root's ledgers that is open, and the latest answered ones.
 * A root that is absent holds none; a ledger that cannot be read is said in
 * `warnings` and the rest are still read.
 */
export async function readDecisions(root: string): Promise<{ asks: DecisionAsk[]; warnings: string[] }> {
  let names: string[];
  try {
    names = (await readdir(root)).filter((name) => LEDGER.test(name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { asks: [], warnings: [] };
    return { asks: [], warnings: [`The asks in ${root} could not be read: ${(error as Error).message}`] };
  }
  const warnings: string[] = [];
  const all: DecisionAsk[] = [];
  const home: AskHome = { kind: "root", path: root, branch: null };
  for (const name of names) {
    try {
      const source = await readLedger(join(root, name));
      all.push(...decisionsOf(source, name, home));
    } catch (error) {
      warnings.push(`The ask ledger ${name} could not be read: ${(error as Error).message}`);
    }
  }
  return { asks: shown(all), warnings };
}

/** A ledger's text: a regular file only (a link would be replaced by the rename), within the limit. */
export async function readLedger(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error("it is not a regular file");
  if (info.size > LEDGER_LIMIT) throw new Error(`it is over ${LEDGER_LIMIT} bytes`);
  return readFile(path, "utf8");
}

// ── The lock (§5.5) ──────────────────────────────────────────────────────────

/** A lock this old whose holder is dead is reclaimed; one with no pid yet counts as live until then. */
export const LOCK_STALE_MS = 120_000;
/** The reclaim mutex is broken past this, as tick.sh does. */
const RECLAIM_STALE_MS = 60_000;

/** `<k>`: the first 16 hex of the SHA-256 of realpath(dirname(L)) + "/" + basename(L). */
export async function lockKey(ledgerPath: string): Promise<string> {
  const dir = await realpath(dirname(ledgerPath));
  return createHash("sha256")
    .update(`${dir}/${basename(ledgerPath)}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

/**
 * This process's start, in whole seconds since the epoch. A holder's pid file
 * is `<pid> <start>\n`, both decimal, the start in seconds since the epoch, so a
 * reused pid with another start is not the holder. Other writers taking this
 * lock write the same grammar; a file without a start is judged by its pid alone.
 */
let ownStart: number | null = null;
/**
 * Read from ps, as other writers will read it: Node's uptime stops while the
 * Mac sleeps, ps's does not. Kept once ps answers; until then each take asks it
 * again, and uptime stands in.
 */
async function started(): Promise<number> {
  ownStart ??= await startOf(process.pid);
  return ownStart ?? Math.round(Date.now() / 1000 - process.uptime());
}

/** `ps -o etime=`'s `[[dd-]hh:]mm:ss` in seconds: elapsed time, which no time zone shifts (lstart's local time does). */
export function etimeSeconds(etime: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

/** When a pid's process started (whole seconds), from ps; null when it cannot be told. */
function startOf(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("/bin/ps", ["-o", "etime=", "-p", String(pid)], { timeout: 2000 }, (error, stdout) => {
      const elapsed = error ? null : etimeSeconds(stdout);
      resolve(elapsed === null ? null : Math.round(Date.now() / 1000 - elapsed));
    });
  });
}

function pidOf(pidFile: string): { pid: number; start: number | null } | null {
  const [pidText, startText] = pidFile.trim().split(/\s+/);
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const start = Number(startText);
  return { pid, start: startText !== undefined && Number.isFinite(start) ? start : null };
}

/** Whether the holder a pid file names is alive: its pid answers, and it started when it said. */
export async function holderAlive(pidFile: string): Promise<boolean> {
  const holder = pidOf(pidFile);
  if (!holder) return false;
  try {
    process.kill(holder.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (holder.start === null) return true;
  const actual = await startOf(holder.pid);
  return actual === null || Math.abs(actual - holder.start) <= 2;
}

export interface Lock {
  dir: string;
  token: string;
}

/** The locks this process holds now. One of its own it does not hold was left behind (§5.5: dropped at once). */
const held = new Set<string>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function ageOf(path: string, now: number): Promise<number | null> {
  try {
    return now - (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Whether a lock may be taken away, and by whom it is held: null when it is gone.
 * Stale: its holder is dead and it is 120 s old (one with no pid yet is live for
 * its first 120 s), or it is this process's own and this process holds it no more.
 * A live holder is never stale, however old.
 */
async function staleness(dir: string, now: number): Promise<{ stale: boolean; holder: string } | null> {
  const age = await ageOf(dir, now);
  if (age === null) return null;
  const pidFile = await readFile(join(dir, "pid"), "utf8").catch(() => null);
  const holder = pidFile ? pidOf(pidFile) : null;
  const words = holder ? `pid ${holder.pid}` : "a writer starting up";
  if (holder?.pid === process.pid && holder.start !== null && Math.abs(holder.start - (await started())) <= 2) {
    return { stale: !held.has(dir), holder: words };
  }
  const alive = pidFile === null ? age < LOCK_STALE_MS : await holderAlive(pidFile);
  return { stale: !alive && age >= LOCK_STALE_MS, holder: words };
}

/**
 * Takes a stale lock away under its reclaim mutex, judging it again once the
 * mutex is held (as tick.sh does): another writer may have reclaimed it and
 * taken a fresh one meanwhile, which is live and stays.
 */
async function reclaim(dir: string, now: () => number): Promise<void> {
  const mutex = `${dir.replace(/\.d$/, "")}.reclaim.d`;
  try {
    await mkdir(mutex);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const age = await ageOf(mutex, now());
    if (age !== null && age >= RECLAIM_STALE_MS) await rm(mutex, { recursive: true, force: true });
    return;
  }
  try {
    if (!(await staleness(dir, now()))?.stale) return;
    const aside = `${dir}.stale-${randomBytes(4).toString("hex")}`;
    await rename(dir, aside).then(
      () => rm(aside, { recursive: true, force: true }),
      () => undefined,
    );
  } finally {
    await rm(mutex, { recursive: true, force: true });
  }
}

export async function acquireLock(
  ledgerPath: string,
  lockRoot: string,
  options: { waitMs?: number; now?: () => number } = {},
): Promise<Lock> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.waitMs ?? 5000);
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const dir = join(lockRoot, `${await lockKey(ledgerPath)}.d`);
  let holder = "another writer";
  for (;;) {
    let made = false;
    try {
      await mkdir(dir);
      made = true;
      // Held from the moment it is made: a pid of ours on a lock not yet marked held would read as left behind.
      held.add(dir);
      const token = randomBytes(16).toString("hex");
      await writeFile(join(dir, "pid"), `${process.pid} ${await started()}\n`);
      await writeFile(join(dir, "token"), `${token}\n`);
      return { dir, token };
    } catch (error) {
      // Made but not finished: taken back, so no half-written lock is left to wedge the ledger.
      if (made) {
        held.delete(dir);
        await rm(dir, { recursive: true, force: true });
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const state = await staleness(dir, now());
    if (state?.stale) await reclaim(dir, now);
    else if (state) holder = state.holder;
    if (now() >= deadline) {
      throw new UserError(
        `Another writer holds this ledger's lock (${holder}), so nothing was written. Try again in a moment.`,
      );
    }
    await sleep(50 + Math.floor(Math.random() * 50));
  }
}

/**
 * Drops every lock in the root that this process left behind: its own pid and
 * start, not held now. Run at each scan (§5.5), so another writer is never kept
 * waiting on a lock of Maestro's that only Maestro's next answer would clear.
 * It runs between this process's answers, never during one (exclusive): a lock
 * released and taken again meanwhile would otherwise read as left behind.
 */
export function dropLeftovers(lockRoot: string): Promise<void> {
  return exclusive(() => dropNow(lockRoot));
}

async function dropNow(lockRoot: string): Promise<void> {
  const names = await readdir(lockRoot).catch(() => [] as string[]);
  for (const name of names.filter((entry) => entry.endsWith(".d") && !entry.endsWith(".reclaim.d"))) {
    const dir = join(lockRoot, name);
    if (held.has(dir)) continue;
    const holder = pidOf((await readFile(join(dir, "pid"), "utf8").catch(() => "")) ?? "");
    if (holder?.pid === process.pid && holder.start !== null && Math.abs(holder.start - (await started())) <= 2) {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

async function stillOurs(lock: Lock): Promise<boolean> {
  const token = await readFile(join(lock.dir, "token"), "utf8").catch(() => null);
  return token?.trim() === lock.token;
}

export async function releaseLock(lock: Lock): Promise<void> {
  // No longer held here, whatever follows: a lock of ours left behind is then stale to our next write.
  held.delete(lock.dir);
  if (!(await stillOurs(lock))) return;
  await rm(join(lock.dir, "token"), { force: true });
  await rm(join(lock.dir, "pid"), { force: true });
  await rm(lock.dir, { recursive: true, force: true });
}

// ── The answer (§5.5) ────────────────────────────────────────────────────────

/** The column a key sits at: an ask is a sequence item, so its first key follows `  - `. */
function indentOf(source: string, offset: number): string {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  return " ".repeat(offset - lineStart);
}

/**
 * A YAML scalar on one line: JSON-quoted, whose escapes are YAML's double-quoted
 * ones, so a multi-line answer stays one line and the diff within the spec's
 * bound (§5.5: added lines <= keys + answer lines - 1; a block literal adds one).
 */
function renderScalar(value: string | null): string {
  return value === null ? "null" : JSON.stringify(value);
}

interface Edit {
  start: number;
  end: number;
  text: string;
  /** Build order, used to break ties between inserts at the same offset. */
  seq: number;
}

type Range = [number, number, number];

/**
 * A key written as `key: "value"`. One the entry has is rewritten from its key
 * to the end of its value: a value-less key (`answered_at:`) ends at its colon,
 * and a block scalar's range, which runs on past its last line, is cut back to
 * its last content. One it lacks is appended after the map's last content.
 */
function upsertKey(
  source: string,
  map: YAMLMap,
  key: string,
  value: string | null,
  indent: string,
  seq: number,
  newline: string,
): Edit {
  for (const pair of map.items) {
    const name = pair.key as { value?: unknown; range?: Range } | null;
    if (!name?.range || String(name.value ?? "") !== key) continue;
    const start = name.range[0];
    const valueRange = (pair.value as { range?: Range } | null)?.range;
    let end = Math.max(name.range[1], valueRange?.[1] ?? 0);
    if (!valueRange || valueRange[0] === valueRange[1]) end = Math.max(end, source.indexOf(":", name.range[1]) + 1);
    while (end > start && /\s/.test(source[end - 1] ?? "")) end--;
    return { start, end, text: `${key}: ${renderScalar(value)}`, seq };
  }
  let at = map.range?.[1] ?? source.length;
  while (at > 0 && /\s/.test(source[at - 1] ?? "")) at--;
  return { start: at, end: at, text: `${newline}${indent}${key}: ${renderScalar(value)}`, seq };
}

export interface AnswerInput {
  /** Which ask: its uid when it has one, else its id. */
  uid: string | null;
  id: string;
  /** The entry as you read it (DecisionAsk.hash): an entry changed since is not answered. Null: not checked. */
  hash: string | null;
  /** The option you tapped, or none for an answer in words alone. */
  option: string | null;
  /** Your words, beside the option or alone. */
  note: string;
  /** An idea parked: the day it comes back, written as its `wake`. Only an idea's `park` takes one. */
  wake?: string | null;
}

/** The text an answer records: the option's label and consequence, so a person reads it later; then your words. */
export function answerText(option: DecisionOption | null, note: string): string {
  const chosen = option ? [option.label, option.consequence].filter(Boolean).join(": ") : "";
  return [chosen, note.trim()].filter(Boolean).join("\n");
}

const WRITTEN_KEYS = ["answer_option", "answered_at", "answered_by", "status"] as const;

/** A YYYY-MM-DD that is a real day: 2026-02-30 is not (JS would roll it to March; the ledger's validator refuses it). */
export function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** Today as YYYY-MM-DD where this runs: a wake is judged against the owner's own calendar. */
export function localDay(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** Every entry but the target, and the target's keys but those written: what an answer must leave as it was. */
function untouched(data: Row, index: number, answerKey: string, extra: readonly string[] = []): string {
  const rows = rowsOf(data).map((row, at) => {
    if (at !== index || !row) return row;
    const kept = { ...row };
    for (const key of [answerKey, ...WRITTEN_KEYS, ...extra]) delete kept[key];
    return kept;
  });
  const key = asksKey(data) ?? "asks";
  return JSON.stringify(canonical({ ...data, [key]: rows }));
}

/**
 * The ledger with the answer written into its target entry and nothing else
 * changed, and the ask as it then reads; throws in words when the ask cannot
 * be answered, or the edit would change anything but the answer's keys.
 */
export function withAnswer(
  source: string,
  ledger: string,
  input: AnswerInput,
  at: Date,
  home: AskHome = ROOTLESS,
): { out: string; ask: DecisionAsk; hash: string } {
  const unwritable = `Maestro could not write this answer into ${ledger} without changing anything else there, so nothing was written.`;
  const doc = parseDocument(source);
  if (doc.errors.length > 0) throw new UserError(`${ledger} has a YAML error, so nothing was written to it.`);
  const data = doc.toJS() as unknown;
  const key = asksKey(data);
  const asks = key ? doc.get(key, true) : null;
  if (!isRow(data) || !key || !isSeq(asks)) {
    throw new UserError(`${ledger} has no asks list, so nothing was written to it.`);
  }
  const rows = rowsOf(data);
  const ambiguous = ambiguity(rows);
  const index = input.uid
    ? rows.findIndex((row) => row !== null && text(row.uid) === input.uid)
    : rows.findIndex((row) => row !== null && !text(row.uid) && text(row.id) === input.id);
  const row = rows[index];
  const target = asks.items[index];
  if (!row || !isMap(target)) {
    throw new UserError(`${ledger} no longer holds the ask ${input.id}. Look at the Fleet view again.`);
  }
  if (input.uid ? ambiguous.uids.has(input.uid) : ambiguous.ids.has(input.id)) {
    throw new UserError(
      input.uid
        ? `Two asks in ${ledger} share the uid ${input.uid}, so none was answered.`
        : `Two asks in ${ledger} are named ${input.id} and neither has a uid, so none was answered.`,
    );
  }
  if (stateOf(row) !== "open") {
    throw new UserError(`The ask ${input.id} was already answered or retired; your answer was not written.`);
  }
  const hash = entryHash(row);
  if (input.hash !== null && input.hash !== hash) {
    throw new UserError(`The ask ${input.id} changed since you read it; look at it again before answering.`);
  }
  if (target.flow) throw new UserError(`The ask ${input.id} is written in flow style ({ … }); ${unwritable}`);
  const options = optionsOf(row.options);
  const option = input.option ? (options.find((entry) => entry.id === input.option) ?? null) : null;
  if (input.option && !option) {
    throw new UserError(`The ask ${input.id} no longer offers that option. Look at the Fleet view again.`);
  }
  // An idea is answered develop, park or kill, never with words alone: what Maestro (and ask_ledger.py) acts on.
  if (ideaOf(row) && !(option && IDEA_OPTIONS.includes(option.id))) {
    throw new UserError(`${input.id} is an idea: choose develop, park or kill. It was not answered.`);
  }
  // A wake goes only with an idea's park, and never into the past: the date a parked idea comes back.
  const wake = input.wake ?? null;
  if (wake !== null) {
    if (!ideaOf(row) || option?.id !== "park") {
      throw new UserError(`Only an idea you park takes a wake date; ${input.id} was not answered.`);
    }
    if (!isCalendarDay(wake)) {
      throw new UserError(`${wake} is not a date (YYYY-MM-DD); ${input.id} was not answered.`);
    }
    if (wake < localDay(at)) {
      throw new UserError(`The wake date ${wake} has passed; choose today or later. ${input.id} was not answered.`);
    }
    // ask_ledger.py refuses a wake before the day the idea was asked, as its asked_at writes it.
    const asked = dayOf(text(row.asked_at)?.slice(0, 10) ?? row.asked_at);
    if (asked && wake < asked) {
      throw new UserError(
        `The wake date ${wake} is before the idea was asked (${asked}); ${input.id} was not answered.`,
      );
    }
  }
  // The option's label may name the date the ask proposed; the answer says the one you chose.
  const answer = [answerText(option, input.note), wake !== null ? `Wake: ${wake}.` : ""].filter(Boolean).join("\n");
  if (!answer) throw new UserError("Choose an option or write an answer.");
  const firstKey = target.items[0]?.key as { range?: Range } | null;
  const indent = firstKey?.range ? indentOf(source, firstKey.range[0]) : "    ";
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const answerKey = ANSWER_KEYS.find((name) => target.has(name)) ?? "answer";
  const stamp = at.toISOString().replace(/\.\d{3}Z$/, "Z");
  // No option chosen clears one a writer left there, so the ledger never says you chose what you did not.
  const chosen: [string, string | null][] = option
    ? [["answer_option", option.id]]
    : target.has("answer_option")
      ? [["answer_option", null]]
      : [];
  const writes: [string, string | null][] = [
    [answerKey, answer],
    ...chosen,
    ["answered_at", stamp],
    ["answered_by", "owner:maestro"],
    ["status", "resolved"],
    ...(wake !== null ? ([["wake", wake]] as [string, string][]) : []),
  ];
  // A key to write that holds a list or a map is the writer's data, not a placeholder: never replaced by a line.
  for (const [name] of writes) {
    const existing = row[name];
    if (existing !== null && typeof existing === "object" && !(existing instanceof Date)) {
      throw new UserError(`The ask ${input.id}'s ${name} holds a list or a map; ${unwritable}`);
    }
  }
  const edits = writes.map(([name, value], seq) => upsertKey(source, target, name, value, indent, seq, newline));
  // Back to front so earlier offsets hold; inserts at one offset go highest-seq first, which leaves them in order.
  let out = source;
  for (const edit of [...edits].sort((a, b) => b.start - a.start || b.seq - a.seq)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  // It must read back as this entry, answered, with every other entry and key as it was; else nothing is written.
  let after: Row;
  try {
    after = parsed(out);
  } catch {
    throw new UserError(unwritable);
  }
  const back = rowsOf(after)[index];
  const ask = back ? decisionOf(back, after, ledger, ambiguity(rowsOf(after)), home) : null;
  if (
    ask?.state !== "answered" ||
    ask.answeredAt !== stamp ||
    ask.answer !== answer ||
    ask.answerOption !== (option?.id ?? null) ||
    (wake !== null && ask.idea?.wake !== wake)
  ) {
    throw new UserError(unwritable);
  }
  const extra = wake !== null ? ["wake"] : [];
  if (untouched(after, index, answerKey, extra) !== untouched(data, index, answerKey, extra)) {
    throw new UserError(unwritable);
  }
  return { out, ask, hash };
}

export interface AnswerOptions {
  lockRoot: string;
  /** Where each answer's receipt line goes (§5.5): who answered what, and where. */
  receipts: string;
  now?: () => number;
  waitMs?: number;
  log?: (message: string) => void;
  /** For a test: runs after the temp file is written, before the token is checked and it is renamed. */
  beforeRename?: () => Promise<void>;
  /** The ask's home, as the answered ask then says; the ledger's own folder when not given. */
  home?: AskHome;
}

/**
 * Every lock step of this process, one at a time: an answer (take, write,
 * release) and a sweep of leftovers. The Fleet view and the workspace's asks
 * each queue their own writes, and share this, so a sweep never reads a lock
 * released and taken again meanwhile as left behind.
 */
let lockSteps: Promise<unknown> = Promise.resolve();
function exclusive<T>(run: () => Promise<T>): Promise<T> {
  const next = lockSteps.catch(() => undefined).then(run);
  lockSteps = next;
  return next;
}

/**
 * Writes your answer into the ledger at `path` under the lock, and returns the
 * ask as it now reads, with a warning when the answer is in but its receipt is not.
 */
export function answerDecision(
  path: string,
  input: AnswerInput,
  options: AnswerOptions,
): Promise<{ ask: DecisionAsk; warning: string | null }> {
  return exclusive(() => answerNow(path, input, options));
}

async function answerNow(
  path: string,
  input: AnswerInput,
  options: AnswerOptions,
): Promise<{ ask: DecisionAsk; warning: string | null }> {
  const ledger = basename(path);
  const home: AskHome = options.home ?? { kind: "root", path: dirname(path), branch: null };
  const now = options.now ?? Date.now;
  const gone = () => new UserError(`${ledger} is gone or not a regular file, so nothing was written.`);
  if (!(await lstat(path).catch(() => null))?.isFile()) throw gone();
  const lock = await acquireLock(path, options.lockRoot, { now, waitMs: options.waitMs });
  let written: ReturnType<typeof withAnswer>;
  try {
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile()) throw gone();
    written = withAnswer(await readLedger(path), ledger, input, new Date(now()), home);
    const temp = join(dirname(path), `.${ledger}.tmp-${lock.token}`);
    try {
      await writeFile(temp, written.out, { mode: info.mode & 0o777, flag: "wx" });
      await options.beforeRename?.();
      if (!(await stillOurs(lock))) throw new UserError("This ledger's lock was taken over; nothing was written.");
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  } finally {
    await releaseLock(lock);
  }
  const { ask, hash } = written;
  const receipt = {
    kind: "ask.answered",
    actor: "human",
    at: ask.answeredAt,
    home: path,
    homeKind: home.kind,
    ledger,
    uid: ask.uid,
    id: ask.id,
    askedAt: ask.askedAt,
    originAgentId: ask.origin?.agentId ?? null,
    /** The entry as it was answered (§5.2's legacy identity). */
    entryHash: hash,
    answerOption: ask.answerOption,
    answer: ask.answer,
    ...(input.wake ? { wake: input.wake } : {}),
  };
  // The answer is in the ledger already: a receipt that cannot be written is said, not thrown.
  try {
    await mkdir(dirname(options.receipts), { recursive: true, mode: 0o700 });
    await appendFile(options.receipts, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    return { ask, warning: null };
  } catch (error) {
    const message = `Your answer is in ${ledger}, but its receipt was not written (${(error as Error).message}).`;
    options.log?.(`asks: ${message}`);
    return { ask, warning: message };
  }
}
