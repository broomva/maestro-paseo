# BRO-3037 receipts, PR 1: M1–M5 and the phone half of M10

Shot in the dogfood sandbox at 375x812 (`bun scripts/dogfood/up.ts --plugin "$PWD"`, `bun scripts/dogfood/control.ts`, then
`bun scripts/dogfood/shot.ts --width 375 --height 812 [--theme dark] --no-open --wait-for "Needs you" --steps "Hold 2 of 4|Details, session and history|Close|Decisions|Raise the sheet|Back to the deck|Feed"`),
light and dark, against `docs/design/next/m1-feed-home-mobile.png`, `m2-m4-briefings-mobile.png`, `m5-decisions-mobile.png` and
`m10-from-a-push.png`. The sandbox's seeded work is not the frames' (an ask first, two approvals that `git push`, two due reviews).

| File | Shows |
|---|---|
| `m1-feed-deck-{light,dark}.png` | the Feed: "Needs you" with the workspace and presence chips, one hold (an ask here, its options as 44 pt rows, the silent default), Skip and Answer as 52 pt pills, the tab bar (Feed 4, Decisions 1, and no Health badge: notices.list was empty when this shot was taken; the other shots were taken later and show Health with a badge) on the sheet's top edge, "Everything else" with its four counts |
| `m1-feed-deck-hold2-approval-{light,dark}.png` | an approval hold: the kind's evidence, Deny… and the action named in the primary ("Allow push") |
| `m2-approval-card-{light,dark}.png` | Details: the card rises with the detail header ("Approval · 2 of 4", one segment per hold), the action, the evidence, what happens after you allow, the session; Deny… and Allow pinned |
| `m1-sheet-up-{light,dark}.png` | the sheet pulled up: the tab bar rode up with it; Queued, Running, Health, Finished as rows (no hold among them) |
| `m5-decisions-deck-{light,dark}.png` | Decisions: the open asks that wait on you (1 of 1 here; the tab's badge is the same number), the sheet peeking with "Your answers" and its counts |
| `m5-your-answers-sheet-{light,dark}.png` | the Decisions sheet up: Waiting to land, Routed, Acted on and Held, then where your last answers went |
| `m10-from-the-push-{light,dark}.png` | `openScreen({ screenId: "maestro", params: { hold } })`: the Feed deck opens on that hold (4 of 4, a due review) with "From the push · same hold" |

## Differences from the frames

Left, and why:

- **Work and Health keep today's body** under the same tab bar (docked, not riding a sheet) until M6 and M7 (PR 2). They are the phone's
  old compact views: the view picker, the old Feed, Fleet, Timeline, Loops, Initiatives.
- **Work has no badge** (as M1 draws it); Feed, Decisions and Health carry needs.list's and notices.list's numbers.
- **The ⋯ on the card** opens the hold's session, or says there is nothing else. Copy link and Snooze are not drawn: no clipboard call is
  known to a plugin, and a hold has nothing to snooze.
- **Answer rows in the Decisions sheet do not swipe** to Open session: `answers.status` carries no asking session for a recent answer.
- **The sheet's Decisions tiles** are Waiting to land, Routed, Acted on and Held (the frame's four). The desktop's Open tile has no phone place.
- **The old phone Decisions list** (the ledger picker and its 44 pt verbs) is gone: the deck replaces it. An ask written with no options is
  answered in words in the deck; an option that cannot be undone asks twice (first press arms, a deliberate second sends).
- **A due review's three options with their notes** are taller than the frame's, so on a short phone the deck scrolls to Answer.
- **The deck header** holds the workspace menu and presence (the desktop's menus). Choosing a presence state waits for BRO-2987, as on the desktop.
- **Fonts** are the system's, not Inter and JetBrains Mono.
- **Right swipes** are Paseo's on a phone (BRO-3033 fact 3): the deck pages left or by its segments; a sheet row's default verb is a left action.
- **No real iPhone or software keyboard** was reached (the owner checks in `device-checks.md` stand).

## The memory incident

`bun test client/plane.render.test.tsx` reached 4.8 GB in 28 s. It was not a render loop: a test that expected `view.tabs()` to equal `[]`
now found the phone's tab bar, and bun's failure diff of happy-dom elements (each holding its whole tree) ate the memory. See the PR.

# PART 2, PR 1: M6 Work, M7 Health, M8 Initiatives

Shot in the dogfood sandbox at 375x812 (`bun scripts/dogfood/up.ts --plugin "$PWD"`, `control.ts`, then `shot.ts --steps …`), light and dark, against
`m6-work-mobile.png`, `m7-health-mobile.png` and `m8-initiatives-mobile.png`.

| File | Shows |
|---|---|
| `m6-work-deck-{light,dark}.png` | Work: the work that needs you (hold line, lifecycle rails, receipts, Open session / Open the hold); the sheet peeks with 1 running · 3 queued · 0 standing · 3 done |
| `m6-work-sheet-{light,dark}.png` | the board as one list with the lane switcher; the running row wears the Undertow |
| `m7-health-deck-{light,dark}.png` | Health: the notices, stuck first, what closes each, Open session / Unblock… |
| `m7-health-sheet-light.png` | the sandbox's sheet as it was: 0 schedules, 0 lanes, "ticks: not read", "No loop or schedule is registered or observed.", the four tiles and the More rows |
| `m7-health-sheet-dark.png` | the same sheet in dark, shot later against the sandbox with its control repo: 5 schedules (4 on time, 1 off) |
| `m7-unblock-sheet-light.png` | Unblock: a text-input sheet of ours over the deck, the notice still visible |
| `m8-initiatives-light.png` | Initiatives as a page "from Health": lateness loudest, a hollow dot for no driver |
| `m8-review-undo-light.png` | a due review answered from the page (Keep): the 8 s undo toast over the page |

## Differences from the frames

- **M6 frame 3** (a running item's page with "Decided by the agent" and receipts so far): the card has the lifecycle and the session; work.get carries no decisions or receipts for it. The deck's receipts are the diff stat, checks and verdict work.list holds, or "None recorded yet".
- **M7**: the tick grid shrinks to the "Fleet ticks" number, the schedules row has no last-runs strip (the status word instead), and Snooze is not on schedule rows (notice.snooze exists for a quiet run only). Run tick now and Pause fleet are not drawn: no call exists. The sandbox has no fleet scope, so the ticks tile says "not read"; the peek says "ticks: not read".
- **M8**: Park/Close/Keep are the review hold's three answers in the card that rises over the page (the Feed's own card), not a second layout.
- **Fleet, Timeline and Loops** (the old compact views) are reached from Health's "More" rows as pages; the loop's Wake now sits on the Loops page.
- **A due notice that is quiet** was not in the sandbox's seed, so Snooze 4h was proven by the render test (`notice.snooze` sent once, the verb locked while it waits), not on screen.
- **No real iPhone, no software keyboard**: Unblock's keyboard lift is `useKeyboardLift` (BRO-3033 fact 4), tested against a fake `keyboardWillShow`; the owner checks stand.

## A defect found while dogfooding

The workspace and presence menus opened behind the deck's card on the phone (the deck's header row was not above the cards): the presence menu could not be seen, so Settings was unreachable by touch. The row now paints above them (`client/kit/deck.tsx`).

## Not driven

Swipe and Open log (the light sandbox had no schedules; the dark shot had them but a swipe cannot be dragged by shot.ts), Snooze (no quiet run in the seed), the software keyboard, and Settings (PR 2). Swipe and Snooze are covered by render tests (`notice.snooze` sent once, the verb locked while it waits) and the kit's swipe tests, not on screen.

# PART 2, PR 2: M9 New work and M11 Settings

Shot in the dogfood sandbox at 375x812, against `m9-new-work-mobile.png` and `m11-settings-mobile.png`. `shot.ts` gained one step, `type:words`,
which types into the first visible text area with real input events (`Input.insertText`).

| File | Shows |
|---|---|
| `m9-new-work-typed-{light,dark}.png` | + on the tab bar opened the sheet over the dimmed Feed deck; a brief typed with input events; Save to queue and Dispatch pinned at the foot as 52 pt pills, and the contract's pills and the first promises above. The "Who starts it" row is further down the scroll and is not in this shot (the render test reads its text) |
| `m9-saved-in-queued-light.png` | after Save to queue: the sheet closed and the work is the first row of Queued in the Feed sheet; nothing started (Running still 1) |
| `m9-dispatched-light.png` | after Dispatch on another brief: the sheet closed, the host's "Dispatched" toast over the header |
| `m9-dispatched-running-light.png` | the Work tab's board: Running 2, the new work wears the Undertow, Queued 4 |
| `m11-presence-menu-{light,dark}.png` | the presence menu opened from the deck header, with "Settings ›" at its foot |
| `m11-settings-light.png` | Settings opened from it: Presence, then Orchestration (Runs and gate, Lanes, Loops, Notices) |
| `m11-notices-light.png` | one level deep: Notices, each kind's count from notices.list (this is the notices page, shot after the Settings root) |
| `m11-lanes-light.png` | Lanes: the conductor (the loop's panel with Wake now) and "No fleet scope is configured" (the sandbox has none) |

## Differences from the frames

- **M9:** Save to queue and Dispatch are pinned; the promises include a fifth row, "If it lands nothing", that M9 does not draw (J9 does). No "Undo" on the dispatched toast: work.create has no receipt. The sheet grows by a spring from below (scale and rise), not from the + exactly.
- **M11, drawn only what has data:** Presence (read; the switch waits for BRO-2987), Runs and gate (config.get/config.set, the 8 s undo), Lanes (loop.get and fleet.get, read-only), Loops (loops.get), Notices (notices.list). **Not drawn:** Notifications, Loop and fleet (mode, caps, Fleet on), Approvals, Credentials, Appearance (no read or write behind them), Run tick (no call), Composed prompt and Propose a change (`lanes.get` does not exist). Each lane row's mode and last tick come from fleet.get, not from lanes.get.
- Settings' sub-pages use the plugin's own controls where they fit (Runs and gate is today's Settings screen inside the card).

## Not driven

The software keyboard and its lift (no iPhone; the lift is tested against a fake `keyboardDidShow`/`keyboardWillShow`), a drag-down to close, a swipe row, Snooze, Runs and gate's Save, and a prompt-free run's second Dispatch press. The sandbox has no fleet scope, so the lane rows themselves were not on screen.
