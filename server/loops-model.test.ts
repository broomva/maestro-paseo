import { describe, expect, test } from "bun:test";
import type { DriftClass, LoopIntent, LoopObservation, LoopRow, LoopRun } from "../shared/loops";
import { scheduleObservation } from "./loops";
import {
  AUTH_FAILURES,
  authFailure,
  type Binding,
  claimed,
  deadLogin,
  type Evidence,
  loopNeeds,
  nextBaselines,
  openFrom,
  ownFailure,
  reconcile,
  rolloverSeam,
  rowStub,
  type TickEvent,
  transitions,
} from "./loops-model";
import heartbeat from "./testdata/heartbeat-103a1850.json";

const M = 60_000;
const H = 60 * M;
const D = 24 * H;
const NOW = Date.parse("2026-10-08T16:00:00Z");
const iso = (at: number) => new Date(at).toISOString();
const AGENT = "f5307ce7-acb7-4687-b018-9cfbd322bca7";
const PROMPT = ".broomva/loops/prompts/coordinator-tick.md";
const POINTER = `git -C ~/broomva fetch -q origin main, then follow origin/main:${PROMPT}`;

function intent(extra: Partial<LoopIntent> = {}): LoopIntent {
  return {
    id: "kg-lint",
    title: "Knowledge-graph weekly lint",
    purpose: "Lint every entity page.",
    owner: "owner",
    scope: "broomva",
    initiative: null,
    substrate: { kind: "launchd", ref: "com.broomva.kg-lint" },
    cadence: "Sundays 02:30",
    desired: "active",
    desiredSince: null,
    reason: null,
    reviewBy: "2026-10-21",
    prompt: null,
    session: null,
    checks: null,
    file: ".broomva/loops/kg-lint.yaml",
    ...extra,
  };
}

function obs(extra: Partial<LoopObservation> = {}): LoopObservation {
  return {
    subject: "loop:launchd/com.broomva.kg-lint",
    kind: "launchd",
    ref: "com.broomva.kg-lint",
    name: "kg-lint",
    scope: "broomva",
    presence: "on",
    status: "ok",
    reason: "On schedule.",
    since: null,
    cadence: "Sundays at 02:30",
    next: null,
    last: null,
    runs: [],
    ephemeral: false,
    where: "/tmp/kg-lint.log",
    ...extra,
  };
}

function run(at: number, extra: Partial<LoopRun> = {}): LoopRun {
  return { at: iso(at), endedAt: iso(at + M), status: "ok", exit: null, detail: null, ...extra };
}

const kinds = (row: LoopRow | undefined) => (row?.drift ?? []).map((one) => one.kind);
const one = (intents: LoopIntent[], observations: LoopObservation[], evidence: Evidence = {}, now = NOW) =>
  reconcile(intents, observations, now, evidence)[0];
const has = (row: LoopRow | undefined, kind: DriftClass) => kinds(row).includes(kind);

/** The coordinator row as P1 ships it (§1a): bound, by name, with a prompt. */
const bound = (extra: Partial<LoopIntent> = {}) =>
  intent({
    id: "coordinator-tick",
    title: "Fleet coordinator tick",
    owner: "coordinator",
    substrate: { kind: "paseo-heartbeat", ref: "name:coordinator-tick" },
    prompt: PROMPT,
    session: "bound",
    file: ".broomva/loops/coordinator-tick.yaml",
    ...extra,
  });

/** Heartbeat 103a1850 as the daemon stored it on 2026-10-08 (the real runs), with an overridable prompt. */
function live(extra: Record<string, unknown> = {}): LoopObservation {
  const observed = scheduleObservation({ ...heartbeat, ...extra }, "/tmp/103a1850.json", null, NOW);
  if (!observed) throw new Error("the fixture no longer parses");
  return observed;
}

const tick = (
  type: "started" | "ended",
  id: string,
  ts: number,
  data: Record<string, unknown> = {},
  cause: string | null = null,
): TickEvent => ({
  id,
  ts: iso(ts),
  type: `loop.tick.${type}`,
  subject: "loop:coordinator-tick",
  cause,
  data,
});

describe("the joins", () => {
  test("a bound row joins its live schedule by name, the newest live one first", () => {
    const older = live({ id: "aaaaaaaa", createdAt: "2026-10-01T00:00:00Z" });
    const newer = live({ id: "bbbbbbbb", createdAt: "2026-10-08T00:00:00Z" });
    const off = live({ id: "cccccccc", status: "completed", createdAt: "2026-10-09T00:00:00Z" });
    expect(claimed(bound(), [older, off, newer]).map((one) => one.ref)).toEqual(["bbbbbbbb", "aaaaaaaa", "cccccccc"]);
    // A completed schedule of the bound name is the row's, never an unregistered loop.
    const rows = reconcile([bound()], [off, newer], NOW);
    expect(rows).toHaveLength(1);
  });

  test("a launchd row joins by subject; a gha row by repo and file", () => {
    expect(claimed(intent(), [obs()])).toHaveLength(1);
    expect(claimed(intent({ substrate: { kind: "launchd", ref: "com.broomva.kg-compile" } }), [obs()])).toHaveLength(0);
    const gha = obs({
      subject: "loop:gha/broomva/life/ci.yml",
      kind: "gha-schedule",
      ref: "broomva/life/.github/workflows/ci.yml",
    });
    expect(
      claimed(intent({ substrate: { kind: "gha-schedule", ref: "broomva/life/.github/workflows/ci.yml" } }), [gha]),
    ).toHaveLength(1);
  });

  test("a session-cron row matches on its prompt prefix, and on its owner unless *", () => {
    const cron = obs({
      subject: "loop:cc/s1/c1",
      kind: "session-cron",
      ref: "s1/c1",
      target: { agentId: null, prompt: "Coordinator tick: read the fleet" },
      session: { id: "s1", agentId: "f5307ce7-acb7", pid: 1, alive: true, endedAt: null },
    });
    const row = (ref: string) => intent({ substrate: { kind: "session-cron", ref } });
    expect(claimed(row("*#Coordinator tick"), [cron])).toHaveLength(1);
    expect(claimed(row("f5307ce7#Coordinator tick"), [cron])).toHaveLength(1);
    expect(claimed(row("0badc0de#Coordinator tick"), [cron])).toHaveLength(0);
    expect(claimed(row("*#Something else"), [cron])).toHaveLength(0);
  });
});

describe("PAUSED_BUT_RUNNING", () => {
  const paused = intent({ desired: "paused", desiredSince: "2026-10-04", reason: "Owner: pause until evals." });
  test("fires when a paused row's job will run (10-07: a reboot reloaded it)", () => {
    const row = one([paused], [obs({ presence: "on" })]);
    expect(kinds(row)).toEqual(["paused_but_running"]);
    expect(row?.drift[0]?.fix).toBe(
      "launchctl bootout gui/$UID/com.broomva.kg-lint && launchctl disable gui/$UID/com.broomva.kg-lint",
    );
    expect(row?.drift[0]?.needsYou).toBe(true);
  });
  test("fires on a run after the desired_since day, though it is off now", () => {
    const row = one(
      [paused],
      [obs({ presence: "off", status: "off", runs: [run(Date.parse("2026-10-05T02:30:00Z"))] })],
    );
    expect(has(row, "paused_but_running")).toBe(true);
  });
  test("does not fire when it is off and ran only on or before that day; retired is judged the same", () => {
    const runs = [run(Date.parse("2026-10-04T02:30:00Z"))];
    expect(kinds(one([paused], [obs({ presence: "off", status: "off", runs })]))).toEqual([]);
    expect(kinds(one([{ ...paused, desired: "retired" }], [obs({ presence: "on" })]))).toEqual(["paused_but_running"]);
    expect(kinds(one([paused], []))).toEqual([]);
  });
});

describe("ACTIVE_BUT_ABSENT", () => {
  test("fires with no observation, or one off or gone", () => {
    expect(kinds(one([intent()], []))).toEqual(["active_but_absent"]);
    const off = one([intent()], [obs({ presence: "off", status: "off" })]);
    expect(kinds(off)).toEqual(["active_but_absent"]);
    expect(off?.drift[0]?.fix).toContain("launchctl enable gui/$UID/com.broomva.kg-lint && launchctl bootstrap");
  });
  test("fires on the coordinator heartbeat once Paseo marked it completed (2026-10-08, found by this dogfood)", () => {
    const row = one([bound()], [live({ status: "completed" })]);
    expect(has(row, "active_but_absent")).toBe(true);
  });
  test("does not fire when it is on", () => {
    expect(kinds(one([intent()], [obs()]))).toEqual([]);
  });
  test("clears once the heartbeat is re-created under the name (44ab2429); the completed 103a1850 is history, not a duplicate", () => {
    const old = live({ status: "completed", prompt: POINTER });
    const recreated = live({ id: "44ab2429", prompt: POINTER, createdAt: "2026-10-08T17:00:00.000Z", runs: [] });
    const rows = reconcile([bound()], [old, recreated], NOW + 2 * H, {
      states: new Map([["coordinator-tick", "ok" as const]]),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.observed?.ref).toBe("44ab2429");
    expect(kinds(rows[0])).toEqual([]);
  });
});

describe("FAILING", () => {
  test("fires on an active row whose substrate says failed; the Timeline raises a launchd one, so no second notice", () => {
    const row = one([intent()], [obs({ status: "failed", reason: "Its last run failed: exit 1." })]);
    expect(kinds(row)).toEqual(["failing"]);
    expect(row?.drift[0]?.needsYou).toBe(false);
    const gha = obs({
      subject: "loop:gha/broomva/life/ci.yml",
      kind: "gha-schedule",
      ref: "broomva/life/.github/workflows/ci.yml",
      status: "failed",
    });
    const ghaRow = one(
      [intent({ substrate: { kind: "gha-schedule", ref: "broomva/life/.github/workflows/ci.yml" } })],
      [gha],
    );
    expect(ghaRow?.drift[0]).toMatchObject({ kind: "failing", needsYou: true });
  });
  test("does not fire when it worked, nor on a paused row", () => {
    expect(kinds(one([intent()], [obs()]))).toEqual([]);
    expect(
      has(
        one([intent({ desired: "paused", desiredSince: "2026-10-04" })], [obs({ presence: "off", status: "failed" })]),
        "failing",
      ),
    ).toBe(false);
  });
  test("a bound row's busy fire is not a failure (6799944e); a real failure under it is", () => {
    const busy = run(NOW - H, { status: "failed", detail: `Agent ${AGENT} already has an active run` });
    const restart = run(NOW - 3 * H, {
      status: "failed",
      detail: "Daemon restarted before the scheduled run completed",
    });
    const good = run(NOW - 3 * H);
    expect(has(one([bound({ prompt: null, session: null })], [live({ runs: [] })]), "failing")).toBe(false);
    const withRuns = (runs: LoopRun[]) => ({ ...live(), status: "failed" as const, runs });
    expect(has(one([bound()], [withRuns([busy, good])]), "failing")).toBe(false);
    expect(has(one([bound()], [withRuns([busy, restart])]), "failing")).toBe(true);
  });
});

describe("MISSED", () => {
  test("fires on an active row the substrate calls missed, with the run-once verb", () => {
    const row = one([intent()], [obs({ status: "missed", reason: "Its run came due and has not started." })]);
    expect(row?.drift[0]).toMatchObject({ kind: "missed", fix: "launchctl kickstart gui/$UID/com.broomva.kg-lint" });
  });
  test("does not fire on ok or running", () => {
    expect(kinds(one([intent()], [obs({ status: "running" })]))).toEqual([]);
  });
});

describe("UNREGISTERED", () => {
  test("fires on a broomva loop no row claims, with a YAML stub", () => {
    const row = one(
      [],
      [obs({ subject: "loop:launchd/com.broomva.canary", ref: "com.broomva.canary", name: "canary" })],
    );
    expect(row?.drift[0]).toMatchObject({ kind: "unregistered", needsYou: true });
    expect(row?.drift[0]?.fix).toContain("Add .broomva/loops/canary.yaml");
    expect(row?.drift[0]?.fix).toContain('substrate: {kind: launchd, ref: "com.broomva.canary"}');
  });
  test("does not fire on an ephemeral, an external, an sri, a gone, or a claimed one", () => {
    expect(kinds(one([], [obs({ ephemeral: true })]))).toEqual([]);
    expect(one([], [obs({ ephemeral: true })])?.section).toBe("ephemeral");
    expect(kinds(one([], [obs({ scope: "external" })]))).toEqual([]);
    expect(kinds(one([], [obs({ scope: "sri" })]))).toEqual([]);
    expect(kinds(one([], [obs({ presence: "gone" })]))).toEqual([]);
    expect(reconcile([intent()], [obs()], NOW)).toHaveLength(1);
  });
});

describe("BOUND_SESSION_GONE", () => {
  const archived = { found: true, archivedAt: "2026-10-08T12:00:00Z" };
  test("(a) fires when the target agent is archived or not in Paseo, with the rollover seam", () => {
    const row = one([bound()], [live()], { agents: new Map([[AGENT, archived]]) });
    expect(has(row, "bound_session_gone")).toBe(true);
    const gone = row?.drift.find((one) => one.kind === "bound_session_gone");
    expect(gone?.fix).toContain(`scripts/loop_rollover.py coordinator-tick --expect-agent ${AGENT}`);
    expect(
      has(
        one([bound()], [live()], { agents: new Map([[AGENT, { found: false, archivedAt: null }]]) }),
        "bound_session_gone",
      ),
    ).toBe(true);
  });
  test("(a) 2026-10-08 15:23Z: the app archived f5307ce7, completing its heartbeat; the row says both", () => {
    const row = one([bound()], [live({ status: "completed" })], {
      agents: new Map([[AGENT, { found: true, archivedAt: "2026-10-08T15:23:21.355Z" }]]),
    });
    expect(kinds(row)).toEqual(expect.arrayContaining(["active_but_absent", "bound_session_gone"]));
  });
  test("(a) does not fire when the agent is there, or was not looked up, or the row is not bound", () => {
    expect(
      has(
        one([bound()], [live()], { agents: new Map([[AGENT, { found: true, archivedAt: null }]]) }),
        "bound_session_gone",
      ),
    ).toBe(false);
    expect(has(one([bound()], [live()], {}), "bound_session_gone")).toBe(false);
    const fresh = bound({ session: "fresh" });
    expect(has(one([fresh], [live()], { agents: new Map([[AGENT, archived]]) }), "bound_session_gone")).toBe(false);
  });

  // (b): a property contract (spec §4, 0f933c79d), each clause driven here.
  const denied = "API Error: 403 Your organization has disabled Claude subscription access for Claude Code.";
  const okTick = [
    tick("started", "T1", NOW - 10 * H, { fire: iso(NOW - 10 * H) }),
    tick("ended", "T2", NOW - 10 * H + 5 * M, { outcome: "ok" }, "T1"),
  ];
  const dead = (at: number, extra: Partial<LoopRun> = {}) =>
    run(at, { scheduledFor: iso(at), status: "failed", detail: denied, ...extra });
  const present = new Map([[AGENT, { found: true, archivedAt: null }]]);
  const judge = (runs: LoopRun[], ticks: TickEvent[] = okTick) => deadLogin(bound(), runs, NOW, ticks);

  test("(b) fires when each of the last two judged runs failed on the session's own login failure", () => {
    expect(judge([dead(NOW - 2 * H), dead(NOW - 4 * H)])).toContain(
      "organization has disabled Claude subscription access",
    );
    const row = one([bound()], [{ ...live(), runs: [dead(NOW - 2 * H), dead(NOW - 4 * H)] }], {
      agents: present,
      ticks: okTick,
    });
    expect(has(row, "bound_session_gone")).toBe(true);
  });
  test("(b) counts an output that IS an API error, on a fire that never ticked", () => {
    const silent = (at: number) => run(at, { scheduledFor: iso(at), status: "ok", output: denied });
    expect(judge([silent(NOW - 2 * H), silent(NOW - 4 * H)])).not.toBeNull();
  });
  test("(b) never fires on the real 103a1850 runs: 6c5147fd quotes another agent's failure, 03:13/05:13 replay a message", () => {
    const real = live().runs;
    const adopted = [
      tick("started", "R1", Date.parse("2026-10-08T02:00:00Z"), { fire: "2026-10-08T01:13:00.000Z" }),
      tick("ended", "R2", Date.parse("2026-10-08T02:05:00Z"), { outcome: "ok" }, "R1"),
    ];
    // The observation keeps 280 characters of output; the run as stored quotes the failure past them.
    const quoting = heartbeat.runs.find((one) => one.id.startsWith("6c5147fd"));
    expect(quoting?.output).toContain("organization has disabled Claude subscription access");
    const full = run(Date.parse("2026-10-08T07:13:00Z"), {
      output: quoting?.output ?? "",
      scheduledFor: "2026-10-08T07:13:00.000Z",
    });
    expect(authFailure(full.output)).toBe(true);
    expect(ownFailure(full)).toBeNull();
    expect(deadLogin(bound(), real, NOW, adopted)).toBeNull();
    // Only the 07:13 run as the newest two judged, around a replay: still nothing of its own.
    const quoted = real.filter((one) =>
      ["2026-10-08T07:13:00.000Z", "2026-10-08T05:13:00.000Z"].includes(one.scheduledFor ?? ""),
    );
    expect(deadLogin(bound(), quoted, NOW, adopted)).toBeNull();
  });
  test("(b) never fires while the row has no ok tick, nor on runs before its first started tick", () => {
    expect(judge([dead(NOW - 2 * H), dead(NOW - 4 * H)], [])).toBeNull();
    const startedOnly = [tick("started", "S", NOW - 10 * H, { fire: iso(NOW - 10 * H) })];
    expect(judge([dead(NOW - 2 * H), dead(NOW - 4 * H)], startedOnly)).toBeNull();
    const lateAdoption = [
      tick("started", "L1", NOW - 3 * H, { fire: iso(NOW - 3 * H) }),
      tick("ended", "L2", NOW - 3 * H + M, { outcome: "ok" }, "L1"),
    ];
    expect(judge([dead(NOW - 2 * H), dead(NOW - 4 * H)], lateAdoption)).toBeNull();
  });
  test("(b) busy fires never count, and one glitch never qualifies", () => {
    const busy = (at: number) =>
      run(at, { scheduledFor: iso(at), status: "failed", detail: `Agent ${AGENT} already has an active run` });
    expect(judge([busy(NOW - H), dead(NOW - 2 * H), busy(NOW - 3 * H), dead(NOW - 4 * H)])).not.toBeNull();
    expect(
      judge([
        dead(NOW - 2 * H),
        run(NOW - 4 * H, { scheduledFor: iso(NOW - 4 * H), status: "failed", detail: "Daemon restarted" }),
      ]),
    ).toBeNull();
    expect(judge([dead(NOW - 2 * H)])).toBeNull();
  });
  test("(b) an old failure that a later ok tick fixed never revives", () => {
    const fixed = [
      ...okTick,
      tick("started", "F1", NOW - H, { fire: iso(NOW - H) }),
      tick("ended", "F2", NOW - H + M, { outcome: "ok" }, "F1"),
    ];
    expect(judge([dead(NOW - 2 * H), dead(NOW - 4 * H)], fixed)).toBeNull();
  });
  test("the pinned auth list has a fixture each, and the safeguards error of f13552f7 is not one", () => {
    for (const text of [
      "Your organization has disabled Claude subscription access for Claude Code",
      "OAuth token has expired. Please obtain a new token",
      "Invalid API key · Please run /login",
      "Please run /login",
      'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
      "Login expired",
    ]) {
      expect(authFailure(text)).toBe(true);
    }
    expect(AUTH_FAILURES.length).toBe(6);
    const f135 = live().runs.find((one) => one.scheduledFor === "2026-10-08T11:13:00.000Z");
    expect(f135?.output?.startsWith("API Error")).toBe(true);
    expect(ownFailure(f135 as LoopRun)).toBeNull();
  });
});

describe("PROMPT_MISMATCH", () => {
  test("fires when the substrate's prompt does not name the row's prompt (the inline coordinator prompt)", () => {
    const row = one([bound()], [live()]);
    expect(row?.drift.find((one) => one.kind === "prompt_mismatch")?.fix).toContain(`origin/main:${PROMPT}`);
  });
  test("does not fire when the substrate carries the pointer, or the row has no prompt", () => {
    expect(has(one([bound()], [live({ prompt: POINTER })]), "prompt_mismatch")).toBe(false);
    expect(has(one([bound({ prompt: null, session: null })], [live()]), "prompt_mismatch")).toBe(false);
  });
});

describe("TICK_UNCLOSED", () => {
  const pointer = () => live({ prompt: POINTER, runs: [] });
  const ev = (ticks: TickEvent[]): Evidence => ({ ticks, states: new Map([["coordinator-tick", "ok" as const]]) });
  test("fires when the latest started tick has no end past 60 min, measured from the start", () => {
    const row = one([bound()], [pointer()], ev([tick("started", "A", NOW - 61 * M, { fire: iso(NOW - 61 * M) })]));
    expect(kinds(row)).toEqual(["tick_unclosed"]);
  });
  test("waits 2x the median tick when that is longer", () => {
    const long = [
      tick("started", "P1", NOW - 10 * H, {}),
      tick("ended", "P2", NOW - 10 * H + 50 * M, { outcome: "ok" }, "P1"),
      tick("started", "Q1", NOW - 8 * H, {}),
      tick("ended", "Q2", NOW - 8 * H + 50 * M, { outcome: "ok" }, "Q1"),
    ];
    expect(kinds(one([bound()], [pointer()], ev([...long, tick("started", "A", NOW - 61 * M)])))).toEqual([]);
    expect(kinds(one([bound()], [pointer()], ev([...long, tick("started", "A", NOW - 101 * M)])))).toEqual([
      "tick_unclosed",
    ]);
  });
  test("does not fire under the limit, once closed, or when a later tick closed (a row state)", () => {
    expect(kinds(one([bound()], [pointer()], ev([tick("started", "A", NOW - 30 * M)])))).toEqual([]);
    expect(
      kinds(
        one(
          [bound()],
          [pointer()],
          ev([tick("started", "A", NOW - 2 * H), tick("ended", "B", NOW - H, { outcome: "ok" }, "A")]),
        ),
      ),
    ).toEqual([]);
    const crashedThenOk = [
      tick("started", "A", NOW - 5 * H),
      tick("started", "C", NOW - 2 * H),
      tick("ended", "D", NOW - 2 * H + M, { outcome: "ok" }, "C"),
    ];
    expect(kinds(one([bound()], [pointer()], ev(crashedThenOk)))).toEqual([]);
  });
});

describe("TICK_MISSING", () => {
  const fire = (at: number, extra: Partial<LoopRun> = {}) => run(at, { scheduledFor: iso(at), ...extra });
  const adoption = tick("started", "A0", NOW - 6 * H, { fire: iso(NOW - 6 * H) });
  const closed = tick("ended", "A1", NOW - 6 * H + M, { outcome: "ok" }, "A0");
  const ev = (ticks: TickEvent[]): Evidence => ({ ticks });
  const at = (runs: LoopRun[]) => ({ ...live({ prompt: POINTER }), runs });
  test("fires when the latest judged run, 30 min on, has no started tick for its slot", () => {
    const row = one([bound()], [at([fire(NOW - 40 * M)])], ev([adoption, closed]));
    expect(kinds(row)).toEqual(["tick_missing"]);
  });
  test("clears when the late tick arrives, however late", () => {
    const late = tick("started", "L", NOW - M, { fire: iso(NOW - 40 * M) });
    const end = tick("ended", "L2", NOW, { outcome: "ok" }, "L");
    expect(kinds(one([bound()], [at([fire(NOW - 40 * M)])], ev([adoption, closed, late, end])))).toEqual([]);
  });
  test("does not judge runs before adoption, runs under 30 min, busy fires, or a row never adopted", () => {
    expect(kinds(one([bound()], [at([fire(NOW - 7 * H)])], ev([adoption, closed])))).toEqual([]);
    expect(kinds(one([bound()], [at([fire(NOW - 20 * M)])], ev([adoption, closed])))).toEqual([]);
    const busy = fire(NOW - 40 * M, { status: "failed", detail: "already has an active run" });
    expect(has(one([bound()], [at([busy])], ev([adoption, closed])), "tick_missing")).toBe(false);
    expect(kinds(one([bound()], [at([fire(NOW - 40 * M)])], ev([])))).toEqual([]);
  });
});

describe("SKIPPED_BUSY", () => {
  const busy = (at: number) => run(at, { status: "failed", detail: `Agent ${AGENT} already has an active run` });
  const at = (runs: LoopRun[]) => ({ ...live({ prompt: POINTER }), status: "failed" as const, runs });
  test("fires after three busy fires in a row, and never as FAILING", () => {
    const row = one([bound()], [at([busy(NOW - H), busy(NOW - 3 * H), busy(NOW - 5 * H)])]);
    expect(kinds(row)).toEqual(["skipped_busy"]);
  });
  test("does not fire on two, nor when a run between them went through", () => {
    expect(kinds(one([bound()], [at([busy(NOW - H), busy(NOW - 3 * H)])]))).toEqual([]);
    expect(
      kinds(one([bound()], [at([busy(NOW - H), busy(NOW - 3 * H), run(NOW - 5 * H), busy(NOW - 7 * H)])])),
    ).toEqual([]);
  });
});

describe("DUPLICATE_BINDING", () => {
  test("fires when two live schedules carry the name past 10 min, naming the one to delete", () => {
    const old = live({ id: "aaaaaaaa", prompt: POINTER, createdAt: iso(NOW - D) });
    const fresh = live({ id: "bbbbbbbb", prompt: POINTER, createdAt: iso(NOW - 11 * M) });
    const row = one([bound()], [old, fresh]);
    expect(row?.drift.find((one) => one.kind === "duplicate_binding")?.fix).toBe("paseo schedule delete aaaaaaaa");
  });
  test("does not fire inside a rollover's minutes, nor when the other is not live", () => {
    const old = live({ id: "aaaaaaaa", prompt: POINTER, createdAt: iso(NOW - D) });
    expect(
      has(
        one([bound()], [old, live({ id: "bbbbbbbb", prompt: POINTER, createdAt: iso(NOW - 5 * M) })]),
        "duplicate_binding",
      ),
    ).toBe(false);
    expect(
      has(
        one([bound()], [old, live({ id: "bbbbbbbb", status: "completed", createdAt: iso(NOW - H) })]),
        "duplicate_binding",
      ),
    ).toBe(false);
  });
});

describe("TARGET_CHANGED", () => {
  const OTHER = "0badc0de-0000-4000-8000-000000000000";
  const now = live({ prompt: POINTER });
  const base = (binding: Partial<Binding>): Evidence => ({
    baselines: new Map([["coordinator-tick", { agentId: AGENT, prompt: POINTER, ...binding }]]),
  });
  const completed = (data: Record<string, unknown>): TickEvent => ({
    id: "R",
    ts: iso(NOW - H),
    type: "loop.rollover.completed",
    subject: "loop:coordinator-tick",
    cause: null,
    data,
  });
  test("fires when the target moved with no rollover naming it", () => {
    expect(has(one([bound()], [now], base({ agentId: OTHER })), "target_changed")).toBe(true);
  });
  test("fires when the prompt changed with no rollover naming it", () => {
    expect(has(one([bound()], [now], base({ prompt: "follow the old prompt" })), "target_changed")).toBe(true);
  });
  test("does not fire when the latest loop.rollover.completed names the live target and prompt, nor at first sight", () => {
    const rolled = completed({
      old_agent: OTHER,
      new_agent: AGENT,
      old_schedule: "aaaaaaaa",
      new_schedule: "103a1850",
      prompt: POINTER,
      attempt: 1,
    });
    expect(
      has(one([bound()], [now], { ...base({ agentId: OTHER, prompt: "old" }), rollovers: [rolled] }), "target_changed"),
    ).toBe(false);
    expect(has(one([bound()], [now], {}), "target_changed")).toBe(false);
    expect(has(one([bound()], [now], base({})), "target_changed")).toBe(false);
  });
  test("a TARGET_CHANGED keeps its baseline until answered; a clean row takes the live binding", () => {
    const moved = reconcile([bound()], [now], NOW, base({ agentId: OTHER }));
    expect(
      nextBaselines(moved, new Map([["coordinator-tick", { agentId: OTHER, prompt: POINTER }]])).get("coordinator-tick")
        ?.agentId,
    ).toBe(OTHER);
    const clean = reconcile([bound()], [now], NOW, {});
    expect(nextBaselines(clean, new Map()).get("coordinator-tick")).toEqual({ agentId: AGENT, prompt: POINTER });
  });
});

describe("STATE_LOST", () => {
  const at = live({ prompt: POINTER });
  test("fires when an active prompted row's state file is missing or unparseable", () => {
    expect(kinds(one([bound()], [at], { states: new Map([["coordinator-tick", "missing"]]) }))).toEqual(["state_lost"]);
    expect(kinds(one([bound()], [at], { states: new Map([["coordinator-tick", "unparseable"]]) }))).toEqual([
      "state_lost",
    ]);
  });
  test("does not fire when it reads, or the row has no prompt", () => {
    expect(kinds(one([bound()], [at], { states: new Map([["coordinator-tick", "ok"]]) }))).toEqual([]);
    expect(has(one([intent()], [obs()], { states: new Map([["kg-lint", "missing"]]) }), "state_lost")).toBe(false);
  });
});

describe("ORPHANED and EXPIRING (session crons; P3 fills the adapter)", () => {
  const cron = (session: Partial<NonNullable<LoopObservation["session"]>>, extra: Partial<LoopObservation> = {}) =>
    obs({
      subject: "loop:cc/44f52388/42152ef6",
      kind: "session-cron",
      ref: "44f52388/42152ef6",
      recurring: true,
      ephemeral: true,
      target: { agentId: null, prompt: "Coordinator tick" },
      session: {
        id: "44f52388",
        agentId: AGENT,
        pid: 4242,
        alive: false,
        endedAt: iso(NOW - H),
        lastEventAt: iso(NOW - H),
        ...session,
      },
      ...extra,
    });
  const row = intent({ id: "coordinator-cron", substrate: { kind: "session-cron", ref: "*#Coordinator tick" } });
  test("10-06: a recurring cron whose session died is ORPHANED, which outranks ACTIVE_BUT_ABSENT", () => {
    const got = one([row], [cron({})]);
    expect(kinds(got)).toEqual(["orphaned"]);
    expect(got?.drift[0]?.needsYou).toBe(true);
  });
  test("not orphaned while its session lives, nor once its last event is a week old", () => {
    expect(has(one([row], [cron({ alive: true, endedAt: null })]), "orphaned")).toBe(false);
    expect(has(one([row], [cron({ endedAt: iso(NOW - 8 * D), lastEventAt: iso(NOW - 8 * D) })]), "orphaned")).toBe(
      false,
    );
  });
  test("an unclaimed one's orphaning is a badge, never Needs you", () => {
    expect(one([], [cron({})])?.drift[0]).toMatchObject({ kind: "orphaned", needsYou: false });
  });
  test("EXPIRING fires inside its last day, and says when its age is only a lower bound", () => {
    const alive = { alive: true, endedAt: null };
    const got = one([row], [cron(alive, { createdAt: iso(NOW - 6.5 * D), createdAtLowerBound: true })]);
    expect(kinds(got)).toEqual(["expiring"]);
    expect(got?.drift[0]?.detail).toContain("lower bound");
    expect(kinds(one([row], [cron(alive, { createdAt: iso(NOW - D) })]))).toEqual([]);
  });
});

describe("scope and reads", () => {
  test("an sri row gets badges but never Needs you", () => {
    const sri = intent({ scope: "sri", desired: null, owner: "sri-orchestrator" });
    const row = one([sri], [obs({ status: "failed", scope: "sri" })]);
    expect(row?.drift[0]).toMatchObject({ kind: "failing", needsYou: false });
    expect(loopNeeds([row as LoopRow])).toEqual([]);
  });
  test("a substrate that could not be read judges nothing: no false ACTIVE_BUT_ABSENT", () => {
    const row = one([intent()], [], { unread: new Set(["launchd"]) });
    expect(row?.unread).toBe(true);
    expect(kinds(row)).toEqual([]);
  });
});

describe("Needs you and transitions", () => {
  test("loopNeeds carries each needs-you drift with its pinned fix", () => {
    const rows = reconcile([intent({ desired: "paused", desiredSince: "2026-10-04" })], [obs()], NOW);
    expect(loopNeeds(rows)).toEqual([
      {
        id: "loop:kg-lint#paused_but_running",
        subject: "loop:kg-lint",
        loop: "kg-lint",
        kind: "paused_but_running",
        detail: "It is paused in the ledger, and launchd will run it.",
        fix: "launchctl bootout gui/$UID/com.broomva.kg-lint && launchctl disable gui/$UID/com.broomva.kg-lint",
      },
    ]);
  });
  test("only transitions are written: detected once, nothing while it holds, cleared once", () => {
    const drifting = reconcile([intent()], [], NOW);
    const first = transitions(new Map(), drifting);
    expect(first.lines.map((line) => `${line.type} ${line.kind}`)).toEqual(["loop.drift.detected active_but_absent"]);
    expect(transitions(first.open, drifting).lines).toEqual([]);
    const cleared = transitions(first.open, reconcile([intent()], [obs()], NOW));
    expect(cleared.lines.map((line) => line.type)).toEqual(["loop.drift.cleared"]);
    expect(cleared.open.size).toBe(0);
  });
  test("an unread row keeps what it had open: nothing is cleared on a failed read", () => {
    const first = transitions(new Map(), reconcile([intent()], [], NOW));
    const unread = transitions(first.open, reconcile([intent()], [], NOW, { unread: new Set(["launchd"]) }));
    expect(unread.lines).toEqual([]);
    expect(unread.open.size).toBe(1);
  });
  test("drift.jsonl folds back to what is open, across a restart", () => {
    const line = (type: string, kind: string, subject = "loop:kg-lint") => ({
      type,
      subject,
      data: { kind, detail: "x" },
    });
    const open = openFrom([
      line("loop.drift.detected", "active_but_absent"),
      line("loop.drift.detected", "failing"),
      line("loop.drift.cleared", "failing"),
      line("loop.drift.detected", "not_a_class"),
    ]);
    expect([...open.keys()]).toEqual(["loop:kg-lint#active_but_absent"]);
  });
});

describe("the seams", () => {
  test("the rollover seam is keyed on (loop, old agent, attempt) and runs nothing", () => {
    const seam = rolloverSeam(bound(), AGENT, 2);
    expect(seam.key).toBe(`coordinator-tick:${AGENT}:2`);
    expect(seam.steps).toContain("BRO-2933");
    expect(rolloverSeam(bound({ owner: "owner" }), AGENT).steps).toStartWith("Roll over coordinator-tick by hand");
  });
  test("an unregistered row's stub is a slug id", () => {
    expect(rowStub(obs({ ref: "com.broomva.Paseo_Liveness" })).id).toBe("paseo-liveness");
  });
});

describe("P20 round 1 regressions", () => {
  const OTHER = "0badc0de-0000-4000-8000-000000000000";
  const event = (type: string, ts: number, data: Record<string, unknown> = {}): TickEvent => ({
    id: type,
    ts: iso(ts),
    type,
    subject: "loop:coordinator-tick",
    cause: null,
    data,
  });
  test("a rollover in flight raises neither ACTIVE_BUT_ABSENT nor TARGET_CHANGED; one over 20 min old does", () => {
    const paused = live({ status: "paused", prompt: POINTER });
    const started = [event("loop.rollover.started", NOW - 5 * M, { old_agent: AGENT })];
    const evidence: Evidence = {
      rollovers: started,
      baselines: new Map([["coordinator-tick", { agentId: OTHER, prompt: POINTER }]]),
    };
    const row = one([bound()], [paused], evidence);
    expect(has(row, "active_but_absent")).toBe(false);
    expect(has(row, "target_changed")).toBe(false);
    const stale = { ...evidence, rollovers: [event("loop.rollover.started", NOW - 25 * M)] };
    expect(has(one([bound()], [paused], stale), "active_but_absent")).toBe(true);
    const failed = { ...evidence, rollovers: [...started, event("loop.rollover.failed", NOW - M)] };
    expect(has(one([bound()], [paused], failed), "active_but_absent")).toBe(true);
  });
  test("TICK_MISSING is a row state: a later run that ticked clears it, and a newest run under 30 min waits", () => {
    const fire = (at: number) => run(at, { scheduledFor: iso(at) });
    const ticks = [
      tick("started", "A0", NOW - 6 * H, { fire: iso(NOW - 6 * H) }),
      tick("ended", "A1", NOW - 6 * H + M, { outcome: "ok" }, "A0"),
      tick("started", "B0", NOW - 2 * H + M, { fire: iso(NOW - 2 * H) }),
    ];
    const at = (runs: LoopRun[]) => ({ ...live({ prompt: POINTER }), runs });
    // A later run that ticked clears the older miss.
    expect(has(one([bound()], [at([fire(NOW - 2 * H), fire(NOW - 4 * H)])], { ticks }), "tick_missing")).toBe(false);
    expect(has(one([bound()], [at([fire(NOW - 4 * H)])], { ticks }), "tick_missing")).toBe(true);
    // A dead session's new fire, still in its window, does not clear the open miss (no flap every fire).
    expect(has(one([bound()], [at([fire(NOW - 10 * M), fire(NOW - 4 * H)])], { ticks }), "tick_missing")).toBe(true);
    // A young fire that already ticked clears it.
    const young = [...ticks, tick("started", "Y0", NOW - 9 * M, { fire: iso(NOW - 10 * M) })];
    expect(has(one([bound()], [at([fire(NOW - 10 * M), fire(NOW - 4 * H)])], { ticks: young }), "tick_missing")).toBe(
      false,
    );
  });
  test("(b) is judged without an agent lookup: it needs only the runs and ticks", () => {
    const denied = "API Error: 403 Your organization has disabled Claude subscription access";
    const dead = (at: number) => run(at, { scheduledFor: iso(at), status: "failed", detail: denied });
    const ticks = [
      tick("started", "T1", NOW - 10 * H, { fire: iso(NOW - 10 * H) }),
      tick("ended", "T2", NOW - 10 * H + M, { outcome: "ok" }, "T1"),
    ];
    const row = one([bound()], [{ ...live({ prompt: POINTER }), runs: [dead(NOW - 2 * H), dead(NOW - 4 * H)] }], {
      ticks,
    });
    expect(has(row, "bound_session_gone")).toBe(true);
  });
  test("the baseline is frozen while a rollover is in flight, so a failed rollover that resumes the old agent is no change", () => {
    const rolling = [event("loop.rollover.started", NOW - 5 * M)];
    const successor = live({ prompt: POINTER, target: { type: "agent", agentId: OTHER } });
    const rows = reconcile([bound()], [successor], NOW, {
      rollovers: rolling,
      baselines: new Map([["coordinator-tick", { agentId: AGENT, prompt: POINTER }]]),
    });
    const next = nextBaselines(
      rows,
      new Map([["coordinator-tick", { agentId: AGENT, prompt: POINTER }]]),
      NOW,
      rolling,
    );
    expect(next.get("coordinator-tick")?.agentId).toBe(AGENT);
  });
  test("an unread GitHub repo keeps its unclaimed workflow's open drift; another repo's still clears", () => {
    const open = new Map([
      [
        "loop:gha/broomva/x/w.yml#unregistered",
        { subject: "loop:gha/broomva/x/w.yml", kind: "unregistered" as const, detail: "d" },
      ],
      [
        "loop:gha/broomva/y/w.yml#unregistered",
        { subject: "loop:gha/broomva/y/w.yml", kind: "unregistered" as const, detail: "d" },
      ],
    ]);
    const got = transitions(open, [], new Set(["gha-schedule:broomva/x"]));
    expect(got.lines.map((line) => `${line.type} ${line.subject}`)).toEqual([
      "loop.drift.cleared loop:gha/broomva/y/w.yml",
    ]);
    expect([...got.open.keys()]).toEqual(["loop:gha/broomva/x/w.yml#unregistered"]);
  });
});
