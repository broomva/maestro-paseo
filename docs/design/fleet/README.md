# Fleet tab redesign drafts (BRO-2833)

The source is `../fleet-redesign.pen` (open it in Pen). The PNGs in `export/` are renders of its frames, and `live/` holds what the Fleet tab looked like on the real Paseo app on 2026-10-05, captured read-only.

| Frame | PNG | What it is |
| --- | --- | --- |
| 0 · Today | `export/0-today-diagnosis.png` | The live tab with nine numbered findings, and where its 5,958 px go |
| A · Cockpit (recommended) | `export/a-cockpit-dark.png`, `-light.png`, `-phone.png` | Status first: scope, health strip, KPI tiles, Needs-you queue with verbs, sessions roster with a row menu |
| B · Roster + inspector | `export/b-roster-inspector.png` | Master–detail. Recommended as the side sheet a session row opens, not as the whole page |
| C · Decisions triage | `export/c-decisions-triage.png` | The 49 workspace decisions in their own tab, one at a time, keys 1–3 / Enter / S |
| D · Recommendation | `export/d-recommendation.png` | Finding → fix map, the backing for every verb, the five health states, and the motion spec |

## What the live tab gets wrong (frame 0)

1. It opens on 49 workspace decisions, which are not the fleet's. Fleet health starts about 1,100 px down.
2. The scope switch (broomva / sri) is buried mid-page.
3. There is no summary of the fleet: run states exist only as a class table inside report.md.
4. Dry-run verdicts "change nothing", yet "Accept all 5" is the loudest button on the page.
5. Twenty-four tick rows all say Passed.
6. report.md is rendered inline in full.
7. There are no operating verbs for sessions or the fleet.
8. Seven equal tabs; at phone width they clip.
9. The type is flat: 12–13 px gray throughout.

## Verbs and their backing

The `exists` verbs map onto RPCs the plugin already serves:
- `work.verdict` on the ask's item
- `fleet.review`
- `work.adopt`
- `fleet.tick`
- `ask.answer`

The `new` verbs need the Paseo agent API: Send a prompt, Stop and Archive.

The two `your call` verbs both cross the read-only rule at the top of `server/fleet.ts` ("Nothing here runs a fleet verb… or changes its kill switch"). They are:
- Run tick now (`launchctl kickstart`)
- Pause fleet (the kill switch)

Neither gets built without an explicit owner decision.

## Data

Most of the copy is from the live fleet on 2026-10-05: the asks, sessions, tick 108 and the decision text. These are illustrative only:
- The late sri cell in the health strip.
- The KPI split (2 running, 5 idle). It is a plausible mapping of the report's classes, not a computed one. The real mapping (class → running/idle/failed/unmanaged) is a build decision.
- The progress figure "Decision 12 of 49".

The blocking count (2, both in `checkit-ax-substrate`) was read from the ledgers.
