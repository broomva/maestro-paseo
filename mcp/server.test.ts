import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { SnapshotSchema } from "../shared/mcp";
import { type AnswerHandler, createBackend } from "./backend";
import { APP_URI, createServer } from "./server";

const structured = (result: unknown) =>
  z.object({ structuredContent: z.record(z.string(), z.unknown()).optional() }).parse(result).structuredContent ?? {};

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of close.splice(0)) await stop();
});
async function setup(demo = true, onAnswer?: AnswerHandler, plainRead = false) {
  const backend = createBackend({
    demo,
    socket: "/tmp/maestro-mcp-absent.sock",
    controlRepo: "/tmp/maestro-mcp-absent-repo",
  });
  const server = createServer(
    plainRead ? () => backend() : backend,
    async () => "<!doctype html><title>Maestro</title>",
    onAnswer,
  );
  const client = new Client({ name: "test-host", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  close.push(
    () => client.close(),
    () => server.close(),
  );
  return client;
}
async function firstAsk(client: Client) {
  const result = await client.callTool({ name: "maestro_open", arguments: { view: "decisions" } });
  const snapshot = SnapshotSchema.parse(structured(result).snapshot);
  const ask = snapshot.asks?.[0];
  if (!ask) throw new Error("Missing fixture decision");
  return { key: ask.key, hash: ask.hash, ledger: ask.ledger, id: ask.id, option: ask.options[0].id, note: "" };
}

test("MCP advertises its real App resource, read tools and explicit answer mutation", async () => {
  const client = await setup();
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(["maestro_answer_ask", "maestro_open", "maestro_snapshot"]);
  for (const tool of tools) {
    expect(tool.annotations?.readOnlyHint).toBe(tool.name !== "maestro_answer_ask");
    expect(tool._meta?.ui).toHaveProperty("resourceUri", APP_URI);
  }
  const resource = await client.readResource({ uri: APP_URI });
  expect(resource.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
  expect(resource.contents[0]).toHaveProperty("text", "<!doctype html><title>Maestro</title>");
});

test("actual MCP answer tool updates demo state and returns explicit ok plus canonical snapshot", async () => {
  const client = await setup();
  const args = await firstAsk(client);
  const result = await client.callTool({ name: "maestro_answer_ask", arguments: args });
  expect(result.isError).toBeFalsy();
  expect(structured(result).ok).toBe(true);
  expect(SnapshotSchema.parse(structured(result).snapshot).asks?.find((a) => a.key === args.key)?.state).toBe(
    "answered",
  );
  expect((await client.callTool({ name: "maestro_answer_ask", arguments: args })).isError).toBe(true);
});

test("legacy clients without key/hash cannot invoke a writer", async () => {
  let called = false;
  const client = await setup(true, async () => {
    called = true;
    return { ok: true };
  });
  const result = await client.callTool({
    name: "maestro_answer_ask",
    arguments: { ledger: "onboarding", id: "rollout", option: "approve" },
  });
  expect(result.isError).toBe(true);
  expect(called).toBe(false);
});

test("an unbound reader never defaults to a global live writer", async () => {
  const client = await setup(true, undefined, true);
  expect((await client.callTool({ name: "maestro_answer_ask", arguments: await firstAsk(client) })).isError).toBe(true);
});

test("answer refusal remains MCP isError and never reports success", async () => {
  const client = await setup(true, async () => ({ ok: false, error: "Revision changed" }));
  const result = await client.callTool({ name: "maestro_answer_ask", arguments: await firstAsk(client) });
  expect(result.isError).toBe(true);
  expect(structured(result).ok).not.toBe(true);
});

test("invalid view and unrelated owner tools cannot execute", async () => {
  const client = await setup();
  expect((await client.callTool({ name: "maestro_open", arguments: { view: "dispatch" } })).isError).toBe(true);
  expect((await client.callTool({ name: "work.dispatch", arguments: {} })).isError).toBe(true);
});

test("disconnected live sources return unavailable, never sample or healthy zeroes", async () => {
  const client = await setup(false);
  const result = await client.callTool({ name: "maestro_snapshot", arguments: {} });
  const snapshot = SnapshotSchema.parse(structured(result).snapshot);
  expect(snapshot.source).toBe("unavailable");
  expect(snapshot.capabilities.answerAsks).toBe(false);
  expect(snapshot.needs).toBeNull();
  expect(snapshot.fleet).toBeNull();
});
