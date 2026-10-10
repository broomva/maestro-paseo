# Maestro next (BRO-2980)

The source is `../maestro-next.pen` (open it in Pen). The PNGs here are renders of its frames. The visual language is broomva-design: the foundation plus the agentic-work extension.

## Ready for build (2026-10-10)

**What to build:** the chosen design.
- **J1–J9 on the desktop:** J1 is the Feed home; J6b is Work with the inspector open.
- **M1–M11 on the iPhone.**
- **K0–K2:** cards inside a Paseo session.
- **P1:** the presence menu.
- **B2, B3, D4:** settings on the desktop; M11 on the phone.

Everything else on the canvas is reference:
- S (the first full pass);
- V (variations, compared in V0);
- H (interim);
- G (Liquid Glass);
- R0 (the measured Paseo frame).

**The owner's decisions** are in `.control/asks/maestro-next-design.yaml` in broomva/workspace:
- **A1–A11** from 10-09;
- **B1–B7** from 10-10:
  - **B1:** broomva ink with the Undertow;
  - **B2:** a due initiative review is an Ask in the Feed deck;
  - **B3:** J6 opens the inspector to the right;
  - **B4:** undo is 8 s everywhere.

**The handoff:** [`handoff-2026-10-10.md`](handoff-2026-10-10.md) covers what was decided, the review record, and what is still open.

**The contracts:**
- [`view-models.md`](view-models.md): what each screen reads and writes, the two projections (`needs.list`, `handled.list`), the 8 s undo, and the invariants.
- [`inventory.yaml`](inventory.yaml): every page points at its J frame and its M frame. `scripts/inventory-check.ts` fails a live page that points at a reference export.

**Build order (Linear):**
1. BRO-2990: the plugin never starts work.
2. BRO-2995.
3. BRO-3001: needs.list and the view models.
4. BRO-2999: retire Approve on work.
5. BRO-3032: undo 8 s.
6. BRO-3033: device spike.
7. BRO-3034: component kit.
8. BRO-3035: J1 and the header.
9. BRO-3036: J2–J9.
10. BRO-3037: M1–M11.
11. BRO-2996 and BRO-2997.

The cards in sessions are BRO-3008.

**Not verified yet** (BRO-3033):
- what Paseo's iOS app draws around a plugin screen;
- whether `openScreen` params can carry a hold key;
- how gestures and the keyboard behave inside a plugin;
- gradients on iOS for the Undertow (`experimental_backgroundImage`; on the desktop they pass through as `backgroundImage`);
- how a push body renders.

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
| I0 | `i0-inventory.png` | The inventory as drawn on 10-09 (31 features, 25 pages, 24 components, 66 interfaces, 23 stores, 10 loops; `bun scripts/inventory-check.ts --summary` gives today's counts), each keep, change, new or retire against today's code (BRO-2994) |
| I1 | `i1-articulation.png` | How it articulates: the layers, who calls whom (callers × handling layer), three traces (allow a merge, answer an ask, start new work), the rules the checker enforces |
| I2 | `i2-findings.png` | The 27 findings as drawn on 10-09 (28 today, with the undo constant, BRO-3032) by severity, each with its ticket (BRO-2990, 2995–3002), and the build order they suggest |
| G0 | `g0-two-languages.png` | Liquid Glass alternative (BRO-3003): S1 and G1 side by side; what changes (material, color, type, shape, navigation, push); how it moves (springs from /apple-design); what it buys and costs; a middle path |
| G1 | `g1-glass-feed-mac.png` | Liquid Glass: the Feed on the Mac, with a glass sidebar (lanes, presence), toolbar and inspector over solid cards |
| G2 | `g2-glass-iphone.png` | Liquid Glass on iPhone: a lock-screen push with Allow, Deny and Open; the Feed with a floating tab bar; an Ask as a sheet |
| G3 | `g3-glass-settings-lanes.png` | Liquid Glass: Settings › Lanes, with the conductor, each lane and the fleet as grouped forms |
| H1 | `h1-interim-feed-desktop.png` | Interim (BRO-3005): the Feed inside Paseo on the desktop. broomva tokens, Apple behaviors (springs, an Ask that grows from its card, an Undo capsule), frost only on floating chrome. Every element is tagged with the API that builds it |
| H2 | `h2-interim-phone.png` | Interim on iPhone: the real push ("Agent finished", body ≤220, no buttons), then the gate card in the session, then Paseo's own 65% sheet |
| H3 | `h3-interim-feasibility.png` | What a Paseo plugin can truly build: 19 elements, YES / PARTIAL / NO on desktop and iPhone, what waits on Paseo, the build order |
| K0 | `k0-push-to-card-flow.png` | Cards in sessions (BRO-3008): from a notification to the asking session, to the card at its tail (one tap, 8 s undo, receipt), to Open in Maestro |
| K1 | `k1-session-cards.png` | Every Maestro card kind (approval, ask, owner step, finished, health, inbox digest) and state (pending, undo, receipt, resolved elsewhere), plus how a card behaves |
| K2 | `k2-session-page.png` | The Maestro page for one session: identity, holds (the same card), work, history, controls; opened with openScreen params |
| R0 | `r0-paseo-real-frame.png` | Paseo's real frame, measured from the running app (1920 × 986): Paseo owns the 440 px sidebar (one Maestro row) and the 35 px header; Maestro owns 1480 × 951, of which today's Feed uses a centred 712 px column |
| S1r | `s1r-s1-in-real-frame.png` | S1 unchanged inside the real frame: it fits the 1480 px area; its big title repeats Paseo's header |
| V0 | `v0-variations-compared.png` | Variations (BRO-3012): S1, H1 and V1–V4 compared on information, dashboard feel, Apple feel, acting without opening, evidence, phone and build cost |
| V1 | `v1-dashboard-apple-touch.png` | S1's dashboard in Paseo's real frame with Apple touches: frosted top header (segmented tabs, workspace menu shown open, presence, search, New work), an Ask answered in place, an undo capsule |
| V2 | `v2-glance-strip.png` | V1 plus four glance tiles; holds stay full cards, watched kinds become two-line rows and grouped lists |
| V3 | `v3-list-inspector.png` | Mail-style list with safe verbs inline and an inspector for the selected item |
| J1 | `j1-feed-home.png` | **Chosen** (was V4): V2's home with V3's inspector opened from a card. The J series (BRO-3024) redraws S2–S9 in this language |
| J6b | `j6b-work-inspector.png` | Work with an item open: the inspector over the Needs you and Done lanes (owner B3) |
| J2–J4 | `j2-j4-briefings.png` | S2–S4's briefings as J1's inspector, one per kind: approval, ask (options, default countdown, words), notice (log, closes when, no Approve) |
| J5 | `j5-decisions.png` | Decisions one at a time: sort and ledger filter, four answer tiles (Waiting to land as a warn tile with a verb), the decision at full width, Up next, where your last answers went |
| J6 | `j6-work.png` | Work as five trays (Queued, Running, Standing, Needs you, Done); Running cards wear the Undertow; Done shows who closed it |
| J7 | `j7-health.png` | Health: verdict line, four tiles (tick grid, sessions bar, schedules, the conductor and its lanes), notices with what closes each, per-schedule 24 h bars, sessions |
| J8 | `j8-initiatives.png` | Initiatives: lateness loudest, driver as a standing pulse, the skene review in the inspector with three answers |
| J9 | `j9-new-work.png` | New work grows from its button over a dimmed Feed; a Who starts it row (the lane, A8) |
| JE | `je-evaluation.png` | The nine rules of the J language (rule 9: Undertow marks Running only), a per-screen before and after, and what is still yours to decide |
| M1a | `m1a-top-tabs.png` | Mobile (BRO-3025): J1 on iPhone as is: scrolling segmented tabs under Paseo's header, a 2×2 glance, the inspector as a pushed page |
| M1b | `m1b-bottom-tab-bar.png` | Maestro's own bottom tab bar (Feed, Decisions, Work, Health + New work), large titles with the verdict line, a swipeable glance row |
| M1c | `m1c-focus-deck.png` | One hold at a time with thumb-sized verbs; everything else in a sheet you pull up; sections in a title menu |
| M1d | `m1d-inbox-swipe.png` | One dense grouped list, row verbs and swipe actions, a title menu and a bottom toolbar |
| M1v | `m1v-mobile-compared.png` | The four compared; recommends M1b's tab bar with M1c's deck at the top of the Feed; what to check on a device |
| M1 | `m1-feed-home-mobile.png` | **Chosen** mobile home: M1c's deck with a pull-up sheet that peeks from the bottom edge; M1b's tab bar rides on the sheet's top edge; M1d's row swipes and undo toast on sheet rows only; the Decisions tab uses the same shape |
| M2–M4 | `m2-m4-briefings-mobile.png` | Briefings on the phone: approval, ask and notice as cards that rise from the deck (M/Detail header: grabber, round close, "Approval · 1 of 4" with segments, ⋯), verbs pinned above the home indicator |
| M5 | `m5-decisions-mobile.png` | Decisions: the open asks in the deck; the sheet holds where your answers went (stranded ones loudest); answering advances the deck with a toast |
| M6 | `m6-work-mobile.png` | Work: the deck holds work that needs you (hold, lifecycle, receipts); the sheet is the board with a lane switcher; running cards wear the Undertow; a running item's page |
| M7 | `m7-health-mobile.png` | Health: notices in the deck with what closes each; the sheet is the fleet (four tiles incl. the conductor) and schedules with swipe actions |
| M8 | `m8-initiatives-mobile.png` | Initiatives: a due review joins the Feed deck as a hold; the list is a page from Health's sheet; answering moves the review date |
| M9 | `m9-new-work-mobile.png` | New work: the composer grows from + over a dimmed Feed, rises with the keyboard, and Dispatch lands the work in Queued (the lane starts it, A8) |
| M10 | `m10-from-a-push.png` | From a push: Paseo's fixed-title push, the asking session with Maestro's card and Open in Maestro, then M1's deck on the same hold |
| M11 | `m11-settings-mobile.png` | Settings on the phone, reached from the presence menu: grouped rows, Lanes, Loop and fleet |
| P1 | `p1-presence.png` | Presence: the menu from the presence pill on desktop and phone, and what Present, Away and Off change (D5, corrected for A5: pushes carry no buttons) |
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
- only the conductor or a lane launches a session (A8);
- every store is written by its owning layer through one module, unless a ticket says otherwise;
- findings above minor carry a ticket.

```
bun scripts/inventory-check.ts --summary
```

Code facts come from four read-only passes over maestro-paseo 3f8d9d8: interfaces, stores and loops, the client, and smells. Each cites file:line.

`paseo-feature-request.md` was filed upstream as getpaseo/paseo#6472 on 2026-10-09 and posted as discussion getpaseo/paseo#6478 on 2026-10-10 (owner B6). `paseo-plugin-capabilities.md` is the audit behind H3: what the Paseo 0.11.1 host lets a plugin render, with file and bundle-offset evidence. Read it before designing anything that floats, blurs, pushes or animates.
