import { describe, expect, test } from "bun:test";
import {
  collapseRepeats,
  eventFleetPlace,
  eventTitle,
  fleetOriginOf,
  placeText,
  repeatText,
  repeatWords,
  titleText,
} from "./records-text";

const base = { initiative: null, project: null, repo: null } as const;

describe("titles and places as a person reads them", () => {
  test("the daemon's display title wins; without one, the fleet marker is dropped", () => {
    const title = "1 ask (tick 7) [fleet-reconcile sri batch 7-3]";
    expect(titleText({ title, display: { title: "The core comparison…", fleet: null } })).toBe("The core comparison…");
    expect(titleText({ title })).toBe("1 ask (tick 7)");
    expect(titleText({ title: "Ship the cart" })).toBe("Ship the cart");
    expect(titleText({ title: "Ship the cart", display: { title: "", fleet: null } })).toBe("Ship the cart");
  });

  test("fleet work's place is the fleet's words, never its run folder", () => {
    const fleet = { scope: "sri", what: "batch 7-3", tick: "7" };
    const item = {
      ...base,
      title: "1 ask (tick 7) [fleet-reconcile sri batch 7-3]",
      initiative: "fleet-reconcile-sri",
      project: "maestro-asks",
    };
    expect(placeText({ ...item, display: { title: "x", fleet } })).toBe("fleet · sri");
    // An older daemon sends no display: the title's marker still says it.
    expect(placeText(item)).toBe("fleet · sri");
  });

  test("other work's place reads initiative · project, or the repo's name", () => {
    expect(placeText({ ...base, title: "x", initiative: "holon", project: "broomva" })).toBe("holon · broomva");
    expect(placeText({ ...base, title: "x", initiative: "holon", repo: "/Users/me/broomva" })).toBe("holon · broomva");
    expect(placeText({ ...base, title: "x", initiative: "holon", project: "holon" })).toBe("holon");
    expect(placeText({ ...base, title: "x" })).toBeNull();
  });

  test("History's titles and places follow the same rules", () => {
    const title = "2 asks (tick 42) [fleet-reconcile broomva batch 42-2]";
    expect(eventTitle({ title, heading: "Merge it?" })).toBe("Merge it?");
    expect(eventTitle({ title })).toBe("2 asks (tick 42)");
    expect(eventFleetPlace({ title })).toBe("fleet · broomva");
    expect(eventFleetPlace({ title: "Ship the cart" })).toBeNull();
  });
});

describe("repeated receipts", () => {
  const turn = (ts: string, detail: string | null = "Yes, there are two now.") => ({
    ts,
    type: "turn.ended",
    text: "Turn finished",
    detail,
    actor: "agent",
  });

  test("a run of identical neighbours is said once with its count; order, the newest and the oldest are kept", () => {
    const events = [turn("3"), turn("2"), turn("1"), { ...turn("0"), type: "state", text: "Done", detail: null }];
    const out = collapseRepeats(events);
    expect(out.map(({ event, count, last }) => [event.ts, count, last.ts])).toEqual([
      ["3", 3, "1"],
      ["0", 1, "0"],
    ]);
  });

  test("different words, details, kinds, actors or work are never merged, nor are repeats apart", () => {
    const events = [turn("4"), turn("3", "Something else"), turn("2"), { ...turn("1"), text: "Turn failed" }];
    expect(collapseRepeats(events).map(({ count }) => count)).toEqual([1, 1, 1, 1]);
    expect(collapseRepeats([turn("2"), { ...turn("1"), actor: "human" }]).map(({ count }) => count)).toEqual([1, 1]);
    const across = [
      { ...turn("2"), itemId: "a" },
      { ...turn("1"), itemId: "b" },
    ];
    expect(collapseRepeats(across).map(({ count }) => count)).toEqual([1, 1]);
    expect(collapseRepeats([])).toEqual([]);
  });

  test("the count reads with the run's time range, and nothing for one", () => {
    const when = (ts: string) => `${ts}h`;
    const [run] = collapseRepeats([turn("1"), turn("2"), turn("3")]);
    if (!run) throw new Error("no run");
    expect(repeatText(run, when)).toBe("\u00d73 · 3h\u20131h");
    expect(repeatWords(run, when)).toBe("3 times in a row, from 3h to 1h");
    const [same] = collapseRepeats([turn("1"), turn("1")]);
    if (!same) throw new Error("no run");
    expect(repeatText(same, when)).toBe("\u00d72 · 1h");
    const [one] = collapseRepeats([turn("1")]);
    if (!one) throw new Error("no run");
    expect(repeatText(one, when)).toBe("");
  });

  test("fleet origin: the daemon's, else read from the title", () => {
    expect(fleetOriginOf({ title: "x [fleet-reconcile sri batch 7-3]" })).toEqual({
      scope: "sri",
      what: "batch 7-3",
      tick: "7",
    });
    expect(fleetOriginOf({ title: "Ship the cart" })).toBeNull();
  });
});
