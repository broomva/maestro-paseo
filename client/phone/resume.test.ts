import { describe, expect, test } from "bun:test";
import type { DecisionAsk } from "../../shared/fleet";
import {
  askRefOf,
  cardTarget,
  DRAFT_LIMIT,
  DRAFT_TTL_MS,
  type Draft,
  draftKey,
  draftOf,
  EMPTY_RESUME,
  holdIsNew,
  openingTab,
  parseDrafts,
  parseResume,
  sweepDrafts,
  withDraft,
} from "./resume";

const NOW = 1_800_000_000_000;
const ask = (id: string, extra: Partial<DecisionAsk> = {}) =>
  ({ ledger: "mods.yaml", uid: `u-${id}`, id, hash: "h1", state: "open", scope: null, ...extra }) as DecisionAsk;
const draft = (one: DecisionAsk, at = NOW): Draft => ({
  ask: askRefOf(one),
  hash: one.hash,
  chosen: null,
  words: "draft words",
  at,
});

describe("where you left Maestro (BRO-3180 B)", () => {
  test("a stored record that is not one reads as nothing, never as a crash", () => {
    expect(parseResume({ tab: "nowhere" })).toBeUndefined();
    expect(parseResume("junk")).toBeUndefined();
    const good = parseResume({ ...EMPTY_RESUME, tab: "decisions", page: { kind: "bogus" } });
    expect(good?.tab).toBe("decisions");
    expect(good?.page).toBeNull();
  });
  test("one bad draft drops itself, never the rest", () => {
    const one = ask("A1");
    const key = draftKey(askRefOf(one));
    expect(parseDrafts({ [key]: draft(one), other: { words: 3 } })).toEqual({ [key]: draft(one) });
    expect(parseDrafts([1, 2])).toBeUndefined();
  });
  test("a draft is kept by the ask's identity, so it survives the ask moving home", () => {
    const inCheckout = ask("A1", { home: { kind: "checkout", path: "/w/a" } } as Partial<DecisionAsk>);
    const onMain = ask("A1", { home: { kind: "main" } } as Partial<DecisionAsk>);
    expect(draftKey(askRefOf(inCheckout))).toBe(draftKey(askRefOf(onMain)));
    // A fleet scope's own root ask is another ask, even with the same ledger and id.
    expect(draftKey(askRefOf(ask("A1", { scope: "sri" })))).not.toBe(draftKey(askRefOf(onMain)));
    // An ask from before v2 has no uid and goes by its id.
    expect(draftKey(askRefOf(ask("A2", { uid: null })))).toContain("A2");
  });
  test("a route's tab opens once; after that, where you left it", () => {
    const left = { ...EMPTY_RESUME, tab: "work" as const };
    expect(openingTab(null, left)).toEqual({ tab: "work", consumed: null });
    expect(openingTab("decisions", left)).toEqual({ tab: "decisions", consumed: "decisions" });
    const after = { ...left, consumed: { hold: null, tab: "decisions" } };
    expect(openingTab("decisions", after)).toEqual({ tab: "work", consumed: "decisions" });
  });
  test("a route's hold opens once per distinct value", () => {
    expect(holdIsNew("ask:x", EMPTY_RESUME)).toBe(true);
    expect(holdIsNew("ask:x", { ...EMPTY_RESUME, consumed: { hold: "ask:x", tab: null } })).toBe(false);
    expect(holdIsNew(undefined, EMPTY_RESUME)).toBe(false);
  });
  test("a draft holds a pick of yours or words; nothing is nothing", () => {
    expect(draftOf(ask("A1"), undefined, "", NOW)).toBeNull();
    expect(draftOf(ask("A1"), "maestro:other", "", NOW)?.chosen).toBe("maestro:other");
    expect(draftOf(ask("A1"), undefined, "x".repeat(2100), NOW)?.words).toHaveLength(2000);
  });
  test("at most DRAFT_LIMIT drafts are kept, the newest", () => {
    let drafts = {};
    for (let at = 0; at < DRAFT_LIMIT + 5; at += 1) {
      const one = ask(`A${at}`);
      drafts = withDraft(drafts, draftKey(askRefOf(one)), draft(one, NOW + at));
    }
    expect(Object.keys(drafts)).toHaveLength(DRAFT_LIMIT);
    expect(Object.keys(drafts)).not.toContain(draftKey(askRefOf(ask("A0"))));
  });
});

describe("drafts go only on positive evidence (BRO-3180 B)", () => {
  const open = ask("A1");
  const key = draftKey(askRefOf(open));
  const drafts = { [key]: draft(open) };
  test("a fresh, warning-free read showing the ask answered drops its draft", () => {
    expect(sweepDrafts(drafts, { asks: [ask("A1", { state: "answered" })], fresh: true, warnings: 0 }, NOW)).toEqual(
      {},
    );
  });
  test("an ask missing from the read keeps its draft: absence is no evidence", () => {
    expect(sweepDrafts(drafts, { asks: [], fresh: true, warnings: 0 }, NOW)).toEqual(drafts);
  });
  test("a read with a warning, or a stale one, deletes nothing", () => {
    const answered = [ask("A1", { state: "answered" })];
    expect(sweepDrafts(drafts, { asks: answered, fresh: true, warnings: 1 }, NOW)).toEqual(drafts);
    expect(sweepDrafts(drafts, { asks: answered, fresh: false, warnings: 0 }, NOW)).toEqual(drafts);
  });
  test("an open ask keeps its draft; one untouched past DRAFT_TTL_MS goes", () => {
    expect(sweepDrafts(drafts, { asks: [open], fresh: true, warnings: 0 }, NOW)).toEqual(drafts);
    expect(sweepDrafts(drafts, { asks: [open], fresh: true, warnings: 0 }, NOW + DRAFT_TTL_MS + 1)).toEqual({});
  });
});

describe("the card reopens on the ask it was on (BRO-3180 B)", () => {
  test("found by identity, whatever its hold key is now", () => {
    const card = { series: "s1", ask: askRefOf(ask("A2")) };
    const holds = [
      { key: "ask:home-1:A1", ask: ask("A1") },
      { key: "ask:home-2:A2", ask: ask("A2") },
    ];
    expect(cardTarget(card, holds)).toBe("ask:home-2:A2");
    expect(cardTarget(card, holds.slice(0, 1))).toBeNull();
    expect(cardTarget(null, holds)).toBeNull();
  });
});
