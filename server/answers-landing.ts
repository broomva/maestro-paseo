// Landing the answers batch (BRO-2827; the control interface spec §5.2, "The
// answers batch"). An answer whose home is origin/main is committed on
// maestro/answers, in Maestro's answers worktree (server/control-home.ts).
// The loop lands that batch on each wake:
//   1. fetches origin/main, and stops when the answers worktree is not there,
//      is not this repo's on maestro/answers, or holds changes not committed;
//   2. counts the answers the branch records that main does not. None: every
//      one has landed (by Maestro's PR, squashed or not, by any other, or main
//      closed the ask itself, whose outcome wins), so the branch is brought
//      level with main and step 6 of the home rule reads main's copy; a PR of
//      Maestro's still open with nothing left in it is closed with a word. A
//      branch holding anything but ledger changes is never levelled;
//   3. otherwise merges origin/main into maestro/answers, a merge that never
//      rewrites what the branch holds. One that conflicts is aborted: the
//      batch is kept as it was, and the ledgers it conflicts in are named for
//      you, in Needs you. An answer to an ask whose home is main is refused
//      meanwhile (control-home.ts), so none is lost;
//   4. pushes the branch, and opens ONE PR for it on the repo's origin, or
//      updates the one open, titled as an answers batch.
// The PR is gated like any other: its checks and the merge gate decide.
// Maestro never merges it and never bypasses a gate. Every step's outcome is
// kept (`answers-landing.json` beside the receipts) for the wake log, Needs
// you and Decisions to read without asking git.

import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type AnswersLanding, AnswersLandingSchema, type AskRef, answersWord, type PrRef } from "../shared/answers";
import { canonical, parsed, type Row, rowsOf, stateOf, text } from "./control-asks";
import {
  ANSWERS_BRANCH,
  ASKS_DIR,
  catFiles,
  git,
  isAnswersWorktree,
  MAIN_REF,
  uncommitted,
  type WorkspaceAsks,
} from "./control-home";

/** The batch PR's title opens with this, so a person and Maestro alike know it for what it is. */
export const BATCH_TITLE = "answers:";

/** Where the PR is opened, and how it reads: the repo's own origin, through `gh`. */
export interface Forge {
  /** Maestro's open PR for the branch, or null. */
  openPr(cwd: string, branch: string): Promise<PrRef | null>;
  /** Whether a PR has merged, is still open, or was closed unmerged. */
  prState(cwd: string, number: number): Promise<"OPEN" | "MERGED" | "CLOSED" | null>;
  createPr(cwd: string, pr: { branch: string; base: string; title: string; body: string }): Promise<PrRef>;
  editPr(cwd: string, number: number, pr: { title: string; body: string }): Promise<void>;
  closePr(cwd: string, number: number, comment: string): Promise<void>;
}

export interface LandingOptions {
  asks: WorkspaceAsks;
  controlRepo: string;
  answersPath: string;
  /** Where the outcome is kept (answers-landing.json). */
  statePath: string;
  forge: Forge;
  now?: () => number;
  log?: (message: string) => void;
}

const BLANK = (at: string): AnswersLanding => ({
  stage: "none",
  pending: 0,
  asks: [],
  pr: null,
  conflict: null,
  error: null,
  landed: null,
  checkedAt: at,
});

/** The handle an entry goes by (§5.2): its uid, else its id. */
const handleOf = (row: Row): string | null => {
  const uid = text(row.uid);
  if (uid) return `u:${uid}`;
  const id = text(row.id);
  return id ? `i:${id}` : null;
};

/**
 * The answers one ledger's batch copy records and main's does not: each
 * entry answered (or otherwise closed) on the branch that main holds open.
 * One main no longer holds was removed there, and the removal stands. Pure.
 */
export function unlandedAnswers(ledger: string, batch: string, main: string | null): AskRef[] {
  const mainRows = main ? rowsOf(parsed(main)) : [];
  const onMain = new Map<string, Row>();
  for (const row of mainRows) {
    const handle = row ? handleOf(row) : null;
    if (row && handle && !onMain.has(handle)) onMain.set(handle, row);
  }
  const out: AskRef[] = [];
  for (const row of rowsOf(parsed(batch))) {
    const handle = row ? handleOf(row) : null;
    if (!row || !handle || stateOf(row) === "open") continue;
    const there = onMain.get(handle);
    // Main lacks it: main removed the ask (an answer is only ever written to an ask main held), and that stands.
    if (!there || stateOf(there) !== "open") continue;
    out.push({ ledger, uid: text(row.uid), id: text(row.id) ?? "" });
  }
  return out;
}

/** The keys an answer writes (control-asks.ts withAnswer, an idea's park its `wake`). */
const ANSWER_WRITES = new Set([
  "answer",
  "answered",
  "resolution",
  "outcome",
  "answer_option",
  "answered_at",
  "answered_by",
  "status",
  "wake",
]);

/** The handles of the entries a ledger records closed (answered, or otherwise): the ones an answer may have written. Pure. */
export function closedHandles(source: string): Set<string> {
  const closed = new Set<string>();
  for (const row of rowsOf(parsed(source))) {
    const handle = row ? handleOf(row) : null;
    if (row && handle && stateOf(row) !== "open") closed.add(handle);
  }
  return closed;
}

/**
 * A ledger with the keys an answer writes taken out of the entries `answered`
 * names, and only those: two that read alike here differ only in answers. An
 * open entry keeps every key, so an edit to its `status` still counts. Pure.
 */
export function withoutAnswers(source: string, answered: ReadonlySet<string>): string {
  const data = parsed(source);
  const rows = rowsOf(data).map((row) => {
    const handle = row ? handleOf(row) : null;
    if (!row || !handle || !answered.has(handle)) return row;
    return Object.fromEntries(Object.entries(row).filter(([key]) => !ANSWER_WRITES.has(key)));
  });
  const rest = Object.fromEntries(Object.entries(data).filter(([key]) => key !== "asks" && key !== "open_asks"));
  return JSON.stringify(canonical({ ...rest, asks: rows }));
}

/**
 * The answers one ledger's copy on origin's branch records that would be lost
 * by pushing over it: each answered entry whose handle `here` does not answer
 * the same (option and words) and `main` does not close. Pure.
 */
export function unkeptAnswers(ledger: string, theirs: string, here: string | null, main: string | null): AskRef[] {
  // Each answered entry of theirs that here does not answer the same, and main holds open.
  const index = (source: string | null) => {
    const map = new Map<string, Row>();
    for (const row of source ? rowsOf(parsed(source)) : []) {
      const handle = row ? handleOf(row) : null;
      if (row && handle && !map.has(handle)) map.set(handle, row);
    }
    return map;
  };
  const mine = index(here);
  const onMain = index(main);
  const out: AskRef[] = [];
  for (const row of rowsOf(parsed(theirs))) {
    const handle = row ? handleOf(row) : null;
    if (!row || !handle || stateOf(row) === "open") continue;
    const kept = mine.get(handle);
    if (
      kept &&
      stateOf(kept) !== "open" &&
      same(kept.answer_option, row.answer_option) &&
      same(kept.answer, row.answer)
    )
      continue;
    const closed = onMain.get(handle);
    if (!closed || stateOf(closed) !== "open") continue;
    out.push({ ledger, uid: text(row.uid), id: text(row.id) ?? "" });
  }
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a ?? null)) === JSON.stringify(canonical(b ?? null));

/** The batch PR's title and body: the asks it carries, by ledger and id, and how it lands. */
export function batchPr(asks: readonly AskRef[]): { title: string; body: string } {
  const title = `${BATCH_TITLE} ${answersWord(asks.length)} from Maestro wait to land`;
  const lines = asks.map((ask) => `- \`${ask.ledger}\` ${ask.id}${ask.uid ? ` (uid ${ask.uid})` : ""}`);
  const body = [
    `Your answers to ${answersWord(asks.length)} whose home is ${MAIN_REF}, from Maestro's answers batch (\`${ANSWERS_BRANCH}\`):`,
    "",
    ...lines,
    "",
    "Each was answered by you in Maestro's Decisions; the diff touches only those entries' answer keys.",
    "This PR lands through its checks and the merge gate like any other. Maestro keeps it current and never merges it.",
    "Once it lands, Maestro brings `maestro/answers` level with main and acts on each answer once.",
  ].join("\n");
  return { title, body };
}

/** A step that stopped for you: not transient, it stands until you settle it. `asks`: the answers still waiting. */
class Blocked extends Error {
  readonly asks: AskRef[];
  constructor(message: string, asks: AskRef[]) {
    super(message);
    this.asks = asks;
  }
}

export class AnswersLander {
  private readonly options: LandingOptions;
  private readonly now: () => number;
  private last: AnswersLanding | null = null;

  constructor(options: LandingOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** The batch as the last wake left it (kept on disk across restarts), or null before the first. */
  async state(): Promise<AnswersLanding | null> {
    if (this.last) return this.last;
    const raw = await readFile(this.options.statePath, "utf8").catch(() => null);
    if (raw === null) return null;
    try {
      this.last = AnswersLandingSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
    return this.last;
  }

  /** One landing step (the header above). Never throws: what failed is in the state it returns. */
  async land(): Promise<AnswersLanding> {
    const at = new Date(this.now()).toISOString();
    const before = await this.state();
    let next: AnswersLanding;
    try {
      next = await this.step(at, before);
    } catch (error) {
      const message = (error as Error).message;
      this.options.log?.(`answers: landing the batch: ${message}`);
      // Stopped for you: what still waits, counted now. Failed (a fetch, gh): the last count stands.
      next =
        error instanceof Blocked
          ? {
              ...(before ?? BLANK(at)),
              stage: "blocked",
              pending: error.asks.length,
              asks: error.asks,
              error: message,
              conflict: null,
              checkedAt: at,
            }
          : { ...(before ?? BLANK(at)), stage: "failed", error: message, conflict: null, checkedAt: at };
    }
    await this.save(next);
    return next;
  }

  private async step(at: string, before: AnswersLanding | null): Promise<AnswersLanding> {
    const { asks, controlRepo: repo, answersPath: path, forge } = this.options;
    // A merged PR of Maestro's is remembered as landed, whatever else this step finds.
    let landed = before?.landed ?? null;
    if (before?.pr) {
      const state = await forge.prState(path, before.pr.number).catch(() => null);
      if (state === "MERGED") landed = { pr: before.pr, at };
    }
    const fetched = await asks.fetchMain();
    if (fetched)
      throw new Error(`${MAIN_REF} could not be fetched (${fetched}), so the batch was not compared with it`);
    const outcome = await asks.exclusive(async () => {
      if (!(await isAnswersWorktree(repo, path))) return null;
      const dirty = await uncommitted(path);
      if (dirty.length > 0) {
        throw new Error(
          `the answers worktree has changes not committed (${dirty.join(", ")}); commit or discard them in ${path}`,
        );
      }
      const mainSha = (await git(repo, ["rev-parse", "--verify", "--quiet", `${MAIN_REF}^{commit}`])).trim();
      const waiting = await this.unlanded(path, mainSha);
      // Every answer the batch records is on main (Maestro's PR merged, squashed or not, or main closed the ask
      // itself, whose outcome wins, §5.2 step 1): level the branch with main.
      if (waiting.length === 0) return this.level(path, mainSha);
      const current = await git(path, ["merge-base", "--is-ancestor", mainSha, "HEAD"]).then(
        () => true,
        () => false,
      );
      if (!current) {
        const conflicted = await git(
          path,
          ["merge", "--quiet", "--no-edit", "-m", `Merge ${MAIN_REF} into ${ANSWERS_BRANCH}`, mainSha],
          60_000,
        ).then(
          () => null,
          async () => {
            const files = (await git(path, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ""))
              .split("\n")
              .filter(Boolean)
              .map((file) => file.split("/").pop() ?? file);
            // The batch is kept as it was: the merge is aborted, never resolved for you.
            await git(path, ["merge", "--abort"]);
            return files;
          },
        );
        if (conflicted) return { kind: "conflict" as const, ledgers: conflicted, refs: waiting };
      }
      const refs = await this.unlanded(path, mainSha);
      // The merge can leave none (main closed or dropped the last of them meanwhile): level, never an empty PR.
      if (refs.length === 0) return this.level(path, mainSha);
      // Pushed from inside the queue: no answer commits between the count and the push.
      await this.push(path, mainSha);
      return { kind: "pending" as const, refs };
    });
    if (!outcome) return { ...BLANK(at), landed };
    if (outcome.kind === "conflict") {
      const open = await forge.openPr(path, ANSWERS_BRANCH).catch(() => before?.pr ?? null);
      return {
        stage: "conflict",
        pending: outcome.refs.length,
        asks: outcome.refs,
        pr: open,
        conflict: { ledgers: outcome.ledgers, path },
        error: null,
        landed,
        checkedAt: at,
      };
    }
    if (outcome.kind === "level") {
      const open = await forge.openPr(path, ANSWERS_BRANCH);
      if (open) {
        await forge.closePr(
          path,
          open.number,
          `Everything in this batch is on ${MAIN_REF} now, so it has nothing left to land. Maestro brought ${ANSWERS_BRANCH} level with main.`,
        );
        if (!landed || landed.pr?.number !== open.number) landed = { pr: null, at };
      }
      await this.pushLevel(path, outcome.mainSha);
      return { ...BLANK(at), landed };
    }
    const pr = batchPr(outcome.refs);
    const open = await forge.openPr(path, ANSWERS_BRANCH);
    let ref: PrRef;
    if (open) {
      await forge.editPr(path, open.number, pr);
      ref = open;
    } else {
      ref = await forge.createPr(path, { branch: ANSWERS_BRANCH, base: "main", ...pr });
      this.options.log?.(`answers: opened PR #${ref.number} for ${answersWord(outcome.refs.length)}`);
    }
    return {
      stage: "waiting",
      pending: outcome.refs.length,
      asks: outcome.refs,
      pr: ref,
      conflict: null,
      error: null,
      landed,
      checkedAt: at,
    };
  }

  /**
   * The branch brought level with main, once every answer it records is
   * there. Only answers live on it: a file outside the ledgers, or a ledger
   * the branch changed in anything but the keys an answer writes (a new ask, a
   * reworded one, an edit made while settling a conflict by hand), is refused
   * in words, never dropped. Run inside the answers' queue.
   */
  private async level(path: string, mainSha: string): Promise<{ kind: "level"; mainSha: string }> {
    const base = (await git(path, ["merge-base", mainSha, "HEAD"])).trim();
    const own = (await git(path, ["diff", "--name-only", base, "HEAD"])).split("\n").filter(Boolean);
    // What the branch changed that neither its merge-base nor main holds as it does, answers aside, would be lost.
    const foreign = await this.stray(path, "HEAD", own, [base, mainSha]);
    if (foreign.length > 0) {
      throw new Blocked(
        `${ANSWERS_BRANCH} holds changes that are not answers (${foreign.join(", ")}), so it was not brought level with main; land or remove them in ${path}`,
        [],
      );
    }
    const head = (await git(path, ["rev-parse", "HEAD"])).trim();
    if (head !== mainSha) await git(path, ["reset", "--quiet", "--hard", mainSha]);
    return { kind: "level", mainSha };
  }

  /**
   * Of `files`, those whose copy at `rev` no copy in `against` holds, answers
   * aside: a ledger that differs from each only in the keys answers wrote in
   * the entries `rev` closes is held; any other file must match one exactly,
   * and one `rev` lacks must be missing from one too.
   */
  private async stray(
    path: string,
    rev: string,
    files: readonly string[],
    against: readonly string[],
  ): Promise<string[]> {
    const revs = [rev, ...against];
    const blobs = await catFiles(
      path,
      files.flatMap((file) => revs.map((at) => `${at}:${file}`)),
    );
    return files.filter((file) => {
      const mine = blobs.get(`${rev}:${file}`) ?? null;
      const others = against.map((at) => blobs.get(`${at}:${file}`) ?? null);
      if (!mine) return !others.some((other) => other === null);
      if (others.some((other) => other?.equals(mine))) return false;
      if (!file.startsWith(`${ASKS_DIR}/`)) return true;
      try {
        // The entries `rev` closes are where an answer was written; in them alone the answer's keys may differ.
        const answered = closedHandles(mine.toString("utf8"));
        const held = withoutAnswers(mine.toString("utf8"), answered);
        return !others.some((other) => other !== null && withoutAnswers(other.toString("utf8"), answered) === held);
      } catch {
        return true;
      }
    });
  }

  /** The answers HEAD records that main does not, over the ledgers the two hold differently. */
  private async unlanded(path: string, mainSha: string, rev = "HEAD"): Promise<AskRef[]> {
    const changed = (await git(path, ["diff", "--name-only", mainSha, rev, "--", `${ASKS_DIR}/`]))
      .split("\n")
      .filter(Boolean);
    const blobs = await catFiles(
      path,
      changed.flatMap((file) => [`${rev}:${file}`, `${mainSha}:${file}`]),
    );
    return changed.flatMap((file) => {
      const mine = blobs.get(`${rev}:${file}`);
      if (!mine) return [];
      const theirs = blobs.get(`${mainSha}:${file}`);
      const name = file.split("/").pop() ?? file;
      try {
        return unlandedAnswers(name, mine.toString("utf8"), theirs ? theirs.toString("utf8") : null);
      } catch (error) {
        throw new Error(`${name} on ${ANSWERS_BRANCH} could not be read (${(error as Error).message})`);
      }
    });
  }

  /** The answers `rev` records that neither `head` records the same nor `mainSha` closes. */
  private async unkept(path: string, rev: string, head: string, mainSha: string): Promise<AskRef[]> {
    const changed = (await git(path, ["diff", "--name-only", head, rev, "--", `${ASKS_DIR}/`]))
      .split("\n")
      .filter(Boolean);
    const blobs = await catFiles(
      path,
      changed.flatMap((file) => [`${rev}:${file}`, `${head}:${file}`, `${mainSha}:${file}`]),
    );
    const textOf = (spec: string) => blobs.get(spec)?.toString("utf8") ?? null;
    return changed.flatMap((file) => {
      const theirs = textOf(`${rev}:${file}`);
      if (theirs === null) return [];
      const name = file.split("/").pop() ?? file;
      return unkeptAnswers(name, theirs, textOf(`${head}:${file}`), textOf(`${mainSha}:${file}`));
    });
  }

  /**
   * The branch pushed to origin, when origin's differs. Origin's own batch is
   * fetched and judged first: the push is a fast-forward of it, or goes over a
   * batch whose every answer main records already (one that landed). Origin
   * holding an answer this batch lacks and main does not record (another
   * daemon's, a hand push) is never pushed over: the step fails and says so.
   * The lease pins the push to the very commit judged.
   */
  private async push(path: string, mainSha: string): Promise<void> {
    const head = (await git(path, ["rev-parse", "HEAD"])).trim();
    const remote =
      (await git(path, ["ls-remote", "origin", `refs/heads/${ANSWERS_BRANCH}`], 60_000)).split(/\s/)[0] ?? "";
    if (remote === head) return;
    if (remote) {
      await git(path, ["fetch", "--quiet", "origin", `refs/heads/${ANSWERS_BRANCH}`], 60_000);
      const behind = await git(path, ["merge-base", "--is-ancestor", remote, "HEAD"]).then(
        () => true,
        () => false,
      );
      if (!behind) {
        // Not a fast-forward (GitHub's Update branch, an old batch that landed, another's push): only over a
        // batch every answer of which this one records the same, or main closed.
        const theirs = await this.unkept(path, remote, head, mainSha);
        const changed = (await git(path, ["diff", "--name-only", head, remote])).split("\n").filter(Boolean);
        // Held where it came from main (their merge-base: main's edits since, a removal included, stand) or is here.
        const from = (await git(path, ["merge-base", remote, mainSha]).catch(() => "")).trim();
        const stray = await this.stray(path, remote, changed, from ? [head, mainSha, from] : [head, mainSha]);
        if (stray.length > 0 && theirs.length === 0) {
          throw new Blocked(
            `origin's ${ANSWERS_BRANCH} (${remote.slice(0, 9)}) holds changes that are not answers and neither this batch nor main holds (${stray.join(", ")}); Maestro never pushes over them. Merge it into ${path}, or remove them on origin`,
            await this.unlanded(path, mainSha),
          );
        }
        if (theirs.length > 0) {
          throw new Blocked(
            `origin's ${ANSWERS_BRANCH} (${remote.slice(0, 9)}) holds ${answersWord(theirs.length)} this batch does not record and main does not close (${theirs.map((ask) => `${ask.ledger} ${ask.id}`).join(", ")}); Maestro never pushes over them. Merge it into ${path}, or remove it on origin`,
            await this.unlanded(path, mainSha),
          );
        }
      }
    }
    await git(
      path,
      [
        "push",
        "--quiet",
        `--force-with-lease=refs/heads/${ANSWERS_BRANCH}:${remote}`,
        "origin",
        `HEAD:refs/heads/${ANSWERS_BRANCH}`,
      ],
      180_000,
    );
  }

  /** A level branch on origin too, when origin still holds the old batch: nothing on it is lost, all of it is on main. */
  private async pushLevel(path: string, mainSha: string): Promise<void> {
    const remote = (await git(path, ["ls-remote", "origin", `refs/heads/${ANSWERS_BRANCH}`], 60_000)).split(/\s/)[0];
    if (!remote || remote === mainSha) return;
    await this.options.asks.exclusive(() => this.push(path, mainSha));
  }

  private async save(state: AnswersLanding): Promise<void> {
    this.last = state;
    const file = this.options.statePath;
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.tmp-${process.pid}`;
      await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temp, file);
    } catch (error) {
      this.options.log?.(`answers: keeping the landing state: ${(error as Error).message}`);
    }
  }
}

/** `gh`, run in the answers worktree: it finds the repo from the worktree's origin. */
export function ghForge(run: (cwd: string, args: readonly string[]) => Promise<string> = gh): Forge {
  return {
    async openPr(cwd, branch) {
      const out = await run(cwd, [
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "open",
        "--json",
        "number,url,title",
        "--limit",
        "10",
      ]);
      const list = JSON.parse(out || "[]") as { number: number; url: string; title: string }[];
      const mine = list.find((pr) => pr.title.startsWith(BATCH_TITLE)) ?? list[0];
      return mine ? { number: mine.number, url: mine.url } : null;
    },
    async prState(cwd, number) {
      const out = await run(cwd, ["pr", "view", String(number), "--json", "state"]);
      const state = (JSON.parse(out || "{}") as { state?: string }).state;
      return state === "OPEN" || state === "MERGED" || state === "CLOSED" ? state : null;
    },
    async createPr(cwd, pr) {
      const out = await run(cwd, [
        "pr",
        "create",
        "--head",
        pr.branch,
        "--base",
        pr.base,
        "--title",
        pr.title,
        "--body",
        pr.body,
      ]);
      const url = out.trim().split("\n").pop() ?? "";
      const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
      if (!Number.isInteger(number)) throw new Error(`gh pr create said no PR: ${url || "nothing"}`);
      return { number, url };
    },
    async editPr(cwd, number, pr) {
      await run(cwd, ["pr", "edit", String(number), "--title", pr.title, "--body", pr.body]);
    },
    async closePr(cwd, number, comment) {
      await run(cwd, ["pr", "close", String(number), "--comment", comment]);
    },
  };
}

function gh(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      [...args],
      { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1" } },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`gh ${args.slice(0, 2).join(" ")}: ${(stderr || error.message).trim()}`));
        else resolve(stdout);
      },
    );
  });
}
