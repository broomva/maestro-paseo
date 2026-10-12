// Work paused on a usage limit (BRO-3073): Stuck, with a reason that starts here. Its card offers Resume.

/** The Stuck reason's first words: what the work card keys Resume on. */
export const PAUSED = "Paused: hit a usage limit";

/** Whether a Stuck reason is a pause for a usage limit: its card offers Resume. */
export const isPaused = (reason: string | null | undefined): boolean => reason?.startsWith(PAUSED) ?? false;
