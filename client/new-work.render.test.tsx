// Render tests for the New work composer: the real component, mounted with
// react-dom through react-native-web in a happy-dom window, the way Paseo's
// web and desktop builds run it. The setup mirrors plane.render.test.tsx (see
// its header): globals first, react-native mocked as react-native-web, and the
// host's react-native kit as plain parts, then everything else imported
// dynamically. The Paseo API is a fake whose provider reads each test shapes;
// RPCs go through the real contracts, so `created` holds exactly what the
// server would receive. Menus render inline (no portal), and a press is a DOM
// click, which react-native-web's Pressable answers.
//
// Two traps. The provider reads chain (projects, then the folder's reads,
// then its features), and an act scope flushes only when it ends, so mount
// settles over several scopes. And this suite shares a machine with CI and
// other work: under load a test can pass bun's 5 s default, the timeout fires
// mid-test, afterEach unmounts, and the rest of the body asserts against an
// empty container ("no menu appeared", reported between tests). Every test
// here gets SLOW instead. bun's module mocks outlive the file and
// mock.restore() does not undo them, so afterAll puts both mocked modules back
// to what a file that does not mock them gets under bun.

import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { Window } from "happy-dom";
import type { ReactNode } from "react";
import type { WorkItem } from "../shared/contracts";
import { FAKE_PROVIDERS } from "../shared/fake-providers";

const SLOW = 30_000;
const it = (name: string, run: () => Promise<void>) => test(name, run, SLOW);

const win = new Window({ url: "http://localhost/" });
Object.assign(win, {
  matchMedia: (query: string) => ({
    media: query,
    matches: query.includes("reduce"),
    addEventListener: () => {},
    removeEventListener: () => {},
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
const { PaseoApiProvider, PluginRpcProvider } = await import("@getpaseo/plugin/client/host");
const { NewWorkPane, NewWork } = await import("./new-work");

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
const pending = () => new Promise<never>(() => {});

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

const settings: { workRoot: string; provider: string; modeId: string | null; isolation: string } = {
  workRoot: "/work",
  provider: "claude/haiku",
  modeId: null,
  isolation: "worktree",
};
const created: Record<string, unknown>[] = [];
const inspected: string[] = [];
const item = (id: string): WorkItem => ({
  id,
  path: id,
  title: "Made",
  kind: "task",
  state: "proposed",
  group: "queued",
  gate: "human",
  owner: null,
  initiative: null,
  project: null,
  repo: "/src/broomva",
  createdAt: "2026-09-29T10:00:00Z",
  updatedAt: "2026-09-29T10:00:00Z",
  lastEventAt: null,
  phase: null,
  worker: null,
  reason: null,
  verdict: null,
  look: null,
  permission: null,
  checks: [],
});
const invoke = async (method: string, input: unknown) => {
  switch (method) {
    case "config.get":
      return settings;
    case "work.list": {
      const scoreboard = { unsupervisedMs: 0, looks: 0, longestRunMs: 0, live: false, segments: [], notches: [] };
      return { root: "/work", items: [], warnings: [], scoreboard };
    }
    case "work.create":
      created.push(input as Record<string, unknown>);
      return { item: item(`w${created.length}`) };
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

const pane = (overrides: { onClose?: () => void; onCreated?: (id: string) => void } = {}) => (
  <NewWorkPane
    theme={theme}
    compact={false}
    onClose={overrides.onClose ?? (() => {})}
    onCreated={overrides.onCreated ?? (() => {})}
  />
);

const consoleError = spyOn(console, "error").mockImplementation(() => {});

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  reads = answers();
  created.length = 0;
  inspected.length = 0;
  settings.provider = "claude/haiku";
  settings.modeId = null;
  const logged = consoleError.mock.calls.map((args) => String(args[0]));
  consoleError.mockClear();
  expect(logged).toEqual([]);
});

afterAll(async () => {
  consoleError.mockRestore();
  // The host's kit is an empty module outside Paseo. react-native has no build that loads under bun,
  // so an empty module is the nearest honest stand-in: a later file that forgets to mock it fails loudly
  // instead of rendering against this file's react-native-web.
  mock.module("@getpaseo/plugin/client/react-native", () => ({}));
  mock.module("react-native", () => ({}));
  for (const key of added) delete (globalThis as Record<string, unknown>)[key];
  await win.happyDOM.close();
});

describe("the composer's agent pills", () => {
  it("they read the provider: the Settings model, its thinking, the provider's default mode, its features", async () => {
    reads.listModels = async () => ({ provider: "claude", models: [OPUS, HAIKU], fetchedAt: "", requestId: "" });
    settings.provider = "claude/opus";
    const view = await mount(pane());
    expect(view.text()).toContain("New work");
    expect(view.pillText("Model")).toBe("Opus 5.5");
    expect(view.pillText("Thinking")).toBe("High");
    expect(view.pillText("Mode")).toBe("Always ask");
    expect(view.one('[role="switch"][aria-label="Fast"]')).not.toBeNull();
  });

  it("while the reads run, each pill says Loading", async () => {
    reads.listModels = pending;
    reads.listModes = pending;
    const view = await mount(pane());
    expect(view.pillText("Model")).toBe("Loading…");
    expect(view.pillText("Thinking")).toBe("Loading…");
    expect(view.pillText("Mode")).toBe("Loading…");
  });

  it("failed or empty reads keep every pill, reading Settings default", async () => {
    reads.listModels = async () => {
      throw new Error("claude is not installed");
    };
    reads.listModes = async () => ({
      provider: "claude",
      error: "claude is not installed",
      fetchedAt: "",
      requestId: "",
    });
    settings.provider = "claude";
    const view = await mount(pane());
    expect(view.pillText("Model")).toBe("Settings default");
    expect(view.pillText("Thinking")).toBe("Settings default");
    expect(view.pillText("Mode")).toBe("Settings default");
  });

  it("a feature read that fails says so under the composer", async () => {
    reads.listFeatures = async () => ({ provider: "claude", error: "no features here", fetchedAt: "", requestId: "" });
    const view = await mount(pane());
    expect(view.text()).toContain("Could not list Claude’s features: no features here");
  });
});

describe("what Dispatch sends", () => {
  it("untouched pills send no run choices; the first project is where it runs", async () => {
    const view = await mount(pane());
    await view.type(view.one('textarea[aria-label="Brief"]'), "Trim the cache\nDone when it is small.");
    await view.press(view.one('[aria-label="Dispatch"]'));
    expect(created).toEqual([
      {
        brief: "Trim the cache\nDone when it is small.",
        repo: "/src/broomva",
        check: "",
        gate: "human",
        initiative: "",
        dispatch: true,
      },
    ]);
  });

  it("picking a mode pins the model Settings names, not the provider's default", async () => {
    const view = await mount(pane());
    expect(view.pillText("Model")).toBe("Haiku 4.5");
    await view.type(view.one('textarea[aria-label="Brief"]'), "Trim the cache");
    await view.press(view.pill("Mode"));
    const menu = view.one('[role="menu"]');
    expect(menu).not.toBeNull();
    const rows = view.all('[role="menuitemradio"]');
    expect(rows.map((row) => [row.textContent, row.getAttribute("aria-checked")])).toEqual([
      ["Always ask", "true"],
      ["Bypass", "false"],
    ]);
    await view.press(rows[1]);
    expect(view.pillText("Mode")).toBe("Bypass");
    await view.press(view.one('[aria-label="Save to queue"]'));
    expect(created[0]).toMatchObject({ provider: "claude/haiku", modeId: "bypassPermissions", dispatch: false });
  });

  it("return in the brief dispatches, command-return queues, shift-return does not submit", async () => {
    const view = await mount(pane());
    const brief = view.one('textarea[aria-label="Brief"]');
    await view.type(brief, "Trim the cache");
    await view.key(brief, "Enter", { shiftKey: true });
    expect(created).toHaveLength(0);
    await view.key(brief, "Enter", { metaKey: true });
    expect(created.map((input) => input.dispatch)).toEqual([false]);
    await view.type(view.one('textarea[aria-label="Brief"]'), "Another");
    await view.key(view.one('textarea[aria-label="Brief"]'), "Enter");
    expect(created.map((input) => input.dispatch)).toEqual([false, true]);
  });

  it("every mode the provider list marks unattended warns before Dispatch, from Settings too; no other mode does", async () => {
    const SKIPS = "This run skips permission prompts";
    reads.snapshot = async () => ({ entries: FAKE_PROVIDERS });
    const seen: [string, string, boolean][] = [];
    for (const { provider, modes } of FAKE_PROVIDERS) {
      reads.listModes = async () => ({ provider, modes, fetchedAt: "", requestId: "" });
      for (const mode of modes) {
        settings.provider = provider;
        settings.modeId = mode.id;
        const view = await mount(pane());
        expect(view.pillText("Mode")).toBe(mode.label);
        seen.push([provider, mode.id, view.text().includes(SKIPS)]);
        mounted.pop()?.();
      }
    }
    expect(seen).toEqual(
      FAKE_PROVIDERS.flatMap(({ provider, modes }) =>
        modes.map((mode): [string, string, boolean] => [provider, mode.id, mode.isUnattended === true]),
      ),
    );
  });

  it("a prompt-free Dispatch asks a second press, by button or by return; queueing does not", async () => {
    const view = await mount(pane());
    const brief = () => view.one('textarea[aria-label="Brief"]');
    await view.type(brief(), "Trim the cache");
    expect(view.text()).not.toContain("skips permission prompts");
    await view.press(view.pill("Mode"));
    await view.press(view.all('[role="menuitemradio"]')[1]);
    expect(view.pillText("Mode")).toBe("Bypass");
    // The warning stands next to Dispatch before it is pressed.
    expect(view.text()).toContain(
      "This run skips permission prompts: it can edit files and run commands without asking.",
    );
    await view.key(brief(), "Enter");
    expect(created).toHaveLength(0);
    expect(view.one('[aria-label="Confirm dispatch"]')).not.toBeNull();
    await view.key(brief(), "Enter");
    expect(created.map((input) => [input.modeId, input.dispatch])).toEqual([["bypassPermissions", true]]);

    await view.type(brief(), "Trim it again");
    await view.press(view.one('[aria-label="Dispatch"]'));
    expect(created).toHaveLength(1);
    await view.press(view.one('[aria-label="Confirm dispatch"]'));
    expect(created.map((input) => input.dispatch)).toEqual([true, true]);

    await view.type(brief(), "Queue this one");
    await view.key(brief(), "Enter", { metaKey: true });
    expect(created.map((input) => input.dispatch)).toEqual([true, true, false]);
  });

  it("Dispatch stays off until there is a brief or a title", async () => {
    const view = await mount(pane());
    await view.press(view.one('[aria-label="Dispatch"]'));
    expect(created).toHaveLength(0);
    expect(view.one('[aria-label="Dispatch"]')?.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("menus and keys", () => {
  it("every picker opens as a menu of its choices, the current one checked", async () => {
    settings.provider = "claude/opus";
    const view = await mount(pane());
    const label = (row: HTMLElementLike) => row.getAttribute("aria-label")?.split(". ")[0] ?? "";
    const open = async (pill: HTMLElementLike | null) => {
      await view.press(pill);
      expect(view.all('[role="menu"]')).toHaveLength(1);
      const rows = view.all('[role="menuitemradio"]');
      const shown = {
        choices: rows.map(label),
        checked: rows.filter((row) => row.getAttribute("aria-checked") === "true").map(label),
        actions: view.all('[role="menuitem"]').map(label),
        off: rows.filter((row) => row.getAttribute("aria-disabled") === "true").map(label),
      };
      await view.press(view.one('[data-testid="menu-backdrop"]'));
      expect(view.one('[role="menu"]')).toBeNull();
      return shown;
    };
    expect(await open(view.one('[aria-label="Runs in broomva"]'))).toEqual({
      choices: ["broomva", "Choose a folder\u2026"],
      checked: ["broomva"],
      actions: [],
      off: [],
    });
    expect(await open(view.one('[aria-label="New worktree"]'))).toEqual({
      choices: ["New worktree", "In the repository"],
      checked: ["New worktree"],
      actions: [],
      off: [],
    });
    expect(await open(view.one('[aria-label="Who closes it: you approve"]'))).toEqual({
      choices: ["You approve", "Checks decide"],
      checked: ["You approve"],
      actions: [],
      off: ["Checks decide"],
    });
    expect(await open(view.one('[aria-label="Initiative: none"]'))).toEqual({
      choices: ["No initiative"],
      checked: ["No initiative"],
      actions: ["New initiative\u2026"],
      off: [],
    });
    expect(await open(view.pill("Model"))).toEqual({
      choices: ["Opus 5.5", "Haiku 4.5"],
      checked: ["Opus 5.5"],
      actions: [],
      off: [],
    });
    expect(await open(view.pill("Thinking"))).toEqual({
      choices: ["High", "Extra high"],
      checked: ["High"],
      actions: [],
      off: [],
    });
    expect(await open(view.pill("Mode"))).toEqual({
      choices: ["Always ask", "Bypass"],
      checked: ["Always ask"],
      actions: [],
      off: [],
    });
  });

  it("pressing outside an open menu closes it", async () => {
    const view = await mount(pane());
    await view.press(view.pill("Mode"));
    expect(view.one('[role="menu"]')).not.toBeNull();
    await view.press(view.one('[data-testid="menu-backdrop"]'));
    expect(view.one('[role="menu"]')).toBeNull();
  });

  it("esc inside a text field closes the open menu first, then the pane", async () => {
    let closed = 0;
    const view = await mount(pane({ onClose: () => closed++ }));
    await view.press(view.pill("Mode"));
    const search = view.one('input[aria-label="Search modes…"]');
    expect(search).not.toBeNull();
    await view.key(search, "Escape");
    expect(view.one('[role="menu"]')).toBeNull();
    expect(closed).toBe(0);
    await view.key(view.one('textarea[aria-label="Brief"]'), "Escape");
    expect(closed).toBe(1);
  });

  it("a typed folder is read by the daemon; one that is not a repository blocks Dispatch under worktree isolation", async () => {
    const view = await mount(pane());
    await view.press(view.one('[aria-label^="Runs in "]'));
    await view.press(view.one('[aria-label="Choose a folder…. Any git repository on this host"]'));
    const field = view.one('input[aria-label="Repository folder"]');
    await view.type(field, "~/scratch");
    await view.blur(field);
    expect(inspected).toEqual(["~/scratch"]);
    expect(view.text()).toContain("Not a git repository, and each run gets a new worktree.");
    await view.type(view.one('textarea[aria-label="Brief"]'), "Trim the cache");
    expect(view.one('[aria-label="Dispatch"]')?.getAttribute("aria-disabled")).toBe("true");
  });

  it("the modal wrapper renders the same composer when open", async () => {
    const view = await mount(
      <NewWork theme={theme} open onOpenChange={() => {}} onCreated={() => {}} compact={false} />,
    );
    expect(view.one('textarea[aria-label="Brief"]')).not.toBeNull();
    expect(view.pillText("Model")).toBe("Haiku 4.5");
  });
});
