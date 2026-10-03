import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLock,
  answerDecision,
  decisionsOf,
  LOCK_STALE_MS,
  lockKey,
  readDecisions,
  releaseLock,
  withAnswer,
} from "./control-asks";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** A ledger shaped like the real ones (maestro-paseo-gaps.yaml's A10), which ask_ledger.py validate passes. */
const LEDGER = `# Ask ledger: a test arc.
arc:    test-arc
opened: 2026-09-29T16:30Z
tz:     America/Bogota
lanes:  [lane-a]

asks:
  - id:            A10
    headline:      "Four small review follow-ups: ticket them, or drop them?"
    stakes:        "None blocks a lane; untracked, a test gap stays invisible."
    why_you:       "Scheduling is yours."
    options:
      - id: ticket-all
        label: "File all four"
        consequence: "Each becomes a Linear issue."
        reversible: true
        recommended: true
      - id: drop
        label: "Drop all four"
        consequence: "They stay in this ledger, with no ticket."
        reversible: true
    ask:           "Four review follow-ups are open and unscheduled: file or drop?"
    class:         decision
    gates:         []
    default:       "file all four once Linear is signed in"
    blocking:      false
    preanswerable: false
    exhausted:
      - "read: the PR comments hold no decision"
      - "default: available: none blocks a lane"
    asked_at:      2026-10-01T03:27Z

  - id: A11
    uid: 7d1e0c2a-5b8f-4e1a-9c4d-2f6b8a0e3c91
    ask: "Merge it?"
    class: decision
    gates: []
    default: "leave it open"
    blocking: false
    preanswerable: false
    exhausted: ["read: nothing on disk", "default: available"]
    answer: "Merge it."
    answered_at: 2026-10-02T10:00:00Z

decisions:
  - id: D1
    decision: "kept below the asks"
    scenario: "a decisions section after the asks list, so an answer appended to the last ask must land inside that ask and never under decisions"
    gap: "none"
    reach: "this ledger"
    reversal: "edit it back"
    verdict: sound
    confidence: high
`;

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "maestro-asks-"));
  roots.push(dir);
  return dir;
}

async function ledgerIn(source = LEDGER, mode = 0o640) {
  const dir = await root();
  const asks = join(dir, ".control", "asks");
  await mkdir(asks, { recursive: true });
  const path = join(asks, "test-arc.yaml");
  await writeFile(path, source);
  await chmod(path, mode);
  return { dir, asks, path, locks: join(dir, "locks"), receipts: join(dir, "state", "asks.jsonl") };
}

describe("reading decision asks", () => {
  test("each ask's decision layer: stakes, why you, the options with consequences, recommended and the default", () => {
    const [open, answered] = decisionsOf(LEDGER, "test-arc.yaml");
    expect(open).toEqual({
      ledger: "test-arc.yaml",
      uid: null,
      id: "A10",
      arc: "test-arc",
      headline: "Four small review follow-ups: ticket them, or drop them?",
      question: "Four review follow-ups are open and unscheduled: file or drop?",
      stakes: "None blocks a lane; untracked, a test gap stays invisible.",
      whyYou: "Scheduling is yours.",
      options: [
        {
          id: "ticket-all",
          label: "File all four",
          consequence: "Each becomes a Linear issue.",
          reversible: true,
          recommended: true,
        },
        {
          id: "drop",
          label: "Drop all four",
          consequence: "They stay in this ledger, with no ticket.",
          reversible: true,
          recommended: false,
        },
      ],
      fallback: "file all four once Linear is signed in",
      blocking: false,
      askedAt: "2026-10-01T03:27Z",
      answeredAt: null,
      answer: null,
      answerOption: null,
      state: "open",
      origin: null,
      refusal: null,
    });
    expect([answered?.uid, answered?.state, answered?.answer]).toEqual([
      "7d1e0c2a-5b8f-4e1a-9c4d-2f6b8a0e3c91",
      "answered",
      "Merge it.",
    ]);
  });

  test("two uid-less asks sharing an id are an id collision: shown, and refused", () => {
    const twice = LEDGER.replace(
      "  - id: A11\n    uid: 7d1e0c2a-5b8f-4e1a-9c4d-2f6b8a0e3c91\n",
      "  - id: A10\n",
    ).replace('    answer: "Merge it."\n    answered_at: 2026-10-02T10:00:00Z\n', "");
    const asks = decisionsOf(twice, "test-arc.yaml");
    expect(asks.map((ask) => ask.refusal?.slice(0, 51))).toEqual([
      "Two asks in test-arc.yaml are named A10 and neither",
      "Two asks in test-arc.yaml are named A10 and neither",
    ]);
    expect(() =>
      withAnswer(twice, "test-arc.yaml", { uid: null, id: "A10", option: "drop", note: "" }, new Date()),
    ).toThrow("neither has a uid");
  });

  test("a root lists open asks, then the latest answered; an unreadable ledger is a warning, a missing root none", async () => {
    const { asks } = await ledgerIn();
    await writeFile(join(asks, "broken.yaml"), "asks: [\n");
    await writeFile(join(asks, ".test-arc.yaml.tmp-abc"), "not a ledger");
    const read = await readDecisions(asks);
    expect(read.asks.map((ask) => [ask.id, ask.state])).toEqual([
      ["A10", "open"],
      ["A11", "answered"],
    ]);
    expect(read.warnings).toHaveLength(1);
    expect(read.warnings[0]).toContain("broken.yaml");
    expect(await readDecisions(join(asks, "nowhere"))).toEqual({ asks: [], warnings: [] });
  });
});

describe("writing an answer", () => {
  const AT = new Date("2026-10-03T17:00:00.000Z");

  test("only the entry changes: answer, answer_option, answered_at, answered_by, status, within the spec's bound", () => {
    const out = withAnswer(LEDGER, "test-arc.yaml", { uid: null, id: "A10", option: "drop", note: "" }, AT);
    const before = LEDGER.split("\n");
    const after = out.split("\n");
    const added = after.filter((line) => !before.includes(line));
    expect(added).toEqual([
      '    answer: "Drop all four: They stay in this ledger, with no ticket."',
      '    answer_option: "drop"',
      '    answered_at: "2026-10-03T17:00:00Z"',
      '    answered_by: "owner:maestro"',
      '    status: "resolved"',
    ]);
    // k = 5 keys, m = 1 line, r = 0 keys there before: added <= k + (m - 1), removed <= r.
    expect(before.filter((line) => !after.includes(line))).toEqual([]);
    // Every added line sits inside A10's map: right after its last key, before A11.
    expect(out.indexOf('status: "resolved"')).toBeLessThan(out.indexOf("  - id: A11"));
    expect(out.indexOf('answer: "Drop')).toBeGreaterThan(out.indexOf("asked_at:      2026-10-01T03:27Z"));
    const [answered] = decisionsOf(out, "test-arc.yaml");
    expect([answered?.state, answered?.answerOption, answered?.answeredAt]).toEqual([
      "answered",
      "drop",
      "2026-10-03T17:00:00Z",
    ]);
  });

  test("your words beside an option, or alone; a multi-line answer stays one line, within the bound", () => {
    const both = withAnswer(
      LEDGER,
      "test-arc.yaml",
      { uid: null, id: "A10", option: "ticket-all", note: "Under BRO-2800.\nNot this week." },
      AT,
    );
    expect(decisionsOf(both, "test-arc.yaml")[0]?.answer).toBe(
      "File all four: Each becomes a Linear issue.\nUnder BRO-2800.\nNot this week.",
    );
    // k = 5 keys and an answer of m = 3 lines: at most k + (m - 1) = 7 lines added; one line per key is 5.
    expect(both.split("\n").length - LEDGER.split("\n").length).toBe(5);
    expect(both).toContain(
      '    answer: "File all four: Each becomes a Linear issue.\\nUnder BRO-2800.\\nNot this week."\n',
    );
    const words = withAnswer(LEDGER, "test-arc.yaml", { uid: null, id: "A10", option: null, note: "Hold it." }, AT);
    expect(words).toContain('    answer: "Hold it."\n');
    expect(words).not.toContain("answer_option");
    expect(() => withAnswer(LEDGER, "test-arc.yaml", { uid: null, id: "A10", option: null, note: "  " }, AT)).toThrow(
      "Choose an option or write an answer.",
    );
  });

  test("refuses an ask already answered, an option it no longer offers, and an ask that is gone", () => {
    const uid = "7d1e0c2a-5b8f-4e1a-9c4d-2f6b8a0e3c91";
    expect(() => withAnswer(LEDGER, "test-arc.yaml", { uid, id: "A11", option: null, note: "x" }, AT)).toThrow(
      "already answered",
    );
    expect(() => withAnswer(LEDGER, "test-arc.yaml", { uid: null, id: "A10", option: "merge", note: "" }, AT)).toThrow(
      "no longer offers that option",
    );
    expect(() => withAnswer(LEDGER, "test-arc.yaml", { uid: null, id: "A99", option: null, note: "x" }, AT)).toThrow(
      "no longer holds the ask A99",
    );
  });

  test("an ask with a uid is found by its uid, not its handle", () => {
    const source = LEDGER.replace('    answer: "Merge it."\n    answered_at: 2026-10-02T10:00:00Z\n', "");
    const out = withAnswer(
      source,
      "test-arc.yaml",
      { uid: "7d1e0c2a-5b8f-4e1a-9c4d-2f6b8a0e3c91", id: "A11", option: null, note: "Merge it." },
      AT,
    );
    const [a10, a11] = decisionsOf(out, "test-arc.yaml");
    expect([a10?.state, a11?.state]).toEqual(["open", "answered"]);
  });

  test("under the lock, through a temp file renamed over the ledger: its mode kept, no temp or lock left, a receipt", async () => {
    const { asks, path, locks, receipts } = await ledgerIn();
    const ask = await answerDecision(
      path,
      { uid: null, id: "A10", option: "ticket-all", note: "" },
      { lockRoot: locks, receipts, now: () => AT.getTime() },
    );
    expect([ask.state, ask.answerOption]).toEqual(["answered", "ticket-all"]);
    expect((await stat(path)).mode & 0o777).toBe(0o640);
    expect(await readdir(asks)).toEqual(["test-arc.yaml"]);
    expect(await readdir(locks)).toEqual([]);
    const [receipt] = (await readFile(receipts, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(receipt).toEqual({
      kind: "ask.answered",
      actor: "human",
      at: "2026-10-03T17:00:00Z",
      home: path,
      ledger: "test-arc.yaml",
      uid: null,
      id: "A10",
      askedAt: "2026-10-01T03:27Z",
      answerOption: "ticket-all",
      answer: "File all four: Each becomes a Linear issue.",
    });
    expect((await readDecisions(asks)).asks.find((entry) => entry.id === "A10")?.state).toBe("answered");
  });

  // The workspace's own validator, where this machine has it: an answer must leave a valid ledger valid.
  const validator = join(homedir(), "broomva", "scripts", "ask_ledger.py");
  test.skipIf(!existsSync(validator))("ask_ledger.py validate passes before and after the answer", async () => {
    const { path, locks, receipts } = await ledgerIn();
    const validate = () => spawnSync("python3", [validator, "validate", path], { encoding: "utf8" });
    expect(validate().status).toBe(0);
    await answerDecision(
      path,
      { uid: null, id: "A10", option: "drop", note: "Not now.\nMaybe later." },
      { lockRoot: locks, receipts },
    );
    const after = validate();
    expect(after.stdout).toContain(" 0 error(s)");
    expect(after.status).toBe(0);
  });
});

describe("the ledger lock", () => {
  test("lives at <k>.d, k the first 16 hex of sha256(realpath(dirname) + / + basename)", async () => {
    const { asks, path } = await ledgerIn();
    const expected = createHash("sha256")
      .update(`${await realpath(asks)}/test-arc.yaml`)
      .digest("hex")
      .slice(0, 16);
    expect(await lockKey(path)).toBe(expected);
  });

  test("a live holder is waited on and never reclaimed, however old: the answer is refused and nothing written", async () => {
    const { path, locks, receipts } = await ledgerIn();
    const held = await acquireLock(path, locks);
    const dir = join(locks, `${await lockKey(path)}.d`);
    const old = new Date(Date.now() - 10 * LOCK_STALE_MS);
    await utimes(dir, old, old);
    await expect(
      answerDecision(
        path,
        { uid: null, id: "A10", option: "drop", note: "" },
        { lockRoot: locks, receipts, waitMs: 200 },
      ),
    ).rejects.toThrow(`Another writer holds this ledger's lock (pid ${process.pid})`);
    expect(await readFile(path, "utf8")).toBe(LEDGER);
    await releaseLock(held);
    expect(await readdir(locks)).toEqual([]);
  });

  test("a dead holder's lock is reclaimed once 120 s old, not before; one with no pid yet is live until then", async () => {
    const { path, locks } = await ledgerIn();
    await mkdir(locks, { recursive: true });
    const dir = join(locks, `${await lockKey(path)}.d`);
    await mkdir(dir);
    // No pid file, fresh: a writer starting up.
    await expect(acquireLock(path, locks, { waitMs: 150 })).rejects.toThrow("a writer starting up");
    // A dead pid, fresh: still waited on.
    await writeFile(join(dir, "pid"), "999999 1\n");
    await expect(acquireLock(path, locks, { waitMs: 150 })).rejects.toThrow("pid 999999");
    // The same, past 120 s: reclaimed, and the lock is ours.
    const old = new Date(Date.now() - LOCK_STALE_MS - 5000);
    await utimes(dir, old, old);
    const lock = await acquireLock(path, locks, { waitMs: 1000 });
    expect((await readFile(join(lock.dir, "token"), "utf8")).trim()).toBe(lock.token);
    expect((await readFile(join(lock.dir, "pid"), "utf8")).split(" ")[0]).toBe(String(process.pid));
    await releaseLock(lock);
    expect(await readdir(locks)).toEqual([]);
  });

  test("a holder whose token was taken writes nothing and leaves the lock to its new owner", async () => {
    const { asks, path, locks } = await ledgerIn();
    const lock = await acquireLock(path, locks);
    await writeFile(join(lock.dir, "token"), "someone-else\n");
    await releaseLock(lock);
    expect(await readdir(locks)).toEqual([`${await lockKey(path)}.d`]);
    expect(await readdir(asks)).toEqual(["test-arc.yaml"]);
  });
});
