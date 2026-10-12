import { describe, expect, test } from "bun:test";
import { needsOf } from "../server/needs";
import type { DecisionAsk } from "../shared/fleet";
import type { Initiative } from "../shared/initiatives";
import { fakeWork } from "./fake-work";
import {
  type BoardInput,
  dateWords,
  driverOf,
  hangingWords,
  initiativeBoard,
  sourceLine,
} from "./initiatives-board-model";

const TODAY = "2026-10-09";
const NOW = Date.parse("2026-10-09T15:00:00.000Z");

const initiative = (id: string, extra: Partial<Initiative> = {}): Initiative =>
  ({
    id,
    file: `${id}.yaml`,
    home: { kind: "main", path: "/ctl", branch: null },
    error: null,
    title: id,
    quote: null,
    intentSource: null,
    summary: `${id} summary`,
    status: "active",
    stated: "2026-09-01",
    reviewBy: "2026-10-20",
    wake: null,
    nextAction: null,
    driver: "none",
    waitingOn: [],
    linear: [],
    prs: [],
    repos: [],
    sessions: [],
    asks: [],
    exit: null,
    closedAt: null,
    outcome: null,
    stale: null,
    local: [],
    ideas: { open: 0, triaged: 0 },
    ...extra,
  }) as Initiative;

const ask = (id: string, extra: Partial<DecisionAsk> = {}): DecisionAsk =>
  ({
    ledger: "x.yaml",
    uid: null,
    id,
    hash: "h",
    arc: null,
    headline: `Idea ${id}`,
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
    home: { kind: "main", path: "/ctl", branch: null },
    batched: false,
    waiting: false,
    ...extra,
  }) as DecisionAsk;

const skene = initiative("skene", {
  reviewBy: "2026-10-07",
  stale: { kind: "overdue", date: "2026-10-07" },
  driver: "coordinator:skene-driver",
  sessions: [{ id: "abcd", agentId: "agent-9" }],
});
const canvas = initiative("local-first canvas", {
  id: "canvas",
  reviewBy: "2026-10-07",
  stale: { kind: "overdue", date: "2026-10-07" },
});
const holon = initiative("holon", {
  reviewBy: "2026-10-08",
  stale: { kind: "overdue", date: "2026-10-08" },
  driver: "holon-coordinator",
  sessions: [{ id: "x", agentId: "agent-3" }],
});
const maestro = initiative("maestro", { reviewBy: "2026-10-16", driver: "owner" });
const kinetic = initiative("kinetic", { status: "parked", wake: "2026-10-30", reviewBy: null });
const all = [skene, canvas, holon, maestro, kinetic];

const items = [
  fakeWork("w1", "running", null, { initiative: "skene" }),
  fakeWork("w2", "proposed", null, { initiative: "skene" }),
  fakeWork("w3", "done", null, { initiative: "skene" }),
  fakeWork("w4", "proposed", null, { initiative: "maestro" }),
];
const asks = [
  ask("A1", { initiative: "skene" }),
  ask("A2", { initiative: "skene", state: "answered" }),
  ask("A3", { initiative: "maestro" }),
];
const needs = needsOf(
  { items: [], asks: [], reviews: [skene, canvas, holon], landing: null, workspace: "broomva" },
  NOW,
);
const input: BoardInput = {
  initiatives: all,
  ideas: [ask("I1"), ask("I2", { state: "answered" })],
  items,
  asks,
  needs,
  filter: "all",
  today: TODAY,
};

describe("lateness is the loudest thing", () => {
  test("late reviews come first, the longest late first (ties by name), then by date; the parked one last", () => {
    expect(initiativeBoard(input).rows.map((row) => row.id)).toEqual([
      "canvas",
      "skene",
      "holon",
      "maestro",
      "kinetic",
    ]);
  });

  test("a review's date says how late it is, against the daemon's day", () => {
    expect(dateWords(skene, TODAY)).toEqual({ text: "10-07", late: "2 d late" });
    expect(dateWords(holon, TODAY)).toEqual({ text: "10-08", late: "1 d late" });
    expect(
      dateWords(initiative("today", { reviewBy: TODAY, stale: { kind: "overdue", date: TODAY } }), TODAY).late,
    ).toBe("today");
    expect(dateWords(maestro, TODAY)).toEqual({ text: "10-16", late: null });
    expect(dateWords(kinetic, TODAY)).toEqual({ text: "10-30", late: null });
    expect(
      dateWords(
        initiative("woke", { status: "parked", wake: "2026-10-08", stale: { kind: "wake", date: "2026-10-08" } }),
        TODAY,
      ).late,
    ).toBe("1 d late");
    expect(dateWords(initiative("none", { reviewBy: null }), TODAY)).toEqual({ text: "no date", late: null });
  });

  test("a row is due when needs.list holds its review: that is the one number", () => {
    const board = initiativeBoard(input);
    expect(board.rows.filter((row) => row.due).map((row) => row.id)).toEqual(["canvas", "skene", "holon"]);
    expect(board.tiles.due.value).toBe(needs.rows.filter((row) => row.key.startsWith("review:")).length);
    expect(board.chips.find((chip) => chip.id === "due")?.count).toBe(board.tiles.due.value);
    // Without needs.list read, nothing is claimed due.
    expect(initiativeBoard({ ...input, needs: null }).tiles.due.value).toBe(0);
  });
});

describe("the tiles, the chips and what hangs off an initiative", () => {
  const board = initiativeBoard(input);

  test("Review due names each late initiative and how late", () => {
    expect(board.tiles.due.line).toBe("local-first canvas 2 d late · skene 2 d late · holon 1 d late");
  });

  test("Active counts the active ones and says which have no driver session", () => {
    expect(board.tiles.active.value).toBe(4);
    expect(board.tiles.active.line).toBe("2 have a driver session; local-first canvas, maestro have none.");
  });

  test("Proposed is the ideas waiting to be triaged, never the answered ones", () => {
    expect(board.tiles.proposed).toEqual({ value: 1, line: "Idea I1" });
    expect(initiativeBoard({ ...input, ideas: [] }).tiles.proposed.line).toBe("No idea is waiting to be triaged.");
  });

  test("work hanging off is the open work that names it; asks are the open decisions that do", () => {
    expect(board.rows.find((row) => row.id === "skene")).toMatchObject({ work: 2, asks: 1 });
    expect(board.rows.find((row) => row.id === "maestro")).toMatchObject({ work: 1, asks: 1 });
    expect(board.tiles.hanging).toMatchObject({ work: 3, asks: 2 });
    expect(hangingWords(3, 1)).toBe("3 work items · 1 ask");
  });

  test("the chips filter the rows, and each count is its rows' length", () => {
    for (const chip of board.chips.filter((one) => one.id !== "proposed")) {
      expect(initiativeBoard({ ...input, filter: chip.id }).rows).toHaveLength(chip.count);
    }
    expect(initiativeBoard({ ...input, filter: "parked" }).rows.map((row) => row.id)).toEqual(["kinetic"]);
    expect(initiativeBoard({ ...input, filter: "active" }).rows.map((row) => row.id)).not.toContain("kinetic");
    // Proposed is the ideas, listed by their own view: no initiative rows.
    expect(initiativeBoard({ ...input, filter: "proposed" }).rows).toEqual([]);
  });

  test("a driver is named in a word, and live only when a session of its is known here", () => {
    expect(driverOf(skene)).toEqual({ name: "skene-driver", live: true });
    expect(driverOf(canvas)).toEqual({ name: "none", live: false });
    expect(driverOf(maestro)).toEqual({ name: "owner", live: false });
  });

  test("an unreadable file is not a row", () => {
    expect(
      initiativeBoard({ ...input, initiatives: [...all, initiative("bad", { error: "no id" })] }).rows,
    ).toHaveLength(5);
  });

  test("where the rows are read from", () => {
    expect(sourceLine("/ctl")).toBe("from /ctl/.control/initiatives/*.yaml · sorted by review date");
    expect(sourceLine("")).toBe("from .control/initiatives/*.yaml · sorted by review date");
  });
});
