# Device checks: the Paseo facts the J/M build rests on (BRO-3033)

Date: 2026-10-10. Host: Paseo 0.11.1 (desktop app, daemon and CLI; iOS app built from the `v0.11.1` tag).
This answers the six questions in BRO-3033 and says what each answer means for BRO-3034 (component kit) and BRO-3037 (M screens).

## Where the evidence comes from

Every row names its surface. In order of strength:

| Label | What it is | Strength |
|---|---|---|
| **desktop (same bundle)** | Same bundle, browser runtime: the sandbox daemon's web client in headless Chromium, driven by Playwright (`scripts/dogfood/up.ts` sandbox, probe plugin installed). It serves `index-abadf3b49254b04e0d7c8630abdf7fbe.js`, **the same file the owner's Paseo.app renderer runs** (read over CDP from the real app's window, and from the sandbox's `/`: [`desktop-bundle.txt`](../../receipts/BRO-3033/desktop-bundle.txt)). | Observed; same JS as the desktop app, though Electron-only branches (window chrome, traffic-light offset) are not exercised |
| **simulator** | Paseo's iOS app built from `getpaseo/paseo@v0.11.1` (`ab10a66`; RN 0.81.5 and Expo 54 per `packages/app/package.json:114,78`; New Architecture per `app.config.js:107`; built in the Release configuration) on an iPhone 16 Pro simulator (iOS 26.3.1), connected to the sandbox daemon, touches by AXe. Gesture timing on a simulator is **not** an iPhone's: frame numbers are marked "simulator". | Observed, same source as the App Store build; perf not representative |
| **source** | `getpaseo/paseo@v0.11.1` read at `ab10a66`, cited `path:line`. | Read, not run |
| **real iPhone** | The owner's iPhone over iPhone Mirroring. **Not reached**: the Mac is paired, but Mirroring showed "iPhone in Use. Lock your iPhone to connect" ([`iphone-mirroring-0.jpg`](../../receipts/BRO-3033/iphone-mirroring-0.jpg)), and no phone is set up for interceptor-ios. What only a real phone can show is in [Owner checks](#owner-checks-on-the-real-iphone). | — |

The probe is a separate throwaway plugin, [`scripts/device-probe/`](../../../scripts/device-probe/README.md) (id `maestro-device-probe`), so it never ships inside Maestro. It registers one screen and one sidebar row and shows, on the screen itself: the params it was opened with and its mount count, where the host put it (`measureInWindow`), four gradient swatches, four `PanResponder` cards that count animation frames from touch-down until the spring back settles and report whether the host terminated the gesture, RN `Keyboard` events, a bottom composer, and an M1-style tab bar inside RN `SafeAreaView`.

**Which probe produced which receipt.** The simulator receipts (JPEGs and [`sim-ax-readings.txt`](../../receipts/BRO-3033/sim-ax-readings.txt), the probe's own text read through `axe describe-ui`) come from the probe at commit `df4e6aa`. [`desktop-probe.json`](../../receipts/BRO-3033/desktop-probe.json) was re-recorded after review round 1 (`ba98956`) with the same readings. The probe now in the tree adds, after review round 2:
- a median frame interval;
- frame-meter fixes for a re-grab during the spring-back;
- an axis-locked row;
- a composer that lifts by its measured overlap with the keyboard.

Re-run it before reading new numbers off it.

## Summary

| # | Question | Answer | One-line consequence for the build |
|---|---|---|---|
| 1 | What does Paseo draw around a plugin screen on iOS? | **Yes, known: a header only.** An icon (legacy sidebar items only), the title (string or `title(params)`), a host picker (only with >1 host) and an X close. No menu, no "more", no back chevron, nothing at the bottom, no bottom inset. | M1's tab bar owns the bottom edge and must clear the home indicator itself (RN `SafeAreaView` on iOS; nothing on Android yet, BRO-3065). The ☰ and ⋯ drawn in M1's header are not Paseo's: drop them, or draw them inside Maestro's content. |
| 2 | Can `openScreen({ screenId, params })` carry a hold key? | **Yes.** `params` arrive as the `params` prop, strings only, in the URL as `?param.<key>=…`; through `openScreen`, any characters round-trip (a hand-written `paseo://` link can corrupt `&`, `=`, `#`, `+` and `%`); a cold load reads them back (desktop only). Each call pushes a **new instance** (remount); earlier ones stay mounted, hidden. | The deck and inspector open on `params.hold` at mount. Inside an open Maestro, move by state, not by another `openScreen`. Hidden instances should pause their polling, because M10's loop stacks them. |
| 3 | `PanResponder` on the iPhone, JS thread | **Partial.** Leftward and vertical drags are the plugin's. **Rightward drags over ~15 px on compact native are taken by Paseo's sidebar-open gesture, which cancels the plugin's responder.** Frame drops: 0 frames over 20 ms on any leftward or vertical drag, counted from touch-down until the JS-driven spring back settled (simulator, max 18 ms over 136–137 frames, even with 8 ms of synthetic work per move). | M1's rightward deck swipe and right-swipe-to-Continue on sheet rows cannot ship as drawn. Follow-up filed. |
| 4 | Does the composer (M9) get the keyboard inset from RN `Keyboard` events? | **Partial.** Observed: RN `Keyboard` events reach a plugin screen on iOS (`keyboardWillHide`/`keyboardDidHide`, read through the probe's text; no `WillShow`, no software keyboard). From source only: the host applies no inset, so the composer has to lift itself. Not seen: a software keyboard over the composer and the `WillShow` event; that is an owner check. | Build M9's composer to lift itself, either from `keyboardWillShow`/`WillHide` (overlap = composer bottom − `endCoordinates.screenY`) or with RN `KeyboardAvoidingView`. Confirm on the phone. Whether the host `Modal` sheet moves for the keyboard is inferred, not observed. |
| 5 | Gradients for the Undertow | **Desktop: yes** (`backgroundImage` linear and radial render; `experimental_backgroundImage` is dropped by react-native-web). **iOS:** **yes**: `experimental_backgroundImage` linear and radial render; the unprefixed `backgroundImage` does not. | The kit sets **both** keys on every gradient: `backgroundImage` for the desktop, `experimental_backgroundImage` for iOS. A static gradient and a `boxShadow` ring render on iOS. Animating them is untested, and Android is unchecked, so keep the still tinted ring as the fallback. |
| 6 | How Paseo renders the push body Maestro writes | **Partial.** The title is "Agent finished" for a finished turn, which is Maestro's case ("Agent needs permission" and "Agent needs attention" for the other reasons). Body = Maestro's notice with markdown stripped and **newlines collapsed to one space**, cut to 220 characters ending `...`; no actions; tap opens the inbox session; nothing when the app is open; no push at all if any Paseo client was active in the last 180 s. The simulator rendered Maestro's exact payloads. | Put a separator into the notice's first line (title and ask now run together). M10 is push → session → card → Open in Maestro; a push never lands in Maestro directly. |

Follow-ups:
- [BRO-3062](https://linear.app/broomva/issue/BRO-3062): Paseo upstream, let a plugin keep rightward pans.
- [BRO-3063](https://linear.app/broomva/issue/BRO-3063): Maestro, a separator in the notice so the push reads.
- [BRO-3065](https://linear.app/broomva/issue/BRO-3065): Paseo upstream, give plugin screens their safe-area insets. No fact is a plain "no". Fact 3's rightward-swipe gap is the one that changes the design, and BRO-3062 covers it.

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

- **BRO-3037 M1.** The tab bar can sit at the bottom edge: Paseo draws nothing there. It has to pad for the home indicator itself. RN core `SafeAreaView` (from `react-native`, which plugins can import) does it on iOS (simulator, `sim-6-probe-top.jpg`). It is **deprecated in RN 0.81** (it warns that it "will be removed"), and it is a plain `View` on Android, where Paseo runs edge-to-edge (`app.config.js:125`). An Android tab bar would sit under the system navigation bar. `react-native-safe-area-context` is not importable by plugins (`plugins/evaluate.ts:439-463`). Follow-up: [BRO-3065](https://linear.app/broomva/issue/BRO-3065) asks Paseo to pass insets to plugin screens.
- **BRO-3037 M1–M11 headers.** The frames draw `☰ Maestro ⋯` as the top bar. On the phone, Paseo's header holds the title and an X, and Maestro cannot add buttons to it. So the deck header ("Needs you · All · Present") is the first row of Maestro's own content, under Paseo's header.
  - The ☰ has no host equivalent. Paseo's sidebar opens with a full-screen right swipe (fact 3); there is no host menu button.
  - The ⋯ menu, if kept, must be a control in Maestro's own deck header.
  - M1c's title-menu fallback is not needed for the tab bar, because the bottom edge is free.
- **Title.** Use `addScreen({ title: (params) => … })` to say where you are ("Maestro", or "Maestro · Decisions") in Paseo's own header for free.
- **Vertical budget.** On an iPhone 16 Pro the host header costs 62 + 64 = 126 pt before Maestro's first pixel, so M1's deck has `874 − 126 − tab bar − bottom inset` pt to work with.

## 2. `openScreen` params: can they carry a hold key?

**Answer: yes.**

**Evidence**

- **desktop (same bundle)**, [`desktop-probe.json`](../../receipts/BRO-3033/desktop-probe.json):
  - From the sidebar row, `openScreen({ screenId, params: { hold: "from-sidebar" } })` gave `params {"hold":"from-sidebar"}` at `…/plugin/maestro-device-probe/surface/device-probe?…&param.hold=from-sidebar`.
  - Then `{ hold: "ask:7f3e", tab: "decisions" }` gave `?param.hold=ask%3A7f3e&param.tab=decisions` and `params {"hold":"ask:7f3e","tab":"decisions"}` at `mount #2`.
  - Then `{ hold: "café & co/?#=1 ✓", long: <600 × "x"> }` round-tripped exactly at `mount #3`.
  - Reloading the URL cold (desktop only; not tried on iOS) rebuilt `params {"hold":"ask:7f3e","tab":"decisions"}` (`mount #1`).
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
- **Instances stack, and each stays live.** Every `openScreen` adds an instance and keeps the old ones mounted, each with its own queries and subscriptions. The desktop DOM held #1, #2 and #3 at once.
  - Inside an open Maestro, move between holds and tabs with state (today's `requestIntent` bus, `client/intent.ts`), not with `openScreen`.
  - M10's loop (Maestro → session → "Open in Maestro" → `openScreen`) still pushes Maestro #2 over a hidden #1, and each triage round trip adds one.
  - The kit needs a guard. The desktop DOM kept hidden instances mounted. In the first desktop run (log not kept), their `measureInWindow` returned 0x0; that is a candidate signal for pausing polling until the instance shows again, to confirm in the kit. Module-level state is shared, and `intent.ts` already lets the newest listener take an intent first.
  - Paseo has no "navigate to the existing screen" call. The ask belongs with BRO-3062 in `paseo-feature-request.md`.
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
- **simulator**: ([`sim-9-gestures.jpg`](../../receipts/BRO-3033/sim-9-gestures.jpg), [`sim-5-midscreen-right-swipe.jpg`](../../receipts/BRO-3033/sim-5-midscreen-right-swipe.jpg)) AXe drags, 0.8 s each. Frames are counted from touch-down until the JS-driven release spring settles, so they cover the drag and the velocity hand-off together:

  | Drag | Result |
  |---|---|
  | deck, leftward 260 pt | released, vx −0.22; 136 frames, 0 over 20 ms, max 18 ms |
  | deck, **rightward** | **`TERMINATED by host at dx=12`**, 2 frames; Paseo's sidebar slid in |
  | sheet, down 200 pt | released, vy 0.19; 137 frames, 0 over 20 ms |
  | deck with +8 ms JS work per move, leftward | released; 136 frames, 0 over 20 ms, max 18 ms |
  | row inside a vertical ScrollView, leftward | released; 137 frames, 0 over 20 ms |
  | same row, **rightward** | **`TERMINATED by host at dx=12`**; sidebar opened |
  | right swipe from mid-screen on the real Maestro screen | the sidebar opened |

  The frame counts are a simulator on an M-series Mac, not an iPhone; they show the JS-thread path is not obviously heavy, nothing more. The 20 ms threshold assumes 60 Hz. The iPhone 16 Pro's panel runs at 120 Hz, but without `CADisableMinimumFrameDurationOnPhone` in the app config, apps are probably capped at 60 Hz. The revised probe logs the median interval to settle it on the phone.
- **desktop (same bundle)**, headless Chromium ([`desktop-4-gestures.jpg`](../../receipts/BRO-3033/desktop-4-gestures.jpg)): deck x, sheet y, deck x with 8 ms of synthetic work per move, and a row inside a vertical ScrollView. All four released normally with 0 frames over 20 ms (max 17 ms over 131–152 frames). The desktop has no competing gesture.

**Consequences**

- **The M1 deck.** "Swipe the deck sideways for the next item" works leftward only. A rightward swipe on the phone opens Paseo's sidebar instead. On the phone the deck pages with a leftward swipe plus taps on the "1 of 4" pager, or uses vertical motion.
  - The host gesture fails for good once a drag goes 10 px left or turns vertical first (`gesture-intent.ts:17-22`). A drag that starts leftward and then reverses stays the plugin's. That is not a gesture to design around.
- **Sheet rows.** M1d/M1's "right swipe = Continue/Done" cannot ship as drawn on the phone. Keep left-swipe for Snooze/Open, and make the default action a tap target or a left-swipe action. Wide layouts (desktop) can keep both directions. **Compact web** (a narrow window, a mobile browser) wraps the same gesture, limited to drags that start within 32 px of the left edge (`gestures.ts:12,87`).
- **The sheet** (vertical drag with velocity hand-off) and **the detail card's swipe-down** are vertical, so they are not contested. On the simulator neither dropped a frame; whether an iPhone does under a real card's render cost is the owner check below.
- **The kit (BRO-3034).** The deck and row components take a `directions` prop. When `layout.compact`, rightward is disabled: on every platform, since compact web also has the gesture near the edge. Handle `onPanResponderTerminate` by springing home: the host *will* terminate.
- **Horizontal scrollers** (a chip row, a `pagingEnabled` deck) were not tested. The host shields only its own horizontal scrollers from the sidebar gesture (`isAnyScrolledRight`, `gestures.ts:86`). A plugin `ScrollView` scrolled right may lose rightward scrolls to the sidebar, so avoid horizontal scrollers on compact native until the probe shows otherwise.
- **iOS edge swipe-back** stays enabled on plugin routes (source), but the host stack uses `animation: "none"`. Two things are unverified: whether an edge swipe pops a stacked Maestro, and whether it or the sidebar wins at the left edge. Keep interactive things out of the leftmost ~20 pt.
- Follow-up: [BRO-3062](https://linear.app/broomva/issue/BRO-3062) asks Paseo to let a plugin screen block the sidebar-open gesture.

## 4. Keyboard: does the composer get the inset?

**Answer: partial.** Observed on the simulator: RN `Keyboard` events reach a plugin screen (`keyboardWillHide`/`keyboardDidHide`). From source only: the host wraps plugin screens in nothing that insets them for the keyboard, so the composer must lift itself. Not observed: the software keyboard over the composer, and `keyboardWillShow`. The simulator never showed one, so this needs the owner's phone.

**Evidence**

- **source**:
  - The plugin screen container has no `KeyboardAvoidingView` or keyboard-controller wrapper (`surface-screen.tsx:217-243`).
  - The app mounts `react-native-keyboard-controller`'s `<KeyboardProvider>` (`app/_layout.tsx:956`), which, on Android, stops the window from resizing for the keyboard. On iOS nothing resizes for it either way.
  - The provider's iOS observers are additive (`KeyboardMovementObserver+Lifecycle.swift:25`). They do not remove RN's own `RCTKeyboardObserver`, so RN `Keyboard` events should still fire.
  - The plugin `TextInput` is the host's `SheetAwareTextInput`. Outside a host `Modal` it renders RN's `TextInput` with no keyboard handling of its own (`components/ui/text-input/sheet-aware.tsx:18-22`).
  - Tapping Paseo's header dismisses the keyboard (`background.native.tsx:4-5`).
- **simulator**: ([`sim-10-keyboard-composer.jpg`](../../receipts/BRO-3033/sim-10-keyboard-composer.jpg) shows the focused composer; the event lines are in [`sim-ax-readings.txt`](../../receipts/BRO-3033/sim-ax-readings.txt) §4, because the keyboard section is scrolled off that shot) Tapping the bottom composer focused it (cursor shown). Twice, the probe received `keyboardWillHide h=311 screenY=874 dur=0` and `keyboardDidHide h=311`. Later, after the app went to the background and came back, it received the same pair with `h=0`. RN `Keyboard` events do reach a plugin screen. No height read here is a keyboard to lift for: these are hide events on the hardware-keyboard path. The simulator treated AXe as a hardware keyboard, so the software keyboard stayed hidden and no `WillShow` arrived. A reboot did not clear it, and I did not change Simulator.app's global preferences to force it. With no software keyboard on screen, the unchanged `h=748` proves nothing about an inset; that part rests on the source above.
- **desktop**: no soft keyboard, and react-native-web's `Keyboard` emits nothing ("no keyboard events yet" after typing). Nothing to do on desktop.

**Consequences**

- **BRO-3037 M9 (and every bottom input).** The composer lifts itself: listen to `keyboardWillShow`/`keyboardWillHide` (iOS) and `keyboardDidShow`/`keyboardDidHide` (Android). Lift it by the overlap between its bottom edge and `endCoordinates.screenY`, measured with `measureInWindow`, not by the raw height. Animate over `e.duration`. The probe now logs this overlap. Or wrap it in RN `KeyboardAvoidingView` (`behavior="padding"`); that is part of `react-native` and needs no host support.
- The host `Modal` handed to plugins maps to `AdaptiveModalSheet`, which was not read. The simulator's Direct connection form (a host sheet, not a plugin `Modal`) did move up for the keyboard, but there is no receipt. That a plugin `Modal` sheet handles the keyboard (New work) is an inference; BRO-3037 should check it.
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

- **BRO-3034 Undertow.** One style helper emits both keys: `{ backgroundImage: g, experimental_backgroundImage: g }`. Each platform reads its own and ignores the other; the desktop computed `none` for the experimental key, and iOS left the plain key grey. RN 0.81's types declare only `experimental_backgroundImage`, so the helper needs a cast for `backgroundImage`; the probe passes it through `Record<string, unknown>`.
- Static gradients and rings render on both platforms. Animating them (opacity or transform on a wrapping `Animated.View`, native driver on iOS) was **not** tested; the kit should check it on the simulator or phone before relying on it. JE rule 9 holds: it marks Running only.
- **The still, tinted-View ring stays as the fallback** for Android (the same RN 0.81 New Architecture path should render it; Android was not checked) and for reduced motion.
- The gradient is opaque; there is no backdrop blur on iOS (`paseo-plugin-capabilities.md`).

## 6. The push

**Answer: partial.** What Paseo sends is exactly known. On iOS (simulator, iPhone 16 Pro width, 402 pt) the home-screen banner shows the title and the first ~80 characters of the body. Other widths show more or fewer.

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
- **simulator**: ([`sim-13-push-banner-typical.jpg`](../../receipts/BRO-3033/sim-13-push-banner-typical.jpg), [`sim-12-push-banner-long.jpg`](../../receipts/BRO-3033/sim-12-push-banner-long.jpg)) `xcrun simctl push` delivered the exact `{title, body}` above to the backgrounded app. The banner reads **"Agent finished"** over two lines of body: `Needs you · Retry failed card charges with backoff Approve the retry policy: 3 attemp…` and `Needs you · Migrate webhooks to the v3 signing scheme The v3 signer is ready beh…`. That is about 80 characters before iOS's own `…` at this device width. The sent body is up to 220 characters; how much an expanded notification or the lock screen shows was not checked (owner check). The same push with Paseo in the foreground showed **nothing** (`setNotificationHandler` returns no alert). This is a local simulator push, not APNs through Expo; the tap path (open the agent) is from source.

**Consequences**

- **Maestro, small (follow-up):** the notice's two parts run together on the lock screen ("…with backoff Approve the retry policy…"). Put the ask on the first line with a visible separator, e.g. `Needs you · <title> — <ask>` or `Needs you · <title>: <ask>`. Order the words so the 217 characters before `...` carry the decision: the title first, then the shortest form of the ask.
- **M10:** draw the push as "Agent finished" (Maestro's inbox turns end as finished), the body as above, no buttons (the banner is simulator-verified). The tap landing in the inbox session, and what an expanded notification shows, come from source and are owner checks.
- **Presence:** the owner sitting at the Mac suppresses the phone push (180 s rule). M10's push arrives only when the owner is away from every client. While a client is "present", the alert goes in-app to the most recent one (`computeNotificationPlan`). If that client is a phone used within 180 s and now in the background, nothing shows anywhere (`os-notifications.ts:166-170` returns early on native). M10 should not promise a push for every landing.

## Owner checks on the real iPhone

What the simulator cannot show, each one step on the owner's phone:

| # | What | The one step | Why the simulator could not |
|---|---|---|---|
| 3 | Frame drops on a real iPhone during deck, sheet and row drags (and the median interval: 60 or 120 Hz) | Install the probe on the real daemon (`paseo plugin install <repo>/scripts/device-probe`), open **Device probe** from the phone's sidebar, drag each blue card left or down, and read its `frames … >20ms N` line. Then `paseo plugin uninstall maestro-device-probe` | A simulator on an M-series Mac does not drop frames like a phone |
| 4 | The software keyboard over a bottom composer | On the same probe screen, tap "bottom composer: does it sit just above the keyboard?" and read the `keyboardWillShow … overlap=… → lift …` line; with the revised probe, the composer should sit just above the keyboard with no gap | AXe input made the simulator assume a hardware keyboard |
| 6 | A real APNs push on the lock screen (how many lines it shows), and the tap | The next real Maestro landing while away from every client for more than 180 s: check the lock-screen text and that the tap opens "Maestro · Needs you" | Simulator pushes are local, not APNs |
| 3 | iOS edge swipe-back on a plugin screen | Open Maestro, open it again from a gate card, then swipe from the left edge: does it pop to the first Maestro, or open the sidebar? | Not tried |
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
