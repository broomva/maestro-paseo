import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrRef } from "../shared/answers";
import { AnswerRouter } from "./answer-routes";
import { AnswersLander, BATCH_TITLE, batchPr, type Forge, unlandedAnswers } from "./answers-landing";
import { ANSWERS_BRANCH, WorkspaceAsks } from "./control-home";
import type { Paseo } from "./runs";

const LEDGER = "bro-9000-landing.yaml";
const entry = (id: string, extra = "") =>
  `  - id: ${id}
    headline: "Ship ${id}?"
    stakes: "Blocks ${id}."
    why_you: "Yours."
    options:
      - id: ship
        label: "Ship"
        consequence: "It ships."
        reversible: true
        recommended: true
      - id: hold
        label: "Hold"
        consequence: "Nothing changes."
        reversible: true
        status_quo: true
    default: hold
    blocking: false
    asked_at: 2026-10-06T10:00Z
${extra}`;
const TWO = `arc: bro-9000\nasks:\n${entry("A1")}${entry("A2")}`;

describe("which answers wait to land (pure)", () => {
  const answered = (id: string) =>
    entry(id, `    answer: "Ship"\n    answer_option: "ship"\n    answered_at: "2026-10-06T11:00:00Z"\n`);
  test("an answer the batch records and main holds open waits; one main records too, or an open one, does not", () => {
    const batch = `asks:\n${answered("A1")}${answered("A2")}${entry("A3")}`;
    const main = `asks:\n${entry("A1")}${answered("A2")}${entry("A3")}`;
    expect(unlandedAnswers(LEDGER, batch, main)).toEqual([{ ledger: LEDGER, uid: null, id: "A1" }]);
  });
  test("an id main still holds under a uid it stamped since is not removed: the answer waits", () => {
    const batch = `asks:\n${answered("A1")}`;
    expect(unlandedAnswers(LEDGER, batch, `asks:\n${entry("A1")}    uid: u-1\n`)).toEqual([
      { ledger: LEDGER, uid: null, id: "A1" },
    ]);
  });

  test("an answered ask main does not hold by its handle still waits: nothing is read from absence; a uid is the handle", () => {
    const batch = `asks:\n${answered("A1")}    uid: u-1\n`;
    expect(unlandedAnswers(LEDGER, batch, null)).toEqual([{ ledger: LEDGER, uid: "u-1", id: "A1" }]);
    expect(unlandedAnswers(LEDGER, batch, `asks:\n${entry("A1")}    uid: u-1\n`)).toEqual([
      { ledger: LEDGER, uid: "u-1", id: "A1" },
    ]);
    // main holds the same uid under another id, answered: landed.
    const main = `asks:\n${answered("B9")}    uid: u-1\n`;
    expect(unlandedAnswers(LEDGER, batch, main)).toEqual([]);
  });
  test("the PR names the batch and every ask in it", () => {
    const pr = batchPr([
      { ledger: LEDGER, uid: null, id: "A1" },
      { ledger: LEDGER, uid: "u-2", id: "A2" },
    ]);
    expect(pr.title).toBe(`${BATCH_TITLE} 2 answers from Maestro wait to land`);
    expect(pr.body).toContain("- `bro-9000-landing.yaml` A1\n- `bro-9000-landing.yaml` A2 (uid u-2)");
    expect(pr.body).toContain("never merges it");
  });
});

// ── In a scratch control repo, with a bare origin and a fake forge ───────────

const scratch: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
const ISOLATED = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"];
beforeAll(async () => {
  for (const key of ISOLATED) savedEnv[key] = process.env[key];
  const home = await mkdtemp(join(tmpdir(), "maestro-landing-git-"));
  scratch.push(home);
  const config = join(home, "gitconfig");
  await writeFile(
    config,
    "[user]\n\tname = Maestro Test\n\temail = maestro@example.invalid\n[init]\n\tdefaultBranch = main\n",
  );
  process.env.GIT_CONFIG_GLOBAL = config;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterAll(async () => {
  for (const key of ISOLATED) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: process.env }).trim();
/** A commit's tree: level means the branch's tree is main's, whatever its history. */
const treeOf = (cwd: string, rev: string) => run(cwd, "rev-parse", `${rev}^{tree}`);

/** A forge that remembers what it was asked, with PR states a test sets. */
function fakeForge() {
  const prs: { ref: PrRef; title: string; body: string; state: "OPEN" | "MERGED" | "CLOSED"; comment?: string }[] = [];
  const forge: Forge = {
    openPr: async () => prs.find((pr) => pr.state === "OPEN")?.ref ?? null,
    prState: async (_cwd, number) => prs.find((pr) => pr.ref.number === number)?.state ?? null,
    createPr: async (_cwd, pr) => {
      const ref = { number: 915 + prs.length, url: `https://example.invalid/pull/${915 + prs.length}` };
      prs.push({ ref, title: pr.title, body: pr.body, state: "OPEN" });
      return ref;
    },
    editPr: async (_cwd, number, pr) => {
      const found = prs.find((entry) => entry.ref.number === number);
      if (found) Object.assign(found, pr);
    },
    closePr: async (_cwd, number, comment) => {
      const found = prs.find((entry) => entry.ref.number === number);
      if (found) Object.assign(found, { state: "CLOSED", comment });
    },
  };
  return { forge, prs };
}

async function workspace() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "maestro-landing-")));
  scratch.push(root);
  const origin = join(root, "origin.git");
  const repo = join(root, "broomva");
  run(root, "init", "--quiet", "--bare", origin);
  run(root, "init", "--quiet", repo);
  await mkdir(join(repo, ".control", "asks"), { recursive: true });
  await writeFile(join(repo, ".control", "asks", LEDGER), TWO);
  run(repo, "add", ".");
  run(repo, "commit", "--quiet", "-m", "ledgers");
  run(repo, "remote", "add", "origin", origin);
  run(repo, "push", "--quiet", "origin", "main");
  run(repo, "fetch", "--quiet", "origin");
  // Someone else's clone, standing in for GitHub's merge of the PR and for main moving on.
  const other = join(root, "other");
  run(root, "clone", "--quiet", origin, other);
  const state = join(root, "state");
  const answersPath = join(state, "control-answers");
  // No remote fetch is needed of the asks: each test fetches by hand where main moved.
  const asks = new WorkspaceAsks({
    controlRepo: repo,
    answersPath,
    lockRoot: join(state, "locks"),
    receipts: join(state, "asks.jsonl"),
    fetch: false,
    ttlMs: 0,
  });
  const { forge, prs } = fakeForge();
  const lander = new AnswersLander({
    asks,
    controlRepo: repo,
    answersPath,
    statePath: join(state, "answers-landing.json"),
    forge,
    log: process.env.LANDING_LOG ? (message: string) => console.log(message) : undefined,
  });
  const answer = async (id: string, option = "ship") => {
    const found = (await asks.read(true)).all.find((ask) => ask.id === id);
    if (!found) throw new Error(`no ask ${id}`);
    return asks.answer({ ledger: LEDGER, home: "origin/main", uid: null, id, hash: found.hash, option, note: "" });
  };
  /** main moves on in the other clone, then the control repo fetches it. */
  const onMain = async (edit: (text: string) => string, message: string) => {
    run(other, "pull", "--quiet", "--ff-only");
    const path = join(other, ".control", "asks", LEDGER);
    await writeFile(path, edit(await readFile(path, "utf8")));
    run(other, "commit", "--quiet", "-am", message);
    run(other, "push", "--quiet", "origin", "main");
    run(repo, "fetch", "--quiet", "origin");
  };
  // The router over the same asks and receipts, with a fake engine: what routing makes of each landed answer.
  const filed: Record<string, unknown>[] = [];
  const router = new AnswerRouter({
    receipts: join(state, "asks.jsonl"),
    asks,
    engine: {
      answered: async () => new Map(),
      create: async (_paseo: unknown, input: Record<string, unknown>) => {
        filed.push(input);
        return { id: `work-${filed.length}`, title: String(input.title), path: "p" };
      },
    } as never,
    client: () => ({ agents: { ref: () => ({ refresh: async () => null }) } }) as unknown as Paseo,
    controlRepo: repo,
  });
  return { root, origin, repo, other, answersPath, asks, lander, prs, answer, onMain, router, filed };
}

describe("landing the answers batch", () => {
  test("no answers worktree yet: nothing to land, and nothing is made", async () => {
    const { lander, prs, answersPath } = await workspace();
    const landing = await lander.land();
    expect([landing.stage, landing.pending, landing.pr, landing.error]).toEqual(["none", 0, null, null]);
    expect(prs).toEqual([]);
    expect(await readFile(join(answersPath, "x")).catch(() => "absent")).toBe("absent");
  });

  test("an answer waits: the branch is pushed and ONE PR opened, then kept current, never a second", async () => {
    const { origin, answersPath, lander, prs, answer } = await workspace();
    await answer("A1");
    const first = await lander.land();
    expect([first.stage, first.pending, first.asks, first.pr?.number]).toEqual([
      "waiting",
      1,
      [{ ledger: LEDGER, uid: null, id: "A1" }],
      915,
    ]);
    expect(run(origin, "rev-parse", ANSWERS_BRANCH)).toBe(run(answersPath, "rev-parse", "HEAD"));
    expect(prs.map((pr) => [pr.title, pr.state])).toEqual([
      [`${BATCH_TITLE} 1 answer from Maestro wait to land`, "OPEN"],
    ]);
    await answer("A2");
    const second = await lander.land();
    expect([second.pending, second.pr?.number, prs.length]).toEqual([2, 915, 1]);
    expect(prs[0]?.title).toBe(`${BATCH_TITLE} 2 answers from Maestro wait to land`);
    expect(run(origin, "rev-parse", ANSWERS_BRANCH)).toBe(run(answersPath, "rev-parse", "HEAD"));
    // The state is kept on disk, for a restart and for every reader.
    const kept = JSON.parse(await readFile(join(answersPath, "..", "answers-landing.json"), "utf8"));
    expect([kept.stage, kept.pending, kept.pr.number]).toEqual(["waiting", 2, 915]);
  });

  test("after the PR squash-merges, the branch is brought level with main and the ask reads from main", async () => {
    const { repo, origin, other, answersPath, asks, lander, prs, answer } = await workspace();
    await answer("A1");
    await lander.land();
    // GitHub's squash merge, in the other clone.
    run(other, "fetch", "--quiet", "origin");
    run(other, "merge", "--quiet", "--squash", `origin/${ANSWERS_BRANCH}`);
    run(other, "commit", "--quiet", "-m", "answers: 1 answer (#915)");
    run(other, "push", "--quiet", "origin", "main");
    run(repo, "fetch", "--quiet", "origin");
    (prs[0] as { state: string }).state = "MERGED";
    const landing = await lander.land();
    expect([landing.stage, landing.pending, landing.pr, landing.landed?.pr?.number]).toEqual(["none", 0, null, 915]);
    expect(treeOf(answersPath, "HEAD")).toBe(treeOf(repo, "origin/main"));
    // Origin's batch is levelled too, by a fast-forward: nothing on it is lost, all of it is on main.
    expect(run(origin, "rev-parse", ANSWERS_BRANCH)).toBe(run(answersPath, "rev-parse", "HEAD"));
    const ask = (await asks.read(true)).all.find((entry) => entry.id === "A1");
    expect([ask?.state, ask?.batched, ask?.home.kind, ask?.answerOption]).toEqual(["answered", false, "main", "ship"]);
    // The next answer starts a new batch from main, and a new PR.
    await answer("A2");
    const next = await lander.land();
    expect([next.stage, next.pending, next.pr?.number]).toEqual(["waiting", 1, 916]);
  });

  test("a batch that has landed by other means closes Maestro's PR, with a word, and levels the branch", async () => {
    const { repo, other, answersPath, lander, prs, answer } = await workspace();
    await answer("A1");
    await lander.land();
    // Landed by hand, as workspace#914 did: main answers the same ask.
    run(other, "fetch", "--quiet", "origin");
    run(other, "merge", "--quiet", "--squash", `origin/${ANSWERS_BRANCH}`);
    run(other, "commit", "--quiet", "-m", "asks: land the stranded answers by hand");
    run(other, "push", "--quiet", "origin", "main");
    run(repo, "fetch", "--quiet", "origin");
    const landing = await lander.land();
    expect(landing.stage).toBe("none");
    expect([prs[0]?.state, prs[0]?.comment]).toEqual([
      "CLOSED",
      `Nothing in this batch waits to land any more: ${ANSWERS_BRANCH} holds nothing origin/main does not. Maestro brought it level with main.`,
    ]);
    expect(treeOf(answersPath, "HEAD")).toBe(treeOf(repo, "origin/main"));
  });

  test("a planted conflict: the batch is kept, its ledger named, answers to main refused; settled by hand, it lands", async () => {
    const { repo, other, answersPath, asks, lander, answer, onMain } = await workspace();
    await answer("A1");
    const kept = run(answersPath, "rev-parse", "HEAD");
    // main rewrites the line the answer was written beside, while the ask stays open there.
    await onMain(
      (text) => text.replace('  - id: A1\n    headline: "Ship A1?"', '  - id: A1\n    headline: "Ship A1, now?"'),
      "reword A1",
    );
    await onMain((text) => text.replace("    asked_at: 2026-10-06T10:00Z\n", "    asked_at: 2026-10-06T10:05Z\n"), "x");
    const landing = await lander.land();
    expect([landing.stage, landing.pending, landing.conflict?.ledgers]).toEqual(["conflict", 1, [LEDGER]]);
    expect(landing.conflict?.path).toBe(answersPath);
    // Nothing lost, nothing half-merged.
    expect(run(answersPath, "rev-parse", "HEAD")).toBe(kept);
    expect(run(answersPath, "status", "--porcelain")).toBe("");
    expect(await readFile(join(answersPath, ".control", "asks", LEDGER), "utf8")).toContain('answer_option: "ship"');
    // While it stands, an answer whose home is main is refused rather than written into a conflicted batch.
    const a2 = (await asks.read(true)).all.find((ask) => ask.id === "A2");
    await expect(
      asks.answer({
        ledger: LEDGER,
        home: "origin/main",
        uid: null,
        id: "A2",
        hash: a2?.hash ?? "",
        option: "ship",
        note: "",
      }),
    ).rejects.toThrow(/could not take origin\/main's latest \(it conflicts in .control\/asks\/bro-9000-landing.yaml\)/);
    // You settle it by hand: main's lines, your answer.
    try {
      run(answersPath, "merge", "--quiet", "origin/main");
    } catch {
      run(answersPath, "checkout", "--theirs", "--", `.control/asks/${LEDGER}`);
      const path = join(answersPath, ".control", "asks", LEDGER);
      const theirs = await readFile(path, "utf8");
      await writeFile(
        path,
        theirs.replace(
          "    asked_at: 2026-10-06T10:05Z\n",
          '    asked_at: 2026-10-06T10:05Z\n    answer: "Ship: It ships."\n    answer_option: "ship"\n    answered_at: "2026-10-06T12:00:00Z"\n    answered_by: "owner:maestro"\n    status: "resolved"\n',
        ),
      );
      run(answersPath, "add", ".");
      run(answersPath, "commit", "--quiet", "--no-edit");
    }
    expect(run(repo, "rev-parse", "origin/main")).not.toBe(run(answersPath, "rev-parse", "HEAD"));
    const settled = await lander.land();
    expect([settled.stage, settled.pending, settled.conflict, settled.pr?.number]).toEqual(["waiting", 1, null, 915]);
    // The settled batch squash-merges: it levels, the hand-settled merge no bar to it.
    run(other, "pull", "--quiet", "--ff-only");
    run(other, "merge", "--quiet", "--squash", `origin/${ANSWERS_BRANCH}`);
    run(other, "commit", "--quiet", "-m", "answers (#915)");
    run(other, "push", "--quiet", "origin", "main");
    run(repo, "fetch", "--quiet", "origin");
    const landed = await lander.land();
    expect([landed.stage, landed.error]).toEqual(["none", null]);
    expect(treeOf(answersPath, "HEAD")).toBe(treeOf(repo, "origin/main"));
  });

  test("origin's batch holding an answer this one lacks (another daemon's push) is never pushed over", async () => {
    const { origin, other, answersPath, lander, answer } = await workspace();
    await answer("A1");
    await lander.land();
    // Someone else answers A2 on origin's maestro/answers, which this worktree never fetched.
    run(other, "fetch", "--quiet", "origin");
    run(other, "switch", "--quiet", "-c", "theirs", `origin/${ANSWERS_BRANCH}`);
    const path = join(other, ".control", "asks", LEDGER);
    const text = await readFile(path, "utf8");
    await writeFile(
      path,
      text.replace(
        "  - id: A2\n",
        '  - id: A2\n    answer: "Hold"\n    answer_option: "hold"\n    answered_at: "2026-10-06T12:30:00Z"\n',
      ),
    );
    run(other, "commit", "--quiet", "-am", "answer A2 elsewhere");
    run(other, "push", "--quiet", "origin", `HEAD:${ANSWERS_BRANCH}`);
    const theirs = run(origin, "rev-parse", ANSWERS_BRANCH);
    // Here, a new answer moves the local batch on.
    await answer("A2", "ship");
    const mine = run(answersPath, "rev-parse", "HEAD");
    const landing = await lander.land();
    // Merged in first, it answers A2 another way: a conflict to settle, both answers kept, nothing pushed over.
    expect([landing.stage, landing.conflict?.ledgers, landing.conflict?.with]).toEqual([
      "conflict",
      [LEDGER],
      `origin's ${ANSWERS_BRANCH}`,
    ]);
    expect(run(origin, "rev-parse", ANSWERS_BRANCH)).toBe(theirs);
    expect(run(answersPath, "rev-parse", "HEAD")).toBe(mine);
    expect(run(answersPath, "status", "--porcelain")).toBe("");
  });

  test("GitHub's Update branch on the PR (main merged into origin's batch) is no reason to stop pushing", async () => {
    const { origin, other, answersPath, lander, answer, onMain, prs } = await workspace();
    await answer("A1");
    await lander.land();
    await onMain((text) => `${text}  - id: A3\n    headline: "Later?"\n`, "a new ask on main");
    run(other, "fetch", "--quiet", "origin");
    run(other, "switch", "--quiet", "-c", "update", `origin/${ANSWERS_BRANCH}`);
    run(other, "merge", "--quiet", "--no-edit", "origin/main");
    run(other, "push", "--quiet", "origin", `HEAD:${ANSWERS_BRANCH}`);
    await answer("A2");
    const landing = await lander.land();
    expect([landing.stage, landing.pending, prs.length]).toEqual(["waiting", 2, 1]);
    expect(run(origin, "rev-parse", ANSWERS_BRANCH)).toBe(run(answersPath, "rev-parse", "HEAD"));
  });

  test("a batch carrying more than answers, once its answers landed, is a stop: a new ask or a file is named, and kept", async () => {
    const { repo, other, answersPath, lander, answer } = await workspace();
    await answer("A1");
    await lander.land();
    run(other, "fetch", "--quiet", "origin");
    run(other, "merge", "--quiet", "--squash", `origin/${ANSWERS_BRANCH}`);
    run(other, "commit", "--quiet", "-m", "answers (#915)");
    run(other, "push", "--quiet", "origin", "main");
    run(repo, "fetch", "--quiet", "origin");
    const ledger = join(answersPath, ".control", "asks", LEDGER);
    await writeFile(ledger, `${await readFile(ledger, "utf8")}  - id: A9\n    headline: "Added by hand?"\n`);
    await writeFile(join(answersPath, "notes.md"), "a hand note\n");
    run(answersPath, "add", ".");
    run(answersPath, "commit", "--quiet", "-m", "hand edits");
    const landing = await lander.land();
    expect([landing.stage, landing.pending]).toEqual(["blocked", 0]);
    expect(landing.error).toContain(
      `differs from main (.control/asks/${LEDGER}, notes.md) but records no answer main lacks, so Maestro neither lands nor drops it`,
    );
    expect(run(answersPath, "show", "HEAD:notes.md")).toBe("a hand note");
    expect(await readFile(ledger, "utf8")).toContain("  - id: A9");
  });

  test("an open ask's status changed on the branch is not an answer: once the answers landed, a stop, never levelled", async () => {
    const { repo, other, answersPath, lander, answer } = await workspace();
    await answer("A1");
    await lander.land();
    run(other, "fetch", "--quiet", "origin");
    run(other, "merge", "--quiet", "--squash", `origin/${ANSWERS_BRANCH}`);
    run(other, "commit", "--quiet", "-m", "answers (#915)");
    run(other, "push", "--quiet", "origin", "main");
    run(repo, "fetch", "--quiet", "origin");
    const ledger = join(answersPath, ".control", "asks", LEDGER);
    await writeFile(
      ledger,
      (await readFile(ledger, "utf8")).replace("  - id: A2\n", "  - id: A2\n    status: blocked\n"),
    );
    run(answersPath, "commit", "--quiet", "-am", "A2 blocked by hand");
    const landing = await lander.land();
    expect([landing.stage, landing.error?.includes(`differs from main (.control/asks/${LEDGER})`)]).toEqual([
      "blocked",
      true,
    ]);
    expect(await readFile(ledger, "utf8")).toContain("    status: blocked");
  });

  test("a merge that leaves no answer to land (main merged the PR, then dropped the ask) levels; no empty PR", async () => {
    const { repo, other, answersPath, lander, answer, prs } = await workspace();
    await answer("A1");
    await lander.land();
    run(other, "fetch", "--quiet", "origin");
    run(other, "merge", "--quiet", "--no-ff", "--no-edit", `origin/${ANSWERS_BRANCH}`);
    const path = join(other, ".control", "asks", LEDGER);
    const text = await readFile(path, "utf8");
    await writeFile(path, `arc: bro-9000\nasks:\n${text.slice(text.indexOf("  - id: A2"))}`);
    run(other, "commit", "--quiet", "-am", "drop A1");
    run(other, "push", "--quiet", "origin", "main");
    run(repo, "fetch", "--quiet", "origin");
    (prs[0] as { state: string }).state = "MERGED";
    const landing = await lander.land();
    expect([landing.stage, landing.pr, prs.length]).toEqual(["none", null, 1]);
    expect(run(answersPath, "rev-parse", "HEAD")).toBe(run(repo, "rev-parse", "origin/main"));
  });

  test("a landed answer whose row main then removes is a conflict for you to settle, never a silent drop", async () => {
    const { repo, other, answersPath, lander, answer, prs } = await workspace();
    await answer("A1");
    await lander.land();
    run(other, "fetch", "--quiet", "origin");
    run(other, "merge", "--quiet", "--squash", `origin/${ANSWERS_BRANCH}`);
    run(other, "commit", "--quiet", "-m", "answers (#915)");
    const path = join(other, ".control", "asks", LEDGER);
    const text = await readFile(path, "utf8");
    await writeFile(path, `arc: bro-9000\nasks:\n${text.slice(text.indexOf("  - id: A2"))}`);
    run(other, "commit", "--quiet", "-am", "A1 moved elsewhere");
    run(other, "push", "--quiet", "origin", "main");
    run(repo, "fetch", "--quiet", "origin");
    (prs[0] as { state: string }).state = "MERGED";
    const landing = await lander.land();
    expect([landing.stage, landing.conflict?.ledgers, landing.conflict?.with]).toEqual([
      "conflict",
      [LEDGER],
      "origin/main",
    ]);
    expect(await readFile(join(answersPath, ".control", "asks", LEDGER), "utf8")).toContain('answer_option: "ship"');
  });

  test("round 3: a conflict settled keeping the batch's side, then squash-merged, levels: main holds what it changed", async () => {
    const { repo, other, answersPath, lander, answer, onMain } = await workspace();
    await answer("A1");
    await onMain(
      (text) => text.replace("    asked_at: 2026-10-06T10:00Z\n", "    asked_at: 2026-10-06T10:05Z\n"),
      "move A1",
    );
    expect((await lander.land()).stage).toBe("conflict");
    try {
      run(answersPath, "merge", "--quiet", "origin/main");
    } catch {
      run(answersPath, "checkout", "--ours", "--", `.control/asks/${LEDGER}`);
      run(answersPath, "add", ".");
      run(answersPath, "commit", "--quiet", "--no-edit");
    }
    expect((await lander.land()).stage).toBe("waiting");
    run(other, "pull", "--quiet", "--ff-only");
    run(other, "merge", "--quiet", "--squash", `origin/${ANSWERS_BRANCH}`);
    run(other, "commit", "--quiet", "-m", "answers (#915)");
    run(other, "push", "--quiet", "origin", "main");
    run(repo, "fetch", "--quiet", "origin");
    const landed = await lander.land();
    expect([landed.stage, landed.error]).toEqual(["none", null]);
    expect(treeOf(answersPath, "HEAD")).toBe(treeOf(repo, "origin/main"));
  });

  test("a commit on origin's batch that is not an answer (a reviewer's edit) is merged in, never pushed over", async () => {
    const { origin, other, lander, answer } = await workspace();
    await answer("A1");
    await lander.land();
    run(other, "fetch", "--quiet", "origin");
    run(other, "switch", "--quiet", "-c", "review", `origin/${ANSWERS_BRANCH}`);
    await writeFile(join(other, "REVIEW.md"), "a reviewer's note\n");
    run(other, "add", ".");
    run(other, "commit", "--quiet", "-m", "review note");
    run(other, "push", "--quiet", "origin", `HEAD:${ANSWERS_BRANCH}`);
    const theirs = run(origin, "rev-parse", ANSWERS_BRANCH);
    await answer("A2");
    const landing = await lander.land();
    // Merged in, then pushed: a fast-forward of it, the reviewer's note kept.
    expect([landing.stage, landing.pending]).toEqual(["waiting", 2]);
    run(origin, "merge-base", "--is-ancestor", theirs, ANSWERS_BRANCH);
    expect(run(origin, "show", `${ANSWERS_BRANCH}:REVIEW.md`)).toBe("a reviewer's note");
  });

  test("an ask main closed another way while its answer waits is a conflict to settle: nothing pushed over or dropped", async () => {
    const { origin, answersPath, lander, answer, onMain } = await workspace();
    await answer("A1");
    await lander.land();
    const pushed = run(origin, "rev-parse", ANSWERS_BRANCH);
    await onMain(
      (text) =>
        text.replace(
          "  - id: A1\n",
          '  - id: A1\n    answer: "Hold"\n    answer_option: "hold"\n    answered_at: "2026-10-06T12:00:00Z"\n',
        ),
      "A1 held",
    );
    const mine = run(answersPath, "rev-parse", "HEAD");
    const landing = await lander.land();
    expect([landing.stage, landing.conflict?.ledgers]).toEqual(["conflict", [LEDGER]]);
    expect(run(answersPath, "rev-parse", "HEAD")).toBe(mine);
    expect(run(origin, "rev-parse", ANSWERS_BRANCH)).toBe(pushed);
    expect(run(answersPath, "status", "--porcelain")).toBe("");
  });

  test("round 4: main stamps a uid on an answered ask while its answer waits: the answer still waits, never dropped", async () => {
    const { answersPath, lander, answer, onMain, prs } = await workspace();
    await answer("A1");
    await lander.land();
    await onMain((text) => text.replace("  - id: A1\n", "  - id: A1\n    uid: u-1\n"), "stamp A1");
    const landing = await lander.land();
    expect(landing.stage === "waiting" || landing.stage === "conflict").toBe(true);
    expect(landing.pending).toBe(1);
    expect(prs[0]?.state).toBe("OPEN");
    expect(run(answersPath, "log", "--format=%s")).toContain("answer(bro-9000-landing.yaml): A1 -> ship");
    expect(await readFile(join(answersPath, ".control", "asks", LEDGER), "utf8")).toContain('answer_option: "ship"');
  });

  test("round 5 (High): main stamps a uid on an answered ask; once it lands, the answer is acted on, never shown done unacted", async () => {
    const { repo, other, asks, lander, answer, onMain, prs, router, filed } = await workspace();
    await router.begin();
    await answer("A1");
    await lander.land();
    await onMain((text) => text.replace("  - id: A1\n", "  - id: A1\n    uid: u-1\n"), "stamp A1");
    const waiting = await lander.land();
    expect([waiting.stage, waiting.pending]).toEqual(["waiting", 1]);
    run(other, "pull", "--quiet", "--ff-only");
    run(other, "merge", "--quiet", "--squash", `origin/${ANSWERS_BRANCH}`);
    run(other, "commit", "--quiet", "-m", "answers (#915)");
    run(other, "push", "--quiet", "origin", "main");
    run(repo, "fetch", "--quiet", "origin");
    (prs[0] as { state: string }).state = "MERGED";
    expect((await lander.land()).stage).toBe("none");
    const routed = await router.route();
    expect(routed.map((outcome) => [outcome.id, outcome.status, outcome.route])).toEqual([["A1", "routed", "work"]]);
    expect(filed.length).toBe(1);
    const read = await asks.read(true);
    const [fated] = await router.fates(
      read.all.filter((ask) => ask.id === "A1"),
      null,
    );
    expect([fated?.uid, fated?.state, fated?.fate?.stage]).toEqual(["u-1", "answered", "acted"]);
  });

  test("round 5 (Medium): a ledger renamed on main while its answer waits never drops the answer", async () => {
    const { other, repo, answersPath, lander, answer, prs } = await workspace();
    await answer("A1");
    await lander.land();
    run(other, "pull", "--quiet", "--ff-only");
    run(other, "mv", `.control/asks/${LEDGER}`, ".control/asks/bro-9000-renamed.yaml");
    run(other, "commit", "--quiet", "-m", "rename the ledger");
    run(other, "push", "--quiet", "origin", "main");
    run(repo, "fetch", "--quiet", "origin");
    const landing = await lander.land();
    expect(landing.stage === "waiting" || landing.stage === "conflict" || landing.stage === "blocked").toBe(true);
    expect(prs[0]?.state).toBe("OPEN");
    // Still on the branch, in whichever ledger now carries it.
    expect(run(answersPath, "log", "--format=%s")).toContain(`answer(${LEDGER}): A1 -> ship`);
    expect(run(answersPath, "grep", "-c", 'answer_option: "ship"', "HEAD", "--", ".control/asks/")).toContain(":1");
  });

  test("changes not committed in the answers worktree: the step fails in words, and the batch is untouched", async () => {
    const { answersPath, lander, answer } = await workspace();
    await answer("A1");
    await writeFile(join(answersPath, "stray.txt"), "x");
    const landing = await lander.land();
    expect(landing.stage).toBe("failed");
    expect(landing.error).toContain("the answers worktree has changes not committed (stray.txt)");
  });
});
