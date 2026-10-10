import { afterEach, describe, expect, test } from "bun:test";
import type { PluginButton } from "@getpaseo/plugin/client";
import { needsOf } from "../server/needs";
import type { Attention, WorkItem } from "../shared/contracts";
import type { DecisionAsk } from "../shared/fleet";
import type { Needs } from "../shared/needs";
import type { OrchState } from "../shared/states";
import { fakeWork } from "./fake-work";
import { type IntegrationClient, REFRESH, sessionSignal, startIntegrations, workspaceIds } from "./integrations";
import { takeIntent } from "./intent";

afterEach(() => {
  takeIntent();
});

interface Registered {
  id: string;
  workspaceId: string;
  agentId?: string;
  button: PluginButton;
  patches: Array<Partial<PluginButton>>;
  removed: boolean;
}

function PillContent() {
  return null;
}

/** needs.list as the server builds it (server/needs.ts) from this work and these asks. */
const needsFor = (items: WorkItem[], asks: DecisionAsk[] = []): Needs =>
  needsOf({ items, asks, reviews: [], landing: null, workspace: "broomva" }, Date.parse("2026-10-10T15:00:00Z"));
/** Work at your gate, one approval each. */
const holds = (...ids: string[]): Needs => needsFor(ids.map((id) => fakeWork(id, "review")));
const NONE = holds();
/** A decision ask that waits on you. */
const ask = (id: string): DecisionAsk => ({
  ledger: "bro-3001.yaml",
  uid: null,
  id,
  hash: "0123456789abcdef",
  arc: null,
  headline: `Ask ${id}?`,
  question: null,
  stakes: null,
  whyYou: null,
  options: [],
  fallback: null,
  blocking: true,
  askedAt: "2026-10-10T10:00:00.000Z",
  answeredAt: null,
  answer: null,
  answerOption: null,
  state: "open",
  origin: null,
  refusal: null,
  home: { kind: "main", path: "/ctl", branch: null },
  batched: false,
  waiting: true,
});
const session = (workId: string, state: OrchState, agentId = "a1", workspaceId: string | null = "ws1") => ({
  workId,
  title: `Work ${workId}`,
  state,
  agentId,
  workspaceId,
});

type AgentHandler = (update: unknown) => void;

/** A plugin client that records every registration, with the daemon's answers under the test's control. */
function fakeClient() {
  const state = {
    /** What needs.list answers: the count's one source. */
    needs: NONE as Needs | Error,
    /** What work.attention answers: only the pills' sessions are read from it (and the watched notices it carries). */
    attention: { waiting: [], sessions: [] } as Attention | Error,
    workspaces: ["ws1"] as string[] | Error,
    /** While set, every read waits for it. */
    hold: null as Promise<void> | null,
  };
  const headers: Registered[] = [];
  const pills: Registered[] = [];
  const opened: string[] = [];
  const reads: string[] = [];
  const handlers = { agents: new Set<AgentHandler>(), workspaces: new Set<AgentHandler>() };
  const register = (into: Registered[], contribution: Omit<Registered, "patches" | "removed">) => {
    const entry: Registered = { ...contribution, patches: [], removed: false };
    into.push(entry);
    return {
      update: (patch: Partial<PluginButton>) => entry.patches.push(patch),
      remove: () => {
        entry.removed = true;
      },
    };
  };
  const subscribe = (set: Set<AgentHandler>) => (handler: AgentHandler) => {
    set.add(handler);
    return () => set.delete(handler);
  };
  const client = {
    paseo: {
      workspaces: {
        list: async () => {
          if (state.workspaces instanceof Error) throw state.workspaces;
          return {
            requestId: "r",
            entries: state.workspaces.map((id) => ({ id })),
            pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
          };
        },
        subscribe: subscribe(handlers.workspaces),
      },
      agents: { subscribe: subscribe(handlers.agents) },
    },
    rpc: async (contract: { name: string }) => {
      reads.push(contract.name);
      if (state.hold) await state.hold;
      const answer = contract.name === "needs.list" ? state.needs : state.attention;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    openScreen: ({ screenId }: { screenId: string }) => opened.push(screenId),
    addHeaderButton: (contribution: Omit<Registered, "patches" | "removed">) => register(headers, contribution),
    addComposerPill: (contribution: Omit<Registered, "patches" | "removed">) => register(pills, contribution),
  } as unknown as IntegrationClient;
  const emit = {
    agent: (update: unknown) => {
      for (const handler of handlers.agents) handler(update);
    },
    workspace: (update: unknown) => {
      for (const handler of handlers.workspaces) handler(update);
    },
  };
  return { client, state, headers, pills, opened, reads, handlers, emit };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Timers on a clock the test moves. */
function fakeClock() {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const later = (run: () => void, ms: number) => {
    const id = next++;
    timers.set(id, { at: now + ms, run });
    return () => {
      timers.delete(id);
    };
  };
  /** Moves the clock, running each timer that falls due and letting what it starts finish. */
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].run();
      await settle();
    }
    now = until;
  };
  /** The delays of the timers now pending, soonest first. */
  const pending = () => [...timers.values()].map((t) => t.at - now).sort((a, b) => a - b);
  return { later, advance, pending };
}

function start(fake: ReturnType<typeof fakeClient>) {
  const clock = fakeClock();
  const logs: string[] = [];
  const integrations = startIntegrations(
    fake.client,
    { pillIcon: (state) => `icon-${state}`, PillContent },
    { later: clock.later, log: (line) => logs.push(line) },
  );
  return { integrations, clock, logs };
}

/** A latch the test opens by hand. */
function latch() {
  const gate: { release: () => void; held: Promise<void> } = { release: () => undefined, held: Promise.resolve() };
  gate.held = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
  return gate;
}

const live = (entries: Registered[]) => entries.filter((entry) => !entry.removed);
/** What an entry shows now: its first face with every patch applied. */
const face = (entry: Registered) => Object.assign({}, entry.button, ...entry.patches) as PluginButton;

describe("the header count", () => {
  test("every workspace gets one, saying needs.list's total, shown only while something needs you", async () => {
    const fake = fakeClient();
    fake.state.workspaces = ["ws1", "ws2"];
    fake.state.needs = holds("r", "s");
    const { clock } = start(fake);
    await settle();
    expect(fake.reads).toEqual(["needs.list", "work.attention"]);
    expect(live(fake.headers).map((entry) => [entry.id, entry.workspaceId])).toEqual([
      ["needs-you", "ws1"],
      ["needs-you", "ws2"],
    ]);
    expect(face(fake.headers[0] as Registered)).toMatchObject({ label: "2 need you", icon: "Inbox", visible: true });

    // An ask that waits on you counts as one hold, beside the work.
    fake.state.needs = needsFor([fakeWork("r", "review")], [ask("A1"), ask("A2")]);
    await clock.advance(REFRESH.everyMs);
    expect(face(fake.headers[0] as Registered)).toMatchObject({ label: "3 need you", visible: true });

    fake.state.needs = NONE;
    await clock.advance(REFRESH.everyMs);
    expect(live(fake.headers).map((entry) => face(entry).visible)).toEqual([false, false]);
  });

  test("what you watch never reaches it: stuck work, a quiet run, a fleet tick or a failed run (A1)", async () => {
    const fake = fakeClient();
    const flag = { kind: "quiet" as const, reason: "Quiet for 31 minutes.", at: "2026-10-10T09:30:00Z" };
    fake.state.needs = needsFor([fakeWork("b", "blocked"), fakeWork("q", "running", null, { flag })]);
    fake.state.attention = {
      waiting: [],
      sessions: [],
      fleet: [{ scope: "sri", status: "missed", reason: "No tick for 3h.", since: null }],
      timeline: [
        { id: "launchd:x", kind: "launchd", name: "x", status: "failed", reason: "exit 1", since: null },
      ] as Attention["timeline"],
    };
    start(fake);
    await settle();
    expect(face(fake.headers[0] as Registered)).toMatchObject({ label: "0 need you", visible: false });
  });

  test("follows the workspaces that exist: new ones get a button, gone ones lose theirs", async () => {
    const fake = fakeClient();
    fake.state.workspaces = ["ws1", "ws2"];
    const { clock } = start(fake);
    await settle();
    fake.state.workspaces = ["ws2", "ws3"];
    await clock.advance(REFRESH.everyMs);
    expect(live(fake.headers).map((entry) => entry.workspaceId)).toEqual(["ws2", "ws3"]);
    expect(fake.headers.find((entry) => entry.workspaceId === "ws1")?.removed).toBe(true);
  });

  test("pressing it opens Maestro where the holds are, as needs.list stands when pressed", async () => {
    const fake = fakeClient();
    fake.state.needs = holds("r");
    const { clock } = start(fake);
    await settle();
    const press = () => {
      const behavior = face(fake.headers[0] as Registered).behavior;
      if (behavior.kind !== "action") throw new Error("the header count is an action");
      void behavior.onPress();
    };
    press();
    expect(fake.opened).toEqual(["maestro"]);
    expect(takeIntent()).toEqual({ kind: "select", id: "r" });
    fake.state.needs = holds("r", "s");
    await clock.advance(REFRESH.everyMs);
    press();
    expect(takeIntent()).toEqual({ kind: "filter", group: "review" });
    // Only asks: Decisions.
    fake.state.needs = needsFor([], [ask("A1"), ask("A2")]);
    await clock.advance(REFRESH.everyMs);
    press();
    expect(takeIntent()).toEqual({ kind: "decisions" });
  });
});

describe("the composer pill", () => {
  test("each listed session gets one in plain voice with the state dot", async () => {
    const fake = fakeClient();
    fake.state.attention = { waiting: [], sessions: [session("w1", "running")] };
    start(fake);
    await settle();
    expect(fake.pills).toHaveLength(1);
    const pill = fake.pills[0] as Registered;
    expect(pill).toMatchObject({ id: "work", workspaceId: "ws1", agentId: "a1" });
    expect(pill.button).toMatchObject({ title: "Maestro: Work w1", label: "Running", icon: "icon-running" });
    expect(pill.button.behavior).toEqual({ kind: "popover", Content: PillContent });
  });

  test("a state change updates the pill in place without replacing its popover, and a gone session loses it", async () => {
    const fake = fakeClient();
    fake.state.attention = { waiting: [], sessions: [session("w1", "running")] };
    const { clock } = start(fake);
    await settle();
    fake.state.attention = { waiting: [], sessions: [session("w1", "review")] };
    await clock.advance(REFRESH.everyMs);
    const pill = fake.pills[0] as Registered;
    expect(pill.patches).toEqual([{ title: "Maestro: Work w1", label: "Needs you", icon: "icon-review" }]);
    await clock.advance(REFRESH.everyMs);
    expect(pill.patches).toHaveLength(1);
    fake.state.attention = { waiting: [], sessions: [] };
    await clock.advance(REFRESH.everyMs);
    expect(pill.removed).toBe(true);
  });
});

describe("what it costs", () => {
  test("reads every 30 s, and every 60 s once nothing shown has changed for four reads", async () => {
    const fake = fakeClient();
    fake.state.needs = holds("r");
    const { clock } = start(fake);
    await settle();
    expect(clock.pending()).toEqual([REFRESH.everyMs]);
    expect([REFRESH.everyMs, REFRESH.calmMs, REFRESH.calmAfter]).toEqual([30_000, 60_000, 4]);
    for (let read = 1; read < REFRESH.calmAfter; read += 1) {
      await clock.advance(REFRESH.everyMs);
      expect(clock.pending()).toEqual([REFRESH.everyMs]);
    }
    await clock.advance(REFRESH.everyMs);
    // Each refresh is two reads: needs.list for the count, work.attention for the pills.
    expect(fake.reads).toHaveLength(2 * (REFRESH.calmAfter + 1));
    expect(clock.pending()).toEqual([REFRESH.calmMs]);
    fake.state.needs = holds("r", "s");
    await clock.advance(REFRESH.calmMs);
    expect(clock.pending()).toEqual([REFRESH.everyMs]);
  });

  test("a session changing status brings a read forward; a burst of events is one read", async () => {
    const fake = fakeClient();
    const { clock } = start(fake);
    await settle();
    const agent = (id: string, status: string, pendingPermissions: unknown[] = []) => ({
      kind: "upsert",
      agent: { id, status, pendingPermissions, archivedAt: null },
    });
    fake.emit.agent(agent("a1", "running"));
    fake.emit.agent(agent("a2", "running"));
    fake.emit.agent(agent("a1", "idle"));
    expect(clock.pending()).toEqual([REFRESH.nudgeMs, REFRESH.everyMs]);
    await clock.advance(REFRESH.nudgeMs);
    expect(fake.reads).toHaveLength(4);
    // The read also pushed the next poll a full interval out.
    expect(clock.pending()).toEqual([REFRESH.everyMs]);
    // An update that changes nothing the count or a pill shows brings nothing forward.
    fake.emit.agent(agent("a1", "idle"));
    expect(clock.pending()).toEqual([REFRESH.everyMs]);
    fake.emit.agent(agent("a1", "idle", [{ id: "p1" }]));
    expect(clock.pending()).toEqual([REFRESH.nudgeMs, REFRESH.everyMs]);
  });

  test("a workspace coming or going brings a read forward; one it already knows does not", async () => {
    const fake = fakeClient();
    fake.state.workspaces = ["ws1"];
    const { clock } = start(fake);
    await settle();
    fake.emit.workspace({ kind: "upsert", workspace: { id: "ws1" } });
    fake.emit.workspace({ kind: "remove", id: "ws9" });
    expect(clock.pending()).toEqual([REFRESH.everyMs]);
    fake.emit.workspace({ kind: "upsert", workspace: { id: "ws2" } });
    expect(clock.pending()).toEqual([REFRESH.nudgeMs, REFRESH.everyMs]);
    await clock.advance(REFRESH.nudgeMs);
    fake.emit.workspace({ kind: "remove", id: "ws1" });
    expect(clock.pending()).toEqual([REFRESH.nudgeMs, REFRESH.everyMs]);
  });

  test("the session signal is status, question and archive, nothing else", () => {
    expect(sessionSignal({ status: "idle", pendingPermissions: [], archivedAt: null })).toBe("idle:0:live");
    expect(sessionSignal({ status: "idle", pendingPermissions: [{}], archivedAt: "2026-09-29" })).toBe(
      "idle:1:archived",
    );
  });
});

describe("refreshing", () => {
  test("stopping removes every button, pill, timer and listener", async () => {
    const fake = fakeClient();
    fake.state.needs = holds("w1");
    fake.state.attention = { waiting: [], sessions: [session("w1", "review")] };
    const { integrations, clock } = start(fake);
    await settle();
    fake.emit.agent({ kind: "upsert", agent: { id: "a1", status: "idle", pendingPermissions: [] } });
    integrations.stop();
    expect(clock.pending()).toEqual([]);
    expect(fake.handlers.agents.size + fake.handlers.workspaces.size).toBe(0);
    expect(live(fake.headers)).toEqual([]);
    expect(live(fake.pills)).toEqual([]);
    await integrations.refresh();
    expect(fake.reads).toHaveLength(2);
  });

  test("a read still in flight when it stops registers nothing and schedules nothing", async () => {
    const fake = fakeClient();
    const gate = latch();
    fake.state.hold = gate.held;
    fake.state.attention = { waiting: [], sessions: [session("w1", "review")] };
    const { integrations, clock } = start(fake);
    await settle();
    integrations.stop();
    gate.release();
    await settle();
    expect(fake.headers).toEqual([]);
    expect(fake.pills).toEqual([]);
    expect(clock.pending()).toEqual([]);
  });

  test("one read at a time: an event while one is in flight waits for it, then reads once", async () => {
    const fake = fakeClient();
    const gate = latch();
    fake.state.hold = gate.held;
    const { clock, integrations } = start(fake);
    await settle();
    fake.emit.agent({ kind: "upsert", agent: { id: "a1", status: "idle", pendingPermissions: [] } });
    await clock.advance(REFRESH.nudgeMs);
    await integrations.refresh();
    expect(fake.reads).toHaveLength(2);
    fake.state.hold = null;
    gate.release();
    await settle();
    await clock.advance(REFRESH.nudgeMs);
    expect(fake.reads).toHaveLength(4);
  });

  test("a failed read keeps what was last known, and is logged once while it lasts", async () => {
    const fake = fakeClient();
    fake.state.needs = holds("r");
    fake.state.attention = { waiting: [], sessions: [session("r", "review")] };
    const { clock, logs } = start(fake);
    await settle();
    fake.state.needs = new Error("socket closed");
    fake.state.attention = new Error("socket closed");
    await clock.advance(REFRESH.everyMs);
    await clock.advance(REFRESH.everyMs);
    expect(logs).toEqual(["Could not refresh the header count and pills: socket closed"]);
    expect(face(fake.headers[0] as Registered).visible).toBe(true);
    expect(live(fake.pills)).toHaveLength(1);
    fake.state.needs = NONE;
    fake.state.attention = { waiting: [], sessions: [] };
    await clock.advance(REFRESH.everyMs);
    fake.state.workspaces = new Error("socket closed");
    await clock.advance(REFRESH.everyMs);
    expect(logs).toHaveLength(2);
    expect(live(fake.headers).map((entry) => entry.workspaceId)).toEqual(["ws1"]);
  });

  test("a host that cannot subscribe still polls", async () => {
    const fake = fakeClient();
    (fake.client.paseo.agents as { subscribe: unknown }).subscribe = () => {
      throw new Error("not connected");
    };
    const { clock, logs } = start(fake);
    await settle();
    expect(logs).toEqual(["Could not listen for session changes; polling only: not connected"]);
    await clock.advance(REFRESH.everyMs);
    expect(fake.reads).toHaveLength(4);
  });
});

test("workspace ids are read page by page", async () => {
  const pages = [
    { entries: [{ id: "a" }, { id: "b" }], pageInfo: { hasMore: true, nextCursor: "c1", prevCursor: null } },
    { entries: [{ id: "c" }], pageInfo: { hasMore: false, nextCursor: null, prevCursor: "c1" } },
  ];
  const cursors: Array<string | undefined> = [];
  const paseo = {
    workspaces: {
      list: async (options?: { page?: { cursor?: string } }) => {
        cursors.push(options?.page?.cursor);
        return pages[cursors.length - 1];
      },
    },
  } as unknown as Parameters<typeof workspaceIds>[0];
  expect(await workspaceIds(paseo)).toEqual(["a", "b", "c"]);
  expect(cursors).toEqual([undefined, "c1"]);
});
