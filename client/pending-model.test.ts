import { describe, expect, test } from "bun:test";
import type { PendingVerb } from "../shared/verbs";
import { pendingFor, pendingWords, secondsLeft, settledWords } from "./pending-model";

const verb = (key: string, kind: PendingVerb["verb"] = "approval.decide"): PendingVerb => ({
  receipt: `r-${key}-${kind}`,
  verb: kind,
  key,
  label: "Allowed git push",
  at: "2026-10-12T09:00:00.000Z",
  appliesAt: "2026-10-12T09:00:08.000Z",
  remainingMs: 8000,
});

describe("what waits out its 8 s window", () => {
  test("seconds left round up, so the first second reads 8 and the last reads 1", () => {
    expect(secondsLeft(8000)).toBe(8);
    expect(secondsLeft(7001)).toBe(8);
    expect(secondsLeft(1)).toBe(1);
    expect(secondsLeft(0)).toBe(0);
    expect(secondsLeft(-5)).toBe(0);
  });

  test("a verb says what you did and when it takes effect, then that it is taking effect", () => {
    expect(pendingWords(verb("work:a"), 7)).toBe("Allowed git push · takes effect in 7s");
    expect(pendingWords(verb("work:a"), 0)).toBe("Allowed git push · taking effect now");
  });

  test("a surface keeps its own keys, skips what it counts down itself, and drops the open work's", () => {
    const all = [verb("work:a"), verb("work:b"), verb("work:a", "work.verdict"), verb("config", "config.set")];
    expect(pendingFor(all).length).toBe(4);
    expect(pendingFor(all, ["work:a"]).map((entry) => entry.verb)).toEqual(["approval.decide", "work.verdict"]);
    expect(pendingFor(all, ["work:a"], ["work.verdict"]).map((entry) => entry.verb)).toEqual(["approval.decide"]);
    expect(pendingFor(all, undefined, ["work.verdict"]).map((entry) => entry.key)).toEqual([
      "work:a",
      "work:b",
      "config",
    ]);
  });

  test("a receipt says how it ended: took effect, undone, or dropped with its reason", () => {
    const base = { label: "Denied git push", detail: "" };
    expect(settledWords({ ...base, outcome: "applied" })).toBe("Denied git push · took effect");
    expect(settledWords({ ...base, outcome: "undone" })).toBe("Denied git push · you undid it");
    expect(settledWords({ ...base, outcome: "dropped", detail: "The prompt moved on." })).toBe(
      "Denied git push · dropped: The prompt moved on.",
    );
  });
});
