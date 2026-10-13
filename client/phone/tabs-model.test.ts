import { describe, expect, test } from "bun:test";
import { needsOf } from "../../server/needs";
import { noticesOf } from "../../server/notices";
import type { FleetDetail, FleetScope, FleetTick } from "../../shared/fleet";
import type { LoopRow } from "../../shared/loops";
import type { Handled } from "../../shared/needs";
import { runningOf } from "../../shared/needs-you";
import { fakeWork } from "../fake-work";
import type { ScopeRead } from "../fleet-cockpit-model";
import { healthModel } from "../health-model";
import { healthRows } from "../home-model";
import { NO_FILTERS, workBoard } from "../work-model";
import {
  firstLane,
  fleetTiles,
  healthCounts,
  healthDeck,
  laneCards,
  laneRows,
  lifecycleOf,
  noticeAct,
  noticePrimary,
  receiptLines,
  WORK_LANES,
  workCounts,
  workDeck,
} from "./tabs-model";

const NOW = Date.parse("2026-10-12T15:00:00.000Z");
const H = 3_600_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
// Real shapes: a Paseo agent id, a work id and a ledger uid are three different things.
const live = (n: string) => ({ agentId: `d3c2a1b0-7a54-4e0f-9b1e-${n.padStart(12, "0")}`, workspaceId: "ws1" });
const quiet = { kind: "quiet" as const, reason: "Quiet for 808 minutes.", at: ago(808 * 60_000) };

const items = [
  fakeWork("w-gate-9a1", "review", live("1"), { project: "sri", ticket: "STI-3500" }),
  fakeWork("w-stuck-3c4", "blocked", live("2"), {
    project: "sri",
    ticket: "STI-3593",
    reason: "Session ended mid-turn",
  }),
  fakeWork("w-run-1f2", "running", live("3"), {
    project: "sri",
    phase: "working",
    ticket: "STI-3684",
    changed: { additions: 212, deletions: 38 },
    checks: [{ name: "bun test", run: "bun test" }],
  }),
  fakeWork("w-stand-8a0", "running", live("4"), { project: "sri", flag: quiet, ticket: "STI-3617" }),
  fakeWork("w-q-5d7", "proposed", null, { project: "maestro-paseo" }),
];
const needs = needsOf({ items, asks: [], reviews: [], landing: null, workspace: "broomva" }, NOW);
const handled: Handled = {
  rows: [{ key: "work:old", title: "Closed one", closedBy: "gates", reason: "merged", at: ago(3 * H) }],
  today: { closedForYou: 1, byYou: 0, asksAnswered: 0 },
};
const board = workBoard({ items, needs, handled, asks: [], filters: NO_FILTERS, now: NOW });
const notices = noticesOf({ items, fleet: [], timeline: [], loops: [], reviews: [], snoozed: new Map() }, NOW);

describe("Work: the deck is the work that needs you", () => {
  test("it is the Needs you tray's work-backed holds, in order", () => {
    const deck = workDeck(board);
    expect(deck.length).toBeGreaterThan(0);
    expect(deck.every((card) => card.item !== null && card.lane === "needs")).toBe(true);
    expect(deck.map((card) => card.key)).toEqual(
      needs.rows.filter((row) => row.key.startsWith("work:")).map((row) => row.key),
    );
  });

  test("a hold that is not work (an ask) is not on the Work deck", () => {
    const ask = { ...board.lanes[0], cards: [] };
    const withAsk = {
      ...board,
      lanes: board.lanes.map((lane) =>
        lane.id === "needs"
          ? {
              ...lane,
              cards: [...lane.cards, { ...(lane.cards[0] as (typeof lane.cards)[number]), key: "ask:x", item: null }],
            }
          : lane,
      ),
    };
    expect(ask.cards).toHaveLength(0);
    expect(workDeck(withAsk).map((card) => card.key)).not.toContain("ask:x");
  });

  test("the sheet's counts are the lengths of the lanes it lists, and Running is the Work badge's list", () => {
    const counts = workCounts(board);
    expect(counts.map((count) => count.id)).toEqual(WORK_LANES.map((lane) => lane.id));
    for (const lane of WORK_LANES) {
      expect(counts.find((count) => count.id === lane.id)?.label).toBe(
        `${laneCards(board, lane.id).length} ${lane.title.toLowerCase()}`,
      );
    }
    expect(laneCards(board, "running")).toHaveLength(runningOf(items).length);
    expect(counts.find((count) => count.id === "running")?.running).toBe(true);
  });

  test("the switcher opens on the first lane with cards", () => {
    expect(firstLane(board)).toBe("running");
    const empty = { ...board, lanes: board.lanes.map((lane) => ({ ...lane, cards: [] })) };
    expect(firstLane(empty)).toBe("running");
    const onlyDone = {
      ...board,
      lanes: board.lanes.map((lane) => (lane.id === "done" ? lane : { ...lane, cards: [] })),
    };
    expect(firstLane(onlyDone)).toBe("done");
  });

  test("lifecycle and receipts come from the work, never invented", () => {
    const running = items[2] as (typeof items)[number];
    expect(lifecycleOf(running).map((step) => step.label)).toEqual(["Queued", "Running", "Landed", "Done"]);
    expect(lifecycleOf(running).map((step) => step.done)).toEqual([true, true, false, false]);
    expect(receiptLines(running)).toEqual(["changed  +212 −38", "checks   bun test"]);
    expect(receiptLines(items[4] as (typeof items)[number])).toEqual([]);
  });
});

describe("Health: the deck is the notices, stuck first", () => {
  const rows = healthRows(items, notices);

  test("every notice is on the deck, so its length is the Health tab's badge", () => {
    expect(healthDeck(rows)).toHaveLength(notices.summary.total);
    expect(notices.summary.total).toBeGreaterThan(1);
  });

  test("stuck before quiet, and a kind keeps notices.list's order", () => {
    const shuffled = [...rows].reverse();
    const kinds = healthDeck(shuffled).map((row) => row.notice.kind);
    expect(kinds.indexOf("stuck")).toBeLessThan(kinds.indexOf("quiet"));
    expect(
      healthDeck(rows)
        .map((row) => row.key)
        .sort(),
    ).toEqual(rows.map((row) => row.key).sort());
  });

  test("Unblock asks for words when its work is here; Snooze is sent; anything else opens", () => {
    const stuck = rows.find((row) => row.notice.kind === "stuck") as NonNullable<(typeof rows)[number]>;
    const quietRow = rows.find((row) => row.notice.kind === "quiet") as NonNullable<(typeof rows)[number]>;
    expect(noticeAct(stuck.notice, stuck.item)).toBe("unblock");
    expect(noticePrimary(stuck.notice, stuck.item)).toBe("Unblock…");
    // The work is not in the list this client read: it cannot send a prompt, so it opens instead.
    expect(noticeAct(stuck.notice, null)).toBe("open");
    expect(noticePrimary(stuck.notice, null)).toBe("Open");
    expect(noticeAct(quietRow.notice, quietRow.item)).toBe("snooze");
    expect(noticePrimary(quietRow.notice, quietRow.item)).toBe("Snooze 4h");
    expect(noticeAct({ ...quietRow.notice, verb: { id: "open-log", label: "Open log" } }, null)).toBe("open");
  });
});

const tick = (n: number, hoursAgo: number, status: FleetTick["status"] = "ok"): FleetTick => ({
  tick: n,
  at: ago(hoursAgo * H),
  finishedAt: ago(hoursAgo * H - 10_000),
  status,
  exit: status === "ok" ? 0 : 1,
  steps: null,
  failedStep: null,
  dryRun: true,
  mode: "report",
  classCounts: null,
  openAsks: 0,
  proposals: 0,
});
const okHealth = {
  status: "ok" as const,
  reason: "Ticks every hour.",
  notice: "",
  since: null,
  item: null,
  needsYou: false,
};
const scope = (id: string): FleetScope => ({
  id,
  mode: "report",
  dryRun: true,
  health: okHealth,
  lastTick: { tick: 24, at: ago(0.5 * H), status: "ok" },
  unreviewed: 0,
  openAsks: 0,
});
const detail = (id: string, ticks: FleetTick[]): FleetDetail =>
  ({
    id,
    stateDir: `/state/${id}`,
    schedule: { scheduled: true, intervalMinutes: 60 },
    ticks,
    report: null,
    proposals: [],
    asks: [],
    decisions: [],
    askRoot: "/asks",
    alerts: [],
    warnings: [],
    roster: { tick: 24, at: ago(H), sessions: [] },
  }) as FleetDetail;
const okTicks = Array.from({ length: 24 }, (_, at) => tick(24 - at, at + 0.5));
const reads: ScopeRead[] = [
  { scope: scope("broomva"), detail: detail("broomva", okTicks) },
  {
    scope: scope("sri"),
    detail: detail(
      "sri",
      okTicks.map((one, at) => (at === 5 ? { ...one, status: "failed" as const, exit: 1 } : one)),
    ),
  },
];
const row = (name: string, extra: Partial<LoopRow> = {}): LoopRow =>
  ({
    subject: `loop:${name}`,
    id: name,
    name,
    kind: "launchd",
    ref: name,
    scope: "broomva",
    owner: "owner",
    purpose: null,
    desired: "active",
    section: "loops",
    intent: null,
    observed: {
      subject: `loop:launchd/${name}`,
      kind: "launchd",
      ref: name,
      name,
      scope: "broomva",
      presence: "on",
      status: "ok",
      reason: "ok",
      since: null,
      cadence: "hourly",
      next: new Date(NOW + 3 * H).toISOString(),
      last: null,
      runs: [],
      ephemeral: false,
      where: null,
    },
    unread: false,
    drift: [],
    ...extra,
  }) as LoopRow;
const loops = (rows: LoopRow[]) => ({ now: ago(0), ledger: null, rows, ledgerErrors: [], warnings: [] });
const failing = row("b");
if (failing.observed) failing.observed.status = "failed";
const model = healthModel({
  reads,
  loops: loops([row("a"), failing]),
  notices,
  items,
  loop: { minutes: 15, nextAt: null, ticking: false, recent: [] } as never,
  now: NOW,
});

describe("Health: the fleet at a glance", () => {
  test("four tiles, in the design's order, each from the desktop's own model", () => {
    const tiles = fleetTiles(model);
    expect(tiles.map((tile) => tile.id)).toEqual(["ticks", "sessions", "schedules", "conductor"]);
    expect(tiles[0]).toMatchObject({
      value: String(model.ticks.passed),
      unit: `of ${model.ticks.total}`,
      tone: "warn",
    });
    expect(tiles[0]?.line).toBe("sri missed 1");
    expect(tiles[2]).toMatchObject({ value: "2", tone: "warn" });
    expect(tiles[3]).toMatchObject({ value: "On" });
  });

  test("sessions counts running work in its own unit: stuck and quiet are named, never summed into it", () => {
    const sessions = fleetTiles(model)[1];
    expect(sessions?.value).toBe(String(runningOf(items).length));
    expect(sessions?.unit).toBe("running");
    expect(sessions?.line).toContain("1 stuck");
    expect(sessions?.line).toContain("1 quiet");
  });

  test("a scope that was not read says so; it is not a zero of ticks passed", () => {
    const unread = healthModel({ reads: [], loops: null, notices: null, items: [], loop: null, now: NOW });
    const tiles = fleetTiles(unread);
    expect(tiles[0]?.line).toBe("No fleet scope is read.");
    expect(tiles[0]?.unit).toBeUndefined();
    expect(healthCounts(unread, 0)[0]?.label).toBe("ticks: not read");
  });

  test("the peek's counts are the tiles' numbers", () => {
    const counts = healthCounts(model, 2);
    expect(counts.map((count) => count.label)).toEqual([
      `${model.ticks.passed}/${model.ticks.total} ticks`,
      "Dry run",
      "2 schedules",
      "2 lanes",
    ]);
    expect(counts[0]?.tone).toBe("warn");
    expect(healthCounts(model, 1).at(-1)?.label).toBe("1 lane");
  });
});

describe("Work's sheet rows", () => {
  const rows = (lane: "running" | "queued" | "done") => laneRows(laneCards(board, lane), lane, NOW);

  test("a running row says where, its ticket and its live turn; it never offers Continue or Snooze", () => {
    const [row] = rows("running");
    expect(row?.kind).toBe("running");
    expect(row?.lead).toBe("running");
    expect(row?.meta).toContain("STI-3684");
    expect(row?.meta).toContain("working");
    expect(row?.verbs).toEqual({ continue: false, snooze: false });
    expect(row?.target.item?.id).toBe("w-run-1f2");
  });

  test("a queued row waits; a Done row is finished and offers Continue only when it has work behind it", () => {
    expect(rows("queued")[0]?.kind).toBe("queued");
    const done = rows("done")[0];
    expect(done?.kind).toBe("finished");
    // handled.list's row for work this client has no item for: nothing to prompt.
    expect(done?.target.item).toBeNull();
    expect(done?.verbs.continue).toBe(false);
  });
});
