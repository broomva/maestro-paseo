import { describe, expect, test } from "bun:test";
import type { WorkItem } from "../shared/contracts";
import { needsYouOf } from "../shared/needs-you";
import { GROUP_ORDER, groupOf, type OrchState, QUEUED_LOOP_HINT } from "../shared/states";
import {
  applyFilter,
  boardColumns,
  cardLabel,
  changedVisible,
  changeLabel,
  changeText,
  countFilters,
  crumb,
  emptyText,
  FILTERS,
  filterLabel,
  flagText,
  groupedViews,
  groupHint,
  groupsOf,
  inFilter,
  initiatives,
  inScope,
  needsHand,
  resolveScope,
  SYSTEM_VIEWS,
  scopeLabel,
  stateText,
  stuckText,
  summaryText,
  viewFor,
  viewsFor,
  visibleFilters,
  workerText,
} from "./plane-model";

function work(id: string, state: OrchState, extra: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    path: `/work/${id}`,
    title: `Work ${id}`,
    kind: "task",
    state,
    group: groupOf(state),
    gate: "human",
    owner: null,
    initiative: null,
    project: null,
    repo: null,
    createdAt: "2026-09-29T10:00:00Z",
    updatedAt: "2026-09-29T11:00:00Z",
    lastEventAt: null,
    phase: null,
    worker: null,
    reason: null,
    verdict: null,
    look: null,
    // Work at the gate holds a prompt unless a test says it finished (`permission: null`): only a held action needs you (A1).
    permission: state === "review" ? { requestId: `req-${id}`, title: "Run a command", detail: "git push" } : null,
    checks: [],
    pending: null,
    flag: null,
    ...extra,
  };
}

const yoursFlag = {
  kind: "yours" as const,
  reason: "Start it yourself: it runs without permission prompts.",
  at: "2026-09-29T11:05:00Z",
};
const quietFlag = { kind: "quiet" as const, reason: "Quiet for 40 minutes, worth a look.", at: "2026-09-29T11:00:00Z" };

const plane = [
  work("a", "review", { initiative: "hawthorne", project: "core" }),
  work("b", "blocked", { initiative: "hawthorne", project: "db", reason: "Needs a Linear scope" }),
  work("c", "running", { initiative: "genesis" }),
  work("d", "proposed", { initiative: "hawthorne" }),
  work("e", "triggered"),
  work("f", "done", { initiative: "genesis" }),
  work("g", "canceled", { initiative: "hawthorne" }),
];

describe("views", () => {
  test("compact shows the feed, or History when it is chosen", () => {
    expect(viewFor("board", true)).toBe("feed");
    expect(viewFor("list", true)).toBe("feed");
    expect(viewFor("history", true)).toBe("history");
    expect(viewFor("board", false)).toBe("board");
    expect(viewFor("list", false)).toBe("list");
    expect(viewFor("history", false)).toBe("history");
  });

  test("compact offers the feed, History and every system view; wide offers all nine, in two groups", () => {
    expect(viewFor("fleet", true)).toBe("fleet");
    expect(viewFor("decisions", true)).toBe("decisions");
    expect(viewFor("timeline", true)).toBe("timeline");
    expect(viewFor("initiatives", true)).toBe("initiatives");
    expect(viewFor("loops", true)).toBe("loops");
    expect(viewsFor(true).map((view) => view.label)).toEqual([
      "Feed",
      "History",
      "Fleet",
      "Decisions",
      "Timeline",
      "Initiatives",
      "Loops",
    ]);
    expect(groupedViews(viewsFor(false)).map((group) => [group.label, group.views.map((view) => view.label)])).toEqual([
      ["Work", ["Feed", "Board", "List", "History"]],
      ["System", ["Fleet", "Decisions", "Timeline", "Initiatives", "Loops"]],
    ]);
    expect(SYSTEM_VIEWS).toEqual(["fleet", "decisions", "timeline", "initiatives", "loops"]);
  });
});

describe("filters", () => {
  test("counts every group and the total; stuck work is Stuck's, not Needs you's (A1)", () => {
    expect(countFilters(plane)).toEqual({ all: 7, review: 1, blocked: 1, running: 1, queued: 2, done: 2 });
  });

  test("a state chip keeps its section; Needs you keeps what needs you; Stuck keeps stuck work; All keeps everything", () => {
    expect(applyFilter(plane, "queued").map((item) => item.id)).toEqual(["d", "e"]);
    expect(applyFilter(plane, "review").map((item) => item.id)).toEqual(["a"]);
    expect(applyFilter(plane, "blocked").map((item) => item.id)).toEqual(["b"]);
    expect(applyFilter(plane, "all")).toHaveLength(7);
  });

  test("the Needs you chip lists work only you may start; a quiet run stays Running, stuck work Stuck", () => {
    const flagged = [...plane, work("y", "proposed", { flag: yoursFlag }), work("z", "running", { flag: quietFlag })];
    expect(countFilters(flagged)).toEqual({ all: 9, review: 2, blocked: 1, running: 2, queued: 2, done: 2 });
    expect(applyFilter(flagged, "review").map((item) => item.id)).toEqual(["a", "y"]);
    expect(applyFilter(flagged, "queued").map((item) => item.id)).toEqual(["d", "e"]);
    expect(applyFilter(flagged, "running").map((item) => item.id)).toEqual(["c", "z"]);
    expect(applyFilter(flagged, "blocked").map((item) => item.id)).toEqual(["b"]);
  });

  describe("a chip's count is exactly what its filter shows, and the chips follow the sections", () => {
    const mixes: [string, WorkItem[]][] = [
      ["the plane", plane],
      [
        "stuck and flagged work beside plain work of every state",
        [
          ...plane,
          work("y", "proposed", { flag: yoursFlag }),
          work("t", "triggered", { flag: { ...yoursFlag, kind: "failed", reason: "Could not start: x." } }),
          work("z", "running", { flag: quietFlag }),
          work("s2", "blocked", { reason: "Gone" }),
          work("q2", "proposed"),
        ],
      ],
      ["only flagged and stuck work", [work("y", "proposed", { flag: yoursFlag }), work("s", "blocked")]],
      ["nothing", []],
    ];
    const SECTION_CHIPS = ["review", "blocked", "running", "queued", "done"] as const;
    for (const [name, items] of mixes) {
      test(name, () => {
        const counts = countFilters(items);
        const sections = new Map(groupsOf(items).map((entry) => [entry.group, entry.items.length]));
        // Needs you, Stuck, Running, Queued and Done: the count is that section's length in the All view.
        for (const chip of SECTION_CHIPS) expect([chip, counts[chip]]).toEqual([chip, sections.get(chip) ?? 0]);
        // Every chip, All included: the count is what the filter shows.
        for (const chip of FILTERS) expect([chip, counts[chip]]).toEqual([chip, applyFilter(items, chip).length]);
        // Stuck work is never under Needs you (A1: watched); the five section chips add up to All.
        expect(applyFilter(items, "blocked").some((item) => inFilter(item, "review"))).toBe(false);
        expect(SECTION_CHIPS.reduce((sum, chip) => sum + counts[chip], 0)).toBe(counts.all);
        expect(counts.all).toBe(items.length);
      });
    }
  });

  test("empty chips hide unless selected; All always shows", () => {
    const counts = countFilters([work("x", "running")]);
    expect(visibleFilters(counts, "all")).toEqual(["all", "running"]);
    expect(visibleFilters(counts, "review")).toEqual(["all", "review", "running"]);
    expect(visibleFilters(countFilters([]), "all")).toEqual(["all"]);
  });

  test("chips read in the plain voice, attention first", () => {
    expect(FILTERS.map(filterLabel)).toEqual(["All", "Needs you", "Stuck", "Running", "Queued", "Done"]);
  });

  test("an empty filter says so in plain words", () => {
    expect(FILTERS.map(emptyText)).toEqual([
      "No work here yet.",
      "Nothing needs you right now.",
      "Nothing is stuck.",
      "Nothing is running.",
      "Nothing is queued.",
      "Nothing is done yet.",
    ]);
  });
});

describe("initiative scope", () => {
  test("open over total, with a badge that is needs.list's count for the initiative, never a count of its work", () => {
    expect(initiatives(plane)).toEqual([
      { name: "genesis", open: 1, total: 2, needsYou: 0 },
      { name: "hawthorne", open: 3, total: 4, needsYou: 0 },
    ]);
    // hawthorne's holds as needs.list has them (its work at your gate, an ask that names it, its review): 3,
    // though only one of its work items is at your gate.
    expect(initiatives(plane, new Map([["hawthorne", 3]]))).toEqual([
      { name: "genesis", open: 1, total: 2, needsYou: 0 },
      { name: "hawthorne", open: 3, total: 4, needsYou: 3 },
    ]);
  });

  test("what needs a hand is work only you may start; a quiet run and stuck work are watched, not waiting (A1)", () => {
    expect(needsHand(work("y", "proposed", { flag: yoursFlag }))).toBe(true);
    expect(needsHand(work("t", "triggered", { flag: { ...yoursFlag, kind: "failed" } }))).toBe(true);
    expect(needsHand(work("z", "running", { flag: quietFlag }))).toBe(false);
    expect(needsHand(work("s", "blocked"))).toBe(false);
    expect(needsHand(work("c", "running"))).toBe(false);
  });

  test("work without an initiative is in no scope chip", () => {
    expect(initiatives([work("e", "running")])).toEqual([]);
  });

  test("a scope narrows every view; null is all work", () => {
    expect(inScope(plane, "genesis").map((item) => item.id)).toEqual(["c", "f"]);
    expect(inScope(plane, null)).toHaveLength(7);
  });

  test("a scope that left the list falls back to all work", () => {
    expect(resolveScope(plane, "hawthorne")).toBe("hawthorne");
    expect(resolveScope(plane, "gone")).toBeNull();
    expect(resolveScope(plane, null)).toBeNull();
  });

  test("the chip's spoken label carries the counts", () => {
    expect(scopeLabel({ name: "hawthorne", open: 3, total: 4, needsYou: 2 })).toBe(
      "hawthorne, 3 of 4 open, 2 waiting on you",
    );
    expect(scopeLabel({ name: "genesis", open: 1, total: 2, needsYou: 0 })).toBe("genesis, 1 of 2 open");
  });
});

describe("feed and board", () => {
  test("feed sections are non-empty and attention first; stuck work is its own section", () => {
    expect(groupsOf(plane).map((entry) => [entry.group, entry.items.map((item) => item.id)])).toEqual([
      ["review", ["a"]],
      ["blocked", ["b"]],
      ["running", ["c"]],
      ["queued", ["d", "e"]],
      ["done", ["f", "g"]],
    ]);
    expect(groupsOf([work("x", "done"), work("y", "running")]).map((entry) => entry.group)).toEqual([
      "running",
      "done",
    ]);
  });

  test("work only you may start is listed in Needs you after review, and not again in Queued", () => {
    const sections = groupsOf([
      work("quiet", "running", { flag: quietFlag }),
      work("s", "blocked"),
      work("yours", "proposed", { flag: yoursFlag }),
      work("r", "review"),
      work("q", "proposed"),
      work("c", "running"),
    ]);
    expect(sections.map((entry) => [entry.group, entry.items.map((item) => item.id)])).toEqual([
      ["review", ["r", "yours"]],
      ["blocked", ["s"]],
      ["running", ["quiet", "c"]],
      ["queued", ["q"]],
    ]);
  });

  test("one definition: the feed's Needs you, the board's column, the chip and needs.list's work hold the same work", () => {
    const flagged = [...plane, work("y", "proposed", { flag: yoursFlag }), work("z", "running", { flag: quietFlag })];
    const feed = groupsOf(flagged)
      .find((entry) => entry.group === "review")
      ?.items.map((item) => item.id);
    const column = boardColumns(flagged)
      .find((entry) => entry.id === "needs-you")
      ?.items.map((item) => item.id);
    expect(feed).toEqual(["a", "y"]);
    expect(column).toEqual(feed);
    expect(applyFilter(flagged, "review").map((item) => item.id)).toEqual(feed ?? []);
    expect(countFilters(flagged).review).toBe(feed?.length ?? -1);
    expect(needsYouOf(flagged).map((item) => item.id)).toEqual(feed ?? []);
    expect(summaryText(flagged)).toBe("2 work items need you · 2 running");
  });

  test("five columns, always present; stuck work has its own, Needs you holds review then what only you may start", () => {
    const shuffled = [
      work("s", "blocked"),
      work("y", "proposed", { flag: yoursFlag }),
      work("r", "review"),
      work("q", "proposed"),
    ];
    const columns = boardColumns(shuffled);
    expect(columns.map((column) => column.title)).toEqual(["Queued", "Running", "Stuck", "Needs you", "Done"]);
    expect(columns.map((column) => column.items.map((item) => item.id))).toEqual([["q"], [], ["s"], ["r", "y"], []]);
    expect(columns[1]?.hint).toBe("Dispatched and live in a worktree");
    expect(columns[3]?.hint).toBe("At your gate, or only you may start it");
  });

  test("the Queued hint says the loop never starts that work while the loop is on; no other hint changes", () => {
    expect(groupHint("queued", false)).toBe("Ready when you dispatch it");
    expect(groupHint("queued", true)).toBe(QUEUED_LOOP_HINT);
    expect(QUEUED_LOOP_HINT).toBe("Started by you, a lane or the conductor, never the loop");
    for (const group of GROUP_ORDER.filter((group) => group !== "queued")) {
      expect(groupHint(group, true)).toBe(groupHint(group, false));
    }
    expect(boardColumns([], false).map((column) => column.hint)).toEqual([
      "Ready when you dispatch it",
      "Dispatched and live in a worktree",
      "A worker stopped; Unblock it, or watch it close",
      "At your gate, or only you may start it",
      "The branch is the receipt",
    ]);
    expect(boardColumns([], true)[0]?.hint).toBe(QUEUED_LOOP_HINT);
  });

  test("work only you may start leaves Queued for Needs you; a quiet run stays Running, stuck work Stuck", () => {
    const columns = boardColumns([
      work("quiet", "running", { flag: quietFlag }),
      work("s", "blocked"),
      work("yours", "proposed", { flag: yoursFlag }),
      work("r", "review"),
      work("q", "proposed"),
      work("c", "running"),
    ]);
    expect(columns.map((column) => column.items.map((item) => item.id))).toEqual([
      ["q"],
      ["quiet", "c"],
      ["s"],
      ["r", "yours"],
      [],
    ]);
  });

  test("the board places every item exactly once, flagged work too", () => {
    const flagged = [...plane, work("y", "proposed", { flag: yoursFlag }), work("z", "running", { flag: quietFlag })];
    const placed = boardColumns(flagged).flatMap((column) => column.items.map((item) => item.id));
    expect(placed.sort()).toEqual(flagged.map((item) => item.id).sort());
  });
});

describe("card words", () => {
  test("crumb is initiative › project, falling back to the repo folder", () => {
    expect(crumb(work("x", "running", { initiative: "hawthorne", project: "core" }))).toBe("hawthorne › core");
    expect(crumb(work("x", "running", { initiative: "hawthorne", repo: "/src/hawthorne-db/" }))).toBe(
      "hawthorne › hawthorne-db",
    );
    expect(crumb(work("x", "running", { repo: "/src/maestro" }))).toBe("maestro");
    expect(crumb(work("x", "running", { initiative: "ops" }))).toBe("ops");
    expect(crumb(work("x", "running", { initiative: "ops", project: "ops" }))).toBe("ops");
    expect(crumb(work("x", "running"))).toBeNull();
  });

  test("the state label follows the phase, then the plain voice", () => {
    expect(stateText(work("x", "review", { phase: "asking" }))).toBe("Question");
    expect(stateText(work("x", "running", { phase: "checking" }))).toBe("Checking");
    expect(stateText(work("x", "running", { phase: "working" }))).toBe("Running");
    expect(stateText(work("x", "canceled"))).toBe("Canceled");
    expect(stateText(work("x", "triggered"))).toBe("Queued");
  });

  test("the worker line says whether the run has its own worktree", () => {
    const base = { agentId: "a1", workspaceId: "w1", provider: "claude", cwd: "/src" };
    expect(workerText({ ...base, branch: "maestro/x-1" })).toBe("claude · own worktree");
    expect(workerText({ ...base, branch: null })).toBe("claude · in the repo");
    expect(workerText(null)).toBeNull();
  });

  test("only stuck work carries a reason, and never an empty one", () => {
    expect(stuckText(plane[1] as WorkItem)).toBe("Needs a Linear scope");
    expect(stuckText(work("x", "blocked"))).toBe("The run stopped without a reason.");
    expect(stuckText(work("x", "blocked", { reason: "" }))).toBe("The run stopped without a reason.");
    expect(stuckText(work("x", "review", { reason: "stale" }))).toBeNull();
  });

  test("the changed line reads +a −d, and nothing when unknown", () => {
    expect(changeText({ additions: 12, deletions: 3 })).toBe("+12 −3");
    expect(changeText({ additions: 0, deletions: 0 })).toBe("+0 −0");
    expect(changeText(null)).toBeNull();
    expect(changeLabel({ additions: 1, deletions: 3 })).toBe("1 line added, 3 removed");
  });

  test("the changed row needs a branch or a stat that was read, never a bare label", () => {
    expect(changedVisible("maestro/x-1", null)).toBe(true);
    expect(changedVisible(null, { additions: 0, deletions: 0 })).toBe(true);
    expect(changedVisible(null, null)).toBe(false);
    expect(changedVisible(undefined, null)).toBe(false);
    expect(changedVisible("", null)).toBe(false);
  });

  test("a card is spoken with its crumb, stuck reason and age", () => {
    const now = Date.parse("2026-09-29T11:12:00Z");
    expect(cardLabel(plane[1] as WorkItem, now)).toBe(
      "Work b, Stuck, hawthorne › db, Needs a Linear scope, updated 12 minutes ago",
    );
    expect(cardLabel(work("x", "running"), now)).toBe("Work x, Running, updated 12 minutes ago");
  });

  test("a flagged card says why the loop flagged it, in the card and in its spoken label", () => {
    const now = Date.parse("2026-09-29T11:12:00Z");
    const item = work("y", "proposed", { flag: yoursFlag });
    expect(flagText(item)).toBe(yoursFlag.reason);
    expect(flagText(work("x", "proposed"))).toBeNull();
    expect(cardLabel(item, now)).toBe(
      "Work y, Queued, Start it yourself: it runs without permission prompts., updated 12 minutes ago",
    );
  });

  test("the header puts what needs a person first", () => {
    // Without the header's count (not read yet, or failed), the subtitle says what it counts: work items.
    expect(summaryText(plane)).toBe("1 work item needs you · 1 running");
    // A quiet run is watched: counted once, where it is listed, under Running (A1).
    expect(summaryText([...plane, work("z", "running", { flag: quietFlag })])).toBe(
      "1 work item needs you · 2 running",
    );
    // Stuck work is watched too: it needs no one by itself. But only needs.list may say nothing needs you:
    // an ask can wait while no work does, so without its count the subtitle says it has not read it yet.
    expect(summaryText([work("b", "blocked")])).toBe("What needs you is not read yet");
    expect(summaryText([work("y", "proposed", { flag: yoursFlag })])).toBe("1 work item needs you");
    expect(summaryText([work("x", "review"), work("y", "review")])).toBe("2 work items need you");
    expect(summaryText([work("x", "done")])).toBe("What needs you is not read yet");
    expect(summaryText([work("x", "done")], 0)).toBe("Nothing needs you");
    expect(summaryText([])).toBe("No work yet");
    // With needs.list's total, the subtitle says that number: the badge's, Maestro-wide.
    expect(summaryText(plane, 5)).toBe("5 need you · 1 running");
    expect(summaryText([], 0)).toBe("Nothing needs you");
  });
});
