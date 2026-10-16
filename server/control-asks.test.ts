import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AnswerInput,
  AUDIT_LINES,
  answerDecision,
  decisionsOf,
  entryHash,
  readDecisions,
  withAnswer,
} from "./control-asks";
import { acquireLock, dropLeftovers, LOCK_STALE_MS, lockKey, releaseLock } from "./locks";

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
  test("the audit layer carries ids only: class and gates allowlisted, free text dropped, what was tried never sent", () => {
    const ledger = (fields: string) => `arc: a\nasks:\n  - id: X1\n    ask: "Go?"\n${fields}`;
    expect(decisionsOf(ledger(""), "a.yaml")[0]?.audit).toBeNull();
    // A lone string is a list of one; normal ids pass.
    expect(decisionsOf(ledger("    class: authority\n    gates: lane-x\n"), "a.yaml")[0]?.audit).toEqual({
      class: "authority",
      gates: ["lane-x"],
      withheld: 0,
    });
    expect(decisionsOf(ledger("    gates: [lane-a, 2, p20, required_checks]\n"), "a.yaml")[0]?.audit).toEqual({
      class: null,
      gates: ["lane-a", "2", "p20", "required_checks"],
      withheld: 0,
    });
    // Free text or anything secret-looking in class or gates is dropped; exhausted is never on the wire.
    const p = (...parts: string[]) => parts.join("");
    const loud = ledger(
      `    class: "${p("api_", "key=AbC123")}"\n    gates: ["needs the owner's call", "${p("Bearer ", "eyJhbGciOiJ9")}", ok-lane]\n    exhausted: ["read: ${p("sk", "-live-abcdef123456")}"]\n`,
    );
    // What is left home is counted, so the card can say the list is partial.
    expect(decisionsOf(loud, "a.yaml")[0]?.audit).toEqual({ class: null, gates: ["ok-lane"], withheld: 3 });
    expect(JSON.stringify(decisionsOf(loud, "a.yaml"))).not.toContain("live-abcdef");
    // Capped at AUDIT_LINES, each id at 48 characters.
    const many = Array.from({ length: 12 }, (_, at) => `lane-${at}`).join(", ");
    expect(decisionsOf(ledger(`    gates: [${many}]\n`), "a.yaml")[0]?.audit?.gates).toHaveLength(AUDIT_LINES);
    // Ids past the cap are not free text: nothing is said to be withheld.
    expect(decisionsOf(ledger(`    gates: [${many}]\n`), "a.yaml")[0]?.audit?.withheld).toBe(0);
    // A class too long to be an id is left home, and counted.
    expect(decisionsOf(ledger(`    class: ${"x".repeat(49)}\n`), "a.yaml")[0]?.audit).toEqual({
      class: null,
      gates: [],
      withheld: 1,
    });
  });

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
      answerNote: null,
      answerOther: null,
      allowOther: true,
      state: "open",
      origin: null,
      refusal: null,
      // No v2 fields (BRO-3167): an ask written before them reads with rich null, nothing else changes.
      rich: null,
      home: { kind: "root", path: "", branch: null },
      batched: false,
      waiting: false,
      idea: null,
      audit: { class: "decision", gates: [], withheld: 0 },
      initiative: null,
      // No fleet-reconcile prompt key: not a prompt ask (BRO-3001).
      promptSession: null,
      fate: null,
    });
    expect([answer?.uid, answer?.state, answer?.answer]).toEqual([
      "7d1e0c2a-5b8f-4e1a-9c4d-2f6b8a0e3c91",
      "answered",
      "Merge it.",
    ]);
  });

  test("an option changes nothing only by the ledger's own status_quo key; the ask's initiative, else the ledger's", () => {
    const source = [
      "arc: x",
      "initiative: ledger-wide",
      "asks:",
      "  - id: A1",
      "    initiative: own",
      "    options:",
      "      - { id: go, label: Go, consequence: It changes., reversible: true, recommended: true }",
      "      - { id: hold, label: Hold, consequence: Nothing changes., reversible: true, status_quo: true }",
      '      - { id: wait, label: "Keep as is", consequence: Nothing changes at all., reversible: true }',
      "  - id: A2",
      "    ask: two",
    ].join("\n");
    const [one, two] = decisionsOf(source, "x.yaml");
    // Only `status_quo: true` says so: an option whose words say nothing changes is not read as one.
    expect(one?.options.map((option) => [option.id, option.statusQuo ?? false])).toEqual([
      ["go", false],
      ["hold", true],
      ["wait", false],
    ]);
    expect([one?.initiative, two?.initiative]).toEqual(["own", "ledger-wide"]);
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
    // Right after the entry's id line, never at its end, where a writer appends the next ask (BRO-2827).
    expect(after[after.findIndex((line) => /^ {2}- id: +A10$/.test(line)) + 1]).toBe(
      '    answer: "Drop all four: They stay in this ledger, with no ticket."',
    );
    const [ask] = decisionsOf(out, "test-arc.yaml");
    expect([ask?.state, ask?.answerOption, ask?.answeredAt]).toEqual(["answered", "drop", "2026-10-03T17:00:00Z"]);
  });

  test("your words beside an option, or alone; a multi-line answer stays one line, within the bound", () => {
    const both = answered(LEDGER, { option: "ticket-all", note: "Under BRO-2800.\nNot this week." });
    expect(decisionsOf(both, "test-arc.yaml")[0]?.answer).toBe(
      "File all four: Each becomes a Linear issue.\nUnder BRO-2800.\nNot this week.",
    );
    // k = 6 keys (answer_note too, BRO-3146) and an answer of m = 3 lines: at most k + (m - 1) = 8 lines added;
    // one line per key is 6.
    expect(both.split("\n").length - LEDGER.split("\n").length).toBe(6);
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

  test("a key to write that holds a list or a map is the writer's: refused, never replaced by a line", () => {
    expect(() => answered("asks:\n  - id: a\n    status:\n      phase: waiting\n", { id: "a", note: "y" })).toThrow(
      "status holds a list or a map",
    );
    expect(() => answered("asks:\n  - id: a\n    answer: [one, two]\n", { id: "a", note: "y" })).toThrow(
      "answer holds a list or a map",
    );
  });

  test("an answer in words alone clears an option a writer left there, so it never says you chose one", () => {
    const source = "asks:\n  - id: a\n    ask: q\n    options:\n      - id: o1\n    answer_option: o1\n";
    const out = answered(source, { id: "a", note: "Neither." });
    expect(out).toContain("    answer_option: null\n");
    expect(decisionsOf(out, "l.yaml")[0]?.answerOption).toBeNull();
  });

  test("an edit that would change anything but the answer's keys is refused, and nothing is written", () => {
    // A flow-style entry has no line to write beside: an append after it would not read back as it was.
    const flow = "asks:\n  - { id: a, ask: q }\n  - id: b\n";
    expect(() => answered(flow, { id: "a", note: "yes" })).toThrow("without changing anything else");
  });

  test("a comment on the id line stays on it: the answer goes on the line after", () => {
    const out = answered("asks:\n  - id: a  # keep me\n    ask: q\n", { id: "a", note: "yes" });
    expect(out).toContain('  - id: a  # keep me\n    answer: "yes"\n');
  });

  test("a keep-chomped block scalar at the entry's end is left as it was: the answer is written beside the id", () => {
    const keep = "asks:\n  - id: a\n    ask: |+\n      q\n\n\n  - id: b\n";
    const out = answered(keep, { id: "a", note: "yes" });
    expect(out).toContain('  - id: a\n    answer: "yes"\n');
    expect(out).toContain("    ask: |+\n      q\n\n\n  - id: b\n");
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
      homeKind: "root",
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

  // BRO-3146: "I can't add optional text or instructions besides the choice options". Words beside an option are
  // its `answer_note`; words with no option, on an ask that offers options, are an Other answer (`answer_other`).
  test("words beside an option are its answer_note, kept apart from the option and in the full answer too", () => {
    const out = answered(LEDGER, { option: "ticket-all", note: "Under BRO-2800.\nNot this week." });
    const [ask] = decisionsOf(out, "test-arc.yaml");
    expect([ask?.answerOption, ask?.answerNote, ask?.answerOther]).toEqual([
      "ticket-all",
      "Under BRO-2800.\nNot this week.",
      null,
    ]);
    expect(ask?.answer).toBe("File all four: Each becomes a Linear issue.\nUnder BRO-2800.\nNot this week.");
    expect(out).toContain('    answer_note: "Under BRO-2800.\\nNot this week."\n');
    // An option alone writes no note key at all: an answer from before BRO-3146 reads exactly as it did.
    expect(answered(LEDGER, { option: "drop" })).not.toContain("answer_note");
  });

  test("words and no option, on an ask that offers options, are an Other answer: answer_other, no option", () => {
    const out = answered(LEDGER, { note: "Ask Legal first." });
    const [ask] = decisionsOf(out, "test-arc.yaml");
    expect([ask?.answerOption, ask?.answerOther, ask?.answerNote, ask?.answer]).toEqual([
      null,
      "Ask Legal first.",
      null,
      "Ask Legal first.",
    ]);
    expect(out).toContain('    answer_other: "Ask Legal first."\n');
  });

  test("an ask written with no options is answered in words as before: no Other, no note key", () => {
    const out = answered("asks:\n  - id: a\n    ask: q\n", { id: "a", note: "Yes, go." });
    expect(out).not.toContain("answer_other");
    expect(out).not.toContain("answer_note");
    expect(decisionsOf(out, "l.yaml")[0]?.answer).toBe("Yes, go.");
  });

  test("an ask with allow_other: false refuses an Other answer, and still takes a note beside an option", () => {
    const closed = LEDGER.replace(
      "    class:         decision\n",
      "    class:         decision\n    allow_other:   false\n",
    );
    expect(decisionsOf(closed, "test-arc.yaml")[0]?.allowOther).toBe(false);
    expect(decisionsOf(LEDGER, "test-arc.yaml")[0]?.allowOther).toBe(true);
    expect(() => answered(closed, { note: "Something else." })).toThrow("takes one of its options");
    const noted = decisionsOf(answered(closed, { option: "drop", note: "Fine." }), "test-arc.yaml")[0];
    expect([noted?.answerOption, noted?.answerNote]).toEqual(["drop", "Fine."]);
  });

  test("allow_other in any spelling but true refuses Other: an unquoted no is false to the YAML 1.1 validator", () => {
    for (const spelling of ["false", "no", "No", "off", "n", '"false"', "null", "~", ""]) {
      const closed = LEDGER.replace(
        "    class:         decision\n",
        `    class:         decision\n    allow_other:   ${spelling}\n`,
      );
      expect(decisionsOf(closed, "test-arc.yaml")[0]?.allowOther).toBe(false);
      expect(() => answered(closed, { note: "Something else." })).toThrow("takes one of its options");
    }
    const open = LEDGER.replace(
      "    class:         decision\n",
      "    class:         decision\n    allow_other:   true\n",
    );
    expect(decisionsOf(answered(open, { note: "Something else." }), "test-arc.yaml")[0]?.answerOther).toBe(
      "Something else.",
    );
  });

  test("an answer clears a note or Other a writer left on the open entry, so it never says words you did not", () => {
    const stale = LEDGER.replace(
      "    class:         decision\n",
      "    class:         decision\n    answer_note: stale\n",
    );
    const out = answered(stale, { option: "drop" });
    expect(out).toContain("    answer_note: null\n");
    expect(decisionsOf(out, "test-arc.yaml")[0]?.answerNote).toBeNull();
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

/** An ideas ledger as workspace#894 writes one. */
const IDEAS = `arc: ideas-maestro
opened: 2026-10-03T12:00Z
tz: America/Bogota
lanes: [triage]
asks:
  - id: I1
    class: idea
    initiative: maestro
    idea: "An Initiatives tab"
    source: {kind: pr, ref: "broomva/workspace#894"}
    evidence: BRO-2802
    ask: "Develop, park or kill?"
    headline: "Build it, or park it?"
    stakes: "Ideas are forgotten."
    why_you: "Your call."
    options:
      - {id: develop, label: Develop, consequence: "A work item", reversible: true}
      - {id: park, label: "Park until 2026-11-02", consequence: "Comes back", reversible: true, recommended: true}
      - {id: kill, label: Kill, consequence: "Closed", reversible: true}
    default: "park until 2026-11-02"
    wake: 2026-11-02
    blocking: false
    asked_at: 2026-10-03T12:00Z
    answered_at: null
`;

describe("an idea's answer", () => {
  const idea = (extra: Partial<AnswerInput>) =>
    withAnswer(IDEAS, "ideas-maestro.yaml", input({ id: "I1", ...extra }), AT);

  test("park writes the wake you chose in place of the proposed one, and nothing else but the answer", () => {
    const { out, ask } = idea({ option: "park", wake: "2026-11-20" });
    const before = IDEAS.split("\n");
    const after = out.split("\n");
    // New keys go beside the id; the wake and answered_at the idea held are rewritten where they were.
    expect(after.filter((line) => !before.includes(line))).toEqual([
      '    answer: "Park until 2026-11-02: Comes back\\nWake: 2026-11-20."',
      '    answer_option: "park"',
      '    answered_by: "owner:maestro"',
      '    status: "resolved"',
      '    wake: "2026-11-20"',
      '    answered_at: "2026-10-03T17:00:00Z"',
    ]);
    expect(before.filter((line) => !after.includes(line))).toEqual(["    wake: 2026-11-02", "    answered_at: null"]);
    expect([ask.state, ask.answerOption, ask.idea?.wake]).toEqual(["answered", "park", "2026-11-20"]);
  });

  test("park without a wake keeps the proposed one; develop and kill take none", () => {
    expect(idea({ option: "park" }).ask.idea?.wake).toBe("2026-11-02");
    expect(idea({ option: "develop" }).ask.answerOption).toBe("develop");
    expect(() => idea({ option: "kill", wake: "2026-11-20" })).toThrow("Only an idea you park takes a wake date");
  });

  test("a wake that is not a date, or has passed, is refused and nothing is written", () => {
    expect(() => idea({ option: "park", wake: "2026-13-40" })).toThrow("is not a date");
    // A day the calendar lacks: Date.parse would roll it into March, and ask_ledger.py refuses it.
    expect(() => idea({ option: "park", wake: "2027-02-30" })).toThrow("is not a date");
    expect(() => idea({ option: "park", wake: "2026-10-02" })).toThrow("has passed");
    // Today is not past: a park until today wakes at once, which is your call.
    expect(idea({ option: "park", wake: "2026-10-03" }).ask.idea?.wake).toBe("2026-10-03");
  });

  test("an idea takes develop, park or kill, never words alone", () => {
    expect(() => idea({ option: null, note: "sounds good" })).toThrow("choose develop, park or kill");
    const extra = IDEAS.replace(
      "      - {id: kill, label: Kill",
      '      - {id: later, label: Later, consequence: "Someday", reversible: true}\n      - {id: kill, label: Kill',
    );
    expect(() => withAnswer(extra, "ideas-maestro.yaml", input({ id: "I1", option: "later" }), AT)).toThrow(
      "choose develop, park or kill",
    );
  });

  test("a wake before the day the idea was asked is refused, as ask_ledger.py refuses it", () => {
    const later = IDEAS.replace("asked_at: 2026-10-03T12:00Z", "asked_at: 2026-10-04T01:00Z");
    expect(() =>
      withAnswer(later, "ideas-maestro.yaml", input({ id: "I1", option: "park", wake: "2026-10-03" }), AT),
    ).toThrow("before the idea was asked (2026-10-04)");
    expect(
      withAnswer(later, "ideas-maestro.yaml", input({ id: "I1", option: "park", wake: "2026-10-04" }), AT).ask.idea
        ?.wake,
    ).toBe("2026-10-04");
  });

  test("an ask that is not an idea takes no wake", () => {
    expect(() => answered(LEDGER, { option: "drop", wake: "2026-11-20" })).toThrow(
      "Only an idea you park takes a wake date",
    );
  });

  // MAESTRO_ASK_LEDGER_PY names a workspace checkout's validator; else the owner's ~/broomva copy. Skipped,
  // and said so, where neither is: CI has no workspace.
  const validatorScript = process.env.MAESTRO_ASK_LEDGER_PY ?? join(homedir(), "broomva", "scripts", "ask_ledger.py");
  test.skipIf(!existsSync(validatorScript))(
    "each answer Maestro writes still passes ask_ledger.py: develop, park with a wake, kill",
    async () => {
      for (const answer of [{ option: "develop" }, { option: "park", wake: "2026-11-20" }, { option: "kill" }]) {
        // Where an ideas ledger lives: .control/asks, beside the initiative file it names.
        const dir = await root();
        await mkdir(join(dir, ".control", "asks"), { recursive: true });
        await mkdir(join(dir, ".control", "initiatives"), { recursive: true });
        await writeFile(join(dir, ".control", "initiatives", "maestro.yaml"), "id: maestro\n");
        const path = join(dir, ".control", "asks", "ideas-maestro.yaml");
        await writeFile(path, idea(answer).out);
        const result = spawnSync(
          "python3",
          [validatorScript, "validate", path, "--require-decision", "--preauth", join(dir, "none.yaml")],
          { encoding: "utf8" },
        );
        // A validator older than workspace#894 has no idea class: nothing to hold this answer to yet.
        if (result.stdout.includes("class 'idea' not one of")) return;
        expect([answer.option, result.status, result.stdout]).toEqual([
          answer.option,
          0,
          expect.stringContaining("0 error(s)"),
        ]);
      }
    },
  );
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

  test("each scan drops the locks this process left behind, never one it holds or another writer's", async () => {
    const { path, locks } = await ledgerIn();
    const lock = await acquireLock(path, locks);
    await mkdir(join(locks, "0000000000000000.d"));
    await writeFile(join(locks, "0000000000000000.d", "pid"), "999999 1\n");
    await dropLeftovers(locks);
    expect((await readdir(locks)).sort()).toEqual(["0000000000000000.d", `${await lockKey(path)}.d`]);
    // Released while its token could not be read: left behind, and the next scan clears it.
    await writeFile(join(lock.dir, "token"), "garbled\n");
    await releaseLock(lock);
    await dropLeftovers(locks);
    expect(await readdir(locks)).toEqual(["0000000000000000.d"]);
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
