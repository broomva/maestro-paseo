// Every answer to a decision ask is sent from client/verbs.ts (BRO-3036): Decisions' card, the Feed's inspector and
// an initiative's ideas all call `useVerbs().answer`, never the `ask.answer` rpc themselves, so the receipt, the
// undo window and the ids-from-one-read rule have one home.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function sources(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, found);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) found.push(path);
  }
  return found;
}

const relative = (file: string) => file.slice(ROOT.length + 1);

test("only the verb adapter calls the ask.answer rpc", () => {
  const files = [...sources(join(ROOT, "client")), join(ROOT, "index.client.tsx")];
  expect(files.length).toBeGreaterThan(30);
  const callers = files.filter((file) => /\banswerAsk\b/.test(readFileSync(file, "utf8")));
  expect(callers.map(relative)).toEqual(["client/verbs.ts"]);
});

test("Decisions' card and the ideas' cards answer through the adapter", () => {
  expect(readFileSync(join(ROOT, "client/decision-card.tsx"), "utf8")).toContain("verbs.answer(input)");
  expect(readFileSync(join(ROOT, "client/initiatives.tsx"), "utf8")).toContain("mutationFn: verbs.answer");
});
