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

- **Maestro** in the sidebar: all work, attention first (Needs you, Running, Queued, Done; Needs you
  holds work at your gate, stuck work and work the loop flagged, the same set the header count counts),
  the unsupervised-hours scoreboard, and a detail pane with the verb each item needs. The chips
  follow the sections: each counts exactly what it shows, Stuck narrows Needs you to its stuck
  work, and Needs you, Running, Queued and Done add up to All.
- **Fleet**, a view beside History: fleet-reconcile's hourly runs per scope, with your verdict on
  what its dry run would do (see [The Fleet](#the-fleet)).
- **Timeline**, a view beside the Fleet: every scheduled session and loop on one time axis, the past
  24 hours and the next 24, with a failed or missed run in Needs you (see [The Timeline](#the-timeline)).
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

## From other sessions

Any Paseo session can operate Maestro from its shell. The plugin listens on a unix socket beside its
config, `~/.config/maestro-paseo/maestro.sock`, that only you can open, and `bin/maestro.ts` speaks
to it:

```bash
alias maestro="bun /absolute/path/to/maestro-paseo/bin/maestro.ts"

maestro ls                     # all work, what needs you first
maestro new "Persist run transcripts" --brief "Store it on the Run record." --repo ~/code/project --dispatch
maestro show <id>              # state, the look at the gate, receipts
maestro track                  # track this session as work
maestro mine                   # the work this session is running
```

- **Sessions get the noun and the verb, never the gate.** Approve, send back, unblock, cancel,
  leaving a quiet run running, settings and the loop are not served on the socket; a session that
  asks is told they are yours. A session
  starts only queued work (restarting stuck work is unblocking), and work it creates is always
  `gate: human`.
- **A session cannot write a done check.** Checks run as you, with no session and no permission
  prompt in the loop, so they come from you: add one to the work's `_work.md` (`done.check`).
- **A dispatch runs in the mode you configured.** Work a session creates carries none of the run
  choices the composer offers you (provider, isolation, mode, thinking, features), so it runs as
  Settings say. That is no more than a session can already do: Paseo's own `create_agent` tool,
  which every session holds, starts an agent in any mode.
- **A mode you chose for one work is yours to use.** A session cannot start work that carries its
  own mode: it is told "This work runs in a mode you chose; start it yourself."
- **Receipts say which session it said it was.** Everything done through the socket is recorded as
  an agent's (`actor: agent`), never yours, reads "by session 1a2b3c4d" in the receipts, and never
  counts as you stepping in on the scoreboard. The id is the `PASEO_AGENT_ID` the client reports;
  nothing verifies it, and a terminal without one is recorded as "by a session".
- **It is the surface a session is offered, not a sandbox.** A process running as you can still
  edit the work folders directly; the receipts are what keep that visible.
- **Starting runs needs one agent event first.** Paseo hands a plugin its daemon client only inside
  hooks and handlers. Until the first agent event after the plugin starts, `dispatch` and `track`
  refuse and say so. The calling session's own turn is such an event, so in practice this only shows
  right after a reload.

Exit codes: 0 done, 1 Maestro refused, 2 Maestro is not listening (or bad usage), 3 no clear answer:
the request may still have been applied, so check with `maestro ls` before retrying.

Why a socket and not a tool: plugin RPC travels over the daemon's password-protected socket, and a
plugin cannot add tools to an agent. Every session has a shell.

## The work file

`_work.md` is Maestro's work contract, field for field, so the Maestro runtime can read files
written here. Paseo keys are added beside it, and Maestro's parser ignores keys it does not know.

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
provider: claude/claude-sonnet-5  # optional: the provider, with or without a model (added)
isolation: worktree               # optional: worktree or directory (added)
mode: acceptEdits                 # optional: the provider's mode id (added)
thinking: high                    # optional: the model's thinking level (added)
features:                         # optional: the provider's feature toggles (added)
  fast_mode: true
---

# Persist run transcripts

Store the full transcript on each run so reviews do not need the live session.
```

The optional keys are what the New work composer chose. An absent one means Settings, read at
dispatch time; the Settings mode applies only while the run uses the Settings provider, since a
mode belongs to one provider. A title left blank in the composer takes the brief's first line.

Runs start only in a repository the work changes: never your home folder, the work folder, a folder
holding it, or one inside it. With `isolation: worktree` the folder must be a git repository. The
folder is checked when you create the work and again before every run starts, however it starts
(dispatch, unblock, or restarting work tracked from a session), so a hand-edited `repo:` or a
session tracked in such a folder can be recorded, but no run starts there.

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

## The loop

Off by default. Give it a period in Settings (`loopMinutes`) and Maestro wakes on that schedule to
start queued work, the way the Maestro runtime's tick does. Each wake reads the work (reconciling
sessions and applying decisions whose undo window closed), then walks the Queued group, triggered
first, then the rest, each the longest-waiting first, and starts what it can through the same
dispatch you use, recorded as Maestro's ("by the loop"), never as yours and never as a look.

- **It stops at the run cap.** The first start refused at the cap defers that work and the rest of
  the queue, "at the run cap". Work it would never start (below) keeps its own reason, before the
  cap or after it.
- **It never starts what is yours to start.** Work whose run would skip permission prompts (a mode
  that does, the work's own or Settings', or an auto-approving feature), and work you gave a mode
  of its own, are left alone with the reason. It never touches stuck work, and never stops, sends
  back, or decides anything.
- **What it leaves to you lands in Needs you.** A wake flags three things on the work itself, so
  they show in Maestro's Needs you (the feed's and the list's section, the chip, the board's
  column, the header count, `maestro ls`; one definition, `shared/needs-you.ts`) with the reason
  on the card and in the detail: queued work it leaves to you ("Start it yourself: ..."), a start
  it tried that failed ("Could not start: ..."), and a run quiet for 30 minutes or more ("Quiet for
  N minutes, worth a look"). Each flag is one `loop.flagged` receipt, written only when the work's
  current flag is not already of that kind, so a wake every minute adds nothing. Anything else
  that happens to the work (your dispatch or cancel, a turn, a state change, a note) clears it,
  and the loop does not try a failed start again until then. Waiting at the run cap is not
  flagged: that work starts when a slot frees. Flags go through Maestro and Paseo, never a desktop
  notification.
- **Quiet means the session is quiet too.** Maestro hears only turn boundaries, so a run quiet by
  Maestro's events is flagged only when its session has done nothing for as long: the wake asks
  Paseo for the session's last activity (bounded at 10 s), and a long turn that is still working
  is not flagged. A session that cannot be asked is not flagged either, and the wake says so. A
  run already flagged quiet is asked on every wake too: a session working again mid-turn sends
  Maestro no event, so when it has worked since the flag and within the last 30 minutes the loop
  takes the flag down itself ("The loop took its flag down", `flag.cleared`). That receipt is not
  a look and does not move the quiet clock; a session that cannot be asked keeps its flag. While
  the loop is off, a quiet flag clears with the next event on the work. A quiet run's notice
  offers **Leave it running**: your receipt ("You left it running", a look), which clears the flag
  and restarts the quiet clock. It is yours alone, never on the agent socket.
- **Every wake leaves a receipt.** One line per wake in `wake-log.jsonl` beside the config
  (override with `MAESTRO_PASEO_WAKE_LOG`): why it woke, what it started, what it left alone and
  why, what needs you, running work quiet for 30 minutes or more, sessions it could not ask, the
  flags it raised, and the quiet flags it took down. It keeps the newest 500 once it passes 1000 lines. The next wake is due a
  period after the last one there, so a restart keeps the cadence.
- **One wake at a time.** A wake asked for while one runs is recorded as skipped, not queued. With
  no Paseo client yet (right after a restart) a wake records that it could not start work, and the
  first client to arrive runs another, once that wake ends if it arrives while the wake still runs.
- **In Maestro.** Under the header line, a control says "Loop off", "Next wake in 12 min" or
  "Waking…". It opens the loop's panel: how often it wakes (with a press to Settings), **Wake
  now**, and the recent wakes, newest first, each with its time, its cause ("on schedule" or "you
  asked") and what it did in words. While the loop is on, the Queued section reads "The loop
  starts these on its next wake, under the run cap". Settings, Plugins, Maestro, **The loop**:
  off, or every 5, 15, 30 or 60 minutes.
- `loop.get` and `loop.wake` (wake now) are plugin RPCs for Maestro's own surfaces, never on the
  agent socket.

| The loop's panel | Needs you, with the loop's flags |
|---|---|
| ![The loop's panel](docs/loop-panel.png) | ![Needs you with flagged work](docs/loop-needs-you-feed.png) |

## The Fleet

fleet-reconcile (`skills/orchestration/fleet-reconcile` in broomva/skills) ticks hourly per scope
and writes everything to files. Its asks and alerts already reach Maestro as work at Needs you.
The **Fleet** view shows the rest, per scope, read from those files:

- **Health.** On time, failing (the newest tick exited 1, or started and never finished), missed,
  off (the fleet's kill switch), or not scheduled (no LaunchAgent runs it).
  - A scope is missed when it is scheduled and no tick has started for over 2 hours, or two of its
    intervals if that is longer.
  - The 2 hours are awake time, which is how launchd counts `StartInterval`. A laptop that naps
    between meetings ticks about once per hour awake, however the sleeps fall: a fleet that stopped
    is still missed after 2 hours awake, and a night's sleep is never a false alarm.
  - Awake time is the kernel's own count, CLOCK_UPTIME_RAW. It stops while the Mac sleeps and runs
    while its CPU does, DarkWake included, which is how launchd counts.
    - Node offers no such clock (its monotonic clock counts sleep on macOS), so the plugin reads it
      through the system perl once a minute, from the moment it starts, whether a client is looking
      or not.
    - A night of Power Nap wakes counts only those wakes' CPU seconds, as launchd's own timer does,
      and a busy moment is not mistaken for sleep.
    - Reads are shared while one is in flight, and one under 5 seconds old is reused, so client polls
      never stack reads.
    - Before the plugin's first record (a reload, a cold boot) the count starts at that record, and
      the view says "at least". A stall is then flagged 2 hours awake after the reload, never sooner.
    - A wall clock set back starts the records over.
    - If the kernel's clock cannot be read, missed ticks are judged late or not at all, never early,
      and an unfinished tick is not called dead on a guess. The view says so at once. After 5
      minutes, Needs you says so for every scheduled scope ("missed ticks unjudged"), because the
      alarm itself is down. The plugin log records when the read fails and when it recovers.
  - A tick's time budget runs on awake time too, so a tick the Mac slept through mid-run is still
    running after the wake. A tick that died days ago stays dead.
- **Asks and alerts.**
  - The open asks are every ask the newest report counts as open: those still open, those new this
    tick, and those it could not check.
  - Each links to the work the fleet recorded for its batch. The scope's open alerts link to
    theirs.
  - You answer them there, at the gate; they are never copied.
- **Would do.** These are proposals: each in-scope session whose "would do" in the newest report is
  something other than nothing, plus any verb the coordinator logged under dry run.
  - Proposals that read the same and stand the same with you are one card, and one verdict covers
    all of them: one class and one action across many sessions, all waiting or all judged alike.
    sri's 28 rows are a few decisions, not 28.
    - A session you judged differently stands in its own card, so a verdict on a card never
      overwrites one you gave a single session.
    - A coordinator verb is always its own card, its text shown.
    - Each card's verbs sit above its sessions, each session with its evidence.
  - Accept or reject each one; a reject asks for an optional note first.
  - A proposal's key binds its session, its class and its words. For a coordinator verb, the key
    binds the label and whether it adds or removes it, or the mail's template and text. So one
    verdict holds while the fleet proposes the same thing, and a verdict made on a page gone stale
    is refused rather than recorded against different words. Each line names the tick whose words
    you judged.
- **Ticks.** The last 24, each with its time, its exit and which step failed, and its class counts.
- **Report.** The newest `report.md`, drawn natively, up to 128 KB. On a phone, its tables become
  one card per row.

A missed or failing tick also shows above every other view and in the header count, so it reaches
the phone. A failing tick counts only on a scheduled scope; one run by hand was seen by whoever ran
it. When the fleet raised its own alert for the condition, it is counted there, once. That alert
is `tick-<step>` for a failed step, or `lock`, `config`, `statedir` or `tick` for ticks that never
start. The rule depends on the alert's state:

- In Needs you: counted there, and not again as a notice.
- For a failing tick, answered (done or canceled) after that tick began: already yours, so not
  counted again. Never for a missed tick: its last tick stays put while causes come and go, and an
  answer to one cause must not silence the next.
- Still queued: the notice counts, and links to it.

**Your verdicts go to the fleet, and change nothing it does.** The fleet has no verb that records a
review, so Maestro defines one file for it to read: `proposal-reviews.jsonl` beside the scope's
`ledger.jsonl`. BRO-2766 asks the fleet to read it, so its report shows each verdict.

- Each verdict is one JSON line per key, all in one append. The file is mode 0600 and fsynced, and
  the latest line for a key wins.
- Maestro writes it only where a fleet ledger is, never through a symlink or onto a file with
  another hard link.
- A short write is taken back out, so a verdict is recorded whole or not at all.
- Each line has its own `id`, and only lines of Maestro's own shape (`by: owner`, `via: maestro`)
  are read back.
- Like the ledger, it is not a boundary: any process running as you can write it.

```json
{"v":1,"kind":"proposal_review","id":"review-1791000000000","scope":"broomva",
 "key":"session:de2dd335-…:4:1a2b3c4d","verdict":"reject","note":"…","tick":35,
 "proposal":{"source":"report","action":"report","session_id":"…","class":"4",…},
 "by":"owner","via":"maestro","ts":"2026-10-02T21:00:00.000Z"}
```

Nothing else in the fleet's files is written:

- not its ledger;
- not its config, mode, dry run or kill switch.

Verdicts are yours alone, so the agent socket refuses `fleet.review`.

A state dir can be written by the fleet's sessions, so any file there is read only if it is a
regular file: never through a symlink as its last name, never with another hard link, and never a
FIFO, which is refused rather than waited on. A file that cannot be read is said in the view,
never taken for absent.

Your config and LaunchAgent are read as they are linked, but only as regular files under 1 MB and
never waited on. A LaunchAgent that cannot be read is said, and still counts as scheduled, so a
failed read never silences a missed tick.

The fleet's files are found where it keeps them:

- the config: `FLEET_CONFIG`, else `~/.config/ctx/fleet.json`.
  - A scope with a relative `state_dir` is left out, and the view says so.
  - A config caught mid-edit keeps the scopes it last named, and the view says why.
  - A config that is gone is no error: the state dirs on disk are what there is.
- the state dirs that config names.
- the LaunchAgents in `~/Library/LaunchAgents`.

For a second daemon or a test, these override the defaults:

- `MAESTRO_PASEO_FLEET_CONFIG` overrides the config.
- `MAESTRO_PASEO_FLEET_STATE` overrides where state dirs are looked for when no config names them.
- `MAESTRO_PASEO_FLEET_AGENTS` overrides the LaunchAgents folder.
- `MAESTRO_PASEO_FLEET_AWAKE_CLOCK=wall` counts awake time as wall time.

## The Timeline

The **Timeline** view puts every scheduled thing on one time axis, the past 24 hours to the left of
now and the next 24 to its right. It reads four kinds of source:

| Source | Read from | Its runs | Its next run |
|---|---|---|---|
| Paseo schedules and heartbeats | the daemon's schedule files, `<paseo home>/schedules/*.json` | each run Paseo kept, with `succeeded` or `failed` and its error | `nextRunAt`, then what its cron or interval makes of the window |
| launchd jobs (`com.broomva.*`) | `launchctl list`, `launchctl print`, the plist, the job's log, and the unified log | each run end launchd logged ("exited due to exit(0), ran for 26ms"), plus the runs its own log stamped; launchd's last exit code fills the newest | its `StartCalendarInterval`, or an interval after its newest run |
| Maestro's loop | the loop's state and its wake log | each wake, with what it did | its next wake, then every period |
| fleet-reconcile scopes | the Fleet view's own read (one reader of the fleet's files) | each tick, with its exit and failed step | an interval after the last tick |

- **One row per source.** Each row shows the source's name, its status in words beside its color,
  and how often it runs. A track shows its runs as marks: green passed, red failed, a hollow amber
  mark for a run that was missed, grey when no exit was recorded, and hollow rings for the runs
  still to come. Last and next run are in words below the track.
- **Opening a row.** Press a row for its runs in the window, why it has its status, where it keeps
  its record, and a way on: a fleet scope opens the Fleet view, the loop opens its panel, a Paseo
  schedule opens the session of its last run. A launchd job's row also shows the end of its log,
  read (`timeline.log`) only while the row is open, never sent with the view every client polls.
- **What needs you comes first.** A source is *failed* when its newest run failed: a non-zero exit,
  a signal, or Paseo's `failed`. A later run that passes puts it back on time; the red mark stays
  on the track. A run whose exit nobody recorded is *not known*, never on time, and a SIGTERM
  launchd sent itself (at logout, or an unload) stops a run without failing it.
- **When a run counts as missed.** Every grace is awake time, from the plugin's one awake clock,
  which the Fleet view counts in too (the kernel's `CLOCK_UPTIME_RAW`, which stops while the Mac sleeps).
  launchd fires nothing while the Mac sleeps, and runs a calendar job it slept through once at wake:
  - A launchd job on an interval: two intervals and 5 minutes of awake time with no run, after its
    newest run ended.
  - A launchd job on a calendar: a due time after its newest run ended, with 30 minutes of awake time
    gone since.
  - A Paseo schedule: its next run 10 minutes of awake time overdue, with no run started at or after
    it was due. A paused, completed or expired schedule never needs you, whatever its last run did:
    it will not run again on its own.
  - The loop: a wake 5 minutes of awake time overdue.
  - A fleet scope: the Fleet view's own rule.

  Each grace is judged on both bounds of awake time. A run is missed only when the least awake
  time there can have been is past its grace, and on time only when the most is within it. In
  between, the row says *not known*. That happens after a reload, for a due time before the clock's
  first record, and while the clock cannot read the kernel.
- **A read that fails is said, never read as healthy.** A command that exits non-zero, or a plist
  that will not convert, is a warning in the view and costs only what it would have said.
- **A miss is judged only on what was seen.** The launchd reader keeps one stretch the unified log is
  proven to have held. Each read asks the log for the first launchd event at or after where the read
  starts. Only when that event is no later than where the last read ended (the log still held it)
  does the read extend the stretch; a gap the log no longer holds starts it again at what the log
  holds now, and a probe that fails changes nothing until the next read proves the same range. Run
  ends and the stretch are kept to one horizon, eight days, so the stretch never reaches back past
  them. A job is proven loaded from the first read that saw it loaded, again after a read finds
  its unload in the log (`removing service: <label>`), and again whenever the stretch starts over. A
  run is called missed only if it came due inside the stretch, after the newest run ended and since
  the job was proven loaded. A due time after the newest run that falls before judging could start
  (the plugin's first read, a reload, a gap) is never called missed and never read as on time: the
  row says it is not known until the next one.
- **In Needs you.** A failed or missed source shows above every other view, with *Open Timeline*,
  and counts in the header count, so it reaches the phone. Fleet scopes are counted once, by the
  Fleet view's notice or the fleet's own alert work, and never again by the Timeline. The launchd
  job that runs a fleet scope's ticks is shown as that scope. If the Fleet view cannot be read (or
  does not know that scope), it is shown as a plain launchd job and counted like one, so a failure
  is never hidden for want of the Fleet view.
- **On the phone.** The Timeline is one of the views a compact window offers. Its axis labels every
  12 hours there, and every 6 on a wide window.

| The Timeline | On the phone, a row open |
|---|---|
| ![The Timeline](docs/timeline-view.png) | ![A failed run, opened, on the phone](docs/timeline-phone.png) |

It only reads. Every command goes through a guard that runs `launchctl list`, `launchctl print`,
`plutil -convert json -o -`, `log show` and `ps -o etime=` and refuses anything else, so it can
never load, unload, kickstart or kill a job. It never starts, pauses or edits a schedule.

The unified log costs a few seconds to search, so launchd is read in full once (a day back), then
only from where the last read ended. The view reads it at most once a minute and the header count
once every five, and the header count never waits on it more than two seconds.

For a second daemon or a test:

- `MAESTRO_PASEO_SCHEDULES` overrides the Paseo schedule folder (else `$PASEO_HOME/schedules`, else
  `~/.paseo/schedules`).
- `MAESTRO_PASEO_LAUNCHD` names another label prefix (letters, digits, `.`, `_`, `-`), or `off` to
  read no launchd job. Anything else reads none.

## The agent's instructions

The receipt of each dispatch, and the detail pane, say how the agent was started: provider, mode,
thinking level and features.

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
- The agent socket is mode 0600 in your config folder, and serves only the verbs above.

Choosing a permissive provider mode (for example `bypassPermissions`), per work in the composer or
for all runs in Settings, is what makes runs unsupervised; it is off by default.

## Configuration

Stored at `~/.config/maestro-paseo/config.json` (override with `MAESTRO_PASEO_CONFIG`), edited from
Settings. The agent socket sits beside it (override with `MAESTRO_PASEO_SOCKET`), so a second daemon
with its own config gets its own socket. Two daemons on the same config share one: the first to open
it answers, and the other keeps retrying every ten seconds, which its plugin log says once.

| Key | Default | Meaning |
|---|---|---|
| `workRoot` | `~/maestro` | Where work folders live |
| `provider` | `claude` | Provider, optionally with a model: `claude/claude-sonnet-5` |
| `modeId` | none | Provider mode for runs; empty means the provider default. It applies only while a run uses the Settings provider: work that chose another provider starts in that provider's default mode |
| `isolation` | `worktree` | `worktree` for a fresh branch per run, `directory` to run in the repo |
| `loopMinutes` | none | How often the loop wakes to start queued work, in whole minutes from 1 to 1440 (a day); empty means off |

## Development

```bash
npm install
npm run check      # tsc, Biome, bun test
```

`@getpaseo/plugin` is a development dependency for types only; the host supplies it at runtime.
It is pinned to 0.8.0 so one build serves 0.8 and 0.9 hosts.

## Limits

- Hook events are live and best effort. Every list reconciles bound work against the agent's real
  status, so a turn end missed while the plugin was stopped is recovered on the next look. A
  recovered end reads the session's timeline for its real outcome, is stamped when the agent
  actually stopped, and always lands at your gate: work never closes itself on an end Maestro did
  not see. A correction is dropped if anything was recorded after reconcile looked.
- The scoreboard counts from state changes in the event log; a run started before the plugin was
  installed does not appear until it is tracked.
- Cancel does not stop or archive the Paseo session. Stop it from the session if it is still
  working.
- The Timeline sees what the Mac and the daemon keep, nothing more:
  - A cron a Claude session made for itself lives only in that session, so it is not shown. The
    coordinator's :13/:43 tick is one.
  - launchd keeps no run history of its own, and the unified log holds about a day of run ends.
    Run ends read are kept for eight days; a run older than that, or one before the log's reach, is
    known only if the job stamps its own log.
  - A job whose log carries no timestamps shows its last run at the time the log was last written.
  - A launchd job's calendar is read from its plist on disk: one edited but not yet reloaded is
    judged on its new times.
  - A calendar a plist gives that this cannot read (a value out of range) is said in its cadence, and
    its runs are neither drawn nor judged.
  - A launchd calendar is read in the daemon process's time zone, which is the Mac's own unless the
    daemon was started with `TZ` set; launchd itself always uses the Mac's.
  - With the Mac's awake time unreadable from the start (no record at all), nothing overdue is called
    missed: the rows say *not known* and the view says why. Needs you hears of it from the Fleet
    view's notice, which needs a scheduled fleet scope; the Timeline raises none of its own.
  - On the night the clocks go back, a calendar job in the repeated hour is due twice by the wall
    clock; if launchd runs it once, the second can read as missed. Bogotá, with no daylight saving,
    is not affected.
