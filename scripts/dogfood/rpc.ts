#!/usr/bin/env bun
// Call one plugin RPC on the sandbox and print its answer as JSON (BRO-3036): what a screen would read, without a
// browser. Never the real daemon: it acts only on a sandbox up.ts made, on its own port.
//
//   bun scripts/dogfood/rpc.ts answers.status
//   bun scripts/dogfood/rpc.ts needs.list '{"kind":"ask"}'

import { randomUUID } from "node:crypto";
import { flag, RESERVED_PORTS, readState, resolveStateDir } from "./lib";

const args = process.argv.slice(2);
const positional = args.filter((arg, at) => !arg.startsWith("--") && args[at - 1] !== "--state");
const [method, raw] = positional;
if (!method) {
  console.log("bun scripts/dogfood/rpc.ts <method> [json input] [--state <dir>]");
  process.exit(method === undefined ? 1 : 0);
}
const dir = resolveStateDir(flag(args, "state"));
const state = dir ? readState(dir) : null;
if (!state) throw new Error("No sandbox: run scripts/dogfood/up.ts first (or pass --state).");
if (RESERVED_PORTS.has(state.port)) throw new Error(`Refusing port ${state.port}: it is not a sandbox's.`);

const { DaemonClient } = await import("@getpaseo/client/internal/daemon-client");
const client = new DaemonClient({
  url: `ws://127.0.0.1:${state.port}/ws`,
  clientId: `dogfood-rpc-${randomUUID()}`,
  clientType: "cli",
  reconnect: { enabled: false },
});
await client.connect();
try {
  console.log(JSON.stringify(await client.invokePluginRpc("maestro", method, raw ? JSON.parse(raw) : {}), null, 2));
} finally {
  await client.close();
}
