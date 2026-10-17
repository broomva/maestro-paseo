// What Maestro keeps on the device across a screen change, a plugin reload, the host's link dropping (which unmounts
// and re-evaluates every plugin) and an app restart (BRO-3180 B; spec docs/specs/2026-10-17-maestro-persistence-offline.md).
// The pure half: no react-native import, so plain tests load it; client/kit/durable.ts picks the device's backend.
//
// One adapter, three backends chosen once: iOS keeps values in NSUserDefaults through react-native's `Settings`
// (public RN API; the plugin SDK has no storage), the web and desktop in `localStorage`, anything else in memory.
// A module-level cache sits in front, so reads never touch the backend twice. Every key is namespaced, because
// NSUserDefaults is shared with the host app. A backend that throws (a missing native module, a full quota) falls
// back to memory and says so once.

export const DURABLE_PREFIX = "maestro-paseo.v1.";

export type DurableBackend = {
  name: "settings" | "local" | "memory";
  read(key: string): string | null;
  write(key: string, value: string | null): void;
};

function memoryBackend(): DurableBackend {
  const values = new Map<string, string>();
  return {
    name: "memory",
    read: (key) => values.get(key) ?? null,
    write: (key, value) => {
      if (value === null) values.delete(key);
      else values.set(key, value);
    },
  };
}

export type SettingsApi = { get(key: string): unknown; set(values: Record<string, unknown>): void };
export type StorageApi = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** The backend this platform offers, or memory when it offers none that works. */
export function pickBackend(
  platform: string,
  settings: SettingsApi | undefined,
  storage: StorageApi | undefined,
): DurableBackend {
  try {
    if (platform === "ios" && settings) {
      settings.get(`${DURABLE_PREFIX}probe`);
      return {
        name: "settings",
        read: (key) => {
          const value = settings.get(key);
          return typeof value === "string" ? value : null;
        },
        write: (key, value) => settings.set({ [key]: value }),
      };
    }
    if (platform === "web" && storage) {
      storage.getItem(`${DURABLE_PREFIX}probe`);
      return {
        name: "local",
        read: (key) => storage.getItem(key),
        write: (key, value) => (value === null ? storage.removeItem(key) : storage.setItem(key, value)),
      };
    }
  } catch {
    // A backend that cannot even be read from is no backend.
  }
  return memoryBackend();
}

/** A store over one backend: values as JSON, a cache in front, and memory when the backend fails. */
export function durableStore(backend: DurableBackend) {
  const cache = new Map<string, unknown>();
  let fallen = false;
  const fallback = memoryBackend();
  const active = () => (fallen ? fallback : backend);
  const fail = (error: unknown) => {
    if (!fallen) console.warn(`[maestro] device storage (${backend.name}) failed; keeping state in memory`, error);
    fallen = true;
  };
  return {
    get backend(): DurableBackend["name"] {
      return active().name;
    },
    /** The value under `key`, parsed by `parse`; undefined when absent or not what `parse` accepts. */
    get<T>(key: string, parse: (raw: unknown) => T | undefined): T | undefined {
      const full = DURABLE_PREFIX + key;
      if (cache.has(full)) return cache.get(full) as T | undefined;
      let value: T | undefined;
      try {
        const raw = active().read(full);
        value = raw === null ? undefined : parse(JSON.parse(raw));
      } catch (error) {
        if (!(error instanceof SyntaxError)) fail(error);
        value = undefined;
      }
      cache.set(full, value);
      return value;
    },
    set(key: string, value: unknown): void {
      const full = DURABLE_PREFIX + key;
      cache.set(full, value);
      try {
        active().write(full, value === undefined ? null : JSON.stringify(value));
      } catch (error) {
        fail(error);
        fallback.write(full, value === undefined ? null : JSON.stringify(value));
      }
    },
  };
}

export type DurableStore = ReturnType<typeof durableStore>;
