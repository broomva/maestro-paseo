# BRO-3008: Maestro cards in Paseo sessions, dogfooded in the sandbox

`bun scripts/dogfood/up.ts --plugin .`, `control.ts` (an ask stamped with `origin.agent_id` of the second session),
then `bun scripts/dogfood/cards.ts --out <dir> [--theme dark]`: real Chromium against the throwaway daemon, real
stand-in sessions paused on `git push`. Ids in the run are in their real shapes: the Paseo agent id, the work id and the permission request id are three different strings.

| File | What it shows (frame) |
| --- | --- |
| 01-approval-card-desktop/phone | The session that asked, the Approval card at its tail: the exact action, what held it, Allow push + Deny + Open in Maestro (K0 step 2, K1) |
| 02-session-b-cards-desktop | A session with two cards: an Ask (options, recommended chosen, Answer) and an Approval (K1 column 1) |
| 03-session-page-desktop/phone | Open in Maestro landed on `…/plugin/maestro/surface/session?param.agentId=<agent id>`: K2, identity, the same card under Holds, work, history, controls |
| 04-undo-window | Allow → the ink capsule "Allowed git push origin HEAD · takes effect in 7 s" with Undo, in place (K1 "After you act", K0 step 3) |
| 05-undone | Undo took it back: the hold stands again with its verbs |
| 06-receipt | Allow again, 8 s later: one line "Approval · receipt — Allowed git push origin HEAD · took effect" (K1) |
| 07-feed-allow | The other session's hold is allowed from Maestro's Feed (J1), in another page |
| 08-card-shows-the-feed-decision | That session's own card, already counting the same window down, with Undo (no refresh: it reads the ledger live) |
| 09-card-receipt-after-feed | …and its receipt once the window closed |

Dark: `*-dark.png` for 02, 04, 06, 08.

Bugs the run found, both fixed with a test that fails without the fix: Undo pressed while the verb's own reads were
still landing was dropped (Allow and Undo shared one in-flight claim); on the phone the evidence line and the K2 title
were clipped.
