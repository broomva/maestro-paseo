// The agent socket: how Paseo sessions operate Maestro. Plugin RPC reaches the
// daemon only over its password-protected socket, and a plugin cannot add
// tools to an agent, so the plugin listens on a unix socket of its own that
// only this user can open. Every session has a shell; `bin/maestro.ts` is the
// client.
//
// It offers the noun and the verb, never the gate: allow or deny, send back,
// undo, stop, unblock, cancel, settings and the loop are not served, so no
// session can pass its own gate, decide its own request, take back your
// decision, loosen how runs start, or drive the loop (which starts nothing
// anyway, A8). A session may only ask: `approval.request` raises one exact
// held action as a hold in Needs you (server/approvals.ts) and decides nothing.
// A session starts nothing at all (A8): `work.dispatch` is gone, and `work.create`
// only queues, for you, a lane or the conductor to start. It cannot write a done
// check: checks run as you with no session in the loop.
//
// Who is asking is checked (BRO-2996, server/callers.ts): every verb that writes
// names the session it acts for, and that session must exist in Paseo's registry,
// be live, and be the one whose folder the shell is in. A verb then acts only for
// that session: it tracks its own session (or one it started), asks leave for its
// own actions, withdraws its own requests. The reads (work.list, work.get,
// config.get) stay open to any session on the socket: the conductor and the lanes
// read the queue through them, and the files they read are this user's anyway.
// Everything done through it is recorded as that session's, since nothing here
// can prove a person asked.
// This is the surface a session is offered, not a sandbox. A process running as
// you can still edit the work folders directly, and can still name a live session
// it read from Paseo's registry (server/callers.ts says what the check does not
// prove); the receipts are what keep that visible.
//
// Protocol: one JSON request per line, one JSON response per line, in order.
//   → {"id":1,"method":"work.list","input":{},"caller":"<agent id>","cwd":"<shell folder>"}
//   ← {"id":1,"ok":true,"output":{...}}   or   {"id":1,"ok":false,"error":"..."}

import { chmod, link, lstat, mkdir, rename, stat, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { GATE_MODES } from "../shared/states";
import { SESSIONS_START_NOTHING, TICKET } from "../shared/text";
import { TIERS } from "../shared/tiers";
import type { Approvals } from "./approvals";
import type { CallerClaim, Callers, VerifiedCaller } from "./callers";
import { type Engine, NO_HANDLE, UserError } from "./engine";
import type { Origin } from "./events";
import { yoursReason } from "./flags";
import { HELD_FOR_YOU, type Paseo } from "./runs";
import { WorkNotFoundError } from "./store";

/** One verb: its input as sent, and who the request line says sent it (unverified until a verb checks it). */
export type AgentMethod = (input: unknown, claim: CallerClaim) => Promise<unknown>;

/** The verbs that stay with you. Named so a session that asks for one is told why. */
export const GATE_METHODS: ReadonlySet<string> = new Set([
  "approval.decide",
  "session.prompt",
  "verb.undo",
  "verbs.list",
  "work.verdict",
  "work.undo",
  "work.stop",
  "work.unblock",
  "work.cancel",
  "work.leave-running",
  "config.set",
  "loop.get",
  "loop.wake",
  "fleet.review",
  "initiatives.review",
  "notice.snooze",
  "ask.answer",
  "conductor.decide",
  "conductor.undo",
]);

/**
 * Why work filed from outside any session is yours to start, and only yours: an alerter, a cron job or a script has no
 * session to verify, so it may only queue work, and the work is held for you (BRO-2996).
 */
export const EXTERNAL_HOLD = "Filed from outside Maestro, by no session it could verify. Only you start it.";

/** The verbs that start work. They left the socket (A8): named so a session that asks for one is told who starts work. */
export const LAUNCH_METHODS: ReadonlySet<string> = new Set(["work.dispatch"]);

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`);
    throw new UserError(`Invalid input. ${issues.join("; ")}`);
  }
  return parsed.data;
}

const ById = z.object({ id: z.string().min(1) });

function requireApprovals(approvals: Approvals | null): Approvals {
  if (!approvals) throw new UserError("This Maestro keeps no approval requests.");
  return approvals;
}
const ForAgent = z.object({ agentId: z.string().min(1).optional() });

const AgentCreate = z.object({
  title: z.string().trim().min(1, "Give the work a title"),
  brief: z.string().default(""),
  repo: z.string().trim().min(1, "Choose where the work runs"),
  gate: z.enum(GATE_MODES).default("human"),
  check: z.string().default(""),
  initiative: z.string().default(""),
  dispatch: z.boolean().default(false),
  /** The delegation tier the work declares (BRO-3118): a label for the economy, it changes nothing about how a run starts. */
  tier: z.enum(TIERS).optional(),
});

/** The run choices a session may name and Maestro does not take: how runs start is yours (Engine.create). */
const OWNERS_CHOICES = {
  provider: "--provider",
  thinkingOptionId: "--thinking",
  modeId: "mode",
  isolation: "isolation",
  featureValues: "features",
} as const;

/** A sentence naming the run choices a request carried that Maestro set aside, or null. */
function setAside(raw: unknown): string | null {
  const said = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  // Named as the CLI names them (maestro new --provider, --thinking), not by the wire's keys.
  const named = (Object.keys(OWNERS_CHOICES) as Array<keyof typeof OWNERS_CHOICES>)
    .filter((key) => said[key] !== undefined && said[key] !== null && said[key] !== "")
    .map((key) => OWNERS_CHOICES[key]);
  return named.length === 0
    ? null
    : `Set aside: ${named.join(", ")}. How a run starts is yours, not a session's: only the tier is taken, and it resolves to a provider and thinking level through the tier ladder in your Settings.`;
}

/**
 * The allowlist. `paseo` returns the daemon client once the plugin has been
 * handed one; verbs that read a session refuse until then. `callers` is
 * Paseo's registry: every verb that writes checks its caller against it
 * before it runs, and one that cannot be checked is refused.
 */
export function agentMethods(
  engine: Engine,
  paseo: () => Paseo | null,
  approvals: Approvals | null,
  callers: Callers,
): ReadonlyMap<string, AgentMethod> {
  const origin = (caller: VerifiedCaller): Origin => ({ actor: "agent", by: caller.agentId });
  /** Work from a process that names no session: recorded as nobody's, and says so. */
  const EXTERNAL: Origin = { actor: "agent", by: null, via: "external" };
  const connected = (): Paseo => {
    const handle = paseo();
    if (!handle) throw new UserError(NO_HANDLE);
    return handle;
  };
  /** A read: it names no session and changes nothing. */
  const read = <S extends z.ZodType>(schema: S, run: (input: z.output<S>) => Promise<unknown>): AgentMethod => {
    return async (raw) => run(parse(schema, raw));
  };
  /** A verb that acts for a session: the caller is checked first, and `run` gets the session Maestro verified. */
  const asSession = <S extends z.ZodType>(
    schema: S,
    run: (input: z.output<S>, caller: VerifiedCaller) => Promise<unknown>,
  ): AgentMethod => {
    return async (raw, claim) => {
      const caller = await callers.verify(claim);
      return run(parse(schema, raw), caller);
    };
  };
  /**
   * The session a verb acts on: the caller's own, or one the caller started (Paseo's record of who started it).
   * Naming any other is refused: a session tracks and reads its own work, never another's.
   */
  const session = async (agentId: string | undefined, caller: VerifiedCaller): Promise<string> => {
    if (!agentId || agentId === caller.agentId) return caller.agentId;
    if (await callers.started(caller.agentId, agentId)) return agentId;
    throw new UserError(
      `A session acts only for itself or for one it started: ${agentId} is neither this session (${caller.agentId}) nor one it started.`,
    );
  };
  return new Map<string, AgentMethod>([
    // A read, as every read is (BRO-2995): a session listing work reconciles nothing and applies no decision of yours.
    ["work.list", read(z.object({}), () => engine.list(paseo() ?? undefined))],
    ["work.get", read(ById, ({ id }) => engine.get(id))],
    [
      "work.create",
      async (raw, claim) => {
        const input = parse(AgentCreate, raw);
        // A caller that names a session is that session, verified, or is refused. One that names none is a process
        // outside any session (an alerter, a script): it may only queue work, held for you, as nobody's.
        const caller = claim.agentId ? await callers.verify(claim) : null;
        if (input.dispatch) throw new UserError(SESSIONS_START_NOTHING);
        if (input.gate === "auto") {
          throw new UserError(
            "Work a session creates waits at your gate. Letting checks close it (gate: auto) is your call, made in Maestro.",
          );
        }
        if (input.check.trim()) {
          throw new UserError(
            "A session cannot write a done check: checks run as you, outside any session's permissions, so they come from the person who owns this Maestro.",
          );
        }
        const aside = setAside(raw);
        const told = (notice: string | null) => [notice, aside].filter(Boolean).join(" ") || null;
        if (caller) {
          const made = await engine.createWork(paseo(), input, origin(caller));
          return { ...made, notice: told(made.notice) };
        }
        const made = await engine.createWork(paseo(), { ...input, hold: EXTERNAL_HOLD }, EXTERNAL);
        // Held work is yours to start, in Needs you at once: the loop flags it so on a wake, which may be off or hours
        // away, and an alert nobody sees is no alert.
        await engine.flag(made.item, "yours", yoursReason(HELD_FOR_YOU));
        return { ...made, item: (await engine.get(made.item.id)).item, notice: told(made.notice) };
      },
    ],
    [
      "work.adopt",
      asSession(
        ForAgent.extend({
          title: z.string().default(""),
          ticket: z.string().regex(TICKET, "A ticket is a team key and a number, like BRO-2908").optional(),
        }),
        async ({ agentId, title, ticket }, caller) => ({
          item: await engine.adopt(connected(), await session(agentId, caller), title, origin(caller), { ticket }),
        }),
      ),
    ],
    [
      "work.for-agent",
      asSession(ForAgent, async ({ agentId }, caller) => ({
        item: await engine.forAgent(await session(agentId, caller)),
      })),
    ],
    ["config.get", read(z.object({}), () => engine.settings())],
    // Ask leave for one exact action a policy layer held (frame C1). It only raises the hold: the decision is yours.
    // The request is the verified session's, so the cap and the withdrawal are per live session, not per claimed id.
    [
      "approval.request",
      asSession(z.unknown(), (input, caller) => requireApprovals(approvals).request(caller.agentId, input)),
    ],
    [
      "approval.withdraw",
      asSession(ById, ({ id }, caller) => requireApprovals(approvals).withdraw(caller.agentId, id)),
    ],
  ]);
}

const Request = z.object({
  id: z.union([z.string(), z.number()]).nullable().default(null),
  method: z.string().min(1),
  input: z.unknown().optional(),
  caller: z.string().min(1).max(200).nullable().default(null),
  /** The folder the client's shell is in: checked against the session's own (server/callers.ts). */
  cwd: z.string().min(1).max(4096).nullable().default(null),
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
    const issues = request.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`);
    return { id: null, ok: false, error: `Invalid request (${issues.join("; ")}). Example: {"method":"work.list"}.` };
  }
  const { id, method: name, input, caller, cwd } = request.data;
  const run = methods.get(name);
  if (!run) {
    const error = GATE_METHODS.has(name)
      ? `${name} is yours alone: the gate, undo, stopping a run or leaving it running, unblocking, canceling, settings, the loop, your verdicts on the fleet's proposals and your answers to its asks happen in Maestro, not from a session.`
      : LAUNCH_METHODS.has(name)
        ? `${name} is not offered. ${SESSIONS_START_NOTHING}`
        : `Unknown method ${name}. Offered: ${[...methods.keys()].join(", ")}.`;
    return { id, ok: false, error };
  }
  try {
    return { id, ok: true, output: await run(input, { agentId: caller, cwd }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A refusal or an unknown id is an answer, not a fault worth the plugin log.
    if (!(error instanceof UserError || error instanceof WorkNotFoundError)) {
      log(`agent socket: ${name} failed: ${message}`);
    }
    return { id, ok: false, error: message };
  }
}

export const MAX_LINE = 1 << 20;
/** `sun_path` holds 104 bytes on macOS and 108 on Linux, including the terminator. */
const MAX_SOCKET_PATH = 103;

/** Answers requests on one connection, in the order sent. Returns what is still in flight. */
function respond(
  socket: Socket,
  methods: ReadonlyMap<string, AgentMethod>,
  log: (message: string) => void,
): () => Promise<void> {
  socket.setEncoding("utf8");
  socket.on("error", () => undefined);
  let buffer = "";
  let chain = Promise.resolve();
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    for (; newline >= 0 && newline <= MAX_LINE; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      chain = chain.then(async () => {
        const response = await answer(methods, line, log);
        if (socket.writable) socket.write(`${JSON.stringify(response)}\n`);
      });
    }
    // A line over the limit, whole or still arriving, ends the connection however the bytes were chunked.
    if (newline > MAX_LINE || (newline < 0 && buffer.length > MAX_LINE)) {
      // Stop reading: nothing after an oversized line is taken for a request.
      socket.removeAllListeners("data");
      buffer = "";
      chain = chain.then(() => {
        socket.end(`${JSON.stringify({ id: null, ok: false, error: "Request too large." })}\n`);
      });
    }
  });
  // A client may send its request and close its side at once; it still gets the answer.
  socket.on("end", () => {
    chain = chain.then(() => {
      socket.end();
    });
  });
  return () => chain;
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

/**
 * Whether `path` may be in use. Only "nothing there" (ENOENT) and "nobody
 * listening" (ECONNREFUSED) say it is free; a hang or any other error counts
 * as in use. One limit: on macOS a listener whose backlog is full also refuses,
 * so a holder that has stopped accepting altogether reads as gone.
 */
export function answers(path: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path);
    const done = (alive: boolean) => {
      probe.destroy();
      resolve(alive);
    };
    probe.setTimeout(timeoutMs, () => done(true));
    probe.once("connect", () => done(true));
    probe.once("error", (error: NodeJS.ErrnoException) =>
      done(error.code !== "ENOENT" && error.code !== "ECONNREFUSED"),
    );
  });
}

export interface ServeOptions {
  path: string;
  methods: ReadonlyMap<string, AgentMethod>;
  log?: (message: string) => void;
  /** How often to look again while another instance holds the socket. */
  attempts?: number;
  retryMs?: number;
  /** How long closing waits for requests already being answered. */
  graceMs?: number;
  /** Stops a start that is still waiting for the socket. */
  signal?: AbortSignal;
}

let serial = 0;

/**
 * Put the socket bound at `bound` at `path` too. link() fails if anything is
 * already there, so two instances starting at once cannot both take it. A
 * socket file nobody answers on is left over from a crash and is captured and
 * removed, or put back if what was captured is not what was probed; one that
 * answers is waited on; anything that is not a socket is never touched.
 */
async function claim(bound: string, path: string, options: ServeOptions): Promise<void> {
  const { attempts = 15, retryMs = 200, signal } = options;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) throw new Error("Stopped before the agent socket opened");
    try {
      await link(bound, path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const existing = await lstat(path).catch(() => null);
    if (!existing) continue;
    if (!existing.isSocket()) throw new Error(`${path} exists and is not a socket; not replacing it`);
    if (await answers(path)) {
      await sleep(retryMs, undefined, { signal }).catch(() => undefined);
      continue;
    }
    // Left by a crash. Take it aside with one atomic rename, then check it is the
    // file that was probed: a plain unlink could delete a socket another
    // instance linked there in between. If it is not, put it back.
    const captured = `${bound}.stale`;
    if (
      !(await rename(path, captured).then(
        () => true,
        () => false,
      ))
    )
      continue;
    const taken = await lstat(captured).catch(() => null);
    if (taken?.ino !== existing.ino) await link(captured, path).catch(() => undefined);
    await unlink(captured).catch(() => undefined);
  }
  throw new Error(`Another Maestro is already answering on ${path}`);
}

/**
 * Listen on `path`, readable and writable by this user only.
 *
 * The socket is bound under a private name and linked into place. Closing a
 * unix socket server unlinks the path it was bound to, so an instance bound to
 * `path` itself would delete, on the way out, a socket another instance had
 * since put there. Paseo 0.9.2 reloads a plugin stop-then-start, so the
 * instances that can overlap are a second daemon on the same config and a
 * child orphaned by a daemon crash. Returns the cleanup.
 */
export async function serveAgents(options: ServeOptions): Promise<() => Promise<void>> {
  const { path, methods, log = () => undefined, graceMs = 2000 } = options;
  const connections = new Map<Socket, () => Promise<void>>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    connections.set(socket, respond(socket, methods, log));
    socket.on("close", () => connections.delete(socket));
  });
  /** Stop accepting, let requests already being answered finish for up to `graceMs`, drop the rest. */
  const teardown = async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    const inFlight = Promise.all([...connections.values()].map((pending) => pending()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([inFlight, new Promise((resolve) => (timer = setTimeout(resolve, graceMs)))]);
    clearTimeout(timer);
    for (const socket of connections.keys()) socket.destroy();
    await closed;
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  serial += 1;
  const bound = `${path}.${process.pid}-${serial}`;
  if (Buffer.byteLength(bound) > MAX_SOCKET_PATH) {
    throw new Error(`The socket path is too long for this system: ${bound} (${MAX_SOCKET_PATH} bytes at most)`);
  }
  await unlink(bound).catch(() => undefined);
  await bind(server, bound);
  let ino: number;
  try {
    await chmod(bound, 0o600);
    ({ ino } = await stat(bound));
    await claim(bound, path, options);
  } catch (error) {
    // Never leave a listener behind that nothing will close.
    await teardown();
    await unlink(bound).catch(() => undefined);
    throw error;
  }
  await unlink(bound).catch(() => undefined);
  /**
   * Remove the path first, while still listening: until now a successor was
   * told the socket is in use, so it cannot have linked its own into place
   * between the check and the unlink.
   */
  return async () => {
    const current = await stat(path).catch(() => null);
    if (current?.ino === ino) await unlink(path).catch(() => undefined);
    await teardown();
  };
}

/**
 * Serve for as long as the plugin runs. If the socket cannot be opened, as
 * while a second daemon on the same config holds it, say so once and try
 * again every `reopenMs` until it opens or the plugin stops. Returns the stop.
 */
export function keepServing(options: Omit<ServeOptions, "signal"> & { reopenMs?: number }): () => Promise<void> {
  const { path, log = () => undefined, reopenMs = 10_000 } = options;
  const quit = new AbortController();
  let close: (() => Promise<void>) | null = null;
  const running = (async () => {
    for (let failures = 0; !quit.signal.aborted; failures += 1) {
      try {
        close = await serveAgents({ ...options, signal: quit.signal });
        log(`sessions can reach Maestro at ${path}`);
        return;
      } catch (error) {
        if (quit.signal.aborted) return;
        if (failures === 0) {
          log(`the agent socket did not open, trying again every ${reopenMs / 1000}s: ${(error as Error).message}`);
        }
        await sleep(reopenMs, undefined, { signal: quit.signal }).catch(() => undefined);
      }
    }
  })();
  return async () => {
    quit.abort();
    await running;
    await close?.();
  };
}
