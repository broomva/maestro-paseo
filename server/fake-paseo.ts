// A Paseo client double for engine and socket tests: agents, workspaces and
// timelines in memory, with the calls the engine makes recorded.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Paseo } from "./runs";

export interface FakeAgent {
  id: string;
  cwd: string;
  status: "idle" | "running" | "error" | "closed";
  /**
   * When the session last did anything, as the daemon's refresh() reports it
   * (`updatedAt`; Paseo's app calls it lastActivityAt). Stamped when the agent
   * is created; setLastActivityAt moves it.
   */
  updatedAt?: string;
  workspaceId: string;
  provider: string;
  title: string | null;
  archivedAt: string | null;
  pendingPermissions: Array<{ id: string; name: string }>;
  /** The session's labels, as the daemon's refresh() reports them; none when unset. */
  labels?: Record<string, string>;
  activeTurn: null;
  lastError?: string;
  /** The session's mode now, as refresh() reports it. */
  currentModeId?: string | null;
  availableModes?: Array<{ id: string; label?: string; isUnattended?: boolean }>;
}

export interface FakePaseoOptions {
  /** The clock agents are stamped with; tests that move a clock of their own pass it. */
  now?: () => Date;
}

export function fakePaseo(options: FakePaseoOptions = {}) {
  const now = options.now ?? (() => new Date());
  const agents = new Map<string, FakeAgent>();
  const sent: Array<{ agentId: string; text: string }> = [];
  const created: Array<Record<string, unknown>> = [];
  const archived: string[] = [];
  const archivedWorkspaces: string[] = [];
  const timelines = new Map<string, unknown[]>();
  const timelineEnd = new Map<string, string>();
  /** The provider turn id the timeline's entries carry, as Paseo stamps them; none when unset. */
  const timelineTurn = new Map<string, string>();
  const appended: Array<{ agentId: string; item: Record<string, unknown> }> = [];
  const refreshed: string[] = [];
  /** Every timeline.refetch call, by agent id: reading a session's timeline is what a recovered end costs. */
  const refetched: string[] = [];
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
          updatedAt: now().toISOString(),
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
          refetch: async () => {
            refetched.push(id);
            return {
              entries: (timelines.get(id) ?? []).map((item) => ({
                item,
                timestamp: timelineEnd.get(id) ?? "",
                turnId: timelineTurn.get(id),
              })),
            };
          },
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
    refetched,
    agents,
    sent,
    created,
    archived,
    archivedWorkspaces,
    timelines,
    timelineEnd,
    timelineTurn,
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
    /**
     * A live session that is not a run of Maestro's: a lane, the conductor, or
     * any session that asks Maestro for a run. Its mode is its lane profile's.
     */
    addSession: (id: string, session: { provider?: string; modeId?: string | null; title?: string } = {}) => {
      agents.set(id, {
        id,
        cwd: "/tmp",
        status: "idle",
        updatedAt: now().toISOString(),
        workspaceId: `ws-${id}`,
        provider: session.provider ?? "claude",
        title: session.title ?? null,
        archivedAt: null,
        pendingPermissions: [],
        activeTurn: null,
        currentModeId: session.modeId ?? null,
      });
    },
    /** The session did something at `at` (a tool call, a line of output): what refresh() reports from now. */
    setLastActivityAt: (agentId: string, at: Date | string) => {
      const agent = agents.get(agentId);
      if (!agent) throw new Error(`no fake agent ${agentId}`);
      agent.updatedAt = typeof at === "string" ? at : at.toISOString();
    },
  };
}
