import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserError } from "./engine";
import { newId, registryAt, registryRecord } from "./registry-fixture";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "maestro-callers-")));
  roots.push(root);
  const registry = registryAt(join(root, "agents"));
  const folder = async (name: string) => {
    const path = join(root, name);
    await mkdir(path, { recursive: true });
    return path;
  };
  return { root, folder, ...registry };
}

const refusal = async (verify: Promise<unknown>) => {
  const error = await verify.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(UserError);
  return (error as UserError).message;
};

describe("a caller is the live session whose folder the shell is in", () => {
  test("a live session, asked from its own folder or under it, is the caller", async () => {
    const { add, callers, folder } = await setup();
    const cwd = await folder("worktrees/arc-a");
    const id = newId();
    await add({ id, cwd });
    expect(await callers.verify({ agentId: id, cwd })).toEqual({ agentId: id, cwd });
    const deeper = await folder("worktrees/arc-a/server/deep");
    expect(await callers.verify({ agentId: id, cwd: deeper })).toEqual({ agentId: id, cwd });
  });

  test("an id nobody has, or one that is not an agent id, is refused", async () => {
    const { add, callers, folder } = await setup();
    const cwd = await folder("arc-a");
    const id = newId();
    const sessionId = newId();
    await add({ id, cwd, sessionId });
    expect(await refusal(callers.verify({ agentId: newId(), cwd }))).toContain("No Paseo session has the id");
    // The Claude session id behind the agent names no agent: the two id spaces are different strings.
    expect(sessionId).not.toBe(id);
    expect(await refusal(callers.verify({ agentId: sessionId, cwd }))).toContain("No Paseo session has the id");
    // Nor can an id reach outside the registry's folders.
    for (const hostile of ["../agents/x", "a/b", "..", ".", "x\0y", `${id}/../${id}`]) {
      expect(await refusal(callers.verify({ agentId: hostile, cwd }))).toContain("No Paseo session has the id");
    }
  });

  test("an id that walks out of the registry reads no file there, even one that names itself", async () => {
    const { add, callers, folder, root } = await setup();
    const cwd = await folder("arc-a");
    await add({ id: newId(), cwd });
    // A registry-shaped file outside the registry whose own id is the hostile string: only the id's shape stops it.
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    const hostile = "../../outside/stolen";
    await writeFile(join(outside, "stolen.json"), JSON.stringify(registryRecord({ id: hostile, cwd })));
    expect(await callers.find(hostile)).toBeNull();
    expect(await refusal(callers.verify({ agentId: hostile, cwd }))).toContain("No Paseo session has the id");
  });

  test("no id, or no folder, is refused and says what is missing", async () => {
    const { add, callers, folder } = await setup();
    const cwd = await folder("arc-a");
    const id = newId();
    await add({ id, cwd });
    expect(await refusal(callers.verify({ agentId: null, cwd }))).toContain("PASEO_AGENT_ID is not set");
    expect(await refusal(callers.verify({ agentId: id, cwd: null }))).toContain("carried no folder");
    // A relative folder is no folder: it is refused, though it would resolve to the session's own from its own cwd.
    expect(await refusal(callers.verify({ agentId: id, cwd: "arc-a" }))).toContain("must be an absolute path");
    expect(await refusal(callers.verify({ agentId: id, cwd: "." }))).toContain("must be an absolute path");
  });

  test("an archived or closed session is not live; one that is idle, running or in error still is", async () => {
    const { add, callers, folder } = await setup();
    const cwd = await folder("arc-a");
    const archived = newId();
    const closed = newId();
    await add({ id: archived, cwd, archivedAt: "2026-10-09T17:30:23.134Z" });
    await add({ id: closed, cwd, lastStatus: "closed" });
    expect(await refusal(callers.verify({ agentId: archived, cwd }))).toContain("archived");
    expect(await refusal(callers.verify({ agentId: closed, cwd }))).toContain("closed");
    for (const lastStatus of ["idle", "running", "error"] as const) {
      const id = newId();
      await add({ id, cwd, lastStatus });
      expect((await callers.verify({ agentId: id, cwd })).agentId).toBe(id);
    }
  });

  test("a shell in another folder is refused, even a sibling that shares the folder's name as a prefix", async () => {
    const { add, callers, folder } = await setup();
    const cwd = await folder("work/a");
    const id = newId();
    await add({ id, cwd });
    const other = await folder("work/other");
    const prefixed = await folder("work/ab");
    expect(await refusal(callers.verify({ agentId: id, cwd: other }))).toContain("Run maestro from inside that folder");
    expect(await refusal(callers.verify({ agentId: id, cwd: prefixed }))).toContain("runs in");
    expect(await refusal(callers.verify({ agentId: id, cwd: "/" }))).toContain("runs in");
    // Its own folder spelled with a trailing slash or a dot segment is the same folder.
    expect((await callers.verify({ agentId: id, cwd: `${cwd}/` })).agentId).toBe(id);
    expect((await callers.verify({ agentId: id, cwd: `${cwd}/./` })).agentId).toBe(id);
  });

  test("a symlinked path to the session's folder is that folder", async () => {
    const { add, callers, folder, root } = await setup();
    const cwd = await folder("real/arc-a");
    const id = newId();
    await add({ id, cwd });
    const link = join(root, "link");
    await symlink(join(root, "real"), link);
    expect((await callers.verify({ agentId: id, cwd: join(link, "arc-a") })).agentId).toBe(id);
    // The other direction: the link is what the registry holds.
    const other = newId();
    await add({ id: other, cwd: join(link, "arc-a") });
    expect((await callers.verify({ agentId: other, cwd })).agentId).toBe(other);
  });

  test("a file that says another id than its name is not that session's record", async () => {
    const { add, callers, folder } = await setup();
    const cwd = await folder("arc-a");
    const real = newId();
    const victim = newId();
    const path = await add({ id: real, cwd });
    // A file named for the victim whose content is the real session's.
    await writeFile(path.replace(real, victim), JSON.stringify(registryRecord({ id: real, cwd })));
    expect(await refusal(callers.verify({ agentId: victim, cwd }))).toContain("No Paseo session has the id");
  });

  test("a registry that cannot be read refuses every caller", async () => {
    const { root, callers } = await setup();
    // Nothing is written: the registry folder does not exist, so no one can be told from anyone.
    expect(await refusal(callers.verify({ agentId: newId(), cwd: root }))).toContain("No Paseo session has the id");
  });

  test("what is read of a session never includes its tokens", async () => {
    const { add, callers, folder } = await setup();
    const cwd = await folder("arc-a");
    const id = newId();
    await add({ id, cwd });
    const found = await callers.find(id);
    expect(found).toEqual({ id, cwd, archivedAt: null, status: "idle", parent: null });
    expect(JSON.stringify(found)).not.toContain("Bearer");
    expect(JSON.stringify(await callers.verify({ agentId: id, cwd }))).not.toContain("Bearer");
  });

  test("a session is found again after it moves folders in the registry, and not after its file goes", async () => {
    const { add, callers, folder } = await setup();
    const cwd = await folder("arc-a");
    const id = newId();
    const path = await add({ id, cwd });
    expect((await callers.verify({ agentId: id, cwd })).agentId).toBe(id);
    await rm(path);
    expect(await refusal(callers.verify({ agentId: id, cwd }))).toContain("No Paseo session has the id");
    const moved = await folder("arc-b");
    await add({ id, cwd: moved });
    expect((await callers.verify({ agentId: id, cwd: moved })).agentId).toBe(id);
  });
});

describe("a session may act for one it started, by Paseo's own record", () => {
  test("a live child that names the caller as its parent is started by it; no one else's is", async () => {
    const { add, callers, folder } = await setup();
    const orchestrator = newId();
    const stranger = newId();
    const child = newId();
    const grandchild = newId();
    await add({ id: orchestrator, cwd: await folder("orch") });
    await add({ id: stranger, cwd: await folder("stranger") });
    await add({ id: child, cwd: await folder("child"), parent: orchestrator });
    await add({ id: grandchild, cwd: await folder("grandchild"), parent: child });
    expect(await callers.started(orchestrator, child)).toBe(true);
    expect(await callers.started(stranger, child)).toBe(false);
    // Only the session that started it, not the one that started that.
    expect(await callers.started(orchestrator, grandchild)).toBe(false);
    expect(await callers.started(orchestrator, orchestrator)).toBe(false);
    expect(await callers.started(orchestrator, newId())).toBe(false);
  });

  test("a child that is archived or closed is no longer one the caller may act for", async () => {
    const { add, callers, folder } = await setup();
    const orchestrator = newId();
    await add({ id: orchestrator, cwd: await folder("orch") });
    const gone = newId();
    const closed = newId();
    await add({ id: gone, cwd: await folder("gone"), parent: orchestrator, archivedAt: "2026-10-09T17:30:23.134Z" });
    await add({ id: closed, cwd: await folder("closed"), parent: orchestrator, lastStatus: "closed" });
    expect(await callers.started(orchestrator, gone)).toBe(false);
    expect(await callers.started(orchestrator, closed)).toBe(false);
  });
});

describe("what the check does not prove", () => {
  test("a process that read the registry and names a live session and its folder is taken for it", async () => {
    // Stated, not hidden (server/callers.ts): this is the same trust as editing the work folders directly. Peer
    // credentials would close it; the plugin's Node has no native getsockopt, and bun:ffi is not there.
    const { add, callers, folder } = await setup();
    const cwd = await folder("arc-a");
    const id = newId();
    await add({ id, cwd });
    expect((await callers.verify({ agentId: id, cwd })).agentId).toBe(id);
  });
});
