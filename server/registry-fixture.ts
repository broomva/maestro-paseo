// Paseo's registry of sessions as tests write it: the shape the daemon keeps on disk (`agents/<working directory>/
// <agent id>.json`, read from a real registry, never written to one), with a different id in every id space. An
// agent id, the Claude session behind it (`persistence.sessionId`), its workspace and a work id are four different
// strings in production; a fixture that reuses one for two of them tests the mirror, not the code.

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Callers } from "./callers";
import { PARENT_AGENT_LABEL } from "./labels";

export interface FixtureAgent {
  /** The Paseo agent id: what PASEO_AGENT_ID holds and the registry file is named for. */
  id: string;
  cwd: string;
  archivedAt?: string | null;
  lastStatus?: "idle" | "running" | "error" | "closed";
  /** The agent that started this one, as Paseo labels it. */
  parent?: string;
  /** The Claude session id behind the agent: a different string. */
  sessionId?: string;
}

/** A new id of the shape every system uses; no two are ever equal. */
export const newId = () => randomUUID();

/** One registry file's content, as Paseo writes it (the bearer token included: Maestro must never read it out). */
export function registryRecord(agent: FixtureAgent): Record<string, unknown> {
  const sessionId = agent.sessionId ?? newId();
  const at = "2026-10-09T15:01:04.239Z";
  return {
    id: agent.id,
    provider: "claude",
    cwd: agent.cwd,
    workspaceId: `wks_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
    createdAt: at,
    updatedAt: at,
    lastActivityAt: at,
    lastUserMessageAt: at,
    title: "A session",
    labels: {
      ...(agent.parent ? { [PARENT_AGENT_LABEL]: agent.parent } : {}),
      [`paseo.open-agent-tab.cid_${randomUUID().replaceAll("-", "")}`]: "true",
    },
    lastStatus: agent.lastStatus ?? "idle",
    lastModeId: "bypassPermissions",
    config: { modeId: "bypassPermissions", model: "claude-opus-5-5", thinkingOptionId: "high" },
    runtimeInfo: { provider: "claude", sessionId, model: null, modeId: "bypassPermissions" },
    persistence: {
      provider: "claude",
      sessionId,
      nativeHandle: sessionId,
      metadata: {
        provider: "claude",
        cwd: agent.cwd,
        mcpServers: {
          paseo: {
            type: "http",
            url: `http://127.0.0.1:6767/mcp/agents?callerAgentId=${agent.id.slice(0, 13)}`,
            headers: { Authorization: `Bearer ${randomUUID()}` },
          },
        },
      },
    },
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    internal: false,
    archivedAt: agent.archivedAt ?? null,
  };
}

/** The folder name Paseo files a working directory under: its path with the slashes turned to dashes. */
const folderOf = (cwd: string) => cwd.replace(/^\//, "").replaceAll("/", "-");

/** A registry in `dir`, and the Callers that read it. */
export function registryAt(dir: string) {
  return {
    dir,
    callers: new Callers({ dir }),
    /** Write (or rewrite) a session's file. */
    async add(agent: FixtureAgent): Promise<string> {
      const folder = join(dir, folderOf(agent.cwd));
      await mkdir(folder, { recursive: true });
      const path = join(folder, `${agent.id}.json`);
      await writeFile(path, JSON.stringify(registryRecord(agent), null, 2));
      return path;
    },
  };
}
