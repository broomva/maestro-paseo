// A second process for the stores' multi-process test (server/stores.multiprocess.test.ts): it waits for a start
// file so two of them begin together, then hammers one store the way a second daemon would.
//
//   bun store-worker.ts events <workRoot> <id> <count> <tag> <go>      one work item's receipts, read-then-write
//   bun store-worker.ts create <workRoot> <count> <tag> <go>           files work under one title
//   bun store-worker.ts ledger <path> <count> <tag> <go>               long lines onto one JSON-lines ledger
//   bun store-worker.ts verbs <path> <log> <go>                        resumes the verbs ledger, applying what is due
//   bun store-worker.ts receipts <path> <count> <tag> <go>             the ask receipts' appender
//   bun store-worker.ts wake <path> <count> <tag> <go>                 the wake log, which trims itself past 1000 lines

import { appendFileSync, existsSync } from "node:fs";
import type { OwnerVerb } from "../../shared/verbs";
import { appendAskReceipt } from "../ask-receipts";
import { appendJsonLine } from "../jsonl";
import { OwnerVerbs } from "../owner-verbs";
import { WakeLog } from "../wake-log";
import { WorkStore } from "../store";

const [mode, ...args] = process.argv.slice(2) as [string, ...string[]];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(go: string): Promise<void> {
  while (!existsSync(go)) await sleep(2);
}

if (mode === "events") {
  const [root, id, count, tag, go] = args as [string, string, string, string, string];
  const store = new WorkStore(root);
  await waitFor(go);
  for (let i = 0; i < Number(count); i += 1) {
    await store.mutate(id, (item) => ({
      // The receipt says how many the item held when it was read: two writers that read the same number would repeat it.
      events: [{ ts: new Date().toISOString(), type: "note", actor: "maestro", text: `${tag}:${item.events.length}` }],
      // And the contract changes too, so the rename is in the race as well.
      patch: { updated: "2026-10-13" },
    }));
  }
} else if (mode === "create") {
  const [root, count, tag, go] = args as [string, string, string, string];
  const store = new WorkStore(root);
  await waitFor(go);
  for (let i = 0; i < Number(count); i += 1) {
    await store.create({
      title: "Same title",
      brief: `${tag} ${i}`,
      repo: root,
      gate: "human",
      check: "",
      initiative: "",
    });
  }
} else if (mode === "ledger" || mode === "receipts") {
  const [path, count, tag, go] = args as [string, string, string, string];
  await waitFor(go);
  const pad = "x".repeat(6000);
  for (let i = 0; i < Number(count); i += 1) {
    const line = { tag, i, pad };
    await (mode === "ledger" ? appendJsonLine(path, line) : appendAskReceipt(path, line));
  }
} else if (mode === "wake") {
  const [path, count, tag, go] = args as [string, string, string, string];
  const log = new WakeLog(path, () => undefined);
  await waitFor(go);
  for (let i = 0; i < Number(count); i += 1) {
    await log.append({
      tickId: `${tag}${i}`,
      cause: "timer",
      wokeAt: new Date().toISOString(),
      dispatched: [],
      deferred: [],
      needsYou: { gate: 0, stuck: 0, asking: 0 },
      quiet: [],
      unasked: [],
      flagged: [],
      cleared: [],
      narrative: [],
    });
  }
} else if (mode === "verbs") {
  const [path, log, go] = args as [string, string, string];
  const verbs = new OwnerVerbs({ path, windowMs: 0 });
  verbs.register("work.cancel" as OwnerVerb, {
    apply: async (_args, _paseo, receipt) => {
      // Not idempotent, and slow enough that the other process reads the verb as due meanwhile.
      appendFileSync(log, `${process.pid} ${receipt}\n`);
      await sleep(20);
      return "applied here";
    },
  });
  await waitFor(go);
  await verbs.resume();
} else {
  throw new Error(`unknown mode ${mode}`);
}
