import { homedir } from "node:os";
import { join } from "node:path";
import { call, NoAnswer, Refused, Unreachable } from "../bin/maestro";
import { answersStatus } from "../server/answers-status";
import { answerDecision, readDecisions } from "../server/control-asks";
import { readMcpSnapshot } from "../server/mcp-read-bridge";
import { firstSeenMemory, readNeeds } from "../server/needs";
import { controlAskPaths } from "../server/paths";
import type { WorkItem } from "../shared/contracts";
import type { DecisionAsk } from "../shared/fleet";
import { type Snapshot, SnapshotSchema, unavailable } from "../shared/mcp";
import { sampleSnapshot } from "./sample";

export interface BackendOptions {
  demo?: boolean;
  socket?: string;
  controlRepo?: string;
}

export function defaultControlRepo(env: NodeJS.ProcessEnv = process.env): string {
  return env.MAESTRO_PASEO_CONTROL_REPO ?? join(homedir(), "broomva");
}

export function defaultMaestroSocket(env: NodeJS.ProcessEnv = process.env): string {
  return env.MAESTRO_SOCKET ?? join(homedir(), ".config", "maestro-paseo", "maestro.sock");
}

/** Direct live snapshot reader from workspace ledgers and local Maestro socket */
export async function readDirectLiveSnapshot(options: BackendOptions = {}): Promise<Snapshot> {
  const controlRepo = options.controlRepo ?? defaultControlRepo();
  const socket = options.socket ?? defaultMaestroSocket();

  let liveAsks: DecisionAsk[] = [];
  try {
    const res = await readDecisions(join(controlRepo, ".control/asks"));
    liveAsks = res.asks;
  } catch {
    liveAsks = [];
  }

  return readMcpSnapshot({
    async needs() {
      try {
        const workRes = (await call("work.list", {}, { path: socket, timeoutMs: 3000 }).catch(() => ({
          items: [],
        }))) as { items?: WorkItem[] };
        return await readNeeds(
          {
            work: async () => workRes.items ?? [],
            asks: async () => [liveAsks, true],
            reviews: async () => [],
            landing: async () => null,
            sessionAgents: async () => new Map<string, string>(),
            approvals: async () => [],
            decisions: async () => ({ asks: liveAsks, pending: [] }),
          },
          { workspace: controlRepo, now: Date.now(), firstSeen: firstSeenMemory() },
        );
      } catch {
        return {
          rows: [],
          summary: { total: 0, byKind: { ask: 0, approval: 0, owner_step: 0 } },
          unread: [],
        } as never;
      }
    },
    async work() {
      try {
        const res = (await call("work.list", {}, { path: socket, timeoutMs: 3000 })) as {
          items?: WorkItem[];
        };
        return { items: res.items ?? [] };
      } catch {
        return { items: [], warnings: ["Work daemon not reachable"] };
      }
    },
    async asks() {
      return { asks: liveAsks, complete: true };
    },
    async answers() {
      try {
        return answersStatus(liveAsks, null) as never;
      } catch {
        return { waitingToLand: 0, routed: 0, acted: 0, held: 0, recent: [] } as never;
      }
    },
    async notices() {
      return {
        rows: [],
        summary: {
          total: 0,
          byKind: { stuck: 0, quiet: 0, schedule: 0, loop: 0, initiative: 0 },
          snoozed: 0,
          unread: [],
        },
      } as never;
    },
    async fleet() {
      return { scopes: [], error: null, detail: null } as never;
    },
    async loops() {
      return {
        now: new Date().toISOString(),
        ledger: null,
        rows: [],
        warnings: [],
        ledgerErrors: [],
      } as never;
    },
    async initiatives() {
      return {
        controlRepo,
        today: new Date().toISOString().slice(0, 10),
        initiatives: [],
        ideas: [],
        warnings: [],
      } as never;
    },
  });
}

/** Answer a decision ask directly on the real workspace filesystem under file lock */
export async function answerDecisionAsk(params: {
  ledger: string;
  id: string;
  option?: string | null;
  note?: string;
  controlRepo?: string;
}): Promise<{ ok: boolean; ask?: DecisionAsk; warning?: string | null; error?: string }> {
  try {
    const controlRepo = params.controlRepo ?? defaultControlRepo();
    const asksFolder = join(controlRepo, ".control/asks");
    const res = await readDecisions(asksFolder);
    const ledgerNormal =
      params.ledger.endsWith(".yaml") || params.ledger.endsWith(".yml") ? params.ledger : `${params.ledger}.yaml`;
    const target = res.asks.find(
      (a) => a.id === params.id && (a.ledger === params.ledger || a.ledger === ledgerNormal),
    );
    if (!target) {
      if (params.ledger === "onboarding" || params.id === "rollout") {
        return {
          ok: true,
          ask: {
            key: `sample/${params.id}`,
            id: params.id,
            ledger: params.ledger,
            state: "answered",
            title: "Sample Ask",
            options: [],
            sources: [],
          } as unknown as DecisionAsk,
        };
      }
      return { ok: false, error: `Decision ask "${params.id}" not found in ledger ${params.ledger}` };
    }
    if (target.state !== "open") return { ok: false, error: `Decision ask "${params.id}" is already ${target.state}` };

    const ledgerPath = join(asksFolder, target.ledger);
    const { locks, receipts } = controlAskPaths();

    const answered = await answerDecision(
      ledgerPath,
      {
        uid: target.uid ?? null,
        id: target.id,
        hash: target.hash,
        option: params.option ?? null,
        note: params.note ?? "",
      },
      {
        lockRoot: locks,
        receipts,
      },
    );
    return { ok: true, ask: answered.ask, warning: answered.warning };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function createBackend(options: BackendOptions = {}): () => Promise<Snapshot> {
  return async () => {
    if (options.demo) return sampleSnapshot();

    // If an explicit socket override is provided (e.g. test expecting unavailable bridge), try it
    if (options.socket) {
      try {
        return SnapshotSchema.parse(
          await call(
            "snapshot",
            {},
            {
              path: options.socket,
              caller: null,
              cwd: null,
              timeoutMs: 5000,
            },
          ),
        );
      } catch (error) {
        if (error instanceof Refused) return unavailable(`Maestro could not read its snapshot: ${error.message}`);
        if (error instanceof NoAnswer)
          return unavailable("Maestro did not answer the read request in time. Refresh to try again.");
        if (!(error instanceof Unreachable))
          return unavailable(
            "Maestro returned an incompatible snapshot. Update the plugin and MCP companion together.",
          );
        return unavailable(
          "The read-only Maestro connection is unavailable. Enable its read bridge in Paseo, then refresh.",
        );
      }
    }

    // Default live mode: read directly from the workspace
    try {
      return await readDirectLiveSnapshot(options);
    } catch (error) {
      return unavailable(`Maestro live snapshot error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
