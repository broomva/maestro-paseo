// An adoption records its orchestrator by agent id (agent-socket.ts origin);
// the Feed says its session title instead (BRO-2938). The lookup never waits
// on the daemon: it answers what is known and reads in the background, one
// read per id at a time, so a list or a loop tick is never slowed by it.

/** How long a name is trusted before it is read again in the background: a renamed session catches up. */
export const NAME_EVERY_MS = 10 * 60_000;
/** After a read that failed (not "not found": the daemon did not answer), how long before trying again. */
export const NAME_RETRY_MS = 60_000;

/** One read: the session's title, null when it has none, or a throw. */
export type ReadTitle = (agentId: string) => Promise<string | null>;

/** The daemon's answer for an id it does not know (`@getpaseo/server` handleFetchAgent): final, not a failure. */
const NOT_FOUND = /agent not found/i;

export function adopterNames(now: () => number = Date.now) {
  const known = new Map<string, { at: number; name: string | null; failed: boolean }>();
  const asking = new Map<string, Promise<void>>();
  const ask = async (id: string, read: ReadTitle) => {
    const before = known.get(id);
    try {
      const title = (await read(id))?.trim() || null;
      known.set(id, { at: now(), name: title, failed: false });
    } catch (error) {
      const gone = NOT_FOUND.test((error as Error)?.message ?? "");
      // A session that went keeps no name; one that did not answer keeps what it had, and is asked again soon.
      known.set(id, { at: now(), name: gone ? null : (before?.name ?? null), failed: !gone });
    }
  };
  /** The name known for `id` now, or null; with `read`, a stale or missing name is read in the background. */
  const lookup = (id: string, read?: ReadTitle): string | null => {
    const hit = known.get(id);
    const due = !hit || now() - hit.at >= (hit.failed ? NAME_RETRY_MS : NAME_EVERY_MS);
    if (read && due && !asking.has(id)) {
      asking.set(
        id,
        ask(id, read).finally(() => asking.delete(id)),
      );
    }
    return hit?.name ?? null;
  };
  /** For a test: waits for the reads in flight. */
  lookup.settled = async (): Promise<void> => {
    await Promise.all(asking.values());
  };
  return lookup;
}
