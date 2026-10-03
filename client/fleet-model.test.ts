import { describe, expect, test } from "bun:test";
import { type FleetAsk, type FleetProposal, type FleetScope, type FleetTick, groupProposals } from "../shared/fleet";
import {
  askWhere,
  classText,
  groupReviewText,
  groupSubject,
  keysFor,
  lastTickText,
  modeText,
  noticeText,
  proposalClass,
  proposalSubject,
  proposalsHeading,
  reviewText,
  scopeChipLabel,
  tickLabel,
  tickWhen,
} from "./fleet-model";

const NOW = new Date(2026, 9, 2, 15, 40).getTime();
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function proposal(key: string, extra: Partial<FleetProposal> = {}): FleetProposal {
  return {
    key,
    source: "report",
    tick: 35,
    at: minutesAgo(5),
    action: "report",
    session: {
      id: `${key}-id`,
      short: key,
      name: "worried-walrus",
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
    review: null,
    ...extra,
  };
}

const scope = (extra: Partial<FleetScope> = {}): FleetScope => ({
  id: "broomva",
  mode: "report",
  dryRun: true,
  health: { status: "ok", reason: "", notice: "", since: null, item: null, needsYou: false },
  lastTick: { tick: 35, at: minutesAgo(12), status: "ok" },
  unreviewed: 0,
  openAsks: 0,
  ...extra,
});

describe("the Fleet view's words", () => {
  test("a scope's mode and its dry run, as its config says", () => {
    expect(modeText({ mode: "report", dryRun: true })).toBe("report mode, dry run");
    expect(modeText({ mode: "act", dryRun: false })).toBe("act mode, live");
    expect(modeText({ mode: null, dryRun: null })).toBe("mode unknown");
  });

  test("class counts read in a line; a tick with no report says so", () => {
    expect(
      classText([
        { id: "1", name: "out of scope", count: 53 },
        { id: "4", name: "error", count: 1 },
      ]),
    ).toBe("53 out of scope · 1 error");
    expect(classText(null)).toBe("No report");
    expect(classText([])).toBe("No sessions");
  });

  test("a tick's time is the clock today, with its day before that", () => {
    expect(tickWhen(new Date(2026, 9, 2, 9, 5).toISOString(), NOW)).toBe("09:05");
    expect(tickWhen(new Date(2026, 9, 1, 23, 5).toISOString(), NOW)).toBe("Yesterday 23:05");
    expect(tickWhen(new Date(2026, 8, 29, 7, 0).toISOString(), NOW)).toBe("Tue 07:00");
    expect(tickWhen(null, NOW)).toBe("time unknown");
  });

  test("a tick's label says its status, its failed step and how long ago", () => {
    const tick = { tick: 36, at: minutesAgo(12), status: "failed", failedStep: "observe" } as FleetTick;
    expect(tickLabel(tick, NOW)).toBe("Tick 36, failed at observe, 12m ago");
    expect(tickLabel({ ...tick, status: "died", failedStep: null }, NOW)).toBe("Tick 36, never finished, 12m ago");
    expect(tickLabel({ ...tick, status: "ok", failedStep: null, at: minutesAgo(0) }, NOW)).toBe(
      "Tick 36, passed, just now",
    );
  });

  test("proposals that read the same and stand the same with you are one group; waiting ones first", () => {
    const at = (minutes: number) => ({ verdict: "accept" as const, note: null, at: minutesAgo(minutes), tick: 35 });
    const groups = groupProposals([
      proposal("a", { review: at(9) }),
      proposal("b", { classId: "4", className: "error", action: "report" }),
      proposal("c", { review: at(2) }),
      proposal("d"),
      proposal("e"),
    ]);
    expect(
      groups.map((group) => [group.action, group.review?.verdict ?? null, group.proposals.map((p) => p.key)]),
    ).toEqual([
      ["report", null, ["d", "e"]],
      ["report", "accept", ["a", "c"]],
      ["report", null, ["b"]],
    ]);
    const [waiting, accepted, error] = groups;
    if (!waiting || !accepted || !error) throw new Error("three groups");
    expect(groupReviewText(waiting, NOW)).toBe("Not reviewed");
    // One verdict for the group, the newest time.
    expect(groupReviewText(accepted, NOW)).toBe("You accepted this 2m ago");
    expect(groupSubject(waiting)).toBe("2 sessions");
    expect(groupSubject(error)).toBe("b worried-walrus");
    expect(proposalsHeading(groups)).toBe("3 · 2 to review");
    expect(proposalsHeading([accepted])).toBe("1 · all reviewed");
    // A verdict writes the group's keys, unless it already has that verdict: then none, and no lines.
    expect(keysFor(waiting, "accept")).toEqual(["d", "e"]);
    expect(keysFor(accepted, "accept")).toEqual([]);
    expect(keysFor(accepted, "reject")).toEqual(["a", "c"]);
  });

  test("a notice says the scope, what is wrong, for how long, and the fleet's still words", () => {
    const reason = "No tick since tick 35. It runs every hour.";
    expect(noticeText({ scope: "broomva", status: "missed", reason, since: minutesAgo(190) }, NOW)).toBe(
      "Fleet broomva: missed tick for 3h. No tick since tick 35. It runs every hour.",
    );
    expect(
      noticeText({ scope: "alpha", status: "blind", reason: "Missed ticks cannot be judged.", since: null }, NOW),
    ).toBe("Fleet alpha: missed ticks unjudged. Missed ticks cannot be judged.");
    expect(noticeText({ scope: "sri", status: "failing", reason: "Tick 6 failed at observe.", since: null }, NOW)).toBe(
      "Fleet sri: failing tick. Tick 6 failed at observe.",
    );
  });

  test("your verdict reads with when, and the note when there is one", () => {
    expect(reviewText(null, NOW)).toBe("Not reviewed");
    expect(reviewText({ verdict: "accept", note: null, at: minutesAgo(3), tick: 35 }, NOW)).toBe(
      "You accepted this 3m ago",
    );
    expect(reviewText({ verdict: "reject", note: "Mine", at: minutesAgo(0), tick: 35 }, NOW)).toBe(
      "You rejected this just now: Mine",
    );
  });

  test("a proposal names its session and class, or the coordinator's verb", () => {
    expect(proposalSubject(proposal("5dd4ed18"))).toBe("5dd4ed18 worried-walrus");
    expect(proposalClass(proposal("x"))).toBe("Class 10, unmanaged");
    const act = proposal("act:spawn:k", { session: null, classId: null, className: null, verb: "spawn" });
    expect(proposalSubject(act)).toBe("Coordinator spawn");
    expect(proposalClass(act)).toBeNull();
  });

  test("an ask says where it is in Maestro, or why it is not there yet", () => {
    const ask: FleetAsk = {
      id: "a1",
      key: "k",
      question: "q",
      class: "count",
      className: null,
      firstTick: 2,
      session: null,
      batch: "2-1",
      item: null,
    };
    expect(askWhere(ask)).toBe("Its batch has no Maestro work yet: the fleet raises it at a later tick.");
    expect(askWhere({ ...ask, batch: null })).toBe("Not raised yet: the fleet raises an ask once it lasts.");
    const item = { id: "w", title: "t", state: "review" as const, group: "review" as const, needsYou: true };
    expect(askWhere({ ...ask, item })).toBe("In Needs you");
    expect(askWhere({ ...ask, item: { ...item, state: "done", group: "done", needsYou: false } })).toBe(
      "In Maestro, Done",
    );
  });

  test("a scope chip says its health and what waits on you, to a screen reader too", () => {
    expect(scopeChipLabel(scope())).toBe("broomva, On time");
    expect(
      scopeChipLabel(
        scope({
          unreviewed: 4,
          openAsks: 1,
          health: { status: "missed", reason: "", notice: "", since: null, item: null, needsYou: true },
        }),
      ),
    ).toBe("broomva, Missed, 4 proposals to review, 1 open ask");
    expect(lastTickText(scope(), NOW)).toBe("Tick 35, 12m ago");
    expect(lastTickText(scope({ lastTick: null }), NOW)).toBe("No tick yet");
  });
});
