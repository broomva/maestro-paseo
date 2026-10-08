import { afterAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TimelineSource, TimelineView } from "../shared/timeline";
import { type DriftWriter, envelopes, Loops, type LoopsOptions, stateOf, WRITE_BACKOFF_MS } from "./loops";
import { dirLedger } from "./loops-ledger";
import heartbeat from "./testdata/heartbeat-103a1850.json";

const FIXTURE = join(import.meta.dir, "testdata", "loops-ledger");
const NOW = Date.parse("2026-10-08T16:00:00Z");
const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function source(label: string, extra: Partial<TimelineSource> = {}): TimelineSource {
  return {
    id: `launchd:${label}`,
    kind: "launchd",
    name: label.replace("com.broomva.", ""),
    cadence: "every hour",
    status: "ok",
    reason: "On schedule.",
    since: null,
    needsYou: false,
    next: null,
    upcoming: [],
    runs: [],
    runsCut: false,
    last: null,
    where: null,
    hasLog: false,
    link: null,
    ...extra,
  };
}

const LABELS = [
  "disk-janitor",
  "fleet-reconcile.broomva",
  "fleet-reconcile.sri",
  "kg-compile",
  "kg-lint",
  "kg-synthesis",
  "moltbook-loop",
  "paseo-liveness",
].map((name) => `com.broomva.${name}`);
const PAUSED = new Set([
  "com.broomva.kg-compile",
  "com.broomva.kg-lint",
  "com.broomva.kg-synthesis",
  "com.broomva.moltbook-loop",
]);

async function world(extraLabels: string[] = [], ghaFails: { now: boolean; extra?: boolean } = { now: false }) {
  const root = await mkdtemp(join(tmpdir(), "loops-"));
  roots.push(root);
  const ledger = join(root, "ledger");
  await cp(FIXTURE, ledger, { recursive: true });
  const schedules = join(root, "schedules");
  await mkdir(schedules);
  await writeFile(
    join(schedules, "44ab2429.json"),
    JSON.stringify({ ...heartbeat, id: "44ab2429", prompt: "follow .broomva/loops/prompts/coordinator-tick.md" }),
  );
  const streams = join(root, "home", "ledger", "loops");
  const notes = join(root, "home", "notes", "loops");
  await mkdir(join(notes, "coordinator-tick"), { recursive: true });
  await writeFile(join(notes, "coordinator-tick", "state.yaml"), "tick: T1\nopen: []\n");
  const labels = [...LABELS, ...extraLabels];
  const view: TimelineView = {
    now: new Date(NOW).toISOString(),
    from: new Date(NOW - 86_400_000).toISOString(),
    to: new Date(NOW + 86_400_000).toISOString(),
    sources: [
      ...labels.map((label) => source(label, PAUSED.has(label) ? { status: "off" } : {})),
      { ...source("x"), id: "loop", kind: "loop", name: "Maestro's loop", status: "ok" },
    ],
    warnings: [],
  };
  const written: Parameters<DriftWriter>[0][] = [];
  const external = [
    "local.granola-arm",
    "local.granola-bridge",
    "com.omnara.daemon",
    "codes.t3.server",
    "ai.openclaw.gateway",
  ];
  const options: LoopsOptions = {
    ledger: dirLedger(ledger),
    timeline: { get: async () => view },
    schedulesDir: schedules,
    presence: async (asked) =>
      new Map(
        asked.map((label) => [
          label,
          label === "ai.openclaw.gateway" || PAUSED.has(label)
            ? "off"
            : labels.includes(label) || external.includes(label)
              ? "on"
              : "gone",
        ]),
      ),
    gha: {
      observe: async (refs) => ({
        observations: (ghaFails.now
          ? []
          : [...refs, ...(ghaFails.extra ? ["broomva/x/.github/workflows/w.yml"] : [])]
        ).map((ref) => ({
          subject: `loop:gha/${ref.split("/")[0]}/${ref.split("/")[1]}/${ref.split("/").at(-1)}`,
          kind: "gha-schedule" as const,
          ref,
          name: ref,
          scope: "broomva" as const,
          presence: "on" as const,
          status: "ok" as const,
          reason: "",
          since: null,
          cadence: "cron",
          next: null,
          last: null,
          runs: [],
          ephemeral: false,
          where: null,
        })),
        unread: ghaFails.now ? ["broomva/workspace", "broomva/life", "broomva/x"] : [],
      }),
    },
    p9Dir: join(root, "p9"),
    streams,
    notes,
    agents: null,
    writer: async (line) => {
      written.push(line);
    },
    now: () => NOW,
    log: () => undefined,
  };
  return { root, ledger, options, written, view };
}

describe("the Loops read", () => {
  test("the P1 inventory reconciles with 0 UNREGISTERED among broomva non-ephemeral loops", async () => {
    const { options } = await world();
    const view = await new Loops(options).get();
    expect(view.ledgerErrors).toEqual([]);
    const unregistered = view.rows.filter(
      (row) =>
        row.scope === "broomva" && row.section === "loops" && row.drift.some((one) => one.kind === "unregistered"),
    );
    expect(unregistered).toEqual([]);
    const coordinator = view.rows.find((row) => row.id === "coordinator-tick");
    expect(coordinator?.observed?.ref).toBe("44ab2429");
    expect(coordinator?.observed?.target?.agentId).toBe("f5307ce7-acb7-4687-b018-9cfbd322bca7");
    expect(coordinator?.drift.map((one) => one.kind)).toEqual([]);
    expect(view.rows.find((row) => row.id === "kg-lint")?.drift).toEqual([]);
  });

  test("a canary job with no row is UNREGISTERED; given a paused row it is PAUSED_BUT_RUNNING; each written once, then cleared", async () => {
    const { options, ledger, written } = await world(["com.broomva.canary"]);
    const loops = new Loops({ ...options, now: () => NOW });
    let clock = NOW;
    const at = new Loops({ ...options, now: () => clock });
    const first = await at.get();
    expect(first.rows.find((row) => row.ref === "com.broomva.canary")?.drift.map((one) => one.kind)).toEqual([
      "unregistered",
    ]);
    expect((await at.notices()).map((one) => one.kind)).toEqual(["unregistered"]);
    expect(written.map((one) => `${one.type} ${one.subject} ${one.kind}`)).toEqual([
      "loop.drift.detected loop:launchd/com.broomva.canary unregistered",
    ]);
    await writeFile(
      join(ledger, "canary.yaml"),
      "id: canary\ntitle: Canary\npurpose: A test job.\nowner: owner\nscope: broomva\nsubstrate: {kind: launchd, ref: com.broomva.canary}\ncadence: every hour\ndesired: paused\ndesired_since: '2026-10-08'\nreason: canary\nreview_by: '2026-10-21'\n",
    );
    clock += 60_000;
    const second = await at.get();
    expect(second.rows.find((row) => row.id === "canary")?.drift.map((one) => one.kind)).toEqual([
      "paused_but_running",
    ]);
    expect(
      written
        .slice(1)
        .map((one) => `${one.type} ${one.subject} ${one.kind}`)
        .sort(),
    ).toEqual([
      "loop.drift.cleared loop:launchd/com.broomva.canary unregistered",
      "loop.drift.detected loop:canary paused_but_running",
    ]);
    // Read again with nothing changed: no line.
    clock += 60_000;
    await at.get();
    expect(written).toHaveLength(3);
    expect(loops).toBeDefined();
  });

  test("a restart reads drift.jsonl back: what is open is not written again", async () => {
    const { options, written } = await world(["com.broomva.canary"]);
    const home = join(options.streams);
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "drift.jsonl"),
      `${JSON.stringify({ v: 1, id: "01", ts: "2026-10-08T15:00:00.000Z", stream: "loops/drift", type: "loop.drift.detected", actor: "daemon:maestro", subject: "loop:launchd/com.broomva.canary", refs: {}, cause: null, data: { kind: "unregistered", detail: "x" }, prev: null })}\n`,
    );
    await new Loops(options).get();
    expect(written).toEqual([]);
  });

  test("a ledger that cannot be read judges nothing and writes nothing", async () => {
    const { options, written } = await world(["com.broomva.canary"]);
    const view = await new Loops({
      ...options,
      ledger: { where: { repo: "/x", path: "x" }, read: async () => Promise.reject(new Error("no origin/main")) },
    }).get();
    expect(view.rows.every((row) => row.drift.length === 0)).toBe(true);
    expect(view.warnings[0]).toContain("no origin/main");
    expect(written).toEqual([]);
  });

  test("a write that fails is said, never holds the lines after it, and is tried again after the back-off", async () => {
    const { options } = await world(["com.broomva.canary"], { now: false, extra: true });
    let fail = true;
    const lines: string[] = [];
    let clock = NOW;
    const loops = new Loops({
      ...options,
      now: () => clock,
      writer: async (line) => {
        if (fail && line.subject === "loop:launchd/com.broomva.canary") throw new Error("locked");
        lines.push(line.subject);
      },
    });
    expect((await loops.get()).warnings.join(" ")).toContain("locked");
    // The other unregistered loop (a gha workflow no row names) is written though the canary's line failed.
    expect(lines).toEqual(["loop:gha/broomva/x/w.yml"]);
    fail = false;
    clock += 60_000;
    await loops.get();
    expect(lines).toHaveLength(1);
    clock += WRITE_BACKOFF_MS;
    await loops.get();
    expect(lines).toEqual(["loop:gha/broomva/x/w.yml", "loop:launchd/com.broomva.canary"]);
  });

  test("a substrate that fails one read clears none of its open drift, and writes nothing when it is back", async () => {
    const fails = { now: false, extra: true };
    const { options, written } = await world([], fails);
    let clock = NOW;
    const loops = new Loops({ ...options, now: () => clock });
    await loops.get();
    expect(written.map((one) => `${one.type} ${one.subject}`)).toEqual([
      "loop.drift.detected loop:gha/broomva/x/w.yml",
    ]);
    fails.now = true;
    clock += 60_000;
    await loops.get();
    fails.now = false;
    clock += 60_000;
    await loops.get();
    expect(written).toHaveLength(1);
  });

  test("a restart with an open TARGET_CHANGED judges against the binding it was detected with: no cleared, no re-detected", async () => {
    const { options, written } = await world();
    const other = "0badc0de-0000-4000-8000-000000000000";
    await mkdir(options.streams, { recursive: true });
    await writeFile(
      join(options.streams, "drift.jsonl"),
      `${JSON.stringify({ v: 1, id: "01", ts: "2026-10-08T15:00:00.000Z", stream: "loops/drift", type: "loop.drift.detected", actor: "daemon:maestro", subject: "loop:coordinator-tick", refs: {}, cause: null, data: { kind: "target_changed", detail: "x", baseline: { agentId: other, prompt: "follow .broomva/loops/prompts/coordinator-tick.md" } }, prev: null })}\n`,
    );
    const view = await new Loops(options).get();
    expect(view.rows.find((row) => row.id === "coordinator-tick")?.drift.map((one) => one.kind)).toContain(
      "target_changed",
    );
    expect(written.filter((one) => one.subject === "loop:coordinator-tick")).toEqual([]);
  });
});

describe("partial reads are unread, never gone", () => {
  test("a schedule file caught mid-write leaves the Paseo rows unread: no false ACTIVE_BUT_ABSENT", async () => {
    const { options, root } = await world();
    await writeFile(join(root, "schedules", "44ab2429.json"), '{"id": "44ab24');
    const view = await new Loops(options).get();
    const row = view.rows.find((one) => one.id === "coordinator-tick");
    expect(row?.unread).toBe(true);
    expect(row?.drift).toEqual([]);
  });
  test("a Timeline that could not read launchd leaves the launchd rows unread", async () => {
    const { options, view: timeline } = await world();
    const broken = {
      ...timeline,
      sources: timeline.sources.filter((one) => one.kind !== "launchd"),
      warnings: ["launchd could not be read: launchctl list exited 1"],
    };
    const view = await new Loops({ ...options, timeline: { get: async () => broken } }).get();
    expect(view.rows.find((one) => one.id === "paseo-liveness")?.unread).toBe(true);
    expect(view.rows.every((one) => one.kind !== "launchd" || one.drift.length === 0)).toBe(true);
  });
});

describe("the streams", () => {
  test("envelope lines read; a torn one is skipped", () => {
    expect(
      envelopes('{"type":"loop.tick.started","subject":"loop:x","id":"1","ts":"t","data":{}}\n{torn\n'),
    ).toHaveLength(1);
  });
  test("a state file is ok, missing or unparseable", async () => {
    const root = await mkdtemp(join(tmpdir(), "state-"));
    roots.push(root);
    await writeFile(join(root, "ok.yaml"), "tick: T1\n");
    await writeFile(join(root, "bad.yaml"), "- just\n- a list\n");
    expect(await stateOf(join(root, "ok.yaml"))).toBe("ok");
    expect(await stateOf(join(root, "bad.yaml"))).toBe("unparseable");
    expect(await stateOf(join(root, "none.yaml"))).toBe("missing");
  });
});
