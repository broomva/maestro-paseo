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
| P-approval-card | K0–K2 (session cards) | I-needs-list | I-approval-decide, I-undo | the card reads its hold live by `key` |
| P-decisions | J5, M5 | I-asks-workspace, I-needs-list, I-answers-status | I-ask-answer, I-fleet-ask-answer, I-undo | **new read** `answers.status` → `{ waitingToLand, landingPr?, routed, acted, held, recent[] }` |
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
the call (`UNDO_MS = 8_000`, BRO-3032). `work.undo(receipt)` before `appliesAt` cancels it. After
that, the receipt shows in Handled for you or Health. The toast and the session card both read
`appliesAt`, so the two surfaces count down together. If one surface answers first, the other
updates live by `key` (K1, M10).

## Invariants (each one a test in BRO-3001)

1. `summary.total == rows.length ==` the header badge `==` the Feed tab badge `==` the push count.
2. Each glance tile number equals the length or field of the projection it names. No client sums.
3. Deck order is deterministic for equal inputs (sort keys above, ties broken by `key`).
4. The Undertow, tidepool dot and Running tile read `state == "running"` only. The standing pulse
   reads `standing`, and lane liveness when no turn is in progress.
5. No read writes (BRO-2995). No verb here launches a session (A8).

## Alternatives considered

- **Count on the client from several reads.** That is today's code (BRO-3001): four pollers at
  three rates disagree on the badge. Rejected: the counts must come from one projection.
- **One `screen.get(name)` per screen.** It would make each screen trivial, but every screen
  would duplicate the projection logic, and invalidation would go per screen. Rejected: two
  projections plus domain reads keep a single source per number.
- **Push the view state over a socket.** Not needed. Plugin events already invalidate the queries,
  and a socket adds a second delivery path to keep consistent.

## Not in scope

- View state such as selection, the open inspector, the sheet position, or a scrolled lane. It
  lives in the client and is never stored on the server.
- Visual tokens. They come from broomva-design (B1), not from data.
