# Maestro for Paseo

Maestro as a Paseo plugin. Work is the noun: a folder with a `_work.md` contract. Sessions are
the verb: each dispatch is a Paseo agent in its own worktree on a `run/<id>` branch. The human's
one verb is the gate: a finished run lands at **Needs you**, and nothing under a human gate is done
until you approve it.

![Needs you, with the look at the gate](docs/needs-you-default-theme.png)

## Why a plugin

Maestro's design has three tiers: a 24/7 runtime that owns files, git and agent children; a relay;
and a client for web, desktop and mobile. Paseo already is all three. Its daemon runs agents in
worktrees, its relay reaches the host from anywhere, and its app runs on desktop, browser, iOS and
Android. What Paseo does not have is the work noun, the gate, and receipts. This plugin adds exactly
those, and nothing Paseo already does.

| Maestro concept | Here |
|---|---|
| Work item | A folder under the work root with `_work.md` and `_events.jsonl` |
| Dispatch | `workspaces.create` (worktree, branch `run/<id>`) plus one labelled agent |
| Run lifecycle | Paseo lifecycle hooks: turn started or ended, permission asked or answered, archived |
| Verifier | `done.check` commands, run in the run's worktree when a turn ends |
| The gate | Approve, send back with a note, or cancel |
| Receipts | The event log, rendered newest first |
| Unsupervised hours | Time spent running today, with a mark for every time you stepped in |

## What you get in Paseo

- **Maestro** in the sidebar: all work, attention first (Needs you, Stuck, Running, Queued, Done),
  the unsupervised-hours scoreboard, and a detail pane with the verb each item needs.
- **Work** panel beside any agent: the work it is running, or a button to track it.
- **Command Center**: *Open Maestro*, and *Track this session in Maestro* on an agent.
- **`/maestro [title]`** in the composer: track the current session as work.
- **Broomva light** and **Broomva dark** under Settings, Appearance. Every surface takes its colors
  from the active theme, so Maestro follows any Paseo theme.
- **Settings, Plugins, Maestro**: work folder, provider, mode, and isolation.

| Broomva light | Broomva dark |
|---|---|
| ![Receipts](docs/receipts-broomva-light.png) | ![Checks](docs/checks-broomva-dark.png) |

## Install

Requires Paseo 0.8 or later, with plugins enabled on the daemon.

In the app, open **Settings, Plugins** and paste the absolute path of this directory as the plugin
source. Or from a terminal that can reach the daemon:

```bash
paseo plugin install /absolute/path/to/maestro-paseo
paseo plugin ls            # expect: maestro  running
```

After editing the source: `npm run typecheck`, then `paseo plugin reload maestro`.

## The work file

`_work.md` is Maestro's work contract, field for field, so the Maestro runtime can read files
written here. Two keys are added beside it, and Maestro's parser ignores keys it does not know.

```markdown
---
id: b6a9b360-3575-4bc3-a1c4-3c00758dd3cd
kind: task
state: review
gate: human
done:
  check: bun test
created: 2026-09-22
updated: 2026-09-22
repo: /Users/you/code/project     # where runs happen (added)
provider: claude/claude-sonnet-5  # optional per-item override (added)
---

# Persist run transcripts

Store the full transcript on each run so reviews do not need the live session.
```

Folders nest: `<root>/<initiative>/<project>/<item>/_work.md`. The nesting is the grouping.
Edits keep the author's comments and key order. `_events.jsonl` is append-only. A file that does
not parse shows as a warning in the list; it is never silently skipped.

## States and the gate

The eight system states are Maestro's; the UI speaks the six plain labels.

| System | Shown as | Means |
|---|---|---|
| proposed, reviewing, triggered | Queued | Ready when you dispatch it |
| running | Running | Live in a worktree; checks run when the agent stops |
| review | Needs you | Waiting at your gate, or the agent asked a question |
| blocked | Stuck | The turn failed, was stopped, the checks failed under an auto gate, or the session went away |
| done, canceled | Done | The branch is the receipt |

- **gate: human** (the default): a finished run always lands at Needs you, whatever the checks
  say. Only Approve moves it to Done.
- **gate: auto**: requires a check. Passing checks close it; failing checks leave it Stuck.
- **Send back** wakes the same session with your note. **Unblock** does the same for stuck work,
  or starts a fresh run if the session is gone.
- A **permission request** parks the item at Needs you as a question. Answer it from Maestro or
  in the session; the run resumes.

Two edges differ from the Maestro runtime because Paseo owns execution: review can return to
running (send back, answered question), and queued or stuck work can be canceled directly. Both
are documented in `shared/states.ts`, and the invariant that matters is kept exactly: nothing
under a human gate reaches Done without an approve verdict.

## The agent's instructions

Each dispatch sends the title, the brief, the checks, and three rules: commit on the run branch,
do not merge or push unless asked, and end with `## Decided` and `## Ask` sections. Those two
sections become the look at the gate. If the agent skips them, the gate still works; the look
just says less.

## Security

Plugins are trusted code that runs unsandboxed on the daemon host. Two choices here narrow what
this one does:

- Checks run in the run's worktree with a minimal environment (`PATH`, `HOME`, locale, `CI=1`),
  never the daemon's. An agent that edits a test script cannot read the daemon's credentials
  through it.
- The plugin never merges, pushes, or deletes branches. The branch is the receipt; landing it is
  yours.

Choosing a permissive provider mode (for example `bypassPermissions`) is what makes runs
unsupervised; it is off by default.

## Configuration

Stored at `~/.config/maestro-paseo/config.json` (override with `MAESTRO_PASEO_CONFIG`), edited from
Settings.

| Key | Default | Meaning |
|---|---|---|
| `workRoot` | `~/maestro` | Where work folders live |
| `provider` | `claude` | Provider, optionally with a model: `claude/claude-sonnet-5` |
| `modeId` | none | Provider mode for runs; empty means the provider default |
| `isolation` | `worktree` | `worktree` for a fresh branch per run, `directory` to run in the repo |

## Development

```bash
npm install
npm run check      # tsc, Biome, bun test
```

`@getpaseo/plugin` is a development dependency for types only; the host supplies it at runtime.
It is pinned to 0.8.0 so one build serves 0.8 and 0.9 hosts.

## Limits

- Hook events are live and best effort. Every list reconciles bound work against the agent's real
  status, so a turn end missed while the plugin was stopped is recovered on the next look.
- The scoreboard counts from state changes in the event log; a run started before the plugin was
  installed does not appear until it is tracked.
- Cancel does not stop or archive the Paseo session. Stop it from the session if it is still
  working.
