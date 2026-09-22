// The work store: folders under the work root, each holding `_work.md` (the
// contract, the source of truth for state) and `_events.jsonl` (the receipts).
// Every mutation of one item runs under that item's lock, re-reads the files,
// validates the transition, writes the contract, then appends the events.

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { type GateMode, type Kind, type OrchState, type TransitionContext, transition } from "../shared/states";
import { parseEvents, type WorkEvent } from "./events";
import {
  type Contract,
  newWorkSource,
  parseWorkDoc,
  readContract,
  renderWorkDoc,
  setFields,
  titleOf,
  type WorkDoc,
} from "./frontmatter";

export const WORK_FILE = "_work.md";
export const EVENTS_FILE = "_events.jsonl";
const MAX_DEPTH = 5;

export interface StoredWork {
  dir: string;
  rel: string;
  work: WorkDoc;
  contract: Contract;
  title: string;
  events: WorkEvent[];
  /** Lines of `_events.jsonl` that did not parse; surfaced as a warning, never dropped quietly. */
  badLines: number;
  mtime: string;
}

export class WorkNotFoundError extends Error {
  constructor(id: string) {
    super(`No work item with id ${id}`);
    this.name = "WorkNotFoundError";
  }
}

const locks = new Map<string, Promise<unknown>>();

/** Serialize work on one item: hooks and RPCs can race on the same files. */
export async function withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 48)
      .replace(/-$/, "") || "work"
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function endsWithNewline(path: string): Promise<boolean> {
  let handle: import("node:fs/promises").FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    if (size === 0) return true;
    const byte = Buffer.alloc(1);
    await handle.read(byte, 0, 1, size - 1);
    return byte[0] === 0x0a;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

export interface Mutation {
  /** When the change happened, if not now: a recovered event keeps the time it really occurred. */
  at?: string;
  to?: OrchState;
  reason?: string | null;
  actor?: WorkEvent["actor"];
  ctx?: Omit<TransitionContext, "gate">;
  patch?: Record<string, unknown>;
  events?: WorkEvent[];
}

export class WorkStore {
  constructor(
    readonly root: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async load(dir: string): Promise<StoredWork> {
    const source = await readFile(join(dir, WORK_FILE), "utf8");
    const work = parseWorkDoc(source);
    const contract = readContract(work);
    let events: WorkEvent[] = [];
    let badLines = 0;
    try {
      ({ events, bad: badLines } = parseEvents(await readFile(join(dir, EVENTS_FILE), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const info = await stat(join(dir, WORK_FILE));
    return {
      dir,
      rel: relative(this.root, dir),
      work,
      contract,
      title: titleOf(work.body, basename(dir)),
      events,
      badLines,
      mtime: info.mtime.toISOString(),
    };
  }

  /** Every `_work.md` below the root. A broken file is a warning, never a silent drop. */
  async scan(): Promise<{ items: StoredWork[]; warnings: string[] }> {
    const items: StoredWork[] = [];
    const warnings: string[] = [];
    const visit = async (dir: string, depth: number): Promise<void> => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (depth === 0 && (error as NodeJS.ErrnoException).code === "ENOENT") return;
        warnings.push(`Could not read ${dir}: ${(error as Error).message}`);
        return;
      }
      if (depth > 0 && entries.some((entry) => entry.isFile() && entry.name === WORK_FILE)) {
        try {
          const item = await this.load(dir);
          items.push(item);
          if (item.badLines > 0) {
            warnings.push(`${item.rel}/${EVENTS_FILE}: ${item.badLines} unreadable line(s) skipped`);
          }
        } catch (error) {
          warnings.push(`${relative(this.root, dir) || dir}/${WORK_FILE}: ${(error as Error).message}`);
        }
      }
      if (depth >= MAX_DEPTH) return;
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
        await visit(join(dir, entry.name), depth + 1);
      }
    };
    await visit(this.root, 0);
    const seen = new Map<string, string>();
    for (const item of items) {
      const other = seen.get(item.contract.id);
      if (other) warnings.push(`${item.rel} repeats the id of ${other}; the first one wins`);
      else seen.set(item.contract.id, item.rel);
    }
    return { items: items.filter((item) => seen.get(item.contract.id) === item.rel), warnings };
  }

  async findById(id: string): Promise<StoredWork> {
    const { items } = await this.scan();
    const found = items.find((item) => item.contract.id === id);
    if (!found) throw new WorkNotFoundError(id);
    return found;
  }

  /** Re-read one item: from its known folder when it still holds that id, otherwise by scanning. */
  async fresh(id: string, dir?: string): Promise<StoredWork> {
    if (dir) {
      const item = await this.load(dir).catch(() => null);
      if (item?.contract.id === id) return item;
    }
    return this.findById(id);
  }

  async create(input: {
    title: string;
    brief: string;
    repo: string | null;
    gate: GateMode;
    check: string;
    initiative: string;
    kind?: Kind;
    state?: OrchState;
    now?: Date;
  }): Promise<StoredWork> {
    const now = input.now ?? this.now();
    const parent = input.initiative.trim() ? join(this.root, slugify(input.initiative)) : this.root;
    await mkdir(parent, { recursive: true });
    const base = slugify(input.title);
    let dir = join(parent, base);
    for (let n = 2; await exists(dir); n += 1) dir = join(parent, `${base}-${n}`);
    await mkdir(dir);
    const id = randomUUID();
    await writeFile(
      join(dir, WORK_FILE),
      newWorkSource({
        id,
        title: input.title.trim(),
        brief: input.brief,
        kind: input.kind ?? "task",
        state: input.state ?? "proposed",
        gate: input.gate,
        repo: input.repo,
        check: input.check,
        date: now.toISOString().slice(0, 10),
      }),
      "utf8",
    );
    await this.append(dir, [{ ts: now.toISOString(), type: "created", actor: "human" }]);
    return this.load(dir);
  }

  async append(dir: string, events: readonly WorkEvent[]): Promise<void> {
    if (events.length === 0) return;
    const path = join(dir, EVENTS_FILE);
    const lines = events.map((event) => `${JSON.stringify(event)}\n`).join("");
    // A torn last line (a crash mid-write) must not swallow the next event.
    const lead = (await endsWithNewline(path)) ? "" : "\n";
    await appendFile(path, lead + lines, "utf8");
  }

  /**
   * Apply one change to one item under its lock. `decide` sees the freshly
   * read item and returns the mutation, or null to leave it alone.
   */
  async mutate(
    id: string,
    decide: (item: StoredWork) => Mutation | null | Promise<Mutation | null>,
    dir?: string,
  ): Promise<StoredWork> {
    return withLock(id, async () => {
      const item = await this.fresh(id, dir);
      const change = await decide(item);
      if (!change) return item;
      const events = [...(change.events ?? [])];
      const patch: Record<string, unknown> = { ...(change.patch ?? {}) };
      const at = this.now();
      if (change.to && change.to !== item.contract.state) {
        transition(item.contract.state, change.to, { gate: item.contract.gate, ...(change.ctx ?? {}) });
        patch.state = change.to;
        events.push({
          ts: change.at ?? at.toISOString(),
          type: "state",
          actor: change.actor ?? "maestro",
          from: item.contract.state,
          to: change.to,
          reason: change.reason ?? null,
        });
      }
      if (Object.keys(patch).length > 0) {
        patch.updated = at.toISOString().slice(0, 10);
        setFields(item.work, patch);
        await writeAtomic(join(item.dir, WORK_FILE), renderWorkDoc(item.work));
      }
      await this.append(item.dir, events);
      return this.load(item.dir);
    });
  }
}

/** Initiative and project come from the folder nesting, the Maestro work tree. */
export function placement(rel: string): { initiative: string | null; project: string | null } {
  const parts = rel.split(sep).filter(Boolean);
  if (parts.length >= 3) return { initiative: parts[0] ?? null, project: parts[parts.length - 2] ?? null };
  if (parts.length === 2) return { initiative: parts[0] ?? null, project: null };
  return { initiative: null, project: null };
}
