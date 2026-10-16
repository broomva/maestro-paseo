// Render tests for decision layer v2 (BRO-3167): an ask's summary, tradeoffs,
// sources, option pictures (enlarged, compared side by side), inline video, a
// local doc in a sandboxed frame, and details, on the inspector (J5 and the
// Feed, desktop), the phone's risen card and the phone's deck card. Setup as
// client/kit/kit.render.test.tsx: react-native-web in a happy-dom window, the
// host's kit as plain parts, `ask.attachment` answered by a fake RPC that
// records what it was asked.

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

const { act } = await import("react");
const { createRoot } = require("react-dom/client") as {
  createRoot(container: unknown): { render(node: ReactNode): void; unmount(): void };
};
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { PluginRpcProvider } = await import("@getpaseo/plugin/client/host");
const { GALLERY_LIGHT, ASK } = await import("./kit/gallery-data");
const { BOTH_WAYS } = await import("./kit/assumptions");
const { InspectorPanel, InspectorCard } = await import("./kit/inspector");
const { HoldCard } = await import("./phone/hold-card");
const { RichGlance } = await import("./rich-ask");
type InspectorItem = import("./kit/inspector").InspectorItem;
type RichView = import("./rich-ask-model").RichView;

const theme = GALLERY_LIGHT;
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const asked: { method: string; input: unknown }[] = [];
const invoke = async (method: string, input: unknown) => {
  asked.push({ method, input });
  if (method !== "ask.attachment") throw new Error(`unexpected RPC ${method}`);
  const ref = (input as { ref: { list: string; option: string | null; index: number } }).ref;
  if (ref.list === "sources")
    return { mime: "text/html", dataUrl: null, text: "<html><body><p>The spec</p></body></html>", webUrl: null };
  if (ref.option === null) return { mime: "video/mp4", dataUrl: "data:video/mp4;base64,AAAA", text: null, webUrl: null };
  return { mime: "image/png", dataUrl: PNG, text: null, webUrl: null };
};

const settle = (ms = 30) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const mounted: (() => void)[] = [];

interface El {
  tagName: string;
  textContent: string | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): El | null;
  querySelectorAll(selector: string): ArrayLike<El>;
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
    label: (name: string) => one(`[aria-label="${name}"]`),
    press: async (target: El | null | undefined) => {
      if (!target) throw new Error("nothing to press");
      await act(async () => target.click());
      await settle();
      await settle();
    },
  };
}

const ignore = () => undefined;
const consoleError = spyOn(console, "error").mockImplementation(() => {});

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  asked.length = 0;
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

/** A fixture ask choosing between two card designs, with every v2 field. */
const RICH: RichView = {
  handle: { where: { kind: "workspace", home: "/w" }, ledger: "fixture.yaml", uid: null, id: "F1", hash: "h1" },
  rich: {
    summary: "Two phone card designs. Dense fits the options above the fold; airy shows a bigger picture.",
    tradeoffs: [
      { option: "dense", label: null, cost: "none", risk: "cramped on small phones", time: null, reversibility: "a revert" },
      { option: "airy", label: null, cost: "one more PR", risk: null, time: "a day", reversibility: "a revert" },
    ],
    sources: [
      { kind: "ticket", ref: "BRO-3167", label: null },
      { kind: "spec", ref: "docs/specs/card.html#variants", label: "Card spec" },
      { kind: "pr", ref: "broomva/maestro-paseo#80", label: null },
    ],
    media: [{ kind: "video", path: "docs/walkthrough.mp4", url: null, caption: "Walkthrough" }],
    details: "## Why two\n\nThe owner asked for **both**.",
  },
  optionMedia: [
    { option: "dense", label: "Dense", media: [{ kind: "image", path: "docs/a.png", url: null, caption: "Variant A" }] },
    { option: "airy", label: "Airy", media: [{ kind: "image", path: "docs/b.png", url: null, caption: "Variant B" }] },
  ],
};

const ITEM: InspectorItem = {
  kind: "ask",
  key: "ask:fixture",
  kicker: ["fixture.yaml", "F1"],
  title: "FIXTURE: which card design ships?",
  cost: "The card waits.",
  whyYou: "Taste is yours.",
  options: [
    { id: "dense", label: "Dense", note: "Ships A", recommended: true },
    { id: "airy", label: "Airy", note: "Ships B" },
  ],
  chosen: "dense",
  rich: RICH,
};

describe("the inspector (J5 and the Feed) draws an ask's v2 fields", () => {
  it("summary, tradeoff table, source chips and each option's picture", async () => {
    const view = await mount(<InspectorPanel theme={theme} item={ITEM} open onClose={ignore} onVerb={ignore} />);
    const text = view.text();
    expect(text).toContain("Two phone card designs.");
    expect(view.label("Tradeoffs")).toBeTruthy();
    expect(text).toContain("cramped on small phones");
    expect(text).toContain("Undo");
    expect(view.label("ticket BRO-3167")).toBeTruthy();
    expect(view.label("spec Card spec")).toBeTruthy();
    // Each option's picture is fetched by the ask's handle and its position, never by a path.
    const imgs = view.all("img").map((img) => img.getAttribute("src"));
    expect(imgs.filter((src) => src === PNG)).toHaveLength(2);
    const refs = asked.map((call) => (call.input as { ref: unknown }).ref);
    expect(refs).toContainEqual({ list: "media", option: "dense", index: 0 });
    expect(refs).toContainEqual({ list: "media", option: "airy", index: 0 });
    expect(JSON.stringify(asked)).not.toContain("docs/a.png");
    expect(text).toContain("Read the details");
  });

  it("a thumbnail enlarges; Compare puts the options side by side", async () => {
    const view = await mount(<InspectorPanel theme={theme} item={ITEM} open onClose={ignore} onVerb={ignore} />);
    await view.press(view.label("Enlarge Variant B"));
    expect(view.all("img").filter((img) => img.getAttribute("src") === PNG).length).toBeGreaterThanOrEqual(3);
    await view.press(view.label("Compare 2 side by side"));
    expect(view.label("2 options side by side")).toBeTruthy();
  });

  it("the details disclosure renders its markdown", async () => {
    const view = await mount(<InspectorPanel theme={theme} item={ITEM} open onClose={ignore} onVerb={ignore} />);
    expect(view.text()).not.toContain("The owner asked for");
    await view.press(view.label("Read the details"));
    expect(view.text()).toContain("Why two");
    expect(view.text()).toContain("both");
  });

  it("an ask without v2 draws as before: no summary, no chips, nothing fetched", async () => {
    const view = await mount(<InspectorPanel theme={theme} item={ASK} open onClose={ignore} onVerb={ignore} />);
    expect(view.label("Tradeoffs")).toBeNull();
    expect(view.text()).not.toContain("Read the details");
    expect(asked).toEqual([]);
  });
});

describe("the desktop plays a video inline and draws a local doc in a sandbox", () => {
  it("video: a <video> with controls; a spec source: an <iframe> with an empty sandbox", async () => {
    const view = await mount(<RichGlance theme={theme} view={RICH} options={ITEM.options} compact={false} />);
    await view.press(view.label("Enlarge Walkthrough"));
    const video = view.one("video");
    expect(video?.getAttribute("src")).toBe("data:video/mp4;base64,AAAA");
    expect(video?.getAttribute("controls")).not.toBeNull();
    for (const unmount of mounted.splice(0)) unmount();
    const again = await mount(<RichGlance theme={theme} view={RICH} options={ITEM.options} compact={false} />);
    await again.press(again.label("spec Card spec"));
    const frame = again.one("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("");
    expect(frame?.getAttribute("srcdoc")).toContain("The spec");
  });
});

describe("the phone draws them too", () => {
  it("the risen card: summary, stacked tradeoffs, pictures", async () => {
    const view = await mount(
      <InspectorCard
        theme={theme}
        item={ITEM}
        index={0}
        total={1}
        open
        height={874}
        onClose={ignore}
        onMore={ignore}
        onVerb={ignore}
        onIndexChange={ignore}
        directions={BOTH_WAYS}
      />,
    );
    expect(view.text()).toContain("Two phone card designs.");
    expect(view.text()).toContain("Risk: cramped on small phones");
    expect(view.label("Enlarge Variant A")).toBeTruthy();
  });

  it("the deck card: summary, sources, each option's picture, Compare", async () => {
    const view = await mount(
      <HoldCard
        theme={theme}
        item={ITEM}
        verbs={[{ id: "answer", label: "Answer", primary: true }]}
        choice="dense"
        armed={false}
        waiting={null}
        busy={false}
        words=""
        onChoose={ignore}
        onWords={ignore}
        onDetails={ignore}
        onVerb={ignore}
      />,
    );
    expect(view.text()).toContain("Two phone card designs.");
    expect(view.label("ticket BRO-3167")).toBeTruthy();
    expect(view.label("Enlarge Variant A")).toBeTruthy();
    expect(view.label("Enlarge Variant B")).toBeTruthy();
    expect(view.label("Compare 2 side by side")).toBeTruthy();
  });
});
