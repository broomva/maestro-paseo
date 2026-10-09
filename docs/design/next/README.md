# Maestro next (BRO-2980)

The source is `../maestro-next.pen` (open it in Pen). The PNGs here are renders of its frames. The visual language is broomva-design: the foundation plus the agentic-work extension.

| Frame | PNG | What it is |
| --- | --- | --- |
| Start here | `00-start-here.png` | Every frame in reading order, in five groups (model, screens, controls, conductor, history), each tagged current, reference, needs pass or history; where each answer A1–A11 shows; what is not drawn yet |
| A0 | `a0-what-needs-you.png` | Work never asks you to approve it. A session needs you only while it holds an ask, an approval (one exact action a policy layer held) or an owner step; the approval layers L0–L3 |
| A2 | `a2-after-you-click.png` | Each action, step by step, to the receipt on the card: answer, allow, deny, done, unblock, cancel, and the retired Approve |
| B1 | `b1-one-tap-approvals.png` | Approvals from three sources (the agent's own reasoning, a Claude Code permission prompt, a gate) on one card: Allow, Deny, Chat beside it; what never reached you |
| B2 | `b2-settings-loop-fleet.png` | Settings: the plugin sweep (it never starts work, A8), the fleet ceiling, the fleet kill switch, each scope's mode (off, dry run, act), run tick now, pause |
| B3 | `b3-settings-loops-notices-approvals.png` | Settings: loops with pause, resume, run now; the notice source registry (`.broomva/notices.yaml`); approval rules and grants |
| C0 | `c0-how-agents-reach-you.png` | Measured: how agent sessions reach you over 30 days, 678 sessions, 11,232 turn ends, clustered and mapped to kinds |
| C1 | `c1-what-the-measurements-change.png` | Seven changes the measurements call for, each with the card it produces, and the agents' typed contract |
| D0 | `d0-today-loops-and-thinkers.png` | Today: six schedulers (launchd, Paseo heartbeats and schedules, Maestro's plugin cron, session crons, GHA), four kinds of thinker, and who owns what they launch (BRO-2982) |
| D1 | `d1-target-conductor.png` | Target: you, then the Maestro conductor (a Paseo session with its own heartbeat; the plugin as its hands), then lane orchestrators, then workers; which scheduler each loop belongs on; bstack at every layer |
| D2 | `d2-incident-13b97ad9.png` | The 13b97ad9 incident (six answers became six blind sessions), step by step, today and with the conductor, with both prompts |
| D3 | `d3-prompt-stack-and-lanes.png` | The five-layer prompt stack (harness, workspace rules, role base, lane overlay, tick context or brief), where the SRI tick prompt goes, lane profiles |
| D4 | `d4-settings-lanes.png` | Settings › Lanes: the conductor, each lane's session, heartbeat, profile and prompt version, and the composed prompt |
| D5 | `d5-conductor-tick-and-presence.png` | The conductor's tick as a governed autonomy loop (reconcile, sweep, allocate, govern, log, resume on events), code vs judgement, its invariants, and the owner-presence model for when waiting is needed (A3, A8) |
| I0 | `i0-inventory.png` | The inventory: 31 features, 25 pages, 24 components, 66 interfaces, 23 stores, 10 loops, each keep, change, new or retire against today's code (BRO-2994) |
| I1 | `i1-articulation.png` | How it articulates: the layers, who calls whom (callers × handling layer), three traces (allow a merge, answer an ask, start new work), the rules the checker enforces |
| I2 | `i2-findings.png` | 27 findings against the inventory by severity, each with its ticket (BRO-2990, 2995–3002), and the build order they suggest |
| G0 | `g0-two-languages.png` | Liquid Glass alternative (BRO-3003): S1 and G1 side by side; what changes (material, color, type, shape, navigation, push); how it moves (springs from /apple-design); what it buys and costs; a middle path |
| G1 | `g1-glass-feed-mac.png` | Liquid Glass: the Feed on the Mac, with a glass sidebar (lanes, presence), toolbar and inspector over solid cards |
| G2 | `g2-glass-iphone.png` | Liquid Glass on iPhone: a lock-screen push with Allow, Deny and Open; the Feed with a floating tab bar; an Ask as a sheet |
| G3 | `g3-glass-settings-lanes.png` | Liquid Glass: Settings › Lanes, with the conductor, each lane and the fleet as grouped forms |
| H1 | `h1-interim-feed-desktop.png` | Interim (BRO-3005): the Feed inside Paseo on the desktop. broomva tokens, Apple behaviors (springs, an Ask that grows from its card, an Undo capsule), frost only on floating chrome. Every element is tagged with the API that builds it |
| H2 | `h2-interim-phone.png` | Interim on iPhone: the real push ("Agent finished", body ≤220, no buttons), then the gate card in the session, then Paseo's own 65% sheet |
| H3 | `h3-interim-feasibility.png` | What a Paseo plugin can truly build: 19 elements, YES / PARTIAL / NO on desktop and iPhone, what waits on Paseo, the build order |
| K0 | `k0-push-to-card-flow.png` | Cards in sessions (BRO-3008): from a notification to the asking session, to the card at its tail (one tap, 10 s undo, receipt), to Open in Maestro |
| K1 | `k1-session-cards.png` | Every Maestro card kind (approval, ask, owner step, finished, health, inbox digest) and state (pending, undo, receipt, resolved elsewhere), plus how a card behaves |
| K2 | `k2-session-page.png` | The Maestro page for one session: identity, holds (the same card), work, history, controls; opened with openScreen params |
| J0 | `j0-sweet-spot-compared.png` | Sweet spot (BRO-3012): S1, H1 and J1–J4 compared on information, dashboard feel, Apple feel, acting without opening, evidence, phone and build cost; recommends J4 |
| J1 | `j1-dashboard-apple-touch.png` | S1's dashboard (stream + rail, full cards) inside Paseo, with Apple touches only: Maestro takes the window, a frosted top header (segmented tabs, workspace menu shown open, presence, search, New work), an Ask that answers in place, an undo capsule |
| J2 | `j2-glance-strip.png` | J1 plus four glance tiles (Needs you, Running, Handled today, Unsupervised); holds stay full cards, watched kinds become two-line rows and grouped lists |
| J3 | `j3-list-inspector.png` | Mail-style: every item a two-line row with its safe verb inline, the selected item in an inspector (evidence tiles, what happens after you act, session, history, frosted action bar) |
| J4 | `j4-recommended.png` | Recommended: J2's home with J3's inspector opened from a card, in place of the rail |
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

Notifications (owner answer A5): `notifications-integration.md` maps every channel, the gap to one-tap Allow/Deny, ranked options, and the draft feature request to Paseo.

## The inventory (BRO-2994)

`inventory.yaml` is the source; I0–I2 are drawn from it. `scripts/inventory-check.ts` checks it on every `bun test`:
- every feature reaches a page or a loop and has an interface;
- every page has a frame and its export;
- only the owner calls a gate verb;
- only a lane launches a session (A8);
- every store is written by its owning layer through one module, unless a ticket says otherwise;
- findings above minor carry a ticket.

```
bun scripts/inventory-check.ts --summary
```

Code facts come from four read-only passes over maestro-paseo 3f8d9d8: interfaces, stores and loops, the client, and smells. Each cites file:line.

`paseo-feature-request.md` was filed upstream as getpaseo/paseo#6472 on 2026-10-09. `paseo-plugin-capabilities.md` is the audit behind H3: what the Paseo 0.11.1 host lets a plugin render, with file and bundle-offset evidence. Read it before designing anything that floats, blurs, pushes or animates.
