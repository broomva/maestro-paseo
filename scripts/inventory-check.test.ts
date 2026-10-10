import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, contractDrift, type Inventory, load, missingFrames, penIds } from "./inventory-check";

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
        frame: "E4dLZ1",
        png: "j1-feed-home.png",
        phone_frame: "FKTsX",
        phone_png: "m1-feed-home-mobile.png",
        components: ["C-card"],
        reads: ["I-needs"],
        writes: ["I-answer", "I-undo"],
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
      "I-undo": { name: "undo", status: "keep", handler: "plugin", callers: ["ui"], gate: "owner" },
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

  const contract = () => readFileSync(join(root, "docs/design/next/view-models.md"), "utf8");
  test("view-models.md and the inventory agree on every live page", () => {
    expect(contractDrift(load(root), contract())).toEqual([]);
  });
  test("every frame and component id the inventory names exists in the saved .pen", () => {
    expect(missingFrames(load(root), penIds(root))).toEqual([]);
  });
  test("a frame missing from the .pen is caught", () => {
    const inv = load(root);
    inv.pages["P-feed"].frame = "NOPE9";
    inv.components["C-inspector"].pen = "NOPE8";
    const out = missingFrames(inv, penIds(root)).join("\n");
    expect(out).toMatch(/P-feed: frame NOPE9 is not in maestro-next.pen/);
    expect(out).toMatch(/C-inspector: pen NOPE8 is not in maestro-next.pen/);
  });
  test("a duplicated contract row is caught", () => {
    const md = contract();
    const row = md.split("\n").find((l) => l.startsWith("| P-feed "));
    expect(contractDrift(load(root), `${md}\n${row}`).join("\n")).toMatch(/P-feed: two rows in view-models.md/);
  });
  test("contract drift is caught: an extra write, a missing row, an unknown page", () => {
    const inv = load(root);
    inv.pages["P-work"].writes?.push("I-work-unblock");
    expect(contractDrift(inv, contract()).join("\n")).toMatch(/P-work: view-models.md writes/);
    expect(contractDrift(load(root), contract().replace(/^\| P-presence .*$/m, "")).join("\n")).toMatch(
      /P-presence: no row in view-models.md/,
    );
    expect(contractDrift(load(root), `${contract()}\n| P-ghost | x | I-needs-list | | |`).join("\n")).toMatch(
      /P-ghost: in view-models.md but not in the inventory/,
    );
  });

  // One mutant per rule: each must produce the finding that names it. A rule added without a mutant is
  // a rule nobody has seen fire.
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
    [
      "owner verb without undo",
      (i) => {
        i.pages["P-feed"].writes = ["I-answer"];
      },
      /writes owner verbs \(I-answer\) without I-undo/,
    ],
    [
      "phone export as the desktop png",
      (i) => (i.pages["P-feed"].png = "m1-feed-home-mobile.png"),
      /is a phone export; the desktop export goes in png/,
    ],
    [
      "undo page missing from F-undo",
      (i) => {
        i.features["F-undo"] = { name: "Undo", status: "keep", kind: "control", pages: [], interfaces: ["I-undo"] };
      },
      /P-feed: writes I-undo but F-undo does not list it/,
    ],
    [
      "phone export without frame",
      (i) => delete i.pages["P-feed"].phone_frame,
      /phone_frame and phone_png come together/,
    ],
    ["page without export", (i) => delete i.pages["P-feed"].png, /P-feed: no export \(png\) for its frame/],
    ["frame is a reference", (i) => (i.pages["P-feed"].frame = "gcul5"), /frame gcul5 is a reference/],
    [
      "phone frame is a reference",
      (i) => (i.pages["P-feed"].phone_frame = "FcV4R"),
      /phone frame FcV4R is a reference/,
    ],
    ["rejected phone variant", (i) => (i.pages["P-feed"].png = "m1a-top-tabs.png"), /m1a-top-tabs.png is a reference/],
    [
      "diagram as a page export",
      (i) => (i.pages["P-feed"].png = "b1-one-tap-approvals.png"),
      /b1-one-tap-approvals.png is a reference/,
    ],
    [
      "today page with an export",
      (i) => {
        i.pages["P-feed"].frame = "today";
        i.findings?.["FND-x"].about.push("P-feed");
      },
      /a "today" page has no design, so it carries no export/,
    ],
    ["empty export string", (i) => (i.pages["P-feed"].png = ""), /png must be a non-empty string/],
    ["gate typo", (i) => (i.interfaces["I-answer"].gate = "Owner" as never), /gate "Owner" is not one of/],
    [
      "launches as a string",
      (i) => (i.interfaces["I-sweep"].launches = "false" as never),
      /launches must be true or false/,
    ],
    [
      "plugin loop calls a gate verb",
      (i) => i.loops["L-sweep"].calls?.push("I-answer"),
      /a plugin loop calls I-answer, an owner gate verb/,
    ],
    [
      "feature uses retired interface",
      (i) => {
        i.features["F-sweep"].interfaces = ["I-sweep", "I-needs"];
        i.interfaces["I-needs"].status = "retire";
        i.pages["P-feed"].reads = [];
      },
      /F-sweep: live feature uses retired interface I-needs/,
    ],
    [
      "page uses retired component",
      (i) => {
        i.components["C-old"] = { name: "Old", status: "retire" };
        i.pages["P-feed"].components?.push("C-old");
      },
      /P-feed: uses retired component C-old/,
    ],
    ["caller not a layer", (i) => i.interfaces["I-needs"].callers?.push("robot"), /caller "robot" is not a layer/],
    ["store owner not a layer", (i) => (i.stores["S-asks"].owner = "robot"), /S-asks: owner "robot" is not a layer/],
    ["loop owner not a layer", (i) => (i.loops["L-sweep"].owner = "robot"), /L-sweep: owner "robot" is not a layer/],
    [
      "interface points at a ghost store",
      (i) => i.interfaces["I-answer"].stores?.push("S-ghost"),
      /S-ghost, which is not in stores/,
    ],
    ["loop calls a ghost interface", (i) => i.loops["L-sweep"].calls?.push("I-ghost"), /L-sweep: points at I-ghost/],
    [
      "finding without the FND- prefix",
      (i) => {
        if (i.findings) i.findings["BAD-x"] = { ...i.findings["FND-x"] };
      },
      /BAD-x: id in findings must start with FND-/,
    ],
    [
      "finding severity unknown",
      (i) => {
        if (i.findings) i.findings["FND-x"].severity = "huge" as never;
      },
      /severity "huge" is unknown/,
    ],
    [
      "finding state unknown",
      (i) => {
        if (i.findings) i.findings["FND-x"].state = "maybe" as never;
      },
      /state "maybe" is unknown/,
    ],
    [
      "finding about nothing",
      (i) => {
        if (i.findings) i.findings["FND-x"].about = [];
      },
      /FND-x: about nothing/,
    ],
    [
      "finding with an unknown key",
      (i) => {
        if (i.findings) Object.assign(i.findings["FND-x"], { tciket: "BRO-1" });
      },
      /FND-x: unknown key "tciket"/,
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
