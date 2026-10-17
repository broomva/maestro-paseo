# Dogfood receipt: the Decisions filters, on the deployed build (BRO-3170)

Date: 2026-10-16, ~21:40Z.
- **Plugin under test:** `23aa1ed` (broomva/maestro-paseo#79), deployed live by fast-forwarding `~/broomva/apps/maestro-paseo` and running `paseo plugin reload maestro` (status `running`).
- **Surface:** a hidden 1440×900 `BrowserWindow` in the running Paseo.app main process (inspector on :9229 via `SIGUSR1`, closed afterwards), loading the live plugin with the owner's real asks: 27 open, 17 ledgers. Driven with DOM clicks and `webContents.insertText`; captured with `capturePage()`.
- **Writes:** none. Nothing was answered.

| Row | Result | Evidence |
|---|---|---|
| Before: the ledger chips were one line clipped at the card's edge, with no scroll and "+9 more" | the bug as reported | `0-before-clipped.png` (the build before #79) |
| Every ledger on one line that scrolls sideways | pass | `1-rail.png`. Measured on the rail: 17 chips, `scrollWidth` 3232 vs `clientWidth` 988, `overflow-x: auto`, `flex-wrap: nowrap`; the "More ledgers" arrow shows and a scrollbar is drawn |
| The arrow moves the rail; scrolled to the end, the last ledger shows and the left arrow appears | pass | `2-scrolled-to-the-end.png`. `scrollLeft` 2244; "Earlier ledgers" present, "More ledgers" gone |
| The words filter narrows the queue, the chips and Up next | pass | `3-filtered-universe.png`. "universe" leaves "Decision 1 of 10", chips All 10 · universe-seed 7 · universe-grill-skill 3, Up next 9 |

Not covered here: the phone layout. Its Decisions deck has no ledger rail, and the filter applies only where its controls show.
Known MINORs from P20, not observed in this run:
- after a filter shifts the chips, a recorded chip position can be stale;
- no test exercises real browser layout (this receipt is that check).
