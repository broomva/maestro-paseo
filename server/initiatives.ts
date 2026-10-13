// The workspace's initiatives: every `.control/initiatives/<id>.yaml` of the
// control repo (spec docs/specs/2026-10-03-initiative-ledger.html, §5.1), read
// under the asks home rule (§5.4, after #861 §5.2):
//
// - The record is origin/main's blob (`git cat-file`, never a working tree).
// - A checkout whose copy differs from its merge-base with origin/main, in a
//   field whose change has not landed there, is an edit local to that
//   checkout: shown beside the record, never dropped, never the record. A file
//   only a checkout holds is shown from that checkout, marked local.
// - Maestro's answers worktree is not a source.
//
// A file that cannot be read as an initiative is an error row with the reason
// (the same rules scripts/initiative_ledger.py checks structurally, where they
// change what the tab can show), never hidden. Stale (§5.2's comparator, the
// date-only floor): active or blocked with review_by passed, or parked with
// wake reached, against the daemon's local date. A stale initiative counts in
// Needs you.
//
// Also here: the ideas filed for each initiative (idea-triage asks, read by
// server/control-home.ts with every other ask), a PR's state when GitHub can
// say it in one cached query, a session id resolved to its Paseo agent, and
// the brief a develop answer files as held work.

import { execFile } from "node:child_process";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import type { DecisionAsk } from "../shared/fleet";
import {
  INITIATIVE_STATUSES,
  type Initiative,
  type InitiativeNotice,
  type InitiativeStatus,
  type InitiativesView,
  initiativeNotice,
  NOT_STATED,
  type PrLink,
  type SessionLink,
  type WaitingOn,
} from "../shared/initiatives";
import { clipWords } from "../shared/text";
import { canonical, dayOf, isRow, localDay, type Row, text } from "./control-asks";
import { blobId, isLocal, parseWorktrees, type WorkspaceAsks } from "./control-home";
import { catFiles, git, MAIN_REF } from "./git";
import type { Paseo } from "./runs";

export const INITIATIVES_DIR = join(".control", "initiatives");
/** An initiative file is read up to this size; past it, it is an error row. */
const FILE_LIMIT = 256 * 1024;
/** A read is reused this long: the header count polls it from every client. */
export const INITIATIVES_TTL_MS = 10_000;
// `.yaml` only, as scripts/initiative_ledger.py reads them: a `.yml` would show here and fail the workspace's CI.
const FILE = /^[^./][^/]*\.yaml$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DRIVER = /^(owner|fleet|none|coordinator:[0-9a-f]{8}|session:[A-Za-z0-9_-]+)$/;
const PR_REF = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;
const LINK_KEYS = ["linear", "prs", "repos", "sessions", "asks"] as const;
const OPEN_STATUSES: readonly InitiativeStatus[] = ["active", "blocked_on_owner", "parked"];

// ── One file (pure) ──────────────────────────────────────────────────────────

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((entry) => text(entry)).filter((entry): entry is string => entry !== null) : [];

/** A file's fields, or why the tab cannot show it: every broken rule, in words. */
export interface ParsedInitiative {
  row: Row | null;
  errors: string[];
}

/** Reads one file's text, checking the rules the tab relies on. The id must be the file's name. */
export function parseInitiative(source: string, file: string): ParsedInitiative {
  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length > 0) return { row: null, errors: [`it has a YAML error: ${doc.errors[0]?.message}`] };
  const data = doc.toJS() as unknown;
  if (!isRow(data)) return { row: null, errors: ["its top level is not a mapping"] };
  const errors: string[] = [];
  const stem = file.replace(/\.ya?ml$/, "");
  const id = text(data.id);
  if (!id) errors.push("it has no id");
  else if (id !== stem) errors.push(`its id ${id} is not its file name ${stem}`);
  else if (!SLUG.test(id) || id.length > 40)
    errors.push(`its id ${id} is not lowercase-hyphenated within 40 characters`);
  if (!text(data.title)) errors.push("it has no title");
  const intent = text(data.intent);
  if (!intent) errors.push("it has no intent");
  else if (intent !== NOT_STATED && !text(data.intent_source)) {
    errors.push(
      `its intent is a quote with no intent_source (write ${NOT_STATED} when the words were not written down)`,
    );
  }
  const status = text(data.status);
  if (!status || !(INITIATIVE_STATUSES as readonly string[]).includes(status)) {
    errors.push(`its status ${status ?? "(none)"} is not one of ${INITIATIVE_STATUSES.join(", ")}`);
  }
  const driver = text(data.driver);
  if (!driver || !DRIVER.test(driver))
    errors.push(`its driver ${driver ?? "(none)"} is not owner, fleet, none, coordinator:<8 hex> or session:<id>`);
  else if (status === "active" && driver === "none") errors.push("it is active with no driver");
  if ((status === "active" || status === "blocked_on_owner") && !text(data.next_action)) {
    errors.push(`it is ${status} with no next_action`);
  }
  for (const key of ["stated", "review_by"] as const) {
    if (!dayOf(data[key])) errors.push(`its ${key} is not a YYYY-MM-DD date`);
  }
  if (status === "parked" && !dayOf(data.wake)) errors.push("it is parked with no wake date");
  if (status === "blocked_on_owner" && !(Array.isArray(data.waiting_on) && data.waiting_on.length > 0)) {
    errors.push("it is blocked with nothing in waiting_on");
  }
  if (!isRow(data.links) || Object.keys(data.links).length === 0) errors.push("it has no links");
  if (!text(data.exit)) errors.push("it has no exit");
  return { row: data, errors };
}

/** The ask a waiting_on ref names: `ledger.yaml` or `ledger.yaml#id`. */
function askRef(ref: string): { ledger: string | null; askId: string | null } {
  const [ledger, askId] = ref.split("#");
  const name = ledger?.split("/").pop() ?? "";
  return FILE.test(name) ? { ledger: name, askId: askId?.trim() || null } : { ledger: null, askId: null };
}

export function prLink(ref: string, states: ReadonlyMap<string, PrLink["state"]>): PrLink {
  const match = PR_REF.exec(ref);
  const url = match ? `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}` : "";
  return { ref, url, state: states.get(ref) ?? null };
}

/** Stale by the file's own dates (initiative_ledger.py stale): the floor the phase-3 sensor replaces. */
export function staleOf(row: Row, today: string): Initiative["stale"] {
  const status = text(row.status) as InitiativeStatus | null;
  if (!status || !OPEN_STATUSES.includes(status)) return null;
  if (status === "parked") {
    const wake = dayOf(row.wake);
    return wake && wake <= today ? { kind: "wake", date: wake } : null;
  }
  const reviewBy = dayOf(row.review_by);
  return reviewBy && reviewBy < today ? { kind: "overdue", date: reviewBy } : null;
}

export interface Lookups {
  today: string;
  prStates: ReadonlyMap<string, PrLink["state"]>;
  agents: ReadonlyMap<string, string>;
  ideas: ReadonlyMap<string, { open: number; triaged: number }>;
}

/** One initiative as the tab shows it; `error` set (and the rest best effort) when the file breaks a rule. */
export function initiativeOf(
  parsed: ParsedInitiative,
  file: string,
  home: Initiative["home"],
  lookups: Lookups,
): Initiative {
  const row = parsed.row ?? {};
  const id = text(row.id) ?? file.replace(/\.ya?ml$/, "");
  const links = isRow(row.links) ? row.links : {};
  const status = text(row.status);
  const intent = text(row.intent);
  const waitingOn: WaitingOn[] = (Array.isArray(row.waiting_on) ? row.waiting_on : []).filter(isRow).map((entry) => {
    const kind = text(entry.kind) ?? "";
    const ref = text(entry.ref) ?? "";
    return { kind, ref, note: text(entry.note), ...(kind === "ask" ? askRef(ref) : { ledger: null, askId: null }) };
  });
  const unknownLinks = Object.keys(links).filter((key) => !(LINK_KEYS as readonly string[]).includes(key));
  const errors = [
    ...parsed.errors,
    ...(unknownLinks.length > 0 ? [`its links has unknown keys ${unknownLinks.join(", ")}`] : []),
  ];
  return {
    id,
    file,
    home,
    error: errors.length > 0 ? `${file}: ${errors.join("; ")}.` : null,
    title: text(row.title),
    quote: intent && intent !== NOT_STATED ? intent : null,
    intentSource: text(row.intent_source),
    summary: text(row.summary),
    status: status && (INITIATIVE_STATUSES as readonly string[]).includes(status) ? (status as InitiativeStatus) : null,
    stated: dayOf(row.stated),
    reviewBy: dayOf(row.review_by),
    wake: dayOf(row.wake),
    nextAction: text(row.next_action),
    driver: text(row.driver),
    waitingOn,
    linear: strings(links.linear),
    prs: strings(links.prs).map((ref) => prLink(ref, lookups.prStates)),
    repos: strings(links.repos),
    sessions: strings(links.sessions).map(
      (session): SessionLink => ({ id: session, agentId: lookups.agents.get(session) ?? null }),
    ),
    asks: strings(links.asks),
    exit: text(row.exit),
    closedAt: dayOf(row.closed_at),
    outcome: text(row.outcome),
    // A file that breaks a rule is shown, never counted: its dates cannot be trusted.
    stale: errors.length === 0 ? staleOf(row, lookups.today) : null,
    local: [],
    ideas: lookups.ideas.get(id) ?? { open: 0, triaged: 0 },
  };
}

/** Stale first, then by status, then the soonest date. Pure. */
export function sortInitiatives(list: readonly Initiative[]): Initiative[] {
  const rank = (initiative: Initiative) =>
    initiative.error ? 0 : initiative.stale ? 1 : 2 + INITIATIVE_STATUSES.indexOf(initiative.status ?? "killed");
  const due = (initiative: Initiative) =>
    (initiative.status === "parked" ? initiative.wake : initiative.reviewBy) ?? "9999-12-31";
  return [...list].sort((a, b) => rank(a) - rank(b) || due(a).localeCompare(due(b)) || a.id.localeCompare(b.id));
}

/** Open and triaged ideas per initiative. */
export function ideaCounts(ideas: readonly DecisionAsk[]): Map<string, { open: number; triaged: number }> {
  const counts = new Map<string, { open: number; triaged: number }>();
  for (const ask of ideas) {
    const id = ask.idea?.initiative;
    if (!id) continue;
    const now = counts.get(id) ?? { open: 0, triaged: 0 };
    if (ask.state === "open") now.open += 1;
    else now.triaged += 1;
    counts.set(id, now);
  }
  return counts;
}

/** The fields one copy changes against another, by key: what a local edit is about. */
function changedFields(record: Row | null, mine: Row): string[] {
  const keys = new Set([...Object.keys(record ?? {}), ...Object.keys(mine)]);
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(canonical(a ?? null)) === JSON.stringify(canonical(b ?? null));
  return [...keys].filter((key) => !same(record?.[key], mine[key])).sort();
}

// ── The develop brief (pure) ─────────────────────────────────────────────────

/** How long a develop title may be; longer text is cut at a word, with "…". */
export const IDEA_TITLE_MAX = 100;

/**
 * The work a develop answer files: titled after the ask's headline (written
 * for people, at most 100 characters) or else the idea, cut at a word; briefed
 * from the initiative file and the idea.
 */
export function ideaWork(initiative: Initiative | null, ask: DecisionAsk): { title: string; brief: string } {
  const idea = ask.idea;
  const title = clipWords(ask.headline?.trim() || idea?.idea || ask.id, IDEA_TITLE_MAX);
  const lines = [
    `Develop an idea filed for the initiative ${idea?.initiative ?? "(none)"}: you chose develop in Maestro (${ask.ledger} ${ask.id}).`,
    "",
    "## The idea",
    "",
    idea?.idea ?? ask.question ?? ask.id,
  ];
  if (ask.question && ask.question !== idea?.idea) lines.push("", ask.question);
  if (ask.stakes) lines.push("", `What waiting costs: ${ask.stakes}`);
  if (idea?.evidence) lines.push("", `Evidence: ${idea.evidence}`);
  if (idea?.source) lines.push(`Source: ${idea.source.kind} ${idea.source.ref}`);
  if (ask.answer) lines.push("", "Your answer:", "", ...ask.answer.split("\n").map((line) => `> ${line}`));
  lines.push("", "## The initiative", "");
  if (!initiative || initiative.error) {
    lines.push(
      initiative?.error ??
        `.control/initiatives/${idea?.initiative ?? "?"}.yaml could not be read; read it before you start.`,
    );
  } else {
    lines.push(`${initiative.title ?? initiative.id} (.control/initiatives/${initiative.file}, ${initiative.status})`);
    lines.push("", `Intent: ${initiative.quote ? `"${initiative.quote}" (${initiative.intentSource})` : NOT_STATED}`);
    if (initiative.summary) lines.push("", initiative.summary);
    if (initiative.nextAction) lines.push("", `Its next action: ${initiative.nextAction}`);
    if (initiative.exit) lines.push(`Done when: ${initiative.exit}`);
    const links = [...initiative.linear, ...initiative.prs.map((pr) => pr.ref)];
    if (links.length > 0) lines.push(`Linked: ${links.join(", ")}`);
  }
  lines.push(
    "",
    "## How",
    "",
    `Scope one first slice from the evidence, file what you leave as ideas in .control/asks/ideas-${idea?.initiative ?? "<initiative>"}.yaml, and carry "Initiative: ${idea?.initiative ?? "<id>"}" in every PR body.`,
  );
  return { title, brief: lines.join("\n") };
}

// ── PR states, one cached query ──────────────────────────────────────────────

export type Run = (args: readonly string[]) => Promise<string>;

/**
 * What a gh call gave back. GraphQL answers every ref it can and exits 1 when
 * one is missing (a typo, a deleted or private repo), so its output is kept
 * when it has any: one bad ref must not blank every PR's state.
 */
export function ghOutput(error: Error | null, stdout: string): string {
  if (!error || stdout.trim()) return stdout;
  throw error;
}

/** gh, bounded: the PR states are a nicety, never a wait. */
export const ghRun: Run = (args) =>
  new Promise((resolve, reject) => {
    execFile("gh", [...args], { timeout: 20_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      try {
        resolve(ghOutput(error, stdout));
      } catch (thrown) {
        reject(thrown);
      }
    });
  });

/** Refreshed at most this often. */
export const PR_STATES_EVERY_MS = 10 * 60_000;

/**
 * PR states from GitHub, in one GraphQL query for every ref, refreshed in the
 * background at most every PR_STATES_EVERY_MS (sooner when a new ref appears);
 * a read never waits on it. Unknown until the first answer, and after gh fails.
 */
export function prStates(run: Run = ghRun, now: () => number = Date.now, log?: (message: string) => void) {
  const known = new Map<string, PrLink["state"]>();
  let asked = new Set<string>();
  let lastAt = 0;
  let inFlight: Promise<void> | null = null;
  const refresh = (refs: readonly string[]): Promise<void> => {
    const valid = refs.filter((ref) => PR_REF.test(ref));
    lastAt = now();
    // Every ref asked about, a malformed one too: one GitHub cannot answer is not new on the next read.
    asked = new Set(refs);
    if (valid.length === 0) return Promise.resolve();
    const repos = new Map<
      string,
      { owner: string; name: string; prs: { alias: string; ref: string; number: string }[] }
    >();
    valid.forEach((ref, at) => {
      const [, owner = "", name = "", number = ""] = PR_REF.exec(ref) ?? [];
      const key = `${owner}/${name}`;
      const repo = repos.get(key) ?? { owner, name, prs: [] };
      repo.prs.push({ alias: `p${at}`, ref, number });
      repos.set(key, repo);
    });
    const parts = [...repos.values()].map(
      (repo, at) =>
        `r${at}: repository(owner: ${JSON.stringify(repo.owner)}, name: ${JSON.stringify(repo.name)}) { ${repo.prs
          .map((pr) => `${pr.alias}: pullRequest(number: ${pr.number}) { state }`)
          .join(" ")} }`,
    );
    return run(["api", "graphql", "-f", `query=query { ${parts.join(" ")} }`])
      .then((out) => {
        const data = (JSON.parse(out) as { data?: Record<string, Record<string, { state?: string } | null> | null> })
          .data;
        [...repos.values()].forEach((repo, at) => {
          const found = data?.[`r${at}`];
          for (const pr of repo.prs) {
            const state = found?.[pr.alias]?.state?.toLowerCase();
            known.set(pr.ref, state === "open" || state === "merged" || state === "closed" ? state : null);
          }
        });
      })
      .catch((error) => {
        // GraphQL answers a missing PR with a partial result; gh exits 1 then too. Unknown, never an error row.
        log?.(`initiatives: reading PR states: ${(error as Error).message.split("\n")[0]}`);
      });
  };
  return {
    /** What is known now; asks for a refresh when it is due or a ref is new. */
    get(refs: readonly string[]): Map<string, PrLink["state"]> {
      const fresh = refs.some((ref) => !asked.has(ref));
      if (!inFlight && (fresh || now() - lastAt >= PR_STATES_EVERY_MS)) {
        inFlight = refresh([...new Set(refs)]).finally(() => {
          inFlight = null;
        });
      }
      return new Map(known);
    },
    /** For a test: waits for a refresh in flight. */
    settled: (): Promise<void> => inFlight ?? Promise.resolve(),
  };
}

// ── Session ids to agents ────────────────────────────────────────────────────

/** The session an initiative's driver names (`coordinator:<8 hex>`, `session:<id>`); null for owner, fleet, none. Pure. */
export function driverSession(driver: string | null): string | null {
  return /^(?:coordinator|session):(.+)$/.exec(driver ?? "")?.[1] ?? null;
}

/**
 * Answer routing's `driver` (BRO-2918): the initiative's driver as a session,
 * when its record names one that resolves to exactly one agent; else null.
 */
export function driverRelay(
  one: (id: string) => Promise<{ driver: string | null } | null>,
  ids: { resolve(paseo: Paseo | null, sessions: readonly string[]): Promise<Map<string, string>> },
) {
  return async (id: string, paseo: Paseo): Promise<{ agentId: string; as: string } | null> => {
    const named = (await one(id))?.driver ?? null;
    const session = driverSession(named);
    const agentId = session ? (await ids.resolve(paseo, [session])).get(session) : undefined;
    return agentId ? { agentId, as: `the driver of the initiative ${id} (${named})` } : null;
  };
}

/** Session ids resolved this long ago are asked again. */
export const AGENTS_EVERY_MS = 5 * 60_000;

/**
 * Resolves the session ids the files write (often an agent id's first 8 hex)
 * to Paseo agent ids: an id resolves when exactly one agent's id starts with
 * it. From one listing of up to 200 agents, archived included, cached.
 */
export function agentIds(now: () => number = Date.now, log?: (message: string) => void) {
  let ids: string[] = [];
  let at = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;
  const list = async (paseo: Paseo) => {
    try {
      const page = await paseo.agents.list({ filter: { includeArchived: true }, page: { limit: 200 } });
      ids = page.entries.map((entry) => entry.agent.id);
    } catch (error) {
      log?.(`initiatives: listing sessions: ${(error as Error).message}`);
    } finally {
      at = now();
    }
  };
  return {
    async resolve(paseo: Paseo | null, sessions: readonly string[]): Promise<Map<string, string>> {
      if (paseo && sessions.length > 0 && now() - at >= AGENTS_EVERY_MS) {
        inFlight ??= list(paseo).finally(() => {
          inFlight = null;
        });
        await inFlight;
      }
      const out = new Map<string, string>();
      for (const session of sessions) {
        const id = session.toLowerCase();
        const matches = ids.filter((agent) => agent.toLowerCase().startsWith(id));
        if (id.length >= 8 && matches.length === 1 && matches[0]) out.set(session, matches[0]);
      }
      return out;
    },
  };
}

// ── Reading the workspace ────────────────────────────────────────────────────

export interface WorkspaceInitiativesOptions {
  controlRepo: string;
  /** Maestro's answers worktree: not a source. */
  answersPath: string;
  /** The workspace's asks, where the ideas are read; none: no ideas. */
  asks: Pick<WorkspaceAsks, "read"> | null;
  prs?: ReturnType<typeof prStates> | null;
  agents?: ReturnType<typeof agentIds> | null;
  now?: () => number;
  log?: (message: string) => void;
  ttlMs?: number;
}

interface FileCopy {
  name: string;
  row: ParsedInitiative;
}

interface Scan {
  controlRepo: string;
  warnings: string[];
  /** The record per file name: origin/main's, else the first checkout that has it. */
  files: { name: string; parsed: ParsedInitiative; home: Initiative["home"]; locals: Initiative["local"] }[];
}

/** One checkout's initiative files, by name. */
async function filesIn(checkout: string, warnings: string[]): Promise<Map<string, Buffer>> {
  const folder = join(checkout, INITIATIVES_DIR);
  const out = new Map<string, Buffer>();
  const names = await readdir(folder).catch(() => [] as string[]);
  for (const name of names.filter((entry) => FILE.test(entry)).sort()) {
    const path = join(folder, name);
    try {
      const info = await lstat(path);
      if (!info.isFile()) continue;
      if (info.size > FILE_LIMIT) throw new Error(`it is over ${FILE_LIMIT} bytes`);
      out.set(name, await readFile(path));
    } catch (error) {
      warnings.push(`The initiative ${path} could not be read: ${(error as Error).message}`);
    }
  }
  return out;
}

async function treeOf(repo: string, commit: string): Promise<Map<string, string>> {
  const listing = await git(repo, ["ls-tree", "-z", "--full-tree", commit, "--", `${INITIATIVES_DIR}/`]);
  const tree = new Map<string, string>();
  for (const entry of listing.split("\0")) {
    const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(entry);
    const name = match?.[2]?.split("/").pop();
    if (match?.[1] && name && FILE.test(name)) tree.set(name, match[1]);
  }
  return tree;
}

/**
 * Every initiative, as the tab shows it, at most `ttlMs` old. The ideas come
 * from the workspace's asks (their own cache), PR states and agent ids from
 * their own caches: none of them makes a read wait on the network but the
 * first agent listing.
 */
export function workspaceInitiatives(options: WorkspaceInitiativesOptions) {
  const now = options.now ?? Date.now;
  let cached: { at: number; scan: Promise<Scan> } | null = null;

  const scan = async (): Promise<Scan> => {
    const repo = options.controlRepo;
    const warnings: string[] = [];
    if (!(await lstat(repo).catch(() => null))?.isDirectory()) return { controlRepo: repo, warnings, files: [] };
    let worktrees: ReturnType<typeof parseWorktrees>;
    try {
      worktrees = parseWorktrees(await git(repo, ["worktree", "list", "--porcelain"]));
    } catch (error) {
      return {
        controlRepo: repo,
        warnings: [`The control repo ${repo} could not be read as a git repo: ${(error as Error).message}`],
        files: [],
      };
    }
    const mainSha = (
      await git(repo, ["rev-parse", "--verify", "--quiet", `${MAIN_REF}^{commit}`]).catch(() => "")
    ).trim();
    if (!mainSha) {
      return {
        controlRepo: repo,
        warnings: [
          `${repo} has no ${MAIN_REF}, and the home rule needs it, so no initiative was read. Fetch it there.`,
        ],
        files: [],
      };
    }
    const format =
      (await git(repo, ["rev-parse", "--show-object-format"]).catch(() => "")).trim() === "sha256" ? "sha256" : "sha1";
    const mainTree = await treeOf(repo, mainSha);
    const answersReal = await realpath(options.answersPath).catch(() => options.answersPath);
    const checkouts: { path: string; branch: string | null; base: Map<string, string>; files: Map<string, Buffer> }[] =
      [];
    for (const tree of worktrees) {
      const real = await realpath(tree.path).catch(() => null);
      if (!real || real === answersReal || !tree.head) continue;
      const base = (await git(real, ["merge-base", tree.head, mainSha]).catch(() => "")).trim();
      checkouts.push({
        path: real,
        branch: tree.branch,
        base: base ? await treeOf(repo, base) : new Map(),
        files: await filesIn(real, warnings),
      });
    }
    const wanted = new Set<string>(mainTree.values());
    for (const checkout of checkouts) {
      for (const [name, bytes] of checkout.files) {
        const atBase = checkout.base.get(name);
        if (atBase && atBase !== blobId(bytes, format)) wanted.add(atBase);
      }
    }
    const blobs = await catFiles(repo, [...wanted]);
    const parsedBlob = (id: string | undefined, name: string): ParsedInitiative | null => {
      const bytes = id ? blobs.get(id) : null;
      if (!bytes) return null;
      if (bytes.length > FILE_LIMIT) return { row: null, errors: [`it is over ${FILE_LIMIT} bytes`] };
      return parseInitiative(bytes.toString("utf8"), name);
    };

    const records = new Map<string, Scan["files"][number]>();
    for (const [name, id] of mainTree) {
      // A blob git could not give back is an error row, never a missing card.
      const parsed = parsedBlob(id, name) ?? { row: null, errors: [`its blob ${id} could not be read from git`] };
      records.set(name, { name, parsed, home: { kind: "main", path: repo, branch: null }, locals: [] });
    }
    const copies: (FileCopy & { checkout: (typeof checkouts)[number] })[] = [];
    for (const checkout of checkouts) {
      for (const [name, bytes] of checkout.files) {
        const atBase = checkout.base.get(name);
        if (atBase === blobId(bytes, format)) continue;
        copies.push({ name, row: parseInitiative(bytes.toString("utf8"), name), checkout });
      }
    }
    for (const copy of copies) {
      const { name, checkout } = copy;
      const record = records.get(name);
      const mine = copy.row.row;
      const base = parsedBlob(checkout.base.get(name), name)?.row ?? null;
      // Landed: every field this copy changed reads on main as it gives it (control-home isLocal).
      if (record && mine && !isLocal(base, mine, record.parsed.row)) continue;
      if (!record) {
        records.set(name, {
          name,
          parsed: copy.row,
          home: { kind: "checkout", path: checkout.path, branch: checkout.branch },
          locals: [],
        });
        continue;
      }
      if (record.home.kind === "checkout" && record.home.path === checkout.path) continue;
      const theirs = record.parsed.row;
      record.locals.push({
        path: checkout.path,
        branch: checkout.branch,
        fields: mine ? changedFields(theirs, mine) : ["(cannot be read)"],
        status: mine && text(mine.status) !== text(theirs?.status) ? text(mine.status) : null,
        nextAction: mine && text(mine.next_action) !== text(theirs?.next_action) ? text(mine.next_action) : null,
      });
    }
    return {
      controlRepo: repo,
      warnings,
      files: [...records.values()].sort((a, b) => a.name.localeCompare(b.name)),
    };
  };

  const scanned = (): Promise<Scan> => {
    const at = now();
    if (cached && at - cached.at < (options.ttlMs ?? INITIATIVES_TTL_MS)) return cached.scan;
    const next = scan();
    cached = { at, scan: next };
    next.catch(() => {
      if (cached?.scan === next) cached = null;
    });
    return next;
  };

  const view = async (paseo: Paseo | null = null): Promise<InitiativesView> => {
    const [found, asks] = await Promise.all([
      scanned(),
      options.asks
        ? options.asks.read().catch((error) => {
            options.log?.(`initiatives: reading ideas: ${(error as Error).message}`);
            return null;
          })
        : Promise.resolve(null),
    ]);
    const ideas = (asks?.all ?? []).filter((ask) => Boolean(ask.idea));
    const rows = found.files.map((file) => file.parsed.row).filter((row): row is Row => row !== null);
    const prRefs = rows.flatMap((row) => strings(isRow(row.links) ? row.links.prs : []));
    const sessions = rows.flatMap((row) => strings(isRow(row.links) ? row.links.sessions : []));
    const lookups: Lookups = {
      today: localDay(new Date(now())),
      prStates: options.prs?.get(prRefs) ?? new Map(),
      agents: (await options.agents?.resolve(paseo, [...new Set(sessions)])) ?? new Map(),
      ideas: ideaCounts(ideas),
    };
    const initiatives = found.files.map((file) => ({
      ...initiativeOf(file.parsed, file.name, file.home, lookups),
      local: file.locals,
    }));
    return {
      controlRepo: found.controlRepo,
      today: lookups.today,
      initiatives: sortInitiatives(initiatives),
      ideas: [...ideas].sort(
        (a, b) =>
          Number(a.state !== "open") - Number(b.state !== "open") ||
          (b.answeredAt ?? "").localeCompare(a.answeredAt ?? "") ||
          a.ledger.localeCompare(b.ledger) ||
          a.id.localeCompare(b.id, undefined, { numeric: true }),
      ),
      warnings: [...found.warnings, ...(asks?.warnings ?? [])].filter(
        (warning, at, all) => all.indexOf(warning) === at,
      ),
    };
  };

  return {
    view,
    /** The stale or overdue initiatives, for Needs you: no PR or agent lookups. */
    async notices(): Promise<InitiativeNotice[]> {
      const found = await scanned();
      const today = localDay(new Date(now()));
      const lookups: Lookups = { today, prStates: new Map(), agents: new Map(), ideas: new Map() };
      return found.files
        .map((file) => initiativeNotice(initiativeOf(file.parsed, file.name, file.home, lookups)))
        .filter((notice): notice is InitiativeNotice => notice !== null);
    },
    /**
     * The initiatives whose review is due (stale: overdue, or parked and woken), as full records for
     * needs.list's review asks (B2): the same scan as notices(), with no PR or agent lookups.
     */
    async reviews(): Promise<Initiative[]> {
      const found = await scanned();
      const today = localDay(new Date(now()));
      const lookups: Lookups = { today, prStates: new Map(), agents: new Map(), ideas: new Map() };
      return found.files
        .map((file) => ({ ...initiativeOf(file.parsed, file.name, file.home, lookups), local: file.locals }))
        .filter((initiative) => initiative.stale !== null);
    },
    /** The record for one initiative, as the tab reads it (for a develop brief). */
    async one(id: string): Promise<Initiative | null> {
      const read = await view();
      return read.initiatives.find((initiative) => initiative.id === id) ?? null;
    },
    /** Drops the cache: the next read scans again. */
    invalidate(): void {
      cached = null;
    },
  };
}

export type WorkspaceInitiatives = ReturnType<typeof workspaceInitiatives>;
