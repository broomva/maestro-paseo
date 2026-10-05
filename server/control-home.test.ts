import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionAsk } from "../shared/fleet";
import { parsed, rowsOf } from "./control-asks";
import {
  ANSWERS_BRANCH,
  blobId,
  gitWords,
  isLocal,
  type Ledger,
  parseWorktrees,
  resolveHomes,
  type Sources,
  WorkspaceAsks,
} from "./control-home";
import { readLedgers as paseoAsksRead } from "./testdata/paseo-asks-ledger";

// ── The rule, on parsed sources ──────────────────────────────────────────────

const ledger = (text: string): Ledger => {
  const data = parsed(text);
  return { data, rows: rowsOf(data) };
};
const ask = (fields: string) => `asks:\n  - id: A1\n${fields}`;
const OPEN = ask(`    headline: "Merge it?"\n    blocking: false\n    default: hold\n`);
const ANSWERED = ask(
  `    headline: "Merge it?"\n    blocking: false\n    default: hold\n    answer: "Merge."\n    answered_at: 2026-10-02T10:00:00Z\n`,
);
const sources = (over: Partial<Sources>): Sources => ({
  controlRepo: "/repo",
  main: new Map(),
  checkouts: [],
  answers: new Map(),
  ...over,
});
const checkout = (path: string, tree: Record<string, string>, base: Record<string, string> = {}) => ({
  path,
  branch: path.split("/").pop() ?? null,
  tree: new Map(Object.entries(tree).map(([name, text]) => [name, ledger(text)])),
  base: new Map(Object.entries(base).map(([name, text]) => [name, ledger(text)])),
});
const homes = (list: DecisionAsk[]) => list.map((entry) => [entry.id, entry.state, entry.home.kind, entry.home.path]);

describe("the home rule (§5.2)", () => {
  test("a copy is local when it changed a field from B that has not landed; per field, so a folded squash has", () => {
    const base = { id: "A1", status: "open", note: "x" };
    expect(isLocal(base, { ...base }, base)).toBe(false);
    expect(isLocal(base, { ...base, status: "resolved" }, base)).toBe(true);
    // Main took W's edit and edited another field since: landed.
    expect(isLocal(base, { ...base, status: "resolved" }, { ...base, status: "resolved", note: "y" })).toBe(false);
    // An ask only in W is local until main holds it as W gave it.
    expect(isLocal(null, { id: "A1" }, null)).toBe(true);
    expect(isLocal(null, { id: "A1" }, { id: "A1" })).toBe(false);
    // A key set to null reads as no key.
    expect(isLocal({ id: "A1" }, { id: "A1", answered_at: null }, { id: "A1" })).toBe(false);
  });

  test("main's outcome wins over an open copy in any checkout", () => {
    const list = resolveHomes(
      sources({
        main: new Map([["l.yaml", ledger(ANSWERED)]]),
        checkouts: [checkout("/w", { "l.yaml": `${OPEN}    stakes: "edited in W"\n` }, { "l.yaml": OPEN })],
      }),
    );
    // W inherited the ask from B and changed it since, but main has answered it.
    expect(homes(list)).toEqual([["A1", "answered", "main", "/repo"]]);
  });

  test("a checkout's stale copy, which main has moved past, is not the ask: main's is", () => {
    const moved = ask(`    headline: "Merge it, now?"\n    blocking: true\n    no_default_because: irreversible\n`);
    const list = resolveHomes(
      sources({
        main: new Map([["l.yaml", ledger(moved)]]),
        checkouts: [checkout("/repo", { "l.yaml": OPEN }, { "l.yaml": OPEN })],
      }),
    );
    expect(list.map((entry) => [entry.headline, entry.home.kind, entry.waiting])).toEqual([
      ["Merge it, now?", "main", true],
    ]);
  });

  test("the single local copy is the home; an answer it holds and main does not shows answered there", () => {
    const list = resolveHomes(
      sources({
        main: new Map([["l.yaml", ledger(OPEN)]]),
        checkouts: [checkout("/w", { "l.yaml": ANSWERED }, { "l.yaml": OPEN })],
      }),
    );
    expect(homes(list)).toEqual([["A1", "answered", "checkout", "/w"]]);
  });

  test("two local copies are diverged and answered nowhere, unless the stamp names one", () => {
    const one = ask(`    headline: "Merge it?"\n    stakes: "one"\n`);
    const two = ask(`    headline: "Merge it?"\n    stakes: "two"\n`);
    const both = [checkout("/w1", { "l.yaml": one }), checkout("/w2", { "l.yaml": two })];
    const [diverged] = resolveHomes(sources({ checkouts: both }));
    expect(diverged?.refusal).toContain("changed differently in 2 checkouts: /w1 (w1); /w2 (w2)");
    const stamped = (text: string) => `${text}    origin:\n      cwd: /w2/sub\n`;
    const [home] = resolveHomes(
      sources({
        checkouts: [checkout("/w1", { "l.yaml": stamped(one) }), checkout("/w2", { "l.yaml": stamped(two) })],
      }),
    );
    expect([home?.home.path, home?.stakes, home?.refusal]).toEqual(["/w2", "two", null]);
  });

  test("an ask W added under a handle main already uses, unlike main's, is an id collision: both shown, neither answered", () => {
    const other = ask(`    headline: "Something else"\n`);
    const list = resolveHomes(
      sources({ main: new Map([["l.yaml", ledger(OPEN)]]), checkouts: [checkout("/w", { "l.yaml": other }, {})] }),
    );
    expect(list.map((entry) => [entry.headline, entry.home.kind, Boolean(entry.refusal)])).toEqual([
      ["Merge it?", "main", true],
      ["Something else", "checkout", true],
    ]);
    // Landed as W gave it (a squash merge): one ask, not a collision.
    const landed = resolveHomes(
      sources({ main: new Map([["l.yaml", ledger(other)]]), checkouts: [checkout("/w", { "l.yaml": other }, {})] }),
    );
    expect(landed.map((entry) => [entry.home.kind, entry.refusal])).toEqual([["main", null]]);
  });

  test("an ask with a uid is that uid everywhere; an answer in the answers worktree shows as batched", () => {
    const withUid = (text: string) => text.replace("  - id: A1\n", "  - id: A1\n    uid: u-1\n");
    const list = resolveHomes(
      sources({
        main: new Map([["l.yaml", ledger(withUid(OPEN))]]),
        answers: new Map([["l.yaml", ledger(withUid(ANSWERED))]]),
      }),
    );
    expect(list.map((entry) => [entry.uid, entry.state, entry.home.kind, entry.batched])).toEqual([
      ["u-1", "answered", "main", true],
    ]);
  });

  test("a blocking ask waits on you even with a default (BRO-2693); so does one recommending what cannot be undone", () => {
    const blocking = ask(`    headline: "Merge?"\n    blocking: true\n    default: hold\n`);
    const irreversible = ask(
      `    headline: "Send?"\n    blocking: false\n    default: wait\n    options:\n      - id: send\n        label: Send\n        recommended: true\n        reversible: false\n`,
    );
    const quiet = ask(`    headline: "Name?"\n    blocking: false\n    default: placeholder\n`);
    const list = resolveHomes(
      sources({
        main: new Map([
          ["a.yaml", ledger(blocking)],
          ["b.yaml", ledger(irreversible)],
          ["c.yaml", ledger(quiet)],
        ]),
      }),
    );
    expect(list.map((entry) => [entry.ledger, entry.waiting])).toEqual([
      ["a.yaml", true],
      ["b.yaml", true],
      ["c.yaml", false],
    ]);
  });

  test("a handle two entries of one copy share lists both, and answers neither", () => {
    const twice = `${OPEN}  - id: A1\n    headline: "Another A1"\n`;
    const list = resolveHomes(sources({ main: new Map([["l.yaml", ledger(twice)]]) }));
    expect(list.map((entry) => [entry.headline, Boolean(entry.refusal)])).toEqual([
      ["Merge it?", true],
      ["Another A1", true],
    ]);
  });

  test("an id that reads with a uid in one copy and without in another (changed) is two rows, neither answered", () => {
    const stamped = OPEN.replace("  - id: A1\n", "  - id: A1\n    uid: u-1\n");
    const list = resolveHomes(
      sources({
        main: new Map([["l.yaml", ledger(OPEN)]]),
        checkouts: [checkout("/w", { "l.yaml": stamped }, { "l.yaml": OPEN })],
      }),
    );
    expect(list.map((entry) => [entry.uid, entry.home.kind, entry.refusal?.includes("one ask at two homes")])).toEqual([
      [null, "main", true],
      ["u-1", "checkout", true],
    ]);
  });

  test("main stamped a uid; a lingering worktree's unstamped copy, unchanged, reads as nothing and refuses nothing", () => {
    const stamped = OPEN.replace("  - id: A1\n", "  - id: A1\n    uid: u-1\n");
    const other = `${OPEN}  - id: A2\n    ask: "Other"\n`;
    const list = resolveHomes(
      sources({
        main: new Map([["l.yaml", ledger(stamped)]]),
        checkouts: [checkout("/w", { "l.yaml": other }, { "l.yaml": OPEN })],
      }),
    );
    expect(list.map((entry) => [entry.id, entry.uid, entry.home.kind, entry.refusal])).toEqual([
      ["A1", "u-1", "main", null],
      ["A2", null, "checkout", null],
    ]);
  });

  test("a doubled handle in a checkout: main's outcome still wins; else every differing copy is listed, none answered", () => {
    const twice = `${OPEN}  - id: A1\n    headline: "Another A1"\n`;
    const closed = resolveHomes(
      sources({
        main: new Map([["l.yaml", ledger(ANSWERED)]]),
        checkouts: [checkout("/w", { "l.yaml": twice }, { "l.yaml": OPEN })],
      }),
    );
    expect(homes(closed)).toEqual([["A1", "answered", "main", "/repo"]]);
    const open = resolveHomes(
      sources({
        main: new Map([["l.yaml", ledger(OPEN)]]),
        checkouts: [
          checkout("/w", { "l.yaml": twice }, { "l.yaml": OPEN }),
          checkout("/v", { "l.yaml": OPEN }, { "l.yaml": OPEN }),
          checkout("/u", { "l.yaml": ask(`    headline: "Merge it, u?"\n`) }, { "l.yaml": OPEN }),
        ],
      }),
    );
    expect(open.map((entry) => [entry.headline, entry.home.path, Boolean(entry.refusal)])).toEqual([
      ["Merge it?", "/repo", true],
      ["Merge it?", "/w", true],
      ["Another A1", "/w", true],
      ["Merge it, u?", "/u", true],
    ]);
  });

  test("an ask a lingering worktree added, which main has edited since, is main's: not local, not a collision", () => {
    const added = ask(`    ask: "Merge it?"\n    asked_at: 2026-10-01T10:00Z\n    stakes: "old"\n`);
    const edited = added.replace('stakes: "old"', 'stakes: "new"');
    const list = resolveHomes(
      sources({ main: new Map([["l.yaml", ledger(edited)]]), checkouts: [checkout("/w", { "l.yaml": added }, {})] }),
    );
    expect(list.map((entry) => [entry.stakes, entry.home.kind, entry.refusal])).toEqual([["new", "main", null]]);
    // An answer that worktree recorded and main has not is still its own, and shows there.
    const answered = `${added}    answer: "Merge."\n`;
    const local = resolveHomes(
      sources({ main: new Map([["l.yaml", ledger(edited)]]), checkouts: [checkout("/w", { "l.yaml": answered }, {})] }),
    );
    expect(local.map((entry) => [entry.state, entry.home.kind])).toEqual([["answered", "checkout"]]);
  });

  test("main's answer closes its own ask, never a different one a branch added under its id (spec §8 case 7)", () => {
    const theirs = ask(`    headline: "Something else"\n    blocking: true\n`);
    const list = resolveHomes(
      sources({ main: new Map([["l.yaml", ledger(ANSWERED)]]), checkouts: [checkout("/w", { "l.yaml": theirs }, {})] }),
    );
    expect(
      list.map((entry) => [entry.headline, entry.state, entry.home.kind, Boolean(entry.refusal), entry.waiting]),
    ).toEqual([
      ["Merge it?", "answered", "main", false, false],
      ["Something else", "open", "checkout", true, true],
    ]);
  });

  test("asked in the same minute is not enough: the words must agree too, else an id collision", () => {
    const mine = ask(`    question: "Ship the cache?"\n    asked_at: 2026-10-01T10:00Z\n`);
    const theirs = ask(`    ask: "Rename the repo?"\n    asked_at: 2026-10-01T10:00Z\n`);
    const list = resolveHomes(
      sources({ main: new Map([["l.yaml", ledger(theirs)]]), checkouts: [checkout("/w", { "l.yaml": mine }, {})] }),
    );
    expect(list.map((entry) => [entry.question, entry.home.kind, Boolean(entry.refusal)])).toEqual([
      ["Rename the repo?", "main", true],
      ["Ship the cache?", "checkout", true],
    ]);
  });

  test("git's words: the line naming the cause, past a hook's banner and git's boilerplate", () => {
    expect(gitWords("=== bstack pre-commit gate ===\n  [FAIL] gitleaks: a secret\n  Fix: remove it\n")).toBe(
      "[FAIL] gitleaks: a secret",
    );
    expect(
      gitWords(
        "ERROR: Repository not found.\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n",
      ),
    ).toBe("ERROR: Repository not found.");
    expect(gitWords("something odd\nthen this\n")).toBe("then this");
    expect(gitWords("")).toBe("it failed with no words");
  });

  test("git's worktree listing, without bare or prunable trees", () => {
    const listing = [
      "worktree /repo\nHEAD abc\nbranch refs/heads/feat/x",
      "worktree /gone\nHEAD def\ndetached\nprunable gitdir file points to non-existent location",
      "worktree /w\nHEAD 123\ndetached",
    ].join("\n\n");
    expect(parseWorktrees(`${listing}\n`)).toEqual([
      { path: "/repo", head: "abc", branch: "feat/x" },
      { path: "/w", head: "123", branch: null },
    ]);
  });

  test("a working file's blob id is git's", () => {
    expect(blobId(Buffer.from("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
});

// ── The workspace, in scratch git repos ──────────────────────────────────────

/** A real ledger's shape: maestro-paseo-gaps.yaml's A10, which ask_ledger.py validate passes. */
const CANVAS = `# Ask ledger: a test arc.
arc: bro-2795-local-first-agentic-canvas
opened: 2026-10-01T16:30Z
tz: America/Bogota
lanes: [lane-a]

asks:
  - id: product-name
    headline: "Name the product now, or keep the placeholder?"
    stakes: "None blocks a lane."
    why_you: "Naming is yours."
    options:
      - id: keep-placeholder
        label: "Keep the placeholder"
        consequence: "Renaming is a search-and-replace before the first publish."
        reversible: true
        recommended: true
      - id: name-now
        label: "Name it now"
        consequence: "The name lands everywhere at once."
        reversible: true
    ask: "Keep the placeholder name or choose one now?"
    class: decision
    gates: []
    default: keep the placeholder; rename before the first publish
    blocking: false
    preanswerable: false
    exhausted:
      - "read: no prior decision on disk"
      - "default: available: none blocks a lane"
    asked_at: 2026-10-01T16:30Z
    status: open
`;

/** The #863 merge ask's shape: blocking with a default, only in the main checkout's working tree. */
const MERGE = `arc: prompt-cache-and-preflight-caching
asks:
  - id: A1
    headline: "Approve merge of PR #863?"
    stakes: "It touches a require_human path."
    options:
      - id: merge
        label: "Merge PR #863"
        consequence: "Warnings go to stderr."
        reversible: true
        recommended: true
      - id: hold
        label: "Hold PR #863"
        consequence: "It stays open."
        reversible: true
    ask: "Approve merge of PR #863"
    default: hold
    blocking: true
    asked_at: 2026-10-01T10:00Z
    answered_at: null
`;

const scratch: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
const ISOLATED = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE"];
beforeAll(async () => {
  for (const key of ISOLATED) savedEnv[key] = process.env[key];
  // Neither the owner's global hooks nor their identity: a config of the test's own.
  const home = await mkdtemp(join(tmpdir(), "maestro-home-git-"));
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

/** A control repo with an origin: CANVAS committed and on origin/main, MERGE untracked in the main checkout. */
async function workspace() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "maestro-control-")));
  scratch.push(root);
  const origin = join(root, "origin.git");
  const repo = join(root, "broomva");
  run(root, "init", "--quiet", "--bare", origin);
  run(root, "init", "--quiet", repo);
  await mkdir(join(repo, ".control", "asks"), { recursive: true });
  await writeFile(join(repo, ".control", "asks", "bro-2795-canvas.yaml"), CANVAS);
  await writeFile(join(repo, ".control", "asks", "README.md"), "Not a ledger.\n");
  run(repo, "add", ".");
  run(repo, "commit", "--quiet", "-m", "ledgers");
  run(repo, "remote", "add", "origin", origin);
  run(repo, "push", "--quiet", "origin", "main");
  run(repo, "fetch", "--quiet", "origin");
  // The owner's main checkout sits on a feature branch, with an ask of its own not yet committed.
  run(repo, "switch", "--quiet", "-c", "feat/prompt-cache");
  await writeFile(join(repo, ".control", "asks", "2026-10-01-merge.yaml"), MERGE);
  const state = join(root, "state");
  const asks = new WorkspaceAsks({
    controlRepo: repo,
    answersPath: join(state, "control-answers"),
    lockRoot: join(state, "locks"),
    receipts: join(state, "asks.jsonl"),
    fetch: false,
    ttlMs: 0,
  });
  return { root, origin, repo, state, asks };
}

const find = (list: DecisionAsk[], id: string) => {
  const found = list.find((entry) => entry.id === id);
  if (!found) throw new Error(`no ask ${id}`);
  return found;
};

/** ask_ledger.py, when this machine has the workspace's copy: the validator CI runs. */
const ASK_LEDGER = join(homedir(), "broomva", "scripts", "ask_ledger.py");
const validates = (path: string) => spawnSync("python3", [ASK_LEDGER, "validate", path], { encoding: "utf8" });

describe("the workspace's asks, in a scratch control repo", () => {
  test("each ask at its home: an untracked ledger in the main checkout there, the rest on origin/main", async () => {
    const { repo, asks } = await workspace();
    const read = await asks.read();
    expect(read.warnings).toEqual([]);
    const merge = find(read.all, "A1");
    expect([merge.home.kind, merge.home.path, merge.home.branch, merge.waiting]).toEqual([
      "checkout",
      repo,
      "feat/prompt-cache",
      true,
    ]);
    const canvas = find(read.all, "product-name");
    expect([canvas.home.kind, canvas.waiting, canvas.options.map((option) => option.id)]).toEqual([
      "main",
      false,
      ["keep-placeholder", "name-now"],
    ]);
    expect(await asks.waiting()).toEqual([
      {
        scope: null,
        ledger: "2026-10-01-merge.yaml",
        uid: null,
        id: "A1",
        headline: "Approve merge of PR #863?",
        blocking: true,
        askedAt: "2026-10-01T10:00Z",
      },
    ]);
  });

  test("an answer at a checkout home is written in place, and paseo-asks reads it answered", async () => {
    const { repo, state, asks } = await workspace();
    const merge = find((await asks.read()).all, "A1");
    const { ask, warning } = await asks.answer({
      ledger: merge.ledger,
      home: repo,
      uid: null,
      id: "A1",
      hash: merge.hash,
      option: "merge",
      note: "",
    });
    expect([ask.state, ask.answerOption, ask.home.kind, warning]).toEqual(["answered", "merge", "checkout", null]);
    const path = join(repo, ".control", "asks", "2026-10-01-merge.yaml");
    const text = await readFile(path, "utf8");
    expect(text).toContain('answer: "Merge PR #863: Warnings go to stderr."');
    expect(text).toContain('answer_option: "merge"');
    expect(text).toMatch(/answered_at: "\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ"/);
    // The Asks plugin, reading the same folder live, sees it resolved.
    const seen = paseoAsksRead(join(repo, ".control", "asks"));
    expect(seen.problems).toEqual([]);
    const row = seen.asks.find((entry) => entry.id === "A1") as Record<string, unknown> | undefined;
    expect([row?.state, row?.answerText]).toEqual(["answered", "Merge PR #863: Warnings go to stderr."]);
    expect(find((await asks.read()).all, "A1").state).toBe("answered");
    const receipt = JSON.parse((await readFile(join(state, "asks.jsonl"), "utf8")).trim());
    expect([receipt.kind, receipt.home, receipt.homeKind]).toEqual(["ask.answered", path, "checkout"]);
    // Nothing else in the main checkout moved, and no answers worktree was made.
    expect(run(repo, "status", "--porcelain")).toBe("?? .control/asks/2026-10-01-merge.yaml");
    expect(existsSync(join(state, "control-answers"))).toBe(false);
  });

  test("an answer whose home is origin/main goes to the answers worktree, committed on maestro/answers", async () => {
    const { repo, state, asks } = await workspace();
    const canvas = find((await asks.read()).all, "product-name");
    const { ask, warning } = await asks.answer({
      ledger: canvas.ledger,
      home: "origin/main",
      uid: null,
      id: "product-name",
      hash: canvas.hash,
      option: "keep-placeholder",
      note: "Dogfood.",
    });
    expect([ask.state, ask.batched, warning]).toEqual(["answered", true, null]);
    const answers = join(state, "control-answers");
    const path = join(answers, ".control", "asks", "bro-2795-canvas.yaml");
    expect(await readFile(path, "utf8")).toContain('answer_option: "keep-placeholder"');
    expect(run(answers, "symbolic-ref", "--short", "HEAD")).toBe(ANSWERS_BRANCH);
    expect(run(answers, "status", "--porcelain")).toBe("");
    expect(run(answers, "log", "-1", "--format=%s")).toBe(
      "answer(bro-2795-canvas.yaml): product-name -> keep-placeholder",
    );
    // The owner's checkouts are untouched; the next read shows it answered, in the batch.
    expect(await readFile(join(repo, ".control", "asks", "bro-2795-canvas.yaml"), "utf8")).toBe(CANVAS);
    const again = find((await asks.read()).all, "product-name");
    expect([again.state, again.batched, again.home.kind]).toEqual(["answered", true, "main"]);
    const seen = paseoAsksRead(join(answers, ".control", "asks"));
    expect(seen.asks.find((entry) => entry.id === "product-name")?.state).toBe("answered");
    if (existsSync(ASK_LEDGER)) {
      const before = validates(join(repo, ".control", "asks", "bro-2795-canvas.yaml"));
      const after = validates(path);
      expect([before.status, after.status, after.stdout.trim()]).toEqual([
        0,
        0,
        "ask-ledger: 1 ask(s), 0 decision(s), 0 error(s)",
      ]);
    }
  });

  test("the answers worktree takes origin/main's newer asks before an answer, and keeps the answers it holds", async () => {
    const { repo, origin, root, state, asks } = await workspace();
    const first = find((await asks.read()).all, "product-name");
    await asks.answer({
      ledger: first.ledger,
      home: "origin/main",
      uid: null,
      id: first.id,
      hash: first.hash,
      option: "name-now",
      note: "",
    });
    // Main gains a ledger, from another clone.
    const other = join(root, "other");
    run(root, "clone", "--quiet", origin, other);
    await writeFile(join(other, ".control", "asks", "later.yaml"), CANVAS.replace("product-name", "later-ask"));
    run(other, "add", ".");
    run(other, "commit", "--quiet", "-m", "later");
    run(other, "push", "--quiet", "origin", "main");
    run(repo, "fetch", "--quiet", "origin");
    const later = find((await asks.read()).all, "later-ask");
    expect(later.home.kind).toBe("main");
    await asks.answer({
      ledger: "later.yaml",
      home: "origin/main",
      uid: null,
      id: "later-ask",
      hash: later.hash,
      option: null,
      note: "Later.",
    });
    const answers = join(state, "control-answers");
    expect(await readFile(join(answers, ".control", "asks", "bro-2795-canvas.yaml"), "utf8")).toContain(
      'answer_option: "name-now"',
    );
    expect(await readFile(join(answers, ".control", "asks", "later.yaml"), "utf8")).toContain('answer: "Later."');
    expect(run(answers, "status", "--porcelain")).toBe("");
  });

  test("an answer to a home it no longer has, or to an entry changed since it was read, is refused", async () => {
    const { repo, asks } = await workspace();
    const merge = find((await asks.read()).all, "A1");
    const input = { ledger: merge.ledger, uid: null, id: "A1", hash: merge.hash, option: "hold", note: "" };
    await expect(asks.answer({ ...input, home: "origin/main" })).rejects.toThrow("now lives in");
    await writeFile(
      join(repo, ".control", "asks", "2026-10-01-merge.yaml"),
      MERGE.replace("It touches", "It still touches"),
    );
    await expect(asks.answer({ ...input, home: repo })).rejects.toThrow("changed since you read it");
    await expect(asks.answer({ ...input, ledger: "../x.yaml", home: repo })).rejects.toThrow("is not a ledger name");
  });

  test("a worktree that answered an ask locally is its home; once main records the answer, main closes it", async () => {
    const { root, repo, asks } = await workspace();
    const tree = join(root, "arc-tree");
    run(repo, "worktree", "add", "--quiet", "-b", "arc", tree, "origin/main");
    const answered = CANVAS.replace("    status: open\n", '    status: resolved\n    answer: "Keep it."\n');
    await writeFile(join(tree, ".control", "asks", "bro-2795-canvas.yaml"), answered);
    const local = find((await asks.read()).all, "product-name");
    expect([local.state, local.home.kind, local.home.path]).toEqual(["answered", "checkout", await realpath(tree)]);
    // The arc lands it: committed in the worktree and pushed to main. The worktree's copy is no longer local.
    run(tree, "commit", "--quiet", "-am", "answer");
    run(tree, "push", "--quiet", "origin", "arc:main");
    run(repo, "fetch", "--quiet", "origin");
    const landed = find((await asks.read()).all, "product-name");
    expect([landed.state, landed.home.kind]).toEqual(["answered", "main"]);
  });

  test("a fetch of origin/main runs in the background, at most every five minutes", async () => {
    const { repo, root, origin, state } = await workspace();
    let now = 1_000_000;
    const asks = new WorkspaceAsks({
      controlRepo: repo,
      answersPath: join(state, "control-answers"),
      lockRoot: join(state, "locks"),
      receipts: join(state, "asks.jsonl"),
      now: () => now,
      ttlMs: 0,
    });
    const other = join(root, "other");
    run(root, "clone", "--quiet", origin, other);
    await writeFile(join(other, ".control", "asks", "fetched.yaml"), CANVAS.replace("product-name", "fetched-ask"));
    run(other, "add", ".");
    run(other, "commit", "--quiet", "-m", "fetched");
    run(other, "push", "--quiet", "origin", "main");
    await asks.read();
    await asks.settled();
    expect((await asks.read()).all.some((entry) => entry.id === "fetched-ask")).toBe(true);
    expect((await asks.read()).main?.fetchedAt).not.toBeNull();
    // Within five minutes, no second fetch.
    const sha = run(repo, "rev-parse", "origin/main");
    run(other, "commit", "--quiet", "--allow-empty", "-m", "again");
    run(other, "push", "--quiet", "origin", "main");
    now += 60_000;
    await asks.read();
    await asks.settled();
    expect(run(repo, "rev-parse", "origin/main")).toBe(sha);
  });

  test("an answer fetches origin/main first: an ask answered upstream since the last fetch is not answered again", async () => {
    const { repo, root, origin, state } = await workspace();
    let now = 1_000_000;
    const asks = new WorkspaceAsks({
      controlRepo: repo,
      answersPath: join(state, "control-answers"),
      lockRoot: join(state, "locks"),
      receipts: join(state, "asks.jsonl"),
      now: () => now,
      ttlMs: 0,
    });
    const canvas = find((await asks.read()).all, "product-name");
    await asks.settled();
    const other = join(root, "other");
    run(root, "clone", "--quiet", origin, other);
    await writeFile(
      join(other, ".control", "asks", "bro-2795-canvas.yaml"),
      CANVAS.replace("status: open", "status: resolved"),
    );
    run(other, "commit", "--quiet", "-am", "answered upstream");
    run(other, "push", "--quiet", "origin", "main");
    now += 60_000;
    const input = {
      ledger: canvas.ledger,
      home: "origin/main",
      uid: null,
      id: canvas.id,
      hash: canvas.hash,
      option: "name-now",
      note: "",
    };
    await expect(asks.answer(input)).rejects.toThrow("already answered or retired");
    expect(existsSync(join(state, "control-answers"))).toBe(false);
  });

  test("an answer waits for a fetch in flight, and says when origin/main could not be fetched first", async () => {
    const { repo, state } = await workspace();
    let now = 1_000_000;
    const asks = new WorkspaceAsks({
      controlRepo: repo,
      answersPath: join(state, "control-answers"),
      lockRoot: join(state, "locks"),
      receipts: join(state, "asks.jsonl"),
      now: () => now,
      ttlMs: 0,
    });
    run(repo, "remote", "set-url", "origin", join(state, "nowhere.git"));
    // The read starts a fetch; the answer, at once, waits for it rather than judging on what was there.
    const merge = find((await asks.read()).all, "A1");
    const { warning } = await asks.answer({
      ledger: merge.ledger,
      home: repo,
      uid: null,
      id: "A1",
      hash: merge.hash,
      option: "hold",
      note: "",
    });
    expect(warning).toContain("origin/main could not be fetched first");
    expect(warning).toContain("nowhere.git");
    // Within the window after a failure, the failure is still said.
    now += 5_000;
    await writeFile(join(repo, ".control", "asks", "third.yaml"), MERGE.replace("A1", "C1"));
    const third = find((await asks.read()).all, "C1");
    const again = await asks.answer({
      ledger: "third.yaml",
      home: repo,
      uid: null,
      id: "C1",
      hash: third.hash,
      option: "hold",
      note: "",
    });
    expect(again.warning).toContain("could not be fetched first");
  });

  test("a commit a hook refuses says why; the answers worktree then takes no answer until it is clean", async () => {
    const { root, repo, asks } = await workspace();
    const hooks = join(root, "hooks");
    await mkdir(hooks);
    await writeFile(
      join(hooks, "pre-commit"),
      "#!/bin/sh\necho '=== gate ==='\necho '  [FAIL] no commits today' >&2\nexit 1\n",
      { mode: 0o755 },
    );
    run(repo, "config", "core.hooksPath", hooks);
    const canvas = find((await asks.read()).all, "product-name");
    const { ask, warning } = await asks.answer({
      ledger: canvas.ledger,
      home: "origin/main",
      uid: null,
      id: canvas.id,
      hash: canvas.hash,
      option: "name-now",
      note: "",
    });
    expect(ask.state).toBe("answered");
    expect(warning).toContain("[FAIL] no commits today");
    expect(warning).not.toContain("=== gate ===");
    // The answer stays in its file, and is never swept into another answer's commit.
    await writeFile(join(repo, ".control", "asks", "second.yaml"), MERGE.replace("A1", "B1"));
    run(repo, "add", ".control/asks/second.yaml");
    run(repo, "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "second");
    run(repo, "-c", "core.hooksPath=/dev/null", "push", "--quiet", "origin", "HEAD:main");
    run(repo, "fetch", "--quiet", "origin");
    const second = find((await asks.read()).all, "B1");
    await expect(
      asks.answer({
        ledger: "second.yaml",
        home: "origin/main",
        uid: null,
        id: "B1",
        hash: second.hash,
        option: "hold",
        note: "",
      }),
    ).rejects.toThrow("has changes not committed (.control/asks/bro-2795-canvas.yaml)");
  });

  test("an answers batch that cannot take origin/main's latest is refused, and left as it was", async () => {
    const { repo, root, origin, state, asks } = await workspace();
    const canvas = find((await asks.read()).all, "product-name");
    await asks.answer({
      ledger: canvas.ledger,
      home: "origin/main",
      uid: null,
      id: canvas.id,
      hash: canvas.hash,
      option: "name-now",
      note: "",
    });
    // Main rewrites the same lines the batch answered, and adds an ask to answer.
    const other = join(root, "other");
    run(root, "clone", "--quiet", origin, other);
    await writeFile(
      join(other, ".control", "asks", "bro-2795-canvas.yaml"),
      `${CANVAS.replace("status: open", "status: deferred")}  - id: later\n    ask: "Later?"\n    blocking: false\n    default: wait\n`,
    );
    run(other, "commit", "--quiet", "-am", "edited upstream");
    run(other, "push", "--quiet", "origin", "main");
    run(repo, "fetch", "--quiet", "origin");
    const later = find((await asks.read()).all, "later");
    await expect(
      asks.answer({
        ledger: canvas.ledger,
        home: "origin/main",
        uid: null,
        id: "later",
        hash: later.hash,
        option: null,
        note: "Now.",
      }),
    ).rejects.toThrow("could not take origin/main's latest (it conflicts in .control/asks/bro-2795-canvas.yaml)");
    const answers = join(state, "control-answers");
    expect(run(answers, "status", "--porcelain")).toBe("");
    expect(run(answers, "log", "-1", "--format=%s")).toBe("answer(bro-2795-canvas.yaml): product-name -> name-now");
  });

  test("an answers worktree whose folder is gone is made again; the branch checked out elsewhere is refused", async () => {
    const { root, repo, state, asks } = await workspace();
    const answers = join(state, "control-answers");
    const canvas = find((await asks.read()).all, "product-name");
    await asks.answer({
      ledger: canvas.ledger,
      home: "origin/main",
      uid: null,
      id: canvas.id,
      hash: canvas.hash,
      option: "name-now",
      note: "",
    });
    // A cleared state dir: the folder is gone, git still lists it.
    await rm(answers, { recursive: true, force: true });
    await writeFile(join(repo, ".control", "asks", "fourth.yaml"), MERGE.replace("A1", "D1"));
    run(repo, "add", ".control/asks/fourth.yaml");
    run(repo, "commit", "--quiet", "-m", "fourth");
    run(repo, "push", "--quiet", "origin", "HEAD:main");
    run(repo, "fetch", "--quiet", "origin");
    const fourth = find((await asks.read()).all, "D1");
    await asks.answer({
      ledger: "fourth.yaml",
      home: "origin/main",
      uid: null,
      id: "D1",
      hash: fourth.hash,
      option: "hold",
      note: "",
    });
    expect(run(answers, "log", "--no-merges", "-2", "--format=%s").split("\n")).toEqual([
      "answer(fourth.yaml): D1 -> hold",
      "answer(bro-2795-canvas.yaml): product-name -> name-now",
    ]);
    // Checked out in a live worktree of its own somewhere else: refused, saying where.
    await rm(answers, { recursive: true, force: true });
    run(repo, "worktree", "prune");
    run(repo, "worktree", "add", "--quiet", join(root, "elsewhere"), "maestro/answers");
    await writeFile(join(repo, ".control", "asks", "fifth.yaml"), MERGE.replace("A1", "E1"));
    run(repo, "add", ".control/asks/fifth.yaml");
    run(repo, "commit", "--quiet", "-m", "fifth");
    run(repo, "push", "--quiet", "origin", "HEAD:main");
    run(repo, "fetch", "--quiet", "origin");
    const fifth = find((await asks.read()).all, "E1");
    await expect(
      asks.answer({
        ledger: "fifth.yaml",
        home: "origin/main",
        uid: null,
        id: "E1",
        hash: fifth.hash,
        option: "hold",
        note: "",
      }),
    ).rejects.toThrow(`maestro/answers is checked out at ${join(root, "elsewhere")}`);
  });

  test("an answers-worktree ledger that cannot be read is said, not skipped", async () => {
    const { state, asks } = await workspace();
    const canvas = find((await asks.read()).all, "product-name");
    await asks.answer({
      ledger: canvas.ledger,
      home: "origin/main",
      uid: null,
      id: canvas.id,
      hash: canvas.hash,
      option: "name-now",
      note: "",
    });
    await writeFile(join(state, "control-answers", ".control", "asks", "bro-2795-canvas.yaml"), "asks: [unclosed\n");
    const read = await asks.read();
    expect(read.warnings.join(" ")).toContain("The answers worktree's bro-2795-canvas.yaml could not be read");
    expect(find(read.all, "product-name").state).toBe("open");
  });

  test("with no origin/main, no ask is read, and the view says why", async () => {
    const { repo, asks } = await workspace();
    run(repo, "update-ref", "-d", "refs/remotes/origin/main");
    const read = await asks.read();
    expect([read.all, read.main]).toEqual([[], null]);
    expect(read.warnings[0]).toContain("has no origin/main, and the home rule needs it");
  });

  test("no control repo reads as no asks, and a folder that is not a git repo says so", async () => {
    const root = await mkdtemp(join(tmpdir(), "maestro-nocontrol-"));
    scratch.push(root);
    const options = {
      answersPath: join(root, "a"),
      lockRoot: join(root, "l"),
      receipts: join(root, "r"),
      fetch: false,
    };
    expect((await new WorkspaceAsks({ ...options, controlRepo: join(root, "none") }).read()).all).toEqual([]);
    const plain = new WorkspaceAsks({ ...options, controlRepo: root });
    expect((await plain.read()).warnings[0]).toContain("could not be read as a git repo");
  });
});
