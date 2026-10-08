import { describe, expect, test } from "bun:test";
import { DRIFT_CLASSES, type LoopRow } from "../shared/loops";
import { DRIFT_WORDS, driftTone, intentWords, noticeWords, observedWords, sections, summary } from "./loops-model";

const row = (extra: Partial<LoopRow>): LoopRow => ({
  subject: "loop:x",
  id: "x",
  name: "X",
  kind: "launchd",
  ref: "com.broomva.x",
  scope: "broomva",
  owner: "owner",
  purpose: null,
  desired: "active",
  section: "loops",
  intent: null,
  observed: null,
  unread: false,
  drift: [],
  ...extra,
});
const drift = (needsYou: boolean) => ({ kind: "failing" as const, detail: "d", fix: "f", needsYou });

describe("the Loops tab's words", () => {
  test("every drift class has its badge words", () => {
    expect(DRIFT_CLASSES.every((kind) => DRIFT_WORDS[kind].length > 0)).toBe(true);
  });
  test("drifting rows sort first, needs-you before badges; ephemerals apart", () => {
    const rows = [
      row({ id: "a" }),
      row({ id: "b", drift: [drift(false)] }),
      row({ id: "c", drift: [drift(true)] }),
      row({ id: null, name: "w", section: "ephemeral" }),
    ];
    const { loops, ephemeral } = sections(rows);
    expect(loops.map((one) => one.id)).toEqual(["c", "b", "a"]);
    expect(ephemeral.map((one) => one.name)).toEqual(["w"]);
    expect(summary(rows)).toBe("3 loops; 1 needs you, 2 drifting.");
    expect(summary([row({})])).toBe("1 loop, each as its row says.");
    expect(driftTone(drift(true))).toBe("danger");
    expect(driftTone(drift(false))).toBe("warn");
  });
  test("intent and observation in words", () => {
    expect(intentWords(row({ desired: "paused", scope: "external" }))).toBe("Paused · owner · external");
    expect(intentWords(row({ desired: null, scope: "sri", owner: "sri-orchestrator" }))).toBe(
      "Read-only (SRI) · sri-orchestrator · sri",
    );
    expect(intentWords(row({ id: null }))).toBe("No ledger row");
    expect(observedWords(row({ unread: true }))).toBe("Not read this time");
    expect(observedWords(row({}))).toBe("Not found");
    expect(noticeWords({ loop: "kg-lint", kind: "paused_but_running", detail: "It runs." })).toBe(
      "kg-lint: Paused but running. It runs.",
    );
  });
});
