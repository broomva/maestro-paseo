// What a Claude Code session has used (BRO-3118): its tokens, read from the transcript Claude Code keeps for it. A
// transcript is JSON lines; an assistant message is written once per content block, each line repeating the message's
// whole `usage`, so counting lines overcounts: a message counts once, by `message.id`. The main thread is the lines
// with no `isSidechain: true`; a subagent's own lines live in `<session>/subagents/*.jsonl`.
//
// UsageCollector is the pure parser (it takes lines); readTranscriptUsage is the thin IO around it. A transcript can
// reach hundreds of megabytes, so a file is streamed a line at a time and never held as one string.

import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Tokens } from "../shared/economy";
import { paseoAgentsDir } from "./paths";

export const NO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

/**
 * How much of one session Maestro reads. Past any of these the session is unmeasured (`measured: false`, and why),
 * never partial numbers presented as measured: a transcript that size is a runaway, and a daemon must not stall on it.
 * The largest transcript on a busy Mac is about 300 MB.
 */
export interface UsageLimits {
  /** One transcript file. */
  fileBytes: number;
  /** The main transcript and every subagent's together. */
  sessionBytes: number;
  /** Subagent transcript files, however deep they sit. */
  subagentFiles: number;
}

export const USAGE_LIMITS: UsageLimits = { fileBytes: 400_000_000, sessionBytes: 1_000_000_000, subagentFiles: 1000 };

/** The session is past a limit: its numbers would be partial, so it is not read. */
export class UsageBound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageBound";
  }
}

interface Seen {
  tokens: Tokens;
  model: string | null;
  /** The subagent transcript it came from; null for the main thread. */
  file: string | null;
}

/** The usage a transcript holds, split by who spent it. */
export interface TranscriptUsage {
  tokens: Tokens;
  /** The most context a main-thread message carried: input + cache read + cache creation. */
  peakContext: number | null;
  assistantMessages: number;
  /** The distinct models the main thread ran on, in the order they first appeared. */
  mainModels: string[];
  /** Null when the session has no subagents folder and no subagent lines. */
  subagents: {
    tokens: Tokens;
    /** Model id to tokens (input + output + cache creation) over that model's messages. */
    byModel: Record<string, number>;
    /** One entry per subagent transcript: the models it ran on. */
    files: Array<{ file: string; models: string[] }>;
  } | null;
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

const add = (into: Tokens, from: Tokens): void => {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheCreation += from.cacheCreation;
};

/** Input, output and cache creation: what a run cost to start and say. Cache reads are counted apart. */
export const billed = (tokens: Tokens): number => tokens.input + tokens.output + tokens.cacheCreation;

/** Collects assistant usage from transcript lines. One instance per session; feed it the main file, then each subagent's. */
export class UsageCollector {
  private readonly seen = new Map<string, Seen>();
  private anonymous = 0;
  private subagentsFolder = false;

  /** The session has a `subagents/` folder, even if nothing is in it. */
  markSubagentsFolder(): void {
    this.subagentsFolder = true;
  }

  /**
   * One transcript line. `file` is the subagent transcript it comes from, or null for the main file. A line that is
   * not an assistant message with usage is skipped; a message already seen takes the larger of each count (a
   * streamed message's later blocks may carry the final output tokens) and is not counted again.
   */
  push(line: string, file: string | null): void {
    // Cheap test before the parse: most lines of a transcript are tool results and attachments.
    if (!line.includes('"assistant"') || !line.includes('"usage"')) return;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (entry.type !== "assistant") return;
    const message = entry.message as { id?: unknown; model?: unknown; usage?: Record<string, unknown> } | undefined;
    const usage = message?.usage;
    if (!usage || typeof usage !== "object") return;
    const tokens: Tokens = {
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheCreation: num(usage.cache_creation_input_tokens),
    };
    const model =
      typeof message?.model === "string" && message.model && message.model !== "<synthetic>" ? message.model : null;
    // A sidechain line in the main file is a subagent's, whichever file it sits in.
    const owner = file ?? (entry.isSidechain === true ? "(sidechain)" : null);
    this.anonymous += 1;
    const id = typeof message?.id === "string" && message.id ? message.id : `anonymous:${this.anonymous}`;
    const before = this.seen.get(id);
    if (!before) {
      this.seen.set(id, { tokens, model, file: owner });
      return;
    }
    before.tokens.input = Math.max(before.tokens.input, tokens.input);
    before.tokens.output = Math.max(before.tokens.output, tokens.output);
    before.tokens.cacheRead = Math.max(before.tokens.cacheRead, tokens.cacheRead);
    before.tokens.cacheCreation = Math.max(before.tokens.cacheCreation, tokens.cacheCreation);
    before.model ??= model;
  }

  result(): TranscriptUsage {
    const main = { ...NO_TOKENS };
    const sub = { ...NO_TOKENS };
    const byModel: Record<string, number> = {};
    const files = new Map<string, Set<string>>();
    const mainModels: string[] = [];
    let peak: number | null = null;
    let messages = 0;
    for (const message of this.seen.values()) {
      if (message.file === null) {
        add(main, message.tokens);
        messages += 1;
        const context = message.tokens.input + message.tokens.cacheRead + message.tokens.cacheCreation;
        peak = peak === null ? context : Math.max(peak, context);
        if (message.model && !mainModels.includes(message.model)) mainModels.push(message.model);
        continue;
      }
      add(sub, message.tokens);
      const models = files.get(message.file) ?? new Set<string>();
      files.set(message.file, models);
      if (message.model) {
        models.add(message.model);
        byModel[message.model] = (byModel[message.model] ?? 0) + billed(message.tokens);
      }
    }
    const present = this.subagentsFolder || files.size > 0;
    return {
      tokens: main,
      peakContext: peak,
      assistantMessages: messages,
      mainModels,
      subagents: present
        ? {
            tokens: sub,
            byModel,
            files: [...files].map(([file, models]) => ({ file, models: [...models] })),
          }
        : null,
    };
  }
}

/** Usage from the text of a main transcript and the texts of its subagents' transcripts (by file name). Pure. */
export function parseTranscriptUsage(main: string, subagents: Record<string, string> | null = null): TranscriptUsage {
  const collector = new UsageCollector();
  for (const line of main.split("\n")) collector.push(line, null);
  if (subagents) {
    collector.markSubagentsFolder();
    for (const [file, text] of Object.entries(subagents)) {
      for (const line of text.split("\n")) collector.push(line, file);
    }
  }
  return collector.result();
}

async function feed(collector: UsageCollector, path: string, file: string | null): Promise<void> {
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) collector.push(line, file);
}

/** How deep under `subagents/` a transcript may sit: Workflow agents are at `workflows/wf_<id>/agent-<id>.jsonl`. */
const SUBAGENT_DEPTH = 8;

/**
 * Every `.jsonl` under a session's `subagents/` folder, at any depth (Claude Code writes Workflow-tool agents to
 * `subagents/workflows/wf_<id>/agent-<id>.jsonl`), by path relative to it, with `/` between parts, in a stable order.
 * Null when there is no folder. More than `limit` files is a bound crossed: it stops there and says so.
 */
export async function subagentFiles(folder: string, limit: number): Promise<string[] | null> {
  const found: string[] = [];
  const walk = async (dir: string, prefix: string, depth: number): Promise<boolean> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) return false;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length > limit) break;
      if (entry.isDirectory() && depth < SUBAGENT_DEPTH) {
        await walk(join(dir, entry.name), `${prefix}${entry.name}/`, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(`${prefix}${entry.name}`);
    }
    return true;
  };
  return (await walk(folder, "", 0)) ? found : null;
}

/**
 * Usage from a session's transcript file and everything under its `<session>/subagents/` folder, streamed. Past a
 * limit (USAGE_LIMITS) it throws UsageBound before reading a line: the session is unmeasured, not partly counted.
 */
export async function readTranscriptUsage(
  transcript: string,
  limits: UsageLimits = USAGE_LIMITS,
): Promise<TranscriptUsage> {
  const folder = join(transcript.replace(/\.jsonl$/, ""), "subagents");
  const names = await subagentFiles(folder, limits.subagentFiles);
  if (names && names.length > limits.subagentFiles) {
    throw new UsageBound(`more than ${limits.subagentFiles} subagent transcripts`);
  }
  const paths: Array<[string, string | null]> = [
    [transcript, null],
    ...(names ?? []).map((name): [string, string] => [join(folder, name), name]),
  ];
  let total = 0;
  for (const [path] of paths) {
    const size = (await stat(path)).size;
    if (size > limits.fileBytes) {
      throw new UsageBound(
        `a transcript is ${Math.round(size / 1e6)} MB: over the ${Math.round(limits.fileBytes / 1e6)} MB bound`,
      );
    }
    total += size;
    if (total > limits.sessionBytes) {
      throw new UsageBound(`the session's transcripts total over ${Math.round(limits.sessionBytes / 1e6)} MB`);
    }
  }
  const collector = new UsageCollector();
  if (names) collector.markSubagentsFolder();
  for (const [path, file] of paths) await feed(collector, path, file);
  return collector.result();
}

/** Where Claude Code keeps its transcripts: `projects/` in CLAUDE_CONFIG_DIR, else ~/.claude. A test names its own. */
export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MAESTRO_PASEO_CLAUDE_PROJECTS) return env.MAESTRO_PASEO_CLAUDE_PROJECTS;
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
}

/** What Maestro reads of Paseo's registry file for an agent: its Claude session, and where it ran. */
export interface RegistrySession {
  sessionId: string | null;
  cwd: string | null;
}

/** The registry file of `agentId`, under `agents/<folder>/<id>.json`, or null. Only the session and folder are read. */
export async function registrySession(agentId: string, agentsDir = paseoAgentsDir()): Promise<RegistrySession | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(agentId)) return null;
  for (const folder of await readdir(agentsDir).catch(() => [] as string[])) {
    let json: { persistence?: { sessionId?: unknown }; runtimeInfo?: { sessionId?: unknown }; cwd?: unknown };
    try {
      json = JSON.parse(await readFile(join(agentsDir, folder, `${agentId}.json`), "utf8"));
    } catch {
      continue;
    }
    const session = json.persistence?.sessionId ?? json.runtimeInfo?.sessionId;
    return {
      sessionId: typeof session === "string" && session ? session : null,
      cwd: typeof json.cwd === "string" ? json.cwd : null,
    };
  }
  return null;
}

/** Claude Code's project folder for a working directory: its path with every character that is not a letter or digit turned to a dash. */
export const projectFolderOf = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, "-");

/** The transcript of a Claude session: in its project folder when the folder is known, else the first project that holds it. */
export async function findTranscript(
  sessionId: string,
  cwd: string | null,
  projectsDir = claudeProjectsDir(),
): Promise<string | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) return null;
  const has = (path: string) =>
    stat(path).then(
      (info) => info.isFile(),
      () => false,
    );
  if (cwd) {
    const direct = join(projectsDir, projectFolderOf(cwd), `${sessionId}.jsonl`);
    if (await has(direct)) return direct;
  }
  for (const folder of await readdir(projectsDir).catch(() => [] as string[])) {
    const path = join(projectsDir, folder, `${sessionId}.jsonl`);
    if (await has(path)) return path;
  }
  return null;
}

/** What the engine asks to know about an agent's usage: its numbers, or why there are none. */
export type UsageRead = { measured: true; usage: TranscriptUsage } | { measured: false; reason: string };

export type UsageReader = (agentId: string, provider: string) => Promise<UsageRead>;

/**
 * The real reader: the Claude transcript of the agent, through Paseo's registry. Another provider's usage is not read
 * (Codex keeps its own format), so it is unmeasured, and says why. Never throws: a read that fails is unmeasured too.
 */
export function transcriptUsageReader(
  options: { agentsDir?: string; projectsDir?: string; limits?: UsageLimits } = {},
): UsageReader {
  return async (agentId, provider) => {
    const family = provider.trim().split("/")[0] ?? "";
    if (family !== "claude") return { measured: false, reason: `${family || "this provider"} transcript not read` };
    try {
      const session = await registrySession(agentId, options.agentsDir);
      if (!session?.sessionId) return { measured: false, reason: "session not found in Paseo's registry" };
      const transcript = await findTranscript(session.sessionId, session.cwd, options.projectsDir);
      if (!transcript) return { measured: false, reason: "transcript not found" };
      return { measured: true, usage: await readTranscriptUsage(transcript, options.limits) };
    } catch (error) {
      return {
        measured: false,
        reason:
          error instanceof UsageBound
            ? `not read: ${error.message}`
            : `transcript not read: ${(error as Error).message}`,
      };
    }
  };
}
