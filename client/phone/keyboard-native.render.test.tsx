// The ask card's keyboard on iOS (BRO-3180, P20 round 1): the native path of watchKeyboardInset, driven by a fake
// Keyboard and a fake view, and the card's scroll-into-view (useTypingInView in a bare component, with a fake scroll).
// react-native is react-native-web, mocked exactly as the other render tests mock it, since bun shares the module
// registry between test files: a different mock here would leak into theirs.

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactNode } from "react";

const SLOW = 30_000;
const win = new Window({ url: "http://localhost/" });
const added: string[] = [];
for (const key of [...Object.getOwnPropertyNames(win), "window", "document", "navigator"]) {
  if (key in globalThis && key !== "window" && key !== "document" && key !== "navigator") continue;
  (globalThis as Record<string, unknown>)[key] =
    key === "window" ? win : (win as unknown as Record<string, unknown>)[key];
  added.push(key);
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const web = (() => {
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  const module = require("react-native-web");
  process.env.NODE_ENV = env;
  return module;
})();

type Shown = { endCoordinates: { height: number; screenY: number } };
const listeners = new Map<string, Set<(event: Shown) => void>>();
let upNow: { height: number; screenY: number } | undefined;
const keyboard = {
  addListener(type: string, fn: (event: Shown) => void) {
    const set = listeners.get(type) ?? new Set();
    set.add(fn);
    listeners.set(type, set);
    return { remove: () => set.delete(fn) };
  },
  isVisible: () => upNow !== undefined,
  metrics: () => upNow,
};
const emit = (type: string, event: Shown) => {
  for (const fn of listeners.get(type) ?? []) fn(event);
};
mock.module("react-native", () => web);
mock.module("@getpaseo/plugin/client/react-native", () => ({
  ScrollView: web.ScrollView,
  FlatList: web.FlatList,
  TextInput: web.TextInput,
  Icon: () => null,
  Modal: Object.assign(({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null), {
    Content: ({ children }: { children: ReactNode }) => children,
  }),
  useToast: () => ({ show() {}, error() {} }),
  useRevealedText: (text: string) => text,
}));

const { act } = await import("react");
const { createRoot } = require("react-dom/client") as {
  createRoot(container: unknown): { render(node: ReactNode): void; unmount(): void };
};
const { watchKeyboardInset } = await import("./keyboard-lift");
const { useTypingInView } = await import("../kit/inspector");

const mounted: (() => void)[] = [];
async function mount(node: ReactNode) {
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  mounted.push(() => act(() => root.unmount()));
  return { rerender: (next: ReactNode) => act(async () => root.render(next)) };
}

afterAll(async () => {
  for (const unmount of mounted.splice(0)) unmount();
  mock.module("@getpaseo/plugin/client/react-native", () => ({}));
  mock.module("react-native", () => ({}));
  for (const key of added) delete (globalThis as Record<string, unknown>)[key];
  await win.happyDOM.close();
});

type Box = { y: number; height: number } | null;
const IOS = { show: "keyboardWillShow", hide: "keyboardWillHide" };
function watch(box: Box, seen: number[]) {
  const view = {
    current: box ? { measureInWindow: (done: (...at: number[]) => void) => done(0, box.y, 402, box.height) } : null,
  };
  const stop = watchKeyboardInset({ view, platform: "ios", keyboard, events: IOS, page: undefined }, (inset) =>
    seen.push(inset),
  );
  stopped.push(stop);
}
const stopped: (() => void)[] = [];

describe("the keyboard over the ask card on iOS", () => {
  afterEach(() => {
    for (const stop of stopped.splice(0)) stop();
  });
  test(
    "covers the card by its bottom edge less the keyboard's top, and lets go when it hides",
    async () => {
      const seen: number[] = [];
      watch({ y: 0, height: 874 }, seen);
      expect(seen).toEqual([]);
      emit("keyboardWillShow", { endCoordinates: { height: 336, screenY: 538 } });
      expect(seen.at(-1)).toBe(336);
      emit("keyboardWillHide", { endCoordinates: { height: 0, screenY: 874 } });
      expect(seen.at(-1)).toBe(0);
    },
    SLOW,
  );
  test(
    "a card that ends above the bottom is covered only where it meets the keyboard",
    async () => {
      const seen: number[] = [];
      watch({ y: 0, height: 700 }, seen);
      emit("keyboardWillShow", { endCoordinates: { height: 336, screenY: 538 } });
      expect(seen.at(-1)).toBe(162);
    },
    SLOW,
  );
  test(
    "a card it cannot measure takes the keyboard's whole height: over the keyboard there is no safe area",
    async () => {
      const seen: number[] = [];
      watch(null, seen);
      emit("keyboardWillShow", { endCoordinates: { height: 336, screenY: 538 } });
      expect(seen.at(-1)).toBe(336);
    },
    SLOW,
  );
  test(
    "a keyboard already up when the card opens is read at once",
    async () => {
      upNow = { height: 336, screenY: 538 };
      const seen: number[] = [];
      watch({ y: 0, height: 874 }, seen);
      upNow = undefined;
      expect(seen.at(-1)).toBe(336);
    },
    SLOW,
  );
});

type Typing = ReturnType<typeof useTypingInView>;
function Reveal({ itemKey, inset, out }: { itemKey: string; inset: number; out: { now?: Typing } }) {
  out.now = useTypingInView(itemKey, inset);
  return null;
}
const layout = (y: number, height: number) =>
  ({ nativeEvent: { layout: { x: 0, y, width: 360, height } } }) as Parameters<Typing["field"]["onLayout"]>[0];

describe("the field you type in stays in view", () => {
  test(
    "focusing a field under the fold scrolls it into view, and one already in view stays put",
    async () => {
      const out: { now?: Typing } = {};
      const calls: number[] = [];
      await mount(<Reveal itemKey="a" inset={0} out={out} />);
      const typing = out.now as Typing;
      (typing.scroll as { current: unknown }).current = { scrollTo: ({ y }: { y: number }) => calls.push(y) };
      typing.onViewport(layout(0, 380));
      typing.field.onLayout(layout(600, 60));
      // Not focused: nothing moves.
      expect(calls).toEqual([]);
      typing.field.onFocus();
      // 600 + 18 (the card's top padding) + 60 + 16 margin − 380 shown.
      expect(calls).toEqual([314]);
      // It grows a line while you type: scrolled again so its bottom stays in view.
      typing.field.onLayout(layout(600, 84));
      expect(calls).toEqual([314, 338]);
      // In view already: left alone.
      typing.field.onLayout(layout(600, 84));
      expect(calls).toEqual([314, 338]);
    },
    SLOW,
  );
  test(
    "the next ask starts fresh: no scroll from the last ask's field",
    async () => {
      const out: { now?: Typing } = {};
      const calls: number[] = [];
      const view = await mount(<Reveal itemKey="a" inset={0} out={out} />);
      let typing = out.now as Typing;
      const scroll = { scrollTo: ({ y }: { y: number }) => calls.push(y) };
      (typing.scroll as { current: unknown }).current = scroll;
      typing.onViewport(layout(0, 380));
      typing.field.onLayout(layout(600, 60));
      typing.field.onFocus();
      expect(calls).toEqual([314]);
      // Swiped to the next ask: its field is not laid out yet and not focused, so the keyboard rising moves nothing.
      await view.rerender(<Reveal itemKey="b" inset={336} out={out} />);
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
      typing = out.now as Typing;
      (typing.scroll as { current: unknown }).current = scroll;
      typing.onViewport(layout(0, 200));
      expect(calls).toEqual([314]);
    },
    SLOW,
  );
});
