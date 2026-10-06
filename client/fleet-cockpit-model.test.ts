// The cockpit's rules (BRO-2837): the roster's buckets and filters, the Needs
// you queue, the tick strip, the verdict, the cadence and the latest tick's
// steps. Each count is read off the wire, so each is checked against it here.

import { describe, expect, test } from "bun:test";
import {
  askNotice,
  type DecisionAsk,
  type FleetDetail,
  type FleetHealth,
  type FleetProposal,
  type FleetScope,
  type FleetSession,
  type FleetTick,
  type ProposalGroup,
} from "../shared/fleet";
import {
  activeWords,
  adoptTitle,
  ageWords,
  askAge,
  askedSessions,
  askLines,
  askTag,
  askWhen,
  bucketOf,
  cadenceText,
  canAdopt,
  cellAxis,
  cutWords,
  displayName,
  evidenceSentence,
  featuredScope,
  filterRoster,
  fleetNeedsYou,
  headerShares,
  healthCells,
  historyKind,
  historyText,
  linkSession,
  middlePath,
  modeBadge,
  needsText,
  nextTickAt,
  oldestText,
  placedWords,
  plainAction,
  plainEvidence,
  plainStep,
  proposalTitle,
  resumeCommand,
  reviewedGroups,
  rosterCounts,
  rosterRows,
  type ScopeRead,
  shellQuote,
  shortPath,
  teachQueue,
  tickLine,
  tickSteps,
  verdictNote,
  verdictOf,
  wantsAttention,
  wouldText,
} from "./fleet-cockpit-model";
import { needsYouCount } from "./header-count";

const NOW = new Date(2026, 9, 5, 19, 0).getTime();
const H = 3_600_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function session(id: string, classId: string, state: string | null, extra: Partial<FleetSession> = {}): FleetSession {
  return {
    id: `${id}-x`,
    short: id,
    name: `s-${id}`,
    kind: "interactive",
    state,
    cwd: "~/broomva",
    branch: null,
    agentId: null,
    classId,
    className: null,
    action: classId === "10" ? "report only" : "nothing",
    evidence: null,
    activeAt: ago(H),
    scope: "broomva",
    placement: "cwd",
    inScope: classId !== "1",
    history: [],
    ...extra,
  };
}

function tick(
  n: number,
  hoursAgo: number,
  status: FleetTick["status"] = "ok",
  extra: Partial<FleetTick> = {},
): FleetTick {
  return {
    tick: n,
    at: ago(hoursAgo * H),
    finishedAt: ago(hoursAgo * H - 10_000),
    status,
    exit: status === "ok" ? 0 : 1,
    steps: "recover=0 observe=0 report=0 compare=0 ask=0",
    failedStep: null,
    dryRun: true,
    mode: "report",
    classCounts: [
      { id: "1", name: "out of scope", count: 50 },
      { id: "5", name: "running", count: 3 },
      { id: "10", name: "unmanaged", count: 5 },
    ],
    openAsks: 0,
    proposals: 5,
    ...extra,
  };
}

const ok = { status: "ok" as const, reason: "Ticks every hour.", notice: "", since: null, item: null, needsYou: false };

function scope(id: string, extra: Partial<FleetScope> = {}): FleetScope {
  return {
    id,
    mode: "report",
    dryRun: true,
    health: ok,
    lastTick: { tick: 108, at: ago(0.5 * H), status: "ok" },
    unreviewed: 0,
    openAsks: 0,
    ...extra,
  };
}

function detail(id: string, extra: Partial<FleetDetail> = {}): FleetDetail {
  return {
    id,
    stateDir: `/state/${id}`,
    schedule: { scheduled: true, intervalMinutes: 60 },
    ticks: [tick(108, 0.5), tick(107, 1.5)],
    report: null,
    proposals: [],
    asks: [],
    decisions: [],
    askRoot: `/state/${id}/.control/asks`,
    alerts: [],
    warnings: [],
    roster: { tick: 108, at: ago(0.5 * H), sessions: [] },
    ...extra,
  };
}

function proposal(short: string, review: FleetProposal["review"] = null): FleetProposal {
  return {
    key: `session:${short}:10:abc`,
    source: "report",
    tick: 108,
    at: ago(H),
    action: "report only",
    session: {
      id: `${short}-x`,
      short,
      name: `s-${short}`,
      kind: "interactive",
      status: "idle",
      cwd: "~",
      branch: null,
      agentId: null,
    },
    classId: "10",
    className: "unmanaged",
    evidence: "no fleet key, not adopted",
    verb: null,
    review,
  };
}

describe("the roster", () => {
  const reads: ScopeRead[] = [
    {
      scope: scope("broomva"),
      detail: detail("broomva", {
        roster: {
          tick: 108,
          at: ago(0.5 * H),
          sessions: [
            session("run1", "5", "busy", { activeAt: ago(60_000) }),
            session("idle1", "10", "idle", { activeAt: ago(26 * 24 * H) }),
            session("fail1", "4", "failed"),
            session("blk1", "7", "blocked"),
            session("out1", "1", "done", { scope: "sri" }),
            session("gone1", "1", "done", { scope: null, placement: "unplaced" }),
          ],
        },
        asks: [
          {
            id: "a1",
            key: "prompt:idle1-x:abc",
            question: "?",
            class: "count",
            className: null,
            firstTick: 2,
            session: { id: "idle1-x", short: "idle1", name: null, agentId: null },
            batch: null,
            item: null,
          },
        ],
      }),
    },
    {
      scope: scope("sri"),
      detail: detail("sri", {
        roster: {
          tick: 12,
          at: null,
          sessions: [
            session("out1", "5", "busy", { scope: "sri" }),
            session("run1", "1", "busy", { scope: "broomva" }),
          ],
        },
      }),
    },
  ];

  test("buckets read the listing's state: busy runs, idle idles, failed fails, the rest are other", () => {
    expect(["busy", "idle", "failed", "blocked", "done", null].map(bucketOf)).toEqual([
      "running",
      "idle",
      "failed",
      "other",
      "other",
      "other",
    ]);
  });

  test("each session once, in the scope that holds it; out of scope only what no scope read holds", () => {
    const roster = rosterRows(reads);
    expect(roster.inScope.map((row) => [row.short, row.scopeId])).toEqual([
      ["fail1", "broomva"],
      ["blk1", "broomva"],
      ["run1", "broomva"],
      ["out1", "sri"],
      ["idle1", "broomva"],
    ]);
    expect(roster.out.map((row) => row.short)).toEqual(["gone1"]);
  });

  test("filters and counts: attention is a class that wants a look or a session an ask names", () => {
    const roster = rosterRows(reads);
    const asked = askedSessions(reads);
    expect(asked).toEqual(new Set(["idle1-x"]));
    expect(filterRoster(roster, "attention", asked).map((row) => row.short)).toEqual(["fail1", "blk1", "idle1"]);
    expect(rosterCounts(roster, asked)).toEqual({
      attention: 3,
      unmanaged: 1,
      running: 2,
      idle: 1,
      failed: 1,
      all: 5,
      out: 1,
      unplaced: 1,
      blocked: 1,
    });
    // "oldest 26 d ago", in the owner's words; none known: nothing said.
    expect(oldestText(filterRoster(roster, "idle", asked), NOW)).toBe("oldest 26 d ago");
    expect(oldestText([], NOW)).toBeNull();
  });

  test("the fleet would… says the action, and your verdict when you gave one", () => {
    expect(wouldText({ action: "nothing" }, null)).toBe("Nothing");
    expect(wouldText({ action: null }, null)).toBe("Nothing");
    expect(wouldText({ action: "report only" }, null)).toBe("List it in the report");
    const agreed = proposal("a", { verdict: "accept", note: null, at: ago(9 * H), tick: 100 });
    expect(wouldText({ action: "report only" }, agreed, NOW)).toBe("List it in the report · you agreed 9h ago");
    expect(wouldText({ action: "carry the ask forward" }, null)).toBe("Keep asking you");
  });

  test("history says how many ticks listed it and in which classes, never more than it read", () => {
    expect(historyText([])).toBe("Out of scope: the fleet keeps no history for it.");
    expect(historyText([{ tick: 2, classId: null }])).toBe("Not listed in the last 1 tick read.");
    expect(
      historyText([
        { tick: 3, classId: "4" },
        { tick: 2, classId: "4" },
        { tick: 1, classId: null },
      ]),
    ).toBe("Listed at 2 of the last 3 ticks: error on 2.");
    expect(shortPath("~/.paseo/worktrees/0t10n7id/rustic-rat")).toBe("…/0t10n7id/rustic-rat");
    expect(shortPath("~/broomva")).toBe("~/broomva");
  });
});

describe("Needs you", () => {
  const decision = (id: string, extra: Partial<DecisionAsk> = {}): DecisionAsk => ({
    ledger: "l.yaml",
    uid: null,
    id,
    hash: "h",
    arc: null,
    headline: id,
    question: null,
    stakes: null,
    whyYou: null,
    options: [],
    fallback: null,
    blocking: false,
    askedAt: null,
    answeredAt: null,
    answer: null,
    answerOption: null,
    state: "open",
    origin: null,
    refusal: null,
    home: { kind: "root", path: "/r", branch: null },
    batched: false,
    waiting: false,
    ...extra,
  });

  test("a tick that needs you, alerts, asks and the scope's decisions; proposals teach the fleet apart", () => {
    const missed = { ...ok, status: "missed" as const, reason: "No tick for 3h.", needsYou: true };
    const reads: ScopeRead[] = [
      {
        scope: scope("broomva", { health: missed }),
        detail: detail("broomva", {
          alerts: [
            {
              id: "w1",
              title: "lock [fleet-reconcile broomva alert lock]",
              state: "review",
              group: "review",
              needsYou: true,
            },
          ],
          decisions: [
            decision("D1"),
            decision("D2", { state: "answered", answeredAt: ago(10 * 60_000) }),
            decision("D3", { state: "answered", answeredAt: ago(3 * H) }),
          ],
          proposals: [
            proposal("p1"),
            proposal("p2"),
            proposal("p3", { verdict: "accept", note: null, at: ago(10 * 60_000), tick: 108 }),
            proposal("p4", { verdict: "reject", note: "mine", at: ago(5 * H), tick: 100 }),
          ],
        }),
      },
    ];
    const needs = fleetNeedsYou(reads);
    // Proposals are not in Needs you; a decision counts only when it waits on you (`waiting`); D1 does not.
    expect(needs.cards.map((card) => card.kind)).toEqual(["health", "alert"]);
    expect(needs.also.map((card) => card.kind)).toEqual(["decisions"]);
    const decisions = needs.also.find((card) => card.kind === "decisions");
    // Every answered ask stays findable with the open one, however long ago it was answered.
    expect(decisions?.kind === "decisions" ? decisions.asks.map((ask) => ask.id) : null).toEqual(["D1", "D2", "D3"]);
    // An alert is an alert, not an ask.
    expect(needs).toMatchObject({ total: 2, asks: 0, alerts: 1, decisions: 0, ticks: 1 });
    expect(needsText(needs)).toBe("1 tick · 1 alert");
    // p1 and p2 are one group; p3's verdict is under an hour old, so its card stays and says so.
    expect(teachQueue(reads, NOW).map((card) => card.group.proposals.map((entry) => entry.session?.short))).toEqual([
      ["p1", "p2"],
      ["p3"],
    ]);
    expect(reviewedGroups(reads, NOW).map((entry) => entry.group.proposals[0]?.session?.short)).toEqual(["p4"]);
    expect(needsText({ ticks: 0, asks: 0, alerts: 0, decisions: 0 })).toBe("nothing waits on you");
  });
});

describe("the health band", () => {
  test("a cell per tick, oldest first, empty cells before; a wall-clock gap is never painted late", () => {
    // Tick 2 started 2 h after tick 1: sleep may be most of it, and the server judges lateness in awake time.
    const ticks = [
      tick(4, 0.5),
      tick(3, 1.5, "failed", { failedStep: "observe" }),
      tick(2, 3.5),
      tick(1, 5.5, "unknown"),
    ];
    const cells = healthCells(ticks, ok, 6, NOW);
    expect(cells.map((cell) => cell.kind)).toEqual(["empty", "empty", "unknown", "passed", "failed", "passed"]);
    expect(cells[3]?.label).toMatch(/^Tick 2, passed, /);
    expect(cells[4]?.label).toContain("Tick 3, failed at observe");
    expect(cells[0]?.label).toBe("No tick recorded");
  });

  test("a missed scope ends on a missed cell; a running tick is running", () => {
    const missed = { status: "missed" as const, since: ago(3 * H) };
    const cells = healthCells([tick(5, 3, "running")], missed, 3, NOW);
    expect(cells.map((cell) => cell.kind)).toEqual(["empty", "running", "missed"]);
    expect(cells[2]?.label).toBe("No tick: missed for 3h");
    expect(cellAxis(cells, NOW)).toHaveLength(1);
  });

  test("the verdict names the worst scope first, else says healthy with the tally and the dry run", () => {
    const reads: ScopeRead[] = [
      { scope: scope("broomva"), detail: detail("broomva") },
      { scope: scope("sri"), detail: detail("sri") },
    ];
    const cells = new Map(reads.map((read) => [read.scope.id, healthCells(read.detail?.ticks ?? [], ok, 24, NOW)]));
    expect(verdictOf(reads, cells, true)).toEqual({
      tone: "success",
      icon: "Check",
      title: "Fleet healthy",
      sentence: "Both scopes tick on time. 4 of 4 ticks shown passed. Dry run: nothing was acted on.",
    });
    const failing = { ...ok, status: "failing" as const, reason: "Tick 109 failed at observe." };
    const bad: ScopeRead[] = [reads[0] as ScopeRead, { scope: scope("sri", { health: failing }), detail: null }];
    expect(verdictOf(bad, cells, true)).toMatchObject({ tone: "danger", title: "sri is failing" });
    expect(featuredScope(bad)?.scope.id).toBe("sri");
    const off = { ...ok, status: "off" as const };
    expect(verdictOf([{ scope: scope("a", { health: off }), detail: null }], new Map(), false).title).toBe(
      "Fleet paused",
    );
  });

  test("never overclaims: a paused scope, an unreadable one and failed sessions are all named", () => {
    const off = { ...ok, status: "off" as const };
    const reads: ScopeRead[] = [
      { scope: scope("broomva"), detail: detail("broomva") },
      { scope: scope("sri", { health: off }), detail: detail("sri") },
    ];
    const cells = new Map(reads.map((read) => [read.scope.id, healthCells(read.detail?.ticks ?? [], ok, 24, NOW)]));
    // One scope paused while the other ticks: not "Fleet healthy".
    expect(verdictOf(reads, cells, true)).toMatchObject({ tone: "warn", title: "sri paused" });
    // A scope whose read failed is named, with why.
    const unread: ScopeRead[] = [
      { scope: scope("broomva"), detail: detail("broomva") },
      { scope: scope("sri"), detail: null, error: "fleet.get timed out" },
    ];
    expect(verdictOf(unread, cells, true)).toMatchObject({
      tone: "danger",
      title: "Can't read sri",
      sentence: expect.stringContaining("fleet.get timed out"),
    });
    // Ticks pass, sessions do not: the title leads with them.
    const healthy: ScopeRead[] = [{ scope: scope("broomva"), detail: detail("broomva") }];
    expect(verdictOf(healthy, cells, true, { needs: 0, sessions: 3, failed: 2, blocked: 1 })).toMatchObject({
      tone: "warn",
      title: "3 sessions want a look · ticks on time",
      sentence: expect.stringContaining("(2 failed, 1 blocked)"),
    });
  });

  test("the status × sessions × asks grid: success only when nothing at all wants you", () => {
    const one = (health: FleetHealth = ok, extra: Partial<ScopeRead> = {}): ScopeRead[] => [
      { scope: scope("broomva", { health }), detail: detail("broomva"), ...extra },
    ];
    const cells = new Map([["broomva", healthCells([tick(108, 0.5)], ok, 24, NOW)]]);
    const off = { ...ok, status: "off" as const };
    const unscheduled = { ...ok, status: "unscheduled" as const };
    const missed = { ...ok, status: "missed" as const, reason: "No tick for 3h." };
    expect(verdictOf(one(), cells, false).tone).toBe("success");
    // A busy session with an attention class still wants a look (the count comes from the Attention filter).
    expect(verdictOf(one(), cells, false, { needs: 0, sessions: 1 })).toMatchObject({
      tone: "warn",
      title: "1 session wants a look · ticks on time",
    });
    // Anything that needs you (fleetNeedsYou's total) is never "healthy", and it leads.
    expect(verdictOf(one(), cells, false, { needs: 2, needsText: "1 alert · 1 decision", sessions: 3 })).toMatchObject({
      tone: "warn",
      title: "2 need you · 3 sessions want a look · ticks on time",
      sentence: expect.stringContaining("Needs you: 1 alert · 1 decision."),
    });
    // A paused or unscheduled scope never hides hurt sessions, and warn outranks muted.
    expect(verdictOf(one(off), cells, false, { needs: 0, sessions: 3 })).toMatchObject({
      tone: "warn",
      title: "3 sessions want a look · Fleet paused",
    });
    expect(verdictOf(one(unscheduled), cells, false, { needs: 0, sessions: 3 })).toMatchObject({
      tone: "warn",
      title: "3 sessions want a look · Not scheduled",
    });
    // Danger leads.
    expect(verdictOf(one(missed), cells, false, { needs: 0, sessions: 3 }).title).toBe(
      "broomva missed its tick · 3 sessions want a look",
    );
    // A scope still on its first read: never healthy.
    expect(verdictOf(one(ok, { detail: null, reading: true }), cells, false)).toMatchObject({
      tone: "muted",
      title: "Reading broomva…",
    });
    // Stale data with a failed refetch is not "can't read": the verdict stands on the data.
    expect(verdictOf(one(ok, { stale: "timed out" }), cells, false).tone).toBe("success");
  });

  test("the mode badge and the cadence", () => {
    expect(modeBadge([scope("a"), scope("b")])).toBe("Dry run · report only");
    expect(modeBadge([scope("a", { dryRun: false, mode: "act" })])).toBe("Live · act mode");
    expect(modeBadge([scope("a"), scope("b", { dryRun: false })])).toBe("Mixed · report only");
    expect(cadenceText({ scheduled: true, intervalMinutes: 60 }, ago(31 * 60_000), NOW)).toBe(
      "Hourly · next tick in 29 min",
    );
    expect(cadenceText({ scheduled: true, intervalMinutes: 60 }, ago(2 * H), NOW)).toBe("Hourly · tick due");
    expect(cadenceText({ scheduled: false, intervalMinutes: null }, null, NOW)).toBe("By hand only");
    expect(cadenceText(null, null, NOW)).toBeNull();
  });
});

describe("the latest tick", () => {
  test("each step with what the log said, else what the report counts, else its exit", () => {
    const steps = tickSteps(tick(108, 0.5), {
      recover: "0 open intent(s) closed",
      compare: "not run (prototype): compare.jsonl starts with the prototype's line",
      ask: "0 answer(s) read back from Maestro, 0 batch(es) raised, 0 waiting to see if they last, 0 open ask(s)",
    });
    expect(steps.map((step) => [step.name, step.ok, step.skipped, step.detail])).toEqual([
      ["recover", true, false, "nothing to recover"],
      ["observe", true, false, "58 sessions seen"],
      ["report", true, false, "8 in scope · 50 out"],
      ["compare", true, true, "not run (prototype)"],
      ["ask", true, false, "no answers to read, nothing raised"],
    ]);
    const failed = tickSteps(tick(109, 0.1, "failed", { steps: "recover=0 observe=1" }), {});
    expect(failed[1]).toEqual({ name: "observe", rc: 1, ok: false, skipped: false, detail: "exit 1" });
    expect(tickSteps(tick(1, 1, "ok", { steps: null }))).toEqual([]);
    expect(tickLine(tick(108, 0.5), NOW)).toMatch(/^Tick 108 · \d\d:\d\d · took 10 s$/);
  });
});

describe("the owner's words", () => {
  test("cuts at a word, never mid-word", () => {
    expect(cutWords("Ask TypeSafe to delete the requests that carried", 20)).toBe("Ask TypeSafe to…");
    expect(cutWords("stoic-goat-sti-3001-relaunch-plan", 20)).toBe("stoic-goat-sti-3001…");
    expect(cutWords("short", 20)).toBe("short");
  });

  test("a name that repeats itself is said once", () => {
    expect(displayName("sri-sti-2761-next-1633-sti-2761-next-1633-rce")).toBe("sri-sti-2761-next-1633 · rce");
    expect(displayName("sti-2139-asvs-dast-sti-2139-pr774-conflicts-signin")).toBe(
      "sti-2139-asvs-dast · pr774-conflicts-signin",
    );
    expect(displayName("hanging-pug-e7")).toBe("hanging-pug-e7");
  });

  test("an ask is a one-line title and the rest as its body; its tag and age in plain words", () => {
    expect(askLines("Repo GetStimulus/sri: no pull_request rule. Its PRs get no driver.")).toEqual({
      title: "Repo GetStimulus/sri: no pull_request rule",
      body: "Its PRs get no driver.",
    });
    // A first sentence too long for a title: the body goes on from the cut, never repeating it.
    const long = askLines(
      "Session bf1ee1b8 is blocked on you: job file: blocked on a question to its user (allocate disk).",
      50,
    );
    expect(long.title).toBe("Session bf1ee1b8 is blocked on you: job file…");
    expect(long.body).toBe("blocked on a question to its user (allocate disk).");
    expect(askTag({ class: "7", className: "blocked on the owner" })).toBe("Blocked on you");
    expect(askTag({ class: "github", className: null })).toBe("Repo setup");
    expect(askAge({ firstTick: 107 }, [tick(108, 0.5), tick(107, 49)], NOW)).toBe("2 d");
    expect(askAge({ firstTick: 3 }, [tick(108, 0.5)], NOW)).toBeNull();
    expect(ageWords(ago(4 * H), NOW)).toBe("4 h");
  });

  test("an ask not raised yet says when it will be, by the cadence", () => {
    const schedule = { scheduled: true, intervalMinutes: 60 };
    const next = nextTickAt(schedule, ago(31 * 60_000));
    expect(next).toBe(NOW + 29 * 60_000);
    expect(askWhen({ item: null, batch: "12-1" }, next, NOW)).toBe(
      "Not in Maestro yet: raised at the next tick, ~19:29.",
    );
    expect(askWhen({ item: null, batch: null }, null, NOW)).toBe(
      "Not in Maestro yet: raised once it lasts, when a tick runs.",
    );
    expect(nextTickAt({ scheduled: false, intervalMinutes: null }, ago(H))).toBeNull();
  });

  test("the resume command needs a canonical UUID and its folder, and quotes the folder whatever it holds", () => {
    const id = "bf1ee1b8-0000-4000-8000-000000000000";
    expect(resumeCommand(id, "~/broomva/work")).toBe(`cd "$HOME"/'broomva/work' && claude --resume ${id}`);
    expect(resumeCommand(id, "~")).toBe(`cd "$HOME" && claude --resume ${id}`);
    expect(resumeCommand(id, "~/My Work")).toBe(`cd "$HOME"/'My Work' && claude --resume ${id}`);
    // Every shell metacharacter stays inside single quotes; a quote is closed, escaped, reopened.
    for (const cwd of ["/tmp/a;id", "a|id", "a&id", "a>pwned", "/tmp/*", "$(x)", "`id`", "a\nid", "it's"]) {
      const command = resumeCommand(id, cwd) ?? "";
      expect(command).toBe(`cd ${shellQuote(cwd)} && claude --resume ${id}`);
      expect(command.startsWith("cd '")).toBe(true);
    }
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    // `~user` is not a leading `~/`: quoted as written, never expanded.
    expect(resumeCommand(id, "~root/x")).toBe(`cd '~root/x' && claude --resume ${id}`);
    // Only a canonical UUID.
    for (const bad of [
      "records-without-process",
      "bf1ee1b8-0000",
      "bf1ee1b8-0000-4000-8000-00000000000z",
      `${id};id`,
      ` ${id}`,
    ]) {
      expect(resumeCommand(bad, "~/x")).toBeNull();
    }
    expect(resumeCommand(id, null)).toBeNull();
  });

  test("a proposal reads as what it does: list it in the report, nothing done", () => {
    const group = (count: number, action = "report only"): ProposalGroup => ({
      key: "g",
      action,
      classId: "10",
      className: "unmanaged",
      source: "report",
      proposals: Array.from({ length: count }, (_, at) => proposal(`p${at}`)).map((entry) => ({ ...entry, action })),
      review: null,
    });
    expect(proposalTitle(group(4))).toBe("Would list 4 unmanaged sessions in its report — nothing is done");
    expect(proposalTitle(group(1))).toBe("Would list s-p0 in its report — nothing is done");
    expect(proposalTitle(group(2, "report; no spawns in the scope until the reset"))).toBe(
      "Would list 2 unmanaged sessions; no new sessions until the usage limit resets",
    );
    expect(proposalTitle(group(2, "resume once"))).toBe("Would resume once 2 unmanaged sessions");
  });

  test("what a verdict does depends on the dry run", () => {
    expect(verdictNote(true)).toContain("changes nothing now");
    expect(verdictNote(false)).not.toContain("runs dry");
    expect(verdictNote(false)).not.toContain("phase");
  });

  test("plain step words: the fleet's (s) plurals and zero counts", () => {
    expect(plainStep("recover", "2 open intent(s) closed")).toBe("2 open intents closed");
    expect(plainStep("ask", "1 answer(s) read back from Maestro, 2 batch(es) raised, 0 waiting, 3 open ask(s)")).toBe(
      "1 answer read, 2 asks raised, 3 open",
    );
    expect(plainStep("other", "0 file(s) moved")).toBe("no files moved");
  });
});

describe("attention by agent id", () => {
  test("an ask keyed by a session's Paseo agent id marks that session", () => {
    const reads: ScopeRead[] = [
      {
        scope: scope("broomva"),
        detail: detail("broomva", {
          asks: [
            {
              id: "a1",
              key: "prompt:405d8a5d-9528:abc",
              question: "?",
              class: "3",
              className: null,
              firstTick: 2,
              // The key names the agent; the session it resolved to is the agent id itself.
              session: { id: "405d8a5d-9528", short: "405d8a5d", name: null, agentId: "405d8a5d-9528" },
              batch: null,
              item: null,
            },
          ],
        }),
      },
    ];
    const asked = askedSessions(reads);
    const row = session("pug", "5", "busy", { agentId: "405d8a5d-9528" });
    expect(wantsAttention(row, asked)).toBe(true);
    expect(wantsAttention(session("other", "5", "busy"), asked)).toBe(false);
  });

  test("history kinds tell unmanaged from not listed", () => {
    expect(historyKind("10")).toBe("unmanaged");
    expect(historyKind(null)).toBe("unlisted");
    expect(historyKind("5")).toBe("running");
    expect(historyKind("4")).toBe("error");
  });
});

describe("adopting", () => {
  test("the title falls back to the short id, then the id; never empty", () => {
    expect(adoptTitle({ name: "broomva-89", short: "2cf6eca3", id: "2cf6eca3-x" })).toBe("broomva-89");
    expect(adoptTitle({ name: null, short: "2cf6eca3", id: "2cf6eca3-x" })).toBe("2cf6eca3");
    expect(adoptTitle({ name: "  ", short: "", id: "2cf6eca3-x" })).toBe("2cf6eca3-x");
  });

  test("only a Paseo agent in a scope shown can be adopted", () => {
    expect(canAdopt({ agentId: "a", inScope: true })).toBe(true);
    expect(canAdopt({ agentId: null, inScope: true })).toBe(false);
    expect(canAdopt({ agentId: "a", inScope: false })).toBe(false);
  });
});

describe("round 2", () => {
  test("an ask's short id links its roster row by a unique prefix, by session or agent id", () => {
    const rows = [
      {
        ...session("d4b991f0", "7", "blocked", { id: "d4b991f0-1133-4c26-9a7e-000000000001", cwd: "~/sri" }),
        scopeId: "sri",
      },
      { ...session("aaaa1111", "10", "idle", { id: "aaaa1111-0000-4000-8000-000000000002" }), scopeId: "sri" },
      { ...session("aaaa1111b", "10", "idle", { id: "aaaa1111-0000-4000-8000-000000000003" }), scopeId: "sri" },
      { ...session("pug", "5", "busy", { agentId: "405d8a5d-9528-43ab-bcd6-f996e7f230e4" }), scopeId: "broomva" },
    ];
    const ask = (id: string) => ({ session: { id, short: id.slice(0, 8), name: null, agentId: null } });
    expect(linkSession(ask("d4b991f0-1133"), rows)?.cwd).toBe("~/sri");
    expect(linkSession(ask("405d8a5d-9528"), rows)?.short).toBe("pug");
    // Two candidates: neither.
    expect(linkSession(ask("aaaa1111-0000"), rows)).toBeNull();
    expect(linkSession({ session: null }, rows)).toBeNull();
    // Linked by prefix, the session wants a look through the ask.
    const reads: ScopeRead[] = [
      {
        scope: scope("sri"),
        detail: detail("sri", {
          roster: {
            tick: 12,
            at: null,
            sessions: [{ ...session("x", "10", "idle", { id: "d4b991f0-1133-4c26-9a7e-000000000001" }) }],
          },
          asks: [
            {
              id: "a1",
              key: "prompt:d4b991f0-1133:abc",
              question: "?",
              class: "count",
              className: null,
              firstTick: 2,
              session: { id: "d4b991f0-1133", short: "d4b991f0", name: null, agentId: null },
              batch: null,
              item: null,
            },
          ],
        }),
      },
    ];
    expect(askedSessions(reads).has("d4b991f0-1133-4c26-9a7e-000000000001")).toBe(true);
  });

  test("a busy session with an attention class wants a look", () => {
    expect(wantsAttention(session("busy", "7", "busy"), new Set())).toBe(true);
    expect(wantsAttention(session("busy", "5", "busy"), new Set())).toBe(false);
  });

  test("a scope whose decisions are all answered keeps them findable, at the end, uncounted", () => {
    const answered = {
      ledger: "l.yaml",
      uid: null,
      id: "D9",
      hash: "h",
      arc: null,
      headline: "Done",
      question: null,
      stakes: null,
      whyYou: null,
      options: [],
      fallback: null,
      blocking: false,
      askedAt: null,
      answeredAt: ago(9 * 24 * H),
      answer: "yes",
      answerOption: null,
      state: "answered" as const,
      origin: null,
      refusal: null,
      home: { kind: "root" as const, path: "/r", branch: null },
      batched: false,
      waiting: false,
    };
    const reads: ScopeRead[] = [
      {
        scope: scope("sri", { health: { ...ok, status: "missed", needsYou: true } }),
        detail: detail("sri", { decisions: [answered] }),
      },
    ];
    const needs = fleetNeedsYou(reads);
    expect(needs.cards.map((card) => card.kind)).toEqual(["health"]);
    expect(needs.also.map((card) => card.kind)).toEqual(["decisions"]);
    expect(needs.total).toBe(1);
  });

  test("plain words for the fleet's jargon; paths keep their last folder", () => {
    expect(plainEvidence("no fleet key, not adopted (Paseo agent)")).toBe("not managed by the fleet (a Paseo agent)");
    expect(plainEvidence("no fleet key, not adopted")).toBe("not managed by the fleet");
    expect(plainAction("report; no spawns in the scope until the reset")).toBe(
      "List it; no new sessions until the usage limit resets",
    );
    expect(plainAction("carry the ask forward")).toBe("Keep asking you");
    expect(middlePath("~/broomva/work/stimulus/sri-sti-2761-next-1633", 30)).toBe("~/…/sri-sti-2761-next-1633");
    expect(middlePath("~/broomva", 30)).toBe("~/broomva");
    expect(cutWords("feat/prompt-cache-and-preflight-caching", 20)).toBe("feat/prompt-cache…");
  });

  test("an ask's body starts at the next sentence and never repeats the title", () => {
    expect(askLines("First one is short. Second one follows. Third.")).toEqual({
      title: "First one is short",
      body: "Second one follows. Third.",
    });
    expect(askLines("Only one sentence here")).toEqual({ title: "Only one sentence here", body: null });
  });
});

describe("one number for what needs you", () => {
  test("the selector's total is its cards, the band's count, and the header's fleet share", () => {
    const waiting = (id: string, extra: Partial<DecisionAsk> = {}): DecisionAsk => ({
      ledger: "sri-coordinator.yaml",
      uid: null,
      id,
      hash: "h",
      arc: null,
      headline: id,
      question: null,
      stakes: null,
      whyYou: null,
      options: [],
      fallback: null,
      blocking: true,
      askedAt: null,
      answeredAt: null,
      answer: null,
      answerOption: null,
      state: "open",
      origin: null,
      refusal: null,
      home: { kind: "root", path: "/state/sri/.control/asks", branch: null },
      batched: false,
      waiting: true,
      ...extra,
    });
    const item = (id: string, needsYou: boolean) => ({
      id,
      title: `${id} [fleet-reconcile sri batch 12-1]`,
      state: needsYou ? ("review" as const) : ("running" as const),
      group: needsYou ? ("review" as const) : ("running" as const),
      needsYou,
    });
    const fleetAsk = (id: string, work: ReturnType<typeof item> | null) => ({
      id,
      key: `count:${id}`,
      question: `Question ${id}?`,
      class: "count",
      className: null,
      firstTick: 2,
      session: null,
      batch: work ? "12-1" : null,
      item: work,
    });
    const raised = item("w-ask", true);
    const missed = { ...ok, status: "missed" as const, reason: "No tick for 3h.", needsYou: true };
    const reads: ScopeRead[] = [
      {
        scope: scope("sri", { health: missed }),
        detail: detail("sri", {
          alerts: [item("w-alert", true), item("w-quiet", false)],
          // Two asks in one raised batch are one item, one count; an ask not raised yet is not the header's.
          asks: [fleetAsk("a1", raised), fleetAsk("a2", raised), fleetAsk("a3", null)],
          // Only `waiting` counts: blocking, or recommending what cannot be undone.
          decisions: [
            waiting("D1"),
            waiting("D2", { blocking: false, waiting: false }),
            waiting("D3", { state: "answered", waiting: false }),
          ],
        }),
      },
      { scope: scope("broomva"), detail: detail("broomva") },
    ];
    const needs = fleetNeedsYou(reads);
    // What the header counts for the fleet, built the way the server builds work.attention.
    const fleetWork = [item("w-alert", true), item("w-quiet", false), raised].map(({ id, group }) => ({
      id,
      group,
      flag: null,
    }));
    const notices = reads.filter((read) => read.scope.health.needsYou).map((read) => ({ scope: read.scope.id }));
    const asks = reads.flatMap((read) =>
      (read.detail?.decisions ?? []).filter((ask) => ask.waiting).map((ask) => askNotice(ask, read.scope.id)),
    );
    const header = needsYouCount(fleetWork, notices, [], asks);
    expect(needs).toMatchObject({ ticks: 1, alerts: 1, asks: 1, decisions: 1, total: 4 });
    expect(needs.cards).toHaveLength(needs.total);
    expect(header).toBe(needs.total);
    const cells = new Map(
      reads.map((read) => [read.scope.id, healthCells(read.detail?.ticks ?? [], read.scope.health, 24, NOW)]),
    );
    const band = verdictOf(reads, cells, true, {
      needs: needs.total,
      needsText: needsText(needs),
      sessions: needs.sessions,
    });
    expect(band.title).toContain(`${needs.total} need you`);
    // Uncounted, still shown: the quiet alert, the ask not raised yet, the decisions that do not wait.
    expect(needs.also.map((card) => card.kind)).toEqual(["alert", "ask", "decisions"]);
  });
});

describe("round 3 words", () => {
  test("a blocked-session preamble becomes '<session> is waiting on you' with the request as the body", () => {
    expect(
      askLines(
        "Session sti-2139-asvs-dast-conflicts (bf1ee1b8) is blocked on you: job file: blocked on a question to its user (allocate disk space to run `bun test`).",
      ),
    ).toEqual({
      title: "sti-2139-asvs-dast-conflicts is waiting on you",
      body: "Allocate disk space to run `bun test`",
    });
  });

  test("a long first sentence is cut at a clause that keeps the request, the body going on from it", () => {
    expect(
      askLines(
        "Repo GetStimulus/sri: no pull_request rule; no required status checks; force-push to the default branch not blocked. Its PRs get no driver.",
      ),
    ).toEqual({
      title: "Repo GetStimulus/sri: no pull_request rule; no required status checks…",
      // The body goes on as a sentence of its own: never an ellipsis fragment.
      body: "force-push to the default branch not blocked. Its PRs get no driver.",
    });
  });

  test("a long first sentence is cut at a clause, never rewritten: the body is the rest as written", () => {
    expect(
      askLines(
        "The core comparison (ctx doctor --compare) is not run in scope sri: compare.jsonl starts with the pre-spec prototype's line; move it aside, then register. The owner's step is in ctx-core SKILL.md.",
      ),
    ).toEqual({
      title: "The core comparison (ctx doctor --compare) is not run in scope sri…",
      body: "compare.jsonl starts with the pre-spec prototype's line; move it aside, then register. The owner's step is in ctx-core SKILL.md.",
    });
  });

  test("a cut name never ends on a dangling separator", () => {
    expect(cutWords("sti-2642-seat-vocabulary · seat-vocab-index-fresh", 30)).toBe("sti-2642-seat-vocabulary…");
  });

  test("a running session with no activity recorded is active now; any other says nothing", () => {
    expect(activeWords(null, true)).toBe("active now");
    expect(activeWords(null, false)).toBeNull();
    expect(activeWords(ago(2 * H), false, NOW)).toMatch(/ · 2h ago$/);
  });

  test("the report's evidence and placement in words", () => {
    expect(evidenceSentence("listing: state failed ((idle — send a prompt to start))")).toBe(
      "Its session listing says it failed.",
    );
    expect(evidenceSentence("job file: blocked on a question to its user")).toBe(
      "Its job file says: blocked on a question to its user.",
    );
    expect(evidenceSentence("no fleet key, not adopted (Paseo agent)")).toBe(
      "The fleet does not manage it; it is a Paseo agent.",
    );
    expect(evidenceSentence(null)).toBe("The report gives no evidence for it.");
    expect(placedWords("cwd")).toBe("by its folder");
    expect(placedWords("worktree-parent")).toBe("by its worktree's parent");
  });
});

describe("the header's count, split", () => {
  test("the fleet's share and each other surface's, from the header's own pieces, add up to its total", () => {
    const attention = {
      waiting: [
        { id: "w-ask", group: "review" as const, flag: null },
        { id: "w-alert", group: "review" as const, flag: null },
        { id: "mine", group: "review" as const, flag: null },
        { id: "stuck", group: "blocked" as const, flag: null },
      ],
      fleet: [{ scope: "sri", status: "missed" as const, reason: "", since: null }],
      timeline: [{ id: "launchd:x", name: "x", status: "failed" as const, reason: "", since: null }],
      asks: [
        { scope: "sri", ledger: "a.yaml", uid: null, id: "D1", headline: "D1", blocking: true, askedAt: null },
        { scope: null, ledger: "b.yaml", uid: null, id: "W1", headline: "W1", blocking: true, askedAt: null },
      ],
      initiatives: [],
    };
    const shares = headerShares(
      attention as unknown as Parameters<typeof headerShares>[0],
      new Set(["w-ask", "w-alert"]),
    );
    expect(shares).toEqual({ total: 8, fleet: 4, work: 2, decisions: 1, timeline: 1, initiatives: 0 });
    expect(shares.fleet + shares.work + shares.decisions + shares.timeline + shares.initiatives).toBe(shares.total);
  });
});
