// Decision asks in a `.control/asks` ledger, read for the Fleet view and
// answered from it, under the control interface's contract (workspace#861,
// docs/specs/2026-10-01-maestro-control-interface.html):
//
// - Which checkout (§5.2, §5.6). Only a registered machine-local root is read
//   here: the fleet's own, `<state dir>/.control/asks`. A root's home is that
//   root's file, so no git checkout is chosen, and none is ever written. Asks
//   in the control repo's checkouts need the full home rule and stay with the
//   Asks plugin.
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
import type { DecisionAsk, DecisionOption } from "../shared/fleet";
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

type Row = Record<string, unknown>;

function text(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const isRow = (value: unknown): value is Row => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function optionsOf(raw: unknown): DecisionOption[] {
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

function stateOf(row: Row): DecisionAsk["state"] {
  const status = (text(row.status) ?? "").toLowerCase();
  if (text(row.archived_at) || status.startsWith("archived")) return "archived";
  if (OUTCOME_KEYS.some((key) => text(row[key]) !== null) || TERMINAL_STATUS.test(status)) return "answered";
  return "open";
}

/** The rows of a ledger's `asks` (or the corpus's other spelling, `open_asks`). */
function rowsOf(data: unknown): Row[] {
  if (!isRow(data)) return [];
  const rows = Array.isArray(data.asks) ? data.asks : Array.isArray(data.open_asks) ? data.open_asks : [];
  return rows.filter(isRow);
}

/** Handles more than one uid-less ask in the file uses: those asks cannot be told apart, so none is answered. */
function collisions(rows: readonly Row[]): Set<string> {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const row of rows) {
    const id = text(row.id);
    if (!id || text(row.uid)) continue;
    if (seen.has(id)) twice.add(id);
    seen.add(id);
  }
  return twice;
}

/** One ledger's asks, as the Fleet view shows them. */
export function decisionsOf(source: string, ledger: string): DecisionAsk[] {
  const doc = parseDocument(source);
  if (doc.errors.length > 0) throw new Error(`it has a YAML error: ${doc.errors[0]?.message}`);
  const data = doc.toJS() as unknown;
  if (!isRow(data)) throw new Error("its top level is not a mapping");
  const rows = rowsOf(data);
  const twice = collisions(rows);
  return rows.flatMap((row) => {
    const id = text(row.id);
    if (!id) return [];
    const uid = text(row.uid);
    const state = stateOf(row);
    const answerKey = ANSWER_KEYS.find((key) => text(row[key]) !== null);
    const origin = isRow(row.origin) ? row.origin : {};
    const originAgent = text(origin.agent_id);
    const refusal =
      state !== "open"
        ? null
        : !uid && twice.has(id)
          ? `Two asks in ${ledger} are named ${id} and neither has a uid, so an answer could land on the wrong one. Give one a uid or a new id.`
          : null;
    return [
      {
        ledger,
        uid,
        id,
        arc: text(data.arc),
        headline: text(row.headline),
        question: text(row.question) ?? text(row.ask),
        stakes: text(row.stakes),
        whyYou: text(row.why_you),
        options: optionsOf(row.options),
        fallback: text(row.default) ?? text(row.default_if_silent),
        blocking: row.blocking === true,
        askedAt: text(row.asked_at),
        answeredAt: text(row.answered_at) ?? text(row.defaulted_at),
        answer: answerKey ? text(row[answerKey]) : null,
        answerOption: text(row.answer_option),
        state,
        origin: originAgent ? { agentId: originAgent, cwd: text(origin.cwd) } : null,
        refusal,
      },
    ];
  });
}

const LEDGER = /^[^./][^/]*\.ya?ml$/;

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
  for (const name of names) {
    try {
      const source = await readLedger(join(root, name));
      all.push(...decisionsOf(source, name));
    } catch (error) {
      warnings.push(`The ask ledger ${name} could not be read: ${(error as Error).message}`);
    }
  }
  const answered = all
    .filter((ask) => ask.state === "answered")
    .sort((a, b) => (b.answeredAt ?? "").localeCompare(a.answeredAt ?? ""))
    .slice(0, ANSWERED_SHOWN);
  return { asks: [...all.filter((ask) => ask.state === "open"), ...answered], warnings };
}

/** A ledger's text: a regular file only (a link would be replaced by the rename), within the limit. */
async function readLedger(path: string): Promise<string> {
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

/** This process's start, in whole seconds since the epoch: a reused pid with another start is not this holder. */
const started = () => Math.round(Date.now() / 1000 - process.uptime());

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

/** Whether the holder a pid file names is alive: its pid answers, and it started when it said. */
export async function holderAlive(pidFile: string): Promise<boolean> {
  const [pidText, startText] = pidFile.trim().split(/\s+/);
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  const said = Number(startText);
  if (!Number.isFinite(said)) return true;
  const actual = await startOf(pid);
  return actual === null || Math.abs(actual - said) <= 2;
}

export interface Lock {
  dir: string;
  token: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function ageOf(path: string, now: number): Promise<number | null> {
  try {
    return now - (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/** Takes a stale lock away under its reclaim mutex: renamed aside, then removed. */
async function reclaim(dir: string, now: number): Promise<void> {
  const mutex = `${dir.replace(/\.d$/, "")}.reclaim.d`;
  try {
    await mkdir(mutex);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const age = await ageOf(mutex, now);
    if (age !== null && age >= RECLAIM_STALE_MS) await rm(mutex, { recursive: true, force: true });
    return;
  }
  try {
    const aside = `${dir}.stale-${randomBytes(4).toString("hex")}`;
    await rename(dir, aside).then(
      () => rm(aside, { recursive: true, force: true }),
      () => undefined,
    );
  } finally {
    await rm(mutex, { recursive: true, force: true });
  }
}

/** Why the lock is held and by whom, when it is not ours to take; null when it is stale and was reclaimed. */
async function heldBy(dir: string, now: number): Promise<string | null> {
  const pidFile = await readFile(join(dir, "pid"), "utf8").catch(() => null);
  const age = await ageOf(dir, now);
  if (age === null) return null;
  const alive = pidFile === null ? age < LOCK_STALE_MS : await holderAlive(pidFile);
  if (alive || age < LOCK_STALE_MS) return pidFile ? `pid ${pidFile.trim().split(/\s+/)[0]}` : "a writer starting up";
  await reclaim(dir, now);
  return null;
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
    try {
      await mkdir(dir);
      const token = randomBytes(16).toString("hex");
      await writeFile(join(dir, "pid"), `${process.pid} ${started()}\n`);
      await writeFile(join(dir, "token"), `${token}\n`);
      return { dir, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    holder = (await heldBy(dir, now())) ?? holder;
    if (now() >= deadline) {
      throw new UserError(
        `Another writer holds this ledger's lock (${holder}), so nothing was written. Try again in a moment.`,
      );
    }
    await sleep(50 + Math.floor(Math.random() * 50));
  }
}

async function stillOurs(lock: Lock): Promise<boolean> {
  const token = await readFile(join(lock.dir, "token"), "utf8").catch(() => null);
  return token?.trim() === lock.token;
}

export async function releaseLock(lock: Lock): Promise<void> {
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
function renderScalar(value: string): string {
  return JSON.stringify(value);
}

interface Edit {
  start: number;
  end: number;
  text: string;
  seq: number;
}

/** Replaces a key's value span in place, or appends the key after the map's last content. */
function upsertKey(source: string, map: YAMLMap, key: string, value: string, indent: string, seq: number): Edit {
  for (const pair of map.items) {
    const pairKey = pair.key as { value?: unknown } | null;
    if (!pairKey || String(pairKey.value ?? "") !== key) continue;
    const node = pair.value as { range?: [number, number, number] } | null;
    if (node?.range) return { start: node.range[0], end: node.range[1], text: renderScalar(value), seq };
  }
  // A block scalar's range runs past the blank line after it: walk back to the last content instead.
  let at = map.range?.[1] ?? source.length;
  while (at > 0 && /\s/.test(source[at - 1] ?? "")) at--;
  return { start: at, end: at, text: `\n${indent}${key}: ${renderScalar(value)}`, seq };
}

export interface AnswerInput {
  /** Which ask: its uid when it has one, else its id. */
  uid: string | null;
  id: string;
  /** The option you tapped, or none for an answer in words alone. */
  option: string | null;
  /** Your words, beside the option or alone. */
  note: string;
}

/** The text an answer records: the option's label and consequence, so a person reads it later; then your words. */
export function answerText(option: DecisionOption | null, note: string): string {
  const chosen = option ? [option.label, option.consequence].filter(Boolean).join(": ") : "";
  return [chosen, note.trim()].filter(Boolean).join("\n");
}

/**
 * The ledger with the answer written into its target entry, and nothing else
 * changed; throws in words when the ask cannot be answered.
 */
export function withAnswer(source: string, ledger: string, input: AnswerInput, at: Date): string {
  const doc = parseDocument(source);
  if (doc.errors.length > 0) throw new UserError(`${ledger} has a YAML error, so nothing was written to it.`);
  const asks = doc.get("asks", true);
  if (!isSeq(asks)) throw new UserError(`${ledger} has no asks list, so nothing was written to it.`);
  const maps = asks.items.filter((item): item is YAMLMap => isMap(item));
  const rows = maps.map((map) => map.toJSON() as Row);
  const index = input.uid
    ? rows.findIndex((row) => text(row.uid) === input.uid)
    : rows.findIndex((row) => !text(row.uid) && text(row.id) === input.id);
  const row = rows[index];
  const target = maps[index];
  if (!row || !target)
    throw new UserError(`${ledger} no longer holds the ask ${input.id}. Look at the Fleet view again.`);
  if (!input.uid && collisions(rows).has(input.id)) {
    throw new UserError(`Two asks in ${ledger} are named ${input.id} and neither has a uid, so none was answered.`);
  }
  if (stateOf(row) !== "open") {
    throw new UserError(`The ask ${input.id} was already answered or retired; your answer was not written.`);
  }
  const options = optionsOf(row.options);
  const option = input.option ? (options.find((entry) => entry.id === input.option) ?? null) : null;
  if (input.option && !option) {
    throw new UserError(`The ask ${input.id} no longer offers that option. Look at the Fleet view again.`);
  }
  const answer = answerText(option, input.note);
  if (!answer) throw new UserError("Choose an option or write an answer.");
  const firstKey = target.items[0]?.key as { range?: [number, number, number] } | null;
  const indent = firstKey?.range ? indentOf(source, firstKey.range[0]) : "    ";
  const answerKey = ANSWER_KEYS.find((key) => target.has(key)) ?? "answer";
  const stamp = at.toISOString().replace(/\.\d{3}Z$/, "Z");
  const writes: [string, string][] = [
    [answerKey, answer],
    ...(option ? ([["answer_option", option.id]] as [string, string][]) : []),
    ["answered_at", stamp],
    ["answered_by", "owner:maestro"],
    ["status", "resolved"],
  ];
  const edits = writes.map(([key, value], seq) => upsertKey(source, target, key, value, indent, seq));
  // Back to front so earlier offsets hold; inserts at one offset go highest-seq first, which leaves them in order.
  let out = source;
  for (const edit of [...edits].sort((a, b) => b.start - a.start || b.seq - a.seq)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  // What was written must read back as this ask, answered, or nothing is written at all.
  const back = decisionsOf(out, ledger).find((ask) => (input.uid ? ask.uid === input.uid : ask.id === input.id));
  if (back?.state !== "answered" || back.answeredAt !== stamp) {
    throw new Error(`the answer did not read back from ${ledger}`);
  }
  return out;
}

export interface AnswerOptions {
  lockRoot: string;
  /** Where each answer's receipt line goes (§5.5): who answered what, and where. */
  receipts: string;
  now?: () => number;
  waitMs?: number;
  log?: (message: string) => void;
}

/** Writes your answer into the ledger at `path` under the lock, and returns the ask as it now reads. */
export async function answerDecision(path: string, input: AnswerInput, options: AnswerOptions): Promise<DecisionAsk> {
  const ledger = basename(path);
  const now = options.now ?? Date.now;
  const lock = await acquireLock(path, options.lockRoot, { now, waitMs: options.waitMs });
  let written: DecisionAsk | undefined;
  try {
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile()) throw new UserError(`${ledger} is gone or not a regular file, so nothing was written.`);
    const source = await readLedger(path);
    const at = new Date(now());
    const out = withAnswer(source, ledger, input, at);
    const temp = join(dirname(path), `.${ledger}.tmp-${lock.token}`);
    await writeFile(temp, out, { mode: info.mode & 0o777, flag: "wx" });
    try {
      if (!(await stillOurs(lock))) throw new UserError("This ledger's lock was taken over; nothing was written.");
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    written = decisionsOf(out, ledger).find((ask) => (input.uid ? ask.uid === input.uid : ask.id === input.id));
  } finally {
    await releaseLock(lock);
  }
  if (!written) throw new Error(`the answer did not read back from ${ledger}`);
  const receipt = {
    kind: "ask.answered",
    actor: "human",
    at: written.answeredAt,
    home: path,
    ledger,
    uid: written.uid,
    id: written.id,
    askedAt: written.askedAt,
    answerOption: written.answerOption,
    answer: written.answer,
  };
  // The answer is in the ledger already: a receipt that cannot be written is said, not thrown.
  try {
    await mkdir(dirname(options.receipts), { recursive: true, mode: 0o700 });
    await appendFile(options.receipts, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  } catch (error) {
    options.log?.(`asks: the receipt for ${ledger} ${written.id} was not written: ${(error as Error).message}`);
  }
  return written;
}
