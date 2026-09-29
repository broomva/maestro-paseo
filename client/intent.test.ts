import { afterEach, describe, expect, test } from "bun:test";
import { requestIntent, subscribeIntent, takeIntent } from "./intent";

afterEach(() => {
  takeIntent();
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

  test("a subscriber hears each request and can take it", () => {
    const seen: unknown[] = [];
    const stop = subscribeIntent(() => seen.push(takeIntent()));
    requestIntent({ kind: "new" });
    requestIntent({ kind: "select", id: "w2" });
    stop();
    requestIntent({ kind: "new" });
    expect(seen).toEqual([{ kind: "new" }, { kind: "select", id: "w2" }]);
    expect(takeIntent()).toEqual({ kind: "new" });
  });
});
