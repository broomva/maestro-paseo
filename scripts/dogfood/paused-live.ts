#!/usr/bin/env bun
// BRO-3073: how many of a work store's items sit at your gate (or running) on a turn that ended on a usage limit,
// before and after the sweep moves them to Stuck. Reads a COPY of the store: the work root is copied to a
// temp folder and the engine runs there, so the real store is never written.
//
//   bun scripts/dogfood/paused-live.ts [--root ~/maestro]

import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { defaultConfig } from "../../server/config";
import { Engine } from "../../server/engine";
import { expandHome } from "../../server/paths";

const { values } = parseArgs({ options: { root: { type: "string", default: "~/maestro" } } });
const source = expandHome(values.root ?? "~/maestro");
const copy = await mkdtemp(join(tmpdir(), "maestro-paused-"));
try {
  await cp(source, copy, { recursive: true });
  const config = { ...defaultConfig(), workRoot: copy };
  const engine = new Engine({
    config: async () => config,
    log: () => undefined,
    git: async () => ({ branch: null, githubRepo: null }),
    merged: async () => null,
  });
  const count = async () => {
    const { items } = await engine.list();
    const by = (state: string) => items.filter((item) => item.state === state).length;
    return {
      items: items.length,
      review: by("review"),
      holding: items.filter((item) => item.state === "review" && item.permission).length,
      finished: items.filter((item) => item.state === "review" && !item.permission).length,
      running: by("running"),
      stuck: by("blocked"),
      paused: items.filter((item) => item.state === "blocked" && item.reason?.startsWith("Paused:")).length,
    };
  };
  const before = await count();
  const changed = await engine.upkeep(null);
  const after = await count();
  console.log(JSON.stringify({ source, before, changed, after }, null, 2));
  engine.stop();
} finally {
  await rm(copy, { recursive: true, force: true });
}
