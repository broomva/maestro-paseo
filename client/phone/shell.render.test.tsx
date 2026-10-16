// Render tests for the phone's M1 shape (BRO-3037): the real PhoneSurface, mounted with react-dom through
// react-native-web in a happy-dom window at the iPhone's 375 x 812, over RPC fixtures built by the server's own
// projections (needsOf, noticesOf, answersStatus), so ids have the shapes production has: a Paseo agent id, a work
// id, a ledger uid and an ask's hold key are four different things. The setup mirrors client/kit/kit.render.test.tsx
// (globals first, react-native as react-native-web, the host's kit as plain parts, everything else imported
// dynamically, both mocks put back in afterAll). Reduced motion answers "reduce", so springs land at once and a
// position can be read straight after a press.

import { afterAll, afterEach, beforeEach, describe, expect, mock, setDefaultTimeout, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import type { WorkItem } from "../../shared/contracts";
import type { DecisionAsk } from "../../shared/fleet";
import type { Initiative } from "../../shared/initiatives";

setDefaultTimeout(60_000);

const win = new Window({ url: "http://localhost/" });
Object.assign(win, {
  matchMedia: (query: string) => ({
    media: query,
    matches: query.includes("reduce"),
    addEventListener() {},
    removeEventListener() {},
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
    error: (message: string) => void toasts.push(message),
  }),
  useRevealedText: (text: string) => text,
}));

// Settings' own controls are the host's: the settings card draws them, a test only needs them to be there.
mock.module("@getpaseo/plugin/client/ui", () => {
  const part = ({ label }: { label?: string }) => <web.Text>{label ?? ""}</web.Text>;
  return {
    SettingsAction: part,
    SettingsCard: ({ children }: { children?: ReactNode }) => children,
    SettingsInput: part,
    SettingsSection: ({ children }: { children?: ReactNode }) => children,
    SettingsSelect: part,
    SettingsSwitch: part,
  };
});

const { act } = await import("react");
const { createRoot } = require("react-dom/client") as {
  createRoot(container: unknown): { render(node: ReactNode): void; unmount(): void };
};
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { PluginRpcProvider } = await import("@getpaseo/plugin/client/host");
const { needsOf } = await import("../../server/needs");
const { askHoldKey } = await import("../../shared/needs");
const { noticesOf } = await import("../../server/notices");
const { answersStatus } = await import("../../server/answers-status");
const { fakeWork } = await import("../fake-work");
const { GALLERY_LIGHT } = await import("../kit/gallery-data");
const { PhoneSurface } = await import("./shell");
const { CONFIRM_MS } = await import("./model");
const { NEEDS_KEY } = await import("../hooks");
type PhoneTab = import("./model").PhoneTab;
type PhonePage = import("./model").PhonePage;
type HomeFocus = import("../home").HomeFocus;

const FRAME = { width: 375, height: 812 };
const theme = GALLERY_LIGHT;
const settle = (ms = 30) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

// ── Fixtures, in the id spaces production has ───────────────────────────────

const AGENT_GATE = "d3c2a1b0-7a54-4e0f-9b1e-5f6a7b8c9d01";
const AGENT_RUN = "b7e1c9aa-1d2e-4f3a-8b4c-5d6e7f8a9b0c";
const AGENT_FIN = "e1a2b3c4-5d6e-4f7a-8b9c-0d1e2f3a4b5c";
const main = { kind: "main" as const, path: "/Users/me/broomva", branch: null };

const ask = (id: string, extra: Partial<DecisionAsk> = {}): DecisionAsk => ({
  ledger: "claude-code-mods.yaml",
  uid: `u-${id.toLowerCase()}-7f3e91`,
  id,
  hash: "0123456789abcdef",
  arc: null,
  headline: `Install the three headless mods ${id}?`,
  question: null,
  stakes: "The P2 gate stays paused.",
  whyYou: "A mod that answers tool.call runs before the deny rules.",
  options: [
    { id: "off", label: "Keep them off", consequence: "nothing changes", reversible: true, recommended: true },
    { id: "all", label: "Install fleet-wide", consequence: "every session", reversible: false, recommended: false },
  ],
  fallback: null,
  blocking: true,
  askedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  answeredAt: null,
  answer: null,
  answerOption: null,
  allowOther: true,
  state: "open",
  origin: null,
  refusal: null,
  home: main,
  batched: false,
  waiting: true,
  ...extra,
});

const reviewOf = (id: string): Initiative =>
  ({
    id,
    file: `${id}.yaml`,
    title: id,
    quote: null,
    summary: "agentic multimedia workspace",
    nextAction: null,
    driver: null,
    waitingOn: [],
    sessions: [],
    stale: { kind: "overdue", date: "2026-10-08" },
  }) as unknown as Initiative;

/** An initiative as initiatives.list returns it: the review's stale date and the file's own fields. */
const initiativeFile = (review: Initiative): Initiative => ({
  ...review,
  home: main,
  error: null,
  intentSource: null,
  status: "active",
  stated: null,
  reviewBy: "2026-10-08",
  wake: null,
  linear: [],
  prs: [],
  repos: [],
  asks: [],
  exit: null,
  closedAt: null,
  outcome: null,
  local: [],
  ideas: { open: 0, triaged: 0 },
});

type Pending = {
  receipt: string;
  verb: string;
  key: string;
  label: string;
  at: string;
  appliesAt: string;
  remainingMs: number;
};
let items: WorkItem[] = [];
let asks: DecisionAsk[] = [];
let reviews: Initiative[] = [];
let needsFail: string | null = null;
let decideFail: string | null = null;
let unreadNow: string[] | undefined;
/** While set, work.list reports the gate item's session on this prompt: the card was read on another. */
let workListPrompt: string | null = null;
/** While set, needs.list answers only once it resolves: a read still on its way. */
let needsHeld: Promise<void> | null = null;
let pending: Pending[] = [];
let unblockFail: string | null = null;
let noticesFail: string | null = null;
let askWarnings: string[] = [];
let asksFail: string | null = null;
let settingsReadsFail = false;
let noticesUnread: string[] = [];
let workListFail: string | null = null;
let initiativesFail: string | null = null;
const calls: { method: string; input: unknown }[] = [];

function reset() {
  items = [
    fakeWork(
      "w-gate-9a1",
      "review",
      { agentId: AGENT_GATE, workspaceId: "ws1" },
      { project: "broomva", ticket: "BRO-933", title: "Merge workspace 933" },
    ),
    fakeWork(
      "w-run-1f2",
      "running",
      { agentId: AGENT_RUN, workspaceId: "ws1" },
      { project: "sri", ticket: "STI-3684", phase: "working", title: "Provable Outlook reads" },
    ),
    fakeWork(
      "w-run-2e8",
      "running",
      { agentId: "c8f2daab-2e3f-4a4b-9c5d-6e7f8a9b0c1d", workspaceId: "ws1" },
      { project: "sri", ticket: "STI-3680", title: "Composer drops sends" },
    ),
    fakeWork(
      "w-fin-4c7",
      "review",
      { agentId: AGENT_FIN, workspaceId: "ws1" },
      { project: "holon", title: "GitHub identity: PR 12 merged", permission: null },
    ),
    fakeWork(
      "w-stuck-3c4",
      "blocked",
      { agentId: "f9a0b1c2-3d4e-4f5a-8b6c-7d8e9f0a1b2c", workspaceId: "ws1" },
      { project: "sri", ticket: "STI-3593", title: "Credits ledger: ended mid-turn" },
    ),
    fakeWork("w-queued-5d7", "proposed", null, { project: "broomva", title: "Close leftover fleet items" }),
  ];
  asks = [
    ask("A1"),
    ask("A2", {
      ledger: "canvas.yaml",
      headline: "Name the canvas now?",
      options: [{ id: "now", label: "Name it now", consequence: null, reversible: true, recommended: true }],
    }),
  ];
  reviews = [reviewOf("skene")];
  needsFail = null;
  decideFail = null;
  unreadNow = undefined;
  workListPrompt = null;
  needsHeld = null;
  pending = [];
  unblockFail = null;
  noticesFail = null;
  askWarnings = [];
  asksFail = null;
  settingsReadsFail = false;
  noticesUnread = [];
  workListFail = null;
  initiativesFail = null;
  calls.length = 0;
  toasts.length = 0;
}
const needsNow = () => needsOf({ items, asks, reviews, landing: null, workspace: "broomva" }, Date.now());

const ledgerEntry = (method: string, key: string, label: string): Pending => ({
  receipt: `r-${pending.length + 1}`,
  verb: method,
  key,
  label,
  at: new Date().toISOString(),
  appliesAt: new Date(Date.now() + 8_000).toISOString(),
  remainingMs: 8_000,
});

const withUnread = <T extends { summary: { unread: string[] } }>(notices: T): T => ({
  ...notices,
  summary: { ...notices.summary, unread: noticesUnread },
});

const invoke = async (method: string, input: unknown) => {
  calls.push({ method, input });
  switch (method) {
    case "needs.list":
      if (needsHeld) await needsHeld;
      if (needsFail) throw new Error(needsFail);
      return unreadNow ? { ...needsNow(), unread: unreadNow } : needsNow();
    case "work.list":
      if (workListFail) throw new Error(workListFail);
      return {
        root: "/work",
        items: workListPrompt
          ? items.map((item) =>
              item.permission
                ? { ...item, permission: { ...item.permission, requestId: workListPrompt as string } }
                : item,
            )
          : items,
        warnings: [],
        scoreboard: {
          unsupervisedMs: 0,
          looks: 0,
          longestRunMs: 0,
          live: false,
          segments: [],
          notches: [],
          week: [],
          weekByInitiative: [],
        },
      };
    case "handled.list":
      return { rows: [], today: { closedForYou: 22, byYou: 4, asksAnswered: 3 } };
    case "notices.list":
      if (noticesFail) throw new Error(noticesFail);
      return withUnread(
        noticesOf(
          { items, fleet: [], timeline: [], loops: [], reviews: [], snoozed: new Map<string, string>() },
          Date.now(),
        ),
      );
    case "asks.workspace":
      if (asksFail) throw new Error(asksFail);
      return { controlRepo: "/Users/me/broomva", main: null, decisions: asks, fleet: [], warnings: askWarnings };
    case "answers.status":
      return answersStatus(asks, null);
    case "verbs.list":
      return { pending, recent: [] };
    case "approval.decide": {
      if (decideFail) throw new Error(decideFail);
      const { key, action } = input as { key: string; action: string };
      const entry = ledgerEntry(method, key, `Allowed ${action}`);
      pending = [entry, ...pending];
      return { receipt: entry.receipt, appliesAt: entry.appliesAt };
    }
    case "ask.answer": {
      const entry = ledgerEntry(method, "ask", "Answered");
      pending = [entry, ...pending];
      return { ask: asks[0], warning: null, receipt: entry.receipt, appliesAt: entry.appliesAt };
    }
    case "fleet.get":
    case "loops.get":
    case "config.get":
      if (settingsReadsFail) throw new Error("daemon down");
  }
  switch (method) {
    case "fleet.get":
      return { scopes: [], detail: null, error: null };
    case "loops.get":
      return { now: new Date().toISOString(), ledger: null, rows: [], ledgerErrors: [], warnings: [] };
    case "loop.get":
      return { minutes: 15, nextAt: null, ticking: false, recent: [] };
    case "config.get":
      return {
        workRoot: "/work",
        provider: "claude/opus",
        modeId: null,
        isolation: "worktree",
        concurrencyCap: null,
        archiveOnApprove: false,
        defaultGate: "human",
        loopMinutes: 15,
      };
    case "work.unblock": {
      if (unblockFail) throw new Error(unblockFail);
      const { id } = input as { id: string };
      const entry = ledgerEntry(method, `work:${id}`, "Unblocked");
      pending = [entry, ...pending];
      return { item: items.find((one) => one.id === id), receipt: entry.receipt, appliesAt: entry.appliesAt };
    }
    case "notice.snooze": {
      const { key } = input as { key: string };
      const entry = ledgerEntry(method, key, "Snoozed 4h");
      pending = [entry, ...pending];
      return { receipt: entry.receipt, appliesAt: entry.appliesAt };
    }
    case "initiatives.list":
      if (initiativesFail) throw new Error(initiativesFail);
      return {
        controlRepo: "/Users/me/broomva",
        today: "2026-10-10",
        initiatives: reviews.map(initiativeFile),
        ideas: [],
        warnings: [],
      };
    case "initiatives.review": {
      const entry = ledgerEntry(method, `review:${(input as { id: string }).id}`, "Kept driving");
      pending = [entry, ...pending];
      return { receipt: entry.receipt, appliesAt: entry.appliesAt };
    }
    case "verb.undo":
      pending = pending.filter((verb) => verb.receipt !== (input as { receipt: string }).receipt);
      return { undone: true };
    default:
      throw new Error(`unexpected RPC ${method}`);
  }
};

// A failed assertion on a DOM element prints the element and everything it holds, which took a runner past 5 GB:
// these tests assert on whether an element is there, never on the element itself.

// ── The harness ──────────────────────────────────────────────────────────────

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
const mounted: (() => void)[] = [];

async function mount(
  props: {
    tab?: PhoneTab;
    focus?: HomeFocus | null;
    cached?: ReturnType<typeof needsNow>;
    page?: PhonePage | null;
    creating?: boolean;
  } = {},
) {
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // A read left in the cache by an earlier visit: it may be old, and says nothing about the hold until read again.
  if (props.cached) client.setQueryData(NEEDS_KEY, props.cached);
  let tab: PhoneTab = props.tab ?? "feed";
  let page: PhonePage | null = props.page ?? null;
  let creating = props.creating ?? false;
  const handled: number[] = [];
  const pages: (PhonePage | null)[] = [];
  const node = () => (
    <QueryClientProvider client={client}>
      <PluginRpcProvider invoke={invoke}>
        <PhoneSurface
          theme={theme}
          layout={{ compact: true, platform: "ios" }}
          tab={tab}
          onTab={(next) => {
            tab = next;
            void act(() => root.render(node()));
          }}
          workspace={null}
          onWorkspace={() => undefined}
          focus={props.focus ?? null}
          onFocusHandled={() => void handled.push(1)}
          creating={creating}
          onCreating={(next) => {
            creating = next;
            void act(() => root.render(node()));
          }}
          onOpenWork={() => undefined}
          page={page}
          onPage={(next) => {
            page = next;
            pages.push(next);
            void act(() => root.render(node()));
          }}
          onOpenDecision={() => undefined}
          frame={FRAME}
        />
      </PluginRpcProvider>
    </QueryClientProvider>
  );
  await act(async () => root.render(node()));
  for (let at = 0; at < 4; at += 1) await settle();
  mounted.push(() => {
    act(() => root.unmount());
    client.clear();
    container.remove();
  });
  const box = container as unknown as El;
  const all = (selector: string) => [...(box.querySelectorAll(selector) as unknown as El[])];
  return {
    handled,
    pages,
    text: () => box.textContent ?? "",
    all,
    id: (testID: string) => box.querySelector(`[data-testid="${testID}"]`),
    label: (name: string) => box.querySelector(`[aria-label="${name}"]`),
    labelled: (prefix: string) => all(`[aria-label^="${prefix}"]`),
    press: async (target: El | null | undefined) => {
      if (!target) throw new Error("nothing to press");
      await act(async () => target.click());
      await settle(60);
    },
  };
}

const sent = (method: string) => calls.filter((call) => call.method === method).map((call) => call.input);
const translateY = (el: El | null) => {
  const match = /translateY\((-?[\d.]+)px\)/.exec(el?.getAttribute("style") ?? "");
  return match ? Number(match[1]) : null;
};

const consoleError = spyOn(console, "error").mockImplementation(() => {});
beforeEach(reset);
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
  mock.module("@getpaseo/plugin/client/ui", () => ({}));
  for (const key of added) delete (globalThis as Record<string, unknown>)[key];
  await win.happyDOM.close();
});

// ── M1: the Feed ─────────────────────────────────────────────────────────────

describe("M1, the Feed at 375 x 812", () => {
  test("a deck of every hold, the tab bar riding the sheet, and the counts the desktop shows", async () => {
    const view = await mount();
    const needs = needsNow();
    expect(needs.summary.total).toBe(4);
    expect(view.text()).toContain("Needs you");
    expect(view.text()).toContain(`1 of ${needs.summary.total}`);
    expect(view.text()).toContain(needs.rows[0]?.title ?? "missing");
    const bar = view.id("tab-bar");
    expect(bar?.getAttribute("role")).toBe("tablist");
    expect(view.id("pull-sheet-rider")?.contains(bar as El)).toBe(true);
    const tabs = view.all('[role="tab"]').map((tab) => tab.getAttribute("aria-label"));
    // BRO-3001: Feed is needs.list's total, Decisions the holds it lists, Health notices.list's rows.
    const notices = noticesOf(
      { items, fleet: [], timeline: [], loops: [], reviews: [], snoozed: new Map<string, string>() },
      Date.now(),
    );
    expect(tabs).toEqual([`Feed, ${needs.summary.total}`, "Decisions, 2", "Work", `Health, ${notices.summary.total}`]);
    expect(view.label("New work") !== null).toBe(true);
  });

  test("the sheet peeks with its counts, and pulling it up carries the tab bar with it", async () => {
    const view = await mount();
    expect(view.text()).toContain("Everything else");
    expect(view.text()).toContain("2 running");
    expect(view.text()).toContain("1 finished");
    expect(view.text()).toContain("22 handled");
    expect(translateY(view.id("pull-sheet-rider"))).toBe(FRAME.height - 104 - 72);
    await view.press(view.label("Raise the sheet"));
    expect(translateY(view.id("pull-sheet-rider"))).toBe(12);
    expect(view.id("sheet-group-running")?.textContent).toContain("Provable Outlook reads");
    expect(view.id("sheet-group-queued")?.textContent).toContain("Close leftover fleet items");
    expect(view.id("sheet-group-finished")?.textContent).toContain("GitHub identity: PR 12 merged");
    expect(view.id("sheet-group-health")?.textContent).toContain("Credits ledger");
    // A hold is a deliberate tap on the deck: it is never a sheet row.
    expect(view.id("sheet-group-running")?.textContent).not.toContain("Merge workspace 933");
  });

  test("a failed read says so: never 'nothing needs you', and Try again reads it again", async () => {
    needsFail = "daemon down";
    const view = await mount();
    expect(view.text()).toContain("Couldn't read what needs you.");
    expect(view.text()).not.toContain("Nothing needs you.");
    expect(view.text()).toContain("daemon down");
    needsFail = null;
    await view.press(view.label("Try again"));
    for (let at = 0; at < 3; at += 1) await settle();
    expect(view.text()).toContain("1 of 4");
    expect(view.text()).not.toContain("Couldn't read what needs you.");
  });

  test("a source needs.list could not read is named over the deck, never hidden (BRO-3008)", async () => {
    unreadNow = ["asks"];
    const view = await mount();
    expect(view.id("unread-sources")?.textContent).toBe("Couldn't read asks: what needs you may be missing holds.");
    // What it did read is still there to act on.
    expect(view.text()).toContain("1 of 4");
  });

  test("an empty deck over an unread source says it could not read, not that nothing needs you", async () => {
    items = items.filter((item) => item.state !== "review" && item.state !== "blocked");
    asks = [];
    reviews = [];
    unreadNow = ["work"];
    const view = await mount();
    expect(view.text()).toContain("Couldn't read what needs you (work).");
    expect(view.text()).not.toContain("Nothing needs you.");
  });

  test("a hold that is missing because its source was unread is not said to be answered", async () => {
    unreadNow = ["work"];
    const view = await mount({ focus: { hold: "work:w-long-gone-0000", at: 1, from: "push" } });
    for (let at = 0; at < 3; at += 1) await settle();
    expect(view.text()).not.toContain("That hold is no longer waiting on you");
    expect(view.text()).toContain("Couldn't read work");
  });

  test("with nothing held, it says nothing needs you, once the read said so", async () => {
    items = items.filter((item) => item.state !== "review" && item.state !== "blocked");
    asks = [];
    reviews = [];
    const view = await mount();
    expect(view.text()).toContain("Nothing needs you.");
    expect(view.text()).not.toContain("Couldn't read");
  });
});

// ── M2–M4: a hold on the deck and the card that rises ───────────────────────

describe("acting on a hold", () => {
  test("Allow sends one approval.decide with the exact action and prompt the card showed, then the deck moves on", async () => {
    const view = await mount();
    expect(needsNow().rows[0]?.key).toBe("work:w-gate-9a1");
    await view.press(view.labelled("Allow")[0]);
    expect(sent("approval.decide")).toEqual([
      { key: "work:w-gate-9a1", allow: true, action: "Run a command: git push", requestId: "req-w-gate-9a1" },
    ]);
    expect(view.id("undo-toast")?.textContent).toMatch(/Allowed.*applies in [78] s/);
    expect(view.text()).toContain("2 of 4");
    await view.press(view.labelled("Undo: ")[0]);
    expect(sent("verb.undo")).toEqual([{ receipt: "r-1" }]);
  });

  test("a verb that failed leaves the deck on its hold, says why, and can be pressed again", async () => {
    decideFail = "the daemon refused it";
    const view = await mount();
    await view.press(view.labelled("Allow")[0]);
    expect(toasts.join(" ")).toContain("the daemon refused it");
    expect(view.text()).toContain("1 of 4");
    expect(view.id("undo-toast") === null).toBe(true);
    decideFail = null;
    await view.press(view.labelled("Allow")[0]);
    expect(sent("approval.decide")).toHaveLength(2);
    expect(view.text()).toContain("2 of 4");
  });

  test("a verb refused from the card leaves the card open and the deck on its hold", async () => {
    decideFail = "refused";
    const view = await mount();
    await view.press(view.all('[role="link"]')[0]);
    await view.press(view.id("inspector-card-bar")?.querySelector('[aria-label^="Allow"]') as El);
    expect(toasts.join(" ")).toContain("refused");
    expect(view.id("inspector-card") !== null).toBe(true);
    expect(view.id("detail-header")?.textContent).toContain("Approval · 1 of 4");
    expect(view.text()).not.toContain("2 of 4");
    decideFail = null;
    await view.press(view.id("inspector-card-bar")?.querySelector('[aria-label^="Allow"]') as El);
    expect(sent("approval.decide")).toHaveLength(2);
    expect(view.id("inspector-card") === null).toBe(true);
    expect(view.text()).toContain("2 of 4");
  });

  test("a prompt that changed since it was read sends nothing, and the deck stays on it", async () => {
    // needs.list read the card with one prompt, and work.list now has the session on another (client/verbs.ts decideApproval).
    workListPrompt = "req-a-newer-prompt";
    const view = await mount();
    await view.press(view.labelled("Allow")[0]);
    expect(sent("approval.decide")).toHaveLength(0);
    expect(toasts.join(" ")).toContain("That prompt changed");
    expect(view.text()).toContain("1 of 4");
    expect(view.id("undo-toast") === null).toBe(true);
  });

  test("two presses in a breath send one: a verb is never fired twice", async () => {
    const view = await mount();
    const allow = view.labelled("Allow")[0];
    await act(async () => {
      allow?.click();
      allow?.click();
    });
    await settle(60);
    expect(sent("approval.decide")).toHaveLength(1);
  });

  test("a hold waiting out its undo window says so, and its verbs cannot be pressed again", async () => {
    const view = await mount();
    await view.press(view.labelled("Allow")[0]);
    await view.press(view.label("Hold 1 of 4"));
    expect(view.text()).toMatch(/Allowed .* · applies in \d s/);
    const off = view.labelled("Allow").filter((el) => el.getAttribute("aria-disabled") === "true");
    expect(off.length).toBeGreaterThan(0);
    const before = sent("approval.decide").length;
    await view.press(off[0]);
    expect(sent("approval.decide")).toHaveLength(before);
  });

  test("Details raises the card: where you are, the same verbs, one act from either place", async () => {
    const view = await mount();
    await view.press(view.all('[role="link"]')[0]);
    expect(view.id("inspector-card") !== null).toBe(true);
    expect(view.id("detail-header")?.textContent).toContain("Approval · 1 of 4");
    expect(view.id("inspector-card-bar")?.textContent).toContain("Deny");
    await view.press(view.id("inspector-card-bar")?.querySelector('[aria-label^="Allow"]') as El);
    expect(sent("approval.decide")).toHaveLength(1);
  });

  test("the card's round chevron closes it, and so does switching tab", async () => {
    const view = await mount();
    await view.press(view.all('[role="link"]')[0]);
    expect(view.id("inspector-card") !== null).toBe(true);
    // The round button, not the review's option that is also called Close.
    await view.press(view.all('button[aria-label="Close"]')[0]);
    expect(view.id("inspector-card") === null).toBe(true);
    await view.press(view.all('[role="link"]')[0]);
    expect(view.id("inspector-card") !== null).toBe(true);
    await view.press(view.labelled("Decisions")[0]);
    expect(view.id("inspector-card") === null).toBe(true);
  });

  test("Deny… on the deck raises the card and sends nothing until Deny there", async () => {
    const view = await mount();
    await view.press(view.label("Deny…"));
    expect(sent("approval.decide")).toHaveLength(0);
    expect(view.id("inspector-card") !== null).toBe(true);
    await view.press(view.id("inspector-card-bar")?.querySelector('[aria-label="Deny…"]') as El);
    expect(sent("approval.decide")[0]).toMatchObject({ key: "work:w-gate-9a1", allow: false });
  });
});

// ── M5: Decisions ────────────────────────────────────────────────────────────

describe("M5, Decisions", () => {
  test("the deck holds the open asks that wait on you; its length is the tab's badge", async () => {
    const view = await mount({ tab: "decisions" });
    const decisions = needsNow().rows.filter((row) => row.key.startsWith("ask:"));
    expect(decisions).toHaveLength(2);
    expect(view.text()).toContain(`1 of ${decisions.length}`);
    expect(view.label(`Decisions, ${decisions.length}`) !== null).toBe(true);
    expect(view.text()).not.toContain("Merge workspace 933");
  });

  test("an answer carries the ids of the ask the deck drew, with the option chosen", async () => {
    const view = await mount({ tab: "decisions" });
    const first = needsNow().rows.find((row) => row.key.startsWith("ask:"));
    const drawn = asks.find((one) => one.headline === first?.title);
    expect(drawn).toBeDefined();
    await view.press(view.labelled(drawn?.options[0]?.label ?? "")[0]);
    await view.press(view.labelled("Answer")[0]);
    const answers = sent("ask.answer") as {
      ledger: string;
      uid: string | null;
      id: string;
      hash: string;
      option: string | null;
    }[];
    expect(answers).toHaveLength(1);
    // The deck's first card is the ask needs.list put first: its own ledger, uid, id and hash, never another's.
    expect(answers[0]).toMatchObject({ ledger: drawn?.ledger, uid: drawn?.uid, id: drawn?.id, hash: drawn?.hash });
    expect(view.id("undo-toast") !== null).toBe(true);
    expect(view.text()).toContain("2 of 2");
  });

  test("an option that cannot be undone asks twice: the first press arms, a deliberate second sends", async () => {
    asks = [ask("A1")];
    const view = await mount({ tab: "decisions" });
    await view.press(view.labelled("Install fleet-wide")[0]);
    await view.press(view.labelled("Answer")[0]);
    expect(sent("ask.answer")).toHaveLength(0);
    expect(view.text()).toContain("This cannot be undone. Press again to confirm.");
    // A second press in the same breath is not deliberate.
    await view.press(view.label("Confirm with Install fleet-wide"));
    expect(sent("ask.answer")).toHaveLength(0);
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, CONFIRM_MS + 50)));
    await view.press(view.label("Confirm with Install fleet-wide"));
    expect(sent("ask.answer")).toHaveLength(1);
    expect(sent("ask.answer")[0]).toMatchObject({ option: "all" });
  });

  test("choosing another option disarms the confirm", async () => {
    asks = [ask("A1")];
    const view = await mount({ tab: "decisions" });
    await view.press(view.labelled("Install fleet-wide")[0]);
    await view.press(view.labelled("Answer")[0]);
    await view.press(view.labelled("Keep them off")[0]);
    expect(view.text()).not.toContain("Press again to confirm");
    await view.press(view.labelled("Answer")[0]);
    expect(sent("ask.answer")[0]).toMatchObject({ option: "off" });
  });

  // BRO-3146: the owner could not add words beside an option on the phone. Now a note rides with the option,
  // and an Other row answers in your words when none fit.
  const type = async (view: Awaited<ReturnType<typeof mount>>, label: string, words: string) => {
    await act(async () => {
      const field = view.label(label) as unknown as { value: string; dispatchEvent(event: unknown): boolean };
      const setter = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(field, words);
      field.dispatchEvent(new win.Event("input", { bubbles: true }));
    });
    await settle(60);
  };

  test("a note beside the option you chose goes with it (BRO-3146)", async () => {
    asks = [ask("A1")];
    const view = await mount({ tab: "decisions" });
    await view.press(view.labelled("Keep them off")[0]);
    const title = asks[0]?.headline ?? "";
    expect(view.label(`A note on your answer for ${title} (optional)`) !== null).toBe(true);
    await type(view, `A note on your answer for ${title} (optional)`, "Until the launch.");
    await view.press(view.labelled("Answer")[0]);
    expect(sent("ask.answer")).toEqual([expect.objectContaining({ option: "off", note: "Until the launch." })]);
  });

  test("Other answers in your words: no option is sent, and Answer waits for the words (BRO-3146)", async () => {
    asks = [ask("A1")];
    const view = await mount({ tab: "decisions" });
    await view.press(view.labelled("Other…")[0]);
    const title = asks[0]?.headline ?? "";
    expect(view.label("Answer with Other…")?.getAttribute("aria-disabled")).toBe("true");
    await type(view, `Your words for ${title}`, "Only on my machine first.");
    await view.press(view.label("Answer with Other…"));
    expect(sent("ask.answer")).toEqual([expect.objectContaining({ option: null, note: "Only on my machine first." })]);
  });

  test("the rising card offers Other with a field to write it in, the deck card's words shown there (BRO-3146)", async () => {
    asks = [ask("A1")];
    const view = await mount({ tab: "decisions" });
    await view.press(view.all('[role="link"]')[0]);
    const card = view.id("inspector-card");
    expect(card !== null).toBe(true);
    await view.press(card?.querySelector('[aria-label="Other…"]') as El);
    const field = card?.querySelector("textarea") as unknown as {
      value: string;
      dispatchEvent(event: unknown): boolean;
    };
    expect(field).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(field, "Ask Legal first.");
      field.dispatchEvent(new win.Event("input", { bubbles: true }));
    });
    await settle(60);
    await view.press(view.id("inspector-card-bar")?.querySelector('[aria-label^="Answer"]') as El);
    expect(sent("ask.answer")).toEqual([expect.objectContaining({ option: null, note: "Ask Legal first." })]);
  });

  test("an ask that says allow_other: false offers no Other row (BRO-3146)", async () => {
    asks = [ask("A1", { allowOther: false })];
    const view = await mount({ tab: "decisions" });
    expect(view.labelled("Keep them off").length).toBeGreaterThan(0);
    expect(view.labelled("Other…")).toHaveLength(0);
  });

  test("an ask written with no options is answered in your own words, and Answer waits for them", async () => {
    asks = [ask("W1", { headline: "Rename this session?", options: [], fallback: "continue as is" })];
    const view = await mount({ tab: "decisions" });
    expect(view.text()).toContain("No options were written for this ask: answer it in your own words.");
    expect(view.label("Answer")?.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      const field = view.label("Your words for Rename this session?") as unknown as {
        value: string;
        dispatchEvent(event: unknown): boolean;
      };
      const setter = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(field, "Keep the name.");
      field.dispatchEvent(new win.Event("input", { bubbles: true }));
    });
    await settle(60);
    await view.press(view.label("Answer"));
    expect(sent("ask.answer")).toEqual([
      expect.objectContaining({
        ledger: "claude-code-mods.yaml",
        uid: "u-w1-7f3e91",
        id: "W1",
        option: null,
        note: "Keep the name.",
      }),
    ]);
  });

  test("the deck's verbs are 52 pt taps", async () => {
    const view = await mount({ tab: "decisions" });
    expect(view.labelled("Answer")[0]?.getAttribute("style")).toContain("height: 52px");
  });

  test("the sheet is where your answers went: the stranded loudest, then the rows", async () => {
    asks = [
      ask("A1"),
      ask("D1", {
        state: "answered",
        answerOption: "off",
        answer: "Keep them off",
        batched: true,
        headline: "Merge #933?",
      }),
    ];
    const view = await mount({ tab: "decisions" });
    expect(view.text()).toContain("Your answers");
    expect(view.text()).toContain("1 waiting to land");
    await view.press(view.label("Raise the sheet"));
    for (const word of ["Waiting to land", "Routed", "Acted on", "Held", "Where your last answers went"])
      expect(view.text()).toContain(word);
  });

  // BRO-3140 (deciding BRO-3113): every open ask is on the deck, the holds first, each card labelled. On the owner's
  // phone every open ask was an idea or blocked nothing, and the deck said "No decision waits on you" over 23 of them.
  describe("every open ask on the deck", () => {
    const quiet = (id: string, extra: Partial<DecisionAsk> = {}) =>
      ask(id, {
        blocking: false,
        waiting: false,
        ledger: "leadership-20261013.yaml",
        headline: `Quiet question ${id}?`,
        ...extra,
      });
    const idea = (id: string, extra: Partial<DecisionAsk> = {}) =>
      quiet(id, {
        ledger: "ideas-factory-learnings.yaml",
        headline: `Idea ${id}: develop, park or kill?`,
        options: [
          { id: "develop", label: "Develop", consequence: null, reversible: true, recommended: false },
          { id: "park", label: "Park until 2026-11-02", consequence: null, reversible: true, recommended: true },
          { id: "kill", label: "Kill", consequence: null, reversible: true, recommended: false },
        ],
        idea: { initiative: "factory-learnings", idea: `idea ${id}`, source: null, evidence: null, wake: "2026-11-02" },
        ...extra,
      });
    const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();

    test("the deck lists the holds, then every other open ask oldest first, each labelled, none twice", async () => {
      asks = [
        ask("A1"),
        quiet("Q2", { askedAt: hoursAgo(3) }),
        quiet("Q1", { askedAt: hoursAgo(9) }),
        idea("I1", { askedAt: hoursAgo(20) }),
        ask("D1", { state: "answered", answerOption: "off", answer: "Keep them off", headline: "Merge #933?" }),
      ];
      const view = await mount({ tab: "decisions" });
      // The tab's badge is still the holds needs.list lists (the desktop header's number); the deck carries all four.
      expect(needsNow().rows.filter((row) => row.key.startsWith("ask:"))).toHaveLength(1);
      expect(view.label("Decisions, 1") !== null).toBe(true);
      expect(view.text()).toContain("1 of 4");
      expect(view.text()).toContain("4 open · 1 waits on you · 1 idea");
      expect(view.text()).toContain("Waits on you");
      expect(view.labelled("Merge #933?")).toHaveLength(0);
    });

    test("only ideas open (the owner's live case): the deck lists them, never 'No decision waits on you'", async () => {
      asks = [idea("I1", { askedAt: hoursAgo(30) }), idea("I2", { askedAt: hoursAgo(10) })];
      const view = await mount({ tab: "decisions" });
      expect(view.text()).not.toContain("No decision waits on you");
      expect(view.text()).not.toContain("nothing waits on you.");
      expect(view.text()).toContain("2 open · none waits on you · 2 ideas");
      expect(view.text()).toContain("1 of 2");
      expect(view.text()).toContain("Idea I1: develop, park or kill?");
      expect(view.text()).toContain("Idea");
    });

    test("an idea is answered park from its card on the deck: that ask's ids, the option, and the undo", async () => {
      asks = [idea("I1")];
      const view = await mount({ tab: "decisions" });
      await view.press(view.labelled("Park until 2026-11-02")[0]);
      await view.press(view.labelled("Answer")[0]);
      expect(sent("ask.answer")).toEqual([
        expect.objectContaining({
          ledger: "ideas-factory-learnings.yaml",
          uid: asks[0]?.uid,
          id: "I1",
          hash: asks[0]?.hash,
          option: "park",
          // The wake Initiatives' park sends: the idea's own date, while it is still ahead.
          wake: "2026-11-02",
        }),
      ]);
      expect(view.id("undo-toast") !== null).toBe(true);
    });

    test("an idea whose wake has passed is parked for 30 days, as Initiatives parks it", async () => {
      asks = [
        idea("I1", {
          idea: { initiative: "factory-learnings", idea: "x", source: null, evidence: null, wake: "2020-01-01" },
        }),
      ];
      const view = await mount({ tab: "decisions" });
      await view.press(view.labelled("Park until 2026-11-02")[0]);
      await view.press(view.labelled("Answer")[0]);
      const [sentAnswer] = sent("ask.answer") as { wake?: string }[];
      // 30 calendar days on, as defaultWake counts them (never 30 × 24 h, which a DST change would skew).
      const today = new Date();
      const at = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 30);
      const two = (n: number) => String(n).padStart(2, "0");
      expect(sentAnswer?.wake).toBe(`${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`);
    });

    test("a quiet ask's details open its card, and Answer there sends that ask's ids", async () => {
      asks = [quiet("Q1")];
      const view = await mount({ tab: "decisions" });
      await view.press(
        view.all("[role='link']").find((el) => el.textContent?.includes("Details, session and history")),
      );
      expect(view.id("inspector-card") !== null).toBe(true);
      await view.press(view.id("inspector-card-bar")?.querySelector('[aria-label^="Answer"]') as El);
      expect(sent("ask.answer")).toEqual([
        expect.objectContaining({ ledger: "leadership-20261013.yaml", id: "Q1", hash: asks[0]?.hash, option: "off" }),
      ]);
    });

    test("an ask that cannot be answered here says why and offers no Answer, on the deck and its card (BRO-3111)", async () => {
      asks = [quiet("R1", { refusal: "Two asks in leadership-20261013.yaml are named R1 and neither has a uid." })];
      const view = await mount({ tab: "decisions" });
      expect(view.text()).toContain("This ask cannot be answered here. Two asks in leadership-20261013.yaml");
      expect(view.labelled("Answer")).toHaveLength(0);
      // Only Answer goes: the card's other verb is still there to press.
      expect(view.labelled("Skip").length > 0).toBe(true);
      expect(view.labelled("Skip")[0]?.getAttribute("aria-disabled") === "true").toBe(false);
      await view.press(
        view.all("[role='link']").find((el) => el.textContent?.includes("Details, session and history")),
      );
      expect(view.id("inspector-card-bar")?.querySelector('[aria-label^="Answer"]') == null).toBe(true);
      expect(sent("ask.answer")).toHaveLength(0);
    });

    test("a ledger that could not be read is said over the deck, with its words", async () => {
      asks = [quiet("Q1")];
      askWarnings = [
        "The ask ledger sri-coordinator-20261013.yaml could not be read: Map keys must be unique",
        "The ask ledger dogfood-20261013-2245-launch.yaml could not be read: Map keys must be unique",
      ];
      const view = await mount({ tab: "decisions" });
      expect(view.text()).toContain("2 read warnings: some asks may be missing.");
      expect(view.text()).toContain("sri-coordinator-20261013.yaml could not be read: Map keys must be unique");
    });

    test("with every ledger read there is no warning", async () => {
      asks = [ask("A1")];
      const view = await mount({ tab: "decisions" });
      expect(view.text()).not.toContain("could not be read");
    });

    test("needs.list failing with open ideas on the deck is said, and no count claims none waits", async () => {
      asks = [idea("I1")];
      needsFail = "needs are down";
      const view = await mount({ tab: "decisions" });
      expect(view.text()).toContain("Idea I1: develop, park or kill?");
      expect(view.text()).toContain("Couldn't read what needs you (needs are down)");
      expect(view.text()).not.toContain("none waits on you");
    });

    test("an asks read that failed says so: never 'no decision waits'", async () => {
      asksFail = "asks are down";
      asks = [];
      const view = await mount({ tab: "decisions" });
      expect(view.text()).not.toContain("nothing waits on you");
      expect(view.text()).toContain("Couldn't read the open asks.");
    });
  });
});

// ── M10: opening on a hold ───────────────────────────────────────────────────

describe("M10, opening on the same hold from a push", () => {
  test("params.hold opens the deck on that hold and says it came from the push", async () => {
    const rows = needsNow().rows;
    const second = rows.filter((row) => row.key.startsWith("ask:"))[1];
    expect(second?.key).toMatch(/^ask:\[/);
    const view = await mount({ focus: { hold: second?.key, at: 1, from: "push" } });
    for (let at = 0; at < 3; at += 1) await settle();
    expect(view.id("from-the-push")?.textContent).toBe("From the push · same hold");
    expect(view.text()).toContain(`${rows.findIndex((row) => row.key === second?.key) + 1} of ${rows.length}`);
    expect(view.handled).toHaveLength(1);
  });

  test("a push whose hold is now an open ask that does not wait opens it on the Decisions deck, not 'gone'", async () => {
    // Pushed while it waited; it has stopped waiting since, so needs.list no longer holds it (BRO-3140).
    asks = [ask("A1", { blocking: false, waiting: false, headline: "Quiet now A1?" })];
    const key = askHoldKey(asks[0] as DecisionAsk);
    expect(needsNow().rows.some((row) => row.key === key)).toBe(false);
    const view = await mount({ focus: { hold: key, at: 1, from: "push" } });
    for (let at = 0; at < 3; at += 1) await settle();
    expect(view.text()).not.toContain("That hold is no longer waiting on you");
    expect(view.text()).toContain("Quiet now A1?");
    expect(view.id("from-the-push")?.textContent).toBe("From the push · same hold");
    expect(view.handled).toHaveLength(1);
  });

  test("a hold missing from a cached read is not 'closed' until a read made since this screen mounted says so", async () => {
    // The cache holds an old read without the hold; the read since mount (still on its way) has it.
    const stale = needsNow();
    stale.rows = stale.rows.filter((row) => row.key !== "work:w-gate-9a1");
    let release: () => void = () => undefined;
    needsHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view = await mount({ cached: stale, focus: { hold: "work:w-gate-9a1", at: 1, from: "push" } });
    for (let at = 0; at < 3; at += 1) await settle();
    expect(view.text()).not.toContain("That hold is no longer waiting on you");
    expect(view.handled).toHaveLength(0);
    release();
    for (let at = 0; at < 4; at += 1) await settle();
    // The fresh read holds it: the deck opens on it, from the push.
    expect(view.id("from-the-push")?.textContent).toBe("From the push · same hold");
    expect(view.text()).toContain("Merge workspace 933");
    expect(view.text()).not.toContain("That hold is no longer waiting on you");
  });

  test("a hold that closed since the push says so, and shows the deck from its start", async () => {
    const view = await mount({ focus: { hold: "work:w-long-gone-0000", at: 1, from: "push" } });
    for (let at = 0; at < 3; at += 1) await settle();
    expect(view.text()).toContain("That hold is no longer waiting on you");
    expect(view.id("from-the-push") === null).toBe(true);
    expect(view.text()).toContain("1 of 4");
  });
});

// ── M6: Work ─────────────────────────────────────────────────────────────────

describe("M6, Work at 375 x 812", () => {
  test("the deck holds the work that needs you, with its hold, lifecycle and receipts; never an Approve", async () => {
    const view = await mount({ tab: "work" });
    const workHolds = needsNow().rows.filter((row) => row.key.startsWith("work:"));
    expect(workHolds.length).toBeGreaterThan(0);
    expect(view.text()).toContain("Work");
    expect(view.text()).toContain(`1 of ${workHolds.length}`);
    expect(view.text()).toContain("Merge workspace 933");
    expect(view.text()).toContain("Its hold: approval");
    expect(view.text()).toContain("LIFECYCLE");
    expect(view.text()).toContain("RECEIPTS");
    expect(view.label("Open the hold") !== null || view.text().includes("Open the hold")).toBe(true);
    expect(view.text()).not.toMatch(/\bApprove\b/);
    // BRO-3001: Work carries no badge, as M1 and M6 draw it; the other three do.
    const tabs = view.all('[role="tab"]').map((tab) => tab.getAttribute("aria-label"));
    expect(tabs[2]).toBe("Work");
  });

  test("the sheet is the board with a lane switcher, and its counts are the lengths of its lanes", async () => {
    const view = await mount({ tab: "work" });
    expect(view.text()).toContain("The board");
    expect(view.text()).toContain("2 running");
    expect(view.text()).toContain("1 queued");
    expect(view.text()).toContain("0 standing");
    await view.press(view.label("Raise the sheet"));
    // Running opens first, and its rows wear the Undertow; no other lane's do (B1).
    expect(view.text()).toContain("Provable Outlook reads");
    expect(view.all('[data-testid="undertow-halo"]').length).toBe(2);
    await view.press(view.label("Queued, 1"));
    expect(view.text()).toContain("Close leftover fleet items");
    expect(view.all('[data-testid="undertow-halo"]').length).toBe(0);
    await view.press(view.label("Standing, 0"));
    expect(view.text()).toContain("Nothing is standing.");
  });

  test("Open the hold goes to the same card the Feed opens", async () => {
    const view = await mount({ tab: "work" });
    const open = view.all("[role='button']").find((el) => el.textContent === "Open the hold");
    await view.press(open);
    expect(view.id("detail-header") !== null).toBe(true);
    expect(view.text()).toContain("Approval");
  });

  test("a running row opens its card, with the lifecycle and its session", async () => {
    const view = await mount({ tab: "work" });
    await view.press(view.label("Raise the sheet"));
    const row = view.all("[role='button']").find((el) => (el.textContent ?? "").includes("Provable Outlook reads"));
    await view.press(row);
    expect(view.id("detail-header") !== null).toBe(true);
    expect(view.text()).toContain("Running");
  });

  test("a work list that failed beside a good needs.list is not 'no work needs you'", async () => {
    workListFail = "daemon down";
    const view = await mount({ tab: "work" });
    expect(view.text()).toContain("Couldn't read the work that needs you.");
    expect(view.text()).not.toContain("No work needs you.");
  });

  test("a failed read says so: never 'no work needs you'", async () => {
    needsFail = "daemon down";
    const view = await mount({ tab: "work" });
    expect(view.text()).toContain("Couldn't read the work that needs you.");
    expect(view.text()).not.toContain("No work needs you.");
  });
});

// ── M7: Health ───────────────────────────────────────────────────────────────

describe("M7, Health at 375 x 812", () => {
  test("the deck holds the notices, stuck first, each with what closes it and its one verb", async () => {
    items.push(
      fakeWork(
        "w-quiet-7e1",
        "running",
        { agentId: "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d", workspaceId: "ws1" },
        {
          project: "sri",
          ticket: "STI-3617",
          title: "Eve turn latency",
          flag: {
            kind: "quiet",
            reason: "Quiet for 808 minutes.",
            at: new Date(Date.now() - 808 * 60_000).toISOString(),
          },
        },
      ),
    );
    const view = await mount({ tab: "health" });
    const total = noticesOf(
      { items, fleet: [], timeline: [], loops: [], reviews: [], snoozed: new Map<string, string>() },
      Date.now(),
    ).summary.total;
    expect(total).toBe(2);
    // The Health tab's badge, the deck's length and notices.list agree.
    const tabs = view.all('[role="tab"]').map((tab) => tab.getAttribute("aria-label"));
    expect(tabs[3]).toBe(`Health, ${total}`);
    expect(view.text()).toContain(`1 of ${total}`);
    expect(view.text()).toContain("Stuck");
    expect(view.text()).toContain("Credits ledger: ended mid-turn");
    expect(view.text()).toContain("Closes when");
    expect(view.text()).toContain("Unblock…");
  });

  test("a notice card opens its own detail (M4), as a hold's card opens M2 (BRO-3103)", async () => {
    const view = await mount({ tab: "health" });
    expect(view.text()).toContain("Credits ledger: ended mid-turn");
    await view.press(view.all("[role='link']").find((el) => el.textContent?.includes("Details, session and history")));
    expect(view.id("inspector-card") !== null).toBe(true);
    expect(view.id("inspector-card")?.textContent ?? "").toContain("Credits ledger: ended mid-turn");
  });

  test("Unblock asks for words in a sheet of ours and sends them; the sheet closes only when they were sent", async () => {
    unblockFail = "daemon down";
    const view = await mount({ tab: "health" });
    await view.press(view.all("[role='button']").find((el) => el.textContent === "Unblock…"));
    expect(view.id("unblock-sheet") !== null).toBe(true);
    const field = view.label("A prompt for the session of Credits ledger: ended mid-turn");
    await act(async () => {
      const proto = win.HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, "Pick up at the refund test");
      (field as unknown as { dispatchEvent(event: unknown): boolean }).dispatchEvent(
        new win.Event("input", { bubbles: true }),
      );
    });
    await view.press(view.all("[role='button']").find((el) => el.textContent === "Send"));
    // The call failed: nothing was sent, so the sheet stays and the words are still there.
    expect(sent("work.unblock")).toEqual([{ id: "w-stuck-3c4", note: "Pick up at the refund test" }]);
    expect(view.id("unblock-sheet") !== null).toBe(true);
    unblockFail = null;
    await view.press(view.all("[role='button']").find((el) => el.textContent === "Send"));
    expect(sent("work.unblock")).toHaveLength(2);
    expect(view.id("unblock-sheet") === null).toBe(true);
  });

  test("a quiet notice is snoozed with the 8 s undo; its verb cannot be pressed again while it waits", async () => {
    items.splice(
      0,
      items.length,
      fakeWork(
        "w-quiet-7e1",
        "running",
        { agentId: "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d", workspaceId: "ws1" },
        {
          project: "sri",
          title: "Eve turn latency",
          flag: {
            kind: "quiet",
            reason: "Quiet for 808 minutes.",
            at: new Date(Date.now() - 808 * 60_000).toISOString(),
          },
        },
      ),
    );
    const view = await mount({ tab: "health" });
    expect(view.text()).toContain("Quiet");
    await view.press(view.all("[role='button']").find((el) => el.textContent === "Snooze 4h"));
    expect(sent("notice.snooze")).toEqual([{ key: "quiet:w-quiet-7e1", hours: 4 }]);
    await settle(60);
    expect(view.text()).toContain("Snoozed 4h");
    const again = view.all("[role='button']").find((el) => el.textContent === "Snooze 4h");
    await view.press(again);
    expect(sent("notice.snooze")).toHaveLength(1);
  });

  test("the sheet is the fleet at a glance: four tiles, then schedules and the views Health reaches", async () => {
    const view = await mount({ tab: "health" });
    expect(view.text()).toContain("The fleet");
    await view.press(view.label("Raise the sheet"));
    for (const word of ["Fleet ticks", "Sessions", "Schedules", "Conductor"]) expect(view.text()).toContain(word);
    // Sessions counts running work in its own unit.
    expect(view.text()).toContain("Sessions2running1 stuck");
    expect(view.text()).toContain("No loop or schedule is registered or observed.");
    await view.press(view.label("Initiatives, 1 review due"));
    expect(view.pages).toEqual([{ kind: "initiatives" }]);
  });

  test("a source the notices could not read is said above the deck, with cards and without", async () => {
    noticesUnread = ["the fleet"];
    const view = await mount({ tab: "health" });
    expect(view.id("unread-sources")?.textContent).toBe("Couldn't read the fleet: notices may be missing.");
    expect(view.text()).toContain("Credits ledger: ended mid-turn");
    items.splice(0, items.length);
    const empty = await mount({ tab: "health" });
    expect(empty.text()).toContain("Couldn't read the notices (the fleet).");
    expect(empty.text()).not.toContain("Nothing is asking for a look.");
  });

  test("a notices read that failed says so; it is never 'nothing is asking for a look'", async () => {
    noticesFail = "daemon down";
    const view = await mount({ tab: "health" });
    expect(view.text()).toContain("Couldn't read the notices.");
    expect(view.text()).not.toContain("Nothing is asking for a look.");
    // The tab's badge is missing too, not zero.
    expect(view.all('[role="tab"]').map((tab) => tab.getAttribute("aria-label"))[3]).toBe("Health");
  });
});

// ── M8: Initiatives ──────────────────────────────────────────────────────────

describe("M8, Initiatives from Health's sheet", () => {
  test("a page with lateness first; a due review opens as the hold the Feed's deck shows", async () => {
    const view = await mount({ tab: "health", page: { kind: "initiatives" } });
    expect(view.text()).toContain("from Health");
    expect(view.text()).toContain("Initiatives");
    expect(view.text()).toContain("skene");
    expect(view.text()).toContain("2 d late");
    expect(view.text()).toContain("no driver");
    await view.press(view.id("initiative-skene"));
    // The review's three answers, in the card over the page.
    expect(view.id("detail-header") !== null).toBe(true);
    expect(view.text()).toContain("Review · 1 of 1");
    expect(view.text()).toContain("It stays active; its next review date moves on.");
  });

  test("answering a review from the page leaves the Feed's deck where it was", async () => {
    // The Decisions deck is on its second ask; the review answered on the page is not that deck's hold to move past.
    const second = needsNow().rows.filter((row) => row.key.startsWith("ask:"))[1]?.key as string;
    const view = await mount({ tab: "decisions", focus: { hold: second, at: 1 }, page: { kind: "initiatives" } });
    for (let at = 0; at < 3; at += 1) await settle();
    const before = /(\d) of 2/.exec(view.text())?.[0];
    expect(before).toBe("2 of 2");
    await view.press(view.id("initiative-skene"));
    await view.press(view.label("Keep"));
    await view.press(view.label("Answer"));
    expect(sent("initiatives.review")).toHaveLength(1);
    expect(/(\d) of 2/.exec(view.text())?.[0]).toBe(before);
  });

  test("a read that failed says so and offers Try again, never an empty list", async () => {
    initiativesFail = "control repo missing";
    const view = await mount({ tab: "health", page: { kind: "initiatives" } });
    expect(view.id("initiatives-unread") !== null).toBe(true);
    expect(view.text()).toContain("Couldn't read your initiatives");
    expect(view.text()).not.toContain("Nothing here.");
  });

  test("the chevron closes the page", async () => {
    const view = await mount({ tab: "health", page: { kind: "initiatives" } });
    await view.press(view.label("Close"));
    expect(view.pages).toEqual([null]);
  });
});

// ── M11: Settings ────────────────────────────────────────────────────────────

describe("M11, Settings from the presence menu", () => {
  test("the presence menu's Settings opens the card, one level deep, drawing only what has data", async () => {
    const view = await mount();
    await view.press(view.labelled("Presence: Present")[0]);
    await view.press(view.label("Settings"));
    expect(view.pages).toEqual([{ kind: "settings", page: "root" }]);
  });

  test("the root lists the rows that have a read behind them, and none that do not", async () => {
    const view = await mount({ page: { kind: "settings", page: "root" } });
    for (const row of ["Presence", "Runs and gate", "Lanes", "Loops", "Notices"]) {
      expect(view.labelled(row).length).toBeGreaterThan(0);
    }
    // No read or write exists for these yet: they are not drawn.
    for (const absent of ["Notifications", "Approvals", "Credentials", "Appearance"]) {
      expect(view.text()).not.toContain(absent);
    }
    expect(view.text()).toContain("Changes apply after the 8 s undo");
    expect(view.text()).toContain("conductor + 0");
  });

  test("a read that failed is 'not read' on every row, never a zero or an empty list", async () => {
    settingsReadsFail = true;
    noticesFail = "daemon down";
    const view = await mount({ page: { kind: "settings", page: "root" } });
    for (const row of ["Runs and gate", "Lanes", "Loops", "Notices"]) {
      expect(view.label(`${row}, not read`) !== null).toBe(true);
    }
    expect(view.text()).not.toContain("conductor + 0");
  });

  test("Notices and Lanes say they could not read, not 'none' or 'no fleet scope'", async () => {
    settingsReadsFail = true;
    noticesFail = "daemon down";
    const notices = await mount({ page: { kind: "settings", page: "notices" } });
    expect(notices.text()).toContain("Couldn't read the notices.");
    expect(notices.text()).not.toContain("Stuck runs");
    const lanes = await mount({ page: { kind: "settings", page: "lanes" } });
    expect(lanes.text()).toContain("Couldn't read the fleet, so its lanes are not listed.");
    expect(lanes.text()).not.toContain("No fleet scope is configured.");
  });

  test("a row goes one level deeper and the chevron comes back", async () => {
    const view = await mount({ page: { kind: "settings", page: "root" } });
    await view.press(view.label("Presence, Present"));
    expect(view.pages.at(-1)).toEqual({ kind: "settings", page: "presence" });
    expect(view.text()).toContain("Choosing a state lands with BRO-2987");
    expect(view.text()).toContain("Settings › Presence");
    await view.press(view.label("Back"));
    expect(view.pages.at(-1)).toEqual({ kind: "settings", page: "root" });
  });
});
