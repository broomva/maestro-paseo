import { expect, test } from "bun:test";
import { UNDO_MS as engineUndo } from "../server/engine";
import { UNDO_MS } from "./undo";

test("the undo window is 8 s, and the engine uses the shared value (owner B4)", () => {
  expect(UNDO_MS).toBe(8_000);
  expect(engineUndo).toBe(UNDO_MS);
});
