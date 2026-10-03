// Awake time for tests (server/fleet-model.ts AwakeFor): wall time to `now`,
// less the stretches the Mac slept.

import type { AwakeFor } from "./fleet-model";

export function sleptThrough(now: number, sleeps: readonly (readonly [number, number])[] = []): AwakeFor {
  return (from) => {
    let ms = now - from;
    for (const [start, end] of sleeps) ms -= Math.max(0, Math.min(end, now) - Math.max(start, from));
    return { ms: Math.max(0, ms), whole: true };
  };
}
