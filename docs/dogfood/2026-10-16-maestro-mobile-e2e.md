# Dogfood receipt: Maestro on the phone, end to end (BRO-3140)

Date: 2026-10-16, 03:20–04:20Z. Plugin under test: `e7507c5` (broomva/maestro-paseo#71), deployed live. Ticket: BRO-3140. Folded tickets: BRO-3112, BRO-3111, BRO-3094 (phone), BRO-3103.

## Surface

| Surface | What it was | Strength |
|---|---|---|
| **The real Paseo desktop app, live daemon, at an iPhone viewport** | A hidden 402×874 `BrowserWindow` opened inside the running Paseo.app main process (inspector on :9229 via `SIGUSR1`). It uses the app's own `preload.js` and window-chrome argument, and loads `paseo://app/h/<server>/plugin/maestro/sidebar/maestro`. Captured with `webContents.capturePage()` and driven with `sendInputEvent`: real mouse clicks, drags and wheel. | The live plugin and the live daemon on the owner's data, in the phone layout (`compact`). **Not a device and not the native iOS app.** RN-web at an iPhone width, not React Native on iOS. |
| iOS simulator | Not used. The coordinator capped disk (no runtimes, no app builds), and the Paseo iOS app is not installed. | n/a |

Writes: one real, low-stakes answer, `ideas-fleet-autonomy.yaml` I1 → **park** (nothing runs; the idea comes back on 2026-11-02, its own wake date). It landed through broomva/workspace#1015. Nothing else was answered, dispatched or changed.

## Root cause, from the live daemon (03:20Z, before the fix)

- `asks.workspace` returned 33 decisions, 23 of them open, and **every open one was an `idea`**. `needs.list` held no ask (its two rows were owner steps, the Feed's "2").
- The phone kept only `isTriaged` asks (`open && !idea`), so every idea was dropped from the deck and from the sheet's "Open, not blocking". The deck said "No decision waits on you" (`before-decisions-live.png`, identical to the owner's iPhone).
- It was not a scope filter, a control-repo error, a read failure or a layout problem.
- `ask_ledger.py open` lists **44**. It filters on `answered_at` alone and so counts resolved and archived asks; its own `is_closed()` gives 25. Two of those 25, `bro-2827` `answers-pr-auto-merge` and `status-quo-key`, are answered in worktree `bro-2827-asks`, so under the §5.2 home rule Maestro rightly shows them closed.

## Rows

| Row | Result | Evidence | Notes |
|---|---|---|---|
| (a) Deck count equals the open asks in the ledgers | **pass** | `a-decisions-deck-28-open.png` | "28 open · 1 waits on you · 23 ideas" at 04:01Z. Reconciliation follows the table. |
| (b) One idea answered "park" end to end | **pass, with one gap fixed in this PR** | `b1-idea-card-labelled.png`, `b2-idea-park-chosen.png`, `b3-answered-undo-toast.png` | Details follow the table. |
| (c1) Feed badge opens its items | pass | `c1-feed-badge-4.png` | Badge "Feed, 4"; deck "1 of 4". |
| (c2) Decisions badge opens its items | pass | `c2-decisions-badge-2.png` | Badge "Decisions, 2" = its two holds, first on the deck ("2 wait on you"), followed by every other open ask. |
| (c3) Health badge opens its items | pass | `c3-health-badge-11.png` | Badge "Health, 11"; deck "1 of 11". |
| (c4) A notice card opens its detail (BRO-3103) | pass | `c4-health-notice-detail.png` | "Details, session and history" opens M4: log, Closes when, session, Open session / Unblock. |
| Undo on the phone (BRO-3101) | pass on the phone | `b3-answered-undo-toast.png` | The phone shows the Undo it promises. BRO-3101's missing Undo is the desktop J5 line only. |

**(a) How 28 reconciles:**
- 25 strictly open in the main checkout's ledgers;
- −2 bro-2827 asks answered in worktree `bro-2827-asks` (§5.2);
- +2 `skene-closeout.yaml` asks open in worktree `ws-skene-closeout-asks`;
- +3 SRI fleet-scope asks.

The set difference was computed ask by ask against `asks.workspace` and is empty after those four adjustments. Live data moved during the run: new SRI and skene asks arrived between 03:20Z and 04:01Z.

**(b) The park answer, step by step:**
- **The card.** It wears the **Idea** label, with Develop / Park / Kill as 44 pt rows.
- **Answer.** Pressing Answer showed "Answered: Park until 2026-11-02 · … **Undo**" (8 s) and moved the deck on.
- **Written.** `maestro/answers` gained commit `7c85ce2 answer(ideas-fleet-autonomy.yaml): I1 -> park`, with `wake: "2026-11-02"` (the round-1 P20 fix: the phone sends the wake Initiatives sends).
- **Batched.** The 04:06:48Z wake said "1 answer waits to land: PR #1015".
- **Landed.** workspace#1015's gates were all green (Hold, Deletion, Merge, Control Metalayer Audit, test-lock), and it merged pinned as `a7ec73c`.
- **Routed.** The 04:18:19Z wake recorded "landed #1015" and routed it: "Your answer to I1 (ideas-fleet-autonomy.yaml): Acted on: nothing to do. An idea's answer files its own work: develop files it, park and kill need none."
- **The gap.** `answers.status` excluded ideas (`!ask.idea`), so the parked idea never appeared under **Your answers**. That rule predates ideas being answerable from the deck. This PR drops it: an idea's answer is counted while it waits to land and listed where it went.

## Anti-rationalization check

- Did I drive the real plugin against the live daemon? **Yes**: the Paseo.app renderer and the owner's daemon on 6767.
- On a device? **No**: an iPhone-sized window of the desktop app. The owner's 2-minute check on the real iPhone is in BRO-3140.
- Was anything inferred rather than observed? The "28" reconciliation was computed from `asks.workspace` and the ledgers at 04:01Z, minutes after the screenshot. The deck itself was not re-counted against a frozen snapshot.
