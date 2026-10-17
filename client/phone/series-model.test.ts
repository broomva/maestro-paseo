import { describe, expect, test } from "bun:test";
import type { NeedRow } from "../../shared/needs";
import type { NeedEntry } from "../feed-model";
import type { DecisionCard, DeckLane } from "./model";
import {
  askSeries,
  endWords,
  firstOfVisit,
  marked,
  navigable,
  nextInVisit,
  seriesLine,
  seriesWith,
  startVisit,
  visitKeys,
} from "./series-model";

const NOW = Date.parse("2026-10-17T02:00:00.000Z");
const H = 3_600_000;

function askKeyOf(ledger: string, id: string): string {
  return `ask:${JSON.stringify([null, ledger, null, id])}`;
}

function card(
  key: string,
  opts: { scope?: string; lane?: DeckLane; since?: string; blocks?: boolean } = {},
): DecisionCard {
  const row = {
    kind: "ask",
    key,
    title: `Q ${key}`,
    scope: opts.scope ?? "sri",
    since: opts.since ?? new Date(NOW - H).toISOString(),
    blocksWork: opts.blocks ?? false,
    verbs: ["answer"],
    body: { why: "", cost: "", options: [], goesTo: "" },
  } as unknown as NeedRow;
  const entry: NeedEntry = { row, item: null, ask: null };
  return { entry, lane: opts.lane ?? "open" };
}

describe("askSeries", () => {
  test("groups by scope and ledger, in the deck's order, with counts", () => {
    const a1 = askKeyOf("lucky-mule.yaml", "Q1");
    const b1 = askKeyOf("other.yaml", "Q1");
    const a2 = askKeyOf("lucky-mule.yaml", "Q2");
    const ws = askKeyOf("lucky-mule.yaml", "Q3");
    const series = askSeries([
      card(a1, { lane: "waits", blocks: true, since: new Date(NOW - 12 * H).toISOString() }),
      card(b1),
      card(a2, { lane: "idea" }),
      card(ws, { scope: "broomva" }),
    ]);
    expect(series.map((one) => one.id)).toEqual(["sri/lucky-mule.yaml", "sri/other.yaml", "broomva/lucky-mule.yaml"]);
    const [first] = series;
    expect(first?.title).toBe("sri · lucky-mule");
    expect(first?.keys).toEqual([a1, a2]);
    expect(first && seriesLine(first, NOW)).toBe("2 open · 1 waits on you · 1 idea · 12h");
    expect(first?.blocking).toBe(true);
    expect(seriesWith(series, a2)?.id).toBe("sri/lucky-mule.yaml");
  });

  test("the answers batch and an unparseable key are series of one; no card is dropped", () => {
    const series = askSeries([card("answers:batch"), card("ask:not-json"), card(askKeyOf("l.yaml", "A"))]);
    expect(series.map((one) => one.id)).toEqual(["answers:batch", "ask:not-json", "sri/l.yaml"]);
    expect(series.flatMap((one) => one.keys)).toHaveLength(3);
  });
});

describe("a visit", () => {
  const keys = ["a", "b", "c", "d"];
  const visit = startVisit({
    id: "s",
    title: "sri · l",
    keys,
    open: 4,
    waits: 0,
    ideas: 0,
    blocking: false,
    oldest: "",
  });

  test("an answer keeps its place after it leaves the read; a new key joins at the end", () => {
    const after = marked(visit, "a", "answered");
    expect(visitKeys(after, ["b", "c", "d", "e"])).toEqual(["a", "b", "c", "d", "e"]);
    // An unanswered key that left the read (answered elsewhere) leaves the list.
    expect(visitKeys(after, ["b", "d"])).toEqual(["a", "b", "d"]);
  });

  test("advance on answer: the next key the card may show, skipping waiting and answered ones, never wrapping", () => {
    const live = ["a", "b", "c", "d"];
    const answered = marked(marked(visit, "a", "answered"), "c", "answered");
    const ok = (key: string) => navigable(key, live, new Set(["b"]), answered);
    expect(nextInVisit(keys, "a", ok)).toBe("d");
    expect(nextInVisit(keys, "d", ok)).toBeNull();
    expect(nextInVisit(keys, "d", ok, -1)).toBeNull();
    expect(firstOfVisit(keys, ok)).toBe("d");
  });

  test("an undone answer may be shown again", () => {
    const answered = marked(visit, "a", "answered");
    expect(navigable("a", keys, new Set(), answered)).toBe(false);
    expect(navigable("a", keys, new Set(), marked(answered, "a", "undone"))).toBe(true);
  });

  test("the end says the series and what was skipped", () => {
    expect(endWords(visit)).toBe("sri · l: nothing left to answer");
    expect(endWords(marked(visit, "b", "skipped"))).toBe("sri · l: nothing left to answer · 1 skipped");
  });
});
