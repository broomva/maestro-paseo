import { afterEach, describe, expect, test } from "bun:test";
import {
  attachIntent,
  INTENT_TTL_MS,
  type MaestroIntent,
  requestIntent,
  resetIntents,
  subscribeIntent,
  takeIntent,
} from "./intent";

afterEach(() => {
  resetIntents();
});

describe("intent", () => {
  test("an intent is taken once", () => {
    requestIntent({ kind: "select", id: "w1" });
    expect(takeIntent()).toEqual({ kind: "select", id: "w1" });
    expect(takeIntent()).toBeNull();
  });

  test("a later request replaces an untaken one", () => {
    requestIntent({ kind: "new" });
    requestIntent({ kind: "filter", group: "review" });
    expect(takeIntent()).toEqual({ kind: "filter", group: "review" });
  });

  test("an intent nobody took goes stale instead of firing later", () => {
    requestIntent({ kind: "new" }, 1_000);
    expect(takeIntent(1_000 + INTENT_TTL_MS + 1)).toBeNull();
    requestIntent({ kind: "new" }, 1_000);
    expect(takeIntent(1_000 + INTENT_TTL_MS)).toEqual({ kind: "new" });
  });

  test("a surface that mounts after the request takes it at once", () => {
    requestIntent({ kind: "select", id: "w3" });
    const seen: MaestroIntent[] = [];
    const stop = attachIntent((intent) => seen.push(intent));
    expect(seen).toEqual([{ kind: "select", id: "w3" }]);
    stop();
  });

  test("a mounted surface takes each new request, and stops when it unmounts", () => {
    const seen: MaestroIntent[] = [];
    const stop = attachIntent((intent) => seen.push(intent));
    requestIntent({ kind: "new" });
    requestIntent({ kind: "select", id: "w2" });
    stop();
    requestIntent({ kind: "new" });
    expect(seen).toEqual([{ kind: "new" }, { kind: "select", id: "w2" }]);
    expect(takeIntent()).toEqual({ kind: "new" });
  });

  test("with two surfaces mounted, the newest one takes the intent", () => {
    const older: MaestroIntent[] = [];
    const newer: MaestroIntent[] = [];
    const stopOlder = attachIntent((intent) => older.push(intent));
    const stopNewer = attachIntent((intent) => newer.push(intent));
    requestIntent({ kind: "filter", group: "blocked" });
    expect(newer).toEqual([{ kind: "filter", group: "blocked" }]);
    expect(older).toEqual([]);
    stopOlder();
    stopNewer();
  });

  test("a raw subscriber hears each request", () => {
    let heard = 0;
    const stop = subscribeIntent(() => {
      heard += 1;
    });
    requestIntent({ kind: "new" });
    requestIntent({ kind: "new" });
    stop();
    requestIntent({ kind: "new" });
    expect(heard).toBe(2);
  });
});
