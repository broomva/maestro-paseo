import { describe, expect, test } from "bun:test";
import type { WorkItem } from "../shared/contracts";
import { GROUP_ORDER, groupOf, type OrchState, QUEUED_LOOP_HINT } from "../shared/states";
import { needsYou } from "./header-count";
import {
  applyFilter,
  boardColumns,
  cardLabel,
  changedVisible,
  changeLabel,
  changeText,
  countFilters,
  crumb,
  decisionsBadge,
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
    permission: null,
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

  test("the Decisions badge: the open count, warn only when one waits on you, and none when nothing is open", () => {
    expect(decisionsBadge(0, 0)).toBeNull();
    expect(decisionsBadge(49, 0)).toEqual({ count: 49, warn: false, label: "49 open" });
    expect(decisionsBadge(49, 1)).toEqual({ count: 49, warn: true, label: "49 open, 1 waits on you" });
    expect(decisionsBadge(3, 2)?.label).toBe("3 open, 2 wait on you");
  });
});

describe("filters", () => {
  test("counts every group and the total; Needs you counts stuck work too", () => {
    expect(countFilters(plane)).toEqual({ all: 7, review: 2, blocked: 1, running: 1, queued: 2, done: 2 });
  });

  test("a state chip keeps its section; Needs you keeps what needs you; Stuck keeps stuck work; All keeps everything", () => {
    expect(applyFilter(plane, "queued").map((item) => item.id)).toEqual(["d", "e"]);
    expect(applyFilter(plane, "review").map((item) => item.id)).toEqual(["a", "b"]);
    expect(applyFilter(plane, "blocked").map((item) => item.id)).toEqual(["b"]);
    expect(applyFilter(plane, "all")).toHaveLength(7);
  });

  test("the Needs you chip counts and lists stuck and flagged work; no state chip does, and Stuck narrows Needs you", () => {
    const flagged = [...plane, work("y", "proposed", { flag: yoursFlag }), work("z", "running", { flag: quietFlag })];
    expect(countFilters(flagged)).toEqual({ all: 9, review: 4, blocked: 1, running: 1, queued: 2, done: 2 });
    expect(applyFilter(flagged, "review").map((item) => item.id)).toEqual(["a", "b", "y", "z"]);
    expect(applyFilter(flagged, "queued").map((item) => item.id)).toEqual(["d", "e"]);
    expect(applyFilter(flagged, "running").map((item) => item.id)).toEqual(["c"]);
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
    const SECTION_CHIPS = ["review", "running", "queued", "done"] as const;
    for (const [name, items] of mixes) {
      test(name, () => {
        const counts = countFilters(items);
        const sections = new Map(groupsOf(items).map((entry) => [entry.group, entry.items.length]));
        // Needs you, Running, Queued and Done: the count is that section's length in the All view.
        for (const chip of SECTION_CHIPS) expect([chip, counts[chip]]).toEqual([chip, sections.get(chip) ?? 0]);
        // Every chip, Stuck and All included: the count is what the filter shows.
        for (const chip of FILTERS) expect([chip, counts[chip]]).toEqual([chip, applyFilter(items, chip).length]);
        // Stuck narrows Needs you; the four section chips add up to All.
        expect(applyFilter(items, "blocked").every((item) => inFilter(item, "review"))).toBe(true);
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
  test("open over total, with a badge for work waiting on a person", () => {
    expect(initiatives(plane)).toEqual([
      { name: "genesis", open: 1, total: 2, needsYou: 0 },
      { name: "hawthorne", open: 3, total: 4, needsYou: 2 },
    ]);
  });

  test("the badge counts work the loop flagged, which waits on a person too", () => {
    expect(needsHand(work("y", "proposed", { flag: yoursFlag }))).toBe(true);
    expect(needsHand(work("z", "running", { flag: quietFlag }))).toBe(true);
    expect(needsHand(work("c", "running"))).toBe(false);
    expect(initiatives([...plane, work("y", "proposed", { initiative: "genesis", flag: yoursFlag })])).toEqual([
      { name: "genesis", open: 2, total: 3, needsYou: 1 },
      { name: "hawthorne", open: 3, total: 4, needsYou: 2 },
    ]);
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
  test("feed sections are non-empty and attention first; Needs you holds the stuck work", () => {
    expect(groupsOf(plane).map((entry) => [entry.group, entry.items.map((item) => item.id)])).toEqual([
      ["review", ["a", "b"]],
      ["running", ["c"]],
      ["queued", ["d", "e"]],
      ["done", ["f", "g"]],
    ]);
    expect(groupsOf([work("x", "done"), work("y", "running")]).map((entry) => entry.group)).toEqual([
      "running",
      "done",
    ]);
  });

  test("flagged work is listed in the feed's Needs you, after review and stuck, and not again in its own group", () => {
    const sections = groupsOf([
      work("quiet", "running", { flag: quietFlag }),
      work("s", "blocked"),
      work("yours", "proposed", { flag: yoursFlag }),
      work("r", "review"),
      work("q", "proposed"),
      work("c", "running"),
    ]);
    expect(sections.map((entry) => [entry.group, entry.items.map((item) => item.id)])).toEqual([
      ["review", ["r", "s", "quiet", "yours"]],
      ["running", ["c"]],
      ["queued", ["q"]],
    ]);
  });

  test("one definition: the feed's Needs you, the board's column, the chip and the header count hold the same work", () => {
    const flagged = [...plane, work("y", "proposed", { flag: yoursFlag }), work("z", "running", { flag: quietFlag })];
    const feed = groupsOf(flagged)
      .find((entry) => entry.group === "review")
      ?.items.map((item) => item.id);
    const column = boardColumns(flagged)
      .find((entry) => entry.id === "needs-you")
      ?.items.map((item) => item.id);
    expect(feed).toEqual(["a", "b", "y", "z"]);
    expect(column).toEqual(feed);
    expect(applyFilter(flagged, "review").map((item) => item.id)).toEqual(feed ?? []);
    expect(countFilters(flagged).review).toBe(feed?.length ?? -1);
    expect(needsYou(flagged).map((item) => item.id)).toEqual(feed ?? []);
    expect(summaryText(flagged)).toBe("4 work items need you · 1 running");
  });

  test("four columns, always present; Needs you holds review before stuck", () => {
    const shuffled = [work("s", "blocked"), work("r", "review"), work("q", "proposed")];
    const columns = boardColumns(shuffled);
    expect(columns.map((column) => column.title)).toEqual(["Queued", "Running", "Needs you", "Done"]);
    expect(columns.map((column) => column.items.map((item) => item.id))).toEqual([["q"], [], ["r", "s"], []]);
    expect(columns[1]?.hint).toBe("Dispatched and live in a worktree");
    expect(columns[2]?.hint).toBe("At your gate, stuck or flagged");
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
      "At your gate, stuck or flagged",
      "The branch is the receipt",
    ]);
    expect(boardColumns([], true)[0]?.hint).toBe(QUEUED_LOOP_HINT);
  });

  test("work the loop flagged leaves its own column for Needs you, after review and stuck", () => {
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
      ["c"],
      ["r", "s", "quiet", "yours"],
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
    expect(summaryText(plane)).toBe("2 work items need you · 1 running");
    // A flagged run is counted once, where it is listed: in Needs you.
    expect(summaryText([...plane, work("z", "running", { flag: quietFlag })])).toBe(
      "3 work items need you · 1 running",
    );
    expect(summaryText([work("b", "blocked")])).toBe("1 work item needs you");
    expect(summaryText([work("x", "review"), work("y", "review")])).toBe("2 work items need you");
    expect(summaryText([work("x", "done")])).toBe("Nothing needs you");
    expect(summaryText([])).toBe("No work yet");
    // With the header's own count, the subtitle says that number: the badge's, Maestro-wide.
    expect(summaryText(plane, 5)).toBe("5 need you · 1 running");
    expect(summaryText([], 0)).toBe("Nothing needs you");
  });
});
