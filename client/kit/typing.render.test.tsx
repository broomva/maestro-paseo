// Render tests for typing on the phone's ask card (BRO-3180): the caret stays where you put it while the screen lags a
// keystroke behind, the card ends on the keyboard, and choosing Other puts the caret in its field and that field in
// view. Setup as client/kit/kit.render.test.tsx: react-native-web in a happy-dom window, the host's kit as plain parts.

import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactNode } from "react";

const SLOW = 30_000;

const win = new Window({ url: "http://localhost/" });
type Listener = (event: { matches: boolean }) => void;
type MediaList = {
  matches: boolean;
  addEventListener(type: string, fn: Listener): void;
  removeEventListener(type: string, fn: Listener): void;
};
const current = (query: string) => {
  const live = (globalThis as { window?: { matchMedia?: (query: string) => MediaList } }).window;
  return live && live !== (win as unknown) ? live.matchMedia?.(query) : undefined;
};
Object.assign(win, {
  matchMedia: (query: string) => ({
    media: query,
    get matches() {
      return current(query)?.matches ?? query.includes("reduce");
    },
    addEventListener: (type: string, fn: Listener) => current(query)?.addEventListener(type, fn),
    removeEventListener: (type: string, fn: Listener) => current(query)?.removeEventListener(type, fn),
  }),
});
const added: string[] = [];
for (const key of [...Object.getOwnPropertyNames(win), "window", "document", "navigator"]) {
  if (key in globalThis && key !== "window" && key !== "document" && key !== "navigator") continue;
  (globalThis as Record<string, unknown>)[key] =
    key === "window" ? win : (win as unknown as Record<string, unknown>)[key];
  added.push(key);
}
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (frame: (now: number) => void) => setTimeout(() => frame(performance.now()), 16),
  cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
});
const web = (() => {
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  const module = require("react-native-web");
  void module.Animated;
  process.env.NODE_ENV = env;
  return module;
})();
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

const { act, useState, useEffect } = await import("react");
const { createRoot } = require("react-dom/client") as {
  createRoot(container: unknown): { render(node: ReactNode): void; unmount(): void };
};
const { DraftInput } = await import("./draft-input");
const { InspectorCard } = await import("./inspector");
const { OTHER_ROW } = await import("./inspector-model");
const { GALLERY_LIGHT, ASK } = await import("./gallery-data");
const { BOTH_WAYS } = await import("./assumptions");

const theme = GALLERY_LIGHT;
const settle = (ms = 30) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const mounted: (() => void)[] = [];
const ignore = () => undefined;
const consoleError = spyOn(console, "error").mockImplementation(() => {});

type Area = {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  setSelectionRange(start: number, end: number): void;
  dispatchEvent(event: unknown): boolean;
  getAttribute(name: string): string | null;
};

async function mount(node: ReactNode) {
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  await settle();
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container as unknown as { querySelector(selector: string): Area | null };
}

/** Types `text` at the caret, as the browser does: the native value changes, then an input event. */
async function typeAt(area: Area, text: string) {
  const at = area.selectionStart;
  const next = area.value.slice(0, at) + text + area.value.slice(area.selectionEnd);
  const setter = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(area, next);
    area.setSelectionRange(at + text.length, at + text.length);
    area.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  const logged = consoleError.mock.calls.map((args) => String(args[0]));
  consoleError.mockClear();
  expect(logged).toEqual([]);
});

afterAll(async () => {
  consoleError.mockRestore();
  mock.module("@getpaseo/plugin/client/react-native", () => ({}));
  mock.module("react-native", () => ({}));
  for (const key of added) delete (globalThis as Record<string, unknown>)[key];
  delete (win as unknown as Record<string, unknown>).visualViewport;
  await win.happyDOM.close();
});

/**
 * The phone shell, slowed down: it renders your words `lag` ms after you type them, the way a big screen re-renders
 * after the next keystroke has already landed. `outside` lets a test change the words as the screen would (cleared).
 */
const renders: string[] = [];

function SlowOwner({
  initial,
  lag,
  outside,
}: {
  initial: string;
  lag: number;
  outside: { set?: (v: string) => void };
}) {
  const [words, setWords] = useState(initial);
  renders.push(words);
  useEffect(() => {
    outside.set = setWords;
  }, [outside]);
  return (
    <DraftInput
      testID="draft"
      multiline
      value={words}
      onChangeText={(text) => {
        setTimeout(() => setWords(text), lag);
      }}
    />
  );
}

describe("typing mid-text (BRO-3180, the caret jump)", () => {
  test(
    "the caret stays where you put it while the screen renders a keystroke late",
    async () => {
      const outside: { set?: (v: string) => void } = {};
      const view = await mount(<SlowOwner initial="hello world" lag={20} outside={outside} />);
      // Read fresh each time: a field remounted on a stale value is a new element, and the old one keeps your text.
      const field = () => {
        const found = view.querySelector('[data-testid="draft"]');
        if (!found) throw new Error("no field");
        return found;
      };
      const area = field();
      expect(area.value).toBe("hello world");
      // The caret goes back after "hello", and two letters land before the screen has rendered the first.
      area.setSelectionRange(5, 5);
      await typeAt(area, ",");
      await settle(8);
      await typeAt(area, "!");
      // 20 ms after the comma the screen renders "hello, world", one keystroke stale; the "!" lands 8 ms later.
      await settle(16);
      expect(renders).toContain("hello, world");
      // The stale render was not written back over what you typed.
      expect(field().value).toBe("hello,! world");
      await settle(40);
      expect(field()).toBe(area);
      expect(field().value).toBe("hello,! world");
      expect(field().selectionStart).toBe(7);
      await typeAt(field(), "?");
      await settle(60);
      expect(field().value).toBe("hello,!? world");
      expect(field().selectionStart).toBe(8);
    },
    SLOW,
  );
  test(
    "words the screen changes itself replace the field: cleared once the answer lands",
    async () => {
      const outside: { set?: (v: string) => void } = {};
      const view = await mount(<SlowOwner initial="draft" lag={0} outside={outside} />);
      const area = () => view.querySelector('[data-testid="draft"]');
      await typeAt(area() as Area, " more");
      await settle();
      await act(async () => outside.set?.(""));
      await settle();
      expect(area()?.value).toBe("");
    },
    SLOW,
  );
});

type Viewport = {
  height: number;
  offsetTop: number;
  listeners: Set<() => void>;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
};

function fakeViewport(height: number): Viewport {
  const listeners = new Set<() => void>();
  return {
    height,
    offsetTop: 0,
    listeners,
    addEventListener: (_type, fn) => listeners.add(fn),
    removeEventListener: (_type, fn) => listeners.delete(fn),
  };
}

if (ASK.kind !== "ask") throw new Error("the gallery's ask is an ask");
const OTHER_ASK = { ...ASK, options: [...ASK.options, OTHER_ROW] };

function Card({ onChooseSeen }: { onChooseSeen?: (id: string) => void }) {
  const [chosen, setChosen] = useState(OTHER_ASK.chosen);
  const [words, setWords] = useState("");
  return (
    <InspectorCard
      theme={theme}
      item={{ ...OTHER_ASK, chosen }}
      index={0}
      total={1}
      open
      height={874}
      safeBottom={34}
      onClose={ignore}
      onMore={ignore}
      onVerb={ignore}
      onIndexChange={ignore}
      directions={BOTH_WAYS}
      words={words}
      onWords={setWords}
      onChoose={(id) => {
        setChosen(id);
        onChooseSeen?.(id);
      }}
    />
  );
}

describe("the ask card over the keyboard (BRO-3180)", () => {
  test(
    "ends where the keyboard begins, and comes back down when it goes",
    async () => {
      const viewport = fakeViewport(874);
      Object.assign(win, { innerHeight: 874, visualViewport: viewport });
      const view = await mount(<Card />);
      const card = () => view.querySelector('[data-testid="inspector-card"]')?.getAttribute("style") ?? "";
      expect(card()).toContain("bottom: 0px");
      viewport.height = 538;
      await act(async () => {
        for (const fn of viewport.listeners) fn();
      });
      await settle();
      expect(card()).toContain("bottom: 336px");
      viewport.height = 874;
      await act(async () => {
        for (const fn of viewport.listeners) fn();
      });
      await settle();
      expect(card()).toContain("bottom: 0px");
    },
    SLOW,
  );
  test(
    "choosing Other puts the caret in its field",
    async () => {
      Object.assign(win, { innerHeight: 874, visualViewport: fakeViewport(874) });
      const seen: string[] = [];
      const view = await mount(<Card onChooseSeen={(id) => seen.push(id)} />);
      const other = view.querySelector('[aria-label="Other…"]') as unknown as { click(): void } | null;
      if (!other) throw new Error("no Other row");
      await act(async () => other.click());
      await settle();
      expect(seen).toEqual(["maestro:other"]);
      const field = view.querySelector("textarea");
      expect(field).toBeTruthy();
      expect(win.document.activeElement as unknown).toBe(field);
    },
    SLOW,
  );
});
