// Allow and Deny go through the server's approval.decide (BRO-2999): it records, takes effect 8 s later, leaves a
// receipt, and tells the engine at once. No client path answers a permission prompt on Paseo itself, as two
// copied handlers (the detail pane, the session card) once did.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** Every client source file: the screens (client/, index.client.tsx), never a test. */
function sources(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, found);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) found.push(path);
  }
  return found;
}

test("no client path answers a permission prompt on Paseo directly", () => {
  const files = [...sources(join(ROOT, "client")), join(ROOT, "index.client.tsx")];
  expect(files.length).toBeGreaterThan(30);
  const offenders = files.filter((file) => /respondToPermission/.test(readFileSync(file, "utf8")));
  expect(offenders.map((file) => file.slice(ROOT.length + 1))).toEqual([]);
});

test("the one place the server answers a prompt is the engine, after the undo window", () => {
  const server = sources(join(ROOT, "server")).filter((file) => /respondToPermission/.test(readFileSync(file, "utf8")));
  expect(server.map((file) => file.slice(ROOT.length + 1)).filter((file) => !file.endsWith("fake-paseo.ts"))).toEqual([
    "server/engine.ts",
  ]);
});
