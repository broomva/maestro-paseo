#!/usr/bin/env bun
// A stand-in ACP agent for the dogfood sandbox. It speaks just enough of the
// Agent Client Protocol (newline-delimited JSON-RPC on stdio) to hold a turn
// open, so Maestro shows real Running work with no model and no bill. In a
// directory that holds a `.dogfood-ask` file it first asks for permission,
// which parks the work at the gate in its "asking" phase. A cancel ends the turn.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

// up.ts copies this file into the sandbox and runs it on its own: keep it free of imports from the repo.
// The marker name matches ASK_MARKER in seed.ts.
const ASK_MARKER = ".dogfood-ask";

type Id = string | number;
interface Message {
  jsonrpc?: "2.0";
  id?: Id;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

const turns = new Map<string, (stopReason: string) => void>();
const cwds = new Map<string, string>();
const replies = new Map<Id, (message: Message) => void>();
let sent = 0;

function send(message: Message): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function update(sessionId: string, body: Record<string, unknown>): void {
  send({ method: "session/update", params: { sessionId, update: body } });
}

function ask(method: string, params: Record<string, unknown>): Promise<Message> {
  sent += 1;
  const id = `stand-in-${sent}`;
  return new Promise((resolve) => {
    replies.set(id, resolve);
    send({ id, method, params });
  });
}

async function prompt(sessionId: string): Promise<{ stopReason: string }> {
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Working on it. This stand-in agent keeps its turn open until you stop it." },
  });
  const cwd = cwds.get(sessionId);
  if (cwd && existsSync(join(cwd, ASK_MARKER))) {
    const toolCallId = `call-${randomUUID().slice(0, 8)}`;
    const rawInput = { command: "git push origin HEAD" };
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId,
      title: "git push origin HEAD",
      kind: "execute",
      status: "pending",
      rawInput,
    });
    await ask("session/request_permission", {
      sessionId,
      toolCall: { toolCallId, title: "git push origin HEAD", kind: "execute", status: "pending", rawInput },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
  }
  const stopReason = await new Promise<string>((resolve) => turns.set(sessionId, resolve));
  return { stopReason };
}

async function answer(message: Message): Promise<void> {
  const { id, method, params } = message;
  if (id === undefined || !method) return;
  const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "";
  switch (method) {
    case "initialize":
      send({
        id,
        result: {
          protocolVersion: typeof params?.protocolVersion === "number" ? params.protocolVersion : 1,
          agentCapabilities: { loadSession: false },
          authMethods: [],
          agentInfo: { name: "dogfood-stand-in", version: "1.0.0" },
        },
      });
      return;
    case "session/new": {
      const created = `stand-in-${randomUUID()}`;
      if (typeof params?.cwd === "string") cwds.set(created, params.cwd);
      send({ id, result: { sessionId: created } });
      return;
    }
    case "session/prompt":
      send({ id, result: await prompt(sessionId) });
      return;
    case "session/set_mode":
    case "session/set_model":
    case "session/close":
      send({ id, result: {} });
      return;
    case "session/set_config_option":
      send({ id, result: { configOptions: [] } });
      return;
    default:
      send({ id, error: { code: -32601, message: `The stand-in agent does not implement ${method}` } });
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message: Message;
  try {
    message = JSON.parse(line) as Message;
  } catch {
    return;
  }
  if (message.method && message.id !== undefined) {
    void answer(message);
  } else if (message.method === "session/cancel") {
    const sessionId = String(message.params?.sessionId ?? "");
    turns.get(sessionId)?.("cancelled");
    turns.delete(sessionId);
  } else if (message.id !== undefined) {
    replies.get(message.id)?.(message);
    replies.delete(message.id);
  }
});
lines.on("close", () => process.exit(0));
