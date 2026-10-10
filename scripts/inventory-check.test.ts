import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { check, type Inventory, load } from "./inventory-check";

const root = join(import.meta.dir, "..");

// The smallest inventory that passes every rule: one hold, one page, one verb, one store, one loop.
function clean(): Inventory {
  return structuredClone({
    version: 1,
    features: {
      "F-need-ask": { name: "Ask", status: "keep", kind: "need", pages: ["P-feed"], interfaces: ["I-answer"] },
      "F-sweep": { name: "Sweep", status: "keep", kind: "watch", interfaces: ["I-sweep"] },
    },
    pages: {
      "P-feed": {
        name: "Feed",
        status: "keep",
        frame: "gcul5",
        png: "j1-feed-home.png",
        phone_frame: "FKTsX",
        phone_png: "m1-feed-home-mobile.png",
        components: ["C-card"],
        reads: ["I-needs"],
        writes: ["I-answer"],
      },
    },
    components: { "C-card": { name: "Card", status: "keep" } },
    interfaces: {
      "I-answer": {
        name: "answer",
        status: "keep",
        handler: "plugin",
        callers: ["ui"],
        gate: "owner",
        stores: ["S-asks"],
      },
      "I-needs": { name: "needs.list", status: "keep", handler: "plugin", callers: ["ui"] },
      "I-sweep": { name: "sweep", status: "keep", handler: "plugin", callers: ["plugin"] },
    },
    stores: { "S-asks": { name: "asks", status: "keep", owner: "plugin", modules: ["server/control-asks.ts"] } },
    loops: {
      "L-sweep": { name: "sweep", status: "keep", scheduler: "plugin cron", owner: "plugin", calls: ["I-sweep"] },
    },
    findings: {
      "FND-x": {
        name: "x",
        severity: "major",
        state: "open",
        about: ["I-sweep"],
        ticket: "BRO-1",
        code: ["server/loop.ts:1"],
      },
    },
  } as Inventory);
}

const findings = (mutate: (i: Inventory) => void) => {
  const inv = clean();
  mutate(inv);
  return check(inv, root);
};

describe("inventory-check", () => {
  test("the fixture is clean", () => {
    expect(check(clean(), root)).toEqual([]);
  });

  test("the real inventory is clean", () => {
    expect(check(load(root), root)).toEqual([]);
  });

  // One mutant per rule: each must produce the finding that names it.
  const mutants: [string, (i: Inventory) => void, RegExp][] = [
    ["wrong prefix", (i) => (i.pages["X-feed"] = { ...i.pages["P-feed"] }), /must start with P-/],
    ["bad status", (i) => (i.components["C-card"].status = "maybe" as never), /is not one of/],
    ["missing code", (i) => (i.components["C-card"].code = ["client/nope.tsx:1"]), /does not exist/],
    [
      "dangling edge",
      (i) => i.features["F-need-ask"].interfaces?.push("I-ghost"),
      /I-ghost, which is not in interfaces/,
    ],
    ["unreachable feature", (i) => (i.features["F-need-ask"].pages = []), /no page shows it and no loop runs it/],
    ["feature without interface", (i) => (i.features["F-sweep"].interfaces = []), /no interface carries it/],
    ["live feature on retired page", (i) => (i.pages["P-feed"].status = "retire"), /live feature on retired page/],
    ["a fourth hold", (i) => (i.features["F-sweep"].kind = "need"), /reserved for the three holds/],
    [
      "orphan page",
      (i) => (i.pages["P-extra"] = { name: "Extra", status: "new", frame: "x", components: ["C-card"] }),
      /no feature lives on this page/,
    ],
    ["page without frame", (i) => delete i.pages["P-feed"].frame, /no design frame/],
    [
      "page on a reference export",
      (i) => (i.pages["P-feed"].png = "s1-feed-home.png"),
      /s1-feed-home.png is a reference, not the chosen design/,
    ],
    [
      "phone export missing",
      (i) => (i.pages["P-feed"].phone_png = "m99-nope.png"),
      /phone export m99-nope.png is missing/,
    ],
    [
      "phone export from the desktop series",
      (i) => (i.pages["P-feed"].phone_png = "j1-feed-home.png"),
      /phone export j1-feed-home.png is not an M or P frame/,
    ],
    [
      "phone frame without export",
      (i) => delete i.pages["P-feed"].phone_png,
      /phone_frame and phone_png come together/,
    ],
    ["missing export", (i) => (i.pages["P-feed"].png = "nope.png"), /export nope.png is missing/],
    [
      "dead component",
      (i) => (i.components["C-dead"] = { name: "Dead", status: "keep" }),
      /C-dead: no live page uses it/,
    ],
    [
      "uncalled interface",
      (i) => (i.interfaces["I-lonely"] = { name: "x", status: "new", handler: "plugin" }),
      /no live feature, page or loop calls it/,
    ],
    ["unknown layer", (i) => (i.interfaces["I-needs"].handler = "cloud"), /is not a layer/],
    ["agent calls a gate verb", (i) => i.interfaces["I-answer"].callers?.push("worker"), /owner gate verb is callable/],
    ["plugin launches", (i) => (i.interfaces["I-sweep"].launches = true), /only the conductor or a lane may/],
    [
      "written from another layer",
      (i) => (i.stores["S-asks"].owner = "bstack"),
      /written by I-answer from plugin, but bstack owns it/,
    ],
    [
      "plugin store nobody writes",
      (i) => (i.interfaces["I-answer"].stores = []),
      /owned by plugin, yet no live interface writes it/,
    ],
    [
      "two writer modules",
      (i) => i.stores["S-asks"].modules?.push("server/answer-routes.ts"),
      /2 writer modules .* one, or an exception with a ticket/,
    ],
    ["unknown key", (i) => Object.assign(i.components["C-card"], { " secondary": null }), /unknown key " secondary"/],
    ["untracked today frame", (i) => (i.pages["P-feed"].frame = "today"), /frame "today" with no finding tracking it/],
    [
      "page on a retired interface",
      (i) => (i.interfaces["I-needs"].status = "retire"),
      /P-feed: uses retired interface I-needs/,
    ],
    ["replaced by a ghost", (i) => (i.pages["P-feed"].replaced_by = ["P-ghost"]), /P-ghost, which is not in pages/],
    ["loop without scheduler", (i) => delete i.loops["L-sweep"].scheduler, /no scheduler/],
    ["finding without ticket", (i) => delete i.findings?.["FND-x"].ticket, /a major finding needs a ticket/],
    [
      "finding about a ghost",
      (i) => i.findings?.["FND-x"].about.push("P-ghost"),
      /about P-ghost, which is not in the inventory/,
    ],
    [
      "finding cites missing code",
      (i) => i.findings?.["FND-x"].code?.push("server/nope.ts:3"),
      /cites server\/nope.ts:3/,
    ],
  ];

  for (const [name, mutate, want] of mutants) {
    test(`flags: ${name}`, () => {
      expect(findings(mutate).join("\n")).toMatch(want);
    });
  }

  test("two writer modules pass only with a ticketed exception", () => {
    const two = (exception: string) => (i: Inventory) => {
      i.stores["S-asks"].modules?.push("server/answer-routes.ts");
      i.stores["S-asks"].exception = exception;
    };
    expect(findings(two("legacy"))).not.toEqual([]);
    expect(findings(two("two appenders until BRO-2999"))).toEqual([]);
  });

  test("a store owned outside the plugin may have no writer here", () => {
    expect(findings((i) => (i.stores["S-fleet"] = { name: "fleet state", status: "keep", owner: "bstack" }))).toEqual(
      [],
    );
  });

  test("a plugin loop may not call a launching interface even if a lane handles it", () => {
    const out = findings((i) => {
      i.interfaces["I-sweep"].launches = true;
      i.interfaces["I-sweep"].handler = "lane";
    });
    expect(out.join("\n")).toMatch(/a plugin loop calls I-sweep, which launches a session/);
  });
});
