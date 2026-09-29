// The dogfood seed must read back, through the plugin's own store, as the
// states it claims: otherwise the screenshots would show a sandbox that
// quietly lost items or put them in the wrong group.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkStore } from "../../server/store";
import { toWire } from "../../server/wire";
import { groupOf, type OrchState, transition, type Verdict } from "../../shared/states";
import { buildSeeds, writeSeeds } from "./seed";

const now = new Date("2026-09-29T18:00:00.000Z");
const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function seeded() {
  const root = await mkdtemp(join(tmpdir(), "dogfood-seed-"));
  dirs.push(root);
  const seeds = buildSeeds(now, { checkout: "/repo/checkout", platform: "/repo/platform", infra: "/repo/infra" });
  await writeSeeds(root, seeds, now);
  const { items, warnings } = await new WorkStore(root, () => now).scan();
  const wire = new Map(items.map((item) => [item.contract.id, toWire(item, now.getTime())]));
  return { seeds, wire, warnings };
}

describe("dogfood seed", () => {
  test("every folder reads back without a warning", async () => {
    const { seeds, wire, warnings } = await seeded();
    expect(warnings).toEqual([]);
    expect(wire.size).toBe(seeds.length);
  });

  test("covers every group, two initiatives and four projects", async () => {
    const { seeds } = await seeded();
    const groups = new Set(seeds.map((seed) => seed.expect.group));
    expect([...groups].sort()).toEqual(["blocked", "done", "queued", "review", "running"]);
    expect(new Set(seeds.map((seed) => seed.expect.initiative)).size).toBe(2);
    expect(new Set(seeds.map((seed) => seed.expect.project)).size).toBe(4);
    expect(seeds.map((seed) => seed.state)).toContain("canceled");
  });

  test("each item lands where it claims", async () => {
    const { seeds, wire } = await seeded();
    for (const seed of seeds) {
      const item = wire.get(seed.id);
      expect(item, seed.key).toBeDefined();
      if (!item) continue;
      expect(item.title, seed.key).toBe(seed.title);
      expect(item.initiative, seed.key).toBe(seed.expect.initiative);
      expect(item.project, seed.key).toBe(seed.expect.project);
      // Live items are written queued; up.ts dispatches them to the stand-in agent.
      expect(item.group, seed.key).toBe(seed.live ? "queued" : seed.expect.group);
      expect(item.group, seed.key).toBe(groupOf(seed.state));
      if (seed.live) continue;
      if (seed.expect.reason !== undefined) expect(item.reason, seed.key).toBe(seed.expect.reason);
      if (seed.expect.verdict !== undefined) expect(item.verdict, seed.key).toBe(seed.expect.verdict);
      if (seed.expect.decided !== undefined) {
        expect(item.look?.decided.length, seed.key).toBe(seed.expect.decided);
        expect(item.look?.ask, seed.key).toContain("30 seconds");
        expect(item.look?.ran, seed.key).toBe("48m unsupervised · 1 turn · ran to the gate");
      }
    }
  });

  test("every recorded state change is one the state machine allows", async () => {
    const { seeds } = await seeded();
    for (const seed of seeds) {
      let state: OrchState = "proposed";
      let verdict: Verdict | undefined;
      let checksPassed: boolean | undefined;
      for (const event of seed.events) {
        if (event.type === "gate") verdict = event.verdict as Verdict;
        if (event.type === "checks.finished") {
          checksPassed = (event.results as Array<{ ok: boolean }>).every((result) => result.ok);
        }
        if (event.type !== "state") continue;
        expect(event.from, seed.key).toBe(state);
        state = transition(state, event.to as OrchState, { gate: seed.gate, verdict, checksPassed });
      }
      expect(state, seed.key).toBe(seed.state);
    }
  });

  test("no seeded history leaves a check run pending, so reconcile never runs seeded checks", async () => {
    const { wire } = await seeded();
    for (const item of wire.values()) expect(item.phase === "checking").toBe(false);
  });
});
