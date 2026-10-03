// A fleet-reconcile install on disk for tests, in the fleet's own formats
// (fleetlib/ledger.py, report.py, tick.sh, install.sh): its config, a state
// dir per scope with a ledger and ticks, and a LaunchAgent. Every path is the
// test's own.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { plistName } from "./fleet";

export interface FakeTick {
  tick: number;
  /** When it fired. */
  at: Date;
  /** Its exit code; undefined: it never finished (no runner_exit). */
  exit?: number;
  detail?: string;
  /** Its report.json; null: it wrote none. */
  report?: Record<string, unknown> | null;
  markdown?: string;
}

export const H = 3_600_000;

/** One in-scope session of a report, as report.json lists it. */
export function session(
  id: string,
  classId: string,
  action: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    session_id: id,
    short: id.slice(0, 8),
    name: `session-${id.slice(0, 4)}`,
    kind: "background",
    status: "failed",
    class: classId,
    class_name: { "1": "out of scope", "4": "error", "5": "running", "10": "unmanaged" }[classId] ?? classId,
    evidence: `evidence for ${id.slice(0, 8)}`,
    action,
    scope: "alpha",
    cwd: "~/alpha",
    ...extra,
  };
}

export function report(
  tick: number,
  at: Date,
  extra: Record<string, unknown> = {},
  scope = "alpha",
): Record<string, unknown> {
  return {
    v: 1,
    tick,
    ts: at.toISOString(),
    scope,
    mode: "report",
    dry_run: true,
    phase: 1,
    class_counts: { "1": 3, "4": 1, "10": 1 },
    sessions: [
      session("11111111-aaaa", "1", "nothing", { scope: scope === "beta" ? "alpha" : "beta" }),
      session("22222222-bbbb", "4", "report", { scope }),
      session("33333333-cccc", "10", "report only", { scope }),
      session("44444444-dddd", "5", "nothing", { scope }),
    ],
    asks_open: [
      { id: "a1", key: "records-without-process", class: "count", first_tick: tick - 1, question: "3 records" },
    ],
    ...extra,
  };
}

/** Writes the fleet: `scopes` keyed by id, each with its ticks, extra ledger lines and whether launchd runs it. */
export async function writeFleet(
  paths: { config: string; state: string; agents: string },
  scopes: Record<
    string,
    {
      ticks: FakeTick[];
      ledger?: Record<string, unknown>[];
      scheduled?: boolean;
      /** The LaunchAgent's StartInterval, seconds. */
      interval?: number;
      config?: Record<string, unknown>;
    }
  >,
): Promise<void> {
  await mkdir(join(paths.config, ".."), { recursive: true });
  await mkdir(paths.agents, { recursive: true });
  const sections: Record<string, unknown> = {};
  for (const [id, scope] of Object.entries(scopes)) {
    const stateDir = join(paths.state, id);
    sections[id] = { dispatch_enabled: 1, dry_run: 1, mode: "report", state_dir: stateDir, ...scope.config };
    await mkdir(join(stateDir, "ticks"), { recursive: true });
    const lines: Record<string, unknown>[] = [];
    for (const tick of scope.ticks) {
      lines.push({
        by: "tick",
        dry_run: true,
        id: `${tick.tick}-1`,
        kind: "tick_fire",
        scope: id,
        tick: tick.tick,
        ts: tick.at.toISOString(),
        v: 1,
      });
      if (tick.exit !== undefined) {
        lines.push({
          by: "tick",
          detail: tick.detail ?? "recover=0 observe=0 report=0 compare=0 ask=0",
          dry_run: true,
          exit: tick.exit,
          id: `${tick.tick}-2`,
          kind: "runner_exit",
          scope: id,
          tick: tick.tick,
          ts: new Date(tick.at.getTime() + 10_000).toISOString(),
          v: 1,
        });
      }
      const dir = join(stateDir, "ticks", String(tick.tick).padStart(5, "0"));
      if (tick.report !== null) {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "report.json"), JSON.stringify(tick.report ?? report(tick.tick, tick.at, {}, id)));
        await writeFile(join(dir, "report.md"), tick.markdown ?? `# fleet-reconcile · ${id} · tick ${tick.tick}\n`);
      }
    }
    lines.push(...(scope.ledger ?? []));
    await writeFile(join(stateDir, "ledger.jsonl"), lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
    if (scope.scheduled !== false) {
      await writeFile(
        join(paths.agents, plistName(id)),
        `<plist><dict><!-- StartInterval 3600 is the owner's cadence --><key>StartInterval</key>\n    <integer>${scope.interval ?? 3600}</integer></dict></plist>\n`,
      );
    }
  }
  await writeFile(paths.config, JSON.stringify({ v: 1, scopes: sections }));
}

/** The ledger lines of an ask batch raised at `tick` and seen in Maestro as `item`. */
export function askBatch(scope: string, tick: number, asks: { id: string; key: string }[], item?: string) {
  const batch = `${tick}-3`;
  const lines: Record<string, unknown>[] = [
    {
      by: "tick",
      dry_run: true,
      id: batch,
      key: `scope:${scope}`,
      kind: "intent",
      scope,
      target: { asks: asks.map((ask) => ({ ...ask, class: "count", question: ask.key })), batch: `/x/asks/${tick}.md` },
      tick,
      ts: new Date().toISOString(),
      v: 1,
      verb: "ask",
    },
  ];
  if (item) {
    lines.push({
      by: "tick",
      dry_run: true,
      id: `${tick}-4`,
      kind: "seen",
      of: batch,
      result: { channel: "maestro", item, state: "review" },
      scope,
      tick,
      ts: new Date().toISOString(),
      v: 1,
    });
  }
  return { batch, lines };
}
