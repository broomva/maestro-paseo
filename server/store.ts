// The work store: folders under the work root, each holding `_work.md` (the
// contract, the source of truth for state) and `_events.jsonl` (the receipts).
// The one writer of both (BRO-2997). Every mutation of one item runs under that
// item's lock, which is a file lock in `<work root>/.locks` (server/locks.ts), so a
// second daemon on the same root waits its turn. Under it the files are re-read, the
// transition validated, the contract replaced through a temp file and a rename
// (server/atomic.ts), and the events appended whole.

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { type GateMode, type Kind, type OrchState, type TransitionContext, transition } from "../shared/states";
import { writeFileAtomic } from "./atomic";
import { BY_HUMAN, type Origin, parseEvents, type WorkEvent } from "./events";
import {
  type Contract,
  newWorkSource,
  parseWorkDoc,
  type RunKeys,
  readContract,
  renderWorkDoc,
  setFields,
  titleOf,
  type WorkDoc,
} from "./frontmatter";
import { appendLinesLocked } from "./jsonl";
import { awaitUnlocked, withFileLock } from "./locks";
import { workLockRoot } from "./paths";

export const WORK_FILE = "_work.md";
export const EVENTS_FILE = "_events.jsonl";
const MAX_DEPTH = 5;
/** A change waits this long for another writer of the same item (a claim under daemon calls can hold it a while). */
const LOCK_WAIT_MS = 20_000;

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

export interface Mutation {
  /** Record the state change before `events` rather than after them. */
  stateFirst?: boolean;
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

  /** Where this root's item locks are taken: one per item id, shared by every process on the root. */
  private get lockRoot(): string {
    return workLockRoot(this.root);
  }

  /** Serialize work on one item: hooks, RPCs and a second daemon can race on the same files. */
  withLock<T>(id: string, run: () => Promise<T>): Promise<T> {
    return withFileLock(join(this.lockRoot, id), this.lockRoot, run, { waitMs: LOCK_WAIT_MS, what: `work item ${id}` });
  }

  /**
   * One item as it stands once any change to it in flight, in this process or another, has finished. A change
   * replaces `_work.md` and then appends to `_events.jsonl`; a read in between would pair the new state with the
   * old receipts.
   */
  async load(dir: string): Promise<StoredWork> {
    const first = await this.read(dir);
    await awaitUnlocked(join(this.lockRoot, first.contract.id), this.lockRoot).catch(() => undefined);
    return this.read(dir);
  }

  /** One item exactly as the files are now. Only for code already holding the item's lock. */
  private async read(dir: string): Promise<StoredWork> {
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
  async scan(options: { raw?: boolean } = {}): Promise<{ items: StoredWork[]; warnings: string[] }> {
    const loadOne = (dir: string) => (options.raw ? this.read(dir) : this.load(dir));
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
          const item = await loadOne(dir);
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

  async findById(id: string, options: { raw?: boolean } = {}): Promise<StoredWork> {
    const { items } = await this.scan(options);
    const found = items.find((item) => item.contract.id === id);
    if (!found) throw new WorkNotFoundError(id);
    return found;
  }

  /**
   * Re-read one item from its known folder when it still holds that id, otherwise by scanning.
   * Raw: `mutate` calls it while holding the item's lock.
   */
  async fresh(id: string, dir?: string): Promise<StoredWork> {
    if (dir) {
      const item = await this.read(dir).catch(() => null);
      if (item?.contract.id === id) return item;
    }
    return this.findById(id, { raw: true });
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
    origin?: Origin;
    /** How its runs start; absent keys mean Settings at dispatch. */
    run?: RunKeys;
    /** Why only you start it (Contract.hold). */
    hold?: string;
    /** The idea it was filed for (Contract.idea). */
    idea?: string;
    /** The answer it was filed for (Contract.answer). */
    answer?: string;
  }): Promise<StoredWork> {
    const now = input.now ?? this.now();
    const parent = input.initiative.trim() ? join(this.root, slugify(input.initiative)) : this.root;
    await mkdir(parent, { recursive: true });
    const base = slugify(input.title);
    const id = randomUUID();
    // The folder is claimed by making it: of two writers (two daemons) filing one title, the second takes the next name.
    let dir = join(parent, base);
    for (let n = 2; ; n += 1) {
      try {
        await mkdir(dir);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        dir = join(parent, `${base}-${n}`);
      }
    }
    return this.withLock(id, async () => {
      await writeFileAtomic(
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
          run: input.run,
          hold: input.hold,
          idea: input.idea,
          answer: input.answer,
        }),
      );
      await this.appendLocked(dir, [{ ts: now.toISOString(), type: "created", ...(input.origin ?? BY_HUMAN) }]);
      return this.read(dir);
    });
  }

  /** Add receipts to one item's `_events.jsonl`, under the item's lock. */
  async append(dir: string, events: readonly WorkEvent[]): Promise<void> {
    if (events.length === 0) return;
    const { contract } = await this.read(dir);
    await this.withLock(contract.id, () => this.appendLocked(dir, events));
  }

  /** For code already holding the item's lock. A torn last line (a crash mid-write) never swallows the next event. */
  private appendLocked(dir: string, events: readonly WorkEvent[]): Promise<void> {
    return appendLinesLocked(join(dir, EVENTS_FILE), events);
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
    return this.withLock(id, async () => {
      const item = await this.fresh(id, dir);
      const change = await decide(item);
      if (!change) return item;
      const events = [...(change.events ?? [])];
      const patch: Record<string, unknown> = { ...(change.patch ?? {}) };
      const at = this.now();
      if (change.to && change.to !== item.contract.state) {
        transition(item.contract.state, change.to, { gate: item.contract.gate, ...(change.ctx ?? {}) });
        patch.state = change.to;
        const moved: WorkEvent = {
          ts: change.at ?? at.toISOString(),
          type: "state",
          actor: change.actor ?? "maestro",
          from: item.contract.state,
          to: change.to,
          reason: change.reason ?? null,
        };
        if (change.stateFirst) events.unshift(moved);
        else events.push(moved);
      }
      if (Object.keys(patch).length > 0) {
        patch.updated = at.toISOString().slice(0, 10);
        setFields(item.work, patch);
        await writeFileAtomic(join(item.dir, WORK_FILE), renderWorkDoc(item.work));
      }
      await this.appendLocked(item.dir, events);
      return this.read(item.dir);
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
