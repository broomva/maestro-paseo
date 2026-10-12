#!/usr/bin/env bun
// Seed the sandbox's control repo (BRO-3036): the daemon's `~/broomva` under the sandbox's HOME, with a bare
// origin, two ask ledgers (one decision that blocks work, a trial with a default, and answered ones whose answers
// went four different ways) and five initiatives (two past their review date, one proposed, one parked and woken),
// so Decisions, Initiatives and the review asks have something to show. Then it reloads the plugin on the
// sandbox only. Nothing here touches the real ~/broomva.
//
//   bun scripts/dogfood/control.ts [--state <dir>]

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { flag, paseoBin, readState, resolveStateDir, sandboxEnv } from "./lib";

const dir = resolveStateDir(flag(process.argv.slice(2), "state"));
const state = dir ? readState(dir) : null;
if (!state) {
  console.error("control: no dogfood sandbox is up (bun scripts/dogfood/up.ts first)");
  process.exit(1);
}
const home = state.home;
const repo = join(home, "broomva");
const origin = join(state.dir, "origin-broomva.git");
if (!repo.startsWith(state.dir) || !origin.startsWith(state.dir)) throw new Error("control: not inside the sandbox");

const env = sandboxEnv({ HOME: home, GIT_CONFIG_NOSYSTEM: "1" });
const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout;
};

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");

const MODS = `# Ask ledger: the headless Claude Code mods
arc: claude-code-mods
asks:
  - id: A3
    headline: "Install the three headless Claude Code mods fleet-wide?"
    stakes: "Nothing blocks; the mods stay unused in tools/claude-code-mods."
    why_you: "A mod that answers tool.call runs before the P2 gate and the deny rules: a boundary only you move."
    options:
      - id: off
        label: "Keep them off"
        consequence: "nothing changes; revisit when a managed gate exists"
        reversible: true
        recommended: true
      - id: one
        label: "Install in one worktree first"
        consequence: "a trial on one session; the fleet stays as it is"
        reversible: true
      - id: fleet
        label: "Install fleet-wide"
        consequence: "every session loads them on its next start"
        reversible: false
    default: off
    blocking: false
    asked_at: ${hoursAgo(2)}
  - id: A4
    headline: "Same-vendor P20 while Codex is out?"
    stakes: "P20 reviews stay same-vendor until credits are added."
    why_you: "It changes what a passing review means."
    options:
      - id: same
        label: "Same-vendor"
        consequence: "P20 runs Strata B and C only"
        reversible: true
        recommended: true
      - id: wait
        label: "Wait for Codex"
        consequence: "reviews hold until credits are back"
        reversible: true
    default: same
    blocking: false
    asked_at: ${hoursAgo(30)}
    answered_at: ${hoursAgo(26)}
    answer: "same"
    answer_option: same
    answered_by: "owner:maestro"
    status: resolved
`;

const SRI = `# Ask ledger: STI-3587
arc: sti-3587
asks:
  - id: A1
    headline: "Approve STIMULUS.md as the seed for aligning the whole workspace?"
    stakes: "Every lane waits on the seed before it aligns its own docs."
    why_you: "It sets what every lane treats as the workspace's voice."
    options:
      - id: approve
        label: "Approve as the seed"
        consequence: "lanes align to it on their next tick"
        reversible: true
        recommended: true
      - id: revise
        label: "Revise first"
        consequence: "it goes back with your notes"
        reversible: true
    default: revise
    blocking: true
    asked_at: ${hoursAgo(9)}
`;

// A readable file (server/initiatives.ts rules): the intent says it was not stated verbatim, a driver is owner,
// fleet, none, coordinator:<8 hex> or session:<id>, and every file has a link and an exit.
const initiative = (id: string, extra: string) =>
  `id: ${id}\ntitle: "${id}"\nstated: ${day(-30)}\n${extra}\n${extra.includes("links:") ? "" : "links:\n  linear: [BRO-2980]\n"}exit: "the work lands, or the initiative is killed"\n`;

const INITIATIVES: Record<string, string> = {
  skene: initiative(
    "skene",
    `intent: "(not stated verbatim)"
summary: "parity merged: #16, #17 (P20 round 7); the S1 CLI is open (#15)"\nstatus: active\nnext_action: "Land S1 CLI (#15); follow-ups BRO-2963"\ndriver: session:skene-driver\nreview_by: ${day(-2)}\nlinks:\n  linear: [BRO-2963]`,
  ),
  "local-first-canvas": initiative(
    "local-first-canvas",
    `intent: "(not stated verbatim)"
summary: "spec drafted; no driver session"\nstatus: active\nnext_action: "Pick a driver"\ndriver: fleet\nreview_by: ${day(-2)}`,
  ),
  holon: initiative(
    "holon",
    `intent: "(not stated verbatim)"
summary: "holon#17-#19 merged"\nstatus: active\nnext_action: "session/load (BRO-2748)"\ndriver: coordinator:1a2b3c4d\nreview_by: ${day(-1)}`,
  ),
  kinetic: initiative(
    "kinetic",
    `intent: "(not stated verbatim)"
summary: "parked until the owner picks it up"\nstatus: parked\nnext_action: "Review today"\ndriver: none\nreview_by: ${day(10)}\nwake: ${day(0)}`,
  ),
  "maestro-next": initiative(
    "maestro-next",
    `intent: "(not stated verbatim)"
summary: "J1 merged, J2-J9 in review"\nstatus: active\nnext_action: "Review J2-J9"\ndriver: owner\nreview_by: ${day(4)}`,
  ),
};

if (!existsSync(origin)) {
  await mkdir(origin, { recursive: true });
  git(origin, "init", "--bare", "-b", "main");
}
if (!existsSync(join(repo, ".git"))) {
  await mkdir(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "config", "user.email", "dogfood@example.invalid");
  git(repo, "config", "user.name", "Dogfood");
}
await mkdir(join(repo, ".control", "asks"), { recursive: true });
await mkdir(join(repo, ".control", "initiatives"), { recursive: true });
await writeFile(join(repo, ".control", "asks", "claude-code-mods.yaml"), MODS);
await writeFile(join(repo, ".control", "asks", "sti-3587.yaml"), SRI);
for (const [id, body] of Object.entries(INITIATIVES))
  await writeFile(join(repo, ".control", "initiatives", `${id}.yaml`), body);
git(repo, "add", "-A");
git(repo, "commit", "-m", "dogfood: asks and initiatives", "--allow-empty");
git(repo, "push", "-u", "origin", "main");
console.log(`control repo: ${repo}`);

const reload = spawnSync(paseoBin(), ["plugin", "reload", "maestro", "--host", `127.0.0.1:${state.port}`], {
  env,
  encoding: "utf8",
});
console.log(
  reload.status === 0 ? "plugin reloaded on the sandbox" : `reload failed: ${reload.stderr || reload.stdout}`,
);
