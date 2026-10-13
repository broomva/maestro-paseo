# Dogfood receipt: Maestro next (BRO-3100)

Date 2026-10-13. Plugin under test: `da5cffa` (main, live). Ticket: BRO-3100, under BRO-2980.

## What was run, and what was not

| Surface | What it was | Strength |
|---|---|---|
| **Sandbox web client, desktop** | `scripts/dogfood/up.ts --plugin .` (throwaway Paseo 0.11.1 daemon, plugin from `da5cffa`, seeded work), its web client in headless Chromium 1440x900, driven over DevTools (real mouse events). The plugin gets the 1120 px R0 width. | Same bundle the Paseo app runs; not the Electron window. |
| **Sandbox web client, phone** | Same daemon, Chromium at 402x874 (iPhone 16 Pro points) with touch emulation; swipes are real `Input.dispatchTouchEvent` sequences. | **Browser at an iPhone viewport, not a device and not the native Paseo app.** |
| **iOS simulator** | iPhone 16 Pro, iOS 18.2, Mobile Safari opened on the sandbox daemon (`sim-m1-feed.png`). | Render only. No taps or swipes: `simctl` has no tap, and `screencapture`/System Events return an all-black frame and no windows here, so `cliclick` could not be aimed. The Paseo iOS app is not installed, and building it was out of scope. |
| **Live plugin** | `bun bin/maestro.ts ls`, `ls --json`, `config`: read only. | CLI only. |
| **The real Paseo app window (R0)** | **Not run.** Screen capture is blocked (black frame), the app exposes no debug port (49333 answers `Unauthorized`), and the live daemon on 6767 serves no web client. | n/a |

Writes ran only in the sandbox: the throwaway ask ledger (three planted asks), the two seeded approvals, and one New work item (`BRO-3100 throwaway`), which was then canceled. No live owner item was approved, answered, canceled or dispatched. Nothing was dispatched anywhere. The sandbox and simulator are torn down.

**Evidence that is a command output, not a file.** The sandbox was deleted at the end, so three checks were read from the terminal during the run and no transcript was saved: the ledger file after Answer (`answered_by: owner:maestro`, `status: resolved`), `needs.list` still holding 2 approvals after Undo, and `work.list` reading `canceled` for the throwaway. They are stated below as observed, not as reproducible from this folder. The two answer screenshots are from two separate runs (`j-ask-answered.png` answers "Blue" on the first planted ask, `j-ask-undo-window.png` answers "Keep" on a second one added after it).

Sandbox limits worth knowing: the planted asks are not "held" (not batched to a session), so they show as "Decide: open, not waiting on you" and the phone deck says "No decision waits on you"; the Health schedules list shows the real machine's launchd jobs (green history bars beside "Not read"; the phone Fleet sheet reads "6 / none registered") because launchd is not sandboxed, so J7 and M7 judge layout, not those numbers; a first fleet config of mine had the wrong shape, so `j-j5-decisions.png` carries a "has no scopes" banner that is my fixture's fault and is gone in `j-j3-ask-briefing.png`; Initiatives had no seed.

## Screens

Evidence paths are under `docs/dogfood/2026-10-13/`.

| Row | Result | Evidence | Notes / ticket |
|---|---|---|---|
| J1 Feed home | **fail** | `j-j1-feed.png` | Renders: tiles, holds as cards, rows, rail. New work wraps to a second header row at 1120 px on Feed, Decisions and Work (not Health or Initiatives); design has one row. [BRO-3104](https://linear.app/broomva/issue/BRO-3104) |
| J2 Approval briefing | pass | `j-j2-approval-briefing.png` | Inspector slides in from the right with action, evidence, what happens next, Deny and Allow (the session row is below the cut of the screenshot). |
| J3 Ask briefing | not run | `j-j3-ask-briefing.png` | No held ask can be made in the sandbox; the ask row in the Feed jumps to Decisions, which is J5. The ask inspector itself was not seen. |
| J4 Notice briefing | pass | `j-j4-notice-briefing.png` | Evidence block, Closes when, prompt box, "No Approve" note, Cancel work / Open session / Unblock with a prompt. |
| J5 Decisions | **fail** | `j-j5-decisions.png`, `j-ask-undo-window.png`, `j-ask-answered.png` | Four tiles, ask card, answer routing line all render and the answer lands in the ledger after 8 s. The line says "unless you undo it" and offers no Undo. [BRO-3101](https://linear.app/broomva/issue/BRO-3101) |
| J6 Work | pass | `j-j6-work.png` | Board lanes Queued, Running, Standing, Needs you, Done (the Done lane is clipped at the right edge and scrolls). |
| J6b Work inspector | **fail** | `j-j6b-work-inspector.png`, `j-cancel-confirm.png` | Inspector opens to the right (B3). Running item: pass. Queued item with no session shows an Open session button. [BRO-3102](https://linear.app/broomva/issue/BRO-3102) |
| J7 Health | pass | `j-j7-health.png` | Verdict, fleet ticks, sessions, schedules, conductor, notices with what closes each. |
| J8 Initiatives | pass (empty state only) | `j-j8-initiatives.png` | No initiative files were seeded, so only the zero state and counters were seen. |
| J9 New work | pass | `j-j9-new-work.png`, `j-j9-queued-in-work.png` | Modal over the dimmed Feed; picker row, brief, "What it must land to reach you", "Who starts it" copy. Save to queue created a queued item. Dispatch was not pressed. |
| M1 Feed deck, sheet, tab bar | pass | `m-m1-feed-deck.png`, `m-m1-deck-swiped-left.png`, `m-m1-sheet-pulled-up.png`, `sim-m1-feed.png` | Left swipe moves 1 of 2 to 2 of 2; a pull-up from the handle opens "Everything else" with the tab bar riding on it. Rightward swipe was not tested (known: Paseo's native sidebar takes it, BRO-3062). Simulator shot is Mobile Safari render only. |
| M2 Approval detail | pass | `m-m2-approval-detail.png` | Opened from "Details, session and history". |
| M3 Ask detail | not run | none | No held ask in the sandbox. |
| M4 Notice detail | **fail** | `m-m4-notice-detail.png` | The Health card has Open session and Unblock only; no path to the detail. [BRO-3103](https://linear.app/broomva/issue/BRO-3103) |
| M5 Decisions | not run | `m-m5-decisions.png` | Only the empty state ("No decision waits on you") was seen, since the planted asks are not held. |
| M6 Work | pass | `m-m6-work.png` | Deck of hold cards with lifecycle and receipts. |
| M7 Health | pass | `m-m7-health.png`, `m-m7-health-sheet.png` | Notice deck; sheet carries the fleet row. |
| M8 Initiatives | pass (empty state only) | `m-m8-initiatives.png` | Reached from the Health sheet, "from Health". |
| M9 New work | pass (render only) | `m-m9-new-work.png` | Grows from the `+`; Save to queue and Dispatch pinned. Not saved or dispatched on the phone. The software keyboard lift was not seen. |
| M10 From a push | not run | none | Needs the native Paseo app and a real push; nothing here can raise one. |
| M11 Settings | pass | `m-m11-presence.png`, `m-m11-settings.png` | Presence menu then Settings: Presence, Runs and gate, Lanes, Loops, Notices. The presence switch is deferred to BRO-2987, as the menu says. |

## Owner flows

| Flow | Result | Evidence | Notes / ticket |
|---|---|---|---|
| Answer an ask | **fail** | `j-ask-answered.png`, `j-ask-undo-window.png` | Written to the sandbox ledger (`answered_by: owner:maestro`, `status: resolved`) 8 to 10 s after Answer; no Undo control. [BRO-3101](https://linear.app/broomva/issue/BRO-3101) |
| Allow, then Undo | pass | `j-allow-toast.png`, `j-allow-undone.png`, `m-m1-allow-toast.png`, `m-m1-allow-undone.png` | Desktop and phone: toast "Allowed · applies in N s" with Undo; after Undo `needs.list` still held 2 approvals (checked with `scripts/dogfood/rpc.ts needs.list`). Deny was not pressed. |
| New work (+) | pass | `j-j9-new-work.png`, `j-j9-queued-in-work.png`, `j-cancel-arm.png`, `j-cancel-done.png` | Saved to queue, then canceled: first press arms ("Press Cancel work… again within 5 s"), second cancels with a toast and a banner, both offering Undo; `work.list` then read `canceled`. |
| Settings | pass | `j-settings-from-presence.png`, `j-health-settings-link.png`, `m-m11-settings.png` | Presence menu "Settings ›" and Health "Settings › Loop and fleet" both reach `/settings/hosts/<id>/plugins/maestro/maestro`. |
| Needs-you counts vs `maestro ls` | sandbox pass; live partial; **fail** on ls | `maestro-ls-sandbox.txt`, `maestro-ls-live.txt` | Sandbox: Needs you (2), Stuck (2), Running (1), Queued (3) in the CLI equal the Feed's 2 holds, Health 2, Running 1, Queued 3. Live: CLI shows 0 held; the live UI count was not read (no window access). `maestro ls` prints 105 of 111 items, dropping the 6 Finished ones (the sandbox listing drops its Finished item too). [BRO-3105](https://linear.app/broomva/issue/BRO-3105) |

## Tickets filed (all under BRO-2980)

- [BRO-3101](https://linear.app/broomva/issue/BRO-3101): Decisions answer line promises Undo and has none.
- [BRO-3102](https://linear.app/broomva/issue/BRO-3102): Open session on queued work with no session.
- [BRO-3103](https://linear.app/broomva/issue/BRO-3103): phone Health notice cards cannot reach M4.
- [BRO-3104](https://linear.app/broomva/issue/BRO-3104): header wraps New work at 1120 px on Feed, Decisions and Work.
- [BRO-3105](https://linear.app/broomva/issue/BRO-3105): `maestro ls` omits Finished work.

No existing ticket among BRO-3062..3099 covered any of these (checked with `list_issues parentId=BRO-2980`).

## What a follow-up should run

The real Paseo app window and a real iPhone or the native Paseo iOS app (J-rows in the Electron frame, M10, the software keyboard under M9, and rightward swipes), plus a held ask raised by a real session to cover J3, M3 and M5.
