import { describe, expect, test } from "bun:test";
import { fakeWork } from "./fake-work";
import { headerFace, headerSpecs, needsYou, needsYouLabel, needsYouTarget } from "./header-count";

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

  test("one button per workspace, all with the same count", () => {
    expect([...headerSpecs(["ws1", "ws2"], 4)]).toEqual([
      ["ws1", { count: 4 }],
      ["ws2", { count: 4 }],
    ]);
  });
});
