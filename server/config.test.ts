import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  });
  expect(defaultConfig()).toMatchObject({
    concurrencyCap: 3,
    archiveOnApprove: false,
    defaultGate: "human",
    loopMinutes: null,
  });
});

test("the loop is off by default, and wakes every whole number of minutes from 1", async () => {
  expect((await loadConfig(await file({ ...older, loopMinutes: 15 }))).loopMinutes).toBe(15);
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
