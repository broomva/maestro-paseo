// The Loops read on this machine, end to end, without the daemon: the real
// ledger reader, the Timeline's adapters, launchd presence, Paseo's schedule
// files, GitHub Actions, p9, and the reconcile (BRO-2931). Prints the row
// table. Read-only unless --drift-home is given: then drift transitions are
// written through broomva_home.py into that home (a temp dir), never ~/.broomva.
//
//   bun scripts/dogfood/loops-live.ts                       # ledger from ~/broomva origin/main
//   bun scripts/dogfood/loops-live.ts --ledger <dir>         # a ledger folder (the P1 rows, or a canary copy)
//   bun scripts/dogfood/loops-live.ts --ledger <dir> --drift-home <tmp> [--json]

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { wallClock } from "../../server/fleet";
import { GhaSchedules } from "../../server/gha";
import { Launchd, launchdPresence } from "../../server/launchd";
import { homeWriter, Loops } from "../../server/loops";
import { dirLedger, gitLedger, loopPaths } from "../../server/loops-ledger";
import { driftName } from "../../server/loops-model";
import { paseoSchedulesDir, wakeLogPath } from "../../server/paths";
import { Timeline } from "../../server/timeline";
import { WakeLog } from "../../server/wake-log";

const arg = (name: string) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? (process.argv[at + 1] ?? null) : null;
};
const ledgerDir = arg("--ledger");
const driftHome = arg("--drift-home");
const repo = join(homedir(), "broomva");
const paths = loopPaths();
const wakes = new WakeLog(wakeLogPath(), () => undefined);
const timeline = new Timeline({
  launchd: new Launchd({ prefix: "com.broomva." }),
  launchdPrefix: "com.broomva.",
  schedulesDir: paseoSchedulesDir(),
  loop: async () => ({ minutes: 30, nextAt: null, ticking: true }),
  wakes: () => wakes.recent(1000),
  wakeLogPath: wakes.path,
  fleet: null,
  clock: { ...wallClock(), error: null },
  log: () => undefined,
});
const inspect = (id: string) =>
  new Promise<{ found: boolean; archivedAt: string | null }>((resolve) => {
    execFile("paseo", ["inspect", id, "--json"], { timeout: 20_000 }, (error, stdout) => {
      if (error) return resolve({ found: false, archivedAt: null });
      const agent = JSON.parse(stdout) as { ArchivedAt?: string | null };
      resolve({ found: true, archivedAt: agent.ArchivedAt && agent.ArchivedAt !== "None" ? agent.ArchivedAt : null });
    });
  });
const loops = new Loops({
  ledger: ledgerDir ? dirLedger(ledgerDir) : gitLedger(repo, { fetch: true }),
  timeline,
  schedulesDir: paseoSchedulesDir(),
  presence: (labels) => launchdPresence(labels),
  gha: new GhaSchedules(),
  p9Dir: join(homedir(), ".config", "broomva", "p9"),
  streams: paths.streams,
  notes: paths.notes,
  driftFile: driftHome ? join(driftHome, "ledger", "loops", "drift.jsonl") : undefined,
  agents: async (ids) => new Map(await Promise.all(ids.map(async (id) => [id, await inspect(id)] as const))),
  writer: driftHome ? homeWriter(repo, { ...process.env, BROOMVA_HOME: driftHome }) : null,
  log: () => undefined,
});
const view = await loops.get();
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(view, null, 2));
  process.exit(0);
}
const pad = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text.padEnd(n));
console.log(
  `ledger ${view.ledger?.path} @ ${view.ledger?.sha ?? "(folder)"} · ${view.rows.length} rows · ${view.ledgerErrors.length} ledger errors`,
);
console.log(
  `${pad("loop", 28)} ${pad("kind", 16)} ${pad("scope", 9)} ${pad("desired", 8)} ${pad("presence", 8)} ${pad("status", 8)} drift`,
);
for (const section of ["loops", "ephemeral"] as const) {
  if (section === "ephemeral") console.log("── Session & watchers");
  for (const row of view.rows.filter((one) => one.section === section)) {
    const drift = row.unread
      ? "(unread)"
      : row.drift.map((one) => `${driftName(one.kind)}${one.needsYou ? "!" : ""}`).join(" ");
    console.log(
      `${pad(row.id ?? row.name, 28)} ${pad(row.kind, 16)} ${pad(row.scope, 9)} ${pad(row.desired ?? "-", 8)} ${pad(row.observed?.presence ?? "none", 8)} ${pad(row.observed?.status ?? "-", 8)} ${drift}`,
    );
  }
}
for (const error of view.ledgerErrors) console.log(`ledger error: ${error.file}: ${error.error}`);
for (const warning of view.warnings) console.log(`warning: ${warning}`);
const unregistered = view.rows.filter(
  (row) => row.scope === "broomva" && row.section === "loops" && row.drift.some((one) => one.kind === "unregistered"),
);
console.log(`UNREGISTERED among broomva non-ephemeral loops: ${unregistered.length}`);
const needs = (await loops.notices()).length;
console.log(`Needs you (loopNeeds): ${needs}`);
process.exit(0);
