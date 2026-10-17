# Maestro on the phone: where you left it, and answers that wait for the link (BRO-3180 B + C)

Date: 2026-10-17. Ticket: BRO-3180, parts 3 and 4. Part A (keyboard and caret) shipped separately in PR #84.
Status: proposed. It is reviewed once by a fresh devil's advocate before any code.

## Objective

Leaving Maestro and coming back lands on the same tab, the same ask and the same typed words, through a screen change,
a plugin reload and an app restart (part B). An answer given while the daemon is unreachable is kept, shown as
queued, and sent once the link returns, unless the ask changed, closed or vanished meanwhile, in which case it waits
for the owner to confirm it again (part C).

**Reversal cost:** two-way door. Everything is client-side, behind versioned storage keys (`maestro-paseo.v1.*`);
reverting the PRs leaves inert keys and no server state. The one durable effect, an answer sent from the outbox, goes
through the unchanged server path and its undo window.

## The safety basis, first

An offline answer is safe because **the server already refuses every unsafe replay, today, unchanged**:
`ask.answer` carries the `hash` of the ask as it was read. `openAsk` (`index.server.ts`) refuses a hash that is no
longer the entry's (*changed*) and an ask that is no longer open (*answered, archived, gone*). The verb ledger
refuses a second answer while one waits out its undo window (`ALREADY_PENDING`, `server/owner-verbs.ts:209`). The
outbox stores the exact request, original hash included, and never re-stamps it. So the worst a client bug can do
is fail to send; it cannot apply a stale or a double answer. Everything the client adds (the pre-check, the reasons,
the re-confirmation row) exists to say *why* in words and to resolve "maybe sent" by reading the ask back.

## The problem, in the owner's words

> when i change screen or open a session, i want to be able to [go back] to maestro to the place and state where
> [I] left it, im always getting back to the default view of maestro home … if I had typed something, that's gone.
> Also, the plugin does not work offline, while we could store asks answers sans push them once mobile gets back
> online.

Two failures, one root: all of Maestro's phone state is React state (`client/plane.tsx:81` holds the tab;
`client/phone/shell.tsx:291,446,448` hold the visit, the choices and the words). React state dies whenever the
screen unmounts: another screen, opening a session, or a plugin reload. An answer is also only one RPC
(`ask.answer`, `client/verbs.ts:342`): with the daemon unreachable it throws, the toast shows the error, and
the answer is gone.

## What the host gives a plugin (facts that bound the design)

Read from `getpaseo/paseo` source (`packages/app/src/plugins/evaluate.ts`, `surface-screen.tsx`,
`packages/client/src/daemon-client.ts`) and the SDK 0.11.1 typings:

| Fact | Consequence |
|---|---|
| A plugin bundle gets exactly `react`, `react-native`, `@tanstack/react-query`, `zod` and the plugin SDK. The SDK has **no storage API**. | Storage must come from `react-native` itself, or the web platform. |
| `react-native`'s `Settings` (iOS NSUserDefaults, `Settings.ios.js`) is in every RN iOS build (`React-RCTSettings` is a default pod). `get` is synchronous from a JS cache; `set` writes through. On Android it is a no-op. | On iOS, a durable, synchronous key-value store with no host change. |
| On the web and desktop builds (react-native-web in Electron or a browser), `localStorage` is available. | Same store, different backend. |
| A plugin module is evaluated once per app run and stays loaded across screen changes. A `paseo plugin reload` or an app restart re-evaluates it. | A module-level memory cache survives navigating away. Only durable storage survives a reload or restart. |
| The host renders the plugin only while it has a client for the host (`surface-screen.tsx:225`). The client object outlives a dropped link. A cold start with no catalog shows "Plugin host is offline" instead. | Offline answering covers the case the owner hit: Maestro open, then the link drops. A cold start offline is the host's to fix (non-goal). |
| `invokePluginRpc` rejects at once with `Transport not connected (status: …)` when disconnected. While `connecting` it queues the request and rejects with `Timed out waiting for connection` if the link never comes. A request in flight when the link drops ends in a timeout, and may or may not have reached the daemon. | Three outcomes: definitely not sent, maybe sent, and refused by the server. The outbox must handle all three. |
| The server already refuses an answer whose `hash` is not the entry's current hash, and an answer to an ask that is not open (`index.server.ts` `openAsk`). It also refuses a second answer while one is waiting out its undo window (`ALREADY_PENDING`, `server/owner-verbs.ts:209`). An answered ask carries `answerOption`, `answerNote` and `answerOther`. | Stale answers and double answers are refused **server-side today**. The outbox needs no server change: it sends the hash it was answered against and reads the outcome back. |

## Part B: where you left it

### The state model

A pure module, `client/phone/resume.ts`, owns one versioned record:

```ts
type Resume = {
  v: 1;
  tab: PhoneTab;                       // feed | decisions | work | health
  page: PhonePage | null;              // initiatives, fleet{scope,tick}, timeline, loops, settings{page}
  workspace: string | null;            // the scope chip
  card: { series: string; key: string } | null; // the open sheet: its series, and the ask it was on
};
type Draft = {
  hash: string;                        // the ask's revision when you last typed
  chosen: string | null;               // the option you picked (OTHER_CHOICE included)
  words: string;                       // the note, or your Other answer: one field, as the card has one
  at: number;                          // last edit, ms
};
type Drafts = Record<string /* the hold key, "ask:<ledger>/<uid|id>" */, Draft>;
```

- **Position is the key, not the index.** A series' order moves as asks are answered elsewhere. `card.key` is
  restored through the visit model that exists already (`series-model.ts`). If the key is gone, the card opens
  on the series' next unanswered ask. If the series is gone, you land on the Decisions dashboard with the toast
  "That ask was answered while you were away". You never land on Feed for lack of state.
- **Drafts are keyed by ask, and the revision is recorded rather than used as the key.** A draft whose `hash`
  differs from the ask's current hash is still restored: losing typed text is the failure the owner reported.
  It is restored under one line, "This ask changed since you wrote this." Keying by `(key, hash)` would silently
  drop the text on any edit to the ask, and that is the worse error.
- **A draft is cleared once the answer lands.** That means the ask's state is no longer `open` in a fresh read
  and no verb of ours is pending on its key. "Sent" is not landing: within the undo window an undo brings the
  ask back with its words, as `shell.tsx:500` does today. A sweep on every fresh read drops drafts whose ask is
  answered or archived. Drafts older than 14 days are dropped too.
- **What is not restored:** the toast, an in-flight verb, the scroll offset inside a card, the New-work
  composer. Each is transient or has its own owner.

### Storage

`client/kit/durable.ts` is one adapter with three backends, chosen once:

| Platform | Backend | Limits |
|---|---|---|
| iOS app | `Settings.get/set` under keys `maestro-paseo.v1.resume` and `maestro-paseo.v1.drafts` | NSUserDefaults: plist-serialised, shared with the host app (hence the namespace), meant for small values. Capped by us at 50 drafts × 2000 chars (the field's `maxLength`), about 100 KB worst case. |
| Web, desktop | `localStorage`, same keys | Per origin (`paseo://app` on desktop), about 5 MB, synchronous. A quota error falls back to memory and is logged once. |
| Android, or anything unreadable | memory only | Survives navigation, not a reload. Stated, not hidden. |

In front of every backend sits a **module-level memory cache**. Reads come from memory, and writes go to memory
first, then through, debounced 300 ms for drafts and immediately for the tab and card. Navigating away and back
never touches the backend. Every value read back is validated with zod; one that fails parses as empty, so a
schema change can never crash the screen. The version lives in the key, so `v2` starts clean.

**The tab is restored over the default, not over an explicit target.** `params.tab`, `params.hold` (a push) and
an intent (`openDecisions`) still win, as they do today, because they express where you asked to go. With none
of them, the screen opens where you left it.

## Part C: answers that wait for the link

### The outbox model

A pure module, `client/phone/outbox.ts`, plus a hook. One entry per ask:

```ts
type Queued = {
  id: string;            // client uuid, made once at enqueue
  key: string;           // the hold key; one entry per key: a new answer to the same ask replaces a queued one
  input: AnswerInput;    // exactly what ask.answer would have sent: where, ledger, uid, id, hash, option, note, wake
  label: string;         // "Answered: Keep them off"
  queuedAt: number;
  state: "queued" | "maybe-sent" | "confirm";
  reason?: "gone" | "changed" | "answered-elsewhere" | "archived" | "refused";
  refusal?: string;      // the server's words, when it refused
};
```

It is stored with the same adapter, key `maestro-paseo.v1.outbox`, written through immediately (never
debounced: an answer is not a draft).

### When an answer is queued

`act("answer")` (`client/use-inspector.ts:122`) runs as today. On its error path the error is classified:

| Error | Meaning | Outbox |
|---|---|---|
| `Transport not connected` | Never left the phone | enqueue `queued` |
| `Timed out waiting for connection` | Queued by the client, never sent | enqueue `queued` |
| Any other timeout, or a dropped socket mid-call | Maybe reached the daemon | enqueue `maybe-sent` |
| Anything else (a `UserError` from the server) | The server read it and said no | not queued: shown as today |

A queued answer behaves like a sent one on the card: the card moves on, the draft is kept, and the toast says
"Queued: sends when Maestro reconnects". The dashboard row shows a **Queued · N** chip, and the queued ask's
card shows "Queued" with **Discard**. Undo on a queued answer removes the entry, because nothing reached the
server.

### Flushing

The outbox flushes when a read succeeds after a failure (the needs or asks query turns from error to
success), when the screen mounts, and every 15 s while entries exist. A module-level single-flight promise
makes two mounted surfaces flush once. Entries go one at a time, oldest first. Each entry is checked against a
fresh `asks.workspace` read made after the link came back:

1. **Ask not found** → `confirm`, reason `gone`.
2. **`state: archived`** → `confirm`, reason `archived`.
3. **`state: answered`**, and its `answerOption` / `answerOther` / `answerNote` equal ours → **landed**. This is
   the idempotent case: a `maybe-sent` answer that did reach the daemon. Drop the entry and the draft.
   Otherwise → `confirm`, reason `answered-elsewhere`.
4. **Open, but `hash` differs from `input.hash`** → `confirm`, reason `changed`. It is never sent with a new hash.
5. **Open, same hash** → send `input` unchanged, with the original hash, through the same `verbs.run` path.
   Success → landed. `ALREADY_PENDING` → stays `maybe-sent`; after the undo window the next flush finds the ask
   answered, and step 3 decides whether it was ours. Any other server refusal → `confirm`, reason `refused`,
   with the server's words. A transport error → stays queued, with backoff (15 s, 30 s, 60 s, capped at 60 s).

The server stays the authority, unchanged. It refuses a changed hash and an ask that is not open, whatever the
client checks. The client's check exists to say *why* in words and to avoid a pointless send.

### Re-confirmation

A `confirm` entry is never retried. It shows at the top of the Decisions dashboard as a row: "Not sent: *the
ask* changed since you answered" (or gone, answered elsewhere, archived, refused). Opening it opens the ask's
card, if the ask still exists, with your queued choice and words restored as the draft. You answer again
deliberately, against the current revision. **Discard** drops it. Nothing is applied without a fresh tap.

### Idempotency, stated as invariants

- One entry per ask key. Enqueueing replaces a `queued` entry and is refused for a `maybe-sent` one ("An answer
  to this ask may already have been sent; it is being checked").
- An entry is sent only from step 5, only with its original hash, and only by the single-flight flush.
- A `maybe-sent` entry is resolved only by reading the ask back (step 3). It is never re-sent blind.
- Server-side, `openAsk` (hash and open) and `ALREADY_PENDING` refuse any second application. No server code
  changes.

## Alternatives considered

- **Drafts and resume state stored on the daemon** (a new RPC). Rejected because it is unreachable in exactly the
  offline case, adds a server surface (out of scope: server semantics stay unchanged), and still loses text typed
  while offline.
- **AsyncStorage through `NativeModules.RNCAsyncStorage`** (the host app links it). Rejected because it reaches into
  the host's private native modules, undocumented and removable in any Paseo release; `Settings` is public RN API
  with the same durability on iOS.
- **Rely on the Paseo client's send queue.** Rejected because it holds a request only while `connecting`, times
  out, lives in memory, and knows nothing about stale asks.
- **Re-stamp a stale queued answer with the new hash and send it.** Rejected because it applies an answer the owner
  never saw against the new revision: the exact failure the ticket forbids.
- **Key drafts by `(key, hash)`.** Rejected because any edit to an ask silently drops the owner's text; recording
  the hash and saying "changed" keeps both the text and the safety.
- **Persist the whole React Query cache** for an offline view. Rejected because it is large, its shape is internal to
  every read, and stale reads are already labelled; persisting only what the owner made (place, drafts, answers) is
  small and ours.

## Non-goals

- **A cold start with no link** ("Plugin host is offline"): the host does not mount the plugin, so nothing of
  ours can run. That needs Paseo to cache the plugin catalog (an upstream ask, filed separately).
- **Offline verbs other than answering an ask** (Approve, Skip-to-later, prompts, dispatch). The ticket asks for
  answers; other verbs keep failing loudly.
- **Android durability.** Memory only until the host offers storage. The owner's phone is an iPhone.
- **Syncing drafts between devices.** Drafts are per device by design: the desktop and the phone never fight
  over a half-typed note.
- **Any change to `ask.answer`, the validator or landing.** Explicitly out of scope.

## Risks and trade-offs

- **Settings is shared with the host app.** A Paseo bug that clears user defaults would clear our drafts. The
  namespace prevents collisions, not that.
- **A draft restored onto a changed ask can mislead.** The "changed since you wrote this" line is the
  mitigation. The alternative, dropping the text, is the reported failure.
- **"Queued" can sit for a long time.** The chip and the 14-day draft sweep bound it. A queued entry never
  expires silently: past 24 h it turns `confirm` with reason `stale`, because an answer the owner gave a day
  ago deserves a look before it is sent.
- **Classifying errors by message text** couples us to the host's wording. The classifier lives in one function
  with tests per message. An unknown message defaults to *not queued*, the safe side: a lost answer the owner
  sees, never a double send.

## Open questions

- Does `Settings` round-trip inside the Paseo iOS app as it does in a stock RN app? It is a default pod, but only the
  owner's phone can prove it. If it does not, iOS degrades to memory (navigation survives, a reload does not), and
  the receipt says so.
- Should a `confirm` row also notify (a Paseo push)? Not in this arc: the row is visible on the next open.

## Acceptance

PR B:
- `bun test client/phone/resume.test.ts client/kit/durable.test.ts` passes: round-trip, invalid stored values
  parse as empty, key-not-index restore, gone key and gone series, the 14-day sweep, clear on landing (not on
  sent), and an explicit `params.tab` beating the restored tab.
- Shell render test: unmount and remount the phone surface, and the same tab, open card, ask and draft come
  back in under 2 renders.
- Live (402×874 hidden window, CDP): open a fixture ask, pick Other, type 20 characters, navigate to a session
  and back. The card is on the same ask with the same 20 characters. Then `paseo plugin reload maestro`: the
  same again.
- Each fix is mutation-proven (drop the restore, drop the sweep, key by index).

PR C:
- `bun test client/phone/outbox.test.ts` passes: classification per error message, one entry per key, all five
  flush branches, `maybe-sent` resolved by read-back only, single flight under two concurrent flushes,
  24 h → confirm.
- Live: with the link cut (the sandbox daemon stopped, or a fault-injected `invoke`), answer a fixture ask and
  see "Queued". Restore the link and see it land within 15 s. Change the fixture ask's text while it is queued:
  after reconnect it shows "Not sent: changed", and the ledger has no answer written.
- Mutation-proven: a send with a re-stamped hash, skipping the read-back for `maybe-sent`, dropping the single
  flight.
