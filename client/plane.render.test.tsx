// Render tests: the real surface components, mounted with react-dom through
// react-native-web in a happy-dom window, the way Paseo's web and desktop
// builds run them. The setup block below must run before anything imports
// React DOM, so everything past it is imported dynamically. It does three
// things: puts happy-dom's window on globalThis (react-dom and react-native-web
// read it at import) with 16 ms animation frames (happy-dom runs them back to
// back, which starves act) and a matchMedia whose reduced-motion answer
// `setReduced` flips live. Motion starts reduced, so the running dot's frames
// cannot land between act scopes; the live-signal tests turn it on; mocks `react-native` as react-native-web (loaded once outside
// NODE_ENV=test, where it would swap Animated for a mock that never moves); and mocks
// `@getpaseo/plugin/client/react-native`, the kit the host substitutes at
// runtime, with plain react-native-web parts. `mount(node, { state })` wraps a
// node in the providers a surface gets (query client, Paseo API, an RPC
// `invoke` backed by the `items` fixture; the client-state source only when
// `state` is given) and returns helpers to read text, find by aria-label, press
// and re-render. To test another component, import it after the setup block
// and pass it to mount(). console.error is captured: the ChangeScope probe's
// error is counted, anything else fails the test. afterAll removes the globals
// it added.

import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { PluginClientStateSource } from "@getpaseo/plugin/client/host";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import type { WorkItem } from "../shared/contracts";
import { groupOf, type OrchState } from "../shared/states";

const win = new Window({ url: "http://localhost/" });
let reduced = true;
const motionListeners = new Set<(event: { matches: boolean }) => void>();
Object.assign(win, {
  matchMedia: (query: string) => ({
    media: query,
    get matches() {
      return reduced && query.includes("reduce");
    },
    addEventListener: (_: string, fn: (event: { matches: boolean }) => void) => motionListeners.add(fn),
    removeEventListener: (_: string, fn: (event: { matches: boolean }) => void) => motionListeners.delete(fn),
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
mock.module("@getpaseo/plugin/client/react-native", () => {
  return {
    ScrollView: web.ScrollView,
    FlatList: web.FlatList,
    TextInput: web.TextInput,
    Icon: () => null,
    Modal: Object.assign(({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null), {
      Content: ({ children }: { children: ReactNode }) => children,
    }),
    useToast: () => ({ show() {}, error() {} }),
    useRevealedText: (text: string) => text,
  };
});

const { act } = await import("react");
const { createRoot } = require("react-dom/client") as {
  createRoot(container: unknown): { render(node: ReactNode): void; unmount(): void };
};
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { PaseoApiProvider, PluginClientStateProvider, PluginRpcProvider } = await import("@getpaseo/plugin/client/host");
const { MaestroSurface } = await import("./plane");
const { WorkDetail } = await import("./detail");
const { requestIntent, takeIntent } = await import("./intent");

function setReduced(value: boolean) {
  reduced = value;
  for (const listener of motionListeners) listener({ matches: value });
}

function work(id: string, state: OrchState, extra: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    path: `/work/${id}`,
    title: `Work ${id}`,
    kind: "task",
    state,
    group: groupOf(state),
    gate: "human",
    owner: null,
    initiative: null,
    project: null,
    repo: null,
    createdAt: "2026-09-29T10:00:00Z",
    updatedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    lastEventAt: null,
    phase: null,
    worker: null,
    reason: null,
    verdict: null,
    look: null,
    permission: null,
    checks: [],
    ...extra,
  };
}
const worker = (id: string, branch: string | null) => ({
  agentId: `ag-${id}`,
  workspaceId: `ws-${id}`,
  provider: "claude",
  branch,
  cwd: "/src",
});
const look = { ran: "Ran on its own", decided: [], ask: "Approve the branch" };
const fixture = (): WorkItem[] => [
  work("a", "review", { initiative: "hawthorne", project: "core", worker: worker("a", "maestro/a-1"), look }),
  work("b", "blocked", { initiative: "hawthorne", worker: worker("b", null), reason: "Needs a Linear scope" }),
  work("c", "running", { initiative: "genesis", worker: worker("c", "maestro/c-1"), phase: "working" }),
  work("d", "proposed", { initiative: "hawthorne" }),
  work("f", "done", { initiative: "genesis" }),
  work("g", "review", { worker: worker("g", null), look }),
];
let items = fixture();
const invoke = async (method: string, input: unknown) => {
  if (method === "work.list") {
    const scoreboard = { unsupervisedMs: 0, looks: 0, longestRunMs: 0, live: false, segments: [], notches: [] };
    return { root: "/work", items, warnings: [], scoreboard };
  }
  const item = items.find((entry) => entry.id === (input as { id: string }).id);
  return { item, brief: "", events: [], checkResults: [] };
};
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
const diffState = {
  subscribe: () => () => {},
  getWorkspace: (id: string) => (id === "ws-a" ? { id, diffStat: { additions: 12, deletions: 3 } } : null),
  getAgent: () => null,
};
const surface = (compact: boolean) => (
  <MaestroSurface
    theme={theme}
    host={{ id: "h", label: "h" }}
    layout={{ compact, platform: "web" }}
    navigation={{ openAgent() {}, openWorkspace() {} }}
  />
);

const settle = (ms = 20) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const mounted: (() => void)[] = [];

async function mount(node: ReactNode, options: { state?: PluginClientStateSource } = {}) {
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (inner: ReactNode) => {
    const scoped = options.state ? (
      <PluginClientStateProvider source={options.state}>{inner}</PluginClientStateProvider>
    ) : (
      inner
    );
    return (
      <QueryClientProvider client={client}>
        <PaseoApiProvider paseo={{} as never}>
          <PluginRpcProvider invoke={invoke}>{scoped}</PluginRpcProvider>
        </PaseoApiProvider>
      </QueryClientProvider>
    );
  };
  await act(async () => root.render(wrap(node)));
  await settle();
  mounted.push(() => {
    act(() => root.unmount());
    client.clear();
    container.remove();
  });
  const byLabel = (label: string) => container.querySelector(`[aria-label="${label}"]`);
  return {
    text: () => container.textContent ?? "",
    byLabel,
    tabs: () => [...container.querySelectorAll('[role="tab"]')],
    pressed: (label: string) => byLabel(label)?.getAttribute("aria-pressed"),
    press: async (target: Element | null | undefined) => {
      if (!target) throw new Error("nothing to press");
      await act(async () => (target as unknown as { click(): void }).click());
      await settle();
    },
    rerender: async (next: ReactNode) => {
      await act(async () => root.render(wrap(next)));
      await settle();
    },
    rings: () => [...container.querySelectorAll("div")].filter((el) => el.style.transform.includes("scale")),
  };
}

const consoleError = spyOn(console, "error").mockImplementation(() => {});
const isProbe = (args: unknown[]) => args.some((arg) => String(arg).includes("inside a workspace panel"));
const probeLogs = () => consoleError.mock.calls.filter(isProbe).length;

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  takeIntent();
  items = fixture();
  setReduced(true);
  const unexpected = consoleError.mock.calls.filter((args) => !isProbe(args)).map((args) => String(args[0]));
  consoleError.mockClear();
  expect(unexpected).toEqual([]);
});

afterAll(async () => {
  consoleError.mockRestore();
  for (const key of added) delete (globalThis as Record<string, unknown>)[key];
  await win.happyDOM.close();
});

describe("the changed line", () => {
  test("a surface without client state renders, logs once, and shows no changed stat", async () => {
    const view = await mount(surface(false));
    expect(view.text()).toContain("2 need you · 1 stuck · 1 running");
    expect(view.text()).toContain("hawthorne › core");
    expect(view.text()).toContain("maestro/a-1");
    expect(view.text()).not.toMatch(/\+\d+ −\d+/);
    expect(probeLogs()).toBe(1);
    await view.press(view.byLabel("Work a, Needs you, hawthorne › core, updated 12 minutes ago"));
    expect(view.text()).toContain("Changed");
    await view.press(view.byLabel("Work g, Needs you, updated 12 minutes ago"));
    expect(view.text()).toContain("Approve the branch");
    expect(view.text()).not.toContain("Changed");
    expect(probeLogs()).toBe(1);
  });

  test("with client state, the card and the detail show +a −d", async () => {
    const view = await mount(surface(false), { state: diffState as unknown as PluginClientStateSource });
    expect(view.text()).toContain("+12 −3");
    expect(view.byLabel("12 lines added, 3 removed")).not.toBeNull();
    const card = view.byLabel("Work a, Needs you, hawthorne › core, updated 12 minutes ago");
    expect(card?.getAttribute("aria-current")).toBe("false");
    await view.press(card);
    expect(card?.getAttribute("aria-current")).toBe("true");
    expect(view.text().match(/\+12 −3/g)).toHaveLength(2);
    expect(probeLogs()).toBe(0);
  });

  test("the detail alone, as the agent panel mounts it, survives a host without state", async () => {
    const view = await mount(<WorkDetail id="a" theme={theme} compact={false} navigation={undefined} />);
    expect(view.text()).toContain("Approve the branch");
    expect(view.text()).toContain("Changed");
    expect(view.text()).toContain("maestro/a-1");
  });
});

describe("views and filters", () => {
  test("a filter intent checks its chip, opens the feed and drops the scope", async () => {
    const view = await mount(surface(false));
    await view.press(view.byLabel("genesis, 1 of 2 open"));
    await view.press(view.tabs()[1]);
    expect(view.tabs()[1]?.getAttribute("aria-selected")).toBe("true");
    await act(async () => requestIntent({ kind: "filter", group: "review" }));
    await settle();
    expect(view.tabs()[0]?.getAttribute("aria-selected")).toBe("true");
    expect(view.pressed("Needs you, 2")).toBe("true");
    expect(view.pressed("All work")).toBe("true");
    expect(view.text()).toContain("Work a");
    expect(view.text()).not.toContain("Work c");
  });

  test("the board bypasses the state filter, and choosing it clears the filter", async () => {
    const view = await mount(surface(false));
    await view.press(view.byLabel("Running, 1"));
    expect(view.text()).not.toContain("Work a");
    await view.press(view.tabs()[1]);
    await view.press(view.tabs()[0]);
    expect(view.pressed("All, 6")).toBe("true");
    // A filter set in the compact feed while the board is the chosen view.
    await view.press(view.tabs()[1]);
    await view.rerender(surface(true));
    await view.press(view.byLabel("Running, 1"));
    await view.rerender(surface(false));
    expect(view.tabs()[1]?.getAttribute("aria-selected")).toBe("true");
    for (const title of ["Work a", "Work b", "Work c", "Work d", "Work f"]) expect(view.text()).toContain(title);
  });

  test("a scope whose initiative leaves the list does not come back", async () => {
    const view = await mount(surface(false));
    await view.press(view.byLabel("genesis, 1 of 2 open"));
    items = fixture().filter((item) => item.initiative !== "genesis");
    await view.press(view.byLabel("Refresh work"));
    items = fixture();
    await view.press(view.byLabel("Refresh work"));
    expect(view.pressed("All work")).toBe("true");
    expect(view.text()).toContain("Work a");
  });

  test("list rows pair the dot with words", async () => {
    items = [...fixture(), work("x", "canceled")];
    const view = await mount(surface(false));
    await view.press(view.tabs()[2]);
    expect(view.text()).toContain("Canceled");
    expect(view.byLabel("Work x, Canceled, updated 12 minutes ago")).not.toBeNull();
    expect(view.byLabel("Work f, Done, genesis, updated 12 minutes ago")).not.toBeNull();
  });

  test("compact has no view switch", async () => {
    const view = await mount(surface(true));
    expect(view.tabs()).toHaveLength(0);
    expect(view.text()).toContain("claude · own worktree");
  });
});

describe("the live signal", () => {
  const opacities = async (view: Awaited<ReturnType<typeof mount>>) => {
    const sample = () => view.rings().map((ring) => ring.style.opacity);
    const first = sample();
    await settle(200);
    return [first, sample()];
  };

  test("the running dot pulses, holds still under reduced motion, and chip dots never pulse", async () => {
    setReduced(false);
    const view = await mount(surface(false));
    expect(view.rings()).toHaveLength(1);
    const [before, after] = await opacities(view);
    expect(after).not.toEqual(before);
    await act(async () => setReduced(true));
    await settle();
    const [still, later] = await opacities(view);
    expect(later).toEqual(still);
  });

  test("a surface opened under reduced motion starts still", async () => {
    const view = await mount(surface(false));
    const [before, after] = await opacities(view);
    expect(view.rings()).toHaveLength(1);
    expect(after).toEqual(before);
  });
});
