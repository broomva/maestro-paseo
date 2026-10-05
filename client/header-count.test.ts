import { describe, expect, test } from "bun:test";
import { fakeWork } from "./fake-work";
import { headerFace, headerSpecs, needsYou, needsYouCount, needsYouLabel, needsYouTarget } from "./header-count";
import { applyFilter } from "./plane-model";

describe("the header count", () => {
  test("counts work at your gate and stuck work, nothing else", () => {
    const items = [
      fakeWork("r", "review"),
      fakeWork("b", "blocked"),
      fakeWork("run", "running"),
      fakeWork("q", "proposed"),
      fakeWork("d", "done"),
      fakeWork("c", "canceled"),
    ];
    expect(needsYou(items).map((item) => item.id)).toEqual(["r", "b"]);
  });

  test("counts work the loop flagged too, whatever its group", () => {
    const at = "2026-09-29T09:30:00.000Z";
    const items = [
      fakeWork("r", "review"),
      fakeWork("yours", "proposed", null, { flag: { kind: "yours", reason: "Start it yourself: x.", at } }),
      fakeWork("failed", "triggered", null, { flag: { kind: "failed", reason: "Could not start: x.", at } }),
      fakeWork("quiet", "running", null, {
        flag: { kind: "quiet", reason: "Quiet for 31 minutes, worth a look.", at },
      }),
      fakeWork("q", "proposed"),
      fakeWork("run", "running"),
    ];
    expect(needsYou(items).map((item) => item.id)).toEqual(["r", "yours", "failed", "quiet"]);
    // One flagged item alone opens it; with others it opens Needs you, whose chip lists it too.
    expect(needsYouTarget([items[3] as (typeof items)[number], fakeWork("x", "running")])).toEqual({
      kind: "select",
      id: "quiet",
    });
    expect(needsYouTarget([fakeWork("b", "blocked"), items[1] as (typeof items)[number]])).toEqual({
      kind: "filter",
      group: "review",
    });
  });

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

  test("opens the one item that waits, else Needs you, else Stuck when only stuck work waits", () => {
    expect(needsYouTarget([fakeWork("r", "review"), fakeWork("x", "running")])).toEqual({ kind: "select", id: "r" });
    expect(needsYouTarget([fakeWork("b", "blocked")])).toEqual({ kind: "select", id: "b" });
    expect(needsYouTarget([fakeWork("r1", "review"), fakeWork("r2", "review")])).toEqual({
      kind: "filter",
      group: "review",
    });
    expect(needsYouTarget([fakeWork("r", "review"), fakeWork("b", "blocked")])).toEqual({
      kind: "filter",
      group: "review",
    });
    expect(needsYouTarget([fakeWork("b1", "blocked"), fakeWork("b2", "blocked")])).toEqual({
      kind: "filter",
      group: "blocked",
    });
    expect(needsYouTarget([])).toEqual({ kind: "filter", group: "review" });
  });

  test("the filter it opens lists everything it counted, stuck and flagged work mixed in", () => {
    const at = "2026-09-29T09:30:00.000Z";
    const flagged = fakeWork("f", "proposed", null, { flag: { kind: "yours", reason: "Start it yourself: x.", at } });
    const quiet = fakeWork("q", "running", null, { flag: { kind: "quiet", reason: "Quiet for 31 minutes.", at } });
    const mixes = [
      [fakeWork("b", "blocked"), flagged],
      [fakeWork("b", "blocked"), quiet, fakeWork("x", "running")],
      [fakeWork("r", "review"), fakeWork("b", "blocked")],
      [fakeWork("r", "review"), fakeWork("b", "blocked"), flagged, quiet],
      [fakeWork("b1", "blocked"), fakeWork("b2", "blocked")],
    ];
    for (const items of mixes) {
      const target = needsYouTarget(items);
      expect(target.kind).toBe("filter");
      if (target.kind !== "filter") continue;
      const listed = applyFilter(items, target.group).map((item) => item.id);
      expect(listed).toEqual(expect.arrayContaining(needsYou(items).map((item) => item.id)));
    }
  });

  test("one button per workspace, all with the same count", () => {
    expect([...headerSpecs(["ws1", "ws2"], 4)]).toEqual([
      ["ws1", { count: 4 }],
      ["ws2", { count: 4 }],
    ]);
  });
});

describe("the fleet in the header count", () => {
  test("each fleet notice counts once beside the work", () => {
    const items = [fakeWork("r", "review"), fakeWork("run", "running")];
    expect(needsYouCount(items)).toBe(1);
    expect(needsYouCount(items, [{ scope: "broomva" }, { scope: "sri" }])).toBe(3);
  });

  test("only stuck work and a fleet notice open Needs you, not Stuck, which would hide the notice's view", () => {
    const stuck = [fakeWork("b", "blocked"), fakeWork("c", "blocked")];
    expect(needsYouTarget(stuck)).toEqual({ kind: "filter", group: "blocked" });
    expect(needsYouTarget(stuck, [{ scope: "broomva" }])).toEqual({
      kind: "filter",
      group: "review",
    });
    expect(needsYouTarget([], [{ scope: "broomva" }])).toEqual({ kind: "fleet", scope: "broomva" });
  });
});

describe("the timeline in the header count", () => {
  const notice = (id: string) => ({ id });

  test("each timeline notice counts once, beside the work and the fleet's", () => {
    const items = [fakeWork("r", "review"), fakeWork("run", "running")];
    expect(needsYouCount(items, [], [notice("launchd:com.broomva.kg-lint")])).toBe(2);
    expect(needsYouCount(items, [{ scope: "broomva" }], [notice("a"), notice("b")])).toBe(4);
  });

  test("only timeline notices open the Timeline; with the fleet's too, the Fleet; with work, Needs you", () => {
    expect(needsYouTarget([], [], [notice("a")])).toEqual({ kind: "timeline" });
    expect(needsYouTarget([], [{ scope: "broomva" }], [notice("a")])).toEqual({ kind: "fleet", scope: "broomva" });
    // One item and a timeline notice: not that one item, since the count is two.
    expect(needsYouTarget([fakeWork("r", "review")], [], [notice("a")])).toEqual({ kind: "filter", group: "review" });
    // Only stuck work and a notice: Needs you, not Stuck, where the notice shows above the list.
    expect(needsYouTarget([fakeWork("b", "blocked")], [], [notice("a")])).toEqual({ kind: "filter", group: "review" });
  });

  test("each decision ask that waits on you counts once; with only asks, the count opens the Fleet view's Decisions", () => {
    const ask = (scope: string | null) => ({ scope });
    expect(needsYouCount([fakeWork("r", "review")], [], [], [ask(null), ask("broomva")])).toBe(3);
    expect(needsYouTarget([], [], [], [ask(null)])).toEqual({ kind: "fleet", scope: null });
    expect(needsYouTarget([], [], [notice("a")], [ask("broomva")])).toEqual({ kind: "fleet", scope: "broomva" });
    // With work as well: Needs you, where the asks' notice shows above the list.
    expect(needsYouTarget([fakeWork("r", "review")], [], [], [ask(null)])).toEqual({ kind: "filter", group: "review" });
  });
});

describe("initiatives past their date", () => {
  const stale = [{ id: "maestro" }];
  test("count in Needs you, and alone open Initiatives", () => {
    expect(needsYouCount([], [], [], [], stale)).toBe(1);
    expect(needsYouTarget([], [], [], [], stale)).toEqual({ kind: "initiatives" });
    // With work waiting, the work wins: the notice sits above every other view.
    expect(needsYouTarget([fakeWork("r", "review")], [], [], [], stale)).toEqual({ kind: "filter", group: "review" });
    // A fleet notice or an ask is opened first, as before.
    expect(needsYouTarget([], [], [], [{ scope: null }], stale)).toEqual({ kind: "fleet", scope: null });
  });
});
