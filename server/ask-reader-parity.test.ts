/**
 * Maestro's half of the cross-reader parity corpus (BRO-3167, P20 r6). The validator's half is broomva/workspace
 * scripts/test_ask_reader_parity.py; this file is a byte-for-byte copy of that repo's
 * scripts/fixtures/ask_reader_parity.yaml, and both tests pin its sha256 so neither side changes the cases alone.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DecisionAsk } from "../shared/fleet";
import { decisionOf, isRow, parsed, type Row, stateOf } from "./control-asks";

const CORPUS = readFileSync(join(import.meta.dir, "fixtures", "ask_reader_parity.yaml"));
// The same pin as workspace scripts/test_ask_reader_parity.py. Change the corpus there, copy it here, update both.
const CORPUS_SHA256 = "736746fc062f01bf58725758adca2ab66595b8787eeec2007522efa610587f54";

type Case = {
  name: string;
  three?: boolean;
  ask: Row;
  expect: { state: DecisionAsk["state"]; trigger: boolean; shown?: boolean };
};
const data = parsed(CORPUS.toString("utf8"));
const cases = data.cases as Case[];
const base = data.base as Row;
const marker = data.marker as string;
const THIRD = { id: "revise", label: "Revise", consequence: "Nothing is built." };

function askOf(one: Case): Row {
  const row: Row = { id: "P1", ...base, ...one.ask };
  if (one.three) row.options = [...(row.options as unknown[]), THIRD];
  return row;
}

test("the corpus is the pinned one", () => {
  expect(createHash("sha256").update(CORPUS).digest("hex")).toBe(CORPUS_SHA256);
});

describe("Maestro reads each case as the validator does", () => {
  for (const one of cases) {
    test(one.name, () => {
      const row = askOf(one);
      expect(stateOf(row)).toBe(one.expect.state);
      const ask = decisionOf(
        row,
        isRow(data.ledger) ? data.ledger : {},
        "parity.yaml",
        { ids: new Set(), uids: new Set() },
        {
          kind: "root",
          path: "",
          branch: null,
        },
      );
      if (one.expect.shown !== undefined) expect(JSON.stringify(ask).includes(marker)).toBe(one.expect.shown);
      // Whatever Maestro shows, the validator has read.
      if (one.expect.shown) expect(one.expect.trigger).toBe(true);
    });
  }
});
