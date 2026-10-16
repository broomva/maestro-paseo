// Render tests for the J/M kit: the real components, mounted with react-dom
// through react-native-web in a happy-dom window, the way Paseo's web and
// desktop builds run them. The setup mirrors client/new-work.render.test.tsx
// (see its header for the traps): globals first, react-native mocked as
// react-native-web, the host's kit as plain parts, everything else imported
// dynamically, and both mocked modules put back in afterAll. The window's
// matchMedia answers "reduce" for reduced motion, so springs land at once and
// a position can be read straight after a press. Gesture thresholds are the
// models' tests (sheet.test.ts, swipe.test.ts, deck.test.ts); these prove the
// components wire them: one Animated.View carries the tab bar and the sheet,
// the toast's Undo and expiry, no actions behind a hold, the Undertow on
// running only, the inspector's verbs and Esc, and the gallery behind its flag.

import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactNode } from "react";

const SLOW = 30_000;
const it = (name: string, run: () => Promise<void>) => test(name, run, SLOW);

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

const { act, useState } = await import("react");
const { createRoot } = require("react-dom/client") as {
  createRoot(container: unknown): { render(node: ReactNode): void; unmount(): void };
};
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { PluginRpcProvider } = await import("@getpaseo/plugin/client/host");
const { UNDO_MS } = await import("../../shared/undo");
const { GALLERY_LIGHT, APPROVAL, ASK, OWNER_STEP, NOTICE, WORK, REVIEW } = await import("./gallery-data");
const { BOTH_WAYS, LEFTWARD } = await import("./assumptions");
const { PullSheet, PEEK, TAB_BAND } = await import("./pull-sheet");
const { TabBar } = await import("./tab-bar");
const { UndoToast, useUndoToast } = await import("./undo-toast");
const { undoEntry } = await import("./undo-model");
const { SwipeRow } = await import("./swipe-row");
const { Undertow, TidepoolDot, StandingPulse } = await import("./undertow");
const { InspectorPanel, InspectorCard } = await import("./inspector");
const { DetailHeader } = await import("./detail-header");
const { GlanceTile } = await import("./glance-tile");
const { Deck, DeckHold } = await import("./deck");
const { KitGalleryScreen } = await import("./gallery");
type UndoClock = import("./undo-model").UndoClock;
type InspectorItem = import("./inspector").InspectorItem;

const theme = GALLERY_LIGHT;
let galleryOn = true;
const invoke = async (method: string) => {
  if (method === "kit.gallery") return { enabled: galleryOn };
  throw new Error(`unexpected RPC ${method}`);
};

const settle = (ms = 30) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const mounted: (() => void)[] = [];

interface El {
  tagName: string;
  textContent: string | null;
  parentElement: El | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): El | null;
  querySelectorAll(selector: string): ArrayLike<El>;
  contains(other: El): boolean;
  click(): void;
}

async function mount(node: ReactNode) {
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PluginRpcProvider invoke={invoke}>{node}</PluginRpcProvider>
      </QueryClientProvider>,
    ),
  );
  await settle();
  await settle();
  mounted.push(() => {
    act(() => root.unmount());
    client.clear();
    container.remove();
  });
  const box = container as unknown as El;
  const one = (selector: string) => box.querySelector(selector);
  return {
    text: () => box.textContent ?? "",
    one,
    all: (selector: string) => [...(box.querySelectorAll(selector) as unknown as El[])],
    id: (testID: string) => one(`[data-testid="${testID}"]`),
    label: (name: string) => one(`[aria-label="${name}"]`),
    press: async (target: El | null | undefined) => {
      if (!target) throw new Error("nothing to press");
      await act(async () => target.click());
      await settle();
    },
    key: async (key: string) => {
      await act(async () => {
        win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true }));
      });
      await settle();
    },
  };
}

/** The translateY a react-native-web view carries, in px. */
const translateY = (el: El | null) => {
  const match = /translateY\((-?[\d.]+)px\)/.exec(el?.getAttribute("style") ?? "");
  return match ? Number(match[1]) : null;
};

const ignore = () => undefined;
const consoleError = spyOn(console, "error").mockImplementation(() => {});

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  galleryOn = true;
  const logged = consoleError.mock.calls.map((args) => String(args[0]));
  consoleError.mockClear();
  expect(logged).toEqual([]);
});

afterAll(async () => {
  consoleError.mockRestore();
  mock.module("@getpaseo/plugin/client/react-native", () => ({}));
  mock.module("react-native", () => ({}));
  for (const key of added) delete (globalThis as Record<string, unknown>)[key];
  await win.happyDOM.close();
});

const TABS = [
  { id: "feed", label: "Feed", icon: "Inbox", badge: 4, badgeTone: "needs" as const },
  { id: "work", label: "Work", icon: "LayoutList" },
];

describe("the pull-up sheet carries the tab bar on one Animated value", () => {
  const H = 760;
  const TOP = 64;
  const sheet = (onPosition: (position: 0 | 1) => void = ignore) => (
    <PullSheet
      theme={theme}
      height={H}
      top={TOP}
      inset={0}
      tabBar={<TabBar theme={theme} tabs={TABS} active="feed" onSelect={ignore} onNew={ignore} />}
      title="Everything else"
      onPosition={onPosition}
    >
      {null}
    </PullSheet>
  );

  it("the tab bar and the sheet are the two children of the one moving view", async () => {
    const view = await mount(sheet());
    const rider = view.id("pull-sheet-rider");
    const band = view.id("pull-sheet-tab-band");
    const panel = view.id("pull-sheet");
    expect(rider && band && panel).toBeTruthy();
    expect(band?.parentElement).toBe(rider);
    expect(panel?.parentElement).toBe(rider);
    expect(band?.contains(view.id("tab-bar") as El)).toBe(true);
  });

  it("its full-height root lets touches through to the deck (box-none as a class, never inline)", async () => {
    const view = await mount(sheet());
    const root = view.id("pull-sheet-root");
    expect(root).toBeTruthy();
    // Inline, "box-none" is not CSS and the root would swallow every press over the deck.
    expect(root?.getAttribute("style") ?? "").not.toContain("pointer-events");
    expect(root?.getAttribute("class") ?? "").toContain("pointerEvents");
  });

  it("it clears the home indicator: the peek sits above it, the sheet still reaches the edge", async () => {
    const view = await mount(
      <PullSheet theme={theme} height={H} top={TOP} inset={0} safeBottom={34} tabBar={null} title="Everything else">
        {null}
      </PullSheet>,
    );
    expect(translateY(view.id("pull-sheet-rider"))).toBe(H - 34 - PEEK - TAB_BAND);
  });

  it("down, the tab bar sits on the peek; raised, it rides up to the top with the sheet", async () => {
    const seen: number[] = [];
    const view = await mount(sheet((position) => seen.push(position)));
    const rider = view.id("pull-sheet-rider");
    expect(translateY(rider)).toBe(H - PEEK - TAB_BAND);
    await view.press(view.label("Raise the sheet"));
    expect(translateY(view.id("pull-sheet-rider"))).toBe(TOP);
    expect(seen).toEqual([1]);
    await view.press(view.label("Lower the sheet"));
    expect(translateY(view.id("pull-sheet-rider"))).toBe(H - PEEK - TAB_BAND);
  });
});

function SheetToastHost({ clock }: { clock: UndoClock }) {
  const toast = useUndoToast(ignore, clock);
  return (
    <PullSheet
      theme={theme}
      height={760}
      top={64}
      inset={0}
      tabBar={
        <web.Pressable
          accessibilityRole="button"
          accessibilityLabel="Continue"
          onPress={() => toast.show(undoEntry("receipt-f1", "Continued", clock.now()))}
        />
      }
      title="Everything else"
      toast={(place) => (
        <UndoToast
          theme={theme}
          entry={toast.entry}
          onUndo={toast.undo}
          bottom={place.bottom}
          lift={place.lift}
          now={clock.now}
        />
      )}
    >
      {null}
    </PullSheet>
  );
}

describe("the toast rides the sheet's value", () => {
  it("above the tab bar when the sheet is down, at the bottom edge when it is up", async () => {
    const fake = fakeClock();
    const view = await mount(<SheetToastHost clock={fake.clock} />);
    await view.press(view.label("Continue"));
    const toast = () => view.id("undo-toast");
    expect(toast()).toBeTruthy();
    const style = () => toast()?.getAttribute("style") ?? "";
    expect(style()).toContain("bottom: 10px");
    expect(translateY(toast())).toBe(-(PEEK + TAB_BAND));
    await view.press(view.label("Raise the sheet"));
    expect(translateY(toast())).toBe(0);
  });
});

/** The toast wired the way a screen wires it, on a clock the test moves. */
function fakeClock() {
  let now = 5_000_000;
  const timers = new Set<{ at: number; run: () => void }>();
  const clock: UndoClock = {
    now: () => now,
    setTimeout: (run, ms) => {
      const timer = { at: now + ms, run };
      timers.add(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as { at: number; run: () => void });
    },
  };
  const tick = (ms: number) => {
    now += ms;
    for (const timer of [...timers])
      if (timer.at <= now) {
        timers.delete(timer);
        timer.run();
      }
  };
  return { clock, tick };
}

function ToastHost({ clock, onUndo }: { clock: UndoClock; onUndo: (receipt: string) => void }) {
  const toast = useUndoToast(onUndo, clock);
  return (
    <>
      <web.Pressable
        accessibilityRole="button"
        accessibilityLabel="Allow"
        onPress={() => toast.show(undoEntry("receipt-933", "Allowed #933", clock.now(), undefined, "merges in"))}
      />
      <UndoToast theme={theme} entry={toast.entry} onUndo={toast.undo} now={clock.now} />
    </>
  );
}

describe("the undo toast: 8 s, then gone; Undo inside the window", () => {
  it("shows the countdown from 8 s and Undo hands the receipt back", async () => {
    const fake = fakeClock();
    const undone: string[] = [];
    const view = await mount(<ToastHost clock={fake.clock} onUndo={(receipt) => undone.push(receipt)} />);
    await view.press(view.label("Allow"));
    expect(view.id("undo-toast")).toBeTruthy();
    expect(view.text()).toContain("Allowed #933 · merges in 8 s");
    await view.press(view.label("Undo: Allowed #933"));
    expect(undone).toEqual(["receipt-933"]);
    expect(view.id("undo-toast")).toBeNull();
  });

  it("goes by itself at 8 s, and an Undo after that does nothing", async () => {
    const fake = fakeClock();
    const undone: string[] = [];
    const view = await mount(<ToastHost clock={fake.clock} onUndo={(receipt) => undone.push(receipt)} />);
    await view.press(view.label("Allow"));
    await act(async () => fake.tick(UNDO_MS - 1));
    await settle();
    expect(view.id("undo-toast")).toBeTruthy();
    await act(async () => fake.tick(1));
    await settle();
    expect(view.id("undo-toast")).toBeNull();
    expect(undone).toEqual([]);
  });
});

describe("the swipe row", () => {
  const actions = {
    snooze: { label: "Snooze 4h", icon: "AlarmClock", onPress: ignore },
    open: { label: "Open", icon: "ArrowUpRight", onPress: ignore },
  };
  it("a hold draws no actions behind it, even asked to show them", async () => {
    const view = await mount(
      <SwipeRow
        theme={theme}
        kind="approval"
        title="Allow merging workspace#933?"
        {...actions}
        preview="open"
        directions={BOTH_WAYS}
      />,
    );
    expect(view.label("Open")).toBeNull();
    expect(view.label("Snooze 4h")).toBeNull();
  });
  it("a sheet row shows Snooze and Open on its left swipe, and Open acts", async () => {
    const opened: string[] = [];
    const view = await mount(
      <SwipeRow
        theme={theme}
        kind="notice"
        title="Quiet for 808 minutes"
        snooze={actions.snooze}
        open={{ ...actions.open, onPress: () => opened.push("open") }}
        preview="open"
        directions={BOTH_WAYS}
      />,
    );
    expect(view.label("Snooze 4h")).toBeTruthy();
    await view.press(view.label("Open"));
    expect(opened).toEqual(["open"]);
  });
});

/** A mouse drag over an element, as react-native-web's responder system reads one. */
async function drag(target: El | null, dx: number, dy = 0) {
  if (!target) throw new Error("nothing to drag");
  const at = { x: 200, y: 100 };
  let clock = 1000;
  const mouse = (type: string, x: number, y: number, on: unknown) => {
    const event = new win.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
    });
    // happy-dom leaves pageX/pageY and a moving timeStamp out; react-native-web's responder reads them.
    clock += 16;
    for (const [key, value] of [
      ["pageX", x],
      ["pageY", y],
      ["timeStamp", clock],
    ] as const)
      Object.defineProperty(event, key, { value });
    (on as { dispatchEvent(e: unknown): boolean }).dispatchEvent(event);
  };
  // Each event in its own act, as a finger's events arrive frames apart: a render lands between them.
  await act(async () => {
    mouse("mousedown", at.x, at.y, target);
  });
  for (let step = 1; step <= 8; step += 1)
    await act(async () => {
      mouse("mousemove", at.x + (dx * step) / 8, at.y + (dy * step) / 8, target);
    });
  await settle();
  await act(async () => {
    mouse("mouseup", at.x + dx, at.y + dy, target);
  });
  await settle(60);
}

describe("on compact native (BRO-3033 fact 3)", () => {
  it("a row's default verb is a left action, and it acts", async () => {
    const done: string[] = [];
    const view = await mount(
      <SwipeRow
        theme={theme}
        kind="finished"
        title="GitHub identity: PR #12 merged"
        primary={{ label: "Continue", icon: "Play", onPress: () => done.push("continue") }}
        open={{ label: "Open", icon: "ArrowUpRight", onPress: ignore }}
        preview="open"
        directions={LEFTWARD}
      />,
    );
    await view.press(view.label("Continue"));
    expect(done).toEqual(["continue"]);
  });
  it("a row whose actions a swipe revealed closes on a tap, and does not open the item", async () => {
    const pressed: string[] = [];
    const view = await mount(
      <SwipeRow
        theme={theme}
        kind="finished"
        title="GitHub identity: PR #12 merged"
        onPress={() => pressed.push("item")}
        primary={{ label: "Continue", icon: "Play", onPress: () => pressed.push("continue") }}
        open={{ label: "Open", icon: "ArrowUpRight", onPress: () => pressed.push("open") }}
        directions={LEFTWARD}
      />,
    );
    const row = view.label("GitHub identity: PR #12 merged");
    await drag(row, -160);
    expect(view.label("Continue")).toBeTruthy();
    await view.press(view.label("GitHub identity: PR #12 merged"));
    expect(pressed).toEqual([]);
    expect(view.label("Continue")).toBeNull();
    await view.press(view.label("GitHub identity: PR #12 merged"));
    expect(pressed).toEqual(["item"]);
  });
  it("the deck pages by its segments, and opens on the hold it was given", async () => {
    function Host() {
      const [index, setIndex] = useState(0);
      return (
        <Deck
          theme={theme}
          title="Needs you"
          items={[APPROVAL, ASK, NOTICE]}
          index={index}
          onIndexChange={setIndex}
          keyOf={(item) => item.key}
          directions={LEFTWARD}
          openOn={NOTICE.key}
          renderItem={(item) => <web.Text>{item.title}</web.Text>}
        />
      );
    }
    const view = await mount(<Host />);
    expect(view.text()).toContain("3 of 3");
    await view.press(view.label("Hold 1 of 3"));
    expect(view.text()).toContain("1 of 3");
  });

  it("Previous and Next page the deck both ways, even where a rightward swipe is the host's (BRO-3153)", async () => {
    function Host() {
      const [index, setIndex] = useState(0);
      return (
        <Deck
          theme={theme}
          title="Needs you"
          items={[APPROVAL, ASK, NOTICE]}
          index={index}
          onIndexChange={setIndex}
          keyOf={(item) => item.key}
          directions={LEFTWARD}
          renderItem={(item) => <web.Text>{item.title}</web.Text>}
        />
      );
    }
    const view = await mount(<Host />);
    expect(view.label("Previous hold")?.getAttribute("aria-disabled")).toBe("true");
    await view.press(view.label("Next hold"));
    await view.press(view.label("Next hold"));
    expect(view.text()).toContain("3 of 3");
    expect(view.label("Next hold")?.getAttribute("aria-disabled")).toBe("true");
    await view.press(view.label("Previous hold"));
    expect(view.text()).toContain("2 of 3");
  });
});

describe("the Undertow marks Running only", () => {
  it("a running card wears the halo, the ring look on request; other states wear nothing", async () => {
    const card = <web.Text>card</web.Text>;
    const view = await mount(
      <>
        <Undertow theme={theme} state="running" look="gradient">
          {card}
        </Undertow>
        <Undertow theme={theme} state="running" look="ring">
          {card}
        </Undertow>
        <Undertow theme={theme} state="standing">
          {card}
        </Undertow>
        <Undertow theme={theme} state="review">
          {card}
        </Undertow>
      </>,
    );
    expect(view.all('[data-testid="undertow-halo"]')).toHaveLength(1);
    expect(view.all('[data-testid="undertow-ring"]')).toHaveLength(1);
    expect(view.text()).toBe("cardcardcardcard");
  });
  it("the dot is for running rows, the pulse for standing", async () => {
    const view = await mount(
      ["running", "standing", "queued", "review"].map((state) => (
        <web.View key={state}>
          <TidepoolDot theme={theme} state={state} />
          <StandingPulse theme={theme} state={state} />
        </web.View>
      )),
    );
    expect(view.all('[data-testid="tidepool-dot"]')).toHaveLength(1);
    expect(view.all('[data-testid="standing-pulse"]')).toHaveLength(1);
  });
});

describe("the inspector", () => {
  it("draws each kind's verbs, never Approve, and reports the verb pressed", async () => {
    for (const item of [APPROVAL, ASK, OWNER_STEP, NOTICE, WORK, REVIEW]) {
      const verbs: string[] = [];
      const view = await mount(
        <InspectorPanel theme={theme} item={item} open onClose={ignore} onVerb={(id) => verbs.push(id)} />,
      );
      expect(view.text()).toContain(item.title);
      expect(view.text().toLowerCase()).not.toContain("approve ");
      const bar = view.id("inspector-bar");
      if (!bar) throw new Error("no action bar");
      const buttons = [...(bar.querySelectorAll('[role="button"]') as unknown as El[])];
      await view.press(buttons.at(-1));
      expect(verbs).toHaveLength(1);
      for (const unmount of mounted.splice(0)) unmount();
    }
  });
  it("closed, it leaves nothing behind: no verbs to focus or scroll into view", async () => {
    const view = await mount(
      <InspectorPanel theme={theme} item={APPROVAL} open={false} onClose={ignore} onVerb={ignore} />,
    );
    expect(view.id("inspector-panel")).toBeNull();
    expect(view.label("Allow merge")).toBeNull();
    const card = await mount(
      <InspectorCard
        theme={theme}
        item={APPROVAL}
        index={0}
        total={4}
        open={false}
        height={760}
        onClose={ignore}
        onMore={ignore}
        onVerb={ignore}
        onIndexChange={ignore}
        directions={BOTH_WAYS}
      />,
    );
    expect(card.id("inspector-card")).toBeNull();
  });
  it("Esc after pressing a card elsewhere in Maestro still sends it back", async () => {
    let closed = 0;
    const view = await mount(
      <>
        <web.Pressable accessibilityRole="button" accessibilityLabel="A rail card" onPress={ignore} />
        <InspectorPanel theme={theme} item={APPROVAL} open onClose={() => (closed += 1)} onVerb={ignore} />
      </>,
    );
    const card = view.label("A rail card") as unknown as { focus(): void; dispatchEvent(e: unknown): boolean };
    await act(async () => {
      card.focus();
      card.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    expect(closed).toBe(1);
  });
  it("Esc from a field outside Maestro is not the inspector's", async () => {
    let closed = 0;
    const view = await mount(
      <InspectorPanel theme={theme} item={APPROVAL} open onClose={() => (closed += 1)} onVerb={ignore} />,
    );
    const field = win.document.createElement("input");
    win.document.body.appendChild(field);
    await act(async () => {
      field.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    field.remove();
    expect(closed).toBe(0);
    expect(view.id("inspector-panel")).toBeTruthy();
  });
  it("only a session that waits on you wears the Needs you dot", async () => {
    const { InspectorBody } = await import("./inspector");
    // Tidepool in the light theme: #0072A3, however the style spells it.
    const tidepool = (el: El) => /0072a3|0,\s*114,\s*163/i.test(el.getAttribute("style") ?? "");
    const sessionDots = (view: { one(selector: string): El | null }) => {
      const row = view.one('[aria-label^="Session "]');
      if (!row) throw new Error("no session row");
      return [...(row.querySelectorAll("div") as unknown as El[])].filter(tidepool);
    };
    const waiting = await mount(<InspectorBody theme={theme} item={{ ...APPROVAL, history: [] }} />);
    expect(sessionDots(waiting).length).toBeGreaterThan(0);
    const idle = { ...APPROVAL, history: [], session: { name: "s", status: "idle", state: "queued" } };
    const view = await mount(<InspectorBody theme={theme} item={idle} />);
    expect(sessionDots(view)).toHaveLength(0);
  });
  it("an Answer carries the option chosen", async () => {
    const pressed: [string, string | undefined][] = [];
    const view = await mount(
      <InspectorPanel
        theme={theme}
        item={ASK}
        open
        onClose={ignore}
        onVerb={(id, choice) => pressed.push([id, choice])}
      />,
    );
    await view.press(view.label("Install fleet-wide"));
    // The primary names the option it takes by its number (J3).
    await view.press(view.label("Answer with 3"));
    expect(pressed).toEqual([["answer", "fleet"]]);
  });
  it("an owner step says where it is done and offers Done", async () => {
    const view = await mount(<InspectorPanel theme={theme} item={OWNER_STEP} open onClose={ignore} onVerb={ignore} />);
    expect(view.text()).toContain("platform.openai.com → Billing → workspace credits");
    expect(view.label("Done")).toBeTruthy();
  });
  it("Esc sends it back", async () => {
    let closed = 0;
    const view = await mount(
      <InspectorPanel theme={theme} item={APPROVAL} open onClose={() => (closed += 1)} onVerb={ignore} />,
    );
    expect(view.text()).toContain("Allow merge");
    await view.key("Escape");
    expect(closed).toBe(1);
  });
  it("the phone card says where you are and pins the kind's verbs", async () => {
    const view = await mount(
      <InspectorCard
        theme={theme}
        item={ASK}
        index={2}
        total={4}
        open
        height={760}
        onClose={ignore}
        onMore={ignore}
        onVerb={ignore}
        onIndexChange={ignore}
        directions={BOTH_WAYS}
      />,
    );
    expect(view.text()).toContain("Ask · 3 of 4");
    const bar = view.id("inspector-card-bar");
    expect(bar?.textContent).toBe("SkipAnswer");
  });
});

describe("J2–J4: the desktop's bodies (BRO-3036)", () => {
  /** Types into a field the way a keyboard does: the native setter, then an input event React hears. */
  const type = async (field: El | null, value: string) => {
    if (!field) throw new Error("nothing to type in");
    const target = field as unknown as { tagName: string; dispatchEvent(event: unknown): boolean };
    const proto = target.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(target, value);
      target.dispatchEvent(new win.Event("input", { bubbles: true }));
    });
    await settle();
  };
  const ask: Extract<InspectorItem, { kind: "ask" }> = {
    ...(ASK as Extract<InspectorItem, { kind: "ask" }>),
    cost: "Nothing blocks; the mods stay unused.",
    whyYou: "A mod that answers tool.call runs before the P2 gate.",
    goes: "Goes to the session that asked, verbatim.",
    fieldLabel: "Your words for A3",
    optionsLabel: "Options for A3",
    chosen: undefined,
  };

  it("an ask: what waiting costs and why you as two tiles, numbered answers, the recommended one named", async () => {
    const { InspectorBody } = await import("./inspector");
    const view = await mount(<InspectorBody theme={theme} item={ask} />);
    const text = view.text();
    expect(text).toContain("What waiting costsNothing blocks; the mods stay unused.");
    expect(text).toContain("Why youA mod that answers tool.call runs before the P2 gate.");
    expect(text).toContain("Keep them offRecommended");
    expect(text).toContain("Goes to the session that asked, verbatim.");
    // Numbered caps 1 to 3 on the options, nothing chosen for you.
    expect(view.label("Options for A3")?.getAttribute("role")).toBe("radiogroup");
    expect(view.all('[aria-checked="true"]')).toHaveLength(0);
  });

  it("the phone keeps its single line: no tiles, no numbers, no words field", async () => {
    const { InspectorBody } = await import("./inspector");
    const view = await mount(<InspectorBody theme={theme} item={ask} compact />);
    expect(view.text()).not.toContain("What waiting costs");
    expect(view.text()).toContain("Rec.");
    expect(view.text()).not.toContain("Recommended");
    expect(view.label("Your words for A3")).toBeNull();
  });

  it("the primary names the option by its number, the words you typed ride the verb, and the option is yours", async () => {
    const pressed: [string, string | undefined, string | undefined][] = [];
    const view = await mount(
      <InspectorPanel
        theme={theme}
        item={ask}
        open
        onClose={ignore}
        onVerb={(id, choice, words) => pressed.push([id, choice, words])}
      />,
    );
    // Nothing chosen: the primary says Answer, never "Answer with 1" for a recommendation you did not take.
    expect(view.label("Answer")).toBeTruthy();
    await view.press(view.label("Install in one worktree first"));
    await type(view.label("Your words for A3"), "After the release.");
    await view.press(view.label("Answer with 2"));
    expect(pressed).toEqual([["answer", "trial", "After the release."]]);
  });

  it("your words belong to one ask: the next ask starts with none", async () => {
    function Host() {
      const [item, setItem] = useState(ask);
      return (
        <>
          <web.Pressable
            accessibilityRole="button"
            accessibilityLabel="Next ask"
            onPress={() => setItem({ ...ask, key: "ask:next", title: "The next ask" })}
          />
          <InspectorPanel theme={theme} item={item} open onClose={ignore} onVerb={ignore} />
        </>
      );
    }
    const view = await mount(<Host />);
    await type(view.label("Your words for A3"), "Not now.");
    expect((view.label("Your words for A3") as unknown as { value: string }).value).toBe("Not now.");
    await view.press(view.label("Next ask"));
    expect(view.text()).toContain("The next ask");
    expect((view.label("Your words for A3") as unknown as { value: string }).value).toBe("");
  });

  it("words typed beside an option you did not pick never send the recommendation; the primary asks for a pick", async () => {
    const pressed: [string, string | undefined, string | undefined][] = [];
    const recommended = { ...ask, chosen: "off" };
    const view = await mount(
      <InspectorPanel
        theme={theme}
        item={recommended}
        open
        onClose={ignore}
        onVerb={(id, choice, words) => pressed.push([id, choice, words])}
      />,
    );
    // Started on its recommendation, the primary says which option it takes.
    expect(view.label("Answer with 1")).toBeTruthy();
    await type(view.label("Your words for A3"), "Not before the release.");
    // With words and no pick of yours, it says what it sends, and the recommendation is not checked.
    expect(view.label("Choose an option or Other")).toBeTruthy();
    expect(view.all('[aria-checked="true"]')).toHaveLength(0);
    await view.press(view.label("Choose an option or Other"));
    expect(pressed).toEqual([["answer", undefined, "Not before the release."]]);
    // Picking an option yourself sends it with your words.
    await view.press(view.label("Install in one worktree first"));
    expect(view.label("Answer with 2")).toBeTruthy();
    await view.press(view.label("Answer with 2"));
    expect(pressed.at(-1)).toEqual(["answer", "trial", "Not before the release."]);
  });

  it("the choice you made belongs to one item: the next starts from its own", async () => {
    const pressed: [string, string | undefined][] = [];
    function Host() {
      const [item, setItem] = useState({ ...ask, chosen: "off" });
      return (
        <>
          <web.Pressable
            accessibilityRole="button"
            accessibilityLabel="Next ask"
            onPress={() => setItem({ ...ask, key: "ask:next", title: "The next ask", chosen: "off" })}
          />
          <InspectorPanel
            theme={theme}
            item={item}
            open
            onClose={ignore}
            onVerb={(id, choice) => pressed.push([id, choice])}
          />
        </>
      );
    }
    const view = await mount(<Host />);
    await view.press(view.label("Install fleet-wide"));
    expect(view.label("Answer with 3")).toBeTruthy();
    await view.press(view.label("Next ask"));
    // The next ask is on its own recommendation again, not on the third option of the last.
    expect(view.text()).toContain("The next ask");
    expect(view.label("Answer with 1")).toBeTruthy();
    await view.press(view.label("Answer with 1"));
    expect(pressed).toEqual([["answer", "off"]]);
  });

  it("choices that are locked cannot be chosen: an answer is in flight", async () => {
    const { InspectorBody } = await import("./inspector");
    const view = await mount(<InspectorBody theme={theme} item={{ ...ask, chosen: "off" }} locked />);
    expect(view.label("Install fleet-wide")?.getAttribute("aria-disabled")).toBe("true");
    await view.press(view.label("Install fleet-wide"));
    expect(view.label("Install fleet-wide")?.getAttribute("aria-checked")).not.toBe("true");
  });

  it("an approval says what held it and what Deny does, under their own labels", async () => {
    const { InspectorBody } = await import("./inspector");
    const view = await mount(
      <InspectorBody
        theme={theme}
        item={{
          ...(APPROVAL as Extract<InspectorItem, { kind: "approval" }>),
          heldBy: "Maestro's human gate",
          afterDeny: ["It goes back to its session with your note; nothing is merged."],
        }}
      />,
    );
    const text = view.text();
    expect(text).toContain("Held byMaestro's human gate");
    expect(text).toContain("After you allow");
    expect(text).toContain("If you deny");
    expect(text).toContain("nothing is merged");
  });

  it("a notice: Cancel work… beside Open session and Unblock with a prompt…, and the prompt rides Unblock", async () => {
    const pressed: [string, string | undefined, string | undefined][] = [];
    const view = await mount(
      <InspectorPanel
        theme={theme}
        item={{ ...(NOTICE as Extract<InspectorItem, { kind: "notice" }>), prompt: true }}
        open
        onClose={ignore}
        onVerb={(id, choice, words) => pressed.push([id, choice, words])}
      />,
    );
    expect(view.label("Cancel work…")).toBeTruthy();
    expect(view.label("Open session")).toBeTruthy();
    expect(view.text().toLowerCase()).not.toContain("approve ");
    await type(view.label("A prompt for the session of Credits ledger: its session ended mid-turn"), "retry the test");
    await view.press(view.label("Unblock with a prompt…"));
    await view.press(view.label("Cancel work…"));
    expect(pressed).toEqual([
      ["unblock", undefined, "retry the test"],
      ["cancel", undefined, "retry the test"],
    ]);
  });

  it("a notice without a prompt (the phone's, an old daemon's) shows no field", async () => {
    const { InspectorBody } = await import("./inspector");
    const view = await mount(<InspectorBody theme={theme} item={NOTICE} onWords={ignore} />);
    expect(view.all("textarea")).toHaveLength(0);
  });
});

describe("review fixes (P20 round 1)", () => {
  it("an ask's choice does not leak into the next ask", async () => {
    const { InspectorBody } = await import("./inspector");
    const second = { ...ASK, key: "ask:second", title: "A second ask", chosen: undefined };
    const first = { ...ASK, chosen: undefined };
    function Host() {
      const [item, setItem] = useState(first);
      return (
        <>
          <web.Pressable accessibilityRole="button" accessibilityLabel="Next ask" onPress={() => setItem(second)} />
          <InspectorBody theme={theme} item={item} />
        </>
      );
    }
    const view = await mount(<Host />);
    await view.press(view.label("Install fleet-wide"));
    expect(view.label("Install fleet-wide")?.getAttribute("aria-checked")).toBe("true");
    await view.press(view.label("Next ask"));
    expect(view.text()).toContain("A second ask");
    expect(view.all('[aria-checked="true"]')).toHaveLength(0);
  });
  it("a deck whose holds shrink under it shows the last and says so", async () => {
    const asked: number[] = [];
    function Host() {
      const [items, setItems] = useState([APPROVAL, ASK, NOTICE]);
      const [index, setIndex] = useState(2);
      return (
        <>
          <web.Pressable
            accessibilityRole="button"
            accessibilityLabel="Act"
            onPress={() => setItems([APPROVAL, ASK])}
          />
          <Deck
            theme={theme}
            title="Needs you"
            items={items}
            index={index}
            onIndexChange={(at) => {
              asked.push(at);
              setIndex(at);
            }}
            keyOf={(item) => item.key}
            directions={BOTH_WAYS}
            renderItem={(item) => <web.Text>{item.title}</web.Text>}
          />
        </>
      );
    }
    const view = await mount(<Host />);
    expect(view.text()).toContain("3 of 3");
    await view.press(view.label("Act"));
    expect(view.text()).toContain("2 of 2");
    expect(asked).toEqual([1]);
  });
});

describe("the detail header", () => {
  it("'Kind · n of N' over one segment per hold, and a round close", async () => {
    let closed = 0;
    const view = await mount(
      <DetailHeader theme={theme} kind="Ask" index={2} total={4} onClose={() => (closed += 1)} onMore={ignore} />,
    );
    expect(view.text()).toContain("Ask · 3 of 4");
    expect(view.all('[data-testid="segment-done"]')).toHaveLength(2);
    expect(view.all('[data-testid="segment-current"]')).toHaveLength(1);
    expect(view.all('[data-testid="segment-todo"]')).toHaveLength(1);
    await view.press(view.label("Close"));
    expect(closed).toBe(1);
  });
});

describe("the glance tile and the deck", () => {
  it("a tile is a tap target that names its number", async () => {
    let pressed = 0;
    const view = await mount(
      <GlanceTile
        theme={theme}
        icon="Hand"
        label="Needs you"
        value="4"
        unit="holds"
        tone="needs"
        onPress={() => (pressed += 1)}
      />,
    );
    await view.press(view.label("Needs you, 4, holds"));
    expect(pressed).toBe(1);
  });
  it("the deck shows where you are and one hold's verbs at 52 pt", async () => {
    function Host() {
      const [index, setIndex] = useState(1);
      return (
        <Deck
          theme={theme}
          title="Needs you"
          items={[APPROVAL, ASK, NOTICE]}
          index={index}
          onIndexChange={setIndex}
          keyOf={(item) => item.key}
          directions={BOTH_WAYS}
          renderItem={(item) => (
            <DeckHold
              theme={theme}
              icon="Hand"
              kicker={[item.kind]}
              title={item.title}
              verbs={[{ label: `Act ${item.kind}`, primary: true, onPress: ignore }]}
            />
          )}
        />
      );
    }
    const view = await mount(<Host />);
    expect(view.text()).toContain("2 of 3");
    expect(view.label("Act ask")?.getAttribute("style")).toContain("height: 52px");
  });
});

describe("the gallery is behind its flag", () => {
  const props = (compact: boolean) => ({
    theme,
    host: { id: "h", label: "h" },
    layout: { compact, platform: "web" as const },
    params: {},
  });
  it("off: it says how to turn it on and shows no part", async () => {
    galleryOn = false;
    const view = await mount(<KitGalleryScreen {...props(false)} />);
    expect(view.text()).toContain("MAESTRO_KIT_GALLERY=1");
    expect(view.id("gallery-pane-light")).toBeNull();
  });
  it("on: every section renders light and dark", async () => {
    const view = await mount(<KitGalleryScreen {...props(false)} />);
    expect(view.id("gallery-pane-light")).toBeTruthy();
    expect(view.id("gallery-pane-dark")).toBeTruthy();
    for (const section of ["Phone", "Undertow"]) {
      const radio = view.all('[role="radio"]').find((el) => el.textContent === section);
      await view.press(radio);
    }
    // J1 adopted the desktop parts (BRO-3035): the gallery has no Desktop section left.
    expect(view.all('[role="radio"]').some((el) => el.textContent === "Desktop")).toBe(false);
  });
  it("on the phone it opens on the Phone section, in the active appearance only", async () => {
    // M1 is the live screen now (client/phone/shell.render.test.tsx): the gallery keeps the states it does not reach.
    const view = await mount(<KitGalleryScreen {...props(true)} />);
    expect(view.all('[data-testid="phone-shell"]')).toHaveLength(0);
    expect(view.all('[data-testid^="gallery-pane"]')).toHaveLength(1);
  });
});
