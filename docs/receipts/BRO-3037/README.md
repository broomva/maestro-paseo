# BRO-3037 receipts, PR 1: M1–M5 and the phone half of M10

Shot in the dogfood sandbox at 375x812 (`bun scripts/dogfood/up.ts --plugin "$PWD"`, `bun scripts/dogfood/control.ts`, then
`bun scripts/dogfood/shot.ts --width 375 --height 812 [--theme dark] --no-open --wait-for "Needs you" --steps "Hold 2 of 4|Details, session and history|Close|Decisions|Raise the sheet|Back to the deck|Feed"`),
light and dark, against `docs/design/next/m1-feed-home-mobile.png`, `m2-m4-briefings-mobile.png`, `m5-decisions-mobile.png` and
`m10-from-a-push.png`. The sandbox's seeded work is not the frames' (an ask first, two approvals that `git push`, two due reviews).

| File | Shows |
|---|---|
| `m1-feed-deck-{light,dark}.png` | the Feed: "Needs you" with the workspace and presence chips, one hold (an ask here, its options as 44 pt rows, the silent default), Skip and Answer as 52 pt pills, the tab bar (Feed 5, Decisions 1, Health 3) on the sheet's top edge, "Everything else" with its four counts |
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
