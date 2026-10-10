# Notifications: how Maestro can reach the owner in one tap (BRO-2980, answer A5)

Agent-read research note, written 2026-10-09. The owner's answer A5 (`.control/asks/maestro-next-design.yaml`, A5, answered 16:01:56Z):
"Draft the request for Paseo … lets also spawn a subagent that traverses and /mod-anything to find how can we plug into the existing notifications setup".

The question: which channels could put an Allow / Deny / Answer / Open on the owner's phone or Mac that he can act on in one tap, and how does Maestro plug into what already exists?

Method: read-only. The Paseo app bundle was extracted to a scratch `mktemp -d` dir with `npx @electron/asar extract`. Paths below written `app.asar:<path>` are inside `/Applications/Paseo.app/Contents/Resources/app.asar`. `app-dist:` means `/Applications/Paseo.app/Contents/Resources/app-dist/_expo/static/js/web/index-abadf3b49254b04e0d7c8630abdf7fbe.js`, the Expo web bundle; the iOS binary is not on this Mac. Nothing was sent: no test push and no Expo call.

## Versions (verified)

| Thing | Version | Evidence |
|---|---|---|
| Paseo desktop app | 0.11.1 | `/Applications/Paseo.app/Contents/Info.plist` CFBundleShortVersionString |
| Paseo CLI | 0.11.1 | `paseo --version`; `/opt/homebrew/bin/paseo` → `/Applications/Paseo.app/Contents/Resources/bin/paseo` |
| Running daemon | 0.11.1, from 2026-10-09T13:49:45Z (0.10.3 before) | `~/.paseo/daemon.log` `daemonVersion` field |
| Plugin SDK bundled in the app | `@getpaseo/plugin`, `protocol`, `server`, `client` 0.11.1 | `app.asar:/node_modules/@getpaseo/*/package.json` |
| Plugin SDK Maestro builds against | `@getpaseo/plugin` 0.8.0, `@getpaseo/protocol` 0.8.0 | `~/broomva/apps/maestro-paseo/package.json` devDependencies |
| Claude Code (fleet binary) | 2.1.295 | `~/.local/bin/claude --version` |
| Installed mods | secret-shield, token-ledger, bstack-snapshot (source commit db00fd24e) | `~/.local/share/broomva-mods/`, `.source-commit` |
| Orca (another agent app with hooks in user settings) | 1.4.199 | `/Applications/Orca.app/Contents/Info.plist` |

**Memory is stale on two points.** It says pushes come from "finished, error, permission" (0.10.3). In 0.11.1, `error` no longer pushes, and a push is skipped whenever any client was active in the last 180 s. See §1.

## 1. Paseo's push path in 0.11.1, as the code reads

1. **Trigger.** `AgentManager.broadcastAgentAttention(agent, reason)` returns early when `isDelegatedAgent(agent)` is true, i.e. the agent carries the `paseo.parent-agent-id` label (`app.asar:/node_modules/@getpaseo/server/dist/server/server/agent/agent-manager.js` ~L3537). Permission attention fires only on the *first* pending permission of a non-internal agent (`onStreamPermissionRequested`, ~L3266).
2. **Who receives it.** `WebSocketServer.broadcastAgentAttention` (`…/server/websocket-server.js` ~L1899-1975) passes `isPushEligibleAttentionReason(reason)`, which is `reason !== "error"`, into `computeNotificationPlan` (`…/server/agent-attention-policy.js`):
   - if a client focused on that agent is visible, nothing is sent;
   - if any client was active within `PRESENCE_THRESHOLD_MS = 180000`, the most recent one gets an **in-app** notification and there is **no push**;
   - otherwise it pushes.
3. **Payload.** `buildAgentAttentionNotificationPayload` (`app.asar:/node_modules/@getpaseo/protocol/dist/agent-attention-notification.js`) sets:
   - **title:** fixed per reason: "Agent finished", "Agent needs permission", or "Agent needs attention";
   - **body:** the first 220 characters (`NOTIFICATION_PREVIEW_LIMIT`), markdown stripped, of either the last assistant message (finished) or the permission's `title - description` (permission). The fallbacks are "Finished working." and "Permission requested.";
   - **data:** `{serverId, workspaceId, agentId, reason}`.
4. **Transport.** `PushService.sendPush` (`…/server/push/push-service.js`) POSTs to `https://exp.host/--/api/v2/push/send` with exactly `{to, title, body, data, sound: "default"}`. There is no `categoryId`, so iOS has nothing to attach action buttons to.
5. **Tokens.** `~/.paseo/push-tokens.json` (mode 600) holds one `ExponentPushToken` with a 48 h lease (`PUSH_TOKEN_LEASE_MS`, `…/push/index.js`). Its current expiry is 2026-10-10T16:50Z. The lease renews only when that phone's app heartbeats (`session.js handleClientHeartbeat`). **If the owner does not open Paseo on the phone for 48 h, phone pushes stop silently.**
6. **On the phone, a tap opens the agent; there is no Allow/Deny on the notification.** The client's response listener reads `content.data` and calls `navigateToAgent`, or `buildNotificationRoute(data)`, which routes only to `agent:<id>`, `terminal:<id>` or the host root (`app-dist`, offset ~7372268 and ~19262062). The bundle has 0 occurrences of `actionIdentifier`, `categoryId` or `categoryIdentifier`. `setNotificationCategoryAsync` appears only as the expo-notifications library export, which is never called. **A permission push does not carry Allow/Deny on iOS** (verified from the server payload and the shared RN client; the iOS binary itself was not inspected).
7. **On the Mac.** Electron's `paseo:notification:send` (`app.asar:/dist/features/notifications.js`) builds `new Notification({title, body, icon, silent})` with no `actions`; a click focuses the window and routes `data`. The URL scheme `paseo` is registered (`Info.plist` CFBundleURLTypes). The only deep link is `paseo://h/<serverId>/agent/<agentId>` (`app.asar:/node_modules/@getpaseo/protocol/dist/agent-deep-link.js`), so plugin surfaces can't be linked to.
8. **Plugin API.** There is no notify, push or notification API for plugins in either SDK:
   - 0.8.0 `.d.ts`: `PluginServerContext` = `registerSettings`, `handle`, `registerProvider`, `on`, `before` (`node_modules/@getpaseo/plugin/dist/server/contracts.d.ts`). The client has `useToast()`, which is in-app only (`client/react-native.d.ts`).
   - 0.11.1 bundled JS adds usage sources and `spawnProcess`, still no notify. In `app.asar:/node_modules/@getpaseo/server/dist/server/server/plugins/index.js`, `notify` is the host's internal change listener, not a user notification.
   - `@getpaseo/client` has `registerPushToken` and `respondToPermission`, but no send-push.
9. **The provider permission path exists and is unused by Maestro.** This is the important finding.
   - A plugin provider may emit `{type: "session.permission", sessionId, request}`. The request is `ProviderPermissionRequest` = `{id, name, kind: "tool"|"plan"|"question"|"mode"|"other", title?, description?, input?, actions?: [{id, label, behavior: "allow"|"deny", variant?, intent?}]}` (`node_modules/@getpaseo/plugin/dist/server/provider.d.ts` L326-355).
   - The daemon translates it into `permission_requested` (`app.asar:…/server/agent/plugin-provider.js` L1082, L1139), and that raises `"permission"` attention.
   - The app's permission sheet draws the `actions` as buttons and answers with `selectedActionId` (`app-dist`: `behavior:"deny",selectedActionId:e.id,message:"Denied by user"`).
   - The answer comes back to the provider as the `session.permission` input. Maestro's inbox ignores it today: `case "session.permission": return;` in `server/inbox.ts`.
   - The provider must declare the `permission` capability (`PROVIDER_CAPABILITIES`).
   - This chain is read from code only; it has **not** been exercised live.

**Measured (logs).**
- `~/.paseo/daemon.log` holds 21 "Sending push notification" lines from 02:53Z to 13:38Z on 0.10.3, then **0 from the 0.11.1 start (13:49:45Z) to 16:13Z**.
- That includes 14:25-14:50Z, when six Maestro-started sessions in Always-ask mode sat waiting (§ Evidence).
- Logs don't record attention events, so the cause is unproven. Two hypotheses: the owner's desktop client counted as present (the 180 s rule, which is correct behaviour), or presence is reported in a way that suppresses every phone push while the Mac app runs. **Verify before building on pushes** (Option 0).

## 2. What Maestro does today (inbox push, maestro-paseo #30 → reverted #35 → relanded #36 fafe644)

`~/broomva/apps/maestro-paseo/server/inbox.ts`, wired in `index.server.ts` L87-108:

- **Mechanism.** Maestro registers a provider `maestro-inbox` and keeps one session on it, titled "Maestro · Needs you". The session id is in `~/.config/maestro-paseo/inbox.json`, currently `9aab8ebf…`.
  - Each landing at the owner's gate becomes a turn: Maestro sends a prompt carrying a "Maestro notice" attachment.
  - The provider answers with one `assistant_message` (`**Needs you** · <title>\n\n<ask>`) and a `maestro-gate` plugin timeline card.
  - The turn ends with `finished` attention, so the push reads **"Agent finished"** + the first 220 characters of that message.
- **Tap path.** A tap opens the inbox session. The gate card offers Approve / Send back, or Allow / Deny for a worker's permission (`client/gate-card.tsx` L214-285; Allow/Deny call `paseo.agents.ref(target).respondToPermission`). So it is **two taps after the app opens**: the notification, then the card button.
- **Limits:**
  - the title is always "Agent finished", whatever the kind;
  - attention fires once until the session is opened, so an unread inbox is archived and a fresh one is created after `BURST_MS` = 10 min;
  - an orchestrator's own landing waits `ORCHESTRATOR_GRACE_MS` = 15 min and pushes only if it is still at the gate;
  - only landings are pushed. Asks in `.control/asks`, owner steps and Health are not;
  - it is subject to every Paseo rule in §1: the 180 s presence rule, the 48 h token lease, and no actions.
- **Measured.** All 33 "inbox notice" lines in `~/.paseo/daemon.log` and `20261008-2137-01-daemon.log` read "its orchestrator took it within the grace; no push". A successful send logs nothing in Maestro, so its delivered count cannot be read from the logs.

## 3. Claude Code: PushNotification, hooks, mods

- **PushNotification tool.** Input `{message, status: "proactive"}`; output `{pushSent?, localSent?, disabledReason?: "config_off"|"user_present"|"no_transport"}`. Source: the 2.1.295 typings, `/private/tmp/claude-501/bundled-skills/2.1.295/…/plugin-authoring/types/claude-code.d.ts` L16514, L20894.
  - Found in 9 transcripts under `~/.claude/projects`. Every result readable was unsent: `no_transport` ×2, `user_present` ×1.
  - It is not a working channel for Paseo-spawned sessions. reach-taxonomy cluster 19 also lists it as dormant.
- **Notification hooks.**
  - Project `.claude/settings.json` has `Notification` → `scripts/conversation-bridge-hook.sh`, which is the P1 bridge, not a notifier.
  - User `~/.claude/settings.json` has `PermissionRequest` → Orca's hook (`~/.orca/agent-hooks/claude-hook.sh`). It prints `{}` and forwards only when `ORCA_PANE_KEY`/`ORCA_AGENT_HOOK_PORT` are set, i.e. inside Orca panes. Under Paseo it is a no-op.
  - No `preferredNotifChannel` is set in `~/.claude/settings.json` or `~/.claude.json`.
- **Mods (2.1.295 API, same typings file).**
  - **Toast, pane and status line are not shown under Paseo.** Paseo runs Claude Code headless (stream-json, `--permission-prompt-tool stdio`); "a mod's hooks run and nothing it draws is shown" (`~/.local/share/broomva-mods/README.md`, "Under Paseo").
  - **`$.ui.notify`** goes through `preferredNotifChannel`, which is limited to terminal channels (iterm2, kitty, ghostty, bell). With no terminal it returns `no-surface` and only Notification hooks run (types L2448-2465, L14079-14110). That is no help for a phone.
  - **`tool.check`** is the permission decision point: "after the `tool.call` and PreToolUse hooks and before the mode settles an ask". It returns `{decision: "allow"|"ask"|"deny"}` (L3967, L12859).
  - **`$.http.fetch(url, {socketPath})`** can reach a Unix socket such as `~/.config/maestro-paseo/maestro.sock` (L3469-3490). An awaited `$` call does not spend the hook's time budget (`reference.md` "Work that outlives a dispatch").
  - **What a mod could do.** On `tool.check` with an `ask` verdict, it could post the ask to Maestro and await the owner's answer. That turns Claude Code permission prompts into Maestro Approvals with one source of truth.
  - **What a mod cannot do.** It can't put anything on the phone itself.
  - **Mod risk.** An `allow` from a mod bypasses the PreToolUse gate and deny rules (memory entity `claude-code-mod-answering-tool-call-bypasses-gate-and-deny-rules`, measured for `tool.call`). Such a mod should only ever pass through `ask` or return `deny`.
  - **Mod redundancy.** Paseo already surfaces Claude permission prompts natively: permission attention plus Maestro's Allow/Deny card. Today 500 of 575 Paseo agents run `bypassPermissions` (reach-taxonomy cluster 9).
  - **Verdict:** no mod can answer an approval from the phone in one tap. A mod is at best a router into Maestro, not a delivery channel.
- **Paseo terminal attention (`paseo hooks`).**
  - Terminal attention pushes "Terminal needs input" / "Terminal finished", with the *terminal's name* as the body, and is always push-eligible (`websocket-server.js` `broadcastTerminalAttention`).
  - It is fed by Claude hooks installed only when `enableTerminalAgentHooks` is on. The default is `false` (`config.js` L391), and it is not set in `~/.paseo/config.json`.
  - It is a hack path (title via terminal name, no actions) and is not recommended.

## 4. bstack notifiers

| Notifier | Channel | State on this Mac | Evidence |
|---|---|---|---|
| `~/.claude/skills/p9/scripts/p9-escalate-notify.sh` | appends a line to `~/.config/broomva/p9/escalations.log` | log-only; last write Jul 26 | the script (22 lines) |
| `p9 notify` (`~/.claude/skills/p9/scripts/p9.py` `notify`, `_deliver_ntfy`, L2615-2740) | ntfy / webhook / command, from `~/.config/broomva/p9/notify.json` or `BROOMVA_P9_NTFY_TOPIC` | **no channel configured**: no `notify.json`, env unset. `notify.jsonl` holds 2,299 rows with **1** successful delivery (a `command` channel) | `~/.config/broomva/p9/` |
| `scripts/bookkeeping-scheduled.sh`, `scripts/kg-land-drive.py` | call `p9 notify` / the p9 escalate hook | inherit the above | grep L82, L176 / L460 |
| `scripts/ticket-dispatch/config.env.template` | documents an ntfy topic for `p9 notify` | template only | L78-84 |

## 5. Native macOS/iOS channels already here (checked, nothing installed)

| Channel | Present? | Notes |
|---|---|---|
| `osascript display notification` | yes, `/usr/bin/osascript` | Mac banner only, no actions. Ruled out by owner policy (below) |
| `terminal-notifier`, `alerter` | not found | |
| `shortcuts` CLI | yes, `/usr/bin/shortcuts`, 28 shortcuts | none named for notifications or approvals; Shortcuts on the Mac cannot push to the iPhone without a service |
| ntfy / Pushover CLIs | not found; no `NTFY_*`/`PUSHOVER_*` env | p9 has ntfy delivery code but no topic |
| Telegram bot | `~/.claude/channels/telegram/.env` holds `TELEGRAM_BOT_TOKEN` (Jun 12) | no `access.json` (no paired chat); no telegram plugin enabled. Telegram, Discord and Slack apps are installed. Inline-keyboard buttons would be a true one-tap |

**Owner policy** (memory `owner-notifications-via-paseo-app.md`, decided 2026-10-01): owner reaches go through Paseo (sessions, asks, Maestro "Needs you"). Desktop-only channels (macOS dialogs, banners, logs) are out, and ntfy is out unless the owner re-opens it.

## What exists

| Channel | Who triggers it | What it can carry | One tap from the notification? | Evidence |
|---|---|---|---|---|
| Paseo agent attention push (phone) | daemon, on a non-delegated agent's `finished`/`permission` (not `error` since 0.11.1); no client active within 180 s | fixed title by reason; body = 220 chars; data → opens that agent | No. A tap opens the agent, then a second tap on Allow/Deny | `agent-attention-notification.js`, `push-service.js`, `agent-attention-policy.js` |
| Paseo in-app / desktop notification (Mac) | same, when a client is present | title, body; click routes to the agent | No (Electron `Notification` without `actions`) | `app.asar:/dist/features/notifications.js` |
| Paseo terminal attention push | Claude hooks in Paseo terminals (`enableTerminalAgentHooks`, off) | "Terminal needs input/finished" + terminal name | No | `websocket-server.js` `broadcastTerminalAttention`; `config.js` L391 |
| Maestro inbox session (#36) | Maestro, on a landing at the owner's gate | "Agent finished" + `Needs you · <title>` + gate card | No: push → inbox → card button | `server/inbox.ts`, `client/gate-card.tsx` |
| Provider permission request (unused) | a plugin provider (Maestro's inbox could) | "Agent needs permission" + `title - description` (220 chars); in-app sheet with **custom action buttons**; answer returns to the plugin | No on the notification. Yes, one tap on the sheet once open | `provider.d.ts` L326-355; `plugin-provider.js` L1139; `agent-manager.js` ~L3266 |
| Plugin client toast | Maestro client code | text, variant | In-app only, no push | `client/react-native.d.ts` `useToast` |
| Claude Code PushNotification | the model | ≤200 chars | No; never delivered here (`no_transport`) | typings L16514/L20894; transcripts |
| Claude Code mods (toast/pane/notify) | mod hooks | text | Not shown under Paseo; `notify` → `no-surface` | broomva-mods README; typings L2448 |
| Claude Code mod `tool.check` + `$.http.fetch` socket | mod, on a permission ask | anything Maestro accepts | Router only, not a channel | typings L3967, L3469 |
| p9 notify | p9, bookkeeping, kg-land-drive | title, body via ntfy/webhook/command | ntfy supports action buttons, but none is configured; 1/2,299 delivered | `p9.py` L2615-2740; `notify.jsonl` |
| Telegram bot | (not wired) | text + inline buttons → callback | Yes, if wired, but it is a second channel outside Paseo | `~/.claude/channels/telegram/.env` |
| osascript banner | any script | title, body | No, and Mac-only | `/usr/bin/osascript` |

## The gap to one-tap Allow / Deny

1. **The notification itself has no buttons.** Paseo's Expo payload carries no `categoryId`, and the app registers no notification categories. No plugin, mod or hook can add buttons to a Paseo push. **Only Paseo can close this.**
2. **No plugin can push with its own words.** Plugins have no notify API. The only levers are agent attention (fixed titles) and its 220-character body.
3. **The tap can't land on a Maestro item.** Deep links and push `data` route only to an agent or terminal, so a tap lands on the inbox session, not on a Maestro card or surface.
4. **Delivery is fragile:**
   - delegated agents are never pushed;
   - presence within 180 s suppresses the push;
   - the phone token lapses after 48 h without opening the app;
   - 0 pushes since the 0.11.1 upgrade (cause unverified).
5. **Responder identity.** A permission response does not say *who* answered. `ProviderPermissionResponse` has no responder field, and any agent with the Paseo MCP (`respond_to_permission`) or `paseo permit` can answer. Gate verbs are owner-only by design (`maestro.sock` refuses them; ask A10), so an Approval routed through a permission sheet would open an agent-side door.

## Options, ranked cheapest first

| # | Option | Gets the owner | Effort | Risk |
|---|---|---|---|---|
| 0 | **Verify the push channel on 0.11.1.** With the owner away from all clients for more than 3 min, end a turn in a top-level session and check `~/.paseo/daemon.log` for "Sending push notification". Ask the owner to open the iOS app at least every 48 h, or ask Paseo for a longer lease. | Knowing whether any push reaches the phone today | minutes | none |
| 1 | **Inbox raises permission requests instead of "finished" turns,** for items that are Approvals or Asks. Declare the `permission` capability in `inbox.ts` and emit `session.permission` with `kind: "question"`, `title` = headline, `description` = the exact action, and `actions` = Approve/Send back or Allow/Deny or the ask's options. Handle the `session.permission` input by `selectedActionId`. | Push titled **"Agent needs permission"** with Maestro's own text; tap → Paseo's native sheet with Maestro's buttons → one tap answers. **2 taps, all inside Paseo**, honours the owner's channel policy, and works with 0.8.0 types | S (inbox.ts + tests, ~1 day) | Medium:<br>(a) any agent with Paseo MCP could answer, so use it **only for kinds an agent may answer anyway** and never for gate or authority verbs until Paseo reports the responder;<br>(b) attention fires on the *first* pending permission only, so it needs one inbox session per open item or the existing burst/rotate logic;<br>(c) not yet exercised live |
| 2 | **Keep the #36 inbox but title the notice by kind** (body starts "Approval · …", "Ask · …"), and widen it to ledger asks and owner steps | Better triage from the lock screen; still 2+ taps | XS | low |
| 3 | **Claude Code mod, `tool.check` → maestro.sock** (pass `ask` through, or wait for an answer and return `deny`/`ask` only) | Claude permission prompts become Maestro Approvals; no phone gain by itself | M | Medium-high: a mod `allow` bypasses gates and deny rules; Paseo already relays these prompts |
| 4 | **Direct Expo push from Maestro** using the token in `~/.paseo/push-tokens.json` and `data {serverId, workspaceId, agentId}` | Custom title and body; tap opens the inbox. **Still no buttons** (the app registers no categories) | S | High: reuses Paseo's credential outside its API, bypasses the presence rule, may hit Expo access-token enforcement (unverified), breaks silently on Paseo changes. Not recommended |
| 5 | **Telegram bot with inline buttons** (token exists; pair a chat; callback → Maestro RPC) | True one tap from the lock screen | M | Needs the owner to re-open channel policy (Paseo-only, 2026-10-01). A second inbox to keep in sync; bot-token custody |
| 6 | **ntfy with action buttons via `p9 notify`** | One tap if the phone can reach an endpoint on the Mac | M | Owner ruled ntfy out; needs a reachable endpoint (tunnel) and an auth design |
| 7 | **Paseo feature request** (draft below) | Real one-tap Allow/Deny on the lock screen and Mac banner, plugin-authored text, deep links into Maestro | Paseo's effort; ours XS to file | External dependency; timeline unknown |

**Recommendation.**
- Do **0 now**.
- Build **1** for Ask-class and agent-answerable items, with **2** as the free improvement for the rest.
- **File 7**, leading with the minimal ask (Allow/Deny actions on permission pushes plus responder identity). Paired with Option 1, that alone makes every Maestro Approval one tap from the lock screen.
- Keep **5** as the fallback only if the owner re-opens the channel policy.

## Evidence that it matters

- **13b97ad9 (2026-10-09; Paseo session `13b97ad9-227b-4715-a7b9-b455a9ea78fa`; frame D2; ask A8):** six answers whose askers were gone became six Maestro runs.
  - They were created 14:29:47Z-14:30:35Z (`~/.paseo/agents/*/`: a9ab2693, 461542bc, 5a090957, e39b1da2, 5476db4d, 57971c77), each in mode `default` (Always ask), with only a `maestro.work` label. They were not delegated, so they were push-eligible.
  - Each stopped on its first command.
  - `~/.paseo/daemon.log` has **no push between 14:25Z and 14:50Z**. The owner found them by opening the app and asked a session what happened at 14:43Z.
  - With one-tap actions, each Always-ask stop would have been a lock-screen Deny (or Allow) instead of six look-alike sessions discovered later.
- **A10 (same ledger):** three dead cards needed a gate verb that only the owner may use. The agent's route (an inspector attach) was refused, so each costs the owner app → Maestro → card → Cancel.
- **reach-taxonomy.md (678 sessions, 11,232 turn ends):**
  - Approvals: AskUserQuestion approval-type 247; Maestro gate 26; prose 187; ledger 73.
  - Ledger approvals wait a **409 min** median (fleet-reconcile, `opened`-based), and ledger asks 131 min (workspace).
  - When the owner is in front of Maestro, tool permissions resolve in a **0.5 min** median (n=20). The cost is reach, not decision time.
  - The owner picked the recommended option in **64.4%** of parsed answers (68.6% for approval-type). Most approvals are a single tap on a known default, the shape that action buttons fit.
  - 27.4% of all stops reach for the owner.

## Draft feature request to Paseo

Repository: `https://github.com/getpaseo/paseo` (from the bundled `package.json` `repository`; license Apache-2.0). The owner sends it, or names where to post it (ask A5: "you send it or let me post it where you choose").

> **Title:** Actionable push notifications: Allow/Deny on permission pushes, and a plugin notify API with action buttons and deep links
>
> **Context.** We run Paseo 0.11.1 with a plugin (Maestro) that orchestrates many agent sessions and surfaces the items that need a human: approvals, questions, owner steps. The human is often away from the Mac and works from the iOS app.
>
> **What happens today (0.11.1, from reading the shipped code):**
> - Push payloads are `{to, title, body, data, sound}`, with no `categoryId` (`server/push/push-service.js`).
> - Titles are fixed per attention reason, and bodies are the first 220 characters (`protocol/agent-attention-notification.js`).
> - Tapping routes only to an agent or terminal (`buildNotificationRoute`). The app registers no notification categories, so no push can carry buttons.
> - Plugins have no notify API, so the only way a plugin reaches the phone is to own a provider session and end a turn, or raise a permission. Even a permission push has no Allow/Deny on the notification itself.
> - Push requests carry no responder identity, so a plugin can't tell a human's answer from an agent's `respond_to_permission`.
>
> **Ask 1 (minimal, helps every Paseo user):** put Allow/Deny on permission pushes.
> - Register an iOS/Android notification category for `reason: "permission"` whose actions are the request's `actions` (or Allow/Deny by default), and send `categoryId` with the push.
> - Handle the action in the background and call `respondToPermission` with `selectedActionId`, without opening the app. Set `authenticationRequired: true` on allow-type actions, so Face ID guards approvals from the lock screen.
> - Do the same on the macOS desktop notification (Electron `Notification` `actions`).
>
> **Ask 2: responder identity on permission responses.** Pass `{clientId, deviceType, principal, via: "push-action"|"app"|"mcp"|"cli"}` with the response to providers and lifecycle hooks, so a plugin can accept a human-only verb only from a human.
>
> **Ask 3: a plugin notify API.**
> - Call shape: `server.notify({ id, title, body, category?, actions?: [{ id, label, destructive?, authenticationRequired?, textInput? }], target?: { kind: "agent", agentId } | { kind: "plugin", route, params }, threadId?, collapseId?, ttlSeconds? })`.
> - Return: `{ delivered: "push" | "in-app" | "none", reason? }`.
> - Action presses come back through `server.onNotificationAction(handler)` with `{ notificationId, actionId, text?, responder }`.
> - Apply the same presence policy as attention, but don't skip delegated agents; the plugin decides what is worth a push.
>
> **Ask 4: plugin deep links.** `paseo://h/<serverId>/plugin/<pluginId>/<route>`, also usable as a push `target`, so a tap lands on the exact item rather than on a session.
>
> **Ask 5 (small):** expose the push-token lease state. A 48 h lease renewed only by opening the app can silently stop phone pushes. Either show "push will stop in N h" in the app, or renew from background fetch.
>
> **Why it matters (our measurements):**
> - Across 678 sessions, 27% of agent stops reach for the human.
> - Approvals queued for the human wait a 409 min median, yet resolve in 0.5 min once the human is in front of them.
> - The human picks the recommended option 64% of the time, which is a one-tap decision.
> - On 2026-10-09, six sessions in Always-ask mode stopped on their first command within 50 s of each other and no push reached the phone. A lock-screen Deny would have ended each in one tap.
>
> **Compatibility.** Ask 1 needs no plugin changes. Asks 2-4 are additive to the plugin SDK. We already build against the provider `session.permission` contract and can test any beta.

## Open items

- **The zero-push window since 13:49:45Z.** Owner presence or a 0.11.1 regression? Run Option 0.
- **Expo access-token enforcement** on Paseo's project. Matters only for Option 4: unverified, and not tested because that would mean sending.
- **Whether the iOS build matches the web bundle** on notification categories. Only the web/Electron bundle and the server payload were inspected; the server sends no `categoryId`, which settles it either way for today.
- **The `plugin-authoring` skill path.** `~/.claude/skills/plugin-authoring/SKILL.md` does not exist. The skill is bundled with Claude Code 2.1.295 (`/private/tmp/claude-501/bundled-skills/2.1.295/…/plugin-authoring/`), and its typings were read there.
