import { describe, expect, test } from "bun:test";
import { withinTimeout } from "./answer-timeout";

describe("an answer that never replies", () => {
  test("stops waiting after the timeout, so every card is free again", async () => {
    // A reply that comes only after the deadline: without the timeout it would be the answer.
    const late = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 200));
    await expect(withinTimeout(late, 10)).rejects.toThrow("No reply in 20 s");
  });

  test("a reply in time is the answer", async () => {
    await expect(withinTimeout(Promise.resolve("ok"), 1000)).resolves.toBe("ok");
  });
});
