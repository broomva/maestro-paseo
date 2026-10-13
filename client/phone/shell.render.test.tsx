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

const { act } = await import("react");
const { createRoot } = require("react-dom/client") as {
  createRoot(container: unknown): { render(node: ReactNode): void; unmount(): void };
};
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { PluginRpcProvider } = await import("@getpaseo/plugin/client/host");
const { needsOf } = await import("../../server/needs");
const { noticesOf } = await import("../../server/notices");
const { answersStatus } = await import("../../server/answers-status");
const { fakeWork } = await import("../fake-work");
const { GALLERY_LIGHT } = await import("../kit/gallery-data");
const { PhoneSurface } = await import("./shell");
const { CONFIRM_MS } = await import("./model");
type PhoneTab = import("./model").PhoneTab;
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
let pending: Pending[] = [];
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
  pending = [];
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

const invoke = async (method: string, input: unknown) => {
  calls.push({ method, input });
  switch (method) {
    case "needs.list":
      if (needsFail) throw new Error(needsFail);
      return unreadNow ? { ...needsNow(), unread: unreadNow } : needsNow();
    case "work.list":
      return {
        root: "/work",
        items,
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
      return noticesOf(
        { items, fleet: [], timeline: [], loops: [], reviews: [], snoozed: new Map<string, string>() },
        Date.now(),
      );
    case "asks.workspace":
      return { controlRepo: "/Users/me/broomva", main: null, decisions: asks, fleet: [], warnings: [] };
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

async function mount(props: { tab?: PhoneTab; focus?: HomeFocus | null } = {}) {
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let tab: PhoneTab = props.tab ?? "feed";
  const handled: number[] = [];
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
          onNew={() => undefined}
          onOpenWork={() => undefined}
          classic={<web.Text>classic body</web.Text>}
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

  test("a hold that closed since the push says so, and shows the deck from its start", async () => {
    const view = await mount({ focus: { hold: "work:w-long-gone-0000", at: 1, from: "push" } });
    for (let at = 0; at < 3; at += 1) await settle();
    expect(view.text()).toContain("That hold is no longer waiting on you");
    expect(view.id("from-the-push") === null).toBe(true);
    expect(view.text()).toContain("1 of 4");
  });
});

// ── The interim bodies ───────────────────────────────────────────────────────

describe("Work and Health", () => {
  test("show today's body under the same tab bar until M6 and M7", async () => {
    const view = await mount({ tab: "work" });
    expect(view.text()).toContain("classic body");
    expect(view.id("tab-bar") !== null).toBe(true);
    expect(view.id("pull-sheet-rider") === null).toBe(true);
    const work = view.all('[role="tab"]').find((tab) => tab.getAttribute("aria-label") === "Work");
    expect(work?.getAttribute("aria-current")).toBe("true");
  });
});
