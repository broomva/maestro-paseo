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
import { parsed, type Row, rowsOf, stateOf, text } from "./control-asks";
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
 * entry answered (or otherwise closed) on the branch whose handle main lacks,
 * or holds open. Pure.
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
    "Each was answered by you in Maestro's Decisions; the diff touches only those entries' answer keys.",
    "This PR lands through its checks and the merge gate like any other. Maestro keeps it current and never merges it.",
    "Once it lands, Maestro brings `maestro/answers` level with main and acts on each answer once.",
  ].join("\n");
  return { title, body };
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
      next = {
        ...(before ?? BLANK(at)),
        stage: "failed",
        error: message,
        conflict: null,
        checkedAt: at,
      };
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
      if (waiting.length === 0) {
        // Every answer the batch records is on main (Maestro's PR merged, squashed or not, or main closed the
        // ask itself, whose outcome wins, §5.2 step 1): level the branch with main. Only answers live on it; a
        // change of any other kind there is refused, never dropped.
        const own = (await git(path, ["diff", "--name-only", `${mainSha}...HEAD`])).split("\n").filter(Boolean);
        const foreign = own.filter((file) => !file.startsWith(`${ASKS_DIR}/`));
        if (foreign.length > 0) {
          throw new Error(
            `${ANSWERS_BRANCH} holds changes that are not answers (${foreign.join(", ")}), so it was not brought level with main; remove them in ${path}`,
          );
        }
        const head = (await git(path, ["rev-parse", "HEAD"])).trim();
        if (head !== mainSha) await git(path, ["reset", "--quiet", "--hard", mainSha]);
        return { kind: "level" as const, mainSha };
      }
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

  /** The branch pushed to origin, when origin's differs: only ever over what origin held when last read. */
  private async push(path: string): Promise<void> {
    const head = (await git(path, ["rev-parse", "HEAD"])).trim();
    const remote = (await git(path, ["ls-remote", "origin", `refs/heads/${ANSWERS_BRANCH}`], 60_000)).split(/\s/)[0];
    if (remote === head) return;
    await git(
      path,
      [
        "push",
        "--quiet",
        `--force-with-lease=refs/heads/${ANSWERS_BRANCH}:${remote ?? ""}`,
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
    await this.options.asks.exclusive(() => this.push(path));
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
