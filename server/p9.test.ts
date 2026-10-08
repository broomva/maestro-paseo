import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { p9Observations, parseLines, readP9, tailText } from "./p9";

const NOW = Date.parse("2026-10-08T16:00:00Z");
const H = 3_600_000;
const iso = (at: number) => new Date(at).toISOString();
const line = (extra: Record<string, unknown>) =>
  JSON.stringify({ ts: iso(NOW - H), pr: 11, repo: "broomva/skene", watcher_id: "w1", ...extra });

describe("p9 watchers", () => {
  test("a watcher going with a live process is on and ephemeral; its end is listed a day", () => {
    const transitions = parseLines(
      [
        line({ from_state: "PUSHED", to_state: "WATCHING", extra: { pid: 42 } }),
        line({ watcher_id: "w2", to_state: "WATCHING", ts: iso(NOW - 2 * H) }),
        line({ watcher_id: "w2", to_state: "GREEN", ts: iso(NOW - H) }),
        line({ watcher_id: "w3", to_state: "RED_UNCLASSIFIED", ts: iso(NOW - 30 * H) }),
        "{torn",
      ].join("\n"),
    );
    const out = p9Observations(transitions, NOW, () => true, "/p9");
    expect(out.map((one) => [one.ref, one.presence, one.status, one.ephemeral])).toEqual([
      ["w1", "on", "running", true],
      ["w2", "off", "off", true],
    ]);
    expect(out[0]?.subject).toBe("loop:p9/w1");
  });
  test("a watcher whose process is gone is not going, whatever its last line says; a red one failed", () => {
    const transitions = parseLines(
      [
        line({ to_state: "WATCHING", extra: { pid: 42 } }),
        line({ watcher_id: "w9", to_state: "RED_UNCLASSIFIED" }),
      ].join("\n"),
    );
    const out = p9Observations(transitions, NOW, () => false, "/p9");
    expect(out.find((one) => one.ref === "w1")).toMatchObject({ presence: "off" });
    expect(out.find((one) => one.ref === "w1")?.last?.detail).toContain("its process is gone");
    expect(out.find((one) => one.ref === "w9")).toMatchObject({ status: "failed" });
  });
  test("waits are folded by wait_id", () => {
    const wait = JSON.stringify({ ts: iso(NOW - H), wait_id: "q1", name: "vps-boot", to_state: "WAITING" });
    expect(p9Observations(parseLines(wait), NOW, () => true, "/p9")[0]).toMatchObject({
      name: "p9 wait vps-boot",
      presence: "on",
    });
  });
  test("only the tail is read, a cut first line dropped; a missing dir reads as none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "p9-"));
    try {
      await writeFile(join(dir, "state.jsonl"), `${"x".repeat(100)}\n${line({ to_state: "WATCHING" })}\n`);
      expect(await tailText(join(dir, "state.jsonl"), 60)).not.toContain("xxx");
      expect(await readP9(dir, NOW, () => true)).toHaveLength(1);
      expect(await readP9(join(dir, "none"), NOW)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
