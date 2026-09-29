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
  let appendMode: "ok" | "throw" | "hang" = "ok";
  let failSend = false;
  let n = 0;
  const makeWorkspace = (directory: string) => ({
    id: `ws-${++n}`,
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
        const directory = join(options.source.cwd, ".wt", options.source.worktreeSlug);
        await mkdir(directory, { recursive: true });
        return makeWorkspace(directory);
      },
      open: async (cwd: string) => makeWorkspace(cwd),
      archive: async (workspaceId: string) => {
        archivedWorkspaces.push(workspaceId);
        return { workspaceId, archivedAt: new Date().toISOString(), error: null };
      },
    },
    agents: {
      ref: (id: string) => ({
        refresh: async () => {
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
    setAppend: (mode: "ok" | "throw" | "hang") => {
      appendMode = mode;
    },
    failNextSends: () => {
      failSend = true;
    },
  };
}
