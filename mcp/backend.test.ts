import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { serveAgents } from "../server/agent-socket";
import { SnapshotSchema } from "../shared/mcp";
import { answerDecisionAsk, createBackend, readDirectLiveSnapshot } from "./backend";
import { createServer } from "./server";

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const ledger = `asks:
  - id: review
    uid: review-uid
    ask: Approve this isolated test?
    options:
      - id: approve
        label: Approve
      - id: skip
        label: Skip
`;
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "maestro-mcp-writer-"));
  folders.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "--initial-branch=main");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  await mkdir(join(dir, ".control/asks"), { recursive: true });
  const path = join(dir, ".control/asks/review.yaml");
  await writeFile(path, ledger);
  const options = {
    controlRepo: dir,
    answersPath: join(dir, "answers"),
    lockRoot: join(dir, "locks"),
    receipts: join(dir, "receipts.jsonl"),
    fetch: false,
    workSocket: join(dir, "absent-work.sock"),
  };
  const snapshot = await readDirectLiveSnapshot(options);
  const ask = snapshot.asks?.find((a) => a.id === "review");
  if (!ask) throw new Error("Fixture ask missing");
  return {
    dir,
    path,
    options,
    snapshot,
    ask,
    input: { key: ask.key, hash: ask.hash, ledger: ask.ledger, id: ask.id, option: "approve", note: "isolated test" },
  };
}

test("canonical locked answer writes only the selected fixture ask and a real receipt", async () => {
  const f = await fixture();
  const result = await answerDecisionAsk(f.input, f.options);
  expect(result.ok).toBe(true);
  expect(await readFile(f.path, "utf8")).toContain('answer_option: "approve"');
  expect(await readFile(f.options.receipts, "utf8")).toContain('"kind":"ask.answered"');
  const refreshed = await readDirectLiveSnapshot(f.options);
  expect(refreshed.asks?.find((a) => a.key === f.ask.key)?.state).toBe("answered");
  expect(refreshed.answers).toBeNull();
});

test("client-seen hash and exact identity cannot be replaced by newly read values", async () => {
  const f = await fixture();
  await writeFile(f.path, ledger.replace("Approve this isolated test?", "Changed question?"));
  const stale = await answerDecisionAsk(f.input, f.options);
  expect(stale.ok).toBe(false);
  expect(stale.error).toContain("changed since you read");
  const wrongHome = await answerDecisionAsk(
    { ...f.input, key: f.input.key.replace("review-uid", "other-uid") },
    f.options,
  );
  expect(wrongHome.ok).toBe(false);
  expect(await readFile(f.path, "utf8")).not.toContain("answer_option:");
});

test("fallback exposes missing sources, never fabricated empty healthy data", async () => {
  const { snapshot } = await fixture();
  expect(snapshot.source).toBe("live");
  expect(snapshot.capabilities.answerAsks).toBe(true);
  expect(snapshot.readOnly).toBe(false);
  for (const key of ["needs", "answers", "notices", "fleet", "loops", "initiatives"] as const) {
    expect(snapshot[key]).toBeNull();
    expect(snapshot.errors[key]).toBeTruthy();
  }
});

test("live mode never treats fictional sample identifiers as successful answers", async () => {
  const f = await fixture();
  expect(
    (await answerDecisionAsk({ ...f.input, ledger: "onboarding", id: "rollout", key: "sample/rollout" }, f.options)).ok,
  ).toBe(false);
  expect(await readFile(f.path, "utf8")).toBe(ledger);
});

test("demo backend owns its changes and never falls through to the real writer", async () => {
  const f = await fixture();
  const demo = createBackend({ demo: true, ...f.options });
  const ask = (await demo()).asks?.[0];
  if (!ask) throw new Error("Missing demo decision");
  const result = await demo.answer({
    key: ask.key,
    hash: ask.hash,
    ledger: ask.ledger,
    id: ask.id,
    option: ask.options[0].id,
    note: "",
  });
  expect(result.ok).toBe(true);
  expect((await demo()).asks?.find((a) => a.key === ask.key)?.state).toBe("answered");
  expect((await demo()).answers?.acted).toBe((await createBackend({ demo: true })()).answers?.acted);
  expect((await createBackend({ demo: true })()).asks?.[0].state).toBe("open");
  expect(await readFile(f.path, "utf8")).toBe(ledger);
});

test("real MCP transport answers an actual isolated ledger then returns the canonical reread", async () => {
  const f = await fixture();
  const backend = createBackend({ ...f.options, socket: join(f.dir, "missing-bridge.sock") });
  const server = createServer(backend, async () => "<!doctype html><title>fixture</title>");
  const client = new Client({ name: "fixture-host", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const result = await client.callTool({ name: "maestro_answer_ask", arguments: f.input });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.ok).toBe(true);
    const snapshot = SnapshotSchema.parse(data.snapshot);
    expect(snapshot.source).toBe("live");
    expect(snapshot.asks?.find((ask) => ask.key === f.input.key)?.state).toBe("answered");
    expect(snapshot.answers).toBeNull();
    expect(await readFile(f.path, "utf8")).toContain('answer_option: "approve"');
  } finally {
    await client.close();
    await server.close();
  }
});

test("a cached bridge cannot resurrect an answered workspace ask or omit a newly read one", async () => {
  const f = await fixture();
  const socket = join("/tmp", `mcp-cache-${crypto.randomUUID()}.sock`);
  const fleet = {
    ...f.ask,
    key: JSON.stringify(["sri", "root", "/fleet", "fleet.yaml", null, "fleet-review"]),
    ledger: "fleet.yaml",
    id: "fleet-review",
  };
  const cached = { ...f.snapshot, asks: [f.ask, fleet] };
  const stop = await serveAgents({
    path: socket,
    methods: new Map([["snapshot", async () => structuredClone(cached)]]),
  });
  try {
    const newlyFiled = ledger.slice("asks:\n".length).replaceAll("review", "new-review");
    await writeFile(f.path, ledger + newlyFiled);
    const backend = createBackend({ ...f.options, socket });
    const before = await backend();
    expect(before.asks?.some((ask) => ask.id === "new-review")).toBe(true);
    expect(before.asks?.find((ask) => ask.id === "fleet-review")?.refusal).toContain("Open it in Paseo");
    expect((await backend.answer(f.input)).ok).toBe(true);
    const after = await backend();
    const answered = after.asks?.find((ask) => ask.key === f.input.key);
    expect(answered?.state).toBe("answered");
    expect(answered?.hash).not.toBe(f.input.hash);
    expect(after.asks?.filter((ask) => ask.key === f.input.key)).toHaveLength(1);
    expect(cached.asks[0].state).toBe("open");
  } finally {
    await stop();
  }
});
