# Maestro next (BRO-2980)

The source is `../maestro-next.pen` (open it in Pen). The PNGs here are renders of its frames. The visual language is broomva-design: the foundation plus the agentic-work extension.

| Frame | PNG | What it is |
| --- | --- | --- |
| A0 | `a0-what-needs-you.png` | Work never asks you to approve it. A session needs you only while it holds an ask, an approval (one exact action a policy layer held) or an owner step; the approval layers L0–L3 |
| A2 | `a2-after-you-click.png` | Each action, step by step, to the receipt on the card: answer, allow, deny, done, unblock, cancel, and the retired Approve |
| B1 | `b1-one-tap-approvals.png` | Approvals from three sources (the agent's own reasoning, a Claude Code permission prompt, a gate) on one card: Allow, Deny, Chat beside it; what never reached you |
| B2 | `b2-settings-loop-fleet.png` | Settings: the Maestro loop, the fleet kill switch, each scope's mode (off, dry run, act), run tick now, pause |
| B3 | `b3-settings-loops-notices-approvals.png` | Settings: loops with pause, resume, run now; the notice source registry (`.broomva/notices.yaml`); approval rules and grants |
| C0 | `c0-how-agents-reach-you.png` | Measured: how agent sessions reach you over 30 days, 678 sessions, 11,232 turn ends, clustered and mapped to kinds |
| C1 | `c1-what-the-measurements-change.png` | Seven changes the measurements call for, each with the card it produces, and the agents' typed contract |
| D0 | `d0-today-loops-and-thinkers.png` | Today: six schedulers (launchd, Paseo heartbeats and schedules, Maestro's plugin cron, session crons, GHA), four kinds of thinker, and who owns what they launch (BRO-2982) |
| D1 | `d1-target-conductor.png` | Target: you, then the Maestro conductor (a Paseo session with its own heartbeat; the plugin as its hands), then lane orchestrators, then workers; which scheduler each loop belongs on; bstack at every layer |
| D2 | `d2-incident-13b97ad9.png` | The 13b97ad9 incident (six answers became six blind sessions), step by step, today and with the conductor, with both prompts |
| D3 | `d3-prompt-stack-and-lanes.png` | The five-layer prompt stack (harness, workspace rules, role base, lane overlay, tick context or brief), where the SRI tick prompt goes, lane profiles |
| D4 | `d4-settings-lanes.png` | Settings › Lanes: the conductor, each lane's session, heartbeat, profile and prompt version, and the composed prompt |
| D5 | `d5-conductor-tick-and-presence.png` | The conductor's tick as a governed autonomy loop (reconcile, sweep, allocate, govern, log, resume on events), code vs judgement, its invariants, and the owner-presence model for when waiting is needed (A3, A8) |
| N0 | `n0-model.png` | Three nouns (work, ask, notice), one list, one verb each; six rules; what it retires |
| N1 | `n1-wiring.png` | Producers, verbs on maestro.sock, one store per kind, needs.list, views, the return path |
| N3 | `n3-lifecycles.png` | The states each kind passes through; the 10-09 Parser drift card, today vs next |
| N4 | `n4-migration.png` | M1 to M6, each with a proving test |
| S0 | `s0-decisions-ledger.png` | Every decision from feed-redesign, fleet-redesign, new-work and harness-architecture: kept, changed, merged or dropped |
| S1 | `s1-feed-home.png` | Feed home, wide: Needs you (approval, owner step), Health, Running and Queued, plus a rail with Decide, Handled for you and Today |
| S2–S4 | `s2-s4-briefings.png` | One briefing per kind: Approval (exact action, why it was held), Ask (options), Notice (evidence) |
| S5 | `s5-decisions.png` | Decisions triage, and where each of your answers went |
| S6 | `s6-work.png` | Work board in canonical states: Queued, Running (Undertow), Standing, Needs you (each names its hold), Done (who merged it) |
| S7 | `s7-health.png` | Health: fleet ticks, tiles, notices, schedules and loops, sessions roster |
| S8 | `s8-initiatives.png` | Initiatives, and a review laid out as keep, park or close |
| S9 | `s9-new-work.png` | The composer sheet, and what work must land to reach you |
| S10 | `s10-phone.png` | The push titled by kind; the phone Feed, light and dark |

Navigation goes from nine tabs to five: Feed, Decisions, Work, Health, Initiatives.

The mockups use Inter and JetBrains Mono because Pen cannot load the system stack. The plugin ships `ui-sans-serif` and `ui-monospace`.

All data on the screens is illustrative.

The measured data is in `reach-taxonomy.md`, with its machine-readable twin `reach-taxonomy.json`.
