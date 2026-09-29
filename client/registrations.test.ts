import { describe, expect, test } from "bun:test";
import { Registrations, sameSpec } from "./registrations";

type Spec = { count: number };

function recorder(refuse: Set<string> = new Set()) {
  const calls: string[] = [];
  const registrations = new Registrations<Spec, { key: string; remove(): void }>(
    {
      add: (key, spec) => {
        if (refuse.has(key)) throw new Error(`host refused ${key}`);
        calls.push(`add ${key} ${spec.count}`);
        return { key, remove: () => calls.push(`remove ${key}`) };
      },
      update: (handle, spec) => {
        calls.push(`update ${handle.key} ${spec.count}`);
      },
    },
    (line) => calls.push(`log ${line}`),
  );
  return { registrations, calls };
}

const specs = (entries: Array<[string, number]>) => new Map(entries.map(([key, count]) => [key, { count }]));

describe("Registrations", () => {
  test("adds new keys, updates changed ones in place, removes gone ones, and leaves the rest alone", () => {
    const { registrations, calls } = recorder();
    registrations.sync(
      specs([
        ["a", 1],
        ["b", 1],
        ["c", 1],
      ]),
    );
    calls.length = 0;
    registrations.sync(
      specs([
        ["a", 1],
        ["b", 2],
        ["d", 0],
      ]),
    );
    expect(calls).toEqual(["remove c", "update b 2", "add d 0"]);
    expect(registrations.keys().sort()).toEqual(["a", "b", "d"]);
  });

  test("an unchanged set is not touched at all", () => {
    const { registrations, calls } = recorder();
    registrations.sync(specs([["a", 3]]));
    registrations.sync(specs([["a", 3]]));
    registrations.sync(specs([["a", 3]]));
    expect(calls).toEqual(["add a 3"]);
  });

  test("a refused add is logged, costs no other registration, and is tried again next time", () => {
    const refuse = new Set(["bad"]);
    const { registrations, calls } = recorder(refuse);
    registrations.sync(
      specs([
        ["bad", 1],
        ["good", 1],
      ]),
    );
    expect(calls).toEqual(["log Could not add bad: host refused bad", "add good 1"]);
    refuse.clear();
    registrations.sync(
      specs([
        ["bad", 1],
        ["good", 1],
      ]),
    );
    expect(calls.at(-1)).toBe("add bad 1");
  });

  test("clear removes every registration", () => {
    const { registrations, calls } = recorder();
    registrations.sync(
      specs([
        ["a", 1],
        ["b", 1],
      ]),
    );
    registrations.clear();
    expect(calls.filter((call) => call.startsWith("remove")).sort()).toEqual(["remove a", "remove b"]);
    expect(registrations.keys()).toEqual([]);
  });

  test("specs compare field by field", () => {
    expect(sameSpec({ a: 1, b: "x" }, { b: "x", a: 1 })).toBe(true);
    expect(sameSpec({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameSpec({ a: 1 }, { a: 1, b: null })).toBe(false);
  });
});
