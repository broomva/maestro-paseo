# Maestro on the phone: where you left it, and answers that survive the link (BRO-3180 B + C)

Date: 2026-10-17. Ticket: BRO-3180, parts 3 and 4. Part A (keyboard and caret) is PR #84.
Status: revision 3. Revision 2 followed one devil's-advocate review (3/10, which found a host fact that reshapes
part C). Part B shipped as #87. Revision 3 makes part C buildable on that code: what counts as "not sent", where the
record lives, the clock, and the changed-ask tap. One Opus devil's-advocate review of revision 3's first draft
(6/10, three MAJORs) is folded in: an undone verb no longer bypasses the two taps, B's sweep waits for the
resolution, and a matched verb is "an answer", never "your answer".

## Objective

- **Part B.** Leaving Maestro and coming back lands on the same tab, the same ask and the same typed words. That
  holds across a screen change, a plugin reload, the link dropping and coming back, and an app restart.
- **Part C.** On iOS and the web, an answer is never lost to the link. Android stores in memory only, and a link
  drop re-evaluates the module, so there it is not kept. It is kept with the exact revision it was given against.
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

The phone answers through `answer()` in `client/phone/shell.tsx`, which calls `inspector.act("answer")`
(`client/use-inspector.ts`). `act` gains an optional `onFail(error)` callback, so the shell learns why a send
failed. Everything else about `act` stays the same, including the toast.

**What counts as not sent: the call got no reply.** Any error the server's handler throws comes back over the wire
as `rpc_error`. The Paseo client raises that as a `DaemonRpcError`, which carries a `requestType` property and
appends `requestType=… [code=…]` to its message (`packages/client/src/daemon-client.ts`). The plugin's `invoke` passes
it through unwrapped (`surface-runtime.ts`). The check reads the property first, and the message second. A `ZodError`
(an input or output this client could not parse) is no dropped link either. A stale hash, a closed ask and `ALREADY_PENDING` are all replies. An
error **without** `requestType=` never reached a reply: `Transport not connected…`, `Timed out waiting for
connection…`, `Connection lost`, `Connection lost before message could be sent`. Only those keep an unsent record.
`Connection lost` can come after the request went out, so the first line says "may not have been sent", never "not
sent", until fresh reads decide. A refusal is said
as today and keeps nothing, because the server has already decided it.

The record lives on the B draft of that ask (`maestro-paseo.v1.phone.drafts`, keyed by the ask's identity):

```ts
type Unsent = { at: number; hash: string; key: string; error: string };
// at: the phone's clock when sent. hash: the revision it was sent against. key: the hold key the server files the
// verb under (askHoldKey), as it was at send time.
```

The choice and words are the draft's own, so editing them after a failed send edits what Send again sends.
Answering again replaces the record: a send that gets a reply, success or refusal, clears it. A draft that holds an
unsent record is never empty, so B's write path keeps it as you type.

Until fresh reads decide, the card shows "Not confirmed: the link dropped before your Mac answered, so this may not
have been sent." The primary verb reads **Send again**.

### Resolving it after reconnect

Once reads of both `verbs.list` and `asks.workspace` have landed **after the record's send** (`dataUpdatedAt > at`,
no error), each unsent record is resolved. "After mount" is not enough: a reply that timed out leaves the screen
mounted, holding reads from before the send. B's sweep never deletes a draft that carries a record. The resolution
owns it, so a closed ask cannot take the record before `verbs.list` has been read. The order:

1. **`verbs.list` has an `ask.answer` verb under the record's key, with `at` no earlier than `unsent.at − 60 s`.**
   - The 60 s absorbs clock skew between the phone and the Mac.
   - Only the key from send time counts. Adding the key as read now would widen collisions.
   - `verbs.list` carries no sender, so a match is "an answer", which may have come from the desktop. The phone
     never says "your answer".
   - The newest match decides:
     - Pending: a one-time toast, "An answer to <ask> reached your Mac: it applies in N s." The record is cleared.
       The 8 s undo window has almost always passed by then, and the server would refuse a second answer
       (`ALREADY_PENDING`).
     - Applied: a one-time toast, "An answer to <ask> went through." The record is cleared.
     - Undone or dropped: "Not sent from here: an answer to this ask was undone", with **Send again**. If the ask's
       hash changed, step 4's two taps apply.
2. **The ask is in a trusted read and no longer open:** a one-time toast, "<ask> is no longer open: nothing more was
   sent from this phone." The record is cleared, and B's sweep deletes the draft. The toast does not claim whether
   the answer was ours: past `verbs.list`'s 24 h it cannot know.
3. **The ask is open, at the record's hash, and no verb matched:** "Not sent: your Mac has no answer to this ask",
   with **Send again**.
4. **The ask is open, and its hash changed:** "Not sent, and this ask changed after you answered. Read it again."
   **The first tap on Send again sends nothing.** It says the ask changed and moves the record onto the current
   revision. Only a second, deliberate tap answers that revision.
5. **The ask is not in the read, or the reads are older than the send:** no conclusion (B's absence rule). It stays
   "Not confirmed".

**Send again** is the ordinary `answer()`, sent against the ask *as read now*: its current hash, the irreversible
option's confirm, the toast and the undo window.

### Invariants

- No answer is sent without a tap made after reconnect, with the current ask on screen.
- A changed ask takes two taps: the first only says it changed.
- An unsent record is resolved only from positive evidence in fresh reads, never from absence.
- One unsent record per ask.
- Server semantics are unchanged: the server still refuses a stale hash, a closed ask and a pending duplicate.

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
  the new revision. Revision 3's changed-ask tap does move the record onto the new hash, but only after a tap that
  sends nothing and says the ask changed. The answer then goes out on a second tap, with the new revision on screen.
- **Classify by error text** ("Transport not connected", "timed out"). Rejected because the host's wording is not
  API. "Did a reply arrive" is structural: every handler error carries `requestType=`.
- **Re-offer the undo toast for a pending verb found after reconnect.** Not built: the 8 s window has almost always
  passed by the time a reconnect remounts the plugin. The line says when it applies.
- **Key drafts by the hold key, or by `(key, hash)`.** Rejected because the first changes when an ask moves home,
  and the second drops the text on any edit to the ask.

## Non-goals

- **Answering while disconnected.** The host unmounts plugins (above). Keeping Maestro mounted offline needs a
  Paseo change: filed upstream as getpaseo/paseo#7247 (keep plugins mounted, which getpaseo/paseo#6731 would do,
  and expose the connection state to plugins).
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
- **Two runs of the plugin can overlap.** An old run's failed-send write can land after the new run has cached the
  drafts. The new run's next debounced save could then drop that record. The record is written straight to storage
  (`flushDrafts`) to keep the window small. Closing it fully needs a merge on write, judged not worth it for a
  reply that arrives after a remount.
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
- `bun test client/phone/unsent.test.ts client/phone/shell.render.test.tsx` passes, covering:
  - each resolution branch, including undone and dropped from `verbs.list`;
  - no conclusion on absence;
  - one unsent answer per ask;
  - Send again using the current hash and not the stored one.
- Live: a fault-injected `invoke` drops the answer call. The card shows "Not sent yet". Then reload, the stand-in
  for a reconnect: still "Not sent". **Send again** lands it, with the undo toast. With the fixture ask edited in
  between, it shows "changed" and the ledger has no answer written.
- Mutation-proven: send with the stored hash, conclude on absence, auto-send on mount.
