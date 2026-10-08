import { describe, expect, test } from "bun:test";
import { adopterNames, NAME_EVERY_MS, NAME_RETRY_MS, type ReadTitle } from "./adopter-names";

const clock = () => {
  let at = 0;
  return { now: () => at, tick: (ms: number) => (at += ms) };
};

/** A read that counts its calls and answers from `answer`. */
const reader = (answer: (id: string) => Promise<string | null>) => {
  const calls: string[] = [];
  const read: ReadTitle = (id) => {
    calls.push(id);
    return answer(id);
  };
  return { read, calls };
};

describe("an adopter's name (BRO-2938)", () => {
  test("answers at once, reads in the background, and keeps the trimmed title", async () => {
    const { now } = clock();
    const names = adopterNames(now);
    const { read, calls } = reader(async () => "  SRI Orchestrator ");
    expect(names("a1", read)).toBeNull();
    await names.settled();
    expect([names("a1", read), names("a1", read), calls]).toEqual(["SRI Orchestrator", "SRI Orchestrator", ["a1"]]);
  });

  test("never waits on a daemon that does not answer, and reads an id once at a time", async () => {
    const { now } = clock();
    const names = adopterNames(now);
    const { read, calls } = reader(() => new Promise<string | null>(() => {}));
    const started = performance.now();
    expect([names("a1", read), names("a1", read), names("a1", read)]).toEqual([null, null, null]);
    expect(performance.now() - started).toBeLessThan(50);
    expect(calls).toEqual(["a1"]);
  });

  test("the daemon's 'Agent not found' is final: null, not read again until the name is due", async () => {
    const t = clock();
    const names = adopterNames(t.now);
    const { read, calls } = reader(async (id) => {
      throw new Error(`Agent not found: ${id}`);
    });
    names("gone", read);
    await names.settled();
    t.tick(NAME_RETRY_MS);
    expect(names("gone", read)).toBeNull();
    await names.settled();
    expect(calls).toEqual(["gone"]);
  });

  test("a read that failed keeps the name it had and is retried after the backoff", async () => {
    const t = clock();
    const names = adopterNames(t.now);
    let fail = false;
    const { read, calls } = reader(async () => {
      if (fail) throw new Error("socket closed");
      return "SRI Orchestrator";
    });
    names("a1", read);
    await names.settled();
    fail = true;
    t.tick(NAME_EVERY_MS);
    names("a1", read);
    await names.settled();
    expect(names("a1", read)).toBe("SRI Orchestrator");
    expect(calls.length).toBe(2);
    t.tick(NAME_RETRY_MS);
    fail = false;
    names("a1", read);
    await names.settled();
    expect(calls.length).toBe(3);
  });

  test("a renamed session is read again once its name is due", async () => {
    const t = clock();
    const names = adopterNames(t.now);
    let title = "Orchestrator";
    const { read } = reader(async () => title);
    names("a1", read);
    await names.settled();
    title = "SRI Orchestrator";
    t.tick(NAME_EVERY_MS - 1);
    names("a1", read);
    await names.settled();
    expect(names("a1")).toBe("Orchestrator");
    t.tick(1);
    names("a1", read);
    await names.settled();
    expect(names("a1")).toBe("SRI Orchestrator");
  });

  test("a session that went loses the name it had; a blank title is no name", async () => {
    const t = clock();
    const names = adopterNames(t.now);
    let answer: () => Promise<string | null> = async () => "SRI Orchestrator";
    const { read } = reader(() => answer());
    names("a1", read);
    await names.settled();
    answer = async () => {
      throw new Error("Agent not found: a1");
    };
    t.tick(NAME_EVERY_MS);
    names("a1", read);
    await names.settled();
    const blank = adopterNames(t.now);
    const { read: blankRead } = reader(async () => "   ");
    blank("b1", blankRead);
    await blank.settled();
    expect([names("a1"), blank("b1")]).toEqual([null, null]);
  });
});
