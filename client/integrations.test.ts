import { afterEach, describe, expect, test } from "bun:test";
import type { PluginButton } from "@getpaseo/plugin/client";
import type { WorkItem } from "../shared/contracts";
import { fakeWork } from "./fake-work";
import { type IntegrationClient, REFRESH_MS, startIntegrations, workspaceIds } from "./integrations";
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

/** A plugin client that records every registration, with the daemon's answers under the test's control. */
function fakeClient() {
  const state = {
    work: [] as WorkItem[] | Error,
    workspaces: ["ws1"] as string[] | Error,
    /** While set, work.list waits for it. */
    hold: null as Promise<void> | null,
  };
  const headers: Registered[] = [];
  const pills: Registered[] = [];
  const opened: string[] = [];
  let reads = 0;
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
      },
    },
    rpc: async () => {
      reads += 1;
      if (state.hold) await state.hold;
      if (state.work instanceof Error) throw state.work;
      return { root: "/work", items: state.work, scoreboard: {}, warnings: [] };
    },
    openSurface: (id: string) => opened.push(id),
    addHeaderButton: (contribution: Omit<Registered, "patches" | "removed">) => register(headers, contribution),
    addComposerPill: (contribution: Omit<Registered, "patches" | "removed">) => register(pills, contribution),
  } as unknown as IntegrationClient;
  return { client, state, headers, pills, opened, reads: () => reads };
}

function start(fake: ReturnType<typeof fakeClient>) {
  const timer = { tick: null as (() => void) | null, ms: 0, cancelled: false };
  const logs: string[] = [];
  const integrations = startIntegrations(
    fake.client,
    { pillIcon: (state) => `icon-${state}`, PillContent },
    {
      every: (tick, ms) => {
        timer.tick = tick;
        timer.ms = ms;
        return () => {
          timer.cancelled = true;
        };
      },
      log: (line) => logs.push(line),
    },
  );
  /** One timer tick, run to completion. */
  const tick = async () => {
    timer.tick?.();
    await settle();
  };
  return { integrations, timer, logs, tick };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A promise the test opens by hand. */
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
  test("every workspace gets one, shown only while something needs you, refreshed every 10 s", async () => {
    const fake = fakeClient();
    fake.state.workspaces = ["ws1", "ws2"];
    fake.state.work = [fakeWork("r", "review"), fakeWork("b", "blocked"), fakeWork("x", "running")];
    const { timer, tick } = start(fake);
    await settle();
    expect(timer.ms).toBe(REFRESH_MS);
    expect(REFRESH_MS).toBe(10_000);
    expect(live(fake.headers).map((entry) => [entry.id, entry.workspaceId])).toEqual([
      ["needs-you", "ws1"],
      ["needs-you", "ws2"],
    ]);
    expect(face(fake.headers[0] as Registered)).toMatchObject({ label: "2 need you", icon: "Inbox", visible: true });

    fake.state.work = [fakeWork("x", "running")];
    await tick();
    expect(live(fake.headers).map((entry) => face(entry).visible)).toEqual([false, false]);
  });

  test("follows the workspaces that exist: new ones get a button, gone ones lose theirs", async () => {
    const fake = fakeClient();
    fake.state.workspaces = ["ws1", "ws2"];
    const { tick } = start(fake);
    await settle();
    fake.state.workspaces = ["ws2", "ws3"];
    await tick();
    expect(live(fake.headers).map((entry) => entry.workspaceId)).toEqual(["ws2", "ws3"]);
    expect(fake.headers.find((entry) => entry.workspaceId === "ws1")?.removed).toBe(true);
  });

  test("pressing it opens Maestro at what needs you, as the list stands when pressed", async () => {
    const fake = fakeClient();
    fake.state.work = [fakeWork("r", "review")];
    const { tick } = start(fake);
    await settle();
    const press = () => {
      const behavior = face(fake.headers[0] as Registered).behavior;
      if (behavior.kind !== "action") throw new Error("the header count is an action");
      void behavior.onPress();
    };
    press();
    expect(fake.opened).toEqual(["maestro"]);
    expect(takeIntent()).toEqual({ kind: "select", id: "r" });
    fake.state.work = [fakeWork("r", "review"), fakeWork("s", "review")];
    await tick();
    press();
    expect(takeIntent()).toEqual({ kind: "filter", group: "review" });
  });
});

describe("the composer pill", () => {
  test("tracked sessions get one in plain voice with the state dot; untracked ones get none", async () => {
    const fake = fakeClient();
    fake.state.work = [fakeWork("w1", "running", { agentId: "a1", workspaceId: "ws1" }), fakeWork("w2", "proposed")];
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
    fake.state.work = [fakeWork("w1", "running", { agentId: "a1", workspaceId: "ws1" })];
    const { tick } = start(fake);
    await settle();
    fake.state.work = [fakeWork("w1", "review", { agentId: "a1", workspaceId: "ws1" })];
    await tick();
    const pill = fake.pills[0] as Registered;
    expect(pill.patches).toEqual([{ title: "Maestro: Work w1", label: "Needs you", icon: "icon-review" }]);
    await tick();
    expect(pill.patches).toHaveLength(1);
    fake.state.work = [];
    await tick();
    expect(pill.removed).toBe(true);
  });
});

describe("refreshing", () => {
  test("stopping removes every button and pill and the timer", async () => {
    const fake = fakeClient();
    fake.state.work = [fakeWork("w1", "review", { agentId: "a1", workspaceId: "ws1" })];
    const { integrations, timer } = start(fake);
    await settle();
    integrations.stop();
    expect(timer.cancelled).toBe(true);
    expect(live(fake.headers)).toEqual([]);
    expect(live(fake.pills)).toEqual([]);
    const reads = fake.reads();
    await integrations.refresh();
    expect(fake.reads()).toBe(reads);
  });

  test("a refresh still in flight when it stops registers nothing", async () => {
    const fake = fakeClient();
    const { held, release } = latch();
    fake.state.hold = held;
    fake.state.work = [fakeWork("w1", "review", { agentId: "a1", workspaceId: "ws1" })];
    const { integrations } = start(fake);
    await settle();
    integrations.stop();
    release();
    await settle();
    expect(fake.headers).toEqual([]);
    expect(fake.pills).toEqual([]);
  });

  test("one refresh at a time: a tick while one is in flight starts no second read", async () => {
    const fake = fakeClient();
    const { held, release } = latch();
    fake.state.hold = held;
    const { tick } = start(fake);
    await settle();
    await tick();
    expect(fake.reads()).toBe(1);
    release();
    await settle();
    fake.state.hold = null;
    await tick();
    expect(fake.reads()).toBe(2);
  });

  test("a failed read keeps what was last known, and is logged once while it lasts", async () => {
    const fake = fakeClient();
    fake.state.work = [fakeWork("r", "review", { agentId: "a1", workspaceId: "ws1" })];
    const { tick, logs } = start(fake);
    await settle();
    fake.state.work = new Error("socket closed");
    await tick();
    await tick();
    expect(logs).toEqual(["Could not refresh the header count and pills: socket closed"]);
    expect(face(fake.headers[0] as Registered).visible).toBe(true);
    expect(live(fake.pills)).toHaveLength(1);
    fake.state.work = [];
    await tick();
    fake.state.workspaces = new Error("socket closed");
    await tick();
    expect(logs).toHaveLength(2);
    expect(live(fake.headers).map((entry) => entry.workspaceId)).toEqual(["ws1"]);
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
