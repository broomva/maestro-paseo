# Dogfood receipt: a note on every answer, and an Other answer, on the phone (BRO-3146 phase 1)

Date: 2026-10-16, 14:20–14:40Z. Plugin under test: `683081d` (broomva/maestro-paseo#74). It was deployed live by fast-forwarding `~/broomva/apps/maestro-paseo` and running `paseo plugin reload maestro` (status `running`). Validator: broomva/workspace#1016 at `39df4d8e4`. Ticket: BRO-3146.

## Surface

| Surface | What it was | Strength |
|---|---|---|
| **The real Paseo desktop app, live daemon, at an iPhone viewport** | A hidden 402×874 `BrowserWindow`, opened in the running Paseo.app main process. The Node inspector was reached with `SIGUSR1` on :9229 and closed afterwards. The window uses the app's own `dist/preload.js` and its `--paseo-window-chrome-mode=native-mac` argument, and it loads `paseo://app/h/srv_T-uYNNfjKK-J/plugin/maestro/sidebar/maestro`. It was driven with `sendInputEvent` (real mouse clicks) and `insertText`, and captured with `webContents.capturePage()`. | The live plugin and the live daemon, in the phone layout (`compact`), as BRO-3140 ran it. **Not a device and not the native iOS app.** |
| The asking side | A single-purpose Paseo session, `claude-haiku-5-5` in plan mode (no tools). It was stamped as the origin of the fixture asks and told to echo the "In parts:" block of whatever Maestro sends it. It was archived afterwards. | It shows what an asking agent actually receives. |

**Writes:** one **fixture** ledger only, `.control/asks/bro-3146-dogfood-fixture.yaml`, with asks F1 and F2. It was untracked in a workspace worktree, so it had a checkout home: answered in place, routed at once, and no landing PR on main. It was deleted afterwards. No owner ask was answered.

## Rows

| Row | Result | Evidence |
|---|---|---|
| The fixture card on the phone deck shows its options, the **Other…** row and a note field | pass | `1-fixture-card-other-row.png` |
| F1: pick **Path B**, type a note, and Answer | pass | `2-f1-option-and-note.png`, `3-f1-answered-undo.png` ("Answered: Path B · applies in 7 s") |
| F2: pick **Other…**. Answer stays disabled until words are typed, then sends | pass | `4-f2-other-chosen-answer-disabled.png` (`aria-disabled="true"`), `5-f2-other-words.png` (attribute gone after typing), `6-f2-answered-undo.png` ("Answered: Other · applies in 7 s") |
| Written to the ledger with the typed keys | pass | below |
| Receipt and routing | pass | below |
| Arrives at the asking side, labelled | pass | below |
| **Your answers** shows the note and the Other answer | pass | `7-your-answers-note-and-other.png` |

**The ledger after the undo windows closed.** `ask_ledger.py validate --require-decision` returned 0 errors.

```yaml
  - id:            F1
    answer: "Path B: The fixture takes path B.\nOnly after the BRO-3146 demo; tell QA first."
    answer_option: "path-b"
    answer_note: "Only after the BRO-3146 demo; tell QA first."
    answered_at: "2026-10-16T14:33:30Z"
    answered_by: "owner:maestro"
    status: "resolved"
  - id:            F2
    answer: "Green, neither red nor blue (BRO-3146 Other test)."
    answer_other: "Green, neither red nor blue (BRO-3146 Other test)."
    answered_at: "2026-10-16T14:34:51Z"
    answered_by: "owner:maestro"
    status: "resolved"
```

**Receipts.** From `~/.local/state/maestro-paseo/asks.jsonl`:

```
ask.answered F1 answerOption=path-b answerNote="Only after the BRO-3146 demo; tell QA first." originAgentId=7fcbf861…
ask.routed   F1 route=delivered 14:33:30.575Z
ask.answered F2 answerOption=null answerOther="Green, neither red nor blue (BRO-3146 Other test)." originAgentId=7fcbf861…
ask.routed   F2 route=delivered 14:34:52.239Z
```

**What the asking session received.** Copied from its timeline, verbatim:

```
Your ask was answered in Maestro: "FIXTURE (a test, do not answer): which test path?" (bro-3146-dogfood-fixture.yaml F1).
The answer, verbatim:
> Path B: The fixture takes path B.
> Only after the BRO-3146 demo; tell QA first.
In parts:
- Option taken: path-b ("Path B")
- Note (read before acting; it may narrow the choice): Only after the BRO-3146 demo; tell QA first.

Your ask was answered in Maestro: "FIXTURE (a test, do not answer): which test color?" (bro-3146-dogfood-fixture.yaml F2).
The answer, verbatim:
> Green, neither red nor blue (BRO-3146 Other test).
In parts:
- Option taken: none of them. This is an Other answer: the owner's words are the decision; do not map them onto an option.
- Other: Green, neither red nor blue (BRO-3146 Other test).
```

**Your answers** (the phone sheet, "Where your last answers went"):
- "FIXTURE … which test color? — You: Other: Green, neither red nor blue (BRO-3146 Other test). · **acted**"
- "FIXTURE … which test path? — You: Path B · Note: Only after the BRO-3146 demo; tell QA first. · **acted**"

## Clean-up

- The fixture ledger was deleted. The hidden window was destroyed. The main-process inspector was closed (`inspector.close()`, and :9229 no longer answers). The receiver session was archived.
- The two `ask.answered` and two `ask.routed` lines stay in the append-only receipt log. They name a ledger that no longer exists, so no surface lists them. The log is not edited by hand.

## Not covered here

- **A device.** This ran on an iPhone-sized window of the desktop app; the owner's check on the real iPhone is still open.
- **An answer whose home is main.** That path goes through the answers batch and its landing PR. The ledger keys travel in the file the batch copies, and the routing is the same code as this checkout-home run. It was not exercised live, to avoid opening a landing PR for a fixture.
