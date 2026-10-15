# BRO-3036 receipts, part 1: J2–J5

Rebased onto BRO-2999 (#59): an answer, an allow and a cancel all wait 8 s with one Undo, from `verbs.list`. Shot in the dogfood sandbox at 1480x951 (`bun scripts/dogfood/up.ts`, then `bun scripts/dogfood/control.ts` for the
control repo's asks, then `bun scripts/dogfood/shot.ts --width 1480 --height 951 [--theme dark]`), against
`docs/design/next/j2-j4-briefings.png` and `j5-decisions.png`. Part 2 (J6–J9) lands in its own PR on this ticket.

| File | Shows |
|---|---|
| `j2-approval-{light,dark}.png` | an approval in the Feed's inspector: the action, **Held by**, the evidence the daemon has, After you allow, **If you deny**, Session |
| `j3-ask-{light,dark}.png` | an ask: What waiting costs and Why you as two tiles, numbered answers (Recommended named), if you say nothing, **Add words**, where the answer goes, Skip and **Answer with N** |
| `j4-notice-{light,dark}.png` | stuck work as a notice: Closes when, a prompt field, the "no Approve" note, **Cancel work…**, Open session, **Unblock with a prompt…** |
| `j5-decisions-{light,dark}.png` | Decisions with an answer waiting to land: order and ledger chips, the four tiles (Waiting to land warn-tinted), the decision at full width, Up next, Where your last answers went |
| `j5-decisions-blocking-light.png` | the same tab with the blocking ask on stage (its banner says why it waits on you) |
| `j5-answer-queued-light.png` | an answer given: it waits out its 8 s undo window (B4), so the line says "written in 8 s unless you undo it" and the surface's pending strip counts it down with one Undo; the batch tile and the rail already count it |

## What changed since J1

- **The inspector bodies are the frames' bodies.** An approval says what held it and what each answer does; an ask
  carries its cost, why it is yours, numbered answers, your words and where the answer goes; a notice carries what
  closes it, a prompt for the session, and Cancel work… (two presses: the first arms it for 5 s).
- **Words travel with the verb.** `planVerb(verb, target, choice, words)`: an answer sends the option and your words in
  one `ask.answer`; your words alone are an answer too; an option that cannot be undone still opens Decisions to
  confirm; Unblock sends the prompt as its note. An empty answer is never sent.
- **J5 is the Decisions tab on the desktop.** The phone keeps the list's own shape (BRO-3037 owns it). The decision is
  J3's inspector body at full width, driven by the card's own logic (`useDecisionCard`): the deliberate confirm for
  an irreversible option, one answer in flight, the keys (1–4, ↵, S, J, K) only while focus is inside the tab.
- **`answers.status`** (new read, `server/answers-status.ts`): the batch waiting to land, and of the answers Maestro
  holds a receipt for, how many are routed, acted on, or held for the conductor, with the latest five.
- **No notice band above a J screen.** The launchd and loop bands (`work.attention`) sat above every view; J5 says what
  it watches in its own tiles, and Health (J7, part 2) takes the rest.

## Differences from the frames

Left, and why:

- **Evidence tiles.** J2's P20, Review bots and Reversible tiles need data `needs.list` does not carry; the tiles show
  what the daemon has (Asks, Ran, Arc, Checks, Diff), as J1. "What changes" (the PR's own description) is not read.
- **"After you act" / "After you allow".** J1 and J6b label the list "After you allow"; J2 labels it "After you act" with
  Allow: and Deny: lines. This build keeps J1's label and puts Deny's line under "If you deny".
- **No countdown bar on "If you say nothing".** The bar draws from `default.appliesAt`, and no ask has a timed default
  yet (A4); the ledger's own default is said in words. The kit draws the bar as soon as a row carries one
  (`fallbackOf` is tested with a timed default).
- **Nothing is pre-chosen on J5.** The frame draws the recommended answer checked; Decisions has always left the choice to
  you, and the Answer verb waits for it. The Feed's inspector pre-chooses the recommendation, as J1 does.
- **Snooze is not drawn** on an ask. `notice.snooze` and its store do not exist yet; it lands with Health's notices
  (J7, part 2).
- **J4's evidence log** shows the one line the daemon carries for stuck work ("Checks failed"), not the run's last
  lines: `work.list` has none.
- **Acted on** counts over the answers Maestro holds a receipt for (`window` says how many), not "41 in all". One
  answered elsewhere has no fate and is in no count.
- **Waiting to land** is the landing's own count or the answers already listed as batched, whichever is larger: the
  landing is as old as its last check, and the tile must not say everything landed while the rail below says an answer
  waits. Its verb, Open the PR, opens the link and never merges; with no PR yet there is no verb.
- **"Recently answered"** (the old fold) is replaced by the rail. Answers to a fleet scope's own asks are the fleet's
  to act on and are not in `answers.status`.
- **Paseo's sidebar, header and window chrome** are the host's, as in J1's receipts.
- **Fonts** are the system's, not the frame's Inter and JetBrains Mono.
