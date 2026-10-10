import { afterEach, describe, expect, test } from "bun:test";
import type { Needs } from "../shared/needs";
import {
  latestNeeds,
  type NeedsFrom,
  onNeeds,
  publishNeeds,
  readTicket,
  resetNeedsBus,
  sessionSignal,
  stampNeeds,
  ticketOf,
  watchSessions,
} from "./needs-bus";

afterEach(resetNeedsBus);

const needs = (total: number): Needs => ({
  rows: [],
  summary: { total, byKind: { ask: 0, approval: total, owner_step: 0 } },
});

describe("one snapshot of what needs you (BRO-3001)", () => {
  test("a read reaches every listener with who made it; the same snapshot again is no news, so readers never echo", () => {
    const heard: [number, NeedsFrom][] = [];
    const stop = onNeeds((next, from) => heard.push([next.summary.total, from]));
    expect(publishNeeds(needs(2), "screen", readTicket())).toBe("newer");
    expect(publishNeeds(needs(2), "header", readTicket())).toBe("same");
    publishNeeds(needs(3), "header", readTicket());
    stop();
    publishNeeds(needs(4), "screen", readTicket());
    expect(heard).toEqual([
      [2, "screen"],
      [3, "header"],
    ]);
  });
});

describe("snapshots in the order their reads started", () => {
  test("a read that started earlier never replaces one that started later, whichever lands first", () => {
    const heard: number[] = [];
    onNeeds((next) => heard.push(next.summary.total));
    const early = readTicket();
    const late = readTicket();
    // The later read lands first; the earlier one, slow, lands after it with an older count.
    expect(publishNeeds(needs(3), "screen", late)).toBe("newer");
    expect(publishNeeds(needs(1), "header", early)).toBe("older");
    expect(latestNeeds()?.summary.total).toBe(3);
    expect(heard).toEqual([3]);
    // The same snapshot from an older read is no news either way.
    expect(publishNeeds(needs(3), "header", early)).toBe("same");
    // An answer carries the ticket its read started with.
    const ticket = readTicket();
    const answer = stampNeeds(needs(5), ticket);
    expect(ticketOf(answer)).toBe(ticket);
    expect(ticketOf(needs(5))).toBeGreaterThan(ticket);
  });
});

/** Paseo's agent subscription, driven by the test. */
function fakeAgents() {
  let handler: ((update: never) => void) | null = null;
  return {
    subscribe: (next: (update: never) => void) => {
      handler = next;
      return () => {
        handler = null;
      };
    },
    emit: (update: unknown) => handler?.(update as never),
    get live() {
      return handler !== null;
    },
  };
}

/** Timers the test runs by hand. */
function fakeTimers() {
  const pending: { run: () => void; ms: number }[] = [];
  return {
    later: (run: () => void, ms: number) => {
      const entry = { run, ms };
      pending.push(entry);
      return () => {
        pending.splice(pending.indexOf(entry), 1);
      };
    },
    pending,
    flush: () => {
      for (const entry of pending.splice(0)) entry.run();
    },
  };
}

const upsert = (id: string, status: string, pendingPermissions: unknown[] = []) => ({
  kind: "upsert",
  agent: { id, status, pendingPermissions, archivedAt: null },
});

describe("a session that changes refetches what needs you", () => {
  test("a burst of changes is one refetch; the first sight of a session and an update that changes nothing are none", () => {
    const agents = fakeAgents();
    const timers = fakeTimers();
    let nudges = 0;
    const stop = watchSessions({
      subscribe: agents.subscribe,
      nudge: () => {
        nudges += 1;
      },
      later: timers.later,
      ms: 2_000,
      log: () => undefined,
    });
    agents.emit(upsert("a1", "running"));
    agents.emit(upsert("a2", "running"));
    expect(timers.pending).toHaveLength(0);
    agents.emit(upsert("a1", "running"));
    expect(timers.pending).toHaveLength(0);
    // A turn ends, a permission is asked: one refetch, 2 s after the first.
    agents.emit(upsert("a1", "idle"));
    agents.emit(upsert("a2", "running", [{ id: "p1" }]));
    expect(timers.pending.map((entry) => entry.ms)).toEqual([2_000]);
    timers.flush();
    expect(nudges).toBe(1);
    // A session that went is a change too; one never seen is not.
    agents.emit({ kind: "remove", agentId: "a9" });
    expect(timers.pending).toHaveLength(0);
    agents.emit({ kind: "remove", agentId: "a1" });
    timers.flush();
    expect(nudges).toBe(2);
    // Stopping unsubscribes and drops a refetch still pending.
    agents.emit(upsert("a2", "idle"));
    stop();
    expect(agents.live).toBe(false);
    expect(timers.pending).toHaveLength(0);
    expect(nudges).toBe(2);
  });

  test("a host that cannot subscribe says so once and leaves the poll", () => {
    const logs: string[] = [];
    const stop = watchSessions({
      subscribe: () => {
        throw new Error("not connected");
      },
      nudge: () => undefined,
      later: fakeTimers().later,
      ms: 2_000,
      log: (message) => logs.push(message),
    });
    stop();
    expect(logs).toEqual(["Could not listen for session changes; what needs you refreshes on its poll: not connected"]);
  });

  test("the signal is status, question and archive, nothing else", () => {
    expect(sessionSignal({ status: "idle", pendingPermissions: [], archivedAt: null })).toBe("idle:0:live");
    expect(sessionSignal({ status: "idle", pendingPermissions: [{}], archivedAt: "2026-09-29" })).toBe(
      "idle:1:archived",
    );
  });
});
