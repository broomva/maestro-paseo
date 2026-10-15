import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, registryAt } from "./registry-fixture";
import {
  findTranscript,
  parseTranscriptUsage,
  projectFolderOf,
  readTranscriptUsage,
  registrySession,
  transcriptUsageReader,
} from "./usage";

const line = (value: unknown) => JSON.stringify(value);

/** One assistant line of a transcript: usage repeats on every content block of one message. */
const assistant = (
  id: string,
  usage: { in?: number; out?: number; read?: number; create?: number },
  extra: { model?: string; sidechain?: boolean; block?: string } = {},
) =>
  line({
    type: "assistant",
    isSidechain: extra.sidechain ?? false,
    message: {
      id,
      model: extra.model ?? "claude-sonnet-5-5",
      content: [{ type: extra.block ?? "text" }],
      usage: {
        input_tokens: usage.in ?? 0,
        output_tokens: usage.out ?? 0,
        cache_read_input_tokens: usage.read ?? 0,
        cache_creation_input_tokens: usage.create ?? 0,
      },
    },
  });

const user = line({ type: "user", message: { role: "user", content: "hello" } });

describe("parseTranscriptUsage", () => {
  test("a message whose usage repeats on every content block counts once", () => {
    const text = [
      user,
      assistant("m1", { in: 2, out: 400, read: 11_000, create: 52_000 }, { block: "thinking" }),
      assistant("m1", { in: 2, out: 400, read: 11_000, create: 52_000 }, { block: "text" }),
      assistant("m1", { in: 2, out: 400, read: 11_000, create: 52_000 }, { block: "tool_use" }),
      assistant("m2", { in: 3, out: 100, read: 63_000, create: 500 }),
    ].join("\n");
    const usage = parseTranscriptUsage(text);
    expect(usage.tokens).toEqual({ input: 5, output: 500, cacheRead: 74_000, cacheCreation: 52_500 });
    expect(usage.assistantMessages).toBe(2);
    expect(usage.subagents).toBeNull();
  });

  test("a streamed message takes the larger of each count, not the sum", () => {
    const text = [assistant("m1", { in: 2, out: 10 }), assistant("m1", { in: 2, out: 400 })].join("\n");
    expect(parseTranscriptUsage(text).tokens.output).toBe(400);
  });

  test("a sidechain line is not the main thread's: not in its tokens or its peak context", () => {
    const text = [
      assistant("main-1", { in: 1, read: 1000, create: 100 }),
      assistant(
        "side-1",
        { in: 9, out: 50, read: 900_000, create: 100_000 },
        { sidechain: true, model: "claude-opus-5-5" },
      ),
    ].join("\n");
    const usage = parseTranscriptUsage(text);
    expect(usage.tokens.input).toBe(1);
    expect(usage.peakContext).toBe(1101);
    expect(usage.assistantMessages).toBe(1);
    // It is a subagent's, so it is counted there.
    expect(usage.subagents?.tokens.cacheRead).toBe(900_000);
  });

  test("peak context is the most input + cache read + cache creation of a main-thread message", () => {
    const text = [
      assistant("a", { in: 1, read: 100, create: 10 }),
      assistant("b", { in: 2, read: 5000, create: 300 }),
      assistant("c", { in: 1, read: 200, create: 0 }),
    ].join("\n");
    expect(parseTranscriptUsage(text).peakContext).toBe(5302);
  });

  test("subagent transcripts are summed apart, and by the model that spent them", () => {
    const usage = parseTranscriptUsage(assistant("m1", { in: 1, out: 1 }), {
      "agent-a.jsonl": [
        assistant("s1", { in: 10, out: 20, read: 1000, create: 30 }, { sidechain: true, model: "claude-opus-5-5" }),
        assistant("s1", { in: 10, out: 20, read: 1000, create: 30 }, { sidechain: true, model: "claude-opus-5-5" }),
        assistant("s2", { in: 1, out: 2, create: 3 }, { sidechain: true, model: "claude-haiku-5" }),
      ].join("\n"),
      "agent-b.jsonl": assistant("s3", { in: 5, out: 5, create: 5 }, { sidechain: true, model: "claude-opus-5-5" }),
    });
    expect(usage.subagents?.tokens).toEqual({ input: 16, output: 27, cacheRead: 1000, cacheCreation: 38 });
    expect(usage.subagents?.byModel).toEqual({ "claude-opus-5-5": 10 + 20 + 30 + 15, "claude-haiku-5": 6 });
    expect(usage.subagents?.files).toEqual([
      { file: "agent-a.jsonl", models: ["claude-opus-5-5", "claude-haiku-5"] },
      { file: "agent-b.jsonl", models: ["claude-opus-5-5"] },
    ]);
  });

  test("an empty subagents folder is none spent, not none there; no folder is null", () => {
    expect(parseTranscriptUsage("", {}).subagents?.tokens).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
    });
    expect(parseTranscriptUsage("").subagents).toBeNull();
  });

  test("a message in both files counts once", () => {
    const usage = parseTranscriptUsage(assistant("same", { in: 1 }), {
      "a.jsonl": assistant("same", { in: 1 }, { sidechain: true }),
    });
    expect(usage.tokens.input).toBe(1);
    expect(usage.subagents?.tokens.input).toBe(0);
  });

  test("main-thread models are listed once each, in order, and a synthetic one is not a model", () => {
    const text = [
      assistant("a", { in: 1 }, { model: "claude-sonnet-5-5" }),
      assistant("b", { in: 1 }, { model: "<synthetic>" }),
      assistant("c", { in: 1 }, { model: "claude-opus-5-5" }),
      assistant("d", { in: 1 }, { model: "claude-sonnet-5-5" }),
    ].join("\n");
    expect(parseTranscriptUsage(text).mainModels).toEqual(["claude-sonnet-5-5", "claude-opus-5-5"]);
  });

  test("lines that are not assistant usage, or not JSON, are skipped", () => {
    const text = [
      user,
      "not json at all but it says assistant and usage",
      line({ type: "assistant", message: {} }),
    ].join("\n");
    expect(parseTranscriptUsage(text).assistantMessages).toBe(0);
  });
});

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "maestro-usage-"));
  dirs.push(root);
  const cwd = "/Users/test/.paseo/worktrees/abc/lane";
  const agentId = newId();
  const sessionId = newId();
  const registry = registryAt(join(root, "agents"));
  await registry.add({ id: agentId, cwd, sessionId });
  const projects = join(root, "projects");
  const folder = join(projects, projectFolderOf(cwd));
  await mkdir(join(folder, sessionId, "subagents"), { recursive: true });
  await writeFile(
    join(folder, `${sessionId}.jsonl`),
    [assistant("m1", { in: 1, out: 2 }), assistant("m1", { in: 1, out: 2 })].join("\n"),
  );
  await writeFile(
    join(folder, sessionId, "subagents", "agent-x.jsonl"),
    assistant("s1", { in: 7, out: 3 }, { sidechain: true, model: "claude-opus-5-5" }),
  );
  return { root, cwd, agentId, sessionId, agents: registry.dir, projects, folder };
}

describe("reading the files", () => {
  test("the project folder is the working directory with slashes and dots as dashes", () => {
    expect(projectFolderOf("/Users/broomva/.paseo/worktrees/x")).toBe("-Users-broomva--paseo-worktrees-x");
  });

  test("the registry gives the session, and the transcript is found in its project folder", async () => {
    const f = await fixture();
    const session = await registrySession(f.agentId, f.agents);
    expect(session).toEqual({ sessionId: f.sessionId, cwd: f.cwd });
    expect(await findTranscript(f.sessionId, f.cwd, f.projects)).toBe(join(f.folder, `${f.sessionId}.jsonl`));
    // Another folder name is found by looking through the projects.
    expect(await findTranscript(f.sessionId, "/somewhere/else", f.projects)).toBe(
      join(f.folder, `${f.sessionId}.jsonl`),
    );
    expect(await findTranscript(newId(), f.cwd, f.projects)).toBeNull();
  });

  test("a transcript is streamed with its subagents folder", async () => {
    const f = await fixture();
    const usage = await readTranscriptUsage(join(f.folder, `${f.sessionId}.jsonl`));
    expect(usage.tokens).toMatchObject({ input: 1, output: 2 });
    expect(usage.subagents?.tokens).toMatchObject({ input: 7, output: 3 });
  });

  test("the reader measures a claude run, and says why it cannot another provider or a missing transcript", async () => {
    const f = await fixture();
    const read = transcriptUsageReader({ agentsDir: f.agents, projectsDir: f.projects });
    const measured = await read(f.agentId, "claude/claude-sonnet-5-5");
    expect(measured.measured && measured.usage.assistantMessages).toBe(1);
    expect(await read(f.agentId, "codex/gpt-5.5")).toEqual({ measured: false, reason: "codex transcript not read" });
    expect(await read(newId(), "claude/claude-sonnet-5-5")).toEqual({
      measured: false,
      reason: "session not found in Paseo's registry",
    });
    const lost = transcriptUsageReader({ agentsDir: f.agents, projectsDir: join(f.root, "nowhere") });
    expect(await lost(f.agentId, "claude")).toEqual({ measured: false, reason: "transcript not found" });
  });
});
