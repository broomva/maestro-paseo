**Context.** We run Paseo 0.11.1 with a plugin (Maestro) that orchestrates many agent sessions and surfaces the items that need a human: approvals, questions, owner steps. The human is often away from the Mac and works from the iOS app.

**What happens today (0.11.1, from reading the shipped code):**
- Push payloads are `{to, title, body, data, sound}`, with no `categoryId` (`server/push/push-service.js`).
- Titles are fixed per attention reason, and bodies are the first 220 characters (`protocol/agent-attention-notification.js`).
- Tapping routes only to an agent or terminal (`buildNotificationRoute`). The app registers no notification categories, so no push can carry buttons.
- Plugins have no notify API, so the only way a plugin reaches the phone is to own a provider session and end a turn, or raise a permission. Even a permission push has no Allow/Deny on the notification itself.
- Push requests carry no responder identity, so a plugin can't tell a human's answer from an agent's `respond_to_permission`.

**Ask 1 (minimal, helps every Paseo user):** put Allow/Deny on permission pushes.
- Register an iOS/Android notification category for `reason: "permission"` whose actions are the request's `actions` (or Allow/Deny by default), and send `categoryId` with the push.
- Handle the action in the background and call `respondToPermission` with `selectedActionId`, without opening the app. Set `authenticationRequired: true` on allow-type actions, so Face ID guards approvals from the lock screen.
- Do the same on the macOS desktop notification (Electron `Notification` `actions`).

**Ask 2: responder identity on permission responses.** Pass `{clientId, deviceType, principal, via: "push-action"|"app"|"mcp"|"cli"}` with the response to providers and lifecycle hooks, so a plugin can accept a human-only verb only from a human.

**Ask 3: a plugin notify API.**
- Call shape: `server.notify({ id, title, body, category?, actions?: [{ id, label, destructive?, authenticationRequired?, textInput? }], target?: { kind: "agent", agentId } | { kind: "plugin", route, params }, threadId?, collapseId?, ttlSeconds? })`.
- Return: `{ delivered: "push" | "in-app" | "none", reason? }`.
- Action presses come back through `server.onNotificationAction(handler)` with `{ notificationId, actionId, text?, responder }`.
- Apply the same presence policy as attention, but don't skip delegated agents; the plugin decides what is worth a push.

**Ask 4: plugin deep links.** `paseo://h/<serverId>/plugin/<pluginId>/<route>`, also usable as a push `target`, so a tap lands on the exact item rather than on a session.

**Ask 5 (small):** expose the push-token lease state. A 48 h lease renewed only by opening the app can silently stop phone pushes. Either show "push will stop in N h" in the app, or renew from background fetch.

**Why it matters (our measurements):**
- Across 678 sessions, 27% of agent stops reach for the human.
- Approvals queued for the human wait a 409 min median, yet resolve in 0.5 min once the human is in front of them.
- The human picks the recommended option 64% of the time, which is a one-tap decision.
- On 2026-10-09, six sessions in Always-ask mode stopped on their first command within 50 s of each other and no push reached the phone. A lock-screen Deny would have ended each in one tap.

**Compatibility.** Ask 1 needs no plugin changes. Asks 2-4 are additive to the plugin SDK. We already build against the provider `session.permission` contract and can test any beta.

**Related:** #2622 (iOS background suspension suppresses pushes inside the 180 s presence window), #4841 (stale presence suppresses permission banners), #306 (quick permission approvals from the watch, closed). Ask 1 would also give #306's use case a lock-screen path.

## Also needed by the interim design (BRO-3005)

These come from a read of the 0.11.1 host. Evidence: `paseo-plugin-capabilities.md` in the same folder.

- **Deep links to plugin screens.** Today `paseo://` reaches only agents, so a push cannot open the screen where the decision lives.
- **Sheet options for `Modal`.** Detents, size, and presentation from a source rect, so a sheet can grow from the card that opened it.
- **A shortcut registration API.** Plugins currently listen for `keydown` while focused, and only on web.
- **Haptics** for plugins. Paseo already ships expo-haptics.
- **An appearance flag** (light or dark) in the plugin theme, next to the 11 colors.
- **Native blur.** Electron vibrancy or a blur view for plugins, if translucent chrome is ever wanted.

