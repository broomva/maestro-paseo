# BRO-3036 receipts, part 2: J6–J9

Shot in the dogfood sandbox at 1480x951 (`bun scripts/dogfood/up.ts --plugin "$PWD"`, `bun scripts/dogfood/control.ts`,
then `bun scripts/dogfood/shot.ts --width 1480 --height 951 [--theme dark] --no-open --wait-for "Needs you" --steps
"Work,|Needs you: Approve STIMULUS|Health,|Initiatives|Initiative: skene|Park|Answer with|New work"`), against
`docs/design/next/j6-work.png`, `j6b-work-inspector.png`, `j7-health.png`, `j8-initiatives.png` and `j9-new-work.png`.
Part 1 (J2–J5) is in `README.md`.

| File | Shows |
|---|---|
| `j6-work-{light,dark}.png` | Work as a board: Queued, Running (the live-turn card wears the Undertow), Standing, Needs you, Done; Board / List / History, the Initiative and Provider filters |
| `j6b-work-inspector-{light,dark}.png` | a Needs you card opened: the same inspector the Feed opens (B3), from the right over the last trays, the card lit |
| `j7-health-{light,dark}.png` | Health, Overview: the verdict sentence, four tiles (fleet ticks, sessions, schedules and loops, conductor), **Open notices** each with what closes it and its verb, schedules with their run cells, sessions |
| `j8-initiatives-{light,dark}.png` | Initiatives: the four tiles, chips with counts, rows with lateness loudest (late first, longest first) |
| `j8-review-inspector-{light,dark}.png` | a due review opened in the inspector: why it is due, since the last review, work / open asks / driver session, Keep / Park / Close, where the answer goes |
| `j8-review-answered-{light,dark}.png` | the review answered (Park): "applies in 7 s" with one Undo (B4) |
| `j9-new-work-{light,dark}.png` | New work: the five promises (Deliverable, Checks, Gate, If it lands nothing, **Who starts it**: you do), the defaults line, Save to queue / Dispatch |

## What changed since part 1

- **Standing is one function.** Running work flagged quiet (`isStanding`, `runningOf` in `shared/needs-you.ts`). The Work
  badge, J1's Running tile, J6's Running and Standing trays and J7's sessions bar all read it, so no count can
  disagree. Standing is watched, never a hold (A1).
- **`notices.list`** (new, pure read, `server/notices.ts`): stuck, quiet, schedule, loop and initiative notices, each with
  a title, scope, since, what closes it and its verb. Oldest first. J1's Health section, the Health tab's badge and J7's
  Open notices are the same list, so no notice that part 1 showed is gone. The notice bands above every view are gone
  from the J screens together with J7 (the orchestrator's condition).
- **`notice.snooze`** (owner verb, 4 h, 8 s undo): `server/notice-snoozes.ts`. A snoozed notice leaves the list until its
  time is up and is counted apart (`summary.snoozed`).
- **A due review is answered in the inspector** (`initiatives.review`): keep, park or close, with your words. It is an
  owner verb, so it waits the 8 s undo window; then a receipt line (`initiative.reviewed`) is appended to the asks log
  and the review stops being due for that date. Maestro never edits the initiative's file.
- **One plan adapter.** `client/verbs.ts` gained `snooze` and `review` plans and `useVerbs().answer` (Decisions' card and
  the ideas' cards use it); the keyboard (J/K, ⌘↵, S, 1–4) lives in `client/use-inspector.ts`, shared by Feed, Work
  and Initiatives: only from inside the screen, never on a held key, one in flight per item.
- **J9.** The composer says, before you send, what the work must land to reach you; the last row says who starts
  it: you do. Dispatch starts a session now (engine.dispatch → runs.ts), Save to queue starts nothing, and Maestro never
  starts work on its own (A8). `contractPromises` in `client/composer.ts` is pure; `server/engine.test.ts` holds the row
  against both paths. The frame's "the Broomva lane … next tick (≤ 15 min)" is not said: no lane starts work yet.

## Found by a pre-review and fixed

- A notice source that cannot be read (`summary.unread`) is named; Health says "Not all clear", never "All clear", over a gap.
- The Work board says when `needs.list` or `handled.list` could not be read, instead of drawing an empty tray.
- A quiet run's notice has its own key (`quiet:<id>`), so snoozing it cannot hide the stuck notice the run may become;
  the snooze is checked again when its window closes, and Health says how many are snoozed.
- Every verb still inside its 8 s keeps its Undo on Work, Health and Initiatives (the ledger strip, not only the one toast).
- Each session is in one sessions-bar segment (an idle session that is not adopted is Unmanaged, not Idle too).
- `notices.list` names unread work (`the work`), and Health surfaces a failed `work.list`.
- `notice.snooze` only snoozes a notice that offers Snooze (a quiet run), when sent and when its window closes; the
  review answer is likewise checked again.
- An answered review no longer reads "N d late"; "work items in scope" counts work items, each once.

## Differences from the frames

Left, and why:

- **"Who starts it" names you, not the Broomva lane** (the frame's wording), and Queued says "waits for Dispatch": lanes
  do not exist yet (`lanes.get` is absent). Tied to the lanes work; the row changes when a lane can start queued work.
- **"If it lands nothing"** says what happens (Finished for you to read, Stuck in Health on a failed check), not "it
  stays Standing": Standing is running work flagged quiet.
- **The Sessions tile** counts runs (work items) and fleet sessions in two named units, not one "seen" sum.

- **Run tick now and Pause fleet** (J7) are not drawn: there is no server verb for either.
- **The Conductor tile has no lanes**: `lanes.get` does not exist; the tile says so.
- **No countdown bar on "If you say nothing"** until a timed default exists (as in part 1).
- **Standing is empty most of the time**: it holds only quiet-flagged running work, which the loop raises.
- **The workspace menu** applies on Feed, Work and Decisions; Health and Initiatives read the whole control repo.
- **A running card says phase · provider · age**: `work.list` carries no live-turn text ("Turn 4 · bun test · 40s").
- **Proposed is the open ideas**: there is no `proposed` initiative status.
- **Done** is the handled rows of the last 24 h (`handled.list`), each saying who closed it.
- **J9 is Paseo's Modal**, not a panel that grows from the button over a dimmed Feed: the plugin API gives no button
  frame to grow from (the frame names the Modal as the fallback). The scrim dims the Feed in place.
- **At 1140 px of content the five trays scroll sideways** (five 250 px trays); the inspector then covers what is under
  it rather than "the last two trays" exactly.
- **Fonts, Paseo's sidebar and window chrome** are the host's.
- **The dark header wraps** New work onto a second row when the workspace menu, presence and the loop pill all show on
  Work at this width; that is the J1 header's own wrapping.
- Dogfood: `scripts/dogfood/control.ts`'s initiatives were unreadable (no `intent_source`, drivers outside the allowed
  forms, no links or exit) and showed as none; they now pass the rules. `shot.ts` clicks an element whose label is
  exactly the step's name first ("New work", not "New workspace").
