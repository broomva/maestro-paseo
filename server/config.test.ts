import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, LOOP_MAX_MINUTES } from "../shared/contracts";
import { DEFAULT_TIER_LADDER } from "../shared/tiers";
import { defaultConfig, loadConfig, saveConfig } from "./config";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function file(contents: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "maestro-config-"));
  roots.push(root);
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify(contents));
  return path;
}

const older = { workRoot: "/tmp/work", provider: "claude", modeId: null, isolation: "worktree" as const };

test("a file written before the cap, archive, default gate and loop settings loads with their defaults", async () => {
  expect(await loadConfig(await file(older))).toEqual({
    ...older,
    concurrencyCap: 3,
    archiveOnApprove: false,
    defaultGate: "human",
    loopMinutes: null,
    tierLadder: DEFAULT_TIER_LADDER,
  });
  expect(defaultConfig()).toMatchObject({
    concurrencyCap: 3,
    archiveOnApprove: false,
    defaultGate: "human",
    loopMinutes: null,
  });
});

test("the tier ladder defaults to the workspace's, loads from a file, and needs every rung whole", async () => {
  expect(defaultConfig().tierLadder).toEqual(DEFAULT_TIER_LADDER);
  expect(DEFAULT_TIER_LADDER.standard).toEqual({ provider: "claude/claude-sonnet-5-5", thinkingOptionId: "medium" });
  const ladder = { ...DEFAULT_TIER_LADDER, apex: { provider: " claude/claude-fable-5-2 ", thinkingOptionId: "max" } };
  const loaded = await loadConfig(await file({ ...older, tierLadder: ladder }));
  expect(loaded.tierLadder.apex).toEqual({ provider: "claude/claude-fable-5-2", thinkingOptionId: "max" });
  const broken = { ...DEFAULT_TIER_LADDER, standard: { provider: "", thinkingOptionId: "low" } };
  await expect(loadConfig(await file({ ...older, tierLadder: broken }))).rejects.toThrow("needs a provider");
  const { apex: _apex, ...partial } = DEFAULT_TIER_LADDER;
  await expect(loadConfig(await file({ ...older, tierLadder: partial }))).rejects.toThrow();
});

test("the loop is off by default, and wakes every whole number of minutes from 1 to a day", async () => {
  expect((await loadConfig(await file({ ...older, loopMinutes: 15 }))).loopMinutes).toBe(15);
  expect((await loadConfig(await file({ ...older, loopMinutes: 1440 }))).loopMinutes).toBe(1440);
  expect((await loadConfig(await file({ ...older, loopMinutes: null }))).loopMinutes).toBeNull();
  for (const bad of [0, -5, 2.5, "10"]) {
    await expect(loadConfig(await file({ ...older, loopMinutes: bad }))).rejects.toThrow(
      /loop wakes every whole number|expected number/,
    );
  }
  const path = await file(older);
  await saveConfig({ ...defaultConfig(), workRoot: "/tmp/w", loopMinutes: 30 }, path);
  expect((await loadConfig(path)).loopMinutes).toBe(30);
});

test("a loop period past a day is refused, saved or loaded, and the error says the range", async () => {
  const copy = "The loop wakes every whole number of minutes from 1 to 1440 (a day), or empty for off";
  expect(LOOP_MAX_MINUTES).toBe(1440);
  await expect(loadConfig(await file({ ...older, loopMinutes: 1441 }))).rejects.toThrow(copy);
  await expect(loadConfig(await file({ ...older, loopMinutes: Number.MAX_SAFE_INTEGER }))).rejects.toThrow(copy);
  const path = await file(older);
  await expect(saveConfig({ ...defaultConfig(), workRoot: "/tmp/w", loopMinutes: 1441 }, path)).rejects.toThrow(copy);
  expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty("loopMinutes");
  const parsed = ConfigSchema.safeParse({ ...defaultConfig(), loopMinutes: 1441 });
  expect(parsed.success).toBe(false);
  expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([copy]);
});

test("the cap is a whole number of runs from 1, or null for no cap", async () => {
  expect((await loadConfig(await file({ ...older, concurrencyCap: null }))).concurrencyCap).toBeNull();
  expect((await loadConfig(await file({ ...older, concurrencyCap: 12 }))).concurrencyCap).toBe(12);
  for (const bad of [0, -1, 1.5, "3"]) {
    await expect(loadConfig(await file({ ...older, concurrencyCap: bad }))).rejects.toThrow(
      /concurrency cap is a whole number|expected number/,
    );
  }
});

test("the default gate is you or the checks, and archiving on approve is on or off", async () => {
  await expect(loadConfig(await file({ ...older, defaultGate: "agent" }))).rejects.toThrow("invalid settings");
  await expect(loadConfig(await file({ ...older, archiveOnApprove: "yes" }))).rejects.toThrow("invalid settings");
});

test("saving keeps every setting, and refuses a bad cap before writing", async () => {
  const path = await file(older);
  const next = { ...defaultConfig(), workRoot: "/tmp/w", concurrencyCap: null, archiveOnApprove: true };
  await saveConfig({ ...next, defaultGate: "auto" }, path);
  expect(await loadConfig(path)).toMatchObject({ concurrencyCap: null, archiveOnApprove: true, defaultGate: "auto" });
  await expect(saveConfig({ ...next, concurrencyCap: 0 }, path)).rejects.toThrow("concurrency cap");
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ concurrencyCap: null });
});
