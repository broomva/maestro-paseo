import { describe, expect, test } from "bun:test";
import { isPaused, pausedBy, pausedReason, resetOf } from "./usage-limit";

describe("a turn that ended on a usage limit (BRO-3073)", () => {
  test("the messages Claude Code ends a turn with, read as the live store has them", () => {
    expect(pausedBy("completed", "You've hit your session limit · resets 11:50pm (America/Bogota)", null)).toBe(
      "Paused: hit a usage limit; resumes after 11:50pm (America/Bogota)",
    );
    expect(pausedBy("completed", "You've hit your weekly limit · resets Oct 15 at 5pm (America/Bogota)", null)).toBe(
      "Paused: hit a usage limit; resumes after Oct 15 at 5pm (America/Bogota)",
    );
    // The same line said twice (the timeline repeats it): one reset, the first.
    const twice =
      "You've hit your session limit · resets 1:30am (America/Bogota)You've hit your session limit · resets 1:30am (America/Bogota)";
    expect(resetOf(twice)).toBe("1:30am (America/Bogota)");
    expect(pausedBy("completed", `\n  ${twice}\n`, null)).toBe(pausedReason(twice));
  });

  test("a limit with no reset, and the curly apostrophe", () => {
    expect(pausedBy("completed", "You’ve hit your usage limit", null)).toBe("Paused: hit a usage limit");
    expect(resetOf("You've hit your usage limit")).toBeNull();
  });

  test("prose that mentions a limit, or a long report, is a finished turn", () => {
    expect(pausedBy("completed", "Done. It handles when you've hit your session limit.", null)).toBeNull();
    expect(pausedBy("completed", `You've hit your session limit · resets later\n${"x".repeat(500)}`, null)).toBeNull();
    expect(pausedBy("completed", "", null)).toBeNull();
  });

  test("a provider's rate-limit or credit error pauses a failed turn; another error does not", () => {
    for (const error of [
      "429 Too Many Requests",
      "Rate limit exceeded",
      "Your credit balance is too low to access the API",
      "usage limit reached",
      "insufficient_quota",
    ]) {
      expect(pausedBy("failed", "", error)).toBe("Paused: hit a usage limit");
    }
    expect(pausedBy("failed", "", "ECONNRESET")).toBeNull();
    expect(pausedBy("failed", "", null)).toBeNull();
    // A canceled turn is not a limit, whatever it says.
    expect(pausedBy("canceled", "You've hit your session limit", null)).toBeNull();
  });

  test("a Stuck reason is a pause when it starts so: its card offers Resume", () => {
    expect(isPaused("Paused: hit a usage limit; resumes after 3pm")).toBe(true);
    expect(isPaused("Stopped before finishing")).toBe(false);
    expect(isPaused(null)).toBe(false);
  });
});
