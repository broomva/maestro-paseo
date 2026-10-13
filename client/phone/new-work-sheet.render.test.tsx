// Render tests for the phone's New work sheet (M9, BRO-3037): our own in-surface sheet hosting the composer, mounted
// with react-dom through react-native-web in a happy-dom window. The harness is client/new-work.render.test.tsx's
// (see its header): the Paseo API is a fake, RPCs go through the real contracts, so `created` holds exactly what
// the server would receive. The keyboard is a fake that a test fires: on the web the sheet listens for the events
// Android sends (`keyboardDidShow`), on iOS `keyboardWillShow` (client/phone/keyboard.ts).

import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { Window } from "happy-dom";
import type { ReactNode } from "react";
import type { MaestroConfig, WorkItem } from "../../shared/contracts";

const SLOW = 30_000;
const it = (name: string, run: () => Promise<void>) => test(name, run, SLOW);

const win = new Window({ url: "http://localhost/" });
// react-native-web reads matchMedia once, when the first file loads it, and keeps that list for
// the whole bun process. So the list asks whichever window is current: once this file is done, a
// later file's reduced-motion switch (plane.render.test.tsx) still reaches react-native-web.
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
const keyboardListeners = new Map<
  string,
  ((event: { endCoordinates: { height: number }; duration: number }) => void)[]
>();
const keyboard = {
  addListener: (name: string, listener: (event: { endCoordinates: { height: number }; duration: number }) => void) => {
    keyboardListeners.set(name, [...(keyboardListeners.get(name) ?? []), listener]);
    return {
      remove: () =>
        keyboardListeners.set(
          name,
          (keyboardListeners.get(name) ?? []).filter((one) => one !== listener),
        ),
    };
  },
};
mock.module("react-native", () => ({ ...web, Keyboard: keyboard }));
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
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { PaseoApiProvider, PluginRpcProvider } = await import("@getpaseo/plugin/client/host");
const { fakeWork } = await import("../fake-work");
const { NewWorkSheet } = await import("./new-work-sheet");
const { keyboardLift } = await import("./keyboard-lift");

const theme = {
  colors: {
    surface0: "#fff",
    surface1: "#f3f4f6",
    surface2: "#eee",
    border: "#e1e3e6",
    foreground: "#0c101a",
    foregroundMuted: "#5f636c",
    accent: "#5480c7",
    accentForeground: "#fff",
    statusSuccess: "#0a0",
    statusWarning: "#a60",
    statusDanger: "#a00",
  },
};

const OPUS = {
  provider: "claude",
  id: "opus",
  label: "Opus 5.5",
  isDefault: true,
  thinkingOptions: [
    { id: "high", label: "High", isDefault: true },
    { id: "xhigh", label: "Extra high" },
  ],
  defaultThinkingOptionId: "high",
};
const HAIKU = { provider: "claude", id: "haiku", label: "Haiku 4.5" };
const MODES = [
  { id: "default", label: "Always ask" },
  { id: "bypassPermissions", label: "Bypass", icon: "ShieldOff" },
];

/** What each provider read answers; a test replaces any of them. */
interface Reads {
  snapshot: () => Promise<unknown>;
  listModels: () => Promise<unknown>;
  listModes: () => Promise<unknown>;
  listFeatures: () => Promise<unknown>;
}
const answers = (): Reads => ({
  snapshot: async () => ({
    entries: [{ provider: "claude", status: "ready", enabled: true, label: "Claude", defaultModeId: "default" }],
  }),
  listModels: async () => ({ provider: "claude", models: [OPUS, HAIKU], fetchedAt: "", requestId: "" }),
  listModes: async () => ({ provider: "claude", modes: MODES, fetchedAt: "", requestId: "" }),
  listFeatures: async () => ({
    provider: "claude",
    features: [{ type: "toggle", id: "fast_mode", label: "Fast", value: false, icon: "zap" }],
    fetchedAt: "",
    requestId: "",
  }),
});
let reads = answers();
const _pending = () => new Promise<never>(() => {});

const paseo = {
  projects: {
    list: async () => ({
      projects: [
        { projectId: "p1", projectDisplayName: "broomva", projectRootPath: "/src/broomva", projectKind: "git" },
      ],
    }),
  },
  providers: {
    snapshot: () => reads.snapshot(),
    listModels: () => reads.listModels(),
    listModes: () => reads.listModes(),
    listFeatures: () => reads.listFeatures(),
  },
};

const settings: MaestroConfig = {
  workRoot: "/work",
  provider: "claude/haiku",
  modeId: null,
  isolation: "worktree",
  concurrencyCap: null,
  archiveOnApprove: false,
  defaultGate: "human",
  loopMinutes: null,
};
const created: Record<string, unknown>[] = [];
const inspected: string[] = [];
const item = (id: string): WorkItem => fakeWork(id, "proposed", null, { repo: "/src/broomva", title: "Made" });
const invoke = async (method: string, input: unknown) => {
  switch (method) {
    case "config.get":
      return settings;
    case "work.list": {
      const scoreboard = {
        unsupervisedMs: 0,
        looks: 0,
        longestRunMs: 0,
        live: false,
        segments: [],
        notches: [],
        week: [],
        weekByInitiative: [],
      };
      return { root: "/work", items: [], warnings: [], scoreboard };
    }
    case "work.create":
      created.push(input as Record<string, unknown>);
      return { item: item(`w${created.length}`), notice: "" };
    case "folder.inspect": {
      const path = (input as { path: string }).path;
      inspected.push(path);
      return { path: path.replace(/^~/, "/home/me"), directory: true, git: false };
    }
    default:
      throw new Error(`unexpected RPC ${method}`);
  }
};

const settle = (ms = 30) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const mounted: (() => void)[] = [];

async function mount(node: ReactNode) {
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PaseoApiProvider paseo={paseo as never}>
          <PluginRpcProvider invoke={invoke}>{node}</PluginRpcProvider>
        </PaseoApiProvider>
      </QueryClientProvider>,
    ),
  );
  // The reads chain: projects, then the folder's providers, then its features. An act scope flushes
  // its updates only when it ends, so each link starts at the end of one scope and lands in the next.
  for (let link = 0; link < 4; link += 1) await settle();
  mounted.push(() => {
    act(() => root.unmount());
    client.clear();
    container.remove();
  });
  const one = (selector: string) => container.querySelector(selector) as unknown as HTMLElementLike | null;
  const pill = (name: string) => one(`[aria-label^="${name}: "]`);
  return {
    text: () => container.textContent ?? "",
    one,
    all: (selector: string) => [...container.querySelectorAll(selector)] as unknown as HTMLElementLike[],
    pill,
    pillText: (name: string) =>
      pill(name)
        ?.getAttribute("aria-label")
        ?.slice(name.length + 2) ?? null,
    press: async (target: HTMLElementLike | null | undefined) => {
      if (!target) throw new Error("nothing to press");
      await act(async () => target.click());
      await settle();
    },
    type: async (target: HTMLElementLike | null, text: string) => {
      if (!target) throw new Error("nothing to type in");
      const proto = target.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      await act(async () => {
        Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(target, text);
        target.dispatchEvent(new win.Event("input", { bubbles: true }));
      });
      await settle();
    },
    key: async (target: HTMLElementLike | null, key: string, extra: Record<string, boolean> = {}) => {
      if (!target) throw new Error("no key target");
      await act(async () => {
        target.dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }));
      });
      await settle();
    },
    blur: async (target: HTMLElementLike | null) => {
      await act(async () => {
        target?.dispatchEvent(new win.FocusEvent("focusout", { bubbles: true }));
        target?.dispatchEvent(new win.FocusEvent("blur"));
      });
      await settle(60);
    },
  };
}

interface HTMLElementLike {
  tagName: string;
  textContent: string | null;
  getAttribute(name: string): string | null;
  click(): void;
  dispatchEvent(event: unknown): boolean;
}

const sheet = (overrides: { onClose?: () => void; onCreated?: (id: string) => void } = {}) => (
  <NewWorkSheet
    theme={theme}
    height={812}
    safeBottom={34}
    onClose={overrides.onClose ?? (() => {})}
    onCreated={overrides.onCreated ?? (() => {})}
  />
);
const button = (view: Awaited<ReturnType<typeof mount>>, name: string) =>
  view.all('[role="button"]').find((el) => el.textContent === name || el.getAttribute("aria-label") === name) ?? null;
const bottomOf = (el: HTMLElementLike | null) => /bottom:\s*([\d.]+)px/.exec(el?.getAttribute("style") ?? "")?.[1];

const consoleError = spyOn(console, "error").mockImplementation(() => {});
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  reads = answers();
  created.length = 0;
  keyboardListeners.clear();
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

describe("M9, New work grows from the +", () => {
  it("says before you send what the work must land, and that you start it: Dispatch does, Save to queue does not", async () => {
    const view = await mount(sheet());
    expect(view.text()).toContain("New work");
    const starts = view.one('[data-testid="promise-starts"]');
    expect(starts?.textContent).toContain("Who starts it");
    expect(starts?.textContent).toContain("You do: Dispatch starts a session");
    expect(starts?.textContent).toContain("Save to queue starts nothing");
    expect(starts?.textContent).toContain("Maestro never starts work on its own (A8)");
    expect(view.text()).not.toMatch(/lane starts|the broomva lane/);
  });

  it("pins Save to queue and Dispatch at the foot, off until a brief and a place are given", async () => {
    const view = await mount(sheet());
    expect(button(view, "Save to queue")?.getAttribute("aria-disabled")).toBe("true");
    expect(button(view, "Dispatch")?.getAttribute("aria-disabled")).toBe("true");
    await view.type(view.one("textarea"), "Close leftover fleet items when their channel is retired");
    expect(button(view, "Save to queue")?.getAttribute("aria-disabled")).not.toBe("true");
    expect(button(view, "Dispatch")?.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("Save to queue sends it without dispatching; Dispatch sends it and starts it, and both close the sheet", async () => {
    const made: string[] = [];
    const view = await mount(sheet({ onCreated: (id) => void made.push(id) }));
    await view.type(view.one("textarea"), "Close leftover fleet items");
    await view.press(button(view, "Save to queue"));
    expect(created).toHaveLength(1);
    expect(created[0]?.dispatch).toBe(false);
    await settle(150);
    expect(made).toEqual(["w1"]);
    await view.type(view.one("textarea"), "A second one");
    await view.press(button(view, "Dispatch"));
    expect(created).toHaveLength(2);
    expect(created[1]?.dispatch).toBe(true);
  });

  it("closing with something typed asks first; with nothing typed it just closes", async () => {
    const closed: number[] = [];
    const view = await mount(sheet({ onClose: () => void closed.push(1) }));
    await view.press(button(view, "Close new work"));
    expect(closed).toHaveLength(1);
    await view.type(view.one("textarea"), "Half a thought");
    await view.press(button(view, "Close new work"));
    expect(closed).toHaveLength(1);
    expect(view.text()).toContain("Discard what you wrote?");
    await view.press(button(view, "Keep writing"));
    expect(view.text()).not.toContain("Discard what you wrote?");
    await view.press(button(view, "Close new work"));
    await view.press(button(view, "Discard"));
    expect(closed).toHaveLength(2);
  });

  it("rises with the keyboard (BRO-3033 fact 4) and returns when it hides", async () => {
    const view = await mount(sheet());
    const root = () => view.one('[data-testid="new-work-sheet"] > div:nth-child(2)');
    expect(bottomOf(root())).toBe("0");
    await act(async () => {
      for (const listener of keyboardListeners.get("keyboardDidShow") ?? [])
        listener({ endCoordinates: { height: 336 }, duration: 0 });
    });
    await settle(120);
    // The keyboard's height less the home indicator the sheet already stands above.
    expect(bottomOf(root())).toBe(String(keyboardLift(336, 34)));
    await act(async () => {
      for (const listener of keyboardListeners.get("keyboardDidHide") ?? [])
        listener({ endCoordinates: { height: 0 }, duration: 0 });
    });
    await settle(120);
    expect(bottomOf(root())).toBe("0");
  });
});
