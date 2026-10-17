// Which value a draft field takes from its owner, as a pure rule (BRO-3180, the caret jump).
//
// A draft field (client/kit/draft-input.tsx) keeps the text you type in the native view and tells its owner each
// change. The owner's value comes back a render later, and on a big screen (the phone shell) that can be after the next
// keystroke: written back into the view, that stale value moved iOS's caret to the end, so the first letter typed mid
// text sent it there. The field writes a value back only when it is not one it sent itself: a cleared field, another
// ask's words, an answer undone. Its own echoes, current or stale, never touch what you are typing.

/** How many of its own values a field remembers as echoes; older ones are long past any render. */
export const ECHO_MEMORY = 64;

export type DraftEcho = {
  /** The text the field shows, as it last wrote it or was typed. */
  shown: string;
  /** Values it has sent its owner since it last took one, newest last. */
  sent: string[];
};

export function draftEcho(value: string): DraftEcho {
  return { shown: value, sent: [] };
}

/** You typed `text`: the field shows it and remembers it was its own. */
export function typed(echo: DraftEcho, text: string): DraftEcho {
  const sent = [...echo.sent, text];
  return { shown: text, sent: sent.length > ECHO_MEMORY ? sent.slice(sent.length - ECHO_MEMORY) : sent };
}

/**
 * The owner rendered `value`. `take` is false when the field keeps what it shows: the value is what it shows, or an
 * echo of something it typed. Renders come in order, so an echo retires every value sent before it, and the owner
 * catching up to what is shown retires them all: a later "" (the field cleared once an answer lands) is the owner's,
 * even when you once emptied the field yourself.
 */
export function received(echo: DraftEcho, value: string): { echo: DraftEcho; take: boolean } {
  if (value === echo.shown)
    return { echo: echo.sent.length === 0 ? echo : { shown: echo.shown, sent: [] }, take: false };
  const at = echo.sent.lastIndexOf(value);
  if (at >= 0) return { echo: { shown: echo.shown, sent: echo.sent.slice(at) }, take: false };
  return { echo: draftEcho(value), take: true };
}
