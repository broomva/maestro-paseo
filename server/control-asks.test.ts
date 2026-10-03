import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AnswerInput,
  acquireLock,
  answerDecision,
  decisionsOf,
  entryHash,
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

const AT = new Date("2026-10-03T17:00:00.000Z");
/** An answer as the Fleet view sends it, the entry's hash left unchecked unless a test gives one. */
const input = (extra: Partial<AnswerInput>): AnswerInput => ({
  uid: null,
  id: "A10",
  hash: null,
  option: null,
  note: "",
  ...extra,
});
const answered = (source: string, extra: Partial<AnswerInput>) =>
  withAnswer(source, "test-arc.yaml", input(extra), AT).out;

describe("reading decision asks", () => {
  test("each ask's decision layer: stakes, why you, the options with consequences, recommended and the default", () => {
    const [open, answer] = decisionsOf(LEDGER, "test-arc.yaml");
    expect(open).toEqual({
      ledger: "test-arc.yaml",
      uid: null,
      id: "A10",
      hash: expect.stringMatching(/^[0-9a-f]{16}$/),
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
    expect([answer?.uid, answer?.state, answer?.answer]).toEqual([
      "7d1e0c2a-5b8f-4e1a-9c4d-2f6b8a0e3c91",
      "answered",
      "Merge it.",
    ]);
  });

  test("handles that name more than one ask are shown refused, and never answered", () => {
    const ids = "asks:\n  - id: A1\n    ask: one\n  - id: A1\n    ask: two\n";
    expect(decisionsOf(ids, "l.yaml").map((ask) => ask.refusal?.slice(0, 39))).toEqual([
      "Two asks in l.yaml are named A1 and nei",
      "Two asks in l.yaml are named A1 and nei",
    ]);
    expect(() => answered(ids, { id: "A1", note: "x" })).toThrow("neither has a uid");
    // A uid used twice: the second entry must never take an answer meant for the first, or the other way round.
    const uids = "asks:\n  - id: a\n    uid: u1\n    ask: one\n  - id: b\n    uid: u1\n    ask: two\n";
    expect(decisionsOf(uids, "l.yaml")[1]?.refusal).toContain("share the uid u1");
    expect(() => answered(uids, { uid: "u1", id: "b", note: "x" })).toThrow("share the uid u1");
    // A uid-less ask sharing its handle with an ask that has a uid is the only one that goes by it: answered, itself.
    const mixed = "asks:\n  - id: a\n    uid: u1\n    ask: one\n  - id: a\n    ask: two\n";
    expect(decisionsOf(mixed, "l.yaml").map((ask) => ask.refusal)).toEqual([null, null]);
    const out = answered(mixed, { id: "a", note: "yes" });
    expect(decisionsOf(out, "l.yaml").map((ask) => [ask.uid, ask.state])).toEqual([
      ["u1", "open"],
      [null, "answered"],
    ]);
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
  test("only the entry changes: answer, answer_option, answered_at, answered_by, status, within the spec's bound", () => {
    const out = answered(LEDGER, { option: "drop" });
    const before = LEDGER.split("\n");
    const after = out.split("\n");
    expect(after.filter((line) => !before.includes(line))).toEqual([
      '    answer: "Drop all four: They stay in this ledger, with no ticket."',
      '    answer_option: "drop"',
      '    answered_at: "2026-10-03T17:00:00Z"',
      '    answered_by: "owner:maestro"',
      '    status: "resolved"',
    ]);
    // k = 5 keys, m = 1 line, r = 0 keys there before: added <= k + (m - 1), removed <= r.
    expect(before.filter((line) => !after.includes(line))).toEqual([]);
    expect(out.indexOf('status: "resolved"')).toBeLessThan(out.indexOf("  - id: A11"));
    expect(out.indexOf('answer: "Drop')).toBeGreaterThan(out.indexOf("asked_at:      2026-10-01T03:27Z"));
    const [ask] = decisionsOf(out, "test-arc.yaml");
    expect([ask?.state, ask?.answerOption, ask?.answeredAt]).toEqual(["answered", "drop", "2026-10-03T17:00:00Z"]);
  });

  test("your words beside an option, or alone; a multi-line answer stays one line, within the bound", () => {
    const both = answered(LEDGER, { option: "ticket-all", note: "Under BRO-2800.\nNot this week." });
    expect(decisionsOf(both, "test-arc.yaml")[0]?.answer).toBe(
      "File all four: Each becomes a Linear issue.\nUnder BRO-2800.\nNot this week.",
    );
    // k = 5 keys and an answer of m = 3 lines: at most k + (m - 1) = 7 lines added; one line per key is 5.
    expect(both.split("\n").length - LEDGER.split("\n").length).toBe(5);
    const words = answered(LEDGER, { note: "Hold it." });
    expect(words).toContain('    answer: "Hold it."\n');
    expect(words).not.toContain("answer_option");
    expect(() => answered(LEDGER, { note: "  " })).toThrow("Choose an option or write an answer.");
  });

  test("keys the entry already has are rewritten in place, whatever their shape: null, empty, or a block scalar", () => {
    const shapes = [
      "asks:\n  - id: a\n    ask: q\n    answered_at: null\n    status: open # still waiting\n  - id: b\n",
      "asks:\n  - id: a\n    ask: q\n    answered_at:\n    status: open\n  - id: b\n",
      "asks:\n  - id: a\n    ask: q\n    status: >\n      open for now\n\n  - id: b\n",
    ];
    for (const source of shapes) {
      const out = answered(source, { id: "a", note: "yes" });
      const [a, b] = decisionsOf(out, "l.yaml");
      expect([a?.state, a?.answer, a?.answeredAt, b?.state]).toEqual([
        "answered",
        "yes",
        "2026-10-03T17:00:00Z",
        "open",
      ]);
      expect(out.split("\n").length - source.split("\n").length).toBeLessThanOrEqual(3);
    }
    expect(answered(shapes[0] ?? "", { id: "a", note: "yes" })).toContain('    status: "resolved" # still waiting\n');
  });

  test("the corpus's other spellings and line endings: open_asks, CRLF; a flow-style entry is refused", () => {
    const open = answered("open_asks:\n  - id: a\n    ask: q\n", { id: "a", note: "yes" });
    expect(decisionsOf(open, "l.yaml")[0]?.state).toBe("answered");
    const crlf = answered("asks:\r\n  - id: a\r\n    ask: q\r\n", { id: "a", note: "yes" });
    expect(crlf.replace(/\r\n/g, "")).not.toContain("\n");
    expect(decisionsOf(crlf, "l.yaml")[0]?.state).toBe("answered");
    expect(() => answered("asks:\n  - {id: a, ask: q}\n", { id: "a", note: "yes" })).toThrow("flow style");
  });

  test("an edit that would change anything but the answer's keys is refused, and nothing is written", () => {
    // A keep-chomped block scalar owns the blank lines after it: an append there would change its value.
    const keep = "asks:\n  - id: a\n    ask: |+\n      q\n\n\n  - id: b\n";
    expect(() => answered(keep, { id: "a", note: "yes" })).toThrow("without changing anything else");
  });

  test("refuses an ask already answered, changed since you read it, an option it no longer offers, or gone", () => {
    const uid = "7d1e0c2a-5b8f-4e1a-9c4d-2f6b8a0e3c91";
    expect(() => answered(LEDGER, { uid, id: "A11", note: "x" })).toThrow("already answered");
    expect(() => answered(LEDGER, { option: "merge" })).toThrow("no longer offers that option");
    expect(() => answered(LEDGER, { id: "A99", note: "x" })).toThrow("no longer holds the ask A99");
    const [a10] = decisionsOf(LEDGER, "test-arc.yaml");
    expect(answered(LEDGER, { hash: a10?.hash ?? "", note: "x" })).toContain('answer: "x"');
    // The writer replaced A10's question between your read and your answer.
    const replaced = LEDGER.replace("file or drop?", "merge or close?");
    expect(() => withAnswer(replaced, "test-arc.yaml", input({ hash: a10?.hash ?? "", note: "x" }), AT)).toThrow(
      "changed since you read it",
    );
    expect(entryHash({ b: 1, a: 2 })).toBe(entryHash({ a: 2, b: 1 }));
  });

  test("an ask with a uid is found by its uid, not its handle", () => {
    const source = LEDGER.replace('    answer: "Merge it."\n    answered_at: 2026-10-02T10:00:00Z\n', "");
    const out = answered(source, { uid: "7d1e0c2a-5b8f-4e1a-9c4d-2f6b8a0e3c91", id: "A11", note: "Merge it." });
    const [a10, a11] = decisionsOf(out, "test-arc.yaml");
    expect([a10?.state, a11?.state]).toEqual(["open", "answered"]);
  });

  test("under the lock, through a temp file renamed over the ledger: its mode kept, no temp or lock left, a receipt", async () => {
    const { asks, path, locks, receipts } = await ledgerIn();
    const { ask, warning } = await answerDecision(path, input({ option: "ticket-all" }), {
      lockRoot: locks,
      receipts,
      now: () => AT.getTime(),
    });
    expect([ask.state, ask.answerOption, warning]).toEqual(["answered", "ticket-all", null]);
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
      originAgentId: null,
      entryHash: decisionsOf(LEDGER, "test-arc.yaml")[0]?.hash,
      answerOption: "ticket-all",
      answer: "File all four: Each becomes a Linear issue.",
    });
    expect((await readDecisions(asks)).asks.find((entry) => entry.id === "A10")?.state).toBe("answered");
  });

  test("a receipt that cannot be written is said, and the answer stands", async () => {
    const { path, locks, dir } = await ledgerIn();
    await writeFile(join(dir, "not-a-folder"), "");
    const { ask, warning } = await answerDecision(path, input({ option: "drop" }), {
      lockRoot: locks,
      receipts: join(dir, "not-a-folder", "asks.jsonl"),
    });
    expect(ask.state).toBe("answered");
    expect(warning).toContain("its receipt was not written");
  });

  test("a writer whose lock was taken over before its rename writes nothing, and leaves no temp file", async () => {
    const { asks, path, locks, receipts } = await ledgerIn();
    const attempt = answerDecision(path, input({ option: "drop" }), {
      lockRoot: locks,
      receipts,
      beforeRename: async () => {
        const [dir] = await readdir(locks);
        await writeFile(join(locks, dir ?? "", "token"), "someone-else\n");
      },
    });
    await expect(attempt).rejects.toThrow("This ledger's lock was taken over; nothing was written.");
    expect(await readFile(path, "utf8")).toBe(LEDGER);
    expect(await readdir(asks)).toEqual(["test-arc.yaml"]);
    // Not ours to remove: the lock stays with whoever holds its token now.
    expect(await readdir(locks)).toHaveLength(1);
  });

  // The workspace's own validator, where this machine has it: an answer must leave a valid ledger valid.
  const validator = join(homedir(), "broomva", "scripts", "ask_ledger.py");
  test.skipIf(!existsSync(validator))("ask_ledger.py validate passes before and after the answer", async () => {
    const { path, locks, receipts } = await ledgerIn();
    const validate = () => spawnSync("python3", [validator, "validate", path], { encoding: "utf8" });
    expect(validate().status).toBe(0);
    await answerDecision(path, input({ option: "drop", note: "Not now.\nMaybe later." }), {
      lockRoot: locks,
      receipts,
    });
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
    const holder = spawn("/bin/sleep", ["30"]);
    try {
      await mkdir(locks, { recursive: true });
      const dir = join(locks, `${await lockKey(path)}.d`);
      await mkdir(dir);
      await writeFile(join(dir, "pid"), `${holder.pid}\n`);
      await writeFile(join(dir, "token"), "theirs\n");
      const old = new Date(Date.now() - 10 * LOCK_STALE_MS);
      await utimes(dir, old, old);
      await expect(
        answerDecision(path, input({ option: "drop" }), { lockRoot: locks, receipts, waitMs: 300 }),
      ).rejects.toThrow(`Another writer holds this ledger's lock (pid ${holder.pid})`);
      expect(await readFile(path, "utf8")).toBe(LEDGER);
      expect(await readdir(locks)).toEqual([`${await lockKey(path)}.d`]);
    } finally {
      holder.kill();
    }
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

  test("a lock of this process's own that it no longer holds is dropped at once; one it holds is waited on", async () => {
    const { path, locks } = await ledgerIn();
    const lock = await acquireLock(path, locks);
    // Held: a second take waits, and gives up.
    await expect(acquireLock(path, locks, { waitMs: 150 })).rejects.toThrow(`pid ${process.pid}`);
    // Released while its token could not be read: the directory stays behind, ours and no longer held.
    await writeFile(join(lock.dir, "token"), "garbled\n");
    await releaseLock(lock);
    expect(await readdir(locks)).toHaveLength(1);
    const again = await acquireLock(path, locks, { waitMs: 1000 });
    expect(again.token).not.toBe(lock.token);
    await releaseLock(again);
    expect(await readdir(locks)).toEqual([]);
  });
});
