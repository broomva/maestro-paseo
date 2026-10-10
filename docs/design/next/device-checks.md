# Device checks: the Paseo facts the J/M build rests on (BRO-3033)

Date: 2026-10-10. Host: Paseo 0.11.1 (desktop app, daemon and CLI; iOS app built from the `v0.11.1` tag).
This answers the six questions in BRO-3033 and says what each answer means for BRO-3034 (component kit) and BRO-3037 (M screens).

## Where the evidence comes from

Every row names its surface. In order of strength:

| Label | What it is | Strength |
|---|---|---|
| **desktop (same bundle)** | The sandbox daemon's web client, driven by Playwright (`scripts/dogfood/up.ts` sandbox, probe plugin installed). It serves `index-abadf3b49254b04e0d7c8630abdf7fbe.js`, **the same file the owner's Paseo.app renderer runs** (read over CDP from the real app's window: `paseo://app/h/srv_…/workspace/…`, scripts `["index-abadf3b49254b04e0d7c8630abdf7fbe.js"]`). | Observed, same code as the desktop app |
| **simulator** | Paseo's iOS app built from `getpaseo/paseo@v0.11.1` (`ab10a66`, RN 0.81.5, Expo 54, New Architecture, Release, Hermes) on an iPhone 16 Pro simulator (iOS 26.3.1), connected to the sandbox daemon, touches by AXe. Gesture timing on a simulator is **not** an iPhone's: frame numbers are marked "simulator". | Observed, same source as the App Store build; perf not representative |
| **source** | `getpaseo/paseo@v0.11.1` read at `ab10a66`, cited `path:line`. | Read, not run |
| **real iPhone** | The owner's iPhone over iPhone Mirroring. **Not reached**: the Mac is paired, but Mirroring showed "iPhone in Use. Lock your iPhone to connect" ([`iphone-mirroring-0.jpg`](../../receipts/BRO-3033/iphone-mirroring-0.jpg)), and no phone is set up for interceptor-ios. What only a real phone can show is in [Owner checks](#owner-checks-on-the-real-iphone). | — |

The probe is a separate throwaway plugin, [`scripts/device-probe/`](../../../scripts/device-probe/README.md) (id `maestro-device-probe`), so it never ships inside Maestro. It registers one screen and one sidebar row and shows, on the screen itself: the params it was opened with and its mount count, where the host put it (`measureInWindow`), four gradient swatches, four `PanResponder` cards that count animation frames over 20 ms while dragged and report whether the host terminated the gesture, RN `Keyboard` events, a bottom composer that rides `endCoordinates.height`, and an M1-style tab bar inside RN `SafeAreaView`.

## Summary

| # | Question | Answer | One-line consequence for the build |
|---|---|---|---|
| 1 | What does Paseo draw around a plugin screen on iOS? | **Yes, known: a header only.** Title (string or `title(params)`), a host picker (only with >1 host) and an X close. No menu, no "more", no back chevron, nothing at the bottom, no bottom inset. | M1's tab bar owns the bottom edge, and must clear the home indicator itself. The ☰ and ⋯ drawn in M1's header are not Paseo's: drop them, or draw them inside Maestro's content. |
| 2 | Can `openScreen({ screenId, params })` carry a hold key? | **Yes.** `params` arrive as the `params` prop, strings only, in the URL as `?param.<key>=…`; any characters round-trip; a cold load reads them back. Each call pushes a **new instance** (remount); earlier ones stay mounted, hidden. | The deck and inspector open on `params.hold` at mount. Inside an open Maestro, move by state, not by another `openScreen`. |
| 3 | `PanResponder` on the iPhone, JS thread | **Partial.** Leftward and vertical drags are the plugin's. **Rightward drags over ~15 px on compact native are taken by Paseo's sidebar-open gesture, which cancels the plugin's responder.** Frame drops: 0 frames over 20 ms on any leftward or vertical drag (simulator, max 18 ms over 136–137 frames, even with 8 ms of synthetic work per move). | M1's rightward deck swipe and right-swipe-to-Continue on sheet rows cannot ship as drawn. Follow-up filed. |
| 4 | Does the composer (M9) get the keyboard inset from RN `Keyboard` events? | **Partial.** RN `Keyboard` events reach a plugin screen on iOS (`keyboardWillHide`/`keyboardDidHide` with `h=311` arrived in the probe). The host applies **no** inset: the screen keeps its full 748 pt and a bottom view stays put. The composer has to read `endCoordinates.height` and lift itself. Seeing the software keyboard over the composer is left to the owner's phone. | M9's composer (and any bottom input) lifts itself by `endCoordinates.height − bottom inset` from `keyboardWillShow`/`WillHide`, or sits in RN `KeyboardAvoidingView`. Inside the host `Modal` sheet, Paseo handles it. |
| 5 | Gradients for the Undertow | **Desktop: yes** (`backgroundImage` linear and radial render; `experimental_backgroundImage` is dropped by react-native-web). **iOS:** **yes**: `experimental_backgroundImage` linear and radial render; the unprefixed `backgroundImage` does not. | The kit sets **both** keys on every gradient: `backgroundImage` for the desktop, `experimental_backgroundImage` for iOS. The iPhone Undertow can be a real gradient (`boxShadow` rings render too); a still tinted ring is only the fallback. |
| 6 | How Paseo renders the push body Maestro writes | **Partial.** Title "Agent finished"; body = Maestro's notice with markdown stripped and **newlines collapsed to one space**, cut to 220 characters ending `...`; no actions; tap opens the inbox session; nothing when the app is open; no push at all if any Paseo client was active in the last 180 s. The simulator rendered Maestro's exact payloads. | Put a separator into the notice's first line (title and ask now run together). M10 is push → session → card → Open in Maestro; a push never lands in Maestro directly. |

Follow-ups: [BRO-3062](https://linear.app/broomva/issue/BRO-3062) (Paseo upstream: let a plugin keep rightward pans) and [BRO-3063](https://linear.app/broomva/issue/BRO-3063) (Maestro: a separator in the notice so the push reads). No fact is a plain "no". Fact 3's rightward-swipe gap is the one that changes the design, and BRO-3062 covers it.

---

## 1. The chrome around a plugin screen

**Answer: yes, known.** The host draws one header at the top and nothing else.

**Evidence**

- **source.** `packages/app/src/plugins/surface-screen.tsx:217-253` renders `<View style={screen}><ScreenHeader left right/><View style={body}>…plugin…</View></View>`, with `screen: { flex: 1 }` and `body: { flex: 1 }`. It has no SafeAreaView, no `insets.bottom` and no ScrollView.
  - **Left** (`:177-189`): the title, `<ScreenTitle>{title}</ScreenTitle>`, where `title` is the screen's string or `title(params)`.
  - **Right** (`:190-215`): `PluginHostFilter`, shown only when `serverIds.length > 1 && hosts.length > 1`, then an X "Close plugin" that does `router.back()`.
  - **Height:** `components/headers/screen-header.tsx:38-46,77-80` with `constants/layout.ts:9-12`. On a phone the header is `insets.top + 8 + 56` pt; on desktop the row is 36 px.
  - **No bottom navigation exists:** the app is expo-router Stacks only (`app/_layout.tsx:882-906`, `app/h/[serverId]/_layout.tsx:36-47`).
  - **Props:** the plugin gets `theme`, `host`, `layout {compact, platform}`, `navigation` and `params`, and no insets (`surface-screen.tsx:78,175`). `compact` means a window narrower than 720 (`constants/layout.ts:40-43`, `styles/unistyles.ts:6-12`).
- **desktop (same bundle)** ([`desktop-3-open-with-params.jpg`](../../receipts/BRO-3033/desktop-3-open-with-params.jpg)): the header is a 36 px row holding "Probe · ask:7f3e" (the title function applied to the params) and an X. The probe measured `screen top=36 left=320 w=1120 h=864 · window 1440x900 · room below=0`, under a 320 px sidebar.
- **desktop at phone width** ([`web-phone-1-probe.jpg`](../../receipts/BRO-3033/web-phone-1-probe.jpg)): `compact true`, `top=64 … room below=0`. The header is 64 px; nothing at the bottom.
- **simulator**: ([`sim-4-maestro.jpg`](../../receipts/BRO-3033/sim-4-maestro.jpg), [`sim-6-probe-top.jpg`](../../receipts/BRO-3033/sim-6-probe-top.jpg)) The real Maestro screen gets `▦ Maestro … ✕`: an icon (Maestro registers through the legacy `addSidebarItem`), the title and Close. Nothing else, and nothing at the bottom. The probe measured `platform ios · compact true · RN ios 26.3.1` and `screen top=126 left=0 w=402 h=748 · window 402x874 · room below=0`: the header takes 126 pt, and the plugin runs to the physical bottom edge, under the home indicator. An RN `SafeAreaView` around an M1-style 49 pt tab bar padded it above the home indicator (the purple strip in the shot).

**Consequences**

- **BRO-3037 M1.** The tab bar can sit at the bottom edge: Paseo draws nothing there. It has to pad for the home indicator itself. RN core `SafeAreaView` (from `react-native`, which plugins can import) does it on iOS (simulator, `sim-6-probe-top.jpg`). Android was not checked. `react-native-safe-area-context` is not importable by plugins (`plugins/evaluate.ts:439-463`).
- **BRO-3037 M1–M11 headers.** The frames draw `☰ Maestro ⋯` as the top bar. On the phone, Paseo's header holds the title and an X, and Maestro cannot add buttons to it. So the deck header ("Needs you · All · Present") is the first row of Maestro's own content, under Paseo's header.
  - The ☰ has no host equivalent. Paseo's sidebar opens with a full-screen right swipe (fact 3); there is no host menu button.
  - The ⋯ menu, if kept, must be a control in Maestro's own deck header.
  - M1c's title-menu fallback is not needed for the tab bar, because the bottom edge is free.
- **Title.** Use `addScreen({ title: (params) => … })` to say where you are ("Maestro", or "Maestro · Decisions") in Paseo's own header for free.
- **Vertical budget.** On an iPhone 16 Pro the host header costs 62 + 64 = 126 pt before Maestro's first pixel, so M1's deck has `874 − 126 − tab bar − 34 (home indicator)` pt to work with.

## 2. `openScreen` params: can they carry a hold key?

**Answer: yes.**

**Evidence**

- **desktop (same bundle)**, [`desktop-probe.json`](../../receipts/BRO-3033/desktop-probe.json):
  - From the sidebar row, `openScreen({ screenId, params: { hold: "from-sidebar" } })` gave `params {"hold":"from-sidebar"}` at `…/plugin/maestro-device-probe/surface/device-probe?…&param.hold=from-sidebar`.
  - Then `{ hold: "ask:7f3e", tab: "decisions" }` gave `?param.hold=ask%3A7f3e&param.tab=decisions` and `params {"hold":"ask:7f3e","tab":"decisions"}` at `mount #2`.
  - Then `{ hold: "café & co/?#=1 ✓", long: <600 × "x"> }` round-tripped exactly at `mount #3`.
  - Reloading the URL cold rebuilt `params {"hold":"ask:7f3e","tab":"decisions"}` (`mount #1`).
  - The DOM then held **three** probe instances, with only the newest visible: `[#1 hidden, #2 hidden, #3 visible]`.
- **source**:
  - `plugins/routes.ts:11-27` builds `encodeURIComponent("param." + key) = encodeURIComponent(value)`.
  - `routes.ts:31-44` throws on a non-string value.
  - `routes.ts:47-56` reads `param.*` back. Repeated keys are dropped.
  - Every caller uses `router.push` (`plugins/sidebar-items/index.tsx:180-195`, `plugins/navigation.ts:26-29`), and the stack has no `getId`, so each call is a new stack entry. Back returns to the previous params.
  - There is no length limit in Paseo code.
  - `paseo://h/<s>/plugin/<id>/surface/<screen>?param.k=v` reaches the route through expo-router's default linking. That path re-decodes values, so `&`, `=`, `#`, `+` and `%` can be corrupted (`expo-router/build/fork/extractPathFromURL.js:95-99`).
  - A push can never target this route (fact 6).
- **simulator**: ([`sim-15-open-with-params.jpg`](../../receipts/BRO-3033/sim-15-open-with-params.jpg)) The same on iOS. The sidebar row opened `params {"hold":"from-sidebar"}` (mount #1). Tapping `hold=ask:7f3e` opened mount #2, titled "Probe · ask:7f3e", with `{"hold":"ask:7f3e","tab":"decisions"}`. Close (X) went **back to mount #1** with its own params. The unicode and 600-character values round-tripped (mount #3, title "Probe · café & co/?#=1 ✓").

**Consequences**

- **BRO-3034 / BRO-3037.**
  - The Maestro screen reads `params.hold` (and `params.tab`) when it mounts and opens the deck or the J1 inspector on that item.
  - Keep `hold` an opaque string key (`view-models.md`'s `key`). Any JSON must be stringified; base64url it if it may ever travel in a `paseo://` link.
- **Don't stack Maestros.** Every `openScreen` adds an instance and keeps the old ones mounted. Inside an already-open Maestro, move between holds and tabs with state (today's `requestIntent` bus, `client/intent.ts`), not with `openScreen`. Keep `openScreen({ params })` for entering from outside: a gate card, a header button, a command, a pill.
  - Module-level state is shared by every mounted instance; `intent.ts` already lets the newest listener take an intent first.
- **The intent bus can shrink.** For a cold open, params replace the 30 s pending-intent dance: the target travels in the route and survives a reload. The bus stays for in-screen moves.
- **M10** is push → the asking session → the gate card's "Open in Maestro" → `openScreen({ screenId: "maestro", params: { hold } })` → M1's deck on that hold. Each link in that chain is verified here, except the push tap on a real phone (fact 6).

## 3. `PanResponder` on the phone, on the JS thread

**Answer: partial.** The plugin owns leftward and vertical drags. On compact native, Paseo takes rightward ones.

**Evidence**

- **source**:
  - On compact layouts the whole stack, plugin screens included, sits inside `MobileGestureWrapper` (`app/_layout.tsx:622-623,652-667`). Its pan opens the agent sidebar.
  - It is enabled on plugin routes (`_layout.tsx:853-868`) and is **not** limited to the edge on native. The 32 px edge limit is web-only (`mobile-panels/gestures.ts:12,55-96`).
  - It activates at `directedDelta >= 15 && |dx| > |dy|` and fails on a leftward or mostly vertical drag (`gesture-intent.ts:17-22`).
  - When a gesture-handler gesture activates, RNGH cancels every JS responder in the root view (`react-native-gesture-handler@2.28.0` `RNGestureHandlerManager.mm:307-312`, `RNRootViewGestureRecognizer.m:63-73`).
  - The host's opt-outs (`horizontalScroll.isAnyScrolledRight`, `setOpenGestureBlocked`) are not exposed to plugins.
  - iOS's left-edge swipe-back also stays on for plugin routes: `gestureEnabled` defaults to true (`h/[serverId]/_layout.tsx:8-13,45`).
- **simulator**: ([`sim-9-gestures.jpg`](../../receipts/BRO-3033/sim-9-gestures.jpg), [`sim-5-midscreen-right-swipe.jpg`](../../receipts/BRO-3033/sim-5-midscreen-right-swipe.jpg)) AXe drags, 0.8 s each:

  | Drag | Result |
  |---|---|
  | deck, leftward 260 pt | released, vx −0.22; 136 frames, 0 over 20 ms, max 18 ms |
  | deck, **rightward** | **`TERMINATED by host at dx=12`**, 2 frames; Paseo's sidebar slid in |
  | sheet, down 200 pt | released, vy 0.19; 137 frames, 0 over 20 ms |
  | deck with +8 ms JS work per move, leftward | released; 136 frames, 0 over 20 ms, max 18 ms |
  | row inside a vertical ScrollView, leftward | released; 137 frames, 0 over 20 ms |
  | same row, **rightward** | **`TERMINATED by host at dx=12`**; sidebar opened |
  | right swipe from mid-screen on the real Maestro screen | the sidebar opened |

  The frame counts are a simulator on an M-series Mac, not an iPhone; they show the JS-thread path is not obviously heavy, nothing more.
- **desktop (same bundle)**, headless Chromium ([`desktop-4-gestures.jpg`](../../receipts/BRO-3033/desktop-4-gestures.jpg)): deck x, sheet y, deck x with 8 ms of synthetic work per move, and a row inside a vertical ScrollView. All four released normally with 0 frames over 20 ms (max 17 ms over 131–164 frames). The desktop has no competing gesture.

**Consequences**

- **The M1 deck.** "Swipe the deck sideways for the next item" works leftward only. A rightward swipe on the phone opens Paseo's sidebar instead. On the phone the deck pages with a leftward swipe plus taps on the "1 of 4" pager, or uses vertical motion.
- **Sheet rows.** M1d/M1's "right swipe = Continue/Done" cannot ship as drawn on the phone. Keep left-swipe for Snooze/Open, and make the default action a tap target or a left-swipe action. The desktop can keep both directions.
- **The sheet** (vertical drag with velocity hand-off) and **the detail card's swipe-down** are vertical, so they are not contested. On the simulator neither dropped a frame; whether an iPhone does under a real card's render cost is the owner check below.
- **The kit (BRO-3034).** The deck and row components take a `directions` prop. On `layout.platform === "ios" | "android" && layout.compact`, rightward is disabled. Handle `onPanResponderTerminate` by springing home: the host *will* terminate.
- Follow-up: [BRO-3062](https://linear.app/broomva/issue/BRO-3062) asks Paseo to let a plugin screen block the sidebar-open gesture.

## 4. Keyboard: does the composer get the inset?

**Answer: partial.** RN `Keyboard` events reach a plugin screen on iOS (`keyboardWillHide`/`keyboardDidHide` with `h=311` arrived in the probe). The host applies **no** inset: the screen keeps its full 748 pt and a bottom view stays put. The composer has to read `endCoordinates.height` and lift itself. Seeing the software keyboard over the composer is left to the owner's phone.

**Evidence**

- **source**:
  - The plugin screen container has no `KeyboardAvoidingView` or keyboard-controller wrapper (`surface-screen.tsx:217-243`).
  - The app mounts `react-native-keyboard-controller`'s `<KeyboardProvider>` (`app/_layout.tsx:956`), which stops the window from resizing for the keyboard.
  - The provider's iOS observers are additive (`KeyboardMovementObserver+Lifecycle.swift:25`). They do not remove RN's own `RCTKeyboardObserver`, so RN `Keyboard` events should still fire.
  - The plugin `TextInput` is a plain RN `TextInput` outside the host `Modal` (`components/ui/text-input/sheet-aware.tsx:18-22`).
  - Tapping Paseo's header dismisses the keyboard (`background.native.tsx:4-5`).
- **simulator**: ([`sim-10-keyboard-composer.jpg`](../../receipts/BRO-3033/sim-10-keyboard-composer.jpg)) Tapping the bottom composer focused it (cursor shown), and the probe received `keyboardWillHide h=311 screenY=874` and `keyboardDidHide h=311`: RN `Keyboard` events do reach a plugin screen. The simulator treated AXe as a hardware keyboard, so the software keyboard stayed hidden and no `WillShow` arrived. A reboot did not clear it, and I did not change Simulator.app's global preferences to force it. The screen kept `h=748` throughout: the host did not resize or inset it.
- **desktop**: no soft keyboard, and react-native-web's `Keyboard` emits nothing ("no keyboard events yet" after typing). Nothing to do on desktop.

**Consequences**

- **BRO-3037 M9 (and every bottom input).** The composer lifts itself: listen to `keyboardWillShow`/`keyboardWillHide` (iOS) and `keyboardDidShow`/`keyboardDidHide` (Android). Set `marginBottom` (or translate) to `endCoordinates.height` minus the bottom safe-area padding, animated over `e.duration`. Or wrap it in RN `KeyboardAvoidingView` (`behavior="padding"`); that is part of `react-native` and needs no host support.
- Inside the host `Modal` sheet, Paseo moves the sheet for the keyboard itself (seen on the simulator's Direct connection sheet), so New work in a `Modal` needs nothing.
- Paseo's header dismisses the keyboard on tap. Do not put a "done" affordance only in the header area.
- Desktop: nothing to do.

## 5. Gradients for the Undertow

**Answer: yes, on both,** under different keys. The desktop renders `backgroundImage` (linear and radial); iOS renders `experimental_backgroundImage` (linear and radial) and ignores the unprefixed key.

**Evidence**

- **desktop (same bundle)**, computed styles in [`desktop-probe.json`](../../receipts/BRO-3033/desktop-probe.json) and [`desktop-3-open-with-params.jpg`](../../receipts/BRO-3033/desktop-3-open-with-params.jpg):

  | Style | Computed result |
  |---|---|
  | `backgroundImage: linear-gradient(90deg, …)` | `linear-gradient(90deg, rgb(47, 111, 237), rgb(196, 61, 240))` |
  | `backgroundImage: radial-gradient(circle, …)` | `radial-gradient(circle, rgb(196, 61, 240) 0%, rgb(47, 111, 237) 60%, rgba(0, 0, 0, 0) 100%)` |
  | `experimental_backgroundImage` (both kinds) | `none`; react-native-web drops the key |
  | `boxShadow: "0 0 0 6px #c43df0"` | `rgb(196, 61, 240) 0px 0px 0px 6px` |
- **source**:
  - RN 0.81.5 with `newArchEnabled: true` (`app.config.js:107`).
  - `experimental_backgroundImage` linear gradients landed for iOS in 0.76 on Fabric only (`b99675d78a`, `RCTViewComponentView.mm`); radial gradients came in 0.80.
  - The plugin require shim hands plugins the real `react-native` with no style sanitizer (`plugins/evaluate.ts:439-466`).
- **simulator**: ([`sim-6-probe-top.jpg`](../../receipts/BRO-3033/sim-6-probe-top.jpg), [`sim-7-gradients.jpg`](../../receipts/BRO-3033/sim-7-gradients.jpg)):

  | Style | iOS (simulator, New Architecture) |
  |---|---|
  | `backgroundImage` linear | grey: not rendered |
  | `backgroundImage` radial | grey: not rendered |
  | `experimental_backgroundImage` linear | **renders** |
  | `experimental_backgroundImage` radial | **renders** |
  | `boxShadow` ring | **renders** |

**Consequences**

- **BRO-3034 Undertow.** One style helper emits both keys: `{ backgroundImage: g, experimental_backgroundImage: g }`. Each platform reads its own and ignores the other; the desktop computed `none` for the experimental key, and iOS left the plain key grey.
- The halo can be a real radial or linear gradient on iOS, plus a `boxShadow` ring, animated with RN `Animated` opacity or transform (native driver on iOS). JE rule 9 holds: it marks Running only.
- **The still, tinted-View ring stays as the fallback** for Android (the same RN 0.81 New Architecture path should render it; Android was not checked) and for reduced motion.
- The gradient is opaque; there is no backdrop blur on iOS (`paseo-plugin-capabilities.md`).

## 6. The push

**Answer: partial.** What Paseo sends is exactly known. On iOS (simulator) the banner shows the fixed title and the first ~80 characters of the body.

**Evidence**

- **source** (`@getpaseo/protocol` 0.11.1 `agent-attention-notification.js`, run against Maestro's own `noticeText` from `server/inbox.ts`; [`push-payloads.json`](../../receipts/BRO-3033/push-payloads.json)):

  | Notice | Maestro writes | Push title | Push body (as sent) |
  |---|---|---|---|
  | No ask | `**Needs you** · Pin the Node version in CI` | Agent finished | `Needs you · Pin the Node version in CI` (38) |
  | Typical | `**Needs you** · Retry failed card charges with backoff⏎⏎Approve the retry policy: …?` | Agent finished | `Needs you · Retry failed card charges with backoff Approve the retry policy: 3 attempts, 2/8/30 s backoff, then park the charge for review?` (139) |
  | Long | `**Needs you** · Migrate webhooks to the v3 signing scheme⏎⏎The v3 signer is ready …` | Agent finished | `Needs you · Migrate webhooks to the v3 signing scheme The v3 signer is ready behind a flag. … Ship wit...` (220) |

  - The transport is `{to, title, body, data, sound: "default"}` to Expo (`server/push/push-service.ts:45-51`). It carries no category, thread id or badge.
  - When the app is open, the iOS handler shows nothing (`app/_layout.tsx:227-236`).
  - A tap goes to `navigateToAgent` (`_layout.tsx:160-174`), which opens Maestro's inbox session, not Maestro.
  - No push is sent if any client was active within 180 s (`agent-attention-policy.ts:3,61-75`).
- **simulator**: ([`sim-13-push-banner-typical.jpg`](../../receipts/BRO-3033/sim-13-push-banner-typical.jpg), [`sim-12-push-banner-long.jpg`](../../receipts/BRO-3033/sim-12-push-banner-long.jpg)) `xcrun simctl push` delivered the exact `{title, body}` above to the backgrounded app. The banner reads **"Agent finished"** over two lines of body: `Needs you · Retry failed card charges with backoff Approve the retry policy: 3 attemp…` and `Needs you · Migrate webhooks to the v3 signing scheme The v3 signer is ready beh…`. That is about 80 characters before iOS's own `…`; the full 220 shows only when expanded. The same push with Paseo in the foreground showed **nothing** (`setNotificationHandler` returns no alert). This is a local simulator push, not APNs through Expo; the tap path (open the agent) is from source.

**Consequences**

- **Maestro, small (follow-up):** the notice's two parts run together on the lock screen ("…with backoff Approve the retry policy…"). Put the ask on the first line with a visible separator, e.g. `Needs you · <title> — <ask>` or `Needs you · <title>: <ask>`. Order the words so the 217 characters before `...` carry the decision: the title first, then the shortest form of the ask.
- **M10:** the frame's push is right: fixed title, the body as above, no buttons. The tap lands in the inbox session, whose gate card carries "Open in Maestro" (fact 2).
- **Presence:** the owner sitting at the Mac suppresses the phone push (180 s rule). M10's push arrives only when the owner is away from every client.

## Owner checks on the real iPhone

What the simulator cannot show, each one step on the owner's phone:

| # | What | The one step | Why the simulator could not |
|---|---|---|---|
| 3 | Frame drops on a real iPhone during deck, sheet and row drags | Install the probe on the real daemon (`paseo plugin install <repo>/scripts/device-probe`), open **Device probe** from the phone's sidebar, drag each blue card left or down, and read its `frames … >20ms N` line. Then `paseo plugin uninstall maestro-device-probe` | A simulator on an M-series Mac does not drop frames like a phone |
| 4 | The software keyboard over a bottom composer | On the same probe screen, tap "bottom composer: does it ride the keyboard?" and read the `keyboardWillShow h=…` line; the composer should sit above the keyboard | AXe input made the simulator assume a hardware keyboard |
| 6 | A real APNs push on the lock screen, and the tap | The next real Maestro landing while away from every client for more than 180 s: check the lock-screen text and that the tap opens "Maestro · Needs you" | Simulator pushes are local, not APNs |
| 1 | iPhone chrome on the App Store build | Open Maestro on the phone: expect `▦ Maestro ✕` and nothing at the bottom | It was built from the same tag, not the store binary |

No real push was sent to the owner's phone. iPhone Mirroring was opened once and quit while the phone was in use.

## How to re-run

```sh
bun scripts/dogfood/up.ts --plugin "$PWD"                      # sandbox daemon with Maestro
paseo plugin install "$PWD/scripts/device-probe" --host 127.0.0.1:<port>   # with HOME=<sandbox>/home, as up.ts does
# open the daemon URL, pick "Device probe" in the sidebar; drag the blue cards, tap the hold buttons
bun scripts/dogfood/down.ts
```

The probe's README covers the iOS simulator route. The simulator, its iOS 26.3 runtime and the build were deleted after this run to give the disk back; rebuilding takes about 20 minutes and 15 GB.
