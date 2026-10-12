// approval.decide and approval.request (A1, BRO-2999): Allow and Deny on one exact held action, recorded when you
// decide, applied after the 8 s undo window, with a receipt, bound to the action you saw.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MaestroConfig } from "../shared/contracts";
import { approvalKey, holdOf, permissionAction, workKey } from "../shared/needs";
import { UNDO_MS } from "../shared/undo";
import { agentMethods, GATE_METHODS } from "./agent-socket";
import { Approvals } from "./approvals";
import { defaultConfig } from "./config";
import { Engine, type Timer } from "./engine";
import { fakePaseo } from "./fake-paseo";
import { needsOf } from "./needs";
import { OwnerVerbs } from "./owner-verbs";
import { newId, registryAt } from "./registry-fixture";
import { decideApprovalHandler, promptSessionHandler, registerApprovalVerbs } from "./verb-specs";

let clock = Date.parse("2026-10-12T09:00:00.000Z");
const tickMs = (ms: number) => {
  clock += ms;
};

function fakeTimers() {
  const armed: Array<{ run: () => Promise<void>; ms: number; canceled: boolean }> = [];
  const timer: Timer = (run, ms) => {
    const entry = { run, ms, canceled: false };
    armed.push(entry);
    return () => {
      entry.canceled = true;
    };
  };
  return {
    timer,
    fire: async () => {
      for (const entry of armed.splice(0)) if (!entry.canceled) await entry.run();
    },
  };
}

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

beforeEach(() => {
  clock = Date.parse("2026-10-12T09:00:00.000Z");
});

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "maestro-approvals-")));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  const config: MaestroConfig = { ...defaultConfig(), workRoot: join(root, "work"), provider: "claude", modeId: null };
  const timers = fakeTimers();
  const now = () => new Date(clock);
  const engine = new Engine({
    now,
    config: async () => config,
    log: () => {},
    timer: timers.timer,
    claimWaitMs: 200,
    git: async () => ({ branch: null, githubRepo: null }),
    merged: async () => null,
  });
  const fake = fakePaseo({ now });
  const verbs = new OwnerVerbs({ path: join(root, "verbs.jsonl"), now, timer: timers.timer, client: () => fake.paseo });
  const approvals = new Approvals({ path: join(root, "approvals.jsonl"), now });
  const deps = { verbs, engine, approvals };
  registerApprovalVerbs(deps);
  const registry = registryAt(join(root, "agents"));
  /**
   * A live Paseo session as the socket sees it: in the registry (its agent id is a uuid, its folder its own), and in
   * the daemon the owner's Allow is sent through. Returns what a request from it says of itself.
   */
  const session = async () => {
    const id = newId();
    const cwd = join(root, "sessions", id.slice(0, 8));
    await mkdir(cwd, { recursive: true });
    await registry.add({ id, cwd });
    fake.addSession(id);
    return { agentId: id, cwd };
  };
  const item = await engine.create(fake.paseo, {
    title: "Ship the fix",
    brief: "",
    repo,
    gate: "human",
    check: "",
    initiative: "",
    dispatch: true,
  });
  /** The session asks to run a command: the work lands at the gate holding that prompt, as a hook reports it. */
  const ask = async (id: string, command: string) => {
    fake.agents.get("agent-1")?.pendingPermissions.push({ id, name: "Bash" });
    await engine.onPermissionRequested({ id: "agent-1" }, { id, name: "Bash", input: { command } });
  };
  return {
    engine,
    fake,
    verbs,
    approvals,
    timers,
    item,
    ask,
    decide: decideApprovalHandler(deps),
    prompt: promptSessionHandler(deps),
    root,
    callers: registry.callers,
    session,
  };
}

describe("approval.decide on a permission prompt", () => {
  test("Allow records now, answers the session after 8 s, and leaves a receipt", async () => {
    const { engine, fake, verbs, timers, item, ask, decide } = await setup();
    await ask("p1", "git push origin main");
    const held = (await engine.get(item.id)).item;
    expect(held).toMatchObject({ state: "review", permission: { requestId: "p1" } });
    const action = permissionAction(held.permission as { title: string; detail: string | null });

    const made = await decide({ key: workKey(item.id), allow: true, action });
    expect(made.appliesAt).toBe(new Date(clock + UNDO_MS).toISOString());
    // Recorded, not applied: the session still waits, and the work still holds the prompt.
    expect(fake.answered).toEqual([]);
    expect((await engine.get(item.id)).item.state).toBe("review");
    expect((await verbs.list()).pending).toMatchObject([
      { receipt: made.receipt, verb: "approval.decide", key: workKey(item.id), label: `Allowed ${action}` },
    ]);

    tickMs(UNDO_MS - 1);
    await timers.fire();
    expect(fake.answered).toEqual([]);
    tickMs(1);
    await timers.fire();
    expect(fake.answered).toEqual([{ agentId: "agent-1", requestId: "p1", response: { behavior: "allow" } }]);
    // The engine learned of it from the verb itself, not from a hook: the work is running again.
    expect((await engine.get(item.id)).item).toMatchObject({ state: "running", permission: null });
    expect((await verbs.list()).recent).toMatchObject([
      { receipt: made.receipt, outcome: "applied", detail: `Allowed: ${action}` },
    ]);
  });

  test("Deny answers with the note", async () => {
    const { engine, fake, timers, item, ask, decide } = await setup();
    await ask("p1", "rm -rf dist");
    const action = permissionAction((await engine.get(item.id)).item.permission as { title: string; detail: null });
    await decide({ key: workKey(item.id), allow: false, action, note: "Not that folder" });
    tickMs(UNDO_MS);
    await timers.fire();
    expect(fake.answered).toEqual([
      { agentId: "agent-1", requestId: "p1", response: { behavior: "deny", message: "Not that folder" } },
    ]);
  });

  test("Undo inside the window sends nothing, and the work still holds the prompt", async () => {
    const { engine, fake, verbs, timers, item, ask, decide } = await setup();
    await ask("p1", "git push");
    const action = permissionAction((await engine.get(item.id)).item.permission as { title: string; detail: null });
    const made = await decide({ key: workKey(item.id), allow: true, action });
    tickMs(3000);
    expect(await verbs.undo(made.receipt)).toEqual({ undone: true });
    tickMs(UNDO_MS);
    await timers.fire();
    expect(fake.answered).toEqual([]);
    expect((await engine.get(item.id)).item).toMatchObject({ state: "review", permission: { requestId: "p1" } });
    // And it can be decided again.
    await decide({ key: workKey(item.id), allow: false, action });
  });

  test("a decision binds to the exact action: a new prompt in the window drops it, and nothing is sent", async () => {
    const { engine, fake, verbs, timers, item, ask, decide } = await setup();
    await ask("p1", "git status");
    const action = permissionAction((await engine.get(item.id)).item.permission as { title: string; detail: null });
    await decide({ key: workKey(item.id), allow: true, action });
    // The session's prompt changes before the window closes: a different command is a different action.
    await engine.onPermissionResolved({ id: "agent-1" }, "p1");
    await ask("p2", "git push --force");
    tickMs(UNDO_MS);
    await timers.fire();
    expect(fake.answered).toEqual([]);
    expect((await verbs.list()).recent).toMatchObject([
      { outcome: "dropped", detail: expect.stringContaining("moved on") },
    ]);
    expect((await engine.get(item.id)).item.permission).toMatchObject({ requestId: "p2" });
  });

  test("a decision on an action that is no longer the one waiting is refused at once", async () => {
    const { item, ask, decide, verbs } = await setup();
    await ask("p1", "git push");
    await expect(decide({ key: workKey(item.id), allow: true, action: "Run: ls" })).rejects.toThrow(
      "asks something else",
    );
    expect((await verbs.list()).pending).toEqual([]);
  });

  test("a decision that names the prompt's request id is refused when another prompt waits", async () => {
    const { engine, item, ask, decide } = await setup();
    await ask("p1", "git push");
    const held = (await engine.get(item.id)).item;
    const action = permissionAction(held.permission as { title: string; detail: string | null });
    await expect(decide({ key: workKey(item.id), allow: true, action, requestId: "other" })).rejects.toThrow(
      "asks something else",
    );
    await decide({ key: workKey(item.id), allow: true, action, requestId: "p1" });
  });

  test("the same prompt described differently is a different action: nothing is sent", async () => {
    const { engine, fake, item, ask } = await setup();
    await ask("p1", "git push");
    await expect(
      engine.answerPermission(fake.paseo, item.id, {
        requestId: "p1",
        action: "Run: git push --force",
        allow: true,
        note: "",
      }),
    ).rejects.toThrow("asks something else");
    expect(fake.answered).toEqual([]);
  });

  test("a prompt the session no longer holds is dropped, and the work's record catches up", async () => {
    const { engine, fake, verbs, timers, item, ask, decide } = await setup();
    await ask("p1", "git push");
    const action = permissionAction((await engine.get(item.id)).item.permission as { title: string; detail: null });
    await decide({ key: workKey(item.id), allow: true, action });
    // Answered in the session's own window meanwhile.
    const agent = fake.agents.get("agent-1");
    if (agent) agent.pendingPermissions = [];
    tickMs(UNDO_MS);
    await timers.fire();
    expect(fake.answered).toEqual([]);
    expect((await verbs.list()).recent).toMatchObject([
      { outcome: "dropped", detail: expect.stringContaining("no longer holds") },
    ]);
    expect((await engine.get(item.id)).item.state).toBe("running");
  });

  test("Allow and Deny on work with no prompt, and on anything else, are refused", async () => {
    const { item, decide } = await setup();
    await expect(decide({ key: workKey(item.id), allow: true, action: "x" })).rejects.toThrow("Nothing is waiting");
    await expect(decide({ key: "ask:[]", allow: true, action: "x" })).rejects.toThrow("Only a held action");
    expect(holdOf("approval:abc")).toEqual({ kind: "approval", id: "abc" });
  });
});

/** An agent-socket method, called as the session `claim` names (its agent id and the folder its shell is in) would. */
function call(
  methods: ReturnType<typeof agentMethods>,
  name: string,
  input: unknown,
  claim: { agentId: string | null; cwd: string | null },
) {
  const method = methods.get(name);
  if (!method) throw new Error(`the socket offers no ${name}`);
  return method(input, claim);
}

describe("approval.request: an agent asks leave for one exact action", () => {
  const ASK = {
    action: "gh pr merge 933 --squash",
    ref: "ce73104",
    heldBy: "gate",
    title: "Merge #933",
    scope: "broomva",
    ticket: "BRO-2999",
    evidence: [{ label: "Checks", value: "9 of 9 passed", tone: "ok" }],
  } as const;

  test("it raises one approval hold, once, whatever number of times it asks", async () => {
    const { approvals, engine, fake, callers, session } = await setup();
    const methods = agentMethods(engine, () => fake.paseo, approvals, callers);
    const asker = await session();
    const first = (await call(methods, "approval.request", ASK, asker)) as { id: string; key: string };
    const again = (await call(methods, "approval.request", ASK, asker)) as { id: string };
    expect(again.id).toBe(first.id);
    expect(holdOf(first.key)).toEqual({ kind: "approval", id: first.id });
    // Another head is another request.
    tickMs(1000);
    await call(methods, "approval.request", { ...ASK, ref: "aaaaaaa" }, asker);
    const open = await approvals.open();
    expect(open.map((entry) => entry.action)).toEqual([
      "gh pr merge 933 --squash @ ce73104",
      "gh pr merge 933 --squash @ aaaaaaa",
    ]);

    const needs = needsOf(
      { items: [], asks: [], reviews: [], landing: null, workspace: "broomva", approvals: open },
      clock,
    );
    expect(needs.summary.byKind).toEqual({ ask: 0, approval: 2, owner_step: 0 });
    expect(needs.rows[0]).toMatchObject({
      kind: "approval",
      key: approvalKey(first.id),
      title: "Merge #933",
      scope: "broomva",
      ticket: "BRO-2999",
      blocksWork: true,
      verbs: ["allow", "deny"],
      session: { agentId: asker.agentId, waiting: true },
      body: {
        action: "gh pr merge 933 --squash @ ce73104",
        heldBy: "gate",
        evidence: [{ label: "Checks", value: "9 of 9 passed", tone: "ok" }],
      },
    });
  });

  test("Allow tells the session the exact action after 8 s, and the hold leaves Needs you", async () => {
    const { approvals, engine, fake, verbs, timers, decide, callers, session } = await setup();
    const methods = agentMethods(engine, () => fake.paseo, approvals, callers);
    const asker = await session();
    const { id, key } = (await call(methods, "approval.request", ASK, asker)) as {
      id: string;
      key: string;
    };
    const action = "gh pr merge 933 --squash @ ce73104";
    const made = await decide({ key, allow: true, action });
    expect(fake.sent).toEqual([]);
    expect((await approvals.open()).map((entry) => entry.id)).toEqual([id]);
    tickMs(UNDO_MS);
    await timers.fire();
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ agentId: asker.agentId });
    expect(fake.sent[0]?.text).toContain(`the owner allowed this exact action: ${action}`);
    expect(await approvals.open()).toEqual([]);
    expect((await verbs.list()).recent).toMatchObject([
      { receipt: made.receipt, outcome: "applied", detail: `Allowed: ${action}` },
    ]);
  });

  test("Deny tells the session, with your note; Undo sends nothing and keeps the hold", async () => {
    const { approvals, engine, fake, verbs, timers, decide, callers, session } = await setup();
    const methods = agentMethods(engine, () => fake.paseo, approvals, callers);
    const { key } = (await call(methods, "approval.request", ASK, await session())) as { key: string };
    const action = "gh pr merge 933 --squash @ ce73104";
    const undone = await decide({ key, allow: false, action });
    await verbs.undo(undone.receipt);
    tickMs(UNDO_MS);
    await timers.fire();
    expect(fake.sent).toEqual([]);
    expect(await approvals.open()).toHaveLength(1);
    await decide({ key, allow: false, action, note: "Wait for the second review." });
    tickMs(UNDO_MS);
    await timers.fire();
    expect(fake.sent[0]?.text).toContain("denied this action");
    expect(fake.sent[0]?.text).toContain("Wait for the second review.");
    expect(await approvals.open()).toEqual([]);
  });

  test("a decision on a request whose action changed is refused; one whose session is gone is dropped", async () => {
    const { approvals, engine, fake, verbs, timers, decide, callers, session } = await setup();
    const methods = agentMethods(engine, () => fake.paseo, approvals, callers);
    const asker = await session();
    const { key } = (await call(methods, "approval.request", ASK, asker)) as { key: string };
    await expect(decide({ key, allow: true, action: "gh pr merge 933 --squash @ 0000000" })).rejects.toThrow(
      "asks for something else",
    );
    await decide({ key, allow: true, action: "gh pr merge 933 --squash @ ce73104" });
    const agent = fake.agents.get(asker.agentId);
    if (agent) agent.archivedAt = "2026-10-12T09:00:03.000Z";
    tickMs(UNDO_MS);
    await timers.fire();
    expect(fake.sent).toEqual([]);
    expect((await verbs.list()).recent).toMatchObject([
      { outcome: "dropped", detail: "The session is gone, so it could not be told." },
    ]);
  });

  test("a session cannot flood Needs you: past 20 waiting, it is told to withdraw some", async () => {
    const { approvals, engine, fake, callers, session } = await setup();
    const methods = agentMethods(engine, () => fake.paseo, approvals, callers);
    const flooder = await session();
    const other = await session();
    for (let n = 0; n < 20; n += 1) await call(methods, "approval.request", { action: `gh pr merge ${n}` }, flooder);
    await expect(call(methods, "approval.request", { action: "gh pr merge 99" }, flooder)).rejects.toThrow(
      "20 requests waiting",
    );
    // Asking again for one that waits is not a new request; another session has its own room.
    await call(methods, "approval.request", { action: "gh pr merge 3" }, flooder);
    await call(methods, "approval.request", { action: "gh pr merge 99" }, other);
    expect(await approvals.open()).toHaveLength(21);
  });

  test("a request file torn by a crash keeps the next request and the decision readable", async () => {
    const { approvals, root } = await setup();
    const asker = newId();
    await approvals.request(asker, { action: "gh pr merge 1" });
    await appendFile(join(root, "approvals.jsonl"), '{"kind":"approval.requ');
    // Requests list oldest first; a clock that has not moved leaves their order to the hash of a random agent id.
    tickMs(1000);
    const made = await approvals.request(asker, { action: "gh pr merge 2" });
    expect((await approvals.open()).map((entry) => entry.action)).toEqual(["gh pr merge 1", "gh pr merge 2"]);
    await approvals.decided(made.id, { allow: true, note: "", receipt: "r" });
    expect((await approvals.open()).map((entry) => entry.action)).toEqual(["gh pr merge 1"]);
  });

  test("a session may ask and withdraw, never decide; only the asker may withdraw", async () => {
    const { approvals, engine, fake, callers, session } = await setup();
    const methods = agentMethods(engine, () => fake.paseo, approvals, callers);
    for (const name of ["approval.decide", "session.prompt", "verb.undo"]) {
      expect(GATE_METHODS.has(name)).toBe(true);
      expect(methods.has(name)).toBe(false);
    }
    const asker = await session();
    const other = await session();
    const { id } = (await call(methods, "approval.request", ASK, asker)) as { id: string };
    await expect(call(methods, "approval.withdraw", { id }, other)).rejects.toThrow("Only the session that asked");
    expect(await call(methods, "approval.withdraw", { id }, asker)).toEqual({ withdrawn: true });
    expect(await approvals.open()).toEqual([]);
    await expect(call(methods, "approval.request", ASK, { agentId: null, cwd: asker.cwd })).rejects.toThrow(
      "PASEO_AGENT_ID is not set",
    );
    await expect(call(methods, "approval.request", { action: "" }, asker)).rejects.toThrow("Name the exact action");
  });
});

describe("session.prompt", () => {
  test("sends to an existing session after 8 s, can be undone, and never creates one", async () => {
    const { fake, verbs, timers, prompt } = await setup();
    fake.addSession("agent-5");
    const made = await prompt({ agentId: "agent-5", prompt: "Change course: use the cache." });
    expect(fake.sent).toEqual([]);
    await verbs.undo(made.receipt);
    tickMs(UNDO_MS);
    await timers.fire();
    expect(fake.sent).toEqual([]);
    await prompt({ agentId: "agent-5", prompt: "Change course: use the cache." });
    tickMs(UNDO_MS);
    await timers.fire();
    expect(fake.sent).toEqual([{ agentId: "agent-5", text: "Change course: use the cache." }]);
    expect(fake.created).toHaveLength(1);
    await expect(prompt({ agentId: "agent-404", prompt: "hi" })).rejects.toThrow("The session is gone");
  });
});
