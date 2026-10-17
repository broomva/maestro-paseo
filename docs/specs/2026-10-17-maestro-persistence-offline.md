# Maestro on the phone: where you left it, and answers that survive the link (BRO-3180 B + C)

Date: 2026-10-17. Ticket: BRO-3180, parts 3 and 4. Part A (keyboard and caret) is PR #84.
Status: revision 2, after one devil's-advocate review (3/10, which found a host fact that reshapes part C; every
finding is answered below).

## Objective

- **Part B.** Leaving Maestro and coming back lands on the same tab, the same ask and the same typed words. That
  holds across a screen change, a plugin reload, the link dropping and coming back, and an app restart.
- **Part C.** An answer is never lost to the link. It is kept with the exact revision it was given against.
  Once the link is back, its fate is read from the server and shown: sent, applied, undone, or not sent. When
  it was not sent, one tap sends it again through today's path, against the current revision.

**Reversal cost: a two-way door.**
- Everything is client-side, under versioned keys (`maestro-paseo.v1.*`).
- Reverting leaves inert keys and no server state.
- No answer is ever sent without a tap, so nothing here can apply an answer the owner did not just confirm.

## The host fact that reshapes part C

**A plugin cannot run while its host is offline.** `PluginCatalogSync` (`packages/app/src/plugins/catalog-sync.tsx`,
the same code in the installed Paseo.app 0.11.4 bundle) calls `pluginRegistry.removeHost(serverId)` whenever the
host is disconnected. That disposes every plugin of the host and clears its query cache (`registry.ts`).

On reconnect the catalog is installed again and the bundle is **re-evaluated**. So:
- With no link there is no Maestro screen to answer on. "Answer in airplane mode, see Queued" cannot be built
  inside a plugin.
- Module memory dies on every link blip, not only on a reload. Durable storage is the only thing that carries
  state across a reconnect, so part B needs it for blips too, not just restarts.
- What part C *can* own is an answer that is in flight, or tapped in the instant before the unmount, when the
  link drops. Today that answer is simply lost.

The owner's literal wish, answering while offline, needs Paseo to keep a plugin mounted while disconnected. That is
an upstream change (see "Non-goals").

## The safety basis

Sending again is safe because **the server already refuses every unsafe replay, today, unchanged.**
- `ask.answer` carries the `hash` of the ask as it was read.
- `openAsk` (`index.server.ts`) refuses a hash that is no longer the entry's, and an ask that is no longer open.
- The verb ledger refuses a second answer while one waits out its undo window (`ALREADY_PENDING`,
  `server/owner-verbs.ts:209`).

The client adds no new path to the server. "Send again" is the ordinary `act("answer")` with today's confirm rules,
toast and undo, so the worst a client bug can do is fail to send.

## Part B: where you left it

### State

`client/phone/resume.ts` is pure and validated with zod on read; a value that fails to parse is treated as empty.

```ts
type Resume = {
  v: 1;
  tab: PhoneTab;
  page: PhonePage | null;
  workspace: string | null;
  card: { series: string; ask: AskRef } | null;   // the open sheet and the ask it was on
  consumed: { hold: string | null; tab: string | null }; // route params already acted on (see below)
};
type AskRef = { ledger: string; uid: string | null; id: string; fleet: string | null }; // identity, not the hold key
type Draft = { ask: AskRef; hash: string; chosen: string | null; words: string; at: number; unsent?: Unsent };
```

- **Identity, not the hold key.** The hold key embeds the ask's home (a checkout path or `origin/main`,
  `shared/needs.ts:150`), so it changes when an ask moves home. Drafts and the card are matched by
  `(ledger, uid ?? id)`, plus the fleet scope for a fleet root ask, as `openAsk` matches.
- **Position by identity.**
  - The card reopens on the same ask through the existing visit model (`series-model.ts`).
  - If the ask is no longer in its series, the card opens on the series' next unanswered ask.
  - If the series is gone, it lands on the Decisions dashboard with "That ask was answered while you were away".
- **A draft is restored even if the ask changed** (`hash` differs), under "This ask changed since you wrote this."
  Silently dropping the text is the failure the owner reported.
- **Route params are consumed once.** `params.hold` and `params.tab` (a push) stay in the route, so a remount would
  otherwise jump back to the push every time. The value acted on is recorded in `consumed`, and an equal value is
  not acted on again. A new push and an explicit intent still win over the restored place.

### Clearing drafts: positive evidence only

A draft is deleted only when a **fresh, warning-free** read shows its ask answered or archived. Absence never
counts:
- `asks.workspace` lists open asks plus only the ten latest answered (`control-asks.ts` `shown()`) and never
  archived ones.
- A fleet read failure returns `asks: []` with a warning (`index.server.ts`).

So a draft whose ask is simply not in the read is kept. Drafts untouched for 14 days are dropped. Sent is not
landing: a draft stays through the undo window, so an undo brings the words back, as `shell.tsx:500` does today.

### Storage

`client/kit/durable.ts` is one adapter. A module-level cache sits in front of it, and reads come from the cache.

| Platform | Backend | Limits |
|---|---|---|
| iOS app | `Settings.get/set` (NSUserDefaults), keys `maestro-paseo.v1.*` | Shared with the host app, hence the namespace. Capped at 50 drafts × 2000 chars, about 100 KB. Wrapped in try/catch: if the native module is absent, `Settings` throws, and we fall back to memory. |
| Web, desktop | `localStorage`, same keys | Per origin, about 5 MB. A quota error falls back to memory. |
| Android, or a failure | memory | Survives navigation but not a reconnect (the module is re-evaluated). Stated, not hidden. |

Drafts are written through with a 300 ms debounce. The tab, the card and an unsent answer are written immediately.

## Part C: answers that survive the link

### Keeping an unsent answer

`act("answer")` (`client/use-inspector.ts:122`) runs as today. When the call throws anything other than a server
refusal (`UserError` text), the draft gets:

```ts
type Unsent = { input: AnswerInput; at: number; error: string }; // exactly what was sent, original hash included
```

Examples: `Transport not connected`, `Timed out waiting for connection…`, `Connection lost`, and the client's own
`No reply in …` (`client/answer-timeout.ts`).

No classification is needed, because nothing auto-sends. The card shows "Not sent yet: the link to your Mac
dropped". The answer stays in the draft, so it survives the unmount and the reconnect.

### Resolving it after reconnect

On mount, once a fresh read of both `verbs.list` and `asks.workspace` exists, each unsent answer is resolved in this
order:

1. **`verbs.list` has an `ask.answer` verb for this ask, at or after `unsent.at`** (pending, or recent applied,
   undone or dropped). The ledger keeps these by key for 24 h.
   - Pending: "Sent, applies in N s". The undo toast is offered.
   - Applied: "Answered". The draft is cleared.
   - Undone or dropped: "Not sent (undone)". Never re-sent on its own; offered as Send again.
2. **No verb, the ask is in the read, open, same hash**: "Not sent", with **Send again**.
3. **No verb, the ask is in the read, open, hash changed**: "This ask changed since you answered". The card opens
   with your choice and words as the draft, and you answer the current revision deliberately.
4. **No verb, the ask is answered, `answeredAt` after `unsent.at`**: "Answered meanwhile". The answer is shown and
   the draft is kept for you to discard.
5. **The ask is not in the read**: no conclusion (see the absence rule). It stays "Not sent".

**Send again** is `act("answer")` against the ask *as read now*: its current hash, today's irreversible-option
confirm, toast and undo window. The stored `input` is only what pre-fills the card.

### Invariants

- No answer is sent without a tap made after reconnect, with the current ask on screen.
- An unsent answer is resolved only from positive evidence in fresh reads, never from absence.
- One unsent answer per ask: answering the ask again replaces it.
- Server semantics are unchanged; the server still refuses a stale hash, a closed ask and a pending duplicate.

## Alternatives considered

- **An automatic outbox that flushes on reconnect** (revision 1). Rejected because it sends in the background,
  where nobody sees the 8 s undo window. That includes irreversible options confirmed hours earlier. Its
  maybe-sent state also needs answer-shape equality the server's split of `note` into `answerNote` and
  `answerOther` makes fragile. One tap with the current ask on screen gives the same reach with none of that.
- **Drafts on the daemon** (a new RPC). Rejected because it is unreachable exactly when the link drops, and adds
  a server surface (out of scope).
- **AsyncStorage through `NativeModules.RNCAsyncStorage`**. Rejected because it reaches into the host's private
  native modules, which any Paseo release could remove. `Settings` is public RN API.
- **Rely on the Paseo client's send queue.** Rejected because it holds a request only while `connecting`, times
  out, and lives in memory that the unmount discards.
- **Re-stamp a stale answer with the new hash.** Rejected because it applies an answer the owner never saw against
  the new revision.
- **Key drafts by the hold key, or by `(key, hash)`.** Rejected because the first changes when an ask moves home,
  and the second drops the text on any edit to the ask.

## Non-goals

- **Answering while disconnected.** The host unmounts plugins (above). Keeping Maestro mounted offline needs a
  Paseo change, which goes upstream as an issue on getpaseo/paseo once the coordinator approves filing it.
- Offline verbs other than answering an ask.
- Android durability beyond memory.
- Syncing drafts between devices: drafts are per device by design.
- Any change to `ask.answer`, the validator or landing.

## Risks and trade-offs

- Settings is shared with the host app. A host bug that clears defaults clears our drafts.
- A draft restored onto a changed ask can mislead. The "changed" line mitigates it; dropping the text instead is
  the reported failure.
- The resolution reads `verbs.list` for 24 h only. An unsent answer older than that falls to steps 2–5, which are
  still safe because nothing auto-sends.
- `Settings` inside the Paseo iOS app is unproven: it is a default pod, but only the owner's phone can show it. If
  it fails, iOS degrades to memory, and the receipt says so.

## Open questions

- Should Paseo keep plugins mounted while disconnected (upstream)? That is the only route to the owner's literal
  wish.
- Should a "Not sent" answer also push a notification after reconnect? Not in this arc.

## Acceptance

**PR B**
- `bun test client/phone/resume.test.ts client/kit/durable.test.ts` passes. It covers:
  - round-trip, and an invalid stored value parsing as empty;
  - restoring by identity, including across a home change;
  - a gone ask and a gone series;
  - the absence rule (a draft is kept when the read lacks its ask or carries a warning);
  - the 14-day sweep;
  - a param consumed once;
  - Settings throwing, falling back to memory.
- A shell render test: unmount and remount, and the same tab, ask and draft come back.
- Live (402×874 hidden window, CDP): open a fixture ask, pick Other, type 20 characters, navigate to a session and
  back. The same ask shows the same 20 characters. The same holds after `paseo plugin reload maestro`.
- Mutation-proven: drop the restore, key by the hold key, sweep on absence.

**PR C**
- `bun test client/phone/unsent.test.ts` passes, covering:
  - each resolution branch, including undone and dropped from `verbs.list`;
  - no conclusion on absence;
  - one unsent answer per ask;
  - Send again using the current hash and not the stored one.
- Live: a fault-injected `invoke` drops the answer call. The card shows "Not sent yet". Then reload, the stand-in
  for a reconnect: still "Not sent". **Send again** lands it, with the undo toast. With the fixture ask edited in
  between, it shows "changed" and the ledger has no answer written.
- Mutation-proven: send with the stored hash, conclude on absence, auto-send on mount.
