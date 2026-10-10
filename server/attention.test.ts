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

  test("the decision asks that wait on you ride along, as given", () => {
    const ask = {
      scope: null,
      ledger: "2026-10-01-auth-preflight-hook-stderr.yaml",
      uid: null,
      id: "A1",
      headline: "Approve merge of PR #863?",
      blocking: true,
      askedAt: "2026-10-01T10:00Z",
    };
    expect(attentionOf([], now, [], [], [ask]).asks).toEqual([ask]);
    expect(attentionOf([], now).asks).toEqual([]);
  });

  test("waiting is the work at your gate, in list order; stuck work is watched, not waiting (A1)", () => {
    const { waiting } = attentionOf(
      [fakeWork("r", "review"), fakeWork("b", "blocked"), fakeWork("x", "running"), fakeWork("d", "done")],
      now,
    );
    expect(waiting).toEqual([{ id: "r", group: "review", flag: null }]);
  });

  test("waiting lists work only you may start after the work at your gate; a quiet run is watched (A1)", () => {
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
      { id: "q", group: "queued", flag },
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

  test("a composer pill names fleet work by the title a person reads, never its marker (BRO-2839)", () => {
    const raw = "1 ask (tick 7) [fleet-reconcile sri batch 7-3]";
    const { sessions } = attentionOf(
      [
        fakeWork("shown", "review", inA, { title: raw, display: { title: "The core comparison…", fleet: null } }),
        fakeWork("older", "review", inA, { title: raw }),
      ],
      now,
    );
    expect(sessions.map((session) => session.title)).toEqual(["The core comparison…", "1 ask (tick 7)"]);
  });
});

test("a list reconciles no session, however often it is called; the sweep's upkeep does each time it runs (BRO-2995)", async () => {
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
  for (let call = 0; call < 5; call += 1) await engine.list(fake.paseo);
  clock += 60_000;
  await engine.list(fake.paseo);
  expect(fake.refreshed).toEqual([]);
  await engine.upkeep(fake.paseo);
  expect(fake.refreshed).toEqual(["agent-1"]);
  await engine.upkeep(fake.paseo);
  expect(fake.refreshed).toEqual(["agent-1", "agent-1"]);
});
