// Who is asking on the agent socket (BRO-2996). The socket is 0600, so only this user opens it, but any
// process of this user can write any `caller` on a line. What the socket does with a caller it does only after
// this: the session the caller names exists in Paseo's own registry, is live, and the shell asking is inside
// the folder that session runs in.
//
// What this proves, and what it does not. It stops a session that names another's id by mistake or by habit
// (a PASEO_AGENT_ID inherited by a process started elsewhere, a loop that fills Needs you under invented ids),
// and it ties every request to one real, live session, so a cap or a withdrawal is that session's. It does not
// stop a process of yours that reads the registry (`~/.paseo/agents/*/<id>.json`, which any process of this user
// can) and sends a live session's id and folder: that is the same trust as editing the work folders directly
// (agent-socket.ts). Peer credentials would close it (LOCAL_PEERPID on a unix socket), but reading them needs a
// native getsockopt call: Node has none, and the plugin runs under the Paseo host's Node, where bun:ffi does not
// exist. A per-session secret would need Paseo to put one in each session's environment, which a plugin cannot do.

import { readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import { UserError } from "./engine";
import { PARENT_AGENT_LABEL } from "./labels";

/** What a request line says about who sent it. Unverified: it is whatever the client wrote. */
export interface CallerClaim {
  /** The session's agent id (`PASEO_AGENT_ID`). */
  agentId: string | null;
  /** The folder the client's shell is in. */
  cwd: string | null;
}

/** A session Maestro has checked against Paseo's registry. Only `Callers.verify` makes one. */
export interface VerifiedCaller {
  readonly agentId: string;
  /** Where the session runs, as the registry has it. */
  readonly cwd: string;
}

/** What Maestro reads of a session's registry file; the rest of it (its tokens above all) is never read out. */
export interface RegistryAgent {
  id: string;
  cwd: string;
  archivedAt: string | null;
  status: string | null;
  /** The session that started it, by Paseo's own record (`paseo.parent-agent-id`). */
  parent: string | null;
}

const RegistryFile = z.object({
  id: z.string(),
  cwd: z.string(),
  archivedAt: z.string().nullable().optional(),
  lastStatus: z.string().nullable().optional(),
  labels: z.record(z.string(), z.string()).optional(),
});

/** An agent id is a file name: nothing that could reach outside the registry's folders. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface CallersOptions {
  /** Paseo's `agents/` folder: one folder per working directory, one `<agent id>.json` in it per session. */
  dir: string;
}

/** Paseo's registry of sessions, read straight from its files. */
export class Callers {
  private readonly dir: string;
  /** Where each id was last found, so a later look reads one file, not every folder. */
  private readonly found = new Map<string, string>();

  constructor(options: CallersOptions) {
    this.dir = options.dir;
  }

  /** The session with this id, or null when the registry has none (or the id is not a plausible one). */
  async find(id: string): Promise<RegistryAgent | null> {
    if (!SAFE_ID.test(id)) return null;
    const known = this.found.get(id);
    const hit = known ? await this.read(known, id) : null;
    if (hit) return hit;
    this.found.delete(id);
    const folders = await readdir(this.dir).catch(() => [] as string[]);
    for (const folder of folders) {
      const path = join(this.dir, folder, `${id}.json`);
      const agent = await this.read(path, id);
      if (agent) {
        this.found.set(id, path);
        return agent;
      }
    }
    return null;
  }

  private async read(path: string, id: string): Promise<RegistryAgent | null> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return null;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return null;
    }
    const parsed = RegistryFile.safeParse(json);
    // The file is named for its session: one that says another id is not that session's record.
    if (!parsed.success || parsed.data.id !== id) return null;
    const { cwd, archivedAt, lastStatus, labels } = parsed.data;
    return {
      id,
      cwd,
      archivedAt: archivedAt ?? null,
      status: lastStatus ?? null,
      parent: labels?.[PARENT_AGENT_LABEL] ?? null,
    };
  }

  /**
   * The session the claim names, or why Maestro cannot take it as the caller. It exists, it is live (not
   * archived, not closed), and the shell asking is in the folder it runs in or under it.
   */
  async verify(claim: CallerClaim): Promise<VerifiedCaller> {
    const { agentId, cwd } = claim;
    if (!agentId) {
      throw new UserError(
        "Maestro cannot tell which session is asking: PASEO_AGENT_ID is not set in this shell. Run maestro from a Paseo session.",
      );
    }
    if (!cwd) {
      throw new UserError(
        "Maestro cannot tell where this shell is: the request carried no folder. Update the maestro command (bin/maestro.ts) to this plugin's version.",
      );
    }
    const agent = await this.find(agentId);
    if (!agent) throw new UserError(`No Paseo session has the id ${agentId}.`);
    if (agent.archivedAt || agent.status === "closed") {
      throw new UserError(`Session ${agentId.slice(0, 8)} is ${agent.archivedAt ? "archived" : "closed"}, not live.`);
    }
    if (!(await within(cwd, agent.cwd))) {
      throw new UserError(
        `This shell is in ${cwd}, but session ${agentId.slice(0, 8)} runs in ${agent.cwd}. Run maestro from inside that folder.`,
      );
    }
    return { agentId, cwd: agent.cwd };
  }

  /** Whether `child` is a live session `parent` started, by Paseo's own record: the one other session a verified caller may act for. */
  async started(parent: string, child: string): Promise<boolean> {
    const agent = await this.find(child);
    return !!agent && agent.parent === parent && !agent.archivedAt && agent.status !== "closed";
  }
}

/** Real paths, so a symlinked checkout and its target are one folder; one that does not exist is compared as written. */
async function real(path: string): Promise<string> {
  const absolute = resolve(path);
  return realpath(absolute).catch(() => absolute);
}

/** Whether `inner` is `outer` or under it, by whole path segments: `/work/ab` is not under `/work/a`. */
async function within(inner: string, outer: string): Promise<boolean> {
  const [inside, outside] = await Promise.all([real(inner), real(outer)]);
  return inside === outside || inside.startsWith(outside.endsWith(sep) ? outside : `${outside}${sep}`);
}
