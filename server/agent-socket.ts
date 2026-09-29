// The agent socket: how Paseo sessions operate Maestro. Plugin RPC reaches the
// daemon only over its password-protected socket, and a plugin cannot add
// tools to an agent, so the plugin listens on a unix socket of its own that
// only this user can open. Every session has a shell; `bin/maestro.ts` is the
// client.
//
// It offers the noun and the verb, never the gate: approve, send back,
// unblock, cancel and settings are not served, so no session can pass its own
// gate or loosen how runs start. Everything done through it is recorded as the
// agent's: nothing here can prove a person asked. This is the surface a session
// is offered, not a sandbox. A process running as you can still edit the work
// folders directly; the receipts are what keep that visible.
//
// Protocol: one JSON request per line, one JSON response per line, in order.
//   → {"id":1,"method":"work.list","input":{},"caller":"<agent id>"}
//   ← {"id":1,"ok":true,"output":{...}}   or   {"id":1,"ok":false,"error":"..."}

import { chmod, mkdir, rename, stat, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { z } from "zod";
import { GATE_MODES } from "../shared/states";
import { loadConfig } from "./config";
import { type Engine, NO_HANDLE, UserError } from "./engine";
import type { Origin } from "./events";
import type { Paseo } from "./runs";

export interface Caller {
  /** The session's agent id, as the client reported it (`PASEO_AGENT_ID`). */
  agentId: string | null;
}

export type AgentMethod = (input: unknown, caller: Caller) => Promise<unknown>;

/** The verbs that stay with you. Named so a session that asks for one is told why. */
export const GATE_METHODS: ReadonlySet<string> = new Set(["work.verdict", "work.unblock", "work.cancel", "config.set"]);

function method<S extends z.ZodType>(
  schema: S,
  run: (input: z.output<S>, caller: Caller) => Promise<unknown>,
): AgentMethod {
  return async (raw, caller) => {
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`);
      throw new UserError(`Invalid input. ${issues.join("; ")}`);
    }
    return run(parsed.data, caller);
  };
}

const ById = z.object({ id: z.string().min(1) });
const ForAgent = z.object({ agentId: z.string().min(1).optional() });

const AgentCreate = z.object({
  title: z.string().trim().min(1, "Give the work a title"),
  brief: z.string().default(""),
  repo: z.string().trim().min(1, "Choose where the work runs"),
  gate: z.enum(GATE_MODES).default("human"),
  check: z.string().default(""),
  initiative: z.string().default(""),
  dispatch: z.boolean().default(false),
});

/**
 * The allowlist. `paseo` returns the daemon client once the plugin has been
 * handed one; verbs that start or read a session refuse until then.
 */
export function agentMethods(engine: Engine, paseo: () => Paseo | null): ReadonlyMap<string, AgentMethod> {
  const origin = (caller: Caller): Origin => ({ actor: "agent", by: caller.agentId });
  const connected = (): Paseo => {
    const handle = paseo();
    if (!handle) throw new UserError(NO_HANDLE);
    return handle;
  };
  const session = (agentId: string | undefined, caller: Caller): string => {
    const id = agentId ?? caller.agentId;
    if (!id) throw new UserError("Say which session: pass an agent id (PASEO_AGENT_ID is not set here).");
    return id;
  };
  return new Map<string, AgentMethod>([
    ["work.list", method(z.object({}), () => engine.list(paseo() ?? undefined))],
    ["work.get", method(ById, ({ id }) => engine.get(id))],
    [
      "work.create",
      method(AgentCreate, async (input, caller) => {
        if (input.gate === "auto") {
          throw new UserError(
            "Work a session creates waits at your gate. Letting checks close it (gate: auto) is your call, made in Maestro.",
          );
        }
        return { item: await engine.create(paseo(), input, origin(caller)) };
      }),
    ],
    [
      "work.dispatch",
      method(ById, async ({ id }, caller) => ({ item: await engine.dispatch(connected(), id, origin(caller)) })),
    ],
    [
      "work.adopt",
      method(ForAgent.extend({ title: z.string().default("") }), async ({ agentId, title }, caller) => ({
        item: await engine.adopt(connected(), session(agentId, caller), title, origin(caller)),
      })),
    ],
    [
      "work.for-agent",
      method(ForAgent, async ({ agentId }, caller) => ({ item: await engine.forAgent(session(agentId, caller)) })),
    ],
    ["config.get", method(z.object({}), () => loadConfig())],
  ]);
}

const Request = z.object({
  id: z.union([z.string(), z.number()]).nullable().default(null),
  method: z.string().min(1),
  input: z.unknown().optional(),
  caller: z.string().min(1).max(200).nullable().default(null),
});

export type AgentResponse =
  | { id: string | number | null; ok: true; output: unknown }
  | { id: string | number | null; ok: false; error: string };

/** One request line to one response. Never throws: every failure is an answer. */
export async function answer(
  methods: ReadonlyMap<string, AgentMethod>,
  line: string,
  log: (message: string) => void = () => undefined,
): Promise<AgentResponse> {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return { id: null, ok: false, error: "Each request is one line of JSON." };
  }
  const request = Request.safeParse(json);
  if (!request.success) {
    return { id: null, ok: false, error: 'A request needs a method, as in {"method":"work.list"}.' };
  }
  const { id, method: name, input, caller } = request.data;
  const run = methods.get(name);
  if (!run) {
    const error = GATE_METHODS.has(name)
      ? `${name} is yours alone: the gate, unblocking, canceling and settings happen in Maestro, not from a session.`
      : `Unknown method ${name}. Offered: ${[...methods.keys()].join(", ")}.`;
    return { id, ok: false, error };
  }
  try {
    return { id, ok: true, output: await run(input, { agentId: caller }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!(error instanceof UserError)) log(`agent socket: ${name} failed: ${message}`);
    return { id, ok: false, error: message };
  }
}

const MAX_LINE = 1 << 20;

function respond(socket: Socket, methods: ReadonlyMap<string, AgentMethod>, log: (message: string) => void): void {
  socket.setEncoding("utf8");
  socket.on("error", () => undefined);
  let buffer = "";
  // Requests on one connection are answered in the order they were sent.
  let chain = Promise.resolve();
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      chain = chain.then(async () => {
        const response = await answer(methods, line, log);
        if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
      });
    }
    if (buffer.length > MAX_LINE) {
      // Stop reading: the rest of an oversized line must not be taken for the next request.
      socket.removeAllListeners("data");
      buffer = "";
      chain = chain.then(() => {
        socket.end(`${JSON.stringify({ id: null, ok: false, error: "Request too large." })}\n`);
      });
    }
  });
}

function bind(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
}

/** Whether something answers at `path`. A probe that hangs counts as alive: never take a socket that may be in use. */
export function answers(path: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path);
    const done = (alive: boolean) => {
      probe.destroy();
      resolve(alive);
    };
    probe.setTimeout(timeoutMs, () => done(true));
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
  });
}

export interface ServeOptions {
  path: string;
  methods: ReadonlyMap<string, AgentMethod>;
  log?: (message: string) => void;
  /** How often to retry while another instance holds the socket, as during a reload. */
  attempts?: number;
  retryMs?: number;
}

let serial = 0;

/**
 * Listen on `path`, readable and writable by this user only. A socket file
 * nobody answers on is left over from a crash and is replaced; one that
 * answers belongs to a live instance and is waited for, then refused.
 *
 * The socket is bound under a private name and renamed into place. Closing a
 * unix socket server unlinks the path it was bound to, so binding `path`
 * itself would let an instance shutting down during a reload delete the
 * socket its successor just opened. Returns the cleanup, which removes `path`
 * only while it is still this instance's.
 */
export async function serveAgents(options: ServeOptions): Promise<() => Promise<void>> {
  const { path, methods, log = () => undefined, attempts = 15, retryMs = 200 } = options;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    respond(socket, methods, log);
  });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 1; await answers(path); attempt += 1) {
    if (attempt >= attempts) throw new Error(`Another Maestro is already answering on ${path}`);
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
  serial += 1;
  const bound = `${path}.${process.pid}-${serial}`;
  await unlink(bound).catch(() => undefined);
  await bind(server, bound);
  await chmod(bound, 0o600);
  await rename(bound, path);
  const { ino } = await stat(path);
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const current = await stat(path).catch(() => null);
    if (current?.ino === ino) await unlink(path).catch(() => undefined);
  };
}
