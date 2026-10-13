# The J/M component kit (BRO-3034)

The shared parts every J (desktop) and M (phone) screen uses, drawn in `docs/design/maestro-next.pen`:
the frame "M components" (`eTSe9`), the frame "Undertow" (`MTdih`), J1's inspector (`VbnhW`) and the
JE rules (`docs/design/next/je-evaluation.png`). React Native primitives, `Animated` and `PanResponder`
only (`docs/design/next/paseo-plugin-capabilities.md`); system fonts; no blur on iOS.

Each part keeps its behaviour in a pure model with a test, and its look in a `.tsx` beside it.

| Part | Component | Model | What its tests prove |
|---|---|---|---|
| Inspector (approval, ask, notice, work, review) | `inspector.tsx`: `InspectorPanel` (desktop, from the right, frosted bar), `InspectorCard` (phone, rises from the deck), `InspectorBody` | `inspector-model.ts` | one primary per kind, never Approve; Esc closes; a closed one unmounts |
| Glance tile | `glance-tile.tsx` | `tile-model.ts` | tinted only for Needs you (Tidepool) or warn; four at most |
| Deck (phone) | `deck.tsx`: `Deck`, `DeckHold` | `deck-model.ts` | one hold per swipe, never past an end, never a barred way; pages by segment taps; opens on `openOn`; 52 pt verbs |
| Pull-up sheet + tab bar (phone) | `pull-sheet.tsx`, `tab-bar.tsx` | `sheet-model.ts` | one Animated value drives the sheet, the tab bar (the same view) and the toast's lift; the peek clears the home indicator |
| Detail header (phone) | `detail-header.tsx` | `deck-model.ts` | "Kind · n of N", a segment per hold |
| Swipe row (phone) | `swipe-row.tsx` | `swipe-model.ts` | right commits past 40 % or a 48 pt fling (desktop); left opens Snooze/Open past 56 pt; on compact native the default verb is a left action; a hold never swipes |
| Undo toast | `undo-toast.tsx`: `UndoToast`, `useUndoToast` | `undo-model.ts` | the window is `UNDO_MS` (8 s, `shared/undo.ts`); gone at 8 000 ms; Undo hands back the receipt |
| Undertow, tidepool dot, standing pulse | `undertow.tsx` | `undertow-model.ts` | Running only (JE rule 9); standing gets the pulse |

Colors come from the active Paseo theme (`tokens.ts`). Primaries are broomva ink, the theme's foreground on
its surface (B1), never its accent. Tidepool, the Undertow's blue and ice, and the link blue come from the pen's
variables, light or dark by the surface's luminance.

## Platform facts (applied from BRO-3033)

The device spike ([`docs/design/next/device-checks.md`](../../docs/design/next/device-checks.md)) checked what
the phone parts rest on. Each fact is one function in
`assumptions.ts`; what it could not check is marked as an assumption. Each component that depends on one
takes a prop that overrides it.

| | Function | What the kit does | Override |
|---|---|---|---|
| F1 | `undertowLook`, `gradientStyle` | every gradient sets `backgroundImage` (react-native-web) and `experimental_backgroundImage` (iOS); Android, unchecked, keeps the still tinted ring | `look` on `Undertow`, `TidepoolDot` |
| A1 | `undertowMotion` | the halo moves on the web only; on iOS it holds still (animating a gradient there is untested); the conic orbit is web-only, since RN draws no conic gradient | `still` on `Undertow`, `TidepoolDot` |
| F2 | `frostLook` | `backdropFilter` frost on the web, solid elsewhere | `frost` on `InspectorPanel` |
| F3 | `chromeInset`, `SafeBottom` | Paseo draws a header only and gives no insets: the sheet runs under the home indicator, and its peek and the toast sit above it, measured with RN `SafeAreaView` (`react-native-safe-area-context` is not importable). Paseo has no ☰ or ⋯: any menu is Maestro's own content | `inset`, `safeBottom` on `PullSheet` |
| F4 | `swipeDirections(layout)` | on compact native Paseo's sidebar gesture takes every rightward drag past ~15 pt and terminates the plugin's responder, so the deck, the swipe row and the phone card swipe leftward only there; the row's default verb becomes its first left action, the deck pages by its segments, and a terminated gesture springs home. The desktop keeps both ways | `directions` on `Deck`, `SwipeRow`, `InspectorCard` |
| A2 | `nativeDriver` | transforms and opacity on the native driver off the web; every output the kit animates is one (the toast's lift is a transform for this reason) | none |
| F5 | `keysHint` | key caps only in the web build; the phone card never shows them | none |

`openScreen` params are strings in the route (fact 2): a screen passes `params.hold` to the deck's `openOn`, and
moves between holds by state once it is open, since every `openScreen` mounts a new instance. Hidden instances stay
mounted, so a screen that polls should pause while hidden; the kit's parts do not poll. The kit has no text
input; the M9 composer (BRO-3037) lifts itself from `keyboardWillShow`/`keyboardWillHide` or `KeyboardAvoidingView`
(fact 4).

## The gallery

`gallery.tsx` shows every part in every state, light and dark (the active theme for its own appearance,
broomva's palette for the other). It is a development screen: registered with `addScreen` as `kit`, with no
sidebar row or command, at `/h/<server>/plugin/maestro/surface/kit?param.section=phone|undertow`,
and off unless the daemon runs with `MAESTRO_KIT_GALLERY=1` (`shared/kit.ts`). To shoot it:

```sh
MAESTRO_KIT_GALLERY=1 bun scripts/dogfood/up.ts --plugin "$PWD"
bun scripts/dogfood/shot.ts --out /tmp/kit --no-open --wait-for "Component kit" \
  --path "/h/{server}/plugin/maestro/surface/kit?param.section=phone" --height 2300
```

M1–M5 (BRO-3037 PR 1, `client/phone/`) adopted the phone shell: the Deck, the pull-up sheet carrying the tab bar, the swipe rows, the undo toast and the card that rises, on the live Feed and Decisions tabs. The gallery's `m1` section (and its `param.hold`) went with them; its `phone` and `undertow` sections keep the states the live screen does not reach.

J1 (BRO-3035, `client/home.tsx`) adopted the desktop parts: `InspectorPanel` (scoped to the screen's root, so Esc is Maestro's only while Maestro has focus), `GlanceTile`, `UndoToast` and `Undertow` on running rows. Its entries left the gallery's Desktop section, which is gone; the phone's inspector card, toast and Undertow stay until M1–M4.

A screen ticket that adopts a part (BRO-3035 J1, BRO-3036 J2–J9, BRO-3037 M1–M11) deletes that part's
entries from the gallery and from `P-kit-gallery` in `docs/design/next/inventory.yaml`; the gallery goes with
its last part.
