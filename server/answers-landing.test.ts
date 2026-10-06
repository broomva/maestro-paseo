import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrRef } from "../shared/answers";
import { AnswersLander, BATCH_TITLE, batchPr, type Forge, unlandedAnswers } from "./answers-landing";
import { ANSWERS_BRANCH, WorkspaceAsks } from "./control-home";

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
  test("an ask main lacks altogether waits; a uid is the handle when there is one", () => {
    const batch = `asks:\n${answered("A1")}    uid: u-1\n`;
    expect(unlandedAnswers(LEDGER, batch, null)).toEqual([{ ledger: LEDGER, uid: "u-1", id: "A1" }]);
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
  return { root, origin, repo, other, answersPath, asks, lander, prs, answer, onMain };
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
    const { repo, other, answersPath, asks, lander, prs, answer } = await workspace();
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
    expect(run(answersPath, "rev-parse", "HEAD")).toBe(run(repo, "rev-parse", "origin/main"));
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
      `Everything in this batch is on origin/main now, so it has nothing left to land. Maestro brought ${ANSWERS_BRANCH} level with main.`,
    ]);
    expect(run(answersPath, "rev-parse", "HEAD")).toBe(run(repo, "rev-parse", "origin/main"));
  });

  test("a planted conflict: the batch is kept, its ledger named, answers to main refused; settled by hand, it lands", async () => {
    const { repo, answersPath, asks, lander, answer, onMain } = await workspace();
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
    const landing = await lander.land();
    expect(landing.stage).toBe("failed");
    expect(landing.error).toContain(
      `holds 2 answers main does not record, in commits this batch lacks (${LEDGER} A1, ${LEDGER} A2)`,
    );
    expect(run(origin, "rev-parse", ANSWERS_BRANCH)).toBe(theirs);
    expect(run(answersPath, "rev-parse", "HEAD")).not.toBe(theirs);
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
