import { describe, expect, test } from "bun:test";
import { needsOf } from "../server/needs";
import type { AnswersLanding } from "../shared/answers";
import type { DecisionAsk } from "../shared/fleet";
import type { Initiative } from "../shared/initiatives";
import { askHoldKey, type Needs } from "../shared/needs";
import { fakeWork } from "./fake-work";
import {
  headerFace,
  headerSpecs,
  holdsByTab,
  holdTarget,
  needsTarget,
  needsYouLabel,
  tabBadges,
  tabOf,
} from "./header-count";

const NOW = Date.parse("2026-10-10T15:00:00.000Z");
const live = { agentId: "agent-1", workspaceId: "ws1" };

const ask = (id: string, extra: Partial<DecisionAsk> = {}): DecisionAsk => ({
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
  ...extra,
});

const review = (id: string): Initiative =>
  ({
    id,
    file: `${id}.yaml`,
    title: id,
    quote: null,
    summary: null,
    nextAction: null,
    driver: null,
    waitingOn: [],
    sessions: [],
    stale: { kind: "overdue", date: "2026-10-08" },
  }) as unknown as Initiative;

const landing: AnswersLanding = {
  stage: "waiting",
  pending: 1,
  asks: [],
  pr: { number: 915, url: "https://github.com/broomva/workspace/pull/915" },
  conflict: null,
  error: null,
  landed: null,
  checkedAt: "2026-10-10T14:00:00.000Z",
};

const needsFrom = (parts: {
  items?: Parameters<typeof needsOf>[0]["items"];
  asks?: DecisionAsk[];
  reviews?: Initiative[];
  landing?: AnswersLanding | null;
}): Needs =>
  needsOf(
    {
      items: parts.items ?? [],
      asks: parts.asks ?? [],
      reviews: parts.reviews ?? [],
      landing: parts.landing ?? null,
      workspace: "broomva",
    },
    NOW,
  );

describe("the header count", () => {
  test("says it in words, singular and plural", () => {
    expect(needsYouLabel(1)).toBe("1 needs you");
    expect(needsYouLabel(3)).toBe("3 need you");
  });

  test("is shown only while something needs you, and names Maestro in its title", () => {
    expect(headerFace(0).visible).toBe(false);
    expect(headerFace(2)).toEqual({
      title: "2 need you in Maestro",
      label: "2 need you",
      icon: "Inbox",
      visible: true,
    });
  });

  test("one button per workspace, all with the same count", () => {
    expect([...headerSpecs(["ws1", "ws2"], 4)]).toEqual([
      ["ws1", { count: 4 }],
      ["ws2", { count: 4 }],
    ]);
  });
});

describe("where a hold opens", () => {
  test("its work item, its ask in Decisions by its full identity, its initiative, the answers batch in Decisions", () => {
    const one = ask("A1", { uid: "u-1" });
    expect(holdTarget({ key: "work:abc" })).toEqual({ kind: "select", id: "abc" });
    expect(holdTarget({ key: askHoldKey(one) })).toEqual({
      kind: "decisions",
      ledger: null,
      id: "A1",
      key: '["origin/main","bro-3001.yaml","u-1","A1"]',
    });
    expect(holdTarget({ key: "review:skene" })).toEqual({ kind: "initiatives" });
    expect(holdTarget({ key: "answers:batch" })).toEqual({ kind: "decisions" });
    expect(holdTarget({ key: "nonsense" })).toEqual({ kind: "filter", group: "review" });
    expect([tabOf({ key: "work:a" }), tabOf({ key: askHoldKey(one) }), tabOf({ key: "review:x" })]).toEqual([
      "feed",
      "decisions",
      "initiatives",
    ]);
  });

  test("the count opens the one hold; only asks, Decisions; only reviews, Initiatives; else the Feed's Needs you", () => {
    expect(needsTarget(needsFrom({ items: [fakeWork("r", "review", live)] }))).toEqual({ kind: "select", id: "r" });
    expect(needsTarget(needsFrom({ asks: [ask("A1"), ask("A2")], landing }))).toEqual({ kind: "decisions" });
    expect(needsTarget(needsFrom({ reviews: [review("a"), review("b")] }))).toEqual({ kind: "initiatives" });
    expect(needsTarget(needsFrom({ items: [fakeWork("r", "review", live)], asks: [ask("A1")] }))).toEqual({
      kind: "filter",
      group: "review",
    });
    expect(needsTarget(needsFrom({}))).toEqual({ kind: "filter", group: "review" });
  });

  test("stuck work and a quiet run never reach the count (owner answer A1)", () => {
    const at = "2026-10-10T12:00:00.000Z";
    const needs = needsFrom({
      items: [
        fakeWork("b", "blocked", live),
        fakeWork("q", "running", live, { flag: { kind: "quiet", reason: "Quiet.", at } }),
        fakeWork("y", "proposed", null, { flag: { kind: "yours", reason: "Held.", at } }),
      ],
    });
    expect(needs.summary.total).toBe(1);
    expect(needsTarget(needs)).toEqual({ kind: "select", id: "y" });
  });
});

describe("the tabs' badges (BRO-3001)", () => {
  const needs = needsFrom({
    items: [fakeWork("r", "review", live), fakeWork("b", "blocked", live)],
    asks: [ask("A1"), ask("A2", { blocking: false, waiting: false })],
    reviews: [review("skene")],
    landing,
  });

  test("the Feed carries the total; Decisions and Initiatives the holds each lists; none where none is", () => {
    const badges = tabBadges(needs);
    expect(badges.feed).toEqual({ count: 4, warn: true, label: "4 need you" });
    expect(badges.decisions).toEqual({ count: 2, warn: true, label: "2 wait on you" });
    expect(badges.initiatives).toEqual({ count: 1, warn: true, label: "1 review is due" });
    expect(tabBadges(needsFrom({}))).toEqual({ feed: null, decisions: null, initiatives: null });
  });

  test("each badge is a length of needs.list's rows, and the tabs' rows add up to the total", () => {
    const tabs = holdsByTab(needs.rows);
    expect(tabs).toEqual({ feed: 1, decisions: 2, initiatives: 1 });
    expect(tabs.feed + tabs.decisions + tabs.initiatives).toBe(needs.summary.total);
    expect(tabBadges(needs).feed?.count).toBe(needs.rows.length);
  });
});
