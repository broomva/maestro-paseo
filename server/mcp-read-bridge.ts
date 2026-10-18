import { dirname, join } from "node:path";
import { z } from "zod";
import type { AnswersStatus } from "../shared/answers";
import type { WorkItem } from "../shared/contracts";
import type { DecisionAsk, FleetView } from "../shared/fleet";
import type { InitiativesView } from "../shared/initiatives";
import type { LoopsView } from "../shared/loops";
import { askKey, type Snapshot, SnapshotSchema } from "../shared/mcp";
import { askHoldKey, type Needs } from "../shared/needs";
import type { Notices } from "../shared/notices";
import { keepServing } from "./agent-socket";
import { configPath } from "./paths";

export interface McpReads {
  needs(): Promise<Needs>;
  work(): Promise<{ items: WorkItem[]; warnings?: string[] }>;
  asks(): Promise<{ asks: DecisionAsk[]; complete: boolean }>;
  answers(): Promise<AnswersStatus>;
  notices(): Promise<Notices>;
  fleet(): Promise<FleetView>;
  loops(): Promise<LoopsView>;
  initiatives(): Promise<InitiativesView>;
}

export function mcpSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MAESTRO_MCP_SOCKET ?? join(dirname(configPath(env)), "maestro-mcp.sock");
}

/** One projection for bridge reads and the companion's authoritative workspace reread. */
export function projectAsk(a: DecisionAsk): NonNullable<Snapshot["asks"]>[number] {
  return {
    key: askKey(a),
    hash: a.hash,
    id: a.id,
    ledger: a.ledger,
    title: a.headline ?? a.question ?? a.id,
    question: a.question,
    stakes: a.stakes,
    whyYou: a.whyYou,
    fallback: a.fallback,
    blocking: a.blocking,
    waiting: a.waiting,
    askedAt: a.askedAt,
    state: a.state,
    refusal: a.refusal,
    options: a.options.map((o) => ({
      id: o.id,
      label: o.label,
      consequence: o.consequence,
      recommended: o.recommended,
      reversible: o.reversible,
    })),
    summary: a.rich?.summary ?? null,
    details: a.rich?.details ?? null,
    sources: a.rich?.sources.map((s) => ({ label: s.label ?? s.kind, ref: s.ref })) ?? [],
  };
}

/** Every source fails independently; missing data is never presented as an empty healthy source. */
export async function readMcpSnapshot(reads: McpReads): Promise<Snapshot> {
  const errors: Record<string, string> = {};
  async function take<T>(key: string, read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch (error) {
      errors[key] = error instanceof Error ? error.message : "This source could not be read.";
      return null;
    }
  }
  const [needs, work, asks, answers, notices, fleet, loops, initiatives] = await Promise.all([
    take("needs", reads.needs),
    take("work", reads.work),
    take("asks", reads.asks),
    take("answers", reads.answers),
    take("notices", reads.notices),
    take("fleet", reads.fleet),
    take("loops", reads.loops),
    take("initiatives", reads.initiatives),
  ]);
  if (work?.warnings?.length) errors.work = work.warnings.join(" ");
  if (needs?.unread?.length) errors.needs = `Some holds could not be read: ${needs.unread.join(", ")}.`;
  if (asks && !asks.complete) errors.asks = "Some decision sources could not be read.";
  if (notices?.summary?.unread?.length)
    errors.notices = `Some notice sources could not be read: ${notices.summary.unread.join(", ")}.`;
  if (fleet?.error) errors.fleet = fleet.error;
  if (loops?.warnings.length || loops?.ledgerErrors.length)
    errors.loops = [...loops.warnings, ...loops.ledgerErrors.map((e) => e.error)].join(" ");
  if (initiatives?.warnings.length) errors.initiatives = initiatives.warnings.join(" ");
  return SnapshotSchema.parse({
    version: 1,
    capturedAt: new Date().toISOString(),
    source: "live",
    readOnly: true,
    errors,
    needs: needs
      ? {
          total: needs.summary.total,
          rows: needs.rows.map((r) => {
            const matches =
              asks?.asks.filter((a) => askHoldKey(a) === r.key && (!a.scope || a.scope === r.scope)) ?? [];
            const target = r.key.startsWith("review:")
              ? { kind: "initiative", id: r.key.slice(7) }
              : r.key.startsWith("work:")
                ? { kind: "work", id: r.key.slice(5) }
                : matches.length === 1
                  ? { kind: "ask", id: askKey(matches[0]) }
                  : null;
            return { key: r.key, title: r.title, kind: r.kind, scope: r.scope, since: r.since, target };
          }),
        }
      : null,
    work:
      work?.items.map((w) => ({
        id: w.id,
        title: w.display?.title ?? w.title,
        state: w.state,
        group: w.group,
        scope: w.project ?? w.initiative ?? "workspace",
        ticket: w.ticket ?? null,
        provider: w.worker?.provider ?? null,
        reason: w.reason,
        updatedAt: w.updatedAt,
        checks: w.checks,
      })) ?? null,
    asks: asks?.asks.map(projectAsk) ?? null,
    answers: answers
      ? { waitingToLand: answers.waitingToLand, routed: answers.routed, acted: answers.acted, held: answers.held }
      : null,
    notices:
      notices?.rows.map((n) => ({ key: n.key, title: n.title, scope: n.scope, detail: n.detail, kind: n.kind })) ??
      null,
    fleet:
      fleet?.scopes.map((s) => ({
        id: s.id,
        health: s.health.status,
        reason: s.health.reason,
        mode: s.mode,
        dryRun: s.dryRun,
        lastTick: s.lastTick?.at ?? null,
        openAsks: s.openAsks,
      })) ?? null,
    loops:
      loops?.rows.map((l) => ({
        id: l.subject,
        title: l.name,
        scope: l.scope,
        cadence: l.observed?.cadence ?? l.intent?.cadence ?? null,
        status: l.unread ? "unread" : (l.observed?.status ?? "unknown"),
        detail: l.observed?.reason ?? l.purpose ?? "No observation is available.",
        drift: l.drift.map((d) => d.detail),
      })) ?? null,
    initiatives:
      initiatives?.initiatives.map((i) => ({
        id: i.id,
        title: i.title ?? i.id,
        summary: i.summary,
        status: i.status,
        reviewBy: i.reviewBy,
        due: i.stale !== null,
        nextAction: i.nextAction,
      })) ?? null,
  });
}

export function startMcpReadBridge(
  reads: McpReads,
  log: (message: string) => void,
  env = process.env,
): () => Promise<void> {
  if (env.MAESTRO_MCP_READ_BRIDGE !== "1") return async () => {};
  return keepServing({
    path: mcpSocketPath(env),
    log,
    methods: mcpReadMethods(reads),
  });
}

export function mcpReadMethods(reads: McpReads) {
  return new Map([
    [
      "snapshot",
      async (input: unknown) => {
        z.object({})
          .strict()
          .parse(input ?? {});
        return readMcpSnapshot(reads);
      },
    ],
  ]);
}
