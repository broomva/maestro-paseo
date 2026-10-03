// The client bundle must parse under Hermes. Paseo's iOS app evaluates a
// plugin's client bundle from source with globalThis.eval, and Hermes (React
// Native 0.81) leaves syntax such as ES6 classes off by default. In a bundle
// this size a class compiles lazily to undefined and activation throws, so
// the app drops Maestro with a console warning while the desktop, on V8,
// shows it (BRO-2786). This builds the bundle with the daemon's esbuild
// options and CommonJS factory wrapper (packages/server/src/server/plugins/
// compiler.ts; not its interop rewrite or import-boundary plugin, which do
// not change syntax) and compiles it with the hermesc from this repo's own
// react-native devDependency. That is a parse check: it does not catch code
// Hermes parses but runs differently from V8.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";

const root = path.join(import.meta.dir, "..");
const hermescDir = { darwin: "osx-bin", linux: "linux64-bin", win32: "win64-bin" }[process.platform as string];
const hermescName = process.platform === "win32" ? "hermesc.exe" : "hermesc";
const hermesc = hermescDir && path.join(root, "node_modules/react-native/sdks/hermesc", hermescDir, hermescName);

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

// Skipped only where react-native ships no hermesc; a missing binary on macOS, Linux or Windows fails.
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
