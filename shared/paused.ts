// Work paused (BRO-3073): Stuck, with a reason that starts here, because the turn ended on something that is not
// the run finishing: a usage limit, or a login that expired. Its card offers Resume.

/** A usage limit's Stuck reason, first words. */
export const PAUSED = "Paused: hit a usage limit";

/** Every pause's Stuck reason starts here: what the work card keys Resume on. */
export const PAUSED_PREFIX = "Paused:";

/** Whether a Stuck reason is a pause (a usage limit, an expired login): its card offers Resume. */
export const isPaused = (reason: string | null | undefined): boolean => reason?.startsWith(PAUSED_PREFIX) ?? false;

/** Said when the paused run's session is gone: Resume cannot send it on, so it starts a fresh run. */
export const ARCHIVED_RESUME = "its session was archived, so Resume starts a fresh run";
