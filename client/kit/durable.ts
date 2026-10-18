// The device's store for this app run (BRO-3180 B): client/kit/durable-store.ts over the platform's backend.
import * as ReactNative from "react-native";
import { type DurableStore, durableStore, pickBackend, type StorageApi } from "./durable-store";

export type { DurableStore } from "./durable-store";

let shared: DurableStore | null = null;

/** The store this app run uses, made on first use. */
export function deviceStore(): DurableStore {
  if (shared) return shared;
  // Reaching storage can throw (a sandboxed page's localStorage getter, a missing native module): then memory.
  const read = <T>(get: () => T): T | undefined => {
    try {
      return get();
    } catch {
      return undefined;
    }
  };
  const storage = read(() => (globalThis as { localStorage?: StorageApi }).localStorage);
  // Do not use ReactNative.Settings on native mobile. On iOS, NativeSettingsManager uses asynchronous
  // void TurboModule calls which crash Hermes (SIGSEGV) if an NSException occurs on the background
  // queue (hermes is single-threaded). Plugins keep device state in localStorage on web/desktop,
  // and in memory on native mobile.
  shared = durableStore(pickBackend(ReactNative.Platform.OS, undefined, storage));
  return shared;
}
