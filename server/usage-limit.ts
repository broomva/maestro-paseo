// A turn that ended on a usage limit is not a finished turn (BRO-3073). Claude Code ends a turn with
// "You've hit your session limit · resets 11:50pm (America/Bogota)" (or weekly) when the subscription is spent, and
// a provider can fail a turn with a rate-limit or credit error. Neither handed you anything: the run was
// interrupted. It is recorded as Stuck, "Paused: hit a usage limit; resumes after <reset>", never as work at the
// gate, where "Close it as done" would have closed unfinished work. The session is alive, so it holds its slot
// (BRO-2990); when the limit resets, Resume (Unblock) tells it to continue, and nothing closes it on its own.

import { PAUSED } from "../shared/paused";

export { isPaused, PAUSED } from "../shared/paused";

/** What a turn that ended on a usage limit says: the whole message, never prose that mentions one. */
const LIMIT_MESSAGE = /^\s*you(?:(?:'|’)ve| have) hit your [a-z0-9 -]{1,40}limit\b/i;
/** A provider's refusal for spend or speed, in a failed turn's error. */
const LIMIT_ERROR =
  /\b(?:usage limit|rate[ -]?limit(?:ed)?|credit balance is too low|out of credits?|quota (?:exceeded|exhausted)|insufficient[_ ]quota|status(?: code)?:? 429|429 too many requests)\b/i;

/** When a limit message says the limit resets ("11:50pm (America/Bogota)", "Oct 15 at 5pm (America/Bogota)"), or null. */
export function resetOf(text: string): string | null {
  const zoned = /\bresets?\s+(.+?\([^)]*\))/i.exec(text);
  if (zoned?.[1]) return zoned[1].trim();
  const bare = /\bresets?\s+(.+?)(?=\s*you(?:'|’)ve\b|$)/i.exec(text.replace(/\s+/g, " "));
  return bare?.[1]?.trim() || null;
}

/** The Stuck reason for a limit, with its reset when it names one. */
export function pausedReason(text: string): string {
  const reset = resetOf(text);
  return reset ? `${PAUSED}; resumes after ${reset}` : PAUSED;
}

/** What a turn ends with when the session cannot sign in: Claude Code's own words, as real transcripts hold them. */
const LOGIN_MESSAGE = /^\s*(?:failed to authenticate|not logged in|invalid api key|please run \/login)/i;
/** A failed turn's error for a sign-in the provider refused. */
const LOGIN_ERROR =
  /\b(?:failed to authenticate|authentication_error|not logged in|invalid api key|401 unauthorized|oauth (?:token|session) (?:has )?expired)\b/i;
/** The account's own refusal: its organization turned the subscription off for Claude Code. */
const ORG_MESSAGE = /^\s*your organization has (?:been )?disabled\b/i;

/** The Stuck reasons for a session that cannot sign in. */
export const LOGIN_EXPIRED = "Paused: the session's login expired; sign in again, then Resume";
export const ORG_DISABLED = "Paused: your organization has disabled subscription access for Claude Code";

/**
 * Whether a turn ended on something that is not the run finishing, and if so the reason it is Stuck for: a usage
 * limit (with its reset), or a login that expired (BRO-2999 review: a fleet-wide login expiry used to land as work
 * at your gate, and now it would have gone quiet). A completed turn is one only when its last words are the message
 * itself (short, and starting with it): a run that mentions limits in a report is not paused. A failed turn is one
 * when its error says the provider refused for rate, credit or sign-in.
 */
export function pausedBy(
  outcome: "completed" | "failed" | "canceled",
  summary: string,
  error: string | null,
): string | null {
  const text = summary.trim();
  if (outcome === "completed" && text.length <= 400) {
    if (LOGIN_MESSAGE.test(text)) return LOGIN_EXPIRED;
    if (ORG_MESSAGE.test(text)) return ORG_DISABLED;
    if (LIMIT_MESSAGE.test(text)) return pausedReason(text);
  }
  if (outcome === "failed" && error) {
    if (LOGIN_ERROR.test(error)) return LOGIN_EXPIRED;
    if (LIMIT_ERROR.test(error)) return pausedReason(error);
  }
  return null;
}
