import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeWork } from "../client/fake-work";
import { attentionOf, RECENT_MS } from "./attention";
import { defaultConfig } from "./config";
import { Engine } from "./engine";
import { fakePaseo } from "./fake-paseo";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const now = Date.parse("2026-09-29T12:00:00.000Z");
const ago = (ms: number) => new Date(now - ms).toISOString();
const inA = { agentId: "a1", workspaceId: "ws1" };

describe("work.attention", () => {
  test("the timeline's notices ride along beside the fleet's, as given", () => {
    const notice = {
      id: "launchd:com.broomva.kg-lint",
      kind: "launchd" as const,
      name: "kg-lint",
      status: "missed" as const,
      reason: "A run came due 2h ago and it has not run.",
      since: ago(7_200_000),
    };
    expect(attentionOf([], now, [], [notice]).timeline).toEqual([notice]);
    expect(attentionOf([], now).timeline).toEqual([]);
  });

  test("waiting is the work at your gate or stuck, in list order", () => {
    const { waiting } = attentionOf(
      [fakeWork("r", "review"), fakeWork("b", "blocked"), fakeWork("x", "running"), fakeWork("d", "done")],
      now,
    );
    expect(waiting).toEqual([
      { id: "r", group: "review", flag: null },
      { id: "b", group: "blocked", flag: null },
    ]);
  });

  test("waiting lists work the loop flagged too, after the work at your gate or stuck", () => {
    const flag = { kind: "yours" as const, reason: "Start it yourself: x.", at: ago(60_000) };
    const quiet = { kind: "quiet" as const, reason: "Quiet for 31 minutes, worth a look.", at: ago(60_000) };
    const { waiting } = attentionOf(
      [
        fakeWork("q", "proposed", null, { flag }),
        fakeWork("r", "review"),
        fakeWork("x", "running", inA, { flag: quiet }),
        fakeWork("plain", "running"),
        fakeWork("b", "blocked"),
      ],
      now,
    );
    expect(waiting).toEqual([
      { id: "r", group: "review", flag: null },
      { id: "b", group: "blocked", flag: null },
      { id: "q", group: "queued", flag },
      { id: "x", group: "running", flag: quiet },
    ]);
  });

  test("sessions are the workers of live work, and of finished work only for a day after it changed", () => {
    const { sessions } = attentionOf(
      [
        fakeWork("live", "running", inA, { updatedAt: ago(30 * RECENT_MS) }),
        fakeWork("just-done", "done", inA, { updatedAt: ago(RECENT_MS - 60_000) }),
        fakeWork("old-done", "done", inA, { updatedAt: ago(RECENT_MS) }),
        fakeWork("old-canceled", "canceled", inA, { updatedAt: ago(2 * RECENT_MS) }),
        fakeWork("unbound", "proposed"),
      ],
      now,
    );
    expect(sessions.map((session) => session.workId)).toEqual(["live", "just-done"]);
    expect(sessions[0]).toEqual({
      workId: "live",
      title: "Work live",
      state: "running",
      agentId: "a1",
      workspaceId: "ws1",
    });
    expect(RECENT_MS).toBe(24 * 60 * 60 * 1000);
  });
});

test("a list reconciles sessions at most once every 10 s, however often it is called", async () => {
  const root = await mkdtemp(join(tmpdir(), "maestro-attention-"));
  roots.push(root);
  const repo = join(root, "repo");
  // A git repository as far as Maestro checks: runs branch a worktree from it.
  await mkdir(join(repo, ".git"), { recursive: true });
  let clock = Date.parse("2026-09-29T09:00:00.000Z");
  const engine = new Engine({
    now: () => new Date(clock),
    config: async () => ({
      ...defaultConfig(),
      workRoot: join(root, "work"),
      provider: "claude",
      modeId: null,
      isolation: "worktree",
    }),
    log: () => undefined,
  });
  const fake = fakePaseo();
  await engine.create(fake.paseo, {
    title: "Throttled",
    brief: "",
    repo,
    gate: "human",
    check: "",
    initiative: "",
    dispatch: true,
  });
  await engine.list(fake.paseo);
  expect(fake.refreshed).toEqual(["agent-1"]);
  for (let call = 0; call < 5; call += 1) await engine.list(fake.paseo);
  clock += 9_000;
  await engine.list(fake.paseo);
  expect(fake.refreshed).toEqual(["agent-1"]);
  clock += 2_000;
  await engine.list(fake.paseo);
  expect(fake.refreshed).toEqual(["agent-1", "agent-1"]);
});
