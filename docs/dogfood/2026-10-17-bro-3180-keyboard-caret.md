# Dogfood receipt: typing on the ask card above the keyboard, caret in place (BRO-3180 A, #84 + #85)

Date: 2026-10-17. Ticket: BRO-3180, parts 1 and 2.

## Surface, and what it is not

| Surface | What it was | Strength |
|---|---|---|
| **The deployed build, at phone size** | The running Paseo.app main process (Node inspector on 127.0.0.1:9229 via `SIGUSR1`). It opened a hidden 402×874 `BrowserWindow` with the app's own preload, at `paseo://app/h/srv_T-uYNNfjKK-J/plugin/maestro/sidebar/maestro`: the live daemon and the live plugin. Clicks were real `sendInputEvent` mouse events, typing was `webContents.insertText` (Chromium's own input path), and capture was `capturePage()`. | The real plugin on the owner's data in the phone layout. **Not a device and not the native iOS app.** RN-web at an iPhone size. Chromium has no software keyboard, so the keyboard is simulated (below). |

**How the keyboard is simulated.** Before the card opens, the page's `visualViewport` is replaced with a stand-in, which the card's inset hook reads when it appears. The stand-in's height is then cut by 336 px, an iPhone keyboard. A grey 336 px block is drawn at the bottom for the screenshot only (`pointer-events: none`). This exercises the web branch of `watchKeyboardInset` and everything after it. The native branch (RN `Keyboard` events, `measureInWindow`) is covered by `client/phone/keyboard-native.render.test.tsx` and by the owner's phone.

**Writes:** none. The ask used is the owner's real `universe-seed` ask (screenshot 5 of the ticket). Other was chosen and words were typed, but nothing was answered: no Answer and no Skip, and the card was closed. **No owner ask was answered.**

## Rows, #84 (deployed as 26e7e95)

| Row (the ticket's Done) | Result | Evidence |
|---|---|---|
| Choosing **Other…** puts the caret in its field | pass | One real click on the Other row → `document.activeElement` is the card's textarea, placeholder "Your answer, since none of the options fit". `1-live-other-focused.png` |
| The card ends on the keyboard; Skip/Answer stay reachable | pass | With the keyboard up: the card's `bottom` is `336px`, and the verb bar is at 461–538, right above the keyboard's top at 538. `2-live-keyboard-field-visible.png` |
| **Editing mid-text keeps the caret** | pass | Typed "hello world", put the caret after "hello" (5), typed "," then " there". The value is `hello, there world` and the caret is at 12, where the typing ended, not at the end (18). The field kept focus. `3-live-caret-mid-text.png` |
| The focused field is in view above the keyboard | **fail on #84** → fixed in #85 | The field was left at 607–667, under the keyboard. After typing it moved to 431–491, still behind the bar (461). Cause: the reveal used a place cached from `onLayout`; on the web a view that moves without resizing reports no layout, and the ask's pictures loading above the field left the cache 46 px short (the field's real place in the content was 657). #85 measures at reveal time. |

## Rows, #85 (deployed as cf70040)

**A trap in the surface, and how it was closed.** A hidden (`show: false`) window never has OS focus, so the page
gets no `focus` or `blur` events. `element.focus()` moves `activeElement` and fires nothing. The card's `onFocus`
never ran there, and every reveal stopped at its first check. The hook's state, read from the React fiber, showed
`focused: false` while the textarea was active. A real phone does not have this problem. The live check now turns on
Chromium's `Emulation.setFocusEmulationEnabled` through the window's debugger before loading.

| Row | Result | Evidence |
|---|---|---|
| Choosing **Other…** puts the caret in its field | pass | One real click, then `activeElement` is the card's textarea. |
| **The focused field is in view above the keyboard** | **pass** | Keyboard up: the field is at **385–445**. Its bottom plus the 16 px margin is exactly the visible scroll's bottom (461), above the verb bar (461) and the keyboard (538). The hook's state reads `scrolled: 408, focused: true`, the target computed from the measured content place (657 + 60 + 16 − 325). `4-live-a2-field-above-keyboard.png` |
| **Editing mid-text keeps the caret** | pass | Typed "hello world", put the caret after "hello", typed "," and " there": the value is `hello, there world` and the caret is at 12. The next lines typed went in at the caret ("hello, there⏎line two⏎line three⏎line four world"), and the field stayed in view. `5-live-a2-typing-grown.png` |
| Skip and Answer reachable above the keyboard | pass | The bar is at 461–538, on the keyboard's top. `5-live-a2-typing-grown.png` |

The scripts are kept beside the shots: `cdp-eval.ts` evaluates an expression in Paseo.app's main process over its
inspector, and `live-a2-check.js` is the #85 check.

**Left behind:** Paseo.app's Node inspector stays open on 127.0.0.1:9229 until the app restarts (`SIGUSR1` cannot
be undone), as in the BRO-3172 and BRO-3167 receipts. The hidden window was destroyed.

## What only the phone can show

- The native keyboard path: RN `keyboardWillShow` measured against the card with `measureInWindow`. It is
  unit-tested (`client/phone/keyboard-native.render.test.tsx`), including Fabric applying a scroll a frame late.
- Whether iOS's own caret handling agrees with the uncontrolled field. The cause (a stale value written back) is
  removed, and a test types mid-text against a screen that renders one keystroke late.
