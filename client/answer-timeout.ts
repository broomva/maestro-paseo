// How long an answer may wait for its reply, kept apart from the card so it can be tested on its own.

/**
 * How long an answer may go without a reply before this card stops waiting.
 * The server gives up on a held ledger lock in 5 s; past this the reply is
 * lost, and holding every card still would leave no way out.
 */
export const ANSWER_TIMEOUT_MS = 20_000;

/** The answer, or a refusal once `ms` (ANSWER_TIMEOUT_MS) passes with no reply. */
export function withinTimeout<T>(reply: Promise<T>, ms: number = ANSWER_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("No reply in 20 s. The answer may still land: refresh before answering again.")),
      ms,
    );
  });
  return Promise.race([reply, late]).finally(() => clearTimeout(timer));
}
