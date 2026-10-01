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
import type { MaestroConfig, Scoreboard, WakeEntry, WorkItem } from "../shared/contracts";
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

// Settings' kit (SettingsSection, SettingsSelect, ...) is the host's at runtime too: plain parts here, a
// select as one button per option, restored in afterAll like the kit above.
const UI = "@getpaseo/plugin/client/ui";
const realUi = { ...(await import(`${Bun.resolveSync(UI, import.meta.dir)}?original`)) };
mock.module(UI, () => {
  const { Pressable, Text, View } = web as typeof import("react-native");
  type Row = { label: string; hint?: string; children?: ReactNode };
  const Section = ({ title, children }: { title: string; children: ReactNode }) => (
    <View>
      <Text>{title}</Text>
      {children}
    </View>
  );
  return {
    SettingsSection: Section,
    SettingsGroup: Section,
    SettingsCard: ({ children }: { children: ReactNode }) => <View>{children}</View>,
    SettingsRow: ({ label, children }: Row) => (
      <View>
        <Text>{label}</Text>
        {children}
      </View>
    ),
    SettingsInput: ({ label }: Row) => <Text>{label}</Text>,
    SettingsSwitch: ({ label }: Row) => <Text>{label}</Text>,
    SettingsSelect: ({
      label,
      hint,
      value,
      options,
      onValueChange,
    }: Row & { value: string; options: { label: string; value: string }[]; onValueChange(value: string): void }) => (
      <View>
        <Text>{label}</Text>
        {hint ? <Text>{hint}</Text> : null}
        {options.map((option) => (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            {...{ "aria-pressed": option.value === value }}
            accessibilityLabel={`${label}: ${option.label}`}
            onPress={() => onValueChange(option.value)}
          >
            <Text>{option.label}</Text>
          </Pressable>
        ))}
      </View>
    ),
    SettingsAction: ({
      label,
      actionLabel,
      onPress,
      disabled,
    }: Row & { actionLabel: string; onPress(): void; disabled?: boolean }) => (
      <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress}>
        <Text>{actionLabel}</Text>
      </Pressable>
    ),
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
const { MaestroSettings } = await import("./settings");
const { attentionOf } = await import("../server/attention");
const { headerFace, needsYou } = await import("./header-count");
const { linkSettings } = await import("./settings-link");

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
/** One wake as the log keeps it, `minutesAgo` before now. */
const wakeEntry = (tickId: string, minutesAgo: number, extra: Partial<WakeEntry> = {}): WakeEntry => ({
  tickId,
  cause: "timer",
  wokeAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  dispatched: [],
  deferred: [],
  needsYou: { gate: 0, stuck: 0, asking: 0 },
  quiet: [],
  unasked: [],
  flagged: [],
  narrative: ["Woke on a scheduled check.", "Did nothing new this tick."],
  ...extra,
});
const loopOff = () => ({
  minutes: null as number | null,
  nextAt: null as string | null,
  ticking: false,
  recent: [] as WakeEntry[],
});
let loopState = loopOff();
/** What loop.wake answers next. */
let nextWake: () => WakeEntry = () => wakeEntry("w-now", 0, { cause: "manual" });
const settingsFixture = (): MaestroConfig => ({
  workRoot: "/work",
  provider: "claude/haiku",
  modeId: "acceptEdits",
  isolation: "worktree",
  concurrencyCap: 3,
  archiveOnApprove: true,
  defaultGate: "auto",
  loopMinutes: null,
});
let settings = settingsFixture();
const calls: { method: string; input: unknown }[] = [];
const invoke = async (method: string, input: unknown) => {
  calls.push({ method, input });
  if (method === "loop.get") return loopState;
  if (method === "loop.wake") return nextWake();
  if (method === "config.get") return settings;
  if (method === "config.set") return input;
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
  loopState = loopOff();
  nextWake = () => wakeEntry("w-now", 0, { cause: "manual" });
  settings = settingsFixture();
  calls.length = 0;
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
  mock.module(UI, () => realUi);
  for (const key of added) delete (globalThis as Record<string, unknown>)[key];
  await win.happyDOM.close();
});

describe("the changed line", () => {
  test("a surface without client state renders, logs once, and shows no changed stat", async () => {
    const view = await mount(surface(false));
    expect(view.text()).toContain("3 need you · 1 running");
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

describe("work the loop flagged", () => {
  const yours = {
    kind: "yours" as const,
    reason: "Start it yourself: it runs without permission prompts.",
    at: new Date(Date.now() - 2 * 60_000).toISOString(),
  };
  const flagged = () => [...fixture(), work("y", "proposed", { flag: yours })];

  test("is in Needs you: the summary, its chip, and the board's column, with the reason on its card", async () => {
    items = flagged();
    const view = await mount(surface(false));
    expect(view.text()).toContain("4 need you · 1 running");
    const card = view.byLabel(`Work y, Queued, ${yours.reason}, updated 12 minutes ago`);
    expect(card?.textContent).toContain(yours.reason);
    await view.press(view.byLabel("Needs you, 4"));
    expect(view.text()).toContain("Work y");
    expect(view.text()).not.toContain("Work d");
    await view.press(view.tabs()[1]);
    const text = view.text();
    const needsYou = text.indexOf("At your gate, stuck or flagged");
    const done = text.indexOf("The branch is the receipt");
    expect(needsYou).toBeGreaterThan(-1);
    expect(text.indexOf("Work y")).toBeGreaterThan(needsYou);
    expect(text.indexOf("Work y")).toBeLessThan(done);
    // It left the Queued column: only once on the board.
    expect(text.match(/Work y/g)).toHaveLength(1);
    expect(text.indexOf("Work d")).toBeLessThan(needsYou);
  });

  test("the feed's Needs you lists stuck and flagged work with its reasons, as many as the header counts", async () => {
    const quiet = { kind: "quiet" as const, reason: "Quiet for 41 minutes, worth a look.", at: yours.at };
    items = [
      ...fixture(),
      work("y", "proposed", { flag: yours }),
      work("z", "running", { worker: worker("z", "maestro/z-1"), phase: "working", flag: quiet }),
    ];
    const view = await mount(surface(false));
    // The header count, as Paseo's header shows it: work.attention's waiting, counted by the header.
    const count = needsYou(attentionOf(items, Date.now()).waiting).length;
    expect(headerFace(count).label).toBe("5 need you");
    const heading = view.all('[role="heading"]').find((el) => el.textContent === "Needs you");
    const header = heading?.parentElement;
    const section = header?.parentElement;
    expect(header?.textContent).toBe(`Needs you${count}At your gate, stuck or flagged`);
    const cards = [...(section?.querySelectorAll('[role="button"]') ?? [])].map((el) => el.getAttribute("aria-label"));
    expect(cards).toHaveLength(count);
    expect(cards.map((label) => label?.split(",")[0])).toEqual(["Work a", "Work g", "Work b", "Work y", "Work z"]);
    for (const reason of ["Needs a Linear scope", yours.reason, quiet.reason]) {
      expect(section?.textContent).toContain(reason);
    }
    // Listed once: not again under Queued, Running or Stuck.
    for (const title of ["Work y", "Work z", "Work b"])
      expect(view.text().match(new RegExp(title, "g"))).toHaveLength(1);
    expect(view.all('[role="heading"]').map((el) => el.textContent)).not.toContain("Stuck");
    expect(view.text()).toContain("5 need you · 1 running");
    // The chip the header opens holds the same work.
    expect(view.byLabel(`Needs you, ${count}`)).not.toBeNull();
  });

  test("a quiet run's notice offers Leave it running, which asks the host; other flags offer nothing of their own", async () => {
    const quiet = { kind: "quiet" as const, reason: "Quiet for 41 minutes, worth a look.", at: yours.at };
    items = [...flagged(), work("z", "running", { worker: worker("z", "maestro/z-1"), phase: "working", flag: quiet })];
    const view = await mount(<WorkDetail id="z" theme={theme} compact={false} navigation={undefined} />);
    const [alert] = view.all('[role="alert"]');
    expect(alert?.textContent).toContain(quiet.reason);
    const leave = alert?.querySelector('[aria-label="Leave it running"]');
    expect(leave).not.toBeNull();
    await view.press(leave);
    expect(calls.filter((call) => call.method === "work.leave-running").map((call) => call.input)).toEqual([
      { id: "z" },
    ]);
    // A start left to you clears when you dispatch or cancel: its notice has no verb of its own.
    await view.rerender(<WorkDetail id="y" theme={theme} compact={false} navigation={undefined} />);
    expect(view.byLabel("Leave it running")).toBeNull();
    expect(view.all('[role="alert"]').map((el) => el.textContent)).toContain(yours.reason);
  });

  test("the detail says why, as a warning Notice; unflagged work has none", async () => {
    items = flagged();
    const view = await mount(<WorkDetail id="y" theme={theme} compact={false} navigation={undefined} />);
    expect(view.all('[role="alert"]').map((el) => el.textContent)).toContain(yours.reason);
    expect(view.byLabel("Dispatch")).not.toBeNull();
    await view.rerender(<WorkDetail id="d" theme={theme} compact={false} navigation={undefined} />);
    expect(view.text()).not.toContain(yours.reason);
    expect(view.all('[role="alert"]')).toHaveLength(0);
  });
});

describe("views and filters", () => {
  test("each chip counts exactly what it shows; the section chips match the feed's sections and add up to All", async () => {
    const at = new Date(Date.now() - 2 * 60_000).toISOString();
    const yours = { kind: "yours" as const, reason: "Start it yourself: it runs without permission prompts.", at };
    const quiet = { kind: "quiet" as const, reason: "Quiet for 41 minutes, worth a look.", at };
    items = [
      ...fixture(),
      work("y", "proposed", { flag: yours }),
      work("z", "running", { worker: worker("z", "maestro/z-1"), phase: "working", flag: quiet }),
      work("q", "proposed"),
    ];
    const view = await mount(surface(false));
    /** The chips as the toolbar shows them: label to count. */
    const chips = () =>
      new Map(
        view.all('[aria-label="Filter by state"] [role="button"]').map((el) => {
          const label = el.getAttribute("aria-label") ?? "";
          const comma = label.lastIndexOf(", ");
          return [label.slice(0, comma), Number(label.slice(comma + 2))] as const;
        }),
      );
    type El = ReturnType<typeof view.all>[number];
    const isCard = (el: El) => el.getAttribute("aria-label")?.startsWith("Work ") ?? false;
    const cards = (root: El | null | undefined) =>
      [...(root?.querySelectorAll('[role="button"]') ?? [])].filter(isCard);
    /** The feed's sections: title to how many cards it lists. */
    const sections = () =>
      new Map(
        view
          .all('[role="heading"]')
          .filter((el) => ["Needs you", "Stuck", "Running", "Queued", "Done"].includes(el.textContent ?? ""))
          .map((el) => [el.textContent ?? "", cards(el.parentElement?.parentElement).length] as const),
      );
    const all = chips();
    expect([...all]).toEqual([
      ["All", 9],
      ["Needs you", 5],
      ["Stuck", 1],
      ["Running", 1],
      ["Queued", 2],
      ["Done", 1],
    ]);
    // In the All view, each section chip counts its section; Stuck has no section of its own.
    const listed = sections();
    expect([...listed]).toEqual([
      ["Needs you", 5],
      ["Running", 1],
      ["Queued", 2],
      ["Done", 1],
    ]);
    for (const title of ["Needs you", "Running", "Queued", "Done"])
      expect([title, all.get(title)]).toEqual([title, listed.get(title)]);
    expect(["Needs you", "Running", "Queued", "Done"].reduce((sum, title) => sum + (all.get(title) ?? 0), 0)).toBe(
      all.get("All") ?? -1,
    );
    // Every chip, Stuck and All included, shows as many cards as it counts.
    for (const [title, count] of all) {
      await view.press(view.byLabel(`${title}, ${count}`));
      expect(view.pressed(`${title}, ${count}`)).toBe("true");
      expect([title, view.all('[role="button"]').filter(isCard).length]).toEqual([title, count]);
    }
  });

  test("a filter intent checks its chip, opens the feed and drops the scope", async () => {
    const view = await mount(surface(false));
    await view.press(view.byLabel("genesis, 1 of 2 open"));
    await view.press(view.tabs()[1]);
    expect(view.tabs()[1]?.getAttribute("aria-selected")).toBe("true");
    await act(async () => requestIntent({ kind: "filter", group: "review" }));
    await settle();
    expect(view.tabs()[0]?.getAttribute("aria-selected")).toBe("true");
    expect(view.pressed("Needs you, 3")).toBe("true");
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
    expect(view.byLabel("Needs you, 3")).toBeNull();
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

describe("the loop", () => {
  const minutesAhead = (minutes: number) => new Date(Date.now() + minutes * 60_000 - 1_000).toISOString();
  const rows = (view: Awaited<ReturnType<typeof mount>>) => view.all('[aria-label^="Wake, "]');

  test("the header says when it wakes next; the panel says how often, and lists the wakes newest first", async () => {
    loopState = {
      minutes: 15,
      nextAt: minutesAhead(12),
      ticking: false,
      recent: [
        wakeEntry("w2", 3, {
          cause: "manual",
          narrative: ["Woke because you asked.", "Did:", "  Started Cache the Rust build in CI."],
        }),
        wakeEntry("w1", 18, {
          narrative: [
            "Woke on a scheduled check.",
            "Did nothing new this tick.",
            "Left alone:",
            "  Bypass: Start it yourself: it runs without permission prompts.",
          ],
        }),
      ],
    };
    const view = await mount(surface(false));
    const control = view.byLabel("Next wake in 12 min. Show the loop");
    expect(control?.getAttribute("aria-expanded")).toBe("false");
    expect(view.text()).not.toContain("Recent wakes");
    await view.press(control);
    expect(view.byLabel("Next wake in 12 min. Hide the loop")?.getAttribute("aria-expanded")).toBe("true");
    expect(view.text()).toContain("The loop wakes every 15 minutes.");
    const [first, second] = rows(view);
    expect(first?.getAttribute("aria-label")).toMatch(/^Wake, Today at \d\d:\d\d, you asked$/);
    expect(first?.textContent).toContain("Started Cache the Rust build in CI.");
    // The cause is the row's header: the narrative's own "Woke ..." line is not repeated under it.
    expect(first?.textContent).not.toContain("Woke because you asked.");
    expect(second?.getAttribute("aria-label")).toMatch(/, on schedule$/);
    expect(second?.textContent).toContain("Bypass: Start it yourself: it runs without permission prompts.");
    // Closing it takes the panel away; polling goes on only while the control is mounted.
    await view.press(view.byLabel("Close the loop"));
    expect(view.text()).not.toContain("Recent wakes");
  });

  test("Wake now asks for a wake and shows it on top", async () => {
    loopState = { ...loopOff(), minutes: 30, nextAt: minutesAhead(20), recent: [wakeEntry("w1", 18)] };
    nextWake = () =>
      wakeEntry("w-now", 0, {
        cause: "manual",
        narrative: ["Woke because you asked.", "Did:", "  Started Persist the cart across devices."],
      });
    const view = await mount(surface(false));
    await view.press(view.byLabel("Next wake in 20 min. Show the loop"));
    await view.press(view.byLabel("Wake now"));
    expect(calls.filter((call) => call.method === "loop.wake")).toHaveLength(1);
    const [first, second] = rows(view);
    expect(first?.getAttribute("aria-label")).toMatch(/, you asked$/);
    expect(first?.textContent).toContain("Started Persist the cart across devices.");
    expect(second?.getAttribute("aria-label")).toMatch(/, on schedule$/);
    expect(view.all('[role="alert"]')).toHaveLength(0);
  });

  test("a wake that was skipped says why", async () => {
    loopState = { ...loopOff(), minutes: 15, nextAt: minutesAhead(5), ticking: true };
    nextWake = () =>
      wakeEntry("w-skip", 0, {
        cause: "manual",
        skipped: "another check was already running",
        narrative: ["Woke because you asked.", "Skipped: another check was already running."],
      });
    const view = await mount(surface(false));
    await view.press(view.byLabel("Waking…. Show the loop"));
    await view.press(view.byLabel("Wake now"));
    expect(view.all('[role="alert"]').map((el) => el.textContent)).toEqual([
      "Not woken: another check was already running.",
    ]);
  });

  test("off and never woken: it says so, and says where its period is set", async () => {
    const view = await mount(surface(false));
    await view.press(view.byLabel("Loop off. Show the loop"));
    expect(view.text()).toContain("The loop is off.");
    expect(view.text()).toContain("No wakes yet.");
    expect(view.text()).toContain("Its period is set in Settings.");
    expect(view.byLabel("Open Settings")).toBeNull();
  });

  test("with Settings linked, the panel opens them", async () => {
    let opened = 0;
    const unlink = linkSettings(() => {
      opened += 1;
    });
    try {
      const view = await mount(surface(false));
      await view.press(view.byLabel("Loop off. Show the loop"));
      await view.press(view.byLabel("Open Settings"));
      expect(opened).toBe(1);
    } finally {
      unlink();
    }
  });
});

describe("the Queued hint", () => {
  const LOOP_HINT = "The loop starts these on its next wake, under the run cap";
  const YOURS_HINT = "Ready when you dispatch it";

  for (const [on, shown, hidden] of [
    [false, YOURS_HINT, LOOP_HINT],
    [true, LOOP_HINT, YOURS_HINT],
  ] as const) {
    test(`with the loop ${on ? "on" : "off"}, the feed, the list and the board say "${shown}"`, async () => {
      if (on) loopState = { ...loopOff(), minutes: 15, nextAt: new Date(Date.now() + 9 * 60_000).toISOString() };
      const view = await mount(surface(false));
      for (const tab of [0, 2, 1]) {
        await view.press(view.tabs()[tab]);
        expect(view.text()).toContain(shown);
        expect(view.text()).not.toContain(hidden);
      }
    });
  }
});

describe("Settings", () => {
  const settingsScreen = () => (
    <MaestroSettings theme={theme} host={{ id: "h", label: "h" }} layout={{ compact: false, platform: "web" }} />
  );

  test("the loop is a choice of off or a period, and Save sends the whole config back with it", async () => {
    const view = await mount(settingsScreen());
    expect(view.text()).toContain("the loop starts Queued work under the run cap");
    expect(view.pressed("The loop: Off")).toBe("true");
    for (const label of ["Every 5 minutes", "Every 15 minutes", "Every 30 minutes", "Every 60 minutes"]) {
      expect(view.byLabel(`The loop: ${label}`)).not.toBeNull();
    }
    await view.press(view.byLabel("The loop: Every 15 minutes"));
    expect(view.pressed("The loop: Every 15 minutes")).toBe("true");
    await view.press(view.byLabel("Save settings"));
    expect(calls.filter((call) => call.method === "config.set").map((call) => call.input)).toEqual([
      { ...settingsFixture(), loopMinutes: 15 },
    ]);
  });

  test("a saved period that is none of the choices shows as itself, and turning it off saves null", async () => {
    settings = { ...settingsFixture(), loopMinutes: 45 };
    const view = await mount(settingsScreen());
    expect(view.pressed("The loop: Every 45 minutes")).toBe("true");
    await view.press(view.byLabel("The loop: Off"));
    await view.press(view.byLabel("Save settings"));
    expect(calls.filter((call) => call.method === "config.set").map((call) => call.input)).toEqual([
      { ...settingsFixture(), loopMinutes: null },
    ]);
  });
});
