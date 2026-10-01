// A Paseo client double for engine and socket tests: agents, workspaces and
// timelines in memory, with the calls the engine makes recorded.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Paseo } from "./runs";

export interface FakeAgent {
  id: string;
  cwd: string;
  status: "idle" | "running" | "error" | "closed";
  workspaceId: string;
  provider: string;
  title: string | null;
  archivedAt: string | null;
  pendingPermissions: Array<{ id: string; name: string }>;
  activeTurn: null;
  lastError?: string;
}

export function fakePaseo() {
  const agents = new Map<string, FakeAgent>();
  const sent: Array<{ agentId: string; text: string }> = [];
  const created: Array<Record<string, unknown>> = [];
  const archived: string[] = [];
  const archivedWorkspaces: string[] = [];
  const timelines = new Map<string, unknown[]>();
  const timelineEnd = new Map<string, string>();
  const appended: Array<{ agentId: string; item: Record<string, unknown> }> = [];
  const refreshed: string[] = [];
  let appendMode: "ok" | "throw" | "hang" = "ok";
  let failSend = false;
  let n = 0;
  /** Where new worktrees go: under the repository by default, or a folder of their own, as Paseo puts them. */
  let worktreeRoot: string | null = null;
  /** The daemon's record of each workspace, as workspaces.ref(id).refresh() answers it. */
  const records = new Map<string, { id: string; projectRootPath: string; workspaceDirectory: string }>();
  const makeWorkspace = (directory: string, projectRootPath: string) => {
    const id = `ws-${++n}`;
    records.set(id, { id, projectRootPath, workspaceDirectory: directory });
    return workspace(id, directory);
  };
  const workspace = (id: string, directory: string) => ({
    id,
    directory,
    agents: {
      create: async (options: Record<string, unknown>) => {
        const id = `agent-${n}`;
        created.push(options);
        agents.set(id, {
          id,
          cwd: directory,
          status: "running",
          workspaceId: `ws-${n}`,
          provider: "claude",
          title: null,
          archivedAt: null,
          pendingPermissions: [],
          activeTurn: null,
        });
        return { id, cwd: directory };
      },
    },
  });
  const paseo = {
    providers: {
      listModels: async () => ({ models: [{ id: "haiku" }, { id: "sonnet", isDefault: true }] }),
    },
    workspaces: {
      create: async (options: { source: { cwd: string; worktreeSlug: string } }) => {
        const directory = join(worktreeRoot ?? join(options.source.cwd, ".wt"), options.source.worktreeSlug);
        await mkdir(directory, { recursive: true });
        return makeWorkspace(directory, options.source.cwd);
      },
      open: async (cwd: string) => makeWorkspace(cwd, cwd),
      ref: (id: string) => ({ refresh: async () => records.get(id) ?? null }),
      archive: async (workspaceId: string) => {
        archivedWorkspaces.push(workspaceId);
        return { workspaceId, archivedAt: new Date().toISOString(), error: null };
      },
    },
    agents: {
      ref: (id: string) => ({
        refresh: async () => {
          refreshed.push(id);
          const agent = agents.get(id);
          return agent ? { agent, project: null } : null;
        },
        send: async (text: string) => {
          if (failSend) throw new Error("socket closed");
          sent.push({ agentId: id, text });
        },
        archive: async () => {
          archived.push(id);
          const agent = agents.get(id);
          if (agent) agent.archivedAt = new Date().toISOString();
          return { archivedAt: new Date().toISOString() };
        },
        timeline: {
          refetch: async () => ({
            entries: (timelines.get(id) ?? []).map((item) => ({ item, timestamp: timelineEnd.get(id) ?? "" })),
          }),
          append: (item: Record<string, unknown>) => {
            appended.push({ agentId: id, item });
            if (appendMode === "throw") return Promise.reject(new Error("agent is not loaded"));
            if (appendMode === "hang") return new Promise(() => undefined);
            return Promise.resolve({ seq: appended.length, epoch: "e1" });
          },
        },
      }),
    },
  } as unknown as Paseo;
  return {
    paseo,
    agents,
    sent,
    created,
    archived,
    archivedWorkspaces,
    timelines,
    timelineEnd,
    /** Every timeline.append call, recorded before it resolves, rejects or hangs. */
    appended,
    /** Every agents.ref(id).refresh() call, by agent id: the reconcile's round trips. */
    refreshed,
    setAppend: (mode: "ok" | "throw" | "hang") => {
      appendMode = mode;
    },
    failNextSends: () => {
      failSend = true;
    },
    placeWorktreesIn: (folder: string) => {
      worktreeRoot = folder;
    },
  };
}
