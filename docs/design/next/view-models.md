# Maestro next: the data each screen reads (BRO-3001)

This is the contract between the server and the J (desktop) and M (phone) screens in
`maestro-next.pen`. It says what each screen shows, which interface supplies it, and what is
new. Interface ids are the ones in `inventory.yaml`. The owner's decisions it applies:

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

| Screen | Reads | New fields or interfaces | Writes (owner verbs: 8 s undo) |
|---|---|---|---|
| J1 / M1 Feed | `needs.list`, `handled.list`, `work.list`, `notices.list`, `sweep.get` | `NeedSummary`; `handled.list.today`; `sweep.get.unsupervisedToday`, `nextWakeAt` | `approval.decide`, `ask.answer`, `owner_step.done`, `session.prompt` (Continue), `notice.snooze`, `work.undo` |
| Glance tiles | the same | none; every tile reads one projection field | none |
| J2–J4 / M2–M4 briefings | `needs.list` (body), `work.get`, `work.files` | `ApprovalBody.evidence`, `after` | as Feed, plus `work.unblock`, `work.cancel` |
| J5 / M5 Decisions | `needs.list` (asks), `asks.workspace` | **new read `answers.status`** → `{ waitingToLand, landingPr?, routed, acted, held, recent[] }` | `ask.answer`, `fleet ask answer` |
| J6 / J6b / M6 Work | `work.list`, `work.history` | `WorkRow.liveTurn`, `lifecycle`, `closedBy` | `work.cancel`, `work.stop`, `session.prompt` |
| J7 / M7 Health | `notices.list`, `fleet.get`, `fleet.tick`, `loops.get`, `lanes.get` | **new read `notices.list`** → `{ key, kind: "stuck" \| "quiet" \| "schedule" \| "loop" \| "initiative", title, scope, since, evidence[], closesWhen, verb }` (the Health deck, in severity order); `fleet.tick.grid` (24 per scope); `loops.get[].recent` (last 16 runs); `lanes.get` conductor and lane liveness (standing) | `notice.snooze`, `fleet tick run`, `fleet mode set`, `loop control` |
| J8 / M8 Initiatives | `initiatives.list`, `needs.list` (the review as an ask) | `initiatives.list[].reviewDue`, `late`, `driver.live`; the review is raised by `ask.raise` on its due date (B2) | `ask.answer` |
| J9 / M9 New work | `config.get`, `folder.inspect`, `lanes.get` | "who starts it" comes from `lanes.get` (A8) | `work.create` (queues only) |
| P1 presence | `presence.get` → `{ state: "present" \| "away" \| "off", from: "signals" \| "manual", until? }` | the whole interface (new) | `presence.set({ state, until })` |
| M10 from a push | the inbox session's push body (≤220 characters); `needs.list` by `key` | `openScreen({ screenId: "maestro", params: { hold: key } })` is assumed, and checked in BRO-3033 | as Feed |
| M11 / B2 / B3 / D4 settings | `config.get`, `fleet.get`, `loops.get`, `lanes.get`, `policy.get`, `notices.registry` | none beyond the above | `config.set`, `fleet mode set`, `loop control`, `lanes propose`, `notices propose` |

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
