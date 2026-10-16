// Render tests for the Maestro card in a Paseo session (BRO-3008, K1) and the session page it opens (K2): the real
// components, mounted with react-dom through react-native-web in a happy-dom window, the way Paseo's web and
// desktop builds run them. The setup mirrors client/kit/kit.render.test.tsx (see its header). The daemon is a
// small stateful fake whose needs.list is the real projection (server/needs.ts) over the fixtures, so a card reads
// exactly what the server would send; a decision lands in the fake's ledger as the server's does (8 s pending,
// then a receipt), and a test moves the world on by hand (`sim.settle`).
//
// Ids are in their real shapes and never shared across spaces: a Paseo agent id, the work id, and a permission
// request id are three different things (a fixture that used one for all three tested the mirror, #56).

import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import type { ComponentProps, ReactNode } from "react";
import { type CardData, holdVersion } from "../shared/card";

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
const toasts: string[] = [];
mock.module("react-native", () => web);
mock.module("@getpaseo/plugin/client/react-native", () => ({
  ScrollView: web.ScrollView,
  FlatList: web.FlatList,
  TextInput: web.TextInput,
  Icon: () => null,
  Modal: Object.assign(({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null), {
    Content: ({ children }: { children: ReactNode }) => children,
  }),
  useToast: () => ({
    show: (message: string) => void toasts.push(message),
    error: (message: string) => void toasts.push(`error: ${message}`),
  }),
  useRevealedText: (text: string) => text,
}));

const { act } = await import("react");
const { createRoot } = require("react-dom/client") as {
  createRoot(container: unknown): { render(node: ReactNode): void; unmount(): void };
};
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { PluginRpcProvider } = await import("@getpaseo/plugin/client/host");
const { needsOf } = await import("../server/needs");
const { fakeWork } = await import("./fake-work");
const { createLegacyCard, createSessionCard } = await import("./session-card");
const { SessionScreen, sessionTitle } = await import("./session-screen");
const { askHoldKey, approvalKey } = await import("../shared/needs");
const { GALLERY_LIGHT } = await import("./kit/gallery-data");

type Actions = import("./card-hooks").CardActions;
type WorkItem = import("../shared/contracts").WorkItem;
type DecisionAsk = import("../shared/fleet").DecisionAsk;
type NeedSource = import("../shared/needs").NeedSource;
type PendingVerb = import("../shared/verbs").PendingVerb;
type SettledVerb = import("../shared/verbs").SettledVerb;
type OpenApproval = import("../server/needs").OpenApproval;

const theme = GALLERY_LIGHT;

// ── Real-shaped ids ──────────────────────────────────────────────────────────

const AGENT = "6f1c2e0a-93b4-4d7e-8a15-2c9d0b7e41aa";
const OTHER_AGENT = "b3d9a7f2-0c51-4e8a-9f6d-71e2a4c85b03";
const WORK = "w-20261012-ledger-1f3a";
const REQUEST = "perm_01JBQ7X2K9M4N5P6R7S8T9V0WA";
const ACTION = "Run a command: gh pr merge 933 --squash";
const worker = { agentId: AGENT, workspaceId: "ws-5d2" };

// ── The daemon, as far as a card reads it ────────────────────────────────────

interface Sim {
  items: WorkItem[];
  approvals: OpenApproval[];
  asks: DecisionAsk[];
  pending: PendingVerb[];
  recent: SettledVerb[];
  unread: NeedSource[];
  needsFail: string | null;
  ledgerFail: string | null;
  workFail: string | null;
  /** needs.list waits for this before it answers: a daemon that is slow to read everything. */
  needsHeld: Promise<void> | null;
  /** work.for-agent fails with this. */
  agentWorkFail: string | null;
  /** A reason approval.decide refuses with. */
  refuse: string | null;
  events: { ts: string; type: string; actor: "human" | "agent" | "maestro"; text: string; detail: string | null }[];
  calls: { method: string; input: unknown }[];
}
const blank = (): Sim => ({
  items: [],
  approvals: [],
  asks: [],
  pending: [],
  recent: [],
  unread: [],
  needsFail: null,
  ledgerFail: null,
  workFail: null,
  refuse: null,
  needsHeld: null,
  agentWorkFail: null,
  events: [],
  calls: [],
});
let sim = blank();
const sent = (method: string) => sim.calls.filter((call) => call.method === method).map((call) => call.input);

const holdsNow = () =>
  needsOf(
    {
      items: sim.items,
      asks: sim.asks,
      reviews: [],
      landing: null,
      workspace: "broomva",
      approvals: sim.approvals,
      pending: new Map(
        sim.pending
          .filter((verb) => verb.verb === "approval.decide")
          .map((verb) => [verb.key, { receipt: verb.receipt, label: verb.label, appliesAt: verb.appliesAt }]),
      ),
    },
    Date.now(),
  );

/** What the server does when a verb of yours comes due: it takes effect, and leaves a receipt. */
function settle(receipt: string, change: () => void, outcome: SettledVerb["outcome"] = "applied", detail = "Done.") {
  const verb = sim.pending.find((entry) => entry.receipt === receipt);
  if (!verb) throw new Error(`no pending verb ${receipt}`);
  sim.pending = sim.pending.filter((entry) => entry.receipt !== receipt);
  const { remainingMs: _remaining, appliesAt: _applies, ...rest } = verb;
  sim.recent = [{ ...rest, settledAt: new Date().toISOString(), outcome, detail }, ...sim.recent];
  change();
}

const schedule = (verb: PendingVerb["verb"], key: string, label: string) => {
  const entry: PendingVerb = {
    receipt: `r-${sim.pending.length + sim.recent.length + 1}`,
    verb,
    key,
    label,
    at: new Date().toISOString(),
    appliesAt: new Date(Date.now() + 8_000).toISOString(),
    remainingMs: 8_000,
  };
  sim.pending = [entry, ...sim.pending];
  return { receipt: entry.receipt, appliesAt: entry.appliesAt };
};

const invoke = async (method: string, input: unknown) => {
  sim.calls.push({ method, input });
  switch (method) {
    case "needs.list": {
      if (sim.needsHeld) await sim.needsHeld;
      if (sim.needsFail) throw new Error(sim.needsFail);
      const needs = holdsNow();
      return sim.unread.length ? { ...needs, unread: sim.unread } : needs;
    }
    case "verbs.list": {
      if (sim.ledgerFail) throw new Error(sim.ledgerFail);
      const now = Date.now();
      return {
        pending: sim.pending.map((verb) => ({ ...verb, remainingMs: Math.max(0, Date.parse(verb.appliesAt) - now) })),
        recent: sim.recent,
      };
    }
    case "approval.decide": {
      const { key, allow, action } = input as { key: string; allow: boolean; action: string };
      if (sim.refuse) throw new Error(sim.refuse);
      return schedule("approval.decide", key, `${allow ? "Allowed" : "Denied"} ${action}`);
    }
    case "ask.answer": {
      const { id } = input as { id: string };
      const ask = sim.asks.find((entry) => entry.id === id);
      if (!ask) throw new Error("no such ask");
      return { ask, warning: null, work: null, ...schedule("ask.answer", askHoldKey(ask), `Answered ${ask.headline}`) };
    }
    case "session.prompt": {
      const { key, prompt } = input as { key?: string; prompt: string; agentId: string };
      return schedule("session.prompt", key ?? "session", `Sent: ${prompt.slice(0, 40)}`);
    }
    case "work.verdict": {
      const { id, note } = input as { id: string; note: string };
      return {
        item: sim.items.find((item) => item.id === id),
        ...schedule("work.verdict", `work:${id}`, `Changed course: ${note}`),
      };
    }
    case "work.unblock": {
      const { id } = input as { id: string };
      return {
        item: sim.items.find((item) => item.id === id),
        ...schedule("work.unblock", `work:${id}`, "Unblocked the work"),
      };
    }
    case "work.cancel": {
      const { id } = input as { id: string };
      return {
        item: sim.items.find((item) => item.id === id),
        ...schedule("work.cancel", `work:${id}`, "Canceled the work"),
      };
    }
    case "work.stop": {
      const { id } = input as { id: string };
      return {
        item: sim.items.find((item) => item.id === id),
        ...schedule("work.stop", `work:${id}`, "Stopped the run"),
      };
    }
    case "notice.snooze": {
      const { key, hours } = input as { key: string; hours: number };
      return schedule("notice.snooze", key, `Snoozed the notice for ${hours} h`);
    }
    case "work.dispatch":
      return { item: sim.items.find((item) => item.id === (input as { id: string }).id) };
    case "verb.undo": {
      const { receipt } = input as { receipt: string };
      sim.pending = sim.pending.filter((entry) => entry.receipt !== receipt);
      return { undone: true };
    }
    case "work.get": {
      if (sim.workFail) throw new Error(sim.workFail);
      const item = sim.items.find((entry) => entry.id === (input as { id: string }).id);
      if (!item) throw new Error("no such work");
      return {
        item,
        brief: "# Harden the ask ledger\n\nReclaim a stale lock after 120 s.",
        events: sim.events,
        checkResults: [],
      };
    }
    case "work.for-agent": {
      if (sim.agentWorkFail) throw new Error(sim.agentWorkFail);
      const { agentId } = input as { agentId: string };
      return { item: sim.items.find((entry) => entry.worker?.agentId === agentId) ?? null };
    }
    case "asks.workspace":
      return { controlRepo: "/ctl", main: null, decisions: sim.asks, fleet: [], warnings: [] };
    case "work.adopt":
      return { item: sim.items[0] };
    default:
      throw new Error(`unexpected RPC ${method}`);
  }
};

// ── The harness ──────────────────────────────────────────────────────────────

const settleUi = (ms = 30) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const mounted: (() => void)[] = [];

interface El {
  tagName: string;
  textContent: string | null;
  parentElement: El | null;
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
  mounted.push(() => {
    act(() => root.unmount());
    client.clear();
    container.remove();
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PluginRpcProvider invoke={invoke}>{node}</PluginRpcProvider>
      </QueryClientProvider>,
    ),
  );
  await settleUi();
  await settleUi();
  const box = container as unknown as El;
  const view = {
    text: () => box.textContent ?? "",
    byLabel: (label: string) => box.querySelector(`[aria-label="${label}"]`),
    byId: (id: string) => box.querySelector(`[data-testid="${id}"]`),
    all: (selector: string) => [...(box.querySelectorAll(selector) as unknown as El[])],
    press: async (target: El | null | undefined) => {
      if (!target) throw new Error("nothing to press");
      await act(async () => target.click());
      await settleUi();
    },
    /** Reads again now, as a poll would: how a change to the fake daemon reaches a mounted card. */
    refetch: async () => {
      await act(async () => client.invalidateQueries());
      await settleUi();
      await settleUi();
    },
    until: async (what: () => boolean, tries = 100) => {
      for (let at = 0; at < tries && !what(); at += 1) await settleUi(20);
      if (!what()) throw new Error(`never became true; the card says: ${view.text()}`);
    },
    type: async (target: El | null | undefined, value: string) => {
      if (!target) throw new Error("nothing to type in");
      const field = target as unknown as { tagName: string; dispatchEvent(event: unknown): boolean };
      const proto = field.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      await act(async () => {
        Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, value);
        field.dispatchEvent(new win.Event("input", { bubbles: true }));
      });
      await settleUi();
    },
  };
  return view;
}

const consoleError = spyOn(console, "error").mockImplementation(() => {});

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  sim = blank();
  toasts.length = 0;
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

// ── What each action did, as the plugin's own screens would ─────────────────

const went: string[] = [];
const actions: Actions = {
  session: (agentId) => void went.push(`session:${agentId}`),
  hold: (key) => void went.push(`hold:${key}`),
  maestro: () => void went.push("maestro"),
  intent: (intent) => void went.push(`intent:${intent.kind}`),
};
afterEach(() => {
  went.length = 0;
});

const Card = createSessionCard(actions);
const Legacy = createLegacyCard(actions);
const props = (data: CardData, host: string | null = AGENT, compact = false) =>
  ({
    item: { type: "plugin", kind: "maestro-card", version: 1, data },
    agentId: host ?? "",
    timestamp: new Date(),
    theme,
    layout: { compact },
  }) as unknown as ComponentProps<typeof Card>;
const card = (data: CardData, host: string | null = AGENT) => <Card {...props(data, host)} />;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const permission = { requestId: REQUEST, title: "Run a command", detail: "gh pr merge 933 --squash" };
const asking = (extra: Partial<WorkItem> = {}) =>
  fakeWork(WORK, "review", worker, {
    title: "Harden the ask ledger",
    permission,
    landing: 4,
    ticket: "BRO-2917",
    ...extra,
  });
const approvalCard: CardData = { kind: "approval", key: `work:${WORK}`, version: REQUEST };

const askFixture = (extra: Partial<DecisionAsk> = {}): DecisionAsk => ({
  ledger: "claude-code-mods.yaml",
  uid: null,
  id: "A1",
  hash: "0123456789abcdef",
  arc: null,
  headline: "Install the three headless Claude Code mods fleet-wide?",
  question: null,
  stakes: "Hooks run on every session.",
  whyYou: "It changes every session's behaviour.",
  options: [
    { id: "off", label: "Keep them off", consequence: "Nothing changes.", reversible: true, recommended: true },
    {
      id: "all",
      label: "Install fleet-wide",
      consequence: "Every session gets them.",
      reversible: true,
      recommended: false,
    },
    { id: "mac", label: "Install on this Mac only", consequence: null, reversible: true, recommended: false },
  ],
  fallback: null,
  blocking: true,
  askedAt: "2026-10-12T13:00:00.000Z",
  answeredAt: null,
  answer: null,
  answerOption: null,
  state: "open",
  origin: { agentId: AGENT, cwd: null },
  refusal: null,
  home: { kind: "main", path: "/ctl", branch: null },
  batched: false,
  waiting: true,
  ...extra,
});
const askCardOf = (ask: DecisionAsk): CardData => {
  const row = holdsNow().rows.find((one) => one.key === askHoldKey(ask));
  if (!row) throw new Error("the ask is not a hold");
  return { kind: "ask", key: row.key, version: holdVersion(row) };
};

// ── Approval ─────────────────────────────────────────────────────────────────

describe("an approval card (K1): pending, undo window, receipt", () => {
  it("shows the exact action, what held it, at most two verbs and Open in Maestro", async () => {
    sim.items = [asking()];
    const view = await mount(card(approvalCard));
    expect(view.text()).toContain("Approval");
    expect(view.text()).toContain("Harden the ask ledger");
    expect(view.text()).toContain(ACTION);
    expect(view.text()).toContain("Held by the session's permission prompt");
    const verbs = view
      .all("[aria-label]")
      .filter((el) => ["Allow", "Deny"].includes(el.getAttribute("aria-label") ?? ""));
    expect(verbs.map((el) => el.getAttribute("aria-label"))).toEqual(["Allow", "Deny"]);
    expect(view.byLabel("Open in Maestro")).not.toBeNull();
    // Work is never approved (A1), and the card has no other verb.
    expect(view.byLabel("Approve")).toBeNull();
  });

  it("Allow is approval.decide on the text and the request id it shows, never a call on Paseo, then the 8 s undo, then Undo", async () => {
    sim.items = [asking()];
    const view = await mount(card(approvalCard));
    await view.press(view.byLabel("Allow"));
    // One exact action, bound to the prompt this card read: both come from the same needs.list row.
    expect(sent("approval.decide")).toEqual([{ key: `work:${WORK}`, allow: true, action: ACTION, requestId: REQUEST }]);
    await view.until(() => view.byId("card-undo") !== null);
    expect(view.byId("card-undo")?.textContent).toContain(`Allowed ${ACTION}`);
    expect(view.byId("card-undo")?.textContent).toMatch(/takes effect in [78] s/);
    // The verbs are gone while it waits: a second press cannot exist.
    expect(view.byLabel("Deny")).toBeNull();
    expect(sent("approval.decide")).toHaveLength(1);
    await view.press(view.byLabel(`Undo: Allowed ${ACTION}`));
    expect(sent("verb.undo")).toEqual([{ receipt: "r-1" }]);
    // Undone: the hold stands again, offering its verbs.
    await view.until(() => view.byLabel("Allow") !== null);
    expect(view.byId("card-undo")).toBeNull();
  });

  it("Undo works while everything is still being read again after Allow (a slow daemon): it is not held behind it", async () => {
    sim.items = [asking()];
    const view = await mount(card(approvalCard));
    let release = () => {};
    // The reads that follow the verb take seconds: Allow's own claim is held until they land.
    sim.needsHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    await view.press(view.byLabel("Allow"));
    await view.until(() => view.byId("card-undo") !== null);
    await view.press(view.byLabel(`Undo: Allowed ${ACTION}`));
    expect(sent("verb.undo")).toEqual([{ receipt: "r-1" }]);
    release();
    sim.needsHeld = null;
  });

  it("two quick presses send one decision", async () => {
    sim.items = [asking()];
    const view = await mount(card(approvalCard));
    const allow = view.byLabel("Allow") as El;
    await act(async () => {
      allow.click();
      allow.click();
    });
    await settleUi(60);
    expect(sent("approval.decide")).toHaveLength(1);
  });

  it("Deny is the same verb with allow false", async () => {
    sim.items = [asking()];
    const view = await mount(card(approvalCard));
    await view.press(view.byLabel("Deny"));
    expect(sent("approval.decide")).toEqual([
      { key: `work:${WORK}`, allow: false, action: ACTION, requestId: REQUEST },
    ]);
    await view.until(() => view.byId("card-undo")?.textContent?.includes("Denied") ?? false);
  });

  it("once the window closes and the hold leaves, the card is one line: its receipt", async () => {
    sim.items = [asking()];
    const view = await mount(card(approvalCard));
    await view.press(view.byLabel("Allow"));
    await view.until(() => view.byId("card-undo") !== null);
    settle("r-1", () => {
      sim.items = [asking({ permission: null, state: "running" })];
    });
    await view.refetch();
    await view.until(() => view.byId("card-settled") !== null);
    const line = view.byId("card-settled")?.textContent ?? "";
    expect(line).toContain("Approval · receipt");
    expect(line).toContain(`Allowed ${ACTION} · took effect`);
    expect(view.byLabel("Allow")).toBeNull();
    expect(view.byId("card-undo")).toBeNull();
  });

  it("answered from another surface it says resolved elsewhere, and never offers a dead button", async () => {
    sim.items = [asking()];
    const view = await mount(card(approvalCard));
    expect(view.byLabel("Allow")).not.toBeNull();
    // Answered on Paseo's own prompt: the work leaves your gate with no verb of yours.
    sim.items = [asking({ permission: null, state: "running" })];
    await view.refetch();
    await view.until(() => view.byId("card-settled") !== null);
    expect(view.byId("card-settled")?.textContent).toContain("Approval · resolved elsewhere");
    expect(view.byId("card-settled")?.textContent).toContain("no longer waits on you");
    expect(view.byLabel("Allow")).toBeNull();
    expect(view.byLabel("Deny")).toBeNull();
  });

  it("answered from J1 first: its window shows here as the same Undo, and an Undo here takes it back", async () => {
    sim.items = [asking()];
    const view = await mount(card(approvalCard));
    // J1's Allow, as the server records it.
    schedule("approval.decide", `work:${WORK}`, `Allowed ${ACTION}`);
    await view.refetch();
    await view.until(() => view.byId("card-undo") !== null);
    expect(view.byId("card-undo")?.textContent).toContain(`Allowed ${ACTION}`);
    await view.press(view.byLabel(`Undo: Allowed ${ACTION}`));
    expect(sent("verb.undo")).toEqual([{ receipt: "r-1" }]);
  });

  it("a card for an earlier prompt is superseded when the session asked another, and offers nothing", async () => {
    sim.items = [asking({ permission: { ...permission, requestId: "perm_01JBQ7ZZZZZZZZZZZZZZZZZZZZ" } })];
    const view = await mount(card(approvalCard));
    await view.until(() => view.byId("card-settled") !== null);
    expect(view.byId("card-settled")?.textContent).toContain("superseded");
    expect(view.byId("card-settled")?.textContent).toContain("A newer request replaced this one");
    expect(view.byLabel("Allow")).toBeNull();
    expect(view.byLabel("Open in Maestro")).not.toBeNull();
  });

  it("an action an agent asked leave for is carded under its own key and decided by it", async () => {
    sim.approvals = [
      {
        id: "e4a1c0",
        at: "2026-10-12T09:00:00.000Z",
        agentId: OTHER_AGENT,
        action: "gh pr merge 933 --squash @ ce73104",
        heldBy: "gate",
        title: "Merge #933",
        scope: "broomva",
        evidence: [
          { label: "checks", value: "7/7", tone: "ok" },
          { label: "P20", value: "8·9·8", tone: "ok" },
        ],
        after: [],
      },
    ];
    const data: CardData = { kind: "approval", key: approvalKey("e4a1c0"), version: approvalKey("e4a1c0") };
    const view = await mount(card(data, OTHER_AGENT));
    expect(view.text()).toContain("Merge #933");
    expect(view.text()).toContain("checks 7/7");
    expect(view.text()).toContain("P20 8·9·8");
    await view.press(view.byLabel("Allow merge"));
    expect(sent("approval.decide")).toEqual([
      { key: "approval:e4a1c0", allow: true, action: "gh pr merge 933 --squash @ ce73104" },
    ]);
  });
});

describe("a failed read is never 'nothing pending' or 'resolved'", () => {
  it("a needs.list that failed says it could not read, offers Try again, and no verb", async () => {
    sim.items = [asking()];
    sim.needsFail = "daemon unreachable";
    const view = await mount(card(approvalCard));
    await view.until(() => view.byId("card-unread") !== null);
    expect(view.byId("card-unread")?.textContent).toContain("Couldn't read what needs you: daemon unreachable");
    expect(view.text()).not.toContain("resolved");
    expect(view.byLabel("Allow")).toBeNull();
    sim.needsFail = null;
    await view.press(view.byLabel("Try again"));
    await view.until(() => view.byLabel("Allow") !== null);
  });

  it("a hold missing because the work could not be read is unread, not resolved", async () => {
    sim.items = [];
    sim.unread = ["work"];
    const view = await mount(card(approvalCard));
    await view.until(() => view.byId("card-unread") !== null);
    expect(view.text()).toContain("Couldn't read");
    expect(view.byId("card-settled")).toBeNull();
  });

  it("an unread source together with a failed ledger is unread and keeps reading: it never settles into 'resolved'", async () => {
    sim.items = [];
    sim.unread = ["work"];
    sim.ledgerFail = "verbs.list timed out";
    const view = await mount(card(approvalCard));
    await view.until(() => view.byId("card-unread") !== null);
    expect(view.byId("card-settled")).toBeNull();
    // It is still live: when the reads come back with the hold, the card offers it again, with no remount.
    sim.items = [asking()];
    sim.unread = [];
    sim.ledgerFail = null;
    await view.refetch();
    await view.until(() => view.byLabel("Allow") !== null);
  });

  it("a ledger that failed hides a decision already waiting, so the verbs are not offered blind", async () => {
    sim.items = [asking()];
    sim.ledgerFail = "verbs.list timed out";
    const view = await mount(card(approvalCard));
    await view.until(() => view.byId("card-unread") !== null);
    expect(view.byId("card-unread")?.textContent).toContain("Couldn't read your decisions: verbs.list timed out");
    expect(view.byLabel("Allow")).toBeNull();
  });

  it("a decision the server refuses is said, and the hold stays as it was, to be read again", async () => {
    sim.items = [asking()];
    sim.refuse = "The session now asks for something else. Read what it asks, then decide again.";
    const view = await mount(card(approvalCard));
    await view.press(view.byLabel("Allow"));
    expect(toasts).toEqual(["error: The session now asks for something else. Read what it asks, then decide again."]);
    expect(view.byId("card-undo")).toBeNull();
    expect(view.byLabel("Allow")).not.toBeNull();
  });
});

// ── Ask ──────────────────────────────────────────────────────────────────────

describe("an ask card", () => {
  it("shows the question and its options with the recommended one chosen, and Answer is ask.answer", async () => {
    const ask = askFixture();
    sim.asks = [ask];
    const view = await mount(card(askCardOf(ask)));
    expect(view.text()).toContain("Install the three headless Claude Code mods fleet-wide?");
    for (const label of ["Keep them off", "Install fleet-wide", "Install on this Mac only"]) {
      expect(view.byLabel(label)).not.toBeNull();
    }
    expect(view.byLabel("Keep them off")?.getAttribute("aria-checked")).toBe("true");
    await view.press(view.byLabel("Install fleet-wide"));
    expect(view.byLabel("Install fleet-wide")?.getAttribute("aria-checked")).toBe("true");
    await view.press(view.byLabel("Answer"));
    expect(sent("ask.answer")).toEqual([
      {
        where: { kind: "workspace", home: "origin/main" },
        ledger: "claude-code-mods.yaml",
        uid: null,
        id: "A1",
        hash: "0123456789abcdef",
        option: "all",
        note: "",
      },
    ]);
    await view.until(() => view.byId("card-undo") !== null);
    expect(view.byId("card-undo")?.textContent).toContain("Answered Install the three headless Claude Code mods");
  });

  it("a note beside the option goes with the answer (BRO-3146)", async () => {
    const ask = askFixture();
    sim.asks = [ask];
    const view = await mount(card(askCardOf(ask)));
    await view.press(view.byLabel("Install fleet-wide"));
    await view.type(
      view.byLabel("A note on your answer for Install the three headless Claude Code mods fleet-wide? (optional)"),
      "Only after the demo.",
    );
    await view.press(view.byLabel("Answer"));
    expect(sent("ask.answer")).toEqual([expect.objectContaining({ option: "all", note: "Only after the demo." })]);
  });

  it("an ask answered elsewhere collapses and says so; its receipt appears once it took effect", async () => {
    const ask = askFixture();
    sim.asks = [ask];
    const data = askCardOf(ask);
    const view = await mount(card(data));
    expect(view.byLabel("Answer")).not.toBeNull();
    sim.asks = [askFixture({ state: "answered", waiting: false, answerOption: "off", answer: "Keep them off" })];
    await view.refetch();
    await view.until(() => view.byId("card-settled") !== null);
    expect(view.byId("card-settled")?.textContent).toContain("Ask · resolved elsewhere");
    expect(view.byLabel("Answer")).toBeNull();
  });

  it("an answer that cannot be undone is not sent from the card: it opens Decisions to confirm", async () => {
    const ask = askFixture({
      options: [
        { id: "go", label: "Ship it", consequence: "Cannot be rolled back.", reversible: false, recommended: true },
        { id: "wait", label: "Wait", consequence: null, reversible: true, recommended: false },
      ],
    });
    sim.asks = [ask];
    const view = await mount(card(askCardOf(ask)));
    await view.press(view.byLabel("Answer"));
    expect(sent("ask.answer")).toEqual([]);
    expect(went).toEqual(["intent:decisions"]);
  });
});

// ── Owner step ───────────────────────────────────────────────────────────────

describe("an owner step card", () => {
  const stuck = () =>
    fakeWork("w-install-hooks", "proposed", null, {
      title: "Add two hooks to ~/.claude/settings.json",
      flag: {
        kind: "yours",
        reason: "The agent cannot write this file; the gate blocks it.",
        at: "2026-10-12T12:00:00.000Z",
      },
    });

  it("says where it is done and how Maestro knows, and Start it dispatches the work", async () => {
    sim.items = [stuck()];
    const row = holdsNow().rows[0];
    const data: CardData = { kind: "owner_step", key: "work:w-install-hooks", version: row ? holdVersion(row) : "" };
    const view = await mount(card(data, null));
    expect(view.text()).toContain("Owner step");
    expect(view.text()).toContain("Start it yourself");
    expect(view.text()).toContain("The agent cannot write this file");
    await view.press(view.byLabel("Start it"));
    expect(sent("work.dispatch")).toEqual([{ id: "w-install-hooks" }]);
  });

  it("with no session it opens the hold on the Feed, not a session page", async () => {
    sim.items = [stuck()];
    const row = holdsNow().rows[0];
    const data: CardData = { kind: "owner_step", key: "work:w-install-hooks", version: row ? holdVersion(row) : "" };
    const view = await mount(card(data, null));
    await view.press(view.byLabel("Open in Maestro"));
    expect(went).toEqual(["hold:work:w-install-hooks"]);
  });
});

// ── Finished ─────────────────────────────────────────────────────────────────

describe("a finished card", () => {
  const look = {
    ran: "18m unsupervised · 1 turn · ran to the gate",
    decided: [],
    ask: "",
    arc: null,
    closing: "Stored it on the Run record. All 40 tests pass and the branch is pushed.",
  };
  const finished = (extra: Partial<WorkItem> = {}) =>
    fakeWork(WORK, "review", worker, {
      title: "The inventory checker landed",
      permission: null,
      landing: 4,
      look,
      ...extra,
    });
  const data: CardData = { kind: "finished", key: `work:${WORK}`, version: "4" };

  it("says Finished, offers Continue and Change course, never Approve, and says what the verbs do", async () => {
    sim.items = [finished()];
    const view = await mount(card(data));
    expect(view.text()).toContain("Finished");
    expect(view.text()).toContain("The inventory checker landed");
    expect(view.byLabel("Continue")).not.toBeNull();
    expect(view.byLabel("Change course")).not.toBeNull();
    expect(view.byLabel("Approve")).toBeNull();
    expect(view.byLabel("Allow")).toBeNull();
    expect(view.text()).toContain("Gates merge finished work; you do not approve it.");
    expect(view.text()).toContain("Its last words");
  });

  it("Continue prompts the session on the work's key, with the undo window, then its receipt", async () => {
    sim.items = [finished()];
    const view = await mount(card(data));
    await view.press(view.byLabel("Continue"));
    expect(sent("session.prompt")).toEqual([
      {
        agentId: AGENT,
        prompt: "Continue where you stopped. End with the Decided and Ask sections.",
        key: `work:${WORK}`,
      },
    ]);
    await view.until(() => view.byId("card-undo") !== null);
    settle("r-1", () => {
      sim.items = [finished({ state: "running", permission: null })];
    });
    await view.refetch();
    await view.until(() => view.byId("card-settled") !== null);
    expect(view.byId("card-settled")?.textContent).toContain("Finished · receipt");
    expect(view.byId("card-settled")?.textContent).toContain("took effect");
  });

  it("Change course takes your note and sends it to the session as a prompt; the work's verdict is never called", async () => {
    sim.items = [finished()];
    const view = await mount(card(data));
    await view.press(view.byLabel("Change course"));
    expect(view.byLabel("What should change")).not.toBeNull();
    expect(
      (view.byLabel("Send") as El).getAttribute("aria-disabled") ??
        (view.byLabel("Send") as El).getAttribute("disabled"),
    ).not.toBeNull();
    await view.type(view.byLabel("What should change"), "Use the cache.");
    await view.press(view.byLabel("Send"));
    expect(sent("session.prompt")).toEqual([
      { agentId: AGENT, prompt: "Change of course: Use the cache.", key: `work:${WORK}` },
    ]);
    expect(sent("work.verdict")).toEqual([]);
    await view.until(() => view.byId("card-undo") !== null);
  });

  it("a card for an earlier landing says it was superseded and offers nothing", async () => {
    sim.items = [finished({ landing: 7 })];
    const view = await mount(card(data));
    await view.until(() => view.byId("card-settled") !== null);
    expect(view.byId("card-settled")?.textContent).toContain("Superseded by a later run.");
    expect(view.byLabel("Continue")).toBeNull();
  });

  it("the same card in another session than the worker's offers nothing: it cannot answer for it", async () => {
    sim.items = [finished()];
    const view = await mount(card(data, OTHER_AGENT));
    await view.until(() => view.byId("card-settled") !== null);
    expect(view.byId("card-settled")?.textContent).toContain("moved to another session");
    expect(view.byLabel("Continue")).toBeNull();
  });

  it("asking permission now it is held: the approval's card has the verbs, this one only says so", async () => {
    sim.items = [finished({ permission })];
    const view = await mount(card(data));
    await view.until(() => view.byId("card-settled") !== null);
    expect(view.byId("card-settled")?.textContent).toContain("the approval card holds it");
    expect(view.byLabel("Continue")).toBeNull();
  });

  it("a card of an earlier build (maestro-gate) renders as this finished card for its landing", async () => {
    sim.items = [finished()];
    const view = await mount(
      <Legacy
        {...({
          item: {
            type: "plugin",
            kind: "maestro-gate",
            version: 1,
            data: { workId: WORK, landing: 4, agentId: AGENT },
          },
          agentId: AGENT,
          timestamp: new Date(),
          theme,
          layout: { compact: false },
        } as unknown as ComponentProps<typeof Legacy>)}
      />,
    );
    expect(view.text()).toContain("Finished");
    expect(view.byLabel("Continue")).not.toBeNull();
  });

  it("a work read that failed is said, and the verbs wait", async () => {
    sim.items = [finished()];
    sim.workFail = "work store busy";
    const view = await mount(card(data));
    await view.until(() => view.byId("card-unread") !== null);
    expect(view.byId("card-unread")?.textContent).toContain("Couldn't read the work: work store busy");
    expect(view.byLabel("Continue")).toBeNull();
  });
});

// ── Health ───────────────────────────────────────────────────────────────────

describe("a health card", () => {
  const stuck = (extra: Partial<WorkItem> = {}) =>
    fakeWork(WORK, "blocked", worker, {
      title: "Credits ledger: the session ended mid-turn",
      reason: "session ended (no turn end recorded)",
      ticket: "STI-3593",
      ...extra,
    });
  const data: CardData = { kind: "health", key: `work:${WORK}`, version: "5c3a99e1" };

  it("shows why it stopped in a log well and offers Unblock", async () => {
    sim.items = [stuck()];
    const view = await mount(card(data));
    expect(view.text()).toContain("Health");
    expect(view.text()).toContain("session ended (no turn end recorded)");
    await view.press(view.byLabel("Unblock"));
    expect(sent("work.unblock")).toEqual([{ id: WORK, note: "" }]);
    await view.until(() => view.byId("card-undo") !== null);
  });

  it("Snooze 4 h is the notice's own verb with its window; applied, the card is a receipt while the work stays stuck", async () => {
    sim.items = [stuck()];
    const view = await mount(card(data));
    await view.press(view.byLabel("Snooze 4 h"));
    expect(sent("notice.snooze")).toEqual([{ key: `work:${WORK}`, hours: 4 }]);
    await view.until(() => view.byId("card-undo") !== null);
    settle("r-1", () => undefined);
    await view.refetch();
    await view.until(() => view.byId("card-settled") !== null);
    expect(view.byId("card-settled")?.textContent).toContain("Snoozed the notice for 4 h · took effect");
    expect(view.byLabel("Unblock")).toBeNull();
  });

  it("once the work is going again the card says so in one line", async () => {
    sim.items = [stuck()];
    const view = await mount(card(data));
    sim.items = [stuck({ state: "running", reason: null })];
    await view.refetch();
    await view.until(() => view.byId("card-settled") !== null);
    expect(view.byId("card-settled")?.textContent).toContain("Back with the agent");
    expect(view.byLabel("Unblock")).toBeNull();
  });
});

// ── Digest ───────────────────────────────────────────────────────────────────

describe("the inbox digest", () => {
  const digest: CardData = { kind: "digest", key: `work:${WORK}`, version: "inbox-c1" };

  it("lists what needs you, each opening its own session, and counts the same number as the header", async () => {
    sim.items = [
      asking(),
      fakeWork(
        "w-second",
        "review",
        { agentId: OTHER_AGENT, workspaceId: null },
        {
          title: "Retry failed card charges",
          permission: { requestId: "perm_02", title: "Run a command", detail: "git push origin main" },
        },
      ),
    ];
    const view = await mount(card(digest, null));
    expect(view.text()).toContain("2 things need you · each opens its own session");
    await view.press(view.byLabel("Retry failed card charges, Approval · repo"));
    expect(went).toEqual([`session:${OTHER_AGENT}`]);
    await view.press(view.byLabel("Open in Maestro"));
    expect(went.at(-1)).toBe("maestro");
  });

  it("with nothing held it says so, and names the landing it came with as finished, never counted", async () => {
    sim.items = [asking({ permission: null, title: "The inventory checker landed" })];
    const view = await mount(card(digest, null));
    expect(view.text()).toContain("Nothing needs you now");
    expect(view.byLabel("The inventory checker landed, Finished · BRO-2917")).not.toBeNull();
  });

  it("a source that could not be read is named, never 'Nothing needs you now'", async () => {
    sim.items = [];
    sim.unread = ["asks"];
    const view = await mount(card(digest, null));
    await view.until(() => view.byId("card-unread") !== null);
    expect(view.byId("card-unread")?.textContent).toContain("Couldn't read what needs you (asks)");
    expect(view.text()).not.toContain("Nothing needs you");
  });

  it("holds listed with a source unread: the digest lists them and says more may need you", async () => {
    sim.items = [asking()];
    sim.unread = ["reviews"];
    const view = await mount(card(digest, null));
    await view.until(() => view.byId("card-unread") !== null);
    expect(view.text()).toContain("1 thing needs you");
    expect(view.byId("card-unread")?.textContent).toContain("Couldn't read reviews: more may need you.");
  });

  it("a needs.list that failed is not 'Nothing needs you now'", async () => {
    sim.items = [asking()];
    sim.needsFail = "socket closed";
    const view = await mount(card(digest, null));
    await view.until(() => view.byId("card-unread") !== null);
    expect(view.text()).toContain("Couldn't read what needs you: socket closed");
    expect(view.text()).not.toContain("Nothing needs you");
  });
});

// ── Open in Maestro → K2 ─────────────────────────────────────────────────────

describe("Open in Maestro", () => {
  it("on a card in a session opens that session's page (K2) with its agent id", async () => {
    sim.items = [asking()];
    const view = await mount(card(approvalCard));
    await view.press(view.byLabel("Open in Maestro"));
    expect(went).toEqual([`session:${AGENT}`]);
    // The agent id, not the work id and not the permission request.
    expect(went[0]).not.toContain(WORK);
    expect(went[0]).not.toContain(REQUEST);
  });

  it("the page's title in Paseo's header names the session", async () => {
    expect(sessionTitle({ agentId: AGENT })).toBe("Maestro · 6f1c2e0a");
    expect(sessionTitle(undefined)).toBe("Maestro · session");
  });
});

// ── K2: the session page ─────────────────────────────────────────────────────

describe("the session page (K2)", () => {
  const screen = (agentId: string | undefined, compact = false) => (
    <SessionScreen
      theme={theme}
      host={{ id: "h", label: "h" } as never}
      layout={{ compact, platform: "web" } as never}
      params={agentId ? { agentId } : {}}
      navigation={
        {
          openAgent: ({ agentId: id }: { agentId: string }) => void went.push(`chat:${id}`),
          openWorkspace() {},
        } as never
      }
      actions={actions}
    />
  );

  it("shows the work, its holds as the same card as in the chat, its history, and its controls", async () => {
    sim.items = [asking()];
    sim.events = [
      { ts: "2026-10-12T15:12:00.000Z", type: "turn", actor: "agent", text: "Checks 7/7 · P20 8·9·8", detail: null },
      {
        ts: "2026-10-12T12:58:00.000Z",
        type: "dispatched",
        actor: "human",
        text: "Started by the Broomva lane",
        detail: null,
      },
    ];
    const view = await mount(screen(AGENT));
    await view.until(() => view.text().includes("Harden the ask ledger") && view.byLabel("Allow") !== null);
    const text = view.text();
    expect(text).toContain("Holds on this session · the same card as in the chat");
    expect(text).toContain(ACTION);
    expect(text).toContain("BRO-2917");
    expect(text).toContain("Checks 7/7 · P20 8·9·8");
    expect(text).toContain("Started by the Broomva lane");
    expect(view.byLabel("Open the chat")).not.toBeNull();
    expect(view.byLabel("Send this session a prompt")).not.toBeNull();
    // The card on this page is the one in the chat: Allow here is the same decision.
    await view.press(view.byLabel("Allow"));
    expect(sent("approval.decide")).toHaveLength(1);
  });

  it("Open the chat goes to the session in Paseo; a prompt goes through session.prompt with its window", async () => {
    sim.items = [asking({ permission: null })];
    const view = await mount(screen(AGENT));
    await view.until(() => view.text().includes("Harden the ask ledger"));
    await view.press(view.byLabel("Open the chat"));
    expect(went).toEqual([`chat:${AGENT}`]);
    await view.type(view.byLabel("Send this session a prompt"), "Run the tests again");
    await view.press(view.byLabel("Send the prompt"));
    expect(sent("session.prompt")).toEqual([{ agentId: AGENT, prompt: "Run the tests again", key: `work:${WORK}` }]);
    await view.until(() => view.text().includes("takes effect in"));
  });

  it("Stop and Cancel the work are the adapter's verbs, each with its 8 s undo and a receipt on this page", async () => {
    sim.items = [asking({ permission: null, state: "running" })];
    const view = await mount(screen(AGENT));
    await view.until(() => view.byLabel("Stop") !== null);
    await view.press(view.byLabel("Stop"));
    expect(sent("work.stop")).toEqual([{ id: WORK }]);
    await view.until(() => view.text().includes("Stopped the run"));
    await view.until(() => view.text().includes("takes effect in"));
    // It cannot be stopped again while a decision on it waits (the server refuses a second): the page says so.
    settle("r-1", () => {
      sim.items = [asking({ permission: null, state: "blocked", reason: "Stopped by you" })];
    });
    await view.refetch();
    await view.until(() => view.text().includes("Stopped the run · took effect"));
    expect(view.text()).toContain("Stop and cancel keep an 8 s undo and leave a receipt here.");
  });

  it("a session with no holds says nothing holds on it; one whose read failed says it could not read", async () => {
    sim.items = [asking({ permission: null })];
    const view = await mount(screen(AGENT));
    await view.until(() => view.byId("session-no-holds") !== null);
    sim.needsFail = "daemon unreachable";
    await view.refetch();
    await view.until(() => view.byId("session-holds-unread") !== null);
    expect(view.byId("session-holds-unread")?.textContent).toContain("Couldn't read what holds this session");
    expect(view.byId("session-no-holds")).toBeNull();
  });

  it("a source that could not be read is not 'nothing holds': it says what it could not read", async () => {
    sim.items = [asking({ permission: null })];
    sim.unread = ["work", "asks"];
    const view = await mount(screen(AGENT));
    await view.until(() => view.byId("session-holds-unread") !== null);
    expect(view.byId("session-holds-unread")?.textContent).toContain("work, asks could not be read");
    expect(view.byId("session-no-holds")).toBeNull();
  });

  it("with holds listed and a source unread, the holds show and the page says more may hold", async () => {
    sim.items = [asking()];
    sim.unread = ["asks"];
    const view = await mount(screen(AGENT));
    await view.until(() => view.byLabel("Allow") !== null);
    expect(view.byId("session-holds-unread")?.textContent).toContain(
      "Couldn't read asks: more may hold on this session",
    );
  });

  it("a work read that failed is not 'Maestro keeps no work': it says it could not read, and offers nothing to track", async () => {
    sim.items = [asking({ permission: null })];
    sim.agentWorkFail = "daemon busy";
    const view = await mount(screen(AGENT));
    await view.until(() => view.byId("session-work-unread") !== null);
    expect(view.byId("session-work-unread")?.textContent).toContain("Couldn't read this session's work: daemon busy");
    expect(view.text()).not.toContain("Maestro keeps no work");
    expect(view.byLabel("Track as work")).toBeNull();
    expect(view.text()).toContain("Couldn't read its work");
    sim.agentWorkFail = null;
    await view.press(view.byLabel("Try again"));
    await view.until(() => view.byId("session-work-unread") === null);
  });

  it("a session Maestro does not track still opens, shows its holds and offers to track it", async () => {
    sim.items = [];
    sim.approvals = [
      {
        id: "e4a1c0",
        at: "2026-10-12T09:00:00.000Z",
        agentId: OTHER_AGENT,
        action: "git push origin main",
        heldBy: "gate",
        title: "Push main",
        scope: "broomva",
        evidence: [],
        after: [],
      },
    ];
    const view = await mount(screen(OTHER_AGENT));
    await view.until(() => view.byLabel("Allow push") !== null);
    expect(view.text()).toContain("Not tracked as work");
    expect(view.byLabel("Track as work")).not.toBeNull();
    await view.press(view.byLabel("Track as work"));
    expect(sent("work.adopt")).toEqual([{ agentId: OTHER_AGENT, title: "" }]);
  });

  it("with no agent id it says no session was named, never a blank page", async () => {
    const view = await mount(screen(undefined));
    expect(view.text()).toContain("No session was named");
  });

  it("on a phone it is one column in the same order", async () => {
    sim.items = [asking()];
    const view = await mount(screen(AGENT, true));
    await view.until(() => view.byLabel("Allow") !== null);
    expect(view.text().indexOf("Holds on this session")).toBeLessThan(view.text().indexOf("Controls"));
    expect(view.text().indexOf("Controls")).toBeLessThan(view.text().indexOf("History"));
  });
});
