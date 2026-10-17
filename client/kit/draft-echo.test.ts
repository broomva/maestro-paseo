import { describe, expect, test } from "bun:test";
import { draftEcho, ECHO_MEMORY, received, typed } from "./draft-echo";

describe("a draft field's echoes (BRO-3180, the caret jump)", () => {
  test("a stale echo of its own typing is never written back", () => {
    // You typed "abXc" then "abXYc" before the screen rendered: its render of "abXc" is an echo, not a change.
    const echo = typed(typed(draftEcho("abc"), "abXc"), "abXYc");
    const late = received(echo, "abXc");
    expect(late.take).toBe(false);
    expect(late.echo.shown).toBe("abXYc");
    // A repeat render of the same stale value is still an echo.
    expect(received(late.echo, "abXc").take).toBe(false);
  });
  test("a value the owner set itself is taken: cleared, or another ask's words", () => {
    const echo = typed(draftEcho(""), "hello");
    const cleared = received(echo, "other words");
    expect(cleared.take).toBe(true);
    expect(cleared.echo).toEqual(draftEcho("other words"));
  });
  test("once the owner catches up, an old value is the owner's again", () => {
    // You emptied the field once, typed again, and the screen caught up: a later "" is the screen clearing it.
    let echo = typed(typed(draftEcho("a"), ""), "b");
    echo = received(echo, "b").echo;
    expect(echo.sent).toEqual([]);
    expect(received(echo, "").take).toBe(true);
  });
  test("an echo retires the values sent before it", () => {
    let echo = typed(typed(typed(draftEcho(""), "a"), ""), "ab");
    echo = received(echo, "").echo;
    // "a" was sent before the echoed "": no later render can carry it, so it is the owner's own.
    expect(received(echo, "a").take).toBe(true);
  });
  test("it remembers a bounded number of its own values", () => {
    let echo = draftEcho("");
    for (let at = 0; at < ECHO_MEMORY + 10; at += 1) echo = typed(echo, `v${at}`);
    expect(echo.sent).toHaveLength(ECHO_MEMORY);
    expect(echo.sent.at(-1)).toBe(`v${ECHO_MEMORY + 9}`);
  });
});
