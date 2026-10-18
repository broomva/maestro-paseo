import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "../bin/maestro";
import { createBackend } from "../mcp/backend";
import { DecisionAskSchema } from "../shared/fleet";
import { askKey } from "../shared/mcp";
import { askHoldKey } from "../shared/needs";
import { answer } from "./agent-socket";
import { type McpReads, mcpReadMethods, readMcpSnapshot, startMcpReadBridge } from "./mcp-read-bridge";

function reads(): McpReads {
  return {
    needs: async () => ({ rows: [], summary: { total: 7 }, unread: ["sri"] }) as never,
    work: async () => ({ items: [], warnings: ["Unread work folder"] }),
    asks: async () => ({ asks: [], complete: false }),
    answers: async () => ({ waitingToLand: 2, routed: 3, acted: 4, held: 1 }) as never,
    notices: async () => ({ rows: [], summary: { unread: ["timeline"] } }) as never,
    fleet: async () => {
      throw new Error("Fleet observer is offline");
    },
    loops: async () => ({ rows: [], warnings: [], ledgerErrors: [] }) as never,
    initiatives: async () => ({ initiatives: [], warnings: [] }) as never,
  };
}
test("projection preserves canonical counts and independent source failures", async () => {
  const snapshot = await readMcpSnapshot(reads());
  expect(snapshot.source).toBe("live");
  expect(snapshot.readOnly).toBe(true);
  expect(snapshot.needs?.total).toBe(7);
  expect(snapshot.work).toEqual([]);
  expect(snapshot.fleet).toBeNull();
  expect(snapshot.errors.fleet).toBe("Fleet observer is offline");
  expect(snapshot.errors.needs).toContain("sri");
  expect(snapshot.errors.asks).toBeDefined();
  expect(snapshot.errors.notices).toContain("timeline");
  expect(snapshot.errors.work).toContain("Unread work folder");
  expect(snapshot.answers?.acted).toBe(4);
});
test("read bridge refuses owner calls and snapshot arguments", async () => {
  const methods = mcpReadMethods(reads());
  for (const method of ["ask.answer", "work.dispatch", "loop.wake", "fleet.review"]) {
    expect((await answer(methods, JSON.stringify({ id: 1, method, input: {} }))).ok).toBe(false);
  }
  expect((await answer(methods, JSON.stringify({ id: 1, method: "snapshot", input: { dispatch: true } }))).ok).toBe(
    false,
  );
  expect((await answer(methods, JSON.stringify({ id: 1, method: "snapshot", input: [] }))).ok).toBe(false);
  expect((await answer(methods, JSON.stringify({ id: 1, method: "snapshot", input: {} }))).ok).toBe(true);
});
test("the normal plugin starts no MCP listener", async () => {
  const path = `/tmp/maestro-disabled-${crypto.randomUUID()}.sock`;
  const stop = startMcpReadBridge(
    reads(),
    () => {
      throw new Error("Should not log");
    },
    { MAESTRO_MCP_SOCKET: path },
  );
  await stop();
  await expect(stat(path)).rejects.toThrow();
});
test("ask identity is stable across revisions and distinguishes scopes", () => {
  const a = { home: { kind: "main", path: "/ctl" }, ledger: "one", id: "A1", uid: null, scope: "broomva" };
  expect(askKey(a)).toBe(askKey({ ...a }));
  expect(askKey(a)).not.toBe(askKey({ ...a, scope: "sri" }));
});

test("enabled bridge round-trips live reads, rejects writes, restricts mode and cleans up", async () => {
  const root = await mkdtemp(join("/tmp", "mcp-"));
  const path = join(root, "read.sock");
  let ready!: () => void;
  const listening = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const stop = startMcpReadBridge(
    reads(),
    (message) => {
      if (message.includes("sessions can reach")) ready();
    },
    { MAESTRO_MCP_READ_BRIDGE: "1", MAESTRO_MCP_SOCKET: path },
  );
  try {
    await Promise.race([
      listening,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Listener did not open")), 5000)),
    ]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const snapshot = await createBackend({ socket: path })();
    expect(snapshot.source).toBe("live");
    expect(snapshot.needs?.total).toBe(7);
    await expect(call("ask.answer", {}, { path, caller: null, cwd: null })).rejects.toThrow();
  } finally {
    await stop();
    await rm(root, { recursive: true, force: true });
  }
  await expect(stat(path)).rejects.toThrow();
});
test("hold projection targets the canonical ask, including its scope", async () => {
  const input = reads();
  const first = DecisionAskSchema.parse({
    ledger: "one",
    uid: null,
    id: "A1",
    hash: "rev1",
    arc: null,
    headline: "Same title",
    question: null,
    stakes: null,
    whyYou: null,
    options: [],
    fallback: null,
    blocking: false,
    askedAt: null,
    answeredAt: null,
    answer: null,
    answerOption: null,
    state: "open",
    origin: null,
    refusal: null,
    home: { kind: "root", path: "/fleet", branch: null },
    batched: false,
    waiting: true,
    scope: "broomva",
  });
  const second = { ...first, scope: "sri", hash: "rev2" };
  input.asks = async () => ({ asks: [first, second], complete: true });
  input.needs = async () =>
    ({
      rows: [{ key: askHoldKey(second), title: "Same title", scope: "sri", kind: "ask", since: "now" }],
      summary: { total: 1 },
      unread: [],
    }) as never;
  const snapshot = await readMcpSnapshot(input);
  expect(snapshot.needs?.rows[0]?.target).toEqual({ kind: "ask", id: askKey(second) });
});
