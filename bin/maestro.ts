#!/usr/bin/env bun
// `maestro`: operate Maestro from a Paseo session, over the plugin's agent
// socket (server/agent-socket.ts). Node built-ins and dependency-free modules
// only, so it runs from a plugin install that has no dev packages.
//
// The session's agent id comes from PASEO_AGENT_ID, which Paseo sets in every
// session it starts, and every request carries the folder this shell is in. Maestro
// checks both against Paseo's registry before it acts (server/callers.ts): run it from
// inside the session. Anything done here is recorded as that session's.

import { connect } from "node:net";
import { resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";
import { expandHome, socketPath } from "../server/paths";
import type { MaestroConfig, WorkEventWire, WorkItem } from "../shared/contracts";
import { needsYouOf, sectionOf } from "../shared/needs-you";
import { GROUP_COPY, GROUP_ORDER, PLAIN_VOICE } from "../shared/states";
import { SESSIONS_START_NOTHING } from "../shared/text";
import { TIERS } from "../shared/tiers";

const USAGE = `maestro: operate Maestro from a Paseo session

  maestro ls                          All work, what needs you first
  maestro show <id>                   One item: state, the look at the gate, receipts
  maestro new <title> [options]       Create work (it waits at your gate, queued)
      --brief <text>                  What to do and why
      --repo <path>                   Where runs happen (default: this directory)
      --initiative <name>             Group it under a folder
      --tier <t>                      mechanical | standard | frontier | apex: what the work is meant to get;
                                      the owner's tier ladder in Settings turns it into a provider and thinking level
      --provider <p>                  claude/claude-sonnet-5-5 style (owner's to set: set aside from a session)
      --thinking <id>                 The thinking level (owner's to set: set aside from a session)
  maestro track [--title <text>] [--ticket <id>]  Track this session as work (or --agent <id>, a session it started)
  maestro mine                        The work this session is running (or --agent <id>, a session it started)
  maestro config                      Where work lives and how runs start
  maestro approval request <action>   Ask leave for one exact action a policy layer held
      --ref <sha>                     What it is bound to: a head SHA, a version
      --held-by <layer>               gate, policy, ... (default: policy)
      --title <text>  --ticket <id>   How the card reads
  maestro approval withdraw <id>      Take your request back

  --json                              Print the raw answer

Exit codes: 0 done · 1 Maestro refused · 2 Maestro is not listening, or bad usage ·
3 no clear answer (the request may still have been applied: check before retrying).

Run it from inside the session: Maestro checks PASEO_AGENT_ID and this folder against
Paseo's registry, and acts only for that live session (track, mine, approval).

Starting work is yours, in Maestro, or a lane's or the conductor's: there is no dispatch
here. Allow, Deny, change of course, unblock and cancel are yours too: work is never
approved, gates merge it. A session can only ask leave for an action (approval request);
it cannot decide it, pass its own gate, restart stuck work, or write a done check.

The tier is recorded with the work, counted in Maestro's economy, and resolved at dispatch through the tier
ladder in Maestro's Settings. How a run starts (--provider, --thinking) is the owner's to set in Maestro: a
session's choice of either is set aside, and the answer says so.`;

/** The command line does not say what to do. */
export class Usage extends Error {}
/** Nothing was sent: Maestro is not listening there. */
export class Unreachable extends Error {}
/** Maestro answered no. */
export class Refused extends Error {}
/** The request went out and no clear answer came back; it may have been applied. */
export class NoAnswer extends Error {}

/** One request, one answer. Rejects with `Refused` when Maestro answers with an error. */
export function call(
  method: string,
  input: unknown = {},
  options: { path?: string; caller?: string | null; cwd?: string | null; timeoutMs?: number } = {},
): Promise<unknown> {
  const path = options.path ?? socketPath();
  const caller = options.caller === undefined ? process.env.PASEO_AGENT_ID || null : options.caller;
  // Where this shell is: Maestro checks it against the folder the session runs in.
  const cwd = options.cwd === undefined ? process.cwd() : options.cwd;
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = "";
    let settled = false;
    let sent = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const unanswered = (why: string) =>
      new NoAnswer(`${why} The request may still have been applied: check with maestro ls before retrying.`);
    const timer = setTimeout(
      () => settle(() => reject(unanswered(`Maestro did not answer in time on ${path}.`))),
      // Under the two minutes a Claude Code Bash call gets, so a session sees this message, not a kill.
      options.timeoutMs ?? 90_000,
    );
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      sent = true;
      socket.write(`${JSON.stringify({ id: 1, method, input, caller, cwd })}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      settle(() => {
        let response: { ok?: unknown; output?: unknown; error?: unknown } | null = null;
        try {
          response = JSON.parse(line);
        } catch {
          // falls through to the malformed answer below
        }
        if (response?.ok === true) resolve(response.output);
        else if (response?.ok === false) reject(new Refused(String(response.error ?? "Maestro refused.")));
        else reject(unanswered(`Maestro answered with something that is not a response: ${line.slice(0, 200)}`));
      });
    });
    socket.on("error", (error: NodeJS.ErrnoException) =>
      settle(() => {
        if (sent)
          reject(unanswered(`The connection failed after the request went out (${error.code ?? error.message}).`));
        else if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
          reject(
            new Unreachable(
              `Maestro is not listening on ${path}. Is the maestro plugin installed and running on this Paseo daemon?`,
            ),
          );
        } else reject(new Unreachable(`Could not reach Maestro on ${path}: ${error.code ?? error.message}.`));
      }),
    );
    socket.on("close", () => settle(() => reject(unanswered("Maestro closed the connection without answering."))));
  });
}

const short = (id: string) => id.slice(0, 8);

function renderItem(item: WorkItem): string {
  const where = item.repo ? `  ${item.repo}` : "";
  const why = [item.reason, item.flag?.reason]
    .filter(Boolean)
    .map((line) => `\n      ${line}`)
    .join("");
  return `  ${item.id}  ${item.title}${where}${why}`;
}

function renderList(output: { root: string; items: WorkItem[]; warnings: string[] }): string {
  const lines = [`Work in ${output.root}`];
  // Grouped as Maestro shows it: Needs you holds work only you may start too; Stuck is its own (shared/needs-you.ts).
  for (const group of GROUP_ORDER) {
    const items =
      group === "review" ? needsYouOf(output.items) : output.items.filter((item) => sectionOf(item) === group);
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
  if (item.group === "review") {
    lines.push(
      "",
      item.permission
        ? "Waiting on a question: Allow or Deny it in Maestro."
        : "Finished: gates merge it; change its course in Maestro if it is not right.",
    );
  }
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

function parse(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: "boolean", default: false },
        brief: { type: "string", default: "" },
        repo: { type: "string" },
        initiative: { type: "string", default: "" },
        tier: { type: "string" },
        provider: { type: "string" },
        thinking: { type: "string" },
        dispatch: { type: "boolean", default: false },
        title: { type: "string", default: "" },
        ref: { type: "string" },
        "held-by": { type: "string" },
        ticket: { type: "string" },
        agent: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    throw new Usage((error as Error).message);
  }
}

export async function main(argv: string[], print: (text: string) => void = console.log): Promise<number> {
  const { values, positionals } = parse(argv);
  const [command, ...rest] = positionals;
  const show = <T>(output: unknown, render: (value: T) => string) =>
    print(values.json ? JSON.stringify(output, null, 2) : render(output as T));
  const needId = () => {
    const id = rest[0];
    if (!id) throw new Usage(`Usage: maestro ${command} <id>. Ids are listed by: maestro ls`);
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
      if (!title) throw new Usage("Usage: maestro new <title> [--brief <text>] [--repo <path>]");
      // Refused before anything is created or sent: a session starts nothing (A8), and a half-made item helps nobody.
      if (values.dispatch) throw new Refused(SESSIONS_START_NOTHING);
      if (values.tier !== undefined && !(TIERS as readonly string[]).includes(values.tier)) {
        throw new Usage(`--tier is one of ${TIERS.join(", ")}, not ${values.tier}`);
      }
      const input = {
        title,
        brief: values.brief,
        repo: resolvePath(expandHome(values.repo ?? ".")),
        initiative: values.initiative,
        ...(values.tier ? { tier: values.tier } : {}),
        ...(values.provider ? { provider: values.provider } : {}),
        ...(values.thinking ? { thinkingOptionId: values.thinking } : {}),
      };
      show(await call("work.create", input), (output: { item: WorkItem; notice?: string | null }) =>
        [renderOne("Created", output), ...(output.notice ? [output.notice] : [])].join("\n"),
      );
      return 0;
    }
    case "dispatch":
      throw new Refused(SESSIONS_START_NOTHING);
    case "track":
      show(
        await call("work.adopt", { agentId: values.agent, title: values.title, ticket: values.ticket }),
        (output: { item: WorkItem }) => renderOne("Tracking", output),
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
    case "approval": {
      const [verb, ...words] = rest;
      if (verb === "request") {
        const action = words.join(" ").trim();
        if (!action) throw new Usage("Usage: maestro approval request <action> [--ref <sha>] [--held-by <layer>]");
        const input = {
          action,
          ref: values.ref,
          heldBy: values["held-by"],
          title: values.title || undefined,
          ticket: values.ticket,
        };
        show(
          await call("approval.request", input),
          (output: { id: string }) =>
            `Asked: ${action}${values.ref ? ` @ ${values.ref}` : ""}\n  ${output.id}  waiting in Needs you; the answer comes to this session.`,
        );
        return 0;
      }
      if (verb === "withdraw") {
        const id = words[0];
        if (!id) throw new Usage("Usage: maestro approval withdraw <id>");
        show(await call("approval.withdraw", { id }), (output: { withdrawn: boolean }) =>
          output.withdrawn ? "Withdrawn." : "Nothing was waiting under that id.",
        );
        return 0;
      }
      throw new Usage("Usage: maestro approval request <action> | withdraw <id>");
    }
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
      process.exit(error instanceof Usage || error instanceof Unreachable ? 2 : error instanceof NoAnswer ? 3 : 1);
    },
  );
}
