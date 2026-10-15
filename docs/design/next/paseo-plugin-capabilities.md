# What a Paseo plugin can actually do (Paseo 0.11.1, SDK typings 0.8.0)

Date: 2026-10-09. Read-only research. Nothing was installed or edited.

## Sources and how they were read

| Short name | Path |
|---|---|
| `SDK` | `/Users/broomva/broomva/apps/maestro-paseo-bro-2980-design/node_modules/@getpaseo/plugin/dist/` (0.8.0 typings; the JS for `client/react-native` and `client/ui` is empty, `export {}`: the host supplies them at runtime) |
| `PROTO` | `.../node_modules/@getpaseo/protocol/dist/` |
| `REPO` | `/Users/broomva/broomva/apps/maestro-paseo-bro-2980-design/` |
| `HOSTWEB` | `/Applications/Paseo.app/Contents/Resources/app-dist/_expo/static/js/web/index-abadf3b49254b04e0d7c8630abdf7fbe.js` (22 MB Expo web export that the Electron app renders; react-native-web). Cited by **byte offset** (`@N`). |
| `ASAR` | `/Applications/Paseo.app/Contents/Resources/app.asar`, read with a small Python reader and copied to `/tmp/paseo-scan/asar/`. It contains the 0.11.1 daemon (`@getpaseo/server`), Electron main (`dist/`) and the vendor's **own plugin skill** `@getpaseo/server/dist/server/skills/paseo-plugin/SKILL.md` (written `SKILL`). |
| App version | `Paseo.app/Contents/Info.plist` CFBundleShortVersionString = 0.11.1. The bundled `@getpaseo/plugin` in ASAR is 0.11.1 (JS only, no .d.ts). |

I could not inspect the iOS app binary. Any claim about iOS rests on the shared RN client code, the compiler and the vendor skill. Those claims are marked.

**Important version gap.** The repo types against SDK **0.8.0**, but the 0.11.1 host has more API than those typings show: `addScreen`, `addSidebarHeaderItem`/`addSidebarFooterItem`, `openScreen({screenId, params})`, `openPopover`, `SidebarRow`/`SidebarSeparator`/`ExternalLink` in `/client/ui`, and `openExternalUrl`/`getPaseoClient`/`useHosts` on `/client`. The evidence is in HOSTWEB @12920742 to @12926113 and SKILL:32, 196-258. Bumping `@getpaseo/plugin` to 0.11.x would give typed access to them.

---

## 1. Rendering model: YES, React Native primitives everywhere. Web uses react-native-web; no React DOM API

- **Module allowlist (the hard boundary).** The host evals the plugin bundle and resolves `require` only for `@getpaseo/plugin/client/ui`, `react`, `react/jsx-runtime`, `react-native`, `@getpaseo/plugin`, `@getpaseo/plugin/client`, `@getpaseo/plugin/client/react-native`, `@tanstack/react-query`, `zod`. Anything else throws `Module "<x>" is not available in plugin client code` (HOSTWEB @12926113, inside `runPluginClientBundle`). `react-dom` is **not** on the list.
- **The compiler marks the same set as external.** ASAR `plugins/compiler.js:330-338` lists the SDK specifiers plus `@tanstack/react-query, react, react/jsx-runtime, react-native, zod`. Other pure-JS npm deps are **bundled into the plugin**. Platform is `neutral`, target es2020, async-await lowered "since the bundle also runs in React Native ... before Hermes sees app code" (`compiler.js:321-329`). Node builtins are a compile error in client code (`compiler.js:266`).
- **The vendor rule** (SKILL:267-285): "Use React Native primitives only: View, Text, Pressable, ScrollView, and TextInput. Do not use HTML elements, className, CSS strings, or onClick." DOM globals may appear only in a `client/web.ts` gated on `Platform.OS === "web"`.
- **Does the same code run on mobile?** YES per vendor. SKILL:135-136 says "Plugins run on desktop and mobile". SKILL:198 says "Plugin screens ... work across desktop, browser, iOS, and Android". `PluginHostProps.layout.platform: "ios" | "android" | "web"` and `layout.compact` are in SDK `client/contracts.d.ts:14-17`. **On-device verification for Maestro is UNVERIFIED**: the repo's phone screenshots (`docs/timeline-phone.png`, `docs/compact-detail.png`) are 375x812 px, which looks like a narrow web viewport, not an iPhone capture.
- **How this repo renders.** It uses RN primitives from `react-native` (`client/ui.tsx:9-21`: `View, Text, Pressable, Animated, Easing, AccessibilityInfo, ActivityIndicator, Platform`). Host components come from `@getpaseo/plugin/client/react-native` (`Icon`, `Modal`, `ScrollView`, `TextInput`, `useToast`; `client/new-work.tsx:14`, `client/plane.tsx:17`). Styles are inline objects built from `theme.colors` plus local tokens (`client/ui.tsx:25-27`: `space`, `radius`, `size`). It ships no CSS files and no className. Web-only behaviour is gated by `Platform.OS` (`client/ui.tsx:47`, `client/decision-triage.tsx:522`).

## 2. Extension points and where they render

From SDK `client/contracts.d.ts:60-74` (0.8.0) plus host-only 0.11.1 additions (HOSTWEB @12920742 onward):

| API | Signature | Where it renders | Status |
|---|---|---|---|
| `addSurface` | `(id, Component<PluginSurfaceProps>) => cleanup` | A full screen in the main content area. In 0.11.1 it is a shim over `addScreen({id, title:id, Component})` (HOSTWEB @12920742) | YES (legacy) |
| `addScreen` | `({id, title: string \| (params)=>string, Component})` | Full screen. Paseo owns route `/h/<server>/plugin/<pluginId>/<kind>/<id>`, header, host picker, close, error boundary (SKILL:258; route template in HOSTWEB) | YES (0.11.1, untyped in 0.8.0) |
| `addSidebarItem` | `({id,title,icon,surface})` | Legacy fixed sidebar row (icon + title) that opens a surface | YES (legacy) |
| `addSidebarHeaderItem` / `addSidebarFooterItem` | `({id,title,Component})` where Component gets `{currentScreen, openScreen, openPopover}` | Sidebar header or footer. You render `SidebarRow`s yourself; `openPopover` shows your component in a host `SidebarPopoverSurface` anchored to the row (HOSTWEB @17707689) | YES (0.11.1, untyped) |
| `addSettingsScreen` | `({id,title,icon,Component})` | Settings, as a plugin page | YES |
| `addWorkspacePanel` | `({id,title,icon,context:"workspace"\|"agent",locations?:["workspace"\|"explorer"],Component})` | A tab beside agents/terminals/files/diffs, or in the Explorer (host validator: valid locations `["workspace","explorer"]`, HOSTWEB @12926113) | YES |
| `addCommandCenterItem` | `({id,title,icon,keywords?,context:"global"\|"workspace"\|"agent",onSelect(ctx)})` | The ⌘K Command Center | YES |
| `addSlashCommand` | `({name,description,argumentHint,context:"workspace"\|"agent",onSubmit(ctx&{args})})` | Composer `/name` autocomplete. Runs client code and sends nothing to the agent (SKILL:461-476) | YES |
| `addHeaderButton` | `({id, workspaceId, button: PluginButton}) => {update, remove}` | Workspace header. The behaviour is `action`, `menu` (items/separators) or `popover` (your `Content` with `close()`) (SDK `client/buttons.d.ts:19-28, 56-60`) | YES |
| `addComposerPill` | same + `agentId` | The composer track bar next to Tasks and Subagents (SKILL:478-546) | YES |
| `addTimelineRenderer` | `({kind,version,schema,Component<PluginTimelineItemProps>})` | Inline in an agent's chat timeline | YES |
| `addTimelineTransformer` | `({id, query:{itemType}, transform})` | Replaces, hides or explodes built-in items: `user_message, assistant_message, reasoning, tool_call, todo, error, compaction` (HOSTWEB @12926113) | YES |
| `addAttachmentSource` | declarative + search RPC | Composer attach picker (Paseo owns the UI) | YES |
| `addTheme` | `({id,name,appearance,colors:{background,foreground,raised,control,border,accent?,mutedForeground,ring}})` | Settings → Appearance. **Hex only**: `#rgb`/`#rrggbb`/`#rrggbbaa` (HOSTWEB @8063820 zod regex) | YES |
| `openSurface(id)` / `openScreen({screenId, params?})` | on command contexts | navigates | YES |
| `openSettings(id)` | on command contexts (SDK `contracts.d.ts:131`) | navigates | YES |
| `openPanel(id, {workspaceId, agentId?, location?})` | client ctx (`contracts.d.ts:73`), contextual on commands | opens a panel tab | YES |
| `props.navigation.openAgent/openWorkspace` | on surfaces/panels, optional (`contracts.d.ts:21-28`) | navigates | YES |
| Server: `timeline.append({type:"plugin",id,kind,version,data})` | daemon | pushes or replaces a row in any agent timeline. `data` ≤ 64 KiB, in-memory, lost on daemon restart (SKILL:572-589) | YES |

There is **no** API for a toolbar, status bar, window title, dock/menu bar, global overlay layer or tray, or for registering keyboard shortcuts.

## 3. Styling

| Feature | Web/desktop (react-native-web) | iOS native (RN 0.81) | Evidence |
|---|---|---|---|
| `backdropFilter: "blur(..) saturate(..)"` | **YES** in the DOM. RNW passes unknown style keys through (`react-native-web/dist/exports/StyleSheet/compiler/createReactDOMStyle.js`, else branch). The host's inline-style-prefixer lists `backdropFilter` (HOSTWEB @98273). It blurs **only DOM beneath it**: the Electron window has no vibrancy (ASAR `dist/window/window-manager.js:44` sets only `titleBarStyle:"hidden"`; no `vibrancy`/`transparent`) | **NO**. RN has no backdrop-filter, and `expo-blur`/`BlurView`/glass views are not on the module allowlist (0 hits for `expo-blur`, `GlassView`, `expo-glass-effect` in HOSTWEB) | PARTIAL overall |
| Gradients | `backgroundImage: "linear-gradient(...)"` passes through (the `background` shortform is rejected, RNW `validate.js:11-21`) | `experimental_backgroundImage` exists in RN 0.79+ (UNVERIFIED in host) | PARTIAL |
| `boxShadow` | YES (RNW `preprocess.js:58-67, 167-172`); the repo uses it at `client/fleet-queue.tsx:217-221` | YES with New Arch RN ≥0.76 (UNVERIFIED on Paseo iOS) | YES/UNVERIFIED |
| CSS transitions / keyframes | `transitionProperty/Duration/TimingFunction` and `animationKeyframes` pass through. The host itself uses `transitionDuration` on its modal overlay (HOSTWEB @12949037) | NO | PARTIAL (web only) |
| Custom fonts | Only `fontFamily` naming fonts that already exist. No `expo-font` loader is exposed. `@font-face` injection needs DOM (a gated side door) | System fonts only (the repo uses `Menlo` on iOS, `client/decision-card.tsx:37`) | PARTIAL |
| CSS variables | No: there is no stylesheet. `var(--x)` strings in style values may pass through on web, UNVERIFIED and not portable | NO | NO |
| Theme tokens to plugins | **11 colors only**: `surface0/1/2, border, foreground, foregroundMuted, accent, accentForeground, statusSuccess/Warning/Danger` (SDK `contracts.d.ts:3-17`; host `toPluginTheme` HOSTWEB @17714605). **No** `appearance`/isDark flag, no fonts, spacing, radii, info/blue token or tint tokens. The repo derives dark from `surface0` luminance (`client/fleet-color.ts:60-63`, `client/fleet-ui.tsx:29-31`) | same | PARTIAL |
| Light/dark | Follows Paseo's chosen theme via `theme.colors` and re-renders. A plugin can contribute light and dark palettes (`REPO/shared/theme.ts`, `index.client.tsx:15-16`). `useColorScheme()` gives the OS scheme, not Paseo's | same | YES |

## 4. Overlays

- **Host `Modal`** (`@getpaseo/plugin/client/react-native`; SDK `client/react-native.d.ts:4-22`): `<Modal title icon open onOpenChange><Modal.Content style contentContainerStyle scrollable/></Modal>`. It maps to the host's `AdaptiveModalSheet` (HOSTWEB @12949037 / module 3970). On compact or native it is a **bottom sheet** with snap points `["65%","90%"]`, host-owned gestures, keyboard and safe-area handling. On desktop web it is a centered card over a dimmed overlay with an opacity fade. The plugin **cannot** set snap points, detents, presentation, size (except `scrollable:false` → 85% desktop height), backdrop or animation. This is what `client/new-work.tsx:142-162`, `client/fleet.tsx:630`, `client/fleet-ticks.tsx:199` use. YES (fixed chrome).
- **Popovers**: `PluginButtonBehavior {kind:"popover", Content}` for header buttons and composer pills (SDK `buttons.d.ts:25-28`), and `openPopover` from sidebar header/footer items (HOSTWEB @17707689). The host anchors and styles them. YES.
- **Toasts**: `useToast().show(msg, {variant, durationMs})` (SDK `react-native.d.ts:23-34`). YES.
- **Absolute positioning**: `position:"absolute"` works inside the plugin's own view tree. Escaping the surface over host chrome has no API. `position:"fixed"` via RNW, or RN's own `Modal` from `react-native`, might escape on web. Both are UNVERIFIED and against the vendor contract. A "sheet that grows from its source" can only be faked **inside** a surface.

## 5. Motion and gestures

| Feature | Status | Evidence |
|---|---|---|
| RN `Animated` (timing/spring/decay, `useNativeDriver` on iOS) | YES | `react-native` allowlisted; the repo uses it (`client/ui.tsx:117-128`, `client/decision-triage.tsx:230-250`) |
| Springs that carry gesture velocity | YES (JS-level): `PanResponder` gestureState `vx/vy` → `Animated.spring({velocity})`. On web it runs on the JS thread | PanResponder is part of `react-native`/RNW (21 hits in HOSTWEB) |
| Reanimated / react-native-gesture-handler / gorhom bottom-sheet | **NO**. The host uses them internally (`GestureDetector` 36 hits, `BottomSheet` 328 hits), but they are not allowlisted, and bundling a second copy of a native-backed lib is unsupported | HOSTWEB @12926113 allowlist |
| `LayoutAnimation` | PARTIAL: real on iOS, a no-op on RNW | RN API |
| CSS transitions/keyframes | Web only (§3) | |
| `requestAnimationFrame` | YES (global in browser and Hermes) | |
| Pointer/hover | `Pressable onHoverIn/Out` works on web. `onPointer*` on RN 0.81/RNW is UNVERIFIED | |
| Reduced motion | YES: `AccessibilityInfo.isReduceMotionEnabled` plus listener (`client/ui.tsx:79-95`) | |
| Host animation helpers | Only `useRevealedText(text, phase)` for streaming text (SDK `react-native.d.ts:35`) | |

## 6. Notifications and push: NO plugin API (confirmed)

- The SDK has no notify API. The client contexts and the server `PluginServerContext` are `registerSettings, handle, registerProvider, on, before` (SDK `server/contracts.d.ts:10-14`, `server/lifecycle.d.ts:86-91`).
- The daemon pushes only on **agent attention** and **terminal attention** (ASAR `server/websocket-server.js:1915-1936, 1993-2018`). The payload is `{title, body, data:{serverId, workspaceId, agentId, reason}}`, body truncated to **220 chars**, title e.g. "Agent finished" (`PROTO/agent-attention-notification.js:1,108`).
- Expo push messages are `{to,title,body,data,sound:"default"}`, with **no `categoryId`** (ASAR `server/push/push-service.js:16-22`). There are 0 hits of `categoryId`/`categoryIdentifier`/`actionIdentifier` in HOSTWEB, so there are no action buttons. Tokens are leased for 48 h (`push/index.js:3`).
- A tap deep-links only to agent, terminal or host (`paseo://h/<server>/agent/<id>`, `PROTO/agent-deep-link.d.ts:5-6`; REPO `docs/design/next/notifications-integration.md:38`). Plugin screens have an in-app route `/h/<s>/plugin/<id>/<kind>/<id>` (HOSTWEB), but no push or deep link targets it.
- Desktop notifications from Electron are `{title, body, data}` with click-to-focus and no actions (ASAR `dist/features/notifications.js:72-104`). Only Paseo's renderer calls them through `window.paseoDesktop.notification.sendNotification` (`dist/preload.js:68-70`). A plugin evaluated in that renderer could technically call the global. It is undocumented, desktop-only, and a side door.
- The repo's workaround is correct as described. `REPO/server/inbox.ts:1-13` registers a `maestro-inbox` provider and drives turns to one top-level session, so Paseo's own "Agent finished" push fires.

## 7. Haptics, sound, keys, focus, a11y

| Feature | Status | Evidence |
|---|---|---|
| Haptics | **NO**. The host has expo-haptics (`impactAsync` 6 hits) but does not expose it. RN `Vibration` is a plain buzz on iOS and a no-op on desktop | allowlist |
| Sound | **NO** API. Web Audio on desktop is a DOM side door | |
| Keyboard shortcuts | **PARTIAL**. There is no registration API and no accelerators (0 hits for `addShortcut`/`registerShortcut`). The reachable route is ⌘K through `addCommandCenterItem`. Web: `document.addEventListener("keydown")` while the plugin's view has focus, as the repo does (`client/decision-triage.tsx:521-544`, `client/new-work.tsx:209`, `client/ui.tsx:631-655`). iOS hardware keyboard: none | |
| Focus management | PARTIAL: `TextInput` ref `.focus()` (host `TextInput` integrates modal keyboard, SDK `react-native.d.ts:44-45`), `SettingsInputHandle.focus/blur` (`ui.d.ts:30-35`), focus-visible rings built by hand (`client/ui.tsx:661-670`) | |
| Accessibility props | YES: `accessibilityRole/Label/State`, `accessible`; RNW maps them to ARIA (the repo uses them widely, e.g. `client/decision-card.tsx:103`, `client/fleet-health.tsx:264` role alert). Web-only ARIA via a spread (`client/ui.tsx:34-40`) | |
| Clipboard / external links | YES: `copyText` (SDK `react-native.d.ts:43`); `openExternalUrl` on `/client` (http/https only, HOSTWEB @12930650); `Linking.openURL` (`client/open-url.ts:11`) | |
| Icons | Lucide names only, validated (`resolvePluginIcon`) | |

## 8. Mobile (iOS app)

- **YES per vendor; UNVERIFIED for this repo on a device.** Client bundles are built for Hermes (`compiler.js:323-329`), and the SDK carries `layout.platform` and `layout.compact` (`contracts.d.ts:14-17`). SKILL:135-136 and 198 say plugins and screens run on iOS/Android.
- Limits on mobile: no blur or glass; `Modal` is the host bottom sheet (65%/90%); no haptics; no keyboard shortcuts; no DOM; `fontFamily` limited to system fonts. Push opens the agent, never a plugin screen. The token lease means pushes stop after 48 h without the phone app heartbeating (`docs/design/next/notifications-integration.md:37`).
- Expect sidebar, header and Command Center affordances to be laid out by the host for compact mode, which you do not control.

## 9. Everything else

- **Server runtime**: a forked Node subprocess (ASAR `plugins/runtime.js:103-105`), **unsandboxed**, with full fs, child processes, sockets, timers and network (SKILL:615-617; the repo uses `node:fs`, launchd, etc.). RPC request timeout is **30 s** (`runtime.js:18`). The log tail is 500 entries / 256 KiB / 16 KiB per line (`runtime.js:19-21`). Soft shutdown takes 2 s. Hooks: `on(agent.turn_started|turn_ended|permission_requested|permission_resolved|archived|created, workspace.created|archived)` and `before(agent.create|agent.session_open|workspace.create)` (SDK `server/lifecycle.d.ts:44-91`). It can register agent providers (`registerProvider`, used for the inbox).
- **Client sandbox**: none. The bundle is `globalThis.eval`'d in the app renderer (HOSTWEB @12926113). Only the module allowlist binds; DOM globals are reachable on web.
- **Size limits**: timeline row `data` ≤ 64 KiB (SKILL:589). I found no client-bundle size cap (not exhaustively searched).
- **Data**: `usePaseo()` (the full Paseo SDK), `useWorkspace(id, selector)`/`useAgent(id, selector)` with shallow equality (SDK `client/client-state.d.ts:9-10`), `useRpc`, TanStack Query with a per-installation client, and `useSettings(definition)` with host-stored, zod-validated settings plus migrate (SDK `settings.d.ts:3-11`, `client/contracts.d.ts:179-199`).
- **Settings UI primitives** (`@getpaseo/plugin/client/ui`; SDK `client/ui.d.ts:49-59`; host exports HOSTWEB module 3917): `SettingsGroup`, `SettingsSection {title, info?, trailing?}`, `SettingsCard`, `SettingsRow {label, hint?, error?}`, `SettingsSwitch`, `SettingsSelect`, `SettingsInput` (with `secureTextEntry`, imperative handle), `SettingsAction {actionLabel, onPress}`, plus 0.11.1 `ExternalLink`, `SidebarRow`, `SidebarSeparator`.
- **Multi-host**: the screen header has a host picker, and the selected host owns the bundle, RPCs and cache (SKILL:640).

## Five constraints a designer must hold

1. **There is no glass on the phone, and on desktop glass only blurs Maestro's own content.** `backdropFilter` works only through react-native-web in the Electron app, over DOM inside the plugin's surface (the window is opaque). iOS gets nothing comparable. Design an opaque or tinted fallback first and treat blur as a desktop enhancement.
2. **The host owns the chrome.** Sidebar, screen header, Command Center, popovers, toasts and the `Modal` sheet are Paseo's, with fixed size and motion (sheet at 65%/90%, centered card on desktop). "Sheets that grow from their source" and floating buttons can exist only inside a Maestro screen or panel, never over Paseo.
3. **Motion is RN `Animated` plus `PanResponder`, not Reanimated or gesture-handler.** Spring-with-velocity is possible but runs on the JS thread on web. CSS transitions are web-only. Respect reduced motion.
4. **The phone cannot be reached directly, and pushes have no actions.** The only push is Paseo's agent-attention push: generic title, 220-char body, tap opens an agent, no category or buttons, a 48 h token lease. Maestro's inbox-session trick is the channel. Design the push as "open, then act in the gate card", not "act on the lock screen".
5. **Tokens are 11 hex colors with no appearance flag, no fonts and no haptics.** Light/dark must be derived from `surface0` luminance. Brand colors outside the palette (e.g. info blue) must be checked for contrast against every theme. Typography is system fonts. Keyboard shortcuts are web-only listeners scoped to Maestro's focus, plus ⌘K items.
