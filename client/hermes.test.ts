// The client bundle must parse under Hermes. Paseo's iOS app evaluates a
// plugin's client bundle from source with globalThis.eval, and Hermes (React
// Native 0.81) rejects syntax it does not enable by default, ES6 classes
// among them. A bundle that throws there is dropped with a console warning
// only, so Maestro vanishes from the phone while the desktop, on V8, shows it
// (BRO-2786). This builds the bundle the way Paseo's daemon does
// (packages/server/src/server/plugins/compiler.ts: esbuild, es2020, async
// lowered, the host runtime external, wrapped as a CommonJS factory) and
// compiles it with the hermesc that ships with react-native.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";

const root = path.join(import.meta.dir, "..");
const hermescDir = { darwin: "osx-bin", linux: "linux64-bin" }[process.platform as string];
const hermesc = hermescDir && path.join(root, "node_modules/react-native/sdks/hermesc", hermescDir, "hermesc");

async function clientBundle(): Promise<string> {
  const result = await build({
    entryPoints: [path.join(root, "index.client.tsx")],
    bundle: true,
    format: "cjs",
    jsx: "automatic",
    platform: "neutral",
    target: "es2020",
    supported: { "async-await": false },
    external: [
      "@getpaseo/plugin",
      "@getpaseo/plugin/*",
      "@tanstack/react-query",
      "react",
      "react/jsx-runtime",
      "react-native",
      "zod",
    ],
    treeShaking: true,
    write: false,
    logLevel: "silent",
  });
  const code = result.outputFiles[0]?.text ?? "";
  return `globalThis.__plugin = (function(require) {\nconst module = { exports: {} };\nconst exports = module.exports;\n${code}\nreturn module.exports;\n});\n`;
}

function compile(source: string): { status: number | null; output: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "maestro-hermes-"));
  const file = path.join(dir, "client.js");
  writeFileSync(file, source);
  const run = spawnSync(hermesc as string, ["-emit-binary", "-out", path.join(dir, "client.hbc"), file], {
    encoding: "utf8",
  });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

// Skipped only where react-native ships no hermesc; a missing binary on macOS or Linux fails.
describe.skipIf(!hermesc)("client bundle under Hermes", () => {
  test("react-native ships hermesc for this platform", () => {
    expect(existsSync(hermesc as string)).toBe(true);
  });

  test("hermesc rejects class syntax, so this check can fail", () => {
    const result = compile("var Quiet = class { render() { return null; } };\n");
    expect(result.output).toContain("error:");
  });

  test("the client bundle compiles with Hermes' default flags", async () => {
    const result = compile(await clientBundle());
    expect(result.output).not.toContain("error:");
    expect(result.status).toBe(0);
  }, 60_000);
});
