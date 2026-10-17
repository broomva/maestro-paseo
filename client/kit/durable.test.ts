import { describe, expect, spyOn, test } from "bun:test";
import { DURABLE_PREFIX, durableStore, pickBackend } from "./durable-store";

const asNumber = (raw: unknown) => (typeof raw === "number" ? raw : undefined);

describe("device storage (BRO-3180 B)", () => {
  test("iOS keeps values in Settings, namespaced; the web in localStorage", () => {
    const defaults: Record<string, unknown> = {};
    const settings = {
      get: (key: string) => defaults[key],
      set: (values: Record<string, unknown>) => Object.assign(defaults, values),
    };
    const ios = durableStore(pickBackend("ios", settings, undefined));
    expect(ios.backend).toBe("settings");
    ios.set("n", 7);
    expect(defaults[`${DURABLE_PREFIX}n`]).toBe("7");
    // A fresh store over the same defaults (the plugin re-evaluated) reads it back.
    expect(durableStore(pickBackend("ios", settings, undefined)).get("n", asNumber)).toBe(7);
    const items = new Map<string, string>();
    const storage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    };
    const web = durableStore(pickBackend("web", undefined, storage));
    expect(web.backend).toBe("local");
    web.set("n", 3);
    expect(durableStore(pickBackend("web", undefined, storage)).get("n", asNumber)).toBe(3);
  });
  test("a platform with no storage, or one whose storage throws, keeps state in memory", () => {
    expect(pickBackend("android", undefined, undefined).name).toBe("memory");
    const broken = {
      get: () => {
        throw new Error("no native module");
      },
      set: () => undefined,
    };
    expect(pickBackend("ios", broken, undefined).name).toBe("memory");
  });
  test("a value that is not what the reader wants, or not JSON, reads as nothing", () => {
    const items = new Map<string, string>([
      [`${DURABLE_PREFIX}n`, "{oops"],
      [`${DURABLE_PREFIX}m`, '"text"'],
    ]);
    const storage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    const store = durableStore(pickBackend("web", undefined, storage));
    expect(store.get("n", asNumber)).toBeUndefined();
    expect(store.get("m", asNumber)).toBeUndefined();
  });
  test("a write that fails falls back to memory and keeps working", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => undefined,
    };
    const store = durableStore(pickBackend("web", undefined, storage));
    store.set("n", 5);
    expect(store.get("n", asNumber)).toBe(5);
    expect(store.backend).toBe("memory");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
