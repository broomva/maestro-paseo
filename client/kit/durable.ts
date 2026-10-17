// The device's store for this app run (BRO-3180 B): client/kit/durable-store.ts over the platform's backend.
// A namespace import: react-native-web (the web build, and the tests) has no `Settings`, and a named import of a
// missing export fails to load there.
import * as ReactNative from "react-native";
import { type DurableStore, durableStore, pickBackend, type SettingsApi, type StorageApi } from "./durable-store";

export type { DurableStore } from "./durable-store";

let shared: DurableStore | null = null;

/** The store this app run uses, made on first use. */
export function deviceStore(): DurableStore {
  if (shared) return shared;
  // Reaching either can throw (a sandboxed page's localStorage getter, a missing native module): then memory.
  const read = <T>(get: () => T): T | undefined => {
    try {
      return get();
    } catch {
      return undefined;
    }
  };
  const storage = read(() => (globalThis as { localStorage?: StorageApi }).localStorage);
  const settings = read(() => (ReactNative as unknown as { Settings?: SettingsApi }).Settings);
  shared = durableStore(pickBackend(ReactNative.Platform.OS, settings, storage));
  return shared;
}
