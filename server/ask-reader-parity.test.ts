/**
 * Maestro's half of the cross-reader parity corpus (BRO-3167). The corpus has one copy, server/fixtures/
 * ask_reader_parity.yaml; broomva/workspace scripts/test_ask_reader_parity.py fetches it and holds the validator
 * to the same cases, so there is no second copy to drift (the file's header says how a change lands).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DecisionAsk } from "../shared/fleet";
import { decisionOf, decisionsOf, isRow, parsed, type Row, stateOf } from "./control-asks";

type Expect = { state: DecisionAsk["state"]; trigger: boolean; shown?: boolean };
type Case = { name: string; three?: boolean; ask: Row; expect: Expect };
type LedgerCase = {
  name: string;
  doc: string;
  expect: { refused: boolean; asks?: (Expect & { id: string })[] };
};

const data = parsed(readFileSync(join(import.meta.dir, "fixtures", "ask_reader_parity.yaml"), "utf8"));
const cases = data.cases as Case[];
const ledgers = data.ledgers as LedgerCase[];
const base = data.base as Row;
const marker = data.marker as string;
const THIRD = { id: "revise", label: "Revise", consequence: "Nothing is built." };
const HOME = { kind: "root", path: "", branch: null } as const;

function askOf(one: Case): Row {
  const row: Row = { id: "P1", ...base, ...one.ask };
  if (one.three) row.options = [...(row.options as unknown[]), THIRD];
  return row;
}

describe("Maestro reads each ask as the validator does", () => {
  for (const one of cases) {
    test(one.name, () => {
      const row = askOf(one);
      expect(stateOf(row)).toBe(one.expect.state);
      const ledger = isRow(data.ledger) ? data.ledger : {};
      const ask = decisionOf(row, ledger, "parity.yaml", { ids: new Set(), uids: new Set() }, HOME);
      if (one.expect.shown !== undefined) expect(JSON.stringify(ask).includes(marker)).toBe(one.expect.shown);
    });
  }
});

describe("Maestro reads each ledger as the validator does", () => {
  for (const one of ledgers) {
    test(one.name, () => {
      let asks: DecisionAsk[] | null = null;
      try {
        asks = decisionsOf(one.doc, "parity.yaml");
      } catch {
        asks = null;
      }
      expect(asks === null).toBe(one.expect.refused);
      if (asks === null) return;
      expect(asks.map((ask) => ask.id)).toEqual((one.expect.asks ?? []).map((ask) => ask.id));
      asks.forEach((ask, i) => {
        const want = one.expect.asks?.[i];
        expect(ask.state).toBe(want?.state as DecisionAsk["state"]);
        expect(JSON.stringify(ask).includes(marker)).toBe(want?.shown ?? false);
      });
    });
  }
});
