// Landing the answers batch (BRO-2827; the control interface spec §5.2, "The
// answers batch"). An answer whose home is origin/main is committed on
// maestro/answers, in Maestro's answers worktree (server/control-home.ts).
// The loop lands that batch on each wake, deciding nothing from what is
// missing: it merges, and stops for you where a merge or a difference cannot
// be settled without a person.
//   1. fetches origin/main, and stops when the answers worktree is not there,
//      is not this repo's on maestro/answers, or holds changes not committed;
//   2. merges origin's own maestro/answers in first (another daemon's push,
//      GitHub's Update branch), then origin/main: merges that never rewrite
//      what the branch holds, so every push after is a fast-forward. One that
//      conflicts is aborted: the batch is kept as it was, and Needs you names
//      the ledgers. An answer to an ask whose home is main is refused
//      meanwhile (control-home.ts), so none is lost;
//   3. levels the branch when its tree is main's (every answer on it has
//      landed, squashed or not), resetting it to main only while that is
//      still a fast-forward for origin, and closes a PR of Maestro's left
//      with nothing in it, with a word;
//   4. otherwise counts the answers the branch records that main holds open
//      or lacks, pushes, and opens ONE PR for it on the repo's origin, or
//      updates the one open, titled as an answers batch. A branch that differs
//      from main yet records no such answer is a stop for you, never dropped.
// The PR is gated like any other: its checks and the merge gate decide.
// Maestro never merges it and never bypasses a gate. Every step's outcome is
// kept (`answers-landing.json` beside the receipts) for the wake log, Needs
// you and Decisions to read without asking git.

import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type AnswersLanding, AnswersLandingSchema, type AskRef, answersWord, type PrRef } from "../shared/answers";
import { parsed, type Row, rowsOf, stateOf, text } from "./control-asks";
import {
  ANSWERS_BRANCH,
  ASKS_DIR,
  catFiles,
  git,
  isAnswersWorktree,
  MAIN_REF,
  mergeInto,
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

/** A ledger's file name, from its repo-relative path. */
const ledgerName = (file: string) => file.split("/").pop() ?? file;

/** The handle an entry goes by (§5.2): its uid, else its id. */
const handleOf = (row: Row): string | null => {
  const uid = text(row.uid);
  if (uid) return `u:${uid}`;
  const id = text(row.id);
  return id ? `i:${id}` : null;
};

/**
 * The answers one ledger's batch copy records and main's does not: each
 * entry answered (or otherwise closed) on the branch that main holds open, or
 * does not hold by its handle at all. Nothing is read from what main lacks:
 * such an answer still waits, and a merge says what became of its ask. Pure.
 */
export function unlandedAnswers(ledger: string, batch: string, main: string | null): AskRef[] {
  const onMain = new Map<string, Row>();
  for (const row of main ? rowsOf(parsed(main)) : []) {
    const handle = row ? handleOf(row) : null;
    if (row && handle && !onMain.has(handle)) onMain.set(handle, row);
  }
  const out: AskRef[] = [];
  for (const row of rowsOf(parsed(batch))) {
    const handle = row ? handleOf(row) : null;
    if (!row || !handle || stateOf(row) === "open") continue;
    const there = onMain.get(handle);
    if (there && stateOf(there) !== "open") continue;
    out.push({ ledger, uid: text(row.uid), id: text(row.id) ?? "" });
  }
  return out;
}

/** The batch PR's title and body: the asks it carries, by ledger and id, and how it lands. */
export function batchPr(asks: readonly AskRef[]): { title: string; body: string } {
  const title = `${BATCH_TITLE} ${answersWord(asks.length)} from Maestro wait to land`;
  const lines = asks.map((ask) => `- \`${ask.ledger}\` ${ask.id}${ask.uid ? ` (uid ${ask.uid})` : ""}`);
  const body = [
    `Your answers to ${answersWord(asks.length)} whose home is ${MAIN_REF}, from Maestro's answers batch (\`${ANSWERS_BRANCH}\`):`,
    "",
    ...lines,
    "",
    "Each was answered by you in Maestro's Decisions.",
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
      // Origin's own batch first: what another pushed there is merged in, never pushed over.
      const remote = await this.remoteHead(path);
      if (remote && !(await this.has(path, remote))) {
        await git(path, ["fetch", "--quiet", "origin", `refs/heads/${ANSWERS_BRANCH}`], 60_000);
        const conflicted = await mergeInto(path, remote, `Merge origin's ${ANSWERS_BRANCH}`);
        if (conflicted) {
          const refs = await this.unlanded(path, mainSha);
          return {
            kind: "conflict" as const,
            ledgers: conflicted.map(ledgerName),
            with: `origin's ${ANSWERS_BRANCH}`,
            refs,
          };
        }
      }
      if (!(await this.has(path, mainSha))) {
        const conflicted = await mergeInto(path, mainSha, `Merge ${MAIN_REF} into ${ANSWERS_BRANCH}`);
        if (conflicted) {
          const refs = await this.unlanded(path, mainSha);
          return { kind: "conflict" as const, ledgers: conflicted.map(ledgerName), with: MAIN_REF, refs };
        }
      }
      const [tree, mainTree] = await Promise.all([
        git(path, ["rev-parse", "HEAD^{tree}"]),
        git(path, ["rev-parse", `${mainSha}^{tree}`]),
      ]);
      if (tree.trim() === mainTree.trim()) {
        // Level: the branch holds nothing main does not. To main itself while origin's batch is part of main.
        const head = (await git(path, ["rev-parse", "HEAD"])).trim();
        const behindMain = !remote || (await this.isAncestor(path, remote, mainSha));
        if (head !== mainSha && behindMain) await git(path, ["reset", "--quiet", "--hard", mainSha]);
        await this.push(path);
        return { kind: "level" as const };
      }
      const refs = await this.unlanded(path, mainSha);
      if (refs.length === 0) {
        const files = (await git(path, ["diff", "--name-only", mainSha, "HEAD"])).split("\n").filter(Boolean);
        throw new Blocked(
          `${ANSWERS_BRANCH} differs from main (${files.join(", ")}) but records no answer main lacks, so Maestro neither lands nor drops it; settle it in ${path}`,
          [],
        );
      }
      // Pushed from inside the queue: no answer commits between the count and the push.
      await this.push(path);
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
        conflict: { ledgers: outcome.ledgers, path, with: outcome.with },
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
          `Nothing in this batch waits to land any more: ${ANSWERS_BRANCH} holds nothing ${MAIN_REF} does not. Maestro brought it level with main.`,
        );
        if (!landed || landed.pr?.number !== open.number) landed = { pr: null, at };
      }
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

  /** Whether the branch already holds `rev`. */
  private has(path: string, rev: string): Promise<boolean> {
    return this.isAncestor(path, rev, "HEAD");
  }

  private isAncestor(path: string, rev: string, of: string): Promise<boolean> {
    return git(path, ["merge-base", "--is-ancestor", rev, of]).then(
      () => true,
      () => false,
    );
  }

  /** Origin's maestro/answers as it is now, or null when origin has none. */
  private async remoteHead(path: string): Promise<string | null> {
    const listed = await git(path, ["ls-remote", "origin", `refs/heads/${ANSWERS_BRANCH}`], 60_000);
    return listed.split(/\s/)[0] || null;
  }

  /**
   * The branch pushed to origin, when origin's differs. Never forced: origin's
   * batch was merged in first, so this is a fast-forward, and git refuses any
   * other (one pushed meanwhile waits for the next wake to merge it).
   */
  private async push(path: string): Promise<void> {
    const [head, remote] = await Promise.all([git(path, ["rev-parse", "HEAD"]), this.remoteHead(path)]);
    if (remote === head.trim()) return;
    await git(path, ["push", "--quiet", "origin", `HEAD:refs/heads/${ANSWERS_BRANCH}`], 180_000);
  }

  /** The answers HEAD records that main does not, over the ledgers the two hold differently. */
  private async unlanded(path: string, mainSha: string): Promise<AskRef[]> {
    const changed = (await git(path, ["diff", "--name-only", mainSha, "HEAD", "--", `${ASKS_DIR}/`]))
      .split("\n")
      .filter(Boolean);
    const blobs = await catFiles(
      path,
      changed.flatMap((file) => [`HEAD:${file}`, `${mainSha}:${file}`]),
    );
    return changed.flatMap((file) => {
      const mine = blobs.get(`HEAD:${file}`);
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
