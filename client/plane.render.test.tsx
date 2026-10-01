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
// error is counted, anything else fails the test.
//
// Teardown has to hold when a test times out, which a loaded machine makes
// likely (the first mount compiles react-dom and react-native-web): bun moves
// on while the timed-out test keeps running. So every harness step is owned by
// the test that started it and refuses once that test has ended, afterEach
// waits for the step still in flight before unmounting, a surface is recorded
// for unmounting before it renders, and afterAll unmounts anything left,
// clears the intent listeners, and restores the spies, the kit mock and the
// globals. A surface left mounted would take the next file's intents.

import { afterAll, afterEach, describe, expect, mock, setDefaultTimeout, spyOn, test } from "bun:test";
import type { PluginClientStateSource } from "@getpaseo/plugin/client/host";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import type { Scoreboard, WorkItem } from "../shared/contracts";
import type { HistoryEvent } from "../shared/records";
import { groupOf, type OrchState } from "../shared/states";

// A cold first mount alone can pass bun's 5 s default under load; that is not a failure of the surface.
setDefaultTimeout(60_000);

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
// react-native itself cannot load under bun (its source is Flow), so it has no original to go
// back to: it stays on react-native-web, the shim every render file maps it to.
mock.module("react-native", () => web);
const KIT = "@getpaseo/plugin/client/react-native";
// The kit as the package ships it, read under a key of its own: loading it by name before the
// mock would bind every later import to the empty original.
const realKit = { ...(await import(`${Bun.resolveSync(KIT, import.meta.dir)}?original`)) };
mock.module(KIT, () => {
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
const { requestIntent, resetIntents, takeIntent } = await import("./intent");

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
    pending: null,
    flag: null,
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

// Local times around today's midnight, so each lands in the day its test says wherever it runs.
const midnight = new Date();
midnight.setHours(0, 0, 0, 0);
const local = (dayOffset: number, hour: number, minute = 0) => {
  const at = new Date(midnight);
  at.setDate(at.getDate() + dayOffset);
  at.setHours(hour, minute);
  return at;
};
const keyOf = (at: Date) =>
  `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
const historyEvent = (itemId: string, at: Date, actor: HistoryEvent["actor"], text: string): HistoryEvent => {
  const item = fixture().find((entry) => entry.id === itemId);
  return {
    ts: at.toISOString(),
    type: "note",
    actor,
    text,
    detail: null,
    itemId,
    title: item?.title ?? itemId,
    initiative: item?.initiative ?? null,
    project: item?.project ?? null,
  };
};
const history = (): HistoryEvent[] => [
  historyEvent("a", local(0, 0, 2), "human", "You approved"),
  historyEvent("c", local(0, 0, 1), "agent", "Turn finished"),
  historyEvent("b", local(-1, 22), "maestro", "Checks failed"),
];
const H = 3_600_000;
const board = (): Scoreboard => ({
  unsupervisedMs: 1.25 * H,
  looks: 1,
  longestRunMs: H,
  live: false,
  segments: [],
  notches: [],
  week: [0, 1, 4, 0, 0.5, 2, 1.25].map((hours, index) => ({
    date: keyOf(local(index - 6, 12)),
    unsupervisedMs: hours * H,
    looks: index === 6 ? 1 : 0,
    longestRunMs: 0,
  })),
  weekByInitiative: [
    { initiative: "hawthorne", unsupervisedMs: 6 * H },
    { initiative: null, unsupervisedMs: 2.75 * H },
  ],
});
const files = [
  { name: "_work.md", size: 412, mtime: new Date(Date.now() - 5 * 60_000).toISOString() },
  { name: "image.png", size: 2048, mtime: new Date(Date.now() - 5 * 60_000).toISOString() },
  { name: "run.log", size: 90_000, mtime: new Date(Date.now() - 5 * 60_000).toISOString() },
];
const invoke = async (method: string, input: unknown) => {
  if (method === "work.list") return { root: "/work", items, warnings: [], scoreboard: board() };
  if (method === "work.history") return { events: history(), capped: false };
  if (method === "work.files") return { files };
  if (method === "work.file") {
    const { name } = input as { name: string };
    if (name === "image.png") throw new Error(`Request failed: ${name} is a binary file, so it is not shown.`);
    if (name === "run.log") return { name, text: "step 1\nstep 2\n", truncated: true };
    return { name, text: "# Work a\n\nStore it on the Run record.\n", truncated: false };
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

/** Bumped when each test ends: a step owned by an earlier test refuses to run. */
let generation = 0;
let closed = false;
/** The act scope running now, so teardown can wait for it to close. */
let inFlight: Promise<unknown> = Promise.resolve();

function step(owner: number, run: () => unknown): Promise<void> {
  if (closed || owner !== generation) {
    return Promise.reject(new Error("This test already ended (it timed out); the harness refused its next step."));
  }
  // act hands back a thenable without catch: adopt it as a promise (which also awaits it, as act asks).
  const running = Promise.resolve(
    act(async () => {
      await run();
    }),
  );
  inFlight = running.catch(() => undefined);
  return running;
}

const settle = (ms = 20) => step(generation, () => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const mounted: (() => void)[] = [];

async function mount(node: ReactNode, options: { state?: PluginClientStateSource } = {}) {
  const owner = generation;
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Recorded before it renders, so a test that times out mid-mount still gets unmounted.
  mounted.push(() => {
    try {
      act(() => root.unmount());
    } finally {
      client.clear();
      container.remove();
    }
  });
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
  await step(owner, () => root.render(wrap(node)));
  await step(owner, () => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  const byLabel = (label: string) => container.querySelector(`[aria-label="${label}"]`);
  return {
    text: () => container.textContent ?? "",
    byLabel,
    tabs: () => [...container.querySelectorAll('[role="tab"]')],
    pressed: (label: string) => byLabel(label)?.getAttribute("aria-pressed"),
    all: (selector: string) => [...container.querySelectorAll(selector)],
    press: async (target: Element | null | undefined) => {
      if (!target) throw new Error("nothing to press");
      await step(owner, () => (target as unknown as { click(): void }).click());
      await step(owner, () => new Promise<void>((resolve) => setTimeout(resolve, 20)));
    },
    rerender: async (next: ReactNode) => {
      await step(owner, () => root.render(wrap(next)));
      await step(owner, () => new Promise<void>((resolve) => setTimeout(resolve, 20)));
    },
    rings: () => [...container.querySelectorAll("div")].filter((el) => el.style.transform.includes("scale")),
  };
}

const consoleError = spyOn(console, "error").mockImplementation(() => {});
const isProbe = (args: unknown[]) => args.some((arg) => String(arg).includes("inside a workspace panel"));
const probeLogs = () => consoleError.mock.calls.filter(isProbe).length;

/** Waits out the act scope still open (a timed-out test's), then unmounts every surface, each on its own. */
async function unmountAll(): Promise<string[]> {
  await Promise.race([inFlight, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  const failures: string[] = [];
  for (const unmount of mounted.splice(0)) {
    try {
      unmount();
    } catch (error) {
      failures.push(String(error));
    }
  }
  return failures;
}

afterEach(async () => {
  generation += 1;
  const failures = await unmountAll();
  takeIntent();
  items = fixture();
  setReduced(true);
  const unexpected = consoleError.mock.calls.filter((args) => !isProbe(args)).map((args) => String(args[0]));
  consoleError.mockClear();
  expect(failures).toEqual([]);
  expect(unexpected).toEqual([]);
});

afterAll(async () => {
  closed = true;
  generation += 1;
  await unmountAll();
  resetIntents();
  consoleError.mockRestore();
  mock.restore();
  mock.module(KIT, () => realKit);
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

  test("the server's changed line shows on the card and the detail with no client state", async () => {
    items = fixture().map((item) => (item.id === "a" ? { ...item, changed: { additions: 5, deletions: 1 } } : item));
    const view = await mount(surface(false));
    expect(view.byLabel("5 lines added, 1 removed")).not.toBeNull();
    await view.press(view.byLabel("Work a, Needs you, hawthorne › core, updated 12 minutes ago"));
    expect(view.text().match(/\+5 −1/g)).toHaveLength(2);
  });

  test("the detail alone, as the agent panel mounts it, survives a host without state", async () => {
    const view = await mount(<WorkDetail id="a" theme={theme} compact={false} navigation={undefined} />);
    expect(view.text()).toContain("Approve the branch");
    expect(view.text()).toContain("Changed");
    expect(view.text()).toContain("maestro/a-1");
  });
});

describe("before a verb that can start a run", () => {
  const fromSettings = (extra: Partial<NonNullable<WorkItem["nextRun"]>> = {}) => ({
    provider: "claude",
    isolation: "worktree" as const,
    modeId: "bypassPermissions",
    thinkingOptionId: null,
    featureValues: null,
    fromSettings: ["provider" as const, "isolation" as const, "modeId" as const],
    ...extra,
  });

  test("a queued item whose mode comes only from Settings says so and warns before Dispatch", async () => {
    items = [...fixture(), work("q", "proposed", { nextRun: fromSettings() })];
    const view = await mount(<WorkDetail id="q" theme={theme} compact={false} navigation={undefined} />);
    expect(view.text()).toContain("Runs with claude (from Settings): mode bypassPermissions (from Settings).");
    expect(view.text()).toContain("This run skips permission prompts");
    expect(view.byLabel("Dispatch")).not.toBeNull();
  });

  test("a stuck item says Unblock may start a new run with the Settings mode, and warns", async () => {
    items = [
      ...fixture(),
      work("s", "blocked", { worker: worker("s", null), reason: "The session was archived", nextRun: fromSettings() }),
    ];
    const view = await mount(<WorkDetail id="s" theme={theme} compact={false} navigation={undefined} />);
    expect(view.text()).toContain(
      "If the session is gone, Unblock starts a new run in a fresh worktree on its own run branch (from Settings), with claude (from Settings): mode bypassPermissions (from Settings).",
    );
    expect(view.text()).toContain("That new run would skip permission prompts");
    expect(view.byLabel("Unblock")).not.toBeNull();
  });

  test("a run that asks before it acts carries no warning", async () => {
    items = [...fixture(), work("p", "proposed", { nextRun: fromSettings({ modeId: "acceptEdits" }) })];
    const view = await mount(<WorkDetail id="p" theme={theme} compact={false} navigation={undefined} />);
    expect(view.text()).toContain("mode acceptEdits (from Settings)");
    expect(view.text()).not.toContain("skip");
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

  test("compact switches only between the feed and History", async () => {
    const view = await mount(surface(true));
    expect(view.tabs().map((tab) => tab.getAttribute("aria-label"))).toEqual(["Feed", "History"]);
    expect(view.text()).toContain("claude · own worktree");
    await view.press(view.tabs()[1]);
    await settle(50);
    expect(view.text()).toContain("You approved");
    await view.press(view.all('[aria-label^="You approved, Work a"]')[0]);
    // Compact pushes the work over the list, with a way back.
    expect(view.byLabel("Back to all work")).not.toBeNull();
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

describe("History", () => {
  test("groups by day, filters you or the loop, groups by work, and a row opens its work", async () => {
    const view = await mount(surface(false));
    await view.press(view.tabs()[3]);
    await settle(50);
    expect(view.tabs()[3]?.getAttribute("aria-selected")).toBe("true");
    // History has its own chips; the state filter is not one of them.
    expect(view.byLabel("Needs you, 2")).toBeNull();
    const headers = () => view.all('[role="heading"]').map((el) => el.textContent);
    expect(headers()).toContain("Today");
    expect(headers()).toContain("Yesterday");
    expect(view.text()).toContain("You approved");
    expect(view.text()).toContain("Checks failed");

    await view.press(view.byLabel("You, 1"));
    expect(view.pressed("You, 1")).toBe("true");
    expect(view.text()).toContain("You approved");
    expect(view.text()).not.toContain("Turn finished");
    await view.press(view.byLabel("Autonomous, 2"));
    expect(view.text()).not.toContain("You approved");
    expect(view.text()).toContain("Turn finished");

    await view.press(view.byLabel("All, 3"));
    await view.press(view.byLabel("By work"));
    expect(headers()).toEqual(expect.arrayContaining(["Work a", "Work c", "Work b"]));
    expect(headers()).not.toContain("Yesterday");

    // A scope narrows History to its initiative.
    await view.press(view.byLabel("genesis, 1 of 2 open"));
    expect(view.text()).toContain("Turn finished");
    expect(view.text()).not.toContain("You approved");
    await view.press(view.byLabel("All work"));

    const row = view.all('[aria-label^="You approved, Work a, hawthorne › core, You, Today at "]')[0];
    await view.press(row);
    expect(row?.getAttribute("aria-current")).toBe("true");
    expect(view.text()).toContain("Approve the branch");
  });
});

describe("the work folder's files", () => {
  test("lists them; a file opens as text, a long one says it was cut, a binary one says why", async () => {
    const view = await mount(<WorkDetail id="a" theme={theme} compact={false} navigation={undefined} />);
    // The detail loads first; the file list is its own read after that.
    await settle(50);
    expect(view.text()).toContain("Files");
    const file = (name: string) => view.all(`[aria-label^="${name}, "]`)[0];
    expect(file("_work.md")?.getAttribute("aria-label")).toBe("_work.md, 412 B, updated 5 minutes ago");
    await view.press(file("_work.md"));
    await settle(50);
    expect(file("_work.md")?.getAttribute("aria-expanded")).toBe("true");
    expect(view.byLabel("Contents of _work.md")?.textContent).toContain("Store it on the Run record.");
    await view.press(file("run.log"));
    await settle(50);
    expect(view.byLabel("Contents of _work.md")).toBeNull();
    expect(view.text()).toContain("Showing the first 64 KB.");
    await view.press(file("image.png"));
    await settle(50);
    expect(view.text()).toContain("image.png is a binary file, so it is not shown.");
    expect(view.byLabel("Contents of image.png")).toBeNull();
  });
});

describe("the week", () => {
  test("seven bars, each with its day and hours in words; tapping shows where the hours went", async () => {
    const view = await mount(surface(false));
    const bars = view.all('[aria-label*=" unsupervised, "]');
    const short = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const days = [0, 1, 2, 3, 4, 5].map((index) => short[local(index - 6, 12).getDay()]).concat("Today");
    expect(bars.map((bar) => bar.textContent)).toEqual(
      ["0m", "1h", "4h", "0m", "30m", "2h", "1.3h"].map((value, index) => `${value}${days[index]}`),
    );
    expect(bars[6]?.getAttribute("aria-label")).toBe("Today: 1h 15m unsupervised, 1 look");
    const toggle = view.byLabel("This week, 8h 45m unsupervised. Show where the hours went");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(view.byLabel("hawthorne: 6h unsupervised this week")).toBeNull();

    await view.press(bars[2]);
    expect(view.byLabel("This week, 8h 45m unsupervised. Hide where the hours went")).not.toBeNull();
    expect(view.byLabel("hawthorne: 6h unsupervised this week")).not.toBeNull();
    expect(view.byLabel("No initiative: 2h 45m unsupervised this week")).not.toBeNull();

    await view.press(view.byLabel("Open History"));
    await settle(50);
    expect(view.tabs()[3]?.getAttribute("aria-selected")).toBe("true");
    expect(view.text()).toContain("You approved");
  });
});
