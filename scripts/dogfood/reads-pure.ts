#!/usr/bin/env bun
// Reads are pure, observed on the sandbox (BRO-2995). Polls the reads every
// client polls (work.list, work.attention, loops.get, and the fleet and
// timeline views) in a tight loop through the sandbox daemon, and compares
// what they could have touched before and after: every file in the sandbox
// outside Paseo's own home (the work store and its mtimes, the wake log, the
// inbox, any ledger), and Paseo's sessions (how many, archived, labels).
// With --plant it first plants work only a write would change: a run whose
// session was archived while nobody looked, and an approval whose undo window
// closed. With --wait-sweep it then waits for the plugin sweep, on its own
// cadence, to change them, and says when and how. Never the real daemon: it
// acts only on a sandbox up.ts made (state.json), on its own port.

import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { flag, hasFlag, RESERVED_PORTS, readState, resolveStateDir, sleep } from "./lib";
import { type Seed, writeSeeds } from "./seed";

const USAGE = `bun scripts/dogfood/reads-pure.ts [--polls N] [--plant] [--wait-sweep S] [--state <dir>]

  --polls N        How many times each read is polled (default 50)
  --plant          First plant work only a write changes: a run whose session was archived unseen,
                   and an approval whose undo window closed
  --wait-sweep S   After the polls, wait up to S seconds for the plugin sweep to change what was planted
  --state <dir>    The sandbox (default: this checkout's)
`;

type Rpc = <T>(method: string, input?: unknown) => Promise<T>;
interface Item {
  id: string;
  title: string;
  state: string;
  reason: string | null;
}
interface Session {
  id: string;
  title: string | null;
  archivedAt: string | null;
  labels: Record<string, string>;
}

/** Every file under `root` but Paseo's own home and the daemon's log: mtime, size and bytes. */
async function fingerprint(root: string, skip: readonly string[]): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (skip.includes(path) || entry.isSocket() || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        await walk(path);
      } else if (entry.isFile()) {
        const info = await stat(path).catch(() => null);
        if (!info) continue;
        const digest = createHash("sha1")
          .update(await readFile(path))
          .digest("hex")
          .slice(0, 12);
        seen.set(path, `${new Date(info.mtimeMs).toISOString()} ${info.size}B ${digest}`);
      }
    }
  };
  await walk(root);
  return seen;
}

function changed(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [path, was] of before) if (after.get(path) !== was) out.push(path);
  for (const path of after.keys()) if (!before.has(path)) out.push(path);
  return out;
}

async function sessions(client: {
  fetchAgents(options?: unknown): Promise<{ entries: Array<{ agent: Session }> }>;
}): Promise<Session[]> {
  const page = await client.fetchAgents({ filter: { includeArchived: true } });
  return page.entries
    .map(({ agent }) => ({
      id: agent.id,
      title: agent.title,
      archivedAt: agent.archivedAt ?? null,
      labels: agent.labels ?? {},
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Two planted items: a run whose session was archived while the plugin heard nothing, and a due approval. */
async function plant(
  workRoot: string,
  repo: string,
  archivedAgent: string,
): Promise<{ gone: string; approved: string }> {
  const now = new Date();
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
  const run = (agentId: string, from: number) => [
    { ts: at(from), type: "created", actor: "human" },
    {
      ts: at(from),
      type: "dispatched",
      actor: "human",
      agentId,
      workspaceId: `ws-${agentId.slice(0, 8)}`,
      provider: "dogfood/stand-in",
      branch: null,
      cwd: repo,
    },
    { ts: at(from), type: "state", actor: "human", from: "proposed", to: "running", reason: null },
    { ts: at(from), type: "turn.started", actor: "agent", agentId },
  ];
  const doneAgent = randomUUID();
  const seeds: Seed[] = [
    {
      key: "planted-gone",
      id: randomUUID(),
      folder: ["platform", "planted", "its-session-was-archived-unseen"],
      title: "Planted: its session was archived unseen",
      brief: "A run whose session was archived while the plugin heard nothing: only reconcile finds it.",
      repo,
      gate: "human",
      checks: [],
      state: "running",
      events: run(archivedAgent, 10),
      expect: { group: "running", initiative: "platform", project: "planted" },
    },
    {
      key: "planted-approved",
      id: randomUUID(),
      folder: ["platform", "planted", "approved-while-nobody-looked"],
      title: "Planted: approved while nobody looked",
      brief: "Approved at your gate; its 8 s undo window closed long ago and no timer of this process holds it.",
      repo,
      gate: "human",
      checks: [],
      state: "review",
      events: [
        ...run(doneAgent, 12),
        {
          ts: at(11),
          type: "turn.ended",
          actor: "agent",
          agentId: doneAgent,
          outcome: "completed",
          error: null,
          summary: "Done.\n\n## Ask\nApprove it.",
          turnId: "planted-turn-1",
        },
        { ts: at(11), type: "state", actor: "maestro", from: "running", to: "review", reason: null },
        {
          ts: at(10),
          type: "gate.pending",
          actor: "human",
          verdict: "approve",
          note: "",
          token: randomUUID(),
          effectiveAt: at(10 - 8 / 60),
        },
      ],
      expect: { group: "review", initiative: "platform", project: "planted" },
    },
  ];
  await writeSeeds(workRoot, seeds, now);
  return { gone: seeds[0]?.id ?? "", approved: seeds[1]?.id ?? "" };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (hasFlag(args, "help") || hasFlag(args, "h")) {
    console.log(USAGE);
    return 0;
  }
  const dir = resolveStateDir(flag(args, "state"));
  const state = dir ? readState(dir) : null;
  if (!state) throw new Error("No sandbox: run scripts/dogfood/up.ts first (or pass --state).");
  if (RESERVED_PORTS.has(state.port)) throw new Error(`Refusing port ${state.port}: it is not a sandbox's.`);
  const polls = Number(flag(args, "polls") ?? 50);
  const waitSweep = Number(flag(args, "wait-sweep") ?? 0);

  const { DaemonClient } = await import("@getpaseo/client/internal/daemon-client");
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${state.port}/ws`,
    clientId: `dogfood-reads-${randomUUID()}`,
    clientType: "cli",
    reconnect: { enabled: false },
  });
  await client.connect();
  try {
    const rpc: Rpc = (method, input = {}) => client.invokePluginRpc("maestro", method, input) as never;
    const config = await rpc<{ workRoot: string }>("config.get");
    if (config.workRoot !== state.workRoot) throw new Error(`The plugin reads ${config.workRoot}, not the sandbox's.`);
    const item = async (id: string) => (await rpc<{ item: Item }>("work.get", { id })).item;

    let planted: { gone: string; approved: string } | null = null;
    if (hasFlag(args, "plant")) {
      // A session the plugin hears created and archived with no work bound: its hooks change nothing.
      const repo = join(state.dir, "repos", "platform");
      const agent = await client.createAgent({
        config: { provider: "dogfood", model: "stand-in", cwd: repo, title: "Planted session (archived)" },
      });
      await client.archiveAgent(agent.id);
      planted = await plant(state.workRoot, repo, agent.id);
      console.log(`Planted ${planted.gone} (its session ${agent.id} archived) and ${planted.approved} (due approval).`);
    }

    const skip = [state.paseoHome, state.log];
    const filesBefore = await fingerprint(state.dir, skip);
    const sessionsBefore = await sessions(client as never);
    const plantedBefore = planted ? [await item(planted.gone), await item(planted.approved)] : [];
    const started = Date.now();
    for (let poll = 0; poll < polls; poll += 1) {
      await rpc("work.list");
      await rpc("work.attention");
      await rpc("loops.get");
      await rpc("fleet.get", {});
      await rpc("timeline.get");
    }
    const took = Date.now() - started;
    const filesAfter = await fingerprint(state.dir, skip);
    const sessionsAfter = await sessions(client as never);
    const plantedAfter = planted ? [await item(planted.gone), await item(planted.approved)] : [];
    const moved = changed(filesBefore, filesAfter);
    const sessionsMoved = JSON.stringify(sessionsBefore) !== JSON.stringify(sessionsAfter);
    const store = [...filesBefore].filter(([path]) => path.startsWith(state.workRoot) && path.endsWith(".jsonl"));

    console.log(`\n${polls} polls of work.list, work.attention, loops.get, fleet.get, timeline.get in ${took} ms`);
    console.log(`  files compared: ${filesBefore.size} (the sandbox but Paseo's home and the daemon log)`);
    console.log(
      `  files changed:  ${moved.length}${moved.length ? `\n    ${moved.map((path) => relative(state.dir, path)).join("\n    ")}` : ""}`,
    );
    console.log(
      `  sessions:       ${sessionsBefore.length} before, ${sessionsAfter.length} after; archived ${sessionsBefore.filter((one) => one.archivedAt).length} → ${sessionsAfter.filter((one) => one.archivedAt).length}; labels ${sessionsMoved ? "CHANGED" : "unchanged"}`,
    );
    console.log("  the store's event logs (mtime size sha1), before = after:");
    for (const [path, was] of store) {
      console.log(`    ${filesAfter.get(path) === was ? "=" : "≠"} ${was}  ${relative(state.workRoot, path)}`);
    }
    for (const [index, was] of plantedBefore.entries()) {
      const now = plantedAfter[index];
      console.log(`  planted "${was.title}": ${was.state} → ${now?.state} after the polls`);
    }
    const pure = moved.length === 0 && !sessionsMoved;
    console.log(pure ? "PURE: the reads changed nothing." : "NOT PURE: see above.");

    if (planted && waitSweep > 0) {
      console.log(`\nWaiting up to ${waitSweep} s for the plugin sweep...`);
      const deadline = Date.now() + waitSweep * 1000;
      let gone = await item(planted.gone);
      let approved = await item(planted.approved);
      while ((gone.state === "running" || approved.state === "review") && Date.now() < deadline) {
        await sleep(1000);
        gone = await item(planted.gone);
        approved = await item(planted.approved);
      }
      for (const id of [planted.gone, planted.approved]) {
        const { item: now, events } = await rpc<{
          item: Item;
          events: Array<{ ts: string; text: string; detail?: string }>;
        }>("work.get", { id });
        const last = events.at(-1);
        console.log(
          `  "${now.title}": ${now.state}${now.reason ? ` (${now.reason})` : ""}; last event ${last?.ts} ${last?.text ?? ""}`,
        );
      }
      console.log(`  sessions now: ${(await sessions(client as never)).length}`);
    }
    return pure ? 0 : 1;
  } finally {
    await client.close().catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  },
);
