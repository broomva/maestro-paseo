# BRO-3035 receipts: J1 Feed home and Maestro's header

Shot in the dogfood sandbox at 1480x951 (`bun scripts/dogfood/shot.ts --width 1480 --height 951`), light and dark, against `docs/design/next/j1-feed-home.png`.

| File | Shows |
|---|---|
| `j1-light-closed.png`, `j1-dark-closed.png` | the home with the inspector closed: header, scope bar, four tiles, Needs you, rail |
| `j1-light-inspector.png`, `j1-dark-inspector.png` | a card opened: the inspector from the right, the card lit in the stream, the rail gone until it closes |
| `j1-light-tall.png` | the rest of the column: Health, Running (Undertow), Queued |
| `j1-presence-menu.png` | the presence pill's menu (P1) |
| `j1-workspace-menu.png` | the workspace menu |

## Differences from the frame

Fixed in this PR: the header is one row at the sandbox's width (the search field shrinks first); the inspector starts below the tiles and the main column makes room for it instead of sliding under its verbs.

Left, and why:

- **Paseo's sidebar** is the host's, not drawn by Maestro (R0). The frame shows pinned sessions and workspaces; the sandbox has its own.
- **Allow merge.** The frame's primary names the action. Maestro names it when the action is `gh pr merge` or `git push`; any other action says Allow (the sandbox's actions are `git push` and a gate close).
- **Running tile rows** read `scope · phase` ("observability · working"). The frame's `turn 4 · bun test` needs the session's live turn, which work.list does not carry.
- **The next wake** reads `loop off` here: the sandbox's loop is off. With a loop it reads `18 min`.
- **Asks** that wait on you are rows in Needs you (so its length is needs.list's total, the header's number); the frame draws them in the rail's Decide. The rail's Decide holds the open asks that do not wait on you.
- **Finished** (Change course, Continue) is empty until BRO-2999 turns work at review with nothing held into Finished; its rows then show Open, and Continue and Change course once `session.prompt` exists.
- **Presence** shows the three states and "from signals"; choosing one lands with BRO-2987 (presence.get and presence.set do not exist yet), and the menu says so.
- **Inspector history** and the evidence tiles (Checks, P20, Diff, Reversible) are empty: the approval body the server builds today carries only the facts it has.
- **Fonts** are the system's, not the frame's Inter and JetBrains Mono (paseo-plugin-capabilities.md).
