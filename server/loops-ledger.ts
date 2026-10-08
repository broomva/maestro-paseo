// The loop intent ledger (BRO-2911 spec §1, §1a): one YAML per standing loop
// at `.broomva/loops/<id>.yaml` in the control repo, read from origin/main's
// blobs (`git ls-tree` + `git cat-file`, never a working tree: a shared
// checkout may sit on any branch), as control-home.ts reads the asks.
//
// Strict: an unknown key, a duplicate key, a missing required field or a value
// outside its set makes that row an error, shown in the Loops tab beside the
// rows that parsed. One bad file never costs the others, and never throws.
// The CI-blocking validator is the workspace's scripts/loop_ledger.py; this
// is the reader's own guard, so a row it cannot trust is never reconciled.
//
// One resolver, loopPaths(), names every place the layer reads or writes, so
// moving the ledger or the home is a one-line change (spec §1).

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import { parseDocument } from "yaml";
import {
  DESIRED,
  type Desired,
  type LedgerError,
  LOOP_SCOPES,
  type LoopIntent,
  type LoopScope,
  SUBSTRATE_KINDS,
  type SubstrateKind,
} from "../shared/loops";
import { catFiles, git } from "./control-home";

/** The ledger folder, repo-relative. */
export const LEDGER_DIR = ".broomva/loops";
export const PROMPTS_DIR = `${LEDGER_DIR}/prompts`;
export const MAIN_REF = "origin/main";
/** origin/main is fetched at most this often (as the asks are). */
export const LEDGER_FETCH_MS = 5 * 60_000;
/** A row bigger than this is not a row. */
const ROW_LIMIT = 64 * 1024;

/**
 * Where the loop layer lives: the intent (repo-relative), and the machine
 * streams and notes under the .broomva home (BROOMVA_HOME, else ~/.broomva),
 * as scripts/broomva_home.py resolves it.
 */
export function loopPaths(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.BROOMVA_HOME?.trim();
  const home = raw ? raw.replace(/^~(?=$|\/)/, homedir()) : join(homedir(), ".broomva");
  return {
    home,
    intent: LEDGER_DIR,
    /** ledger/loops/<name>.jsonl: drift, ticks, rollover, session. */
    streams: join(home, "ledger", "loops"),
    /** notes/loops/<id>/state.yaml: a loop's carry-forward state (§1a). */
    notes: join(home, "notes", "loops"),
  };
}

const REQUIRED = ["id", "title", "purpose", "owner", "scope", "substrate", "cadence", "review_by"] as const;
const OPTIONAL = [
  "initiative",
  "desired",
  "desired_since",
  "reason",
  "retires",
  "contract",
  "links",
  "notes",
  "prompt",
  "session",
] as const;
const KNOWN = new Set<string>([...REQUIRED, ...OPTIONAL]);
const SUBSTRATE_KEYS = new Set(["kind", "ref"]);
const PROMPTING: readonly SubstrateKind[] = ["paseo-heartbeat", "paseo-schedule", "session-cron"];
const FRESH: readonly SubstrateKind[] = ["paseo-heartbeat", "paseo-schedule"];
/** Rollover can replace only a heartbeat (§1a), so only a heartbeat is bound. */
const BINDABLE: readonly SubstrateKind[] = ["paseo-heartbeat"];
/** A bound row's owner is a role with no id: the bound session is observed, never declared. */
const BOUND_OWNERS = ["coordinator", "fleet", "owner"];
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROMPT = /^\.broomva\/loops\/prompts\/[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*\.md$/;

export interface LedgerRead {
  intents: LoopIntent[];
  errors: LedgerError[];
  /** The commit read; null for a folder, or when it could not be read. */
  sha: string | null;
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * One row from its bytes; `files` is every path the ledger folder holds, so a
 * prompt that names no file there is an error. Throws nothing: an error is a
 * string.
 */
export function parseRow(file: string, text: string, files: ReadonlySet<string>): LoopIntent | string {
  if (text.length > ROW_LIMIT) return `it is over ${ROW_LIMIT} bytes`;
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length > 0) return `unparseable YAML: ${doc.errors[0]?.message.split("\n")[0]}`;
  const data: unknown = doc.toJS();
  if (!data || typeof data !== "object" || Array.isArray(data)) return "the top level must be a mapping";
  const row = data as Record<string, unknown>;
  const errors: string[] = [];
  const unknown = Object.keys(row).filter((key) => !KNOWN.has(key));
  if (unknown.length > 0) errors.push(`unknown key${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}`);
  const missing = REQUIRED.filter((key) => !(key in row));
  if (missing.length > 0) errors.push(`missing ${missing.join(", ")}`);
  const stem = posix.basename(file).replace(/\.ya?ml$/, "");
  const id = str(row.id);
  if (id !== null && (id !== stem || !SLUG.test(id) || id.length > 48)) {
    errors.push(`id ${JSON.stringify(id)} must be a slug equal to the file name`);
  }
  for (const key of ["title", "purpose", "owner", "cadence"] as const) {
    if (key in row && (str(row[key]) ?? "").trim() === "") errors.push(`${key} must be text`);
  }
  const scope = str(row.scope);
  if ("scope" in row && !LOOP_SCOPES.includes(scope as LoopScope))
    errors.push(`scope must be ${LOOP_SCOPES.join("|")}`);
  const substrate = row.substrate as Record<string, unknown> | undefined;
  let kind: SubstrateKind | null = null;
  let ref: string | null = null;
  if ("substrate" in row) {
    if (!substrate || typeof substrate !== "object" || Array.isArray(substrate)) {
      errors.push("substrate must be {kind, ref}");
    } else {
      const extra = Object.keys(substrate).filter((key) => !SUBSTRATE_KEYS.has(key));
      if (extra.length > 0) errors.push(`unknown substrate key ${extra.join(", ")}`);
      kind = SUBSTRATE_KINDS.includes(substrate.kind as SubstrateKind) ? (substrate.kind as SubstrateKind) : null;
      if (!kind) errors.push(`substrate.kind must be one of ${SUBSTRATE_KINDS.join(", ")}`);
      ref = str(substrate.ref);
      if (!ref?.trim()) errors.push("substrate.ref must be text");
    }
  }
  const desired = "desired" in row ? str(row.desired) : null;
  if (desired !== null && !DESIRED.includes(desired as Desired)) errors.push(`desired must be ${DESIRED.join("|")}`);
  if ("desired" in row && desired === null) errors.push("desired must be text");
  if (scope === "sri" && "desired" in row) errors.push("a scope sri row has no desired");
  if (scope && scope !== "sri" && !("desired" in row)) errors.push("desired is required unless the scope is sri");
  const prompt = "prompt" in row ? str(row.prompt) : null;
  if ("prompt" in row) {
    if (!prompt || !PROMPT.test(prompt)) errors.push(`prompt must be a file under ${PROMPTS_DIR}/`);
    else if (!files.has(prompt)) errors.push(`prompt ${prompt} is not in the ledger`);
    if (kind && !PROMPTING.includes(kind)) errors.push(`prompt is only for ${PROMPTING.join(", ")}`);
  }
  const session = "session" in row ? str(row.session) : null;
  if ("session" in row) {
    if (session !== "bound" && session !== "fresh") errors.push("session must be bound|fresh");
    const kinds = session === "bound" ? BINDABLE : FRESH;
    if (kind && !kinds.includes(kind)) errors.push(`session: ${session} is only for ${kinds.join(", ")}`);
    if (session === "bound") {
      if (!prompt) errors.push("session: bound needs a prompt");
      if (ref && id && ref !== `name:${id}`) errors.push(`session: bound needs ref name:${id}`);
      if (!BOUND_OWNERS.includes(str(row.owner) ?? ""))
        errors.push(`session: bound needs owner ${BOUND_OWNERS.join("|")}`);
    }
  }
  const initiative = row.initiative ?? null;
  if (initiative !== null && typeof initiative !== "string") errors.push("initiative must be text or null");
  for (const key of ["desired_since", "reason", "review_by"] as const) {
    if (key in row && str(row[key]) === null) errors.push(`${key} must be text`);
  }
  if (errors.length > 0) return errors.join("; ");
  return {
    id: id as string,
    title: str(row.title) as string,
    purpose: str(row.purpose) as string,
    owner: str(row.owner) as string,
    scope: scope as LoopScope,
    initiative: initiative as string | null,
    substrate: { kind: kind as SubstrateKind, ref: ref as string },
    cadence: str(row.cadence) as string,
    desired: desired as Desired | null,
    desiredSince: str(row.desired_since),
    reason: str(row.reason),
    reviewBy: str(row.review_by),
    prompt,
    session: session as LoopIntent["session"],
    file,
  };
}

/** Every row of a set of files: the YAML ones directly in the folder; anything else is not a row. */
export function parseLedger(files: ReadonlyMap<string, string | null>): Omit<LedgerRead, "sha"> {
  const intents: LoopIntent[] = [];
  const errors: LedgerError[] = [];
  const names = new Set(files.keys());
  const claimed = new Map<string, string>();
  for (const [file, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const rel = file.slice(LEDGER_DIR.length + 1);
    if (rel.includes("/")) {
      // prompts/*.md is the one subfolder (§1a); anything else below the folder is said, not read.
      if (!(rel.startsWith("prompts/") && rel.endsWith(".md") && !rel.slice(8).includes("/"))) {
        errors.push({ file, error: "not a ledger row: only prompts/*.md may sit below the folder" });
      }
      continue;
    }
    if (!/\.ya?ml$/.test(rel)) continue;
    if (text === null) {
      errors.push({ file, error: "could not be read" });
      continue;
    }
    const row = parseRow(file, text, names);
    if (typeof row === "string") {
      errors.push({ file, error: row });
      continue;
    }
    const key = `${row.substrate.kind} ${row.substrate.ref}`;
    const first = claimed.get(key);
    if (first) {
      errors.push({ file, error: `${first} already claims ${row.substrate.kind} ${row.substrate.ref}` });
      continue;
    }
    claimed.set(key, file);
    intents.push(row);
  }
  return { intents, errors };
}

export interface LedgerSource {
  read(): Promise<LedgerRead>;
  /** Where it reads, in words: the repo and ref, or the folder. */
  readonly where: { repo: string; path: string };
}

/** The ledger on a repo's origin/main, fetched at most every LEDGER_FETCH_MS (off for a test without a remote). */
export function gitLedger(
  repo: string,
  options: { fetch?: boolean; now?: () => number; log?: (message: string) => void } = {},
): LedgerSource {
  const now = options.now ?? Date.now;
  let fetchedAt = Number.NEGATIVE_INFINITY;
  let fetching: Promise<void> | null = null;
  const fetchMain = async () => {
    if (!options.fetch || now() - fetchedAt < LEDGER_FETCH_MS) return;
    fetchedAt = now();
    fetching ??= git(repo, ["fetch", "-q", "origin", "main"], 60_000)
      .then(() => undefined)
      .catch((error) => options.log?.(`loops: fetching origin/main: ${(error as Error).message}`))
      .finally(() => {
        fetching = null;
      });
    await fetching;
  };
  return {
    where: { repo, path: `${MAIN_REF}:${LEDGER_DIR}` },
    async read() {
      await fetchMain();
      const sha = (await git(repo, ["rev-parse", "--verify", "-q", `${MAIN_REF}^{commit}`])).trim();
      const listed = await git(repo, ["ls-tree", "-r", "--full-tree", "--name-only", sha, "--", `${LEDGER_DIR}/`]);
      const paths = listed.split("\n").filter((line) => line.startsWith(`${LEDGER_DIR}/`));
      const blobs = await catFiles(
        repo,
        paths.map((path) => `${sha}:${path}`),
      );
      const files = new Map(paths.map((path) => [path, blobs.get(`${sha}:${path}`)?.toString("utf8") ?? null]));
      return { ...parseLedger(files), sha };
    },
  };
}

/** A ledger folder on disk: a test's fixture, or the dogfood's temp copy with a canary row. Never production. */
export function dirLedger(dir: string): LedgerSource {
  return {
    where: { repo: dir, path: LEDGER_DIR },
    async read() {
      const files = new Map<string, string | null>();
      const walk = async (at: string, rel: string) => {
        for (const entry of await readdir(at, { withFileTypes: true })) {
          const path = `${rel}/${entry.name}`;
          if (entry.isDirectory()) await walk(join(at, entry.name), path);
          else files.set(path, await readFile(join(at, entry.name), "utf8").catch(() => null));
        }
      };
      await walk(dir, LEDGER_DIR);
      return { ...parseLedger(files), sha: null };
    },
  };
}
