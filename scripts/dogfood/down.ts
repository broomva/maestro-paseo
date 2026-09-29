#!/usr/bin/env bun
// Stop the sandbox daemon (and anything else the sandbox started) and delete
// its directory. Idempotent: with nothing up it says so and exits 0.

import { flag, hasFlag, resolveStateDir } from "./lib";
import { teardown } from "./teardown";

const USAGE = `bun scripts/dogfood/down.ts [--state <dir>]

  --state <dir>   The sandbox to remove (default: MAESTRO_DOGFOOD_STATE, then the one up.ts last started here)
`;

const args = process.argv.slice(2);
if (hasFlag(args, "help") || hasFlag(args, "h")) {
  console.log(USAGE);
  process.exit(0);
}
const dir = resolveStateDir(flag(args, "state"));
if (!dir) {
  console.log("Nothing to tear down: no dogfood sandbox is recorded.");
  process.exit(0);
}
const clean = await teardown(dir);
process.exit(clean ? 0 : 1);
