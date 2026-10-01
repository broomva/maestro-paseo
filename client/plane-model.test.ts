import { describe, expect, test } from "bun:test";
import type { WorkItem } from "../shared/contracts";
import { groupOf, type OrchState } from "../shared/states";
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
  groupsOf,
  initiatives,
  inScope,
  resolveScope,
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
    ...extra,
  };
}

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

  test("compact offers the feed and History; wide offers all four", () => {
    expect(viewsFor(true).map((view) => view.label)).toEqual(["Feed", "History"]);
    expect(viewsFor(false).map((view) => view.label)).toEqual(["Feed", "Board", "List", "History"]);
  });
});

describe("filters", () => {
  test("counts every group and the total", () => {
    expect(countFilters(plane)).toEqual({ all: 7, review: 1, blocked: 1, running: 1, queued: 2, done: 2 });
  });

  test("a group filter keeps only that group; All keeps everything", () => {
    expect(applyFilter(plane, "queued").map((item) => item.id)).toEqual(["d", "e"]);
    expect(applyFilter(plane, "review").map((item) => item.id)).toEqual(["a"]);
    expect(applyFilter(plane, "all")).toHaveLength(7);
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
  test("feed groups are non-empty and attention first", () => {
    expect(groupsOf(plane).map((entry) => entry.group)).toEqual(["review", "blocked", "running", "queued", "done"]);
    expect(groupsOf([work("x", "done"), work("y", "running")]).map((entry) => entry.group)).toEqual([
      "running",
      "done",
    ]);
  });

  test("four columns, always present; Needs you holds review before stuck", () => {
    const shuffled = [work("s", "blocked"), work("r", "review"), work("q", "proposed")];
    const columns = boardColumns(shuffled);
    expect(columns.map((column) => column.title)).toEqual(["Queued", "Running", "Needs you", "Done"]);
    expect(columns.map((column) => column.items.map((item) => item.id))).toEqual([["q"], [], ["r", "s"], []]);
    expect(columns[1]?.hint).toBe("Dispatched and live in a worktree");
    expect(columns[2]?.hint).toBe("At your gate or stuck");
  });

  test("the board places every item exactly once", () => {
    const placed = boardColumns(plane).flatMap((column) => column.items.map((item) => item.id));
    expect(placed.sort()).toEqual(plane.map((item) => item.id).sort());
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

  test("the header puts what needs a person first", () => {
    expect(summaryText(plane)).toBe("1 needs you · 1 stuck · 1 running");
    expect(summaryText([work("x", "review"), work("y", "review")])).toBe("2 need you");
    expect(summaryText([work("x", "done")])).toBe("Nothing needs you");
    expect(summaryText([])).toBe("No work yet");
  });
});
