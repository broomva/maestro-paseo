#!/usr/bin/env bun
// `maestro`: operate Maestro from a Paseo session, over the plugin's agent
// socket (server/agent-socket.ts). Node built-ins and dependency-free modules
// only, so it runs from a plugin install that has no dev packages.
//
// The session's agent id comes from PASEO_AGENT_ID, which Paseo sets in every
// session it starts. Anything done here is recorded as that session's.

import { connect } from "node:net";
import { parseArgs } from "node:util";
import { socketPath } from "../server/paths";
import type { MaestroConfig, WorkEventWire, WorkItem } from "../shared/contracts";
import { GROUP_COPY, GROUP_ORDER, PLAIN_VOICE } from "../shared/states";

const USAGE = `maestro: operate Maestro from a Paseo session

  maestro ls                          All work, what needs you first
  maestro show <id>                   One item: state, the look at the gate, receipts
  maestro new <title> [options]       Create work (it waits at your gate)
      --brief <text>                  What to do and why
      --repo <path>                   Where runs happen (default: this directory)
      --check <command>               Done check, run in the run's worktree
      --initiative <name>             Group it under a folder
      --dispatch                      Start a run right away
  maestro dispatch <id>               Start a run in its own worktree
  maestro track [--title <text>]      Track this session as work (or --agent <id>)
  maestro mine                        The work this session is running (or --agent <id>)
  maestro config                      Where work lives and how runs start

  --json                              Print the raw answer

Approve, send back, unblock and cancel are yours, in Maestro. A session cannot
pass its own gate.`;

export class Unreachable extends Error {}
export class Refused extends Error {}

/** One request, one answer. Rejects with `Refused` when Maestro answers with an error. */
export function call(
  method: string,
  input: unknown = {},
  options: { path?: string; caller?: string | null; timeoutMs?: number } = {},
): Promise<unknown> {
  const path = options.path ?? socketPath();
  const caller = options.caller === undefined ? (process.env.PASEO_AGENT_ID ?? null) : options.caller;
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = "";
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(
      () => settle(() => reject(new Unreachable(`Maestro did not answer on ${path}.`))),
      options.timeoutMs ?? 120_000,
    );
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: 1, method, input, caller })}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      settle(() => {
        const response = JSON.parse(buffer.slice(0, newline)) as { ok: boolean; output?: unknown; error?: string };
        if (response.ok) resolve(response.output);
        else reject(new Refused(response.error ?? "Maestro refused."));
      });
    });
    socket.on("error", (error: NodeJS.ErrnoException) =>
      settle(() =>
        reject(
          error.code === "ENOENT" || error.code === "ECONNREFUSED"
            ? new Unreachable(
                `Maestro is not listening on ${path}. Is the maestro plugin installed and running on this Paseo daemon?`,
              )
            : error,
        ),
      ),
    );
    socket.on("close", () => settle(() => reject(new Unreachable("Maestro closed the connection without answering."))));
  });
}

const short = (id: string) => id.slice(0, 8);

function renderItem(item: WorkItem): string {
  const where = item.repo ? `  ${item.repo}` : "";
  const why = item.reason ? `\n      ${item.reason}` : "";
  return `  ${item.id}  ${item.title}${where}${why}`;
}

function renderList(output: { root: string; items: WorkItem[]; warnings: string[] }): string {
  const lines = [`Work in ${output.root}`];
  for (const group of GROUP_ORDER) {
    const items = output.items.filter((item) => item.group === group);
    if (items.length === 0) continue;
    lines.push("", `${GROUP_COPY[group].title} (${items.length})`, ...items.map(renderItem));
  }
  if (output.items.length === 0) lines.push("", "No work yet. Create some with: maestro new <title>");
  for (const warning of output.warnings) lines.push(`warning: ${warning}`);
  return lines.join("\n");
}

function renderDetail(output: { item: WorkItem; brief: string; events: WorkEventWire[] }): string {
  const { item } = output;
  const field = (name: string, value: string | null | undefined) => (value ? [`  ${name.padEnd(9)}${value}`] : []);
  const worker = item.worker
    ? `session ${short(item.worker.agentId)}${item.worker.branch ? ` on ${item.worker.branch}` : ""} (${item.worker.provider})`
    : null;
  const lines = [
    item.title,
    ...field("id", item.id),
    ...field("state", `${PLAIN_VOICE[item.state].label} (${item.state}), gate ${item.gate}`),
    ...field("repo", item.repo),
    ...field("run", worker),
    ...field("why", item.reason),
    ...field("ran", item.look?.ran),
    ...(item.look?.decided ?? []).map((line) => `  decided  ${line}`),
    ...field("ask", item.look?.ask),
    ...field("question", item.permission ? `${item.permission.title} ${item.permission.detail ?? ""}`.trim() : null),
    ...item.checks.map((check) => `  check    ${check.name}: ${check.run}`),
  ];
  if (item.group === "review") lines.push("", "Waiting at your gate: approve or send back in Maestro.");
  if (output.brief.trim()) lines.push("", output.brief.trim());
  if (output.events.length > 0) {
    lines.push("", "Receipts, newest first");
    for (const event of [...output.events].reverse().slice(0, 15)) {
      const detail = event.detail ? `  ${event.detail}` : "";
      lines.push(`  ${event.ts.slice(0, 16).replace("T", " ")}  ${event.actor.padEnd(7)} ${event.text}${detail}`);
    }
  }
  return lines.join("\n");
}

function renderOne(verb: string, output: { item: WorkItem | null }): string {
  if (!output.item) return "This session is not tracked as work. Track it with: maestro track";
  const { item } = output;
  return `${verb} ${item.id}  ${item.title}\n  ${PLAIN_VOICE[item.state].label}${item.reason ? `: ${item.reason}` : ""}`;
}

function renderConfig(config: MaestroConfig): string {
  return [
    `  work     ${config.workRoot}`,
    `  provider ${config.provider}`,
    `  mode     ${config.modeId ?? "provider default"}`,
    `  runs     ${config.isolation === "worktree" ? "a fresh worktree per run" : "in the repo itself"}`,
  ].join("\n");
}

export async function main(argv: string[], print: (text: string) => void = console.log): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      brief: { type: "string", default: "" },
      repo: { type: "string" },
      check: { type: "string", default: "" },
      initiative: { type: "string", default: "" },
      dispatch: { type: "boolean", default: false },
      title: { type: "string", default: "" },
      agent: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, ...rest] = positionals;
  const show = <T>(output: unknown, render: (value: T) => string) =>
    print(values.json ? JSON.stringify(output, null, 2) : render(output as T));
  const needId = () => {
    const id = rest[0];
    if (!id) throw new Refused(`Usage: maestro ${command} <id>. Ids are listed by: maestro ls`);
    return id;
  };
  if (!command || values.help || command === "help") {
    print(USAGE);
    return command || values.help ? 0 : 2;
  }
  switch (command) {
    case "ls":
      show(await call("work.list"), renderList);
      return 0;
    case "show":
      show(await call("work.get", { id: needId() }), renderDetail);
      return 0;
    case "new": {
      const title = rest.join(" ").trim();
      if (!title) throw new Refused("Usage: maestro new <title> [--brief <text>] [--repo <path>] [--dispatch]");
      const input = {
        title,
        brief: values.brief,
        repo: values.repo ?? process.cwd(),
        check: values.check,
        initiative: values.initiative,
        dispatch: values.dispatch,
      };
      show(await call("work.create", input), (output: { item: WorkItem }) =>
        renderOne(values.dispatch ? "Dispatched" : "Created", output),
      );
      return 0;
    }
    case "dispatch":
      show(await call("work.dispatch", { id: needId() }), (output: { item: WorkItem }) =>
        renderOne("Dispatched", output),
      );
      return 0;
    case "track":
      show(await call("work.adopt", { agentId: values.agent, title: values.title }), (output: { item: WorkItem }) =>
        renderOne("Tracking", output),
      );
      return 0;
    case "mine":
      show(await call("work.for-agent", { agentId: values.agent }), (output: { item: WorkItem | null }) =>
        renderOne("Running", output),
      );
      return 0;
    case "config":
      show(await call("config.get"), renderConfig);
      return 0;
    default:
      print(USAGE);
      return 2;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: Error) => {
      console.error(`maestro: ${error.message}`);
      process.exit(error instanceof Unreachable ? 2 : 1);
    },
  );
}
