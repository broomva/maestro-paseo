// The record RPCs as the plugin registers them: History, a work folder's files,
// and the changed line on work.list and work.get, through the host's handlers.

import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "./index.server";
import { fakePaseo } from "./server/fake-paseo";
import type { Paseo } from "./server/runs";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

type Handler = (input: unknown, context: unknown) => unknown;

test("work.list and work.get carry the changed line; History and files are served", async () => {
  const root = await mkdtemp(join(tmpdir(), "maestro-rec-"));
  roots.push(root);
  const repo = join(root, "repo");
  // A git repository as far as Maestro checks: runs branch a worktree from it.
  await mkdir(join(repo, ".git"), { recursive: true });
  const config = join(root, "config.json");
  await writeFile(
    config,
    JSON.stringify({ workRoot: join(root, "work"), provider: "claude/test", modeId: null, isolation: "worktree" }),
  );
  const saved = { config: process.env.MAESTRO_PASEO_CONFIG, socket: process.env.MAESTRO_PASEO_SOCKET };
  // No fleet here: the plugin's Fleet view reads this test's empty folder, never the machine's fleet.
  const fleet = [
    "MAESTRO_PASEO_FLEET_CONFIG",
    "MAESTRO_PASEO_FLEET_STATE",
    "MAESTRO_PASEO_FLEET_AGENTS",
    // Nor the owner's control repo, whose ledgers a test never reads or writes.
    "MAESTRO_PASEO_CONTROL_REPO",
    "MAESTRO_PASEO_CONTROL_ANSWERS",
    // Nor the owner's ask receipts and locks: routing marks where it begins there (server/answer-routes.ts).
    "MAESTRO_PASEO_ASK_RECEIPTS",
    "MAESTRO_PASEO_ASK_LOCKS",
  ] as const;
  const savedFleet = fleet.map((key) => [key, process.env[key]] as const);
  for (const key of fleet) process.env[key] = join(root, "no-fleet", key);
  process.env.MAESTRO_PASEO_CONFIG = config;
  process.env.MAESTRO_PASEO_SOCKET = join(root, "m.sock");
  const handlers = new Map<string, Handler>();
  const host = {
    handle: (contract: { name: string }, handler: Handler) => handlers.set(contract.name, handler),
    on: () => () => undefined,
    before: () => () => undefined,
    registerProvider: () => undefined,
    registerSettings: () => undefined,
  } as unknown as PluginServerContext;
  const cleanup = contribute(host);
  const call = (name: string, input: unknown, paseo?: Paseo) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`${name} is not handled`);
    return handler(input, { paseo }) as Promise<Record<string, unknown>>;
  };
  try {
    const fake = fakePaseo();
    let reads = 0;
    const paseo = {
      ...fake.paseo,
      workspaces: {
        ...fake.paseo.workspaces,
        list: async () => {
          reads += 1;
          return {
            entries: [{ id: "ws-1", diffStat: { additions: 7, deletions: 2 } }],
            pageInfo: { nextCursor: null },
          };
        },
      },
    } as unknown as Paseo;
    const { item } = (await call(
      "work.create",
      { title: "Wired", brief: "", repo, gate: "human", check: "", initiative: "hawthorne", dispatch: true },
      paseo,
    )) as { item: { id: string } };

    const listed = (await call("work.list", {}, paseo)) as { items: Array<{ id: string; changed: unknown }> };
    expect(listed.items.map((entry) => entry.changed)).toEqual([{ additions: 7, deletions: 2 }]);
    const got = (await call("work.get", { id: item.id }, paseo)) as { item: { changed: unknown } };
    expect(got.item.changed).toEqual({ additions: 7, deletions: 2 });
    expect(reads).toBe(1);

    const history = (await call("work.history", { days: 7 })) as { events: Array<{ text: string; itemId: string }> };
    expect(history.events.map((event) => event.text)).toEqual(["Dispatched", "Created"]);
    expect(history.events.every((event) => event.itemId === item.id)).toBe(true);

    const files = (await call("work.files", { id: item.id })) as { files: Array<{ name: string }> };
    expect(files.files.map((file) => file.name)).toEqual(["_events.jsonl", "_work.md"]);
    const text = (await call("work.file", { id: item.id, name: "_work.md" })) as { text: string };
    expect(text.text).toContain("Wired");
    await expect(call("work.file", { id: item.id, name: "../config.json" })).rejects.toThrow("not a path");
  } finally {
    await cleanup();
    process.env.MAESTRO_PASEO_CONFIG = saved.config;
    process.env.MAESTRO_PASEO_SOCKET = saved.socket;
    if (saved.config === undefined) delete process.env.MAESTRO_PASEO_CONFIG;
    if (saved.socket === undefined) delete process.env.MAESTRO_PASEO_SOCKET;
    for (const [key, value] of savedFleet) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
