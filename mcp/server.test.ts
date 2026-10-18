import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { SnapshotSchema } from "../shared/mcp";
import { createBackend } from "./backend";
import { APP_URI, createServer } from "./server";

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of close.splice(0)) await stop();
});
async function setup(demo = true) {
  const server = createServer(
    createBackend({ demo, socket: "/tmp/maestro-mcp-absent.sock" }),
    async () => "<!doctype html><title>Maestro</title>",
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
test("MCP advertises an App resource and only two read-only tools", async () => {
  const client = await setup();
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(["maestro_open", "maestro_snapshot"]);
  for (const tool of tools) {
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool._meta?.ui).toHaveProperty("resourceUri", APP_URI);
  }
  const result = await client.callTool({ name: "maestro_open", arguments: { view: "decisions" } });
  expect(result.isError).toBeFalsy();
  expect(z.object({ view: z.string() }).parse(result.structuredContent).view).toBe("decisions");
  const snapshot = SnapshotSchema.parse(
    z.object({ snapshot: SnapshotSchema }).parse(result.structuredContent).snapshot,
  );
  expect(snapshot.source).toBe("sample");
  expect(snapshot.asks?.length).toBeGreaterThan(0);
  const resource = await client.readResource({ uri: APP_URI });
  expect(resource.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
  expect(resource.contents[0]).toHaveProperty("text", "<!doctype html><title>Maestro</title>");
});
test("invalid view and owner tools cannot execute", async () => {
  const client = await setup();
  expect((await client.callTool({ name: "maestro_open", arguments: { view: "dispatch" } })).isError).toBe(true);
  expect((await client.callTool({ name: "work.dispatch", arguments: {} })).isError).toBe(true);
});
test("a disconnected live bridge returns unavailable, never sample or healthy zeroes", async () => {
  const client = await setup(false);
  const result = await client.callTool({ name: "maestro_snapshot", arguments: {} });
  const snapshot = SnapshotSchema.parse(
    z.object({ snapshot: SnapshotSchema }).parse(result.structuredContent).snapshot,
  );
  expect(snapshot.source).toBe("unavailable");
  expect(snapshot.needs).toBeNull();
  expect(snapshot.fleet).toBeNull();
  expect(snapshot.errors.connection).toContain("unavailable");
});
