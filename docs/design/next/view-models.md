# Maestro next: the data each screen reads (BRO-3001)

This is the contract between the server and the J (desktop) and M (phone) screens in
`maestro-next.pen`. It says what each screen shows, which interface supplies it, and what is
new. The per-screen table uses `inventory.yaml`'s ids, and a test keeps the two in step. The owner's decisions it applies:

| Decision | Effect on the data |
|---|---|
| A1 (kinds) | Needs you is only ask, approval or owner step. Everything else is watched |
| A4 (reversible asks take their default after 30 min) | An ask row carries its default and the time it applies |
| A8 (the plugin never starts work) | No read or verb here launches a session. New work queues; a lane starts it |
| B2 (a due review is an Ask) | An initiative review arrives as an `ask` row with an initiative body |
| B4 (undo is 8 s) | Every owner verb returns `applies_at = now + 8 s` and can be undone until then |

## Two projections, then per-domain reads

`needs.list` and `handled.list` are computed once on the server (BRO-3001). Every count, badge,
tile, deck and push reads them, and nothing recounts on the client. The other screens read
their own domain (`work.list`, `fleet.get`, `loops.get`, `lanes.get`, `initiatives.list`,
`presence.get`). There is one React Query hook per interface, invalidated on plugin events.

### `needs.list` → `{ rows: NeedRow[], summary: NeedSummary }`

```ts
type NeedKind = "ask" | "approval" | "owner_step";

interface NeedRow {
  kind: NeedKind;
  key: string;                 // stable; openScreen and the session card address the hold by it
  title: string;
  scope: string;               // workspace or lane, e.g. "broomva", "sri"
  ticket?: string;             // "BRO-2953", "STI-3587"
  session?: { agentId: string; name: string; waiting: boolean };
  since: string;               // ISO; when it started waiting
  blocksWork: boolean;         // something stops until it is answered
  verbs: Verb[];               // the kind's verbs only: Allow/Deny, Answer/Skip, Done/Not now
  body: ApprovalBody | AskBody | OwnerStepBody | ReviewBody;
}

interface AskBody { why: string; cost: string; options: Option[]; recommended?: string;
                    default?: { option: string; appliesAt: string }; goesTo: string }
interface ApprovalBody { action: string; heldBy: string; evidence: Evidence[]; after: string[] }
interface OwnerStepBody { where: string; doneCheck: string; waitingSessions: number }
interface ReviewBody extends AskBody { initiative: string; intent: string; since: string[];
                                       hanging: { work: number; asks: number; driver?: string } }

interface NeedSummary {
  total: number;               // == rows.length == header badge == push count (test)
  byKind: Record<NeedKind, number>;
  oldest?: { key: string; since: string };
}
```

**Deck and list order:** `blocksWork` first, then the earliest `default.appliesAt`, then `since`,
oldest first. The phone deck, the desktop Needs you section and Decisions all use this order,
so "1 of 4" means the same thing everywhere.

### `handled.list` → `{ rows: HandledRow[], today: { closedForYou: number; byYou: number; asksAnswered: number } }`

Each `HandledRow` is `{ key, title, closedBy: "gates" | "you" | "orchestrator" | "maestro", reason, at }`.
It feeds the Handled for you rail, the "Handled today" tile, and Done's who-closed chips.

### As built (BRO-3001)

`shared/needs.ts` is the wire, `server/needs.ts` the projection, `index.server.ts` the two handlers.
Where each hold comes from today:

| Kind | Source | Key | `blocksWork` | `since` |
|---|---|---|---|---|
| approval | A permission prompt a session is paused on: work at your gate holding a prompt. `heldBy: permission`; the action is the prompt, `title: detail` | `work:<id>` | yes | when it reached your gate (`WorkItem.landedAt`, its move into review) |
| approval | An action an agent asked leave for (`approval.request`, the agent contract C1): `gh pr merge 933 --squash @ ce73104`. `heldBy` is the layer it names (`gate`, `policy`) | `approval:<id>` | yes | when it was asked |
| ask | A decision ask that waits on you (`isWaiting`: blocking, or recommending what cannot be undone), the workspace's and each fleet root's | `ask:<askKey>` | its `blocking` | `askedAt`, else when first seen |
| ask, review body | An initiative whose review date passed, or a parked one whose wake date came (B2) | `review:<initiative>` | no | the due date |
| owner_step | Queued work only you may start ("Start it yourself": the loop's `yours` flag, or a `failed` start from before A8) | `work:<id>` | yes | the flag's time |
| owner_step | The answers batch while it waits to land or has stopped. Maestro never merges its PR | `answers:batch` | yes | when first seen waiting |

- **An approval is a held action, and only that (A1, BRO-2999).** Work is never asked to be approved: gates merge it.
  A run that finished and waits at the gate with no prompt pending is **Finished**: watched, listed by the Feed and
  the Board under Finished, never counted here (`shared/needs-you.ts` `holdsApproval` / `isFinished`). Its card offers
  Change course (a send back with your note, 8 s undo) and Cancel work. The decision binds to the exact action:
  `approval.decide({ key, allow, action })` is refused when `action` is not the text the hold carries now, and is
  dropped, with a receipt that says why, when the prompt or request changed inside the 8 s window. While a decision
  waits, the row carries `body.pending { receipt, label, appliesAt }` so a card counts down and offers Undo by `key`.
  Old data still reads: a `gate` event with verdict approve, and a pending approve decision in a store, apply as before;
  only the verb is refused.
- **Watched, never a need (A1).** Stuck work (`stuck`), a quiet run (`quiet`), a missed or failing fleet tick
  and any other failed or missed scheduled run (`schedule`), and loop drift (`loop`). So is an open ask that
  does not wait on you; Decisions lists it. So is an idea filed for an initiative: a proposal, which
  Initiatives triages and which holds no session. Work's own lists put stuck work under Stuck and a quiet run under
  Running (`shared/needs-you.ts`), so no surface counts them.
- **One prompt is one hold.** fleet-reconcile files a blocking "Session … is waiting at a prompt" ask.
  - **The key:** `ledger_ask.py` (`ask_entry`) writes `fleet: {scope, key, class, batch, ask, tick}`, and
    `report.py` builds the key as `prompt:<session_id>:<tag>`. `session_id` is the **Claude** session id
    (`parsers.py`: `sessionId`, from `runtimeInfo` or `persistence`), never the Paseo agent id Maestro's work
    names. The ask keeps it as `DecisionAsk.promptSession`.
  - **The join:** `Fleet.sessionAgents()` reads each scope's newest report, whose rows carry `session_id` and
    `paseo_agent`. That gives the agent for the session. An open prompt ask's session is always in the
    newest report, because the first tick that sees the wait end withdraws the ask.
  - **The drop:** when that agent's work holds the prompt as an approval with `heldBy: permission`, the ask is
    dropped and the prompt counts once. Work at Maestro's own gate is a different hold, so it never drops one.
  - **What stays:** an ask whose session Maestro does not track, or that no report names, still counts; it
    is then the prompt's only hold.
- **An answer that waits for the conductor is not a need.** Its asker is gone, and the conductor gives it to
  a lane (BRO-2990). File as work and Dismiss stay your verbs in Decisions (`conductor.decide`, with the 8 s
  undo), but nothing holds on you: an unrouted answer delays a lane, not you. It is `answers.status.held`
  once that read lands (BRO-3036).
- **Keys.** `ask:` is followed by the ask's full identity as Decisions keys it, `["<home>","<ledger>",<uid>,"<id>"]`.
  `holdOf(key)` in `shared/needs.ts` reads any key back, so the header, a band and openScreen open the
  hold's own screen.
- **Verbs** use the component kit's ids: `allow`/`deny`, `answer`/`skip`, `done`/`later` (Not now).
- **Fields the contract left open.** An option is `{ id, label, consequence }`, and evidence is the kit's
  `{ label, value, note?, tone }`. `session.name` is the session's short id: its title is Paseo's, and the screen
  may read it. A review's options are keep, park and close (J8); BRO-3036 wires them to a verb.
- **`default` is absent** until an ask has a timed default (A4, `I-ask-default`, the conductor's).
- **First seen.** An undated ask and the answers batch (whose last check moves on with every wake) wait from
  when the daemon first saw them (`firstSeenMemory`). That time is kept in memory, so a restart starts it
  again. It is forgotten once a complete read no longer holds it; a read that missed a source forgets
  nothing. So `since`, and the deck order with it, holds still across reads.
- **`needs.list({ kind })`** narrows the rows to one kind, and the summary then describes exactly those rows.
- **Pure.** Every read is a query since BRO-2995. The plugin sweep (`server/sweep.ts`, every `SWEEP_MS`,
  30 s) keeps the work true to Paseo, applies due decisions and fetches origin/main. `needs.list` reads the
  store as the sweep left it: the work through `engine.list()`, the asks through `WorkspaceAsks.read()`, and
  every other source through its cached read. So it can be up to one sweep stale, but every surface reads
  this one projection of one store, so they are stale together and never disagree. `index.server.test.ts`
  sets up a control repo with an origin, asks, a due review and the answers batch beside a session that went
  back to work. It waits for the start-up sweep to settle. From then on no file under the test's root
  changes, the control repo's `.git` and the drift ledger included, and nothing is sent or started.
  Mutation-proven: a reconcile (`engine.upkeep`) or a fetch (`fetchDue`) in the read fails it.
- **`handled.list`.** `closedBy` is:
  - `you`: a verdict or a cancel;
  - `gates`: its branch merged, or the auto gate closed it on checks that passed (its receipt says so and
    nothing else);
  - `orchestrator`: an adopted arc that finished or was taken back;
  - `maestro`: a run whose arc reported itself finished.

  Rows reach back a week; `today` is the daemon's local day, and a ledger's bare date is that day's local
  midnight.
- **The client.** There is one hook for each projection (`useNeeds`, `useHandled`). It refetches when a
  session changes (`useNeedsEvents`, Paseo's agent events, one read per burst), when a verb settles, and
  otherwise every 30 s. The header button in every workspace runs outside React, so it shares one snapshot
  with the screen (`client/needs-bus.ts`): every read either makes moves the other at once, and an answer
  given in Decisions moves the header with it. Every read takes a ticket when it starts, so one that
  started earlier and answers later never replaces a newer snapshot (`readTicket`, `publishNeeds`).
- **A source that cannot be read costs its own rows.** That includes the work: a failed `engine.list()`
  leaves the asks, the reviews and the batch.
  These all read `needs.list`: the header button, the subtitle, the Feed's Needs you section, the List's
  Needs you chip (it counts and lists the holds in scope, asks included), each initiative's "N need you"
  (`needsByInitiative`: its work, its asks, its review), the tab badges, the Fleet band's "in Maestro", the ask, answers and review bands, and the push ("N need you · …",
  counted as it goes out; a count slower than 3 s is left out, never waited on). The Fleet band's own health
  is watched: its ticks "want a look", and never say "need you".
  The badges are: Feed, the total; Decisions, the holds it lists; Initiatives, the due reviews. Handled for
  you reads `handled.list`. `work.attention` survives only as the read of what you watch (the fleet's,
  Timeline and loop notices) and as the pills' session list; nothing counts from it. `notices.list`
  (BRO-3036) replaces it.

### Watched rows (`work.list`)

```ts
type WorkState = "queued" | "running" | "standing" | "needs_you" | "done" | "stuck" | "quiet";

interface WorkRow {
  key: string; title: string; scope: string; ticket?: string;
  state: WorkState;
  liveTurn?: { n: number; doing: string; at: string };     // running only; the Undertow shows
  hold?: { kind: NeedKind; key: string };                   // needs_you only
  closedBy?: HandledRow["closedBy"];                        // done only
  lifecycle: { stage: WorkState; at?: string }[];
  receipts: string[];                                       // branch, diffstat, checks, PR
  defaultVerb?: "continue" | "done";                        // right swipe on a sheet row
  secondaryVerbs: ("snooze" | "open")[];                    // left swipe
}
```

Swipe actions come from `defaultVerb` and `secondaryVerbs`. A hold has neither, so it can never
be swiped (B1 and M1).

## Per screen

Ids are the inventory's. `scripts/inventory-check.test.ts` parses this table and fails when a row's
reads or writes differ from `inventory.yaml`, or when a live page has no row. Every owner verb
here has the 8 s undo (B4), settings and presence included, so `I-undo` appears on every page that
writes an owner verb. The checker enforces it.

| Page | Screens | Reads | Writes | New fields |
|---|---|---|---|---|
| P-header | J1 header, M1 deck header | I-needs-list | | `NeedSummary` for the tab counts |
| P-feed | J1, M1 | I-needs-list, I-handled-list, I-work-list, I-notices-list, I-sweep-get | I-ask-answer, I-approval-decide, I-owner-step-done, I-session-prompt, I-notice-snooze, I-work-unblock, I-undo | `NeedSummary`; `handled.list.today`; `sweep.get.unsupervisedToday`, `nextWakeAt`. Glance tiles read only these fields |
| P-briefing | J2–J4, M2–M4 | I-work-get, I-work-files, I-needs-list | I-approval-decide, I-ask-answer, I-work-unblock, I-work-cancel, I-undo | `ApprovalBody.evidence`, `after` |
| P-approval-card | K0–K2 (session cards) | I-needs-list, I-verbs-list | I-approval-decide, I-undo | the card reads its hold live by `key`; `body.pending` or `verbs.list` gives its countdown |
| P-decisions | J5, M5 | I-asks-workspace, I-needs-list, I-answers-status | I-ask-answer, I-fleet-ask-answer, I-conductor-decide, I-undo | **new read** `answers.status` → `{ waitingToLand, landingPr?, routed, acted, held, recent[] }` |
| P-work | J6, J6b, M6 | I-work-list, I-work-history | I-work-cancel, I-work-stop, I-session-prompt, I-approval-decide, I-undo | `WorkRow.liveTurn`, `lifecycle`, `closedBy`; J6b decides an approval in place |
| P-health | J7, M7 | I-fleet-get, I-fleet-tick, I-timeline-get, I-loops-get, I-lanes-get, I-needs-list, I-notices-list | I-work-adopt, I-session-prompt, I-work-stop, I-notice-snooze, I-fleet-tick-run, I-fleet-mode-set, I-loop-control, I-undo | **new read** `notices.list` → `{ key, kind: stuck \| quiet \| schedule \| loop \| initiative, title, scope, since, evidence[], closesWhen, verb }`; `fleet.tick.grid` (24 per scope); `loops.get[].recent` (last 16 runs); `lanes.get` liveness |
| P-initiatives | J8, M8 | I-initiatives-list, I-needs-list | I-ask-answer, I-initiatives-file, I-undo | `reviewDue`, `late`, `driver.live`; the review is an `ask` row raised by `ask.raise` on its due date (B2) |
| P-new-work | J9, M9 | I-config-get, I-folder-inspect, I-lanes-get | I-work-create | "who starts it" from `lanes.get` (A8); `work.create` only queues |
| P-phone | M10 | I-needs-list | I-approval-decide, I-ask-answer, I-undo | the push body (≤220 characters); `openScreen` with `{ hold: key }`, checked in BRO-3033 |
| P-presence | P1 | I-presence-get | I-presence-set, I-undo | `presence.get` → `{ state: present \| away \| off, from: signals \| manual, until? }` |
| P-settings-sweep-fleet | B2, M11 | I-sweep-get, I-fleet-get, I-config-get | I-config-set, I-sweep-wake, I-fleet-mode-set, I-fleet-tick-run, I-undo | none |
| P-settings-loops-notices-approvals | B3, M11 | I-loops-get, I-notices-registry-get, I-policy-get | I-loop-control, I-notices-registry-propose, I-undo | none |
| P-settings-lanes | D4, M11 | I-lanes-get | I-lanes-propose, I-conductor-wake, I-lane-tick-run, I-undo | none |
| P-kit-gallery | development only (BRO-3034): M components, Undertow, J1's inspector | I-kit-gallery | | none; its samples are static, it calls no verb |

`I-session-prompt` prompts an existing session and never creates one. A8 forbids creating work by
rule; Continue is the owner's verb, and auto-continue is A3.

## Verbs and undo

Every owner verb returns `{ receipt: string, appliesAt: string }`, with `appliesAt` 8 s after
the call (`UNDO_MS = 8_000`, BRO-3032). `verb.undo(receipt)` before it cancels the verb. After
that, the receipt shows in Handled for you or Health. The toast and the session card both read
`appliesAt`, so the two surfaces count down together. If one surface answers first, the other
updates live by `key` (K1, M10).

### The ledger (BRO-2999)

`server/owner-verbs.ts` holds every verb of yours that changes state, in one append-only file (`verbs.jsonl`:
`verb.pending`, then `verb.undone`, `verb.applied` or `verb.dropped`). The call checks what it can refuse now
(a stop that would lose uncommitted work, a stuck-only unblock), records, and arms a timer; the plugin sweep applies
anything overdue after a restart. When the window closes each verb **checks again** and is dropped with a
receipt when what you decided on has moved. A newer `config.set` replaces a waiting one; any other second verb
on the same key waits for the first (Undo it first).

| Verb | Acts on (`key`) | When it applies |
|---|---|---|
| `approval.decide` | `work:<id>` or `approval:<id>` | answers the held prompt (`Engine.answerPermission`), or tells the requesting session; bound to the exact action |
| `session.prompt` | `session:<agentId>` | sends the prompt to an existing session; never creates one (A8) |
| `work.cancel` (queued, stuck) | `work:<id>` | closes the work; at your gate it is a decision with its own window |
| `work.stop` (`discard`) | `work:<id>` | archives the session; the not-committed check is at the call and again then |
| `work.unblock`, `work.leave-running` | `work:<id>` | as before; Resume (unblock) for work paused on a usage limit |
| `ask.answer` | `ask:<askKey>` | writes the answer at its home; the ask stands open until then |
| `fleet.review` | `fleet:<scope>:<keys>` | writes your verdict into the review file |
| `config.set` | `config` | saves Settings, then rearms the loop |
| `loop.wake` | `loop` | wakes the loop; its entry is in `loop.get.recent` once it ran |

A decision at the gate (`work.verdict` revise, cancel at review) keeps its window on the work's own events
(`gate.pending`, `gate`, `gate.dropped`); its receipt is the decision's token, and `verbs.list` lists it beside the
ledger's, so one Undo serves them all. **`verbs.list`** → `{ pending[{receipt, verb, key, label, at, appliesAt,
remainingMs}], recent[{…, outcome, detail, settledAt}] }` is the read behind every countdown (`client/pending-verbs.tsx`).
The window is 8 s; `MAESTRO_PASEO_VERB_WINDOW_MS` shortens it for a test or a dogfood only.

### An agent asks (C1)

`approval.request({ action, ref?, heldBy?, title?, scope?, ticket?, evidence?, after? })` on the agent socket
(`maestro approval request <action> --ref <sha>`) raises one hold: the same session asking for the same action at the
same ref is one request, another ref is another. The request is stored in `approvals.jsonl` (`server/approvals.ts`).
A session may withdraw its own request; **it can never decide one** (`approval.decide` is not served on the socket).
Allow or Deny tells the session the exact action in words; whatever was allowed is run by the session or the
conductor, never by Maestro (A8).

## Invariants (each one a test)

1. `summary.total == rows.length ==` the header badge `==` the Feed tab badge `==` the Needs you
   section's length `==` the push count. `index.server.test.ts` checks it end to end, through the plugin's
   own handlers. The header button is `startIntegrations`, reading through them; the push is a real landing
   sent by the real `Inbox` with the plugin's own count. Its sources cover every kind. Two more tests check
   it on their own fixtures. `server/needs-invariant.test.ts` uses work in every state and every subset of
   the four sources. `client/integrations.test.ts` checks that the header takes the screen's snapshot at
   once.
2. Each glance tile number equals the length or field of the projection it names. No client sums. The
   tiles land with J1 (BRO-3035); today's tabs and the Fleet band read `needs.list` alone
   (`client/header-count.test.ts`).
3. Deck order is deterministic for equal inputs (sort keys above, ties broken by `key`):
   `server/needs.test.ts`, over 50 shuffles.
4. The Undertow, tidepool dot and Running tile read `state == "running"` only. The standing pulse
   reads `standing`, and lane liveness when no turn is in progress (BRO-3034's kit; the screens in BRO-3035).
5. No read writes (BRO-2995). No verb here launches a session (A8). For `needs.list` and `handled.list`:
   `index.server.test.ts`.

## Alternatives considered

- **Count on the client from several reads.** That is today's code (BRO-3001): four pollers at
  three rates disagree on the badge. Rejected: the counts must come from one projection.
- **One `screen.get(name)` per screen.** It would make each screen trivial, but every screen
  would duplicate the projection logic, and invalidation would go per screen. Rejected: two
  projections plus domain reads keep a single source per number.
- **Count every open ask, each with a default counting down (A4).** No ask has a timed default yet, so the
  count would jump to every open ask in every ledger. Rejected for now: an ask is a hold while it waits on
  you (§5.4), and `default.appliesAt` orders the deck once the conductor takes defaults.
- **Keep stuck work as an owner step.** Unblock is yours, but stuck work is a fact that closes itself: its
  session takes a turn, its orchestrator closes it, or you cancel it. Rejected: A1 makes it Health
  (`notices.list` kind `stuck`), and an owner step is something only you can do.
- **Count a conductor candidate as an owner step.** File and Dismiss are your verbs, but routing it is the
  conductor's (A8). Rejected: it would put the conductor's queue in your count.
- **Push the view state over a socket.** Not needed. Plugin events already invalidate the queries,
  and a socket adds a second delivery path to keep consistent.

## Not in scope

- View state such as selection, the open inspector, the sheet position, or a scrolled lane. It
  lives in the client and is never stored on the server.
- Visual tokens. They come from broomva-design (B1), not from data.
