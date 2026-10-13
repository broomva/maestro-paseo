# Dogfood harness

Validate a change by operating the real Maestro UI. The harness starts a throwaway Paseo daemon, installs the plugin
from any checkout, seeds work in every state, screenshots the Maestro surface, and tears it all down.

```sh
bun scripts/dogfood/up.ts --plugin <checkout>            # e.g. --plugin . or a worktree path
bun scripts/dogfood/shot.ts --out "$(mktemp -d)"          # 1440x900 + 375x812, list and detail
bun scripts/dogfood/down.ts                               # idempotent
```

`up.ts` prints the daemon URL, the Maestro URL, and the sandbox directory. To click around by hand, open the daemon
URL in any local browser and pick Maestro in the sidebar (a fresh browser sends a cold deep link to `/open-project`). It exits 2 if any seeded item did not land as expected, and tears the sandbox down itself if a
step fails (`--keep-on-failure` keeps it for inspection).

`shot.ts` options: `--width/--height` (desktop size, default 1440x900; a 375x812 phone shot is always added),
`--theme light|dark`, `--open "<title>"` (the item whose detail is captured; `--no-open` skips it), `--path <surface>`,
`--wait-for <text>`, `--steps "a|b|c"` (click each name in turn on the desktop viewport, saving `maestro-step-N-*.png` after each). On a timeout it saves `failed-*.png` and prints what the page did show.

Requirements: the Paseo desktop app (its `paseo` CLI and bundled web client), Bun, and a Playwright Chromium
(`bunx playwright install chromium`) or `--chrome <path>`.

## What is seeded

Two initiatives (`checkout-v2`, `platform`), four projects, twelve items:

| Shows as | Item | How it got there |
| --- | --- | --- |
| Finished | Retry failed card charges with backoff | Seeded history: a look with ran, three decisions, an ask, and a passed check. Nothing is held, so it is watched, never counted as needing you (A1) |
| Needs you (Question) | Publish the build cache to the shared bucket, Rotate the staging deploy key | Live: dispatched to the stand-in agent, which asks to run `git push`. Allow or Deny each (approval.decide, 8 s undo) |
| Running | Add request tracing to the API gateway | Live: dispatched to the stand-in agent, which holds its turn open |
| Stuck | Migrate webhooks to the v3 signing scheme | Seeded history: the turn failed with a reason |
| Stuck | Alert on p95 latency regressions | Seeded history: gate auto, one of two checks failed |
| Queued | Persist the cart across devices, Cache the Rust build in CI | Seeded folders |
| Queued | Write the Q4 reliability review | Created over `work.create`, as the New work form does |
| Done | Show tax lines in the order summary, Pin the Node version in CI | Seeded history: you approved (a decision recorded before approve was retired); checks decided |
| Done (canceled) | Try a one-page checkout experiment | Seeded history |

Seeded history is written as `_work.md` plus `_events.jsonl`, the files the engine itself writes. `seed.test.ts`
reads them back through `server/store.ts` and `server/wire.ts` and checks every state change against the state
machine, so a change to the on-disk contract fails the tests before it produces a misleading screenshot. Seeded
items have no live session behind them; the three live items are real sessions of the stand-in agent.

## Isolation

The real daemon runs live sessions, so the sandbox shares nothing with it:

- One `mktemp -d /tmp/maestro-dogfood-XXXXXX` holds the Paseo home, a `HOME` for the daemon, the Maestro config,
  agent socket and work root, three small git repos, and the daemon log. `down.ts` deletes only a directory that
  carries the harness's `state.json` marker.
- Every `PASEO_*` and `MAESTRO_PASEO_*` variable is dropped from spawned processes, and every CLI call names the
  sandbox (`daemon run --home <sandbox>`, `plugin install --host 127.0.0.1:<port>`). Ports 6767 and 6799 are never
  used.
- Before anything goes through the plugin (`work.create`, `work.dispatch`), `up.ts` asks it for its config and stops
  if the work root is not the sandbox's, then waits for the agent socket to appear in the sandbox.
- All real providers are disabled. The only one is `dogfood/stand-in` (`fake-acp.ts`), a stub ACP agent with no
  model, so a Dispatch clicked while dogfooding costs nothing. It asks for permission in a repo that holds a
  `.dogfood-ask` file.
- Dictation and voice are off, so the daemon does not download its ~1 GB speech model.
- The daemon runs in its own process group. `down.ts` stops that group only while the recorded pid still runs this
  sandbox's exact `daemon run --home <sandbox>/paseo-home` invocation, then anything carrying the sandbox's own
  arguments (stand-in agents, a browser an interrupted `shot.ts` left), and checks that none survive. It never
  signals itself, an ancestor, or another Paseo daemon.
- `state.json` and the pointer are written `0600` and followed only if each is a regular file owned by you that the
  group and world cannot write, and the pointer's marker and directory match that directory's `state.json`.

The daemon serves the Paseo web client itself (`features.webUi`, pointed at the desktop app's bundle), so the
browser is on the daemon's own origin: no host to add, and no Local Network Access flags. A cold deep link lands on
`/open-project`, so `shot.ts` loads `/` first and waits until the app has registered the host.

More than one checkout can run a sandbox at once: each records its own under a pointer keyed by its path. Pass
`--state <dir>` or set `MAESTRO_DOGFOOD_STATE` to act on a specific one.

## Reads are pure (BRO-2995)

```sh
bun scripts/dogfood/up.ts --plugin . --sweep-seconds 90
bun scripts/dogfood/reads-pure.ts --polls 50 --plant --wait-sweep 150
```

`reads-pure.ts` polls the reads every client polls (`work.list`, `work.attention`, `loops.get`, `fleet.get`,
`timeline.get`) N times through the sandbox daemon. It compares every file in the sandbox but Paseo's own home and the
daemon log (the work store's event logs with their mtimes, the wake log, the inbox, any ledger) and Paseo's sessions
(how many, archived, labels) before and after, and exits 1 if anything moved. `--plant` first plants work only a write
changes: a run whose session was archived while the plugin heard nothing, and an approval whose undo window closed.
`--wait-sweep` then waits for the plugin sweep to change them on its own cadence (`--sweep-seconds` on `up.ts`), and
prints when and how. It acts only on a sandbox `up.ts` made.

## The Loops read on this machine

`bun scripts/dogfood/loops-live.ts` runs the Loops read end to end without a daemon: the ledger (from
`~/broomva` origin/main, or `--ledger <dir>`), the real launchd, Paseo schedule files, GitHub Actions
and p9, then the reconcile, and prints the row table and the UNREGISTERED count. It writes nothing
unless `--drift-home <tmp>` is given; then transitions go through `broomva_home.py` into that home,
never `~/.broomva`. Put a canary row in a temp copy of the ledger to make a drift appear, then remove
it to clear it. Never change a real substrate to do this.

## Session cards (BRO-3008)

```sh
bun scripts/dogfood/up.ts --plugin .
bun scripts/dogfood/cards.ts --out "$(mktemp -d)" [--theme dark]
```

`cards.ts` opens each stand-in session's own page, where Maestro's card sits at the tail, and operates it: Open in
Maestro (K2), Allow, the 8 s Undo, the receipt, and a hold allowed from the Feed in another page whose card then
follows. Add `origin.agent_id: <agent id>` to an ask in the sandbox's control repo (`control.ts` seeds the ledgers)
to get an Ask card in that session. PNGs land in `--out`; a background page does not poll, so the script brings the
one it watches to the front.
