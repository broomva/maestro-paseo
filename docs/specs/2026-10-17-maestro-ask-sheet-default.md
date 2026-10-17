# The focused ask sheet is the default way to answer (BRO-3172)

Status: draft for one frontier review, then built in the same PR. Base: maestro-paseo#78 (BRO-3167 rich asks).

## Why

The owner, 2026-10-16, on the phone: answering asks is better in the sheet that "Details, session and history" opens
(`InspectorCard`, client/kit/inspector.tsx). It has a header reading "Ask · 1 of 12", a segmented bar, collapse and ⋯,
the question as a large title, its context, the options with Rec., and Skip and Answer pinned at the bottom. Today's
Decisions tab inlines the whole answer form in a carousel ("1 of 48"). Answer needs a scroll, and the tab bar plus the
"Your answers" pull sheet take about a third of the screen.

## The change, in one line

On the phone, Decisions becomes a **dashboard of ask series**, where each row opens `InspectorCard` on that series.
Every way into an ask opens the same card, positioned on that ask within its series, and answering moves to the next
ask in the series. The card is the existing component, not a new one.

## Information architecture (phone, Decisions tab)

From top to bottom, in one scroll view:

1. **Header**: "Decisions" with the workspace and presence chips (`DeckHeader`, unchanged), and the count line
   (`decisionCountWords`, unchanged: "48 open · none waits on you · 22 ideas"). The ledger read warnings and the
   "couldn't read" alerts stay where they are.
2. **Your answers (summary row)**: one row with the four counts already in `answersCounts`: waiting to land, routed,
   acted, held. When an answer waits to land, the row is in the warn tone and carries its "Open the landing PR" pill
   (the same `stageTiles(...).landing.verb`). Tapping the row expands the existing `AnswersSheet` body (tiles plus
   "Where your last answers went") inline under it. Tapping again collapses it. It starts collapsed, except while an
   answer waits to land, when it starts open so the landing verb shows. This replaces the pull sheet on this tab only.
3. **Series rows**: one row per series (below). Each row shows the series title ("sri · lucky-mule-closeout-20261016"),
   the count line ("12 open · 2 wait on you · 3 ideas"), the age of its oldest ask ("12h"), and a "Blocking" mark when
   any of its holds blocks work. A chevron opens the series. Each row is a 56 pt minimum target with one
   accessibility label that says all of this.
4. The **tab bar** sits at the bottom edge on its own (no sheet under it), in the same band height (`TAB_BAND`).

The other tabs (Feed, Work, Health) keep their deck and pull sheet unchanged.

### What a series is

A pure function, `askSeries(cards)`, in client/phone/series-model.ts, over the Decisions cards
(`decisionCards(...)`: needs.list's holds in its order, then the other open asks by lane and age):

- An **ask hold** (`ask:<askKey>`, where askKey is the JSON of `[home, ledger, uid, id]`) belongs to the series
  `scope + ledger + home`, so two homes that share a ledger name stay apart, as `askKey` keeps them apart. Its title
  is `scope · ledgerName(ledger)`, matching the card's kicker.
- Any other Decisions hold is a **series of one**, keyed by its hold key and titled by its row title. The answers batch
  (`answers:batch`) is the exception on the dashboard: it is the "Your answers" row, never a series row of its own.
- A key that does not parse falls back to a series of one. A card is never dropped.
- Series are ordered by where their first card sits in `cards`, so the dashboard's order is the deck's order. A series'
  asks keep the order they have in `cards`.

The dashboard lists the series of the workspace the filter shows, as today. **Opening** (push, deep link, page) looks a
key up in every workspace's series, so a push for another workspace's ask still opens in its series.

## The sheet's routing

A **visit** is the state of an open sheet: `{ series, snapshot, answered }`. `snapshot` is the series' keys when the
visit started, and `answered` is the keys answered during the visit. The sheet's list is
`visitKeys(snapshot, live, answered)`: the snapshot's keys that are still live or were answered in this visit, then
any key that joined the series since, at the end. So an answered ask keeps its place: after answering 1 of 12, the
header says "Ask · 2 of 12", and it still says 2 of 12 when the undo window closes and the ask leaves the ledger read.
Segments before the current one show as done (`DetailHeader`). Past 12 asks, the segments become one thin progress
bar, so a long ledger never runs into Close and ⋯. The pinned verb bar adds the home-indicator inset (`safeBottom`).

A key is **navigable** when it is live, is not waiting out an undo window, and was not answered in this visit (or its
answer was undone, which makes it live and not waiting again).

Entry points, each of which calls `openSeriesAt(key)`:

| Entry | Today | Now |
|---|---|---|
| Decisions series row | (none) | Opens on the first navigable key of the series (else its first key) |
| Decisions: Details on a card | n/a: the inline deck is gone from Decisions | n/a |
| Feed deck: "Details, session and history" on an **ask** hold | Card at the hold, paging the Feed deck | Card at the ask, paging its series |
| Push / `params.hold` (`HomeFocus.from = "push"`) for an ask | Feed deck on the hold | Card at the ask, in its series, over the tab it lands on |
| `openDecisions(ledger, {key})` | Decisions deck at the hold | Decisions tab, card at the ask in its series |
| `openDecisions(ledger, {ledger, id})` from Initiatives (no key, plane.tsx:404, :469) | Decisions tab at its top | `HomeFocus.decision = {ledger, id}`: resolved to the one open ask with that ledger and id; if none or several match, the card opens on that ledger's series (or nothing opens, and the dashboard shows) |
| A hold that is in no series (approval, work) | unchanged | unchanged: the card pages the tab's deck as before |

Changing tab closes the card, as today. An open asked for together with a tab change is kept as pending state and
applied by an effect declared **after** the tab's close effect, so the close cannot win.

**The open ask leaving.** If the card's current key leaves the read while the card is open, and it was not answered in
this visit (it was answered elsewhere, or closed by its agent), the card moves to the next navigable key. With none,
it ends the visit, as below.

## Advance on answer and Skip

- **Answer sent** (the verb returned `sent`): the visit marks the key answered. The card moves to the next navigable key
  **after** it in the visit's list, and stays open. Nothing wraps around to earlier asks: a skipped ask is not shown
  again in the same visit.
- **Skip**: the same move, without marking the key answered.
- An irreversible answer still asks twice (`answerStep`), and a refused ask still says why and sends nothing (BRO-3111).
  Both leave the card where it is.
- The undo toast: one mount, rendered **after** `InspectorCard`, used whenever a visit is open or the Decisions tab is
  showing. It sits above the card's pinned verb bar, or above the tab bar on the dashboard. The pull sheet's own toast
  is given no entry then, so there is only ever one.
- **Undo during a visit** removes the key from `answered` (`marked(visit, key, "undone")`) and moves the card back to
  that ask, so you can answer it again.
- Swiping sideways pages only between navigable keys, toward the swipe. With none that way, it stays put.
- **A double tap** answers one ask: after the card moves on, Answer and Skip wait `MOVE_SETTLE_MS` (600 ms), so a
  second tap meant for the ask just answered never answers one not read.
- An answer that resolves after the card closed or moved acts on the card as it is then (a ref to the latest render),
  never reopening a closed card.

### End of series

When nothing navigable is after the current key, the card closes onto the dashboard and a toast says
"<series title>: nothing left to answer" (or "… 2 skipped" when skips remain). The series row has already updated its
counts from the live reads.

## What does NOT change

- **Answer semantics**: `inspector.act("answer", ...)`, the verb ledger, landing, routing, the receipts, the validator,
  `answer_note` and `answer_other` (BRO-3146), and the rich fields (BRO-3167) as `InspectorCard` already renders them.
- **The reads**: needs.list, asks.workspace, answers.status, and every count derived from them (the header badge equals
  needs.list's total).
- **Feed, Work and Health** decks and their pull sheets. **Initiatives** pages.
- **The desktop** in this PR (see below).

## Desktop

The desktop's J5 Decisions (`DecisionsView` with the ledger rail, the tiles, the stage card and Up next) has no scroll
or chrome problem at desktop widths. It was reworked today on main (#79, BRO-3170), and #79 is not in this PR's base,
#78. Desktop parity, meaning the series dashboard as the landing state, with a row opening the focused `InspectorPanel`
on that series, is a **follow-up ticket** (filed before this PR merges; the Done criteria here are the phone's) to build once #78 has merged and the base carries #79. That avoids a
three-way conflict in decision-triage.tsx and decisions-stage.tsx. This PR proves the desktop is unchanged with a
screenshot.

## Tests

- series-model.test.ts: grouping by scope and ledger, the order kept, a series of one for `answers:batch` and an
  unparseable key, `visitKeys` holding an answered key's place, `nextInVisit` skipping waiting and answered keys and
  never wrapping, and null at the end.
- shell.render.test.tsx: Decisions renders series rows and no inline answer form (no Answer pill and no options on the
  tab). Pressing a row opens the card at "Ask · 1 of N". Answering advances to "Ask · 2 of N" with the card still open.
  The last answer closes it with the end-of-series toast. Every existing Decisions and ask test stays green, adjusted
  only where it drove the inline deck on Decisions.

## Verify (P11)

The live checkout `~/broomva/apps/maestro-paseo` is on main, which this stacked branch does not contain. It is never
switched to an unmerged head: that would roll #79 back live and ship #78 before its review ends. So:

1. **Before merge:** the render tests above, plus screenshots from a throwaway build of the PR head (outside the live
   checkout) wherever the host can load one without touching the live plugin.
2. **On the deployed build:** after #78 merges and this PR is retargeted to main and merged, fast-forward the live
   checkout, run `paseo plugin reload maestro`, and drive the hidden 402×874 window at the phone viewport (dark and
   light), plus a desktop shot. Only a fixture ledger is answered, never an owner ask. Receipt:
   docs/dogfood/2026-10-17-bro-3172-ask-sheet.md.
