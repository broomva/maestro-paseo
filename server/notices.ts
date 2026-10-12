// notices.list (BRO-3036): what you watch that went wrong, computed once from what the daemon already holds.
// Pure: the caller hands in the reads, and nothing here reconciles, sweeps or writes (BRO-2995). Owner answer A1:
// a notice is a fact, never a hold. The kinds:
//   - stuck: work whose worker stopped (the work's own state);
//   - quiet: a run the loop flagged after 30 minutes with no turn;
//   - schedule: a scheduled source whose run failed or was missed (launchd, a Paseo schedule or heartbeat, the
//     loop) and a fleet scope whose tick is missed, failing or unjudgeable;
//   - loop: loop drift, with its pinned fix;
//   - initiative: initiatives past their review date (each is also a hold in Needs you, a due review, B2).
// A snoozed notice is left out until its time is up; the summary says how many were.

import type { WorkItem } from "../shared/contracts";
import type { FleetNotice } from "../shared/fleet";
import type { Initiative } from "../shared/initiatives";
import type { LoopNotice } from "../shared/loops";
import { workKey } from "../shared/needs";
import { isStanding, sectionOf } from "../shared/needs-you";
import { type NoticeKind, type NoticeRow, type Notices, SNOOZE_HOURS } from "../shared/notices";
import { ticketOf } from "../shared/text";
import type { TimelineNotice } from "../shared/timeline";
import { scopeOf, titleOf } from "./needs";

/** What a scheduled source is called where it is listed. */
const SOURCE_WORDS: Record<TimelineNotice["kind"], string> = {
  schedule: "Paseo schedule",
  heartbeat: "Paseo heartbeat",
  launchd: "launchd",
  loop: "Maestro's loop",
  fleet: "fleet",
};

export interface NoticeSources {
  items: readonly WorkItem[];
  fleet: readonly FleetNotice[];
  timeline: readonly TimelineNotice[];
  loops: readonly LoopNotice[];
  /** The initiatives whose review is due and not yet answered (Initiative.stale). */
  reviews: readonly Initiative[];
  /** Notices snoozed, by key, until when (ISO). */
  snoozed: ReadonlyMap<string, string>;
}

const time = (iso: string | null): number => {
  const at = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
};

/** The sentence a quiet run's flag says: its reason, which says how long. */
const quietLine = (item: WorkItem): string => item.flag?.reason ?? "No turn for a while.";

function stuckRow(item: WorkItem): NoticeRow {
  const ticket = item.ticket ?? ticketOf(item.title);
  return {
    key: workKey(item.id),
    kind: "stuck",
    title: titleOf(item),
    scope: scopeOf(item),
    ...(ticket ? { ticket } : {}),
    since: item.updatedAt,
    detail: item.reason || "The run stopped without a reason.",
    closesWhen: [
      { when: "its session takes a turn again", becomes: "Running" },
      ...(item.adoptedBy ? [{ when: "its orchestrator closes it", becomes: "Handled for you" }] : []),
      { when: "you cancel it", becomes: "Canceled" },
    ],
    verb: { id: "unblock", label: "Unblock…" },
    link: { kind: "work", id: item.id },
  };
}

function quietRow(item: WorkItem): NoticeRow {
  const ticket = item.ticket ?? ticketOf(item.title);
  return {
    key: workKey(item.id),
    kind: "quiet",
    title: titleOf(item),
    scope: scopeOf(item),
    ...(ticket ? { ticket } : {}),
    since: item.flag?.at ?? item.updatedAt,
    detail: quietLine(item),
    closesWhen: [{ when: "its next turn", becomes: "Running" }],
    verb: { id: "snooze", label: `Snooze ${SNOOZE_HOURS}h` },
    link: { kind: "work", id: item.id },
  };
}

function fleetRow(notice: FleetNotice): NoticeRow {
  return {
    key: `fleet:${notice.scope}`,
    kind: "schedule",
    title: `fleet-reconcile ${notice.scope}: tick ${notice.status}`,
    scope: "fleet",
    since: notice.since,
    detail: notice.reason,
    closesWhen: [{ when: "its next tick passes", becomes: "On time" }],
    verb: { id: "open-log", label: "Open ticks" },
    link: { kind: "fleet", scope: notice.scope },
  };
}

function scheduleRow(notice: TimelineNotice): NoticeRow {
  return {
    key: `schedule:${notice.id}`,
    kind: "schedule",
    title: `${notice.name} ${notice.status === "missed" ? "was missed" : "failed"}: ${notice.reason}`,
    scope: SOURCE_WORDS[notice.kind],
    since: notice.since,
    detail: notice.reason,
    closesWhen: [{ when: "its next run passes", becomes: "On time" }],
    verb: { id: "open-log", label: "Open log" },
    link: { kind: "timeline" },
  };
}

function loopRow(notice: LoopNotice): NoticeRow {
  return {
    key: `loop:${notice.id}`,
    kind: "loop",
    title: `${notice.loop}: ${notice.detail}`,
    scope: notice.loop,
    since: null,
    detail: notice.detail,
    closesWhen: [{ when: notice.fix, becomes: "Healthy" }],
    verb: { id: "show-fix", label: "Show fix" },
    link: { kind: "loops" },
  };
}

function initiativesRow(reviews: readonly Initiative[]): NoticeRow | null {
  const due = reviews.filter((initiative) => initiative.stale);
  const first = [...due].sort((a, b) => (a.stale?.date ?? "").localeCompare(b.stale?.date ?? ""))[0];
  if (!first?.stale) return null;
  return {
    key: "initiatives:due",
    kind: "initiative",
    title: `${due.length} ${due.length === 1 ? "initiative is" : "initiatives are"} past ${due.length === 1 ? "its" : "their"} review date`,
    scope: "initiatives",
    since: new Date(`${first.stale.date}T00:00:00`).toISOString(),
    detail: `${first.title ?? first.id} since ${first.stale.date}`,
    closesWhen: [{ when: due.length === 1 ? "it is reviewed" : "each is reviewed", becomes: "Reviewed" }],
    verb: { id: "open-initiatives", label: "Open Initiatives" },
    link: { kind: "initiatives" },
  };
}

/** Every notice, oldest first (a notice with no known start last), by key for ties: one order for equal input. */
export function noticesOf(sources: NoticeSources, now: number): Notices {
  const stuck = sources.items.filter((item) => sectionOf(item) === "blocked").map(stuckRow);
  const quiet = sources.items.filter((item) => item.state === "running" && isStanding(item)).map(quietRow);
  const all = [
    ...stuck,
    ...quiet,
    ...sources.fleet.map(fleetRow),
    ...sources.timeline.map(scheduleRow),
    ...sources.loops.map(loopRow),
    ...[initiativesRow(sources.reviews)].filter((row): row is NoticeRow => row !== null),
  ];
  // One notice per key: a source read twice counts once.
  const keys = new Set<string>();
  const unique = all.filter((row) => !keys.has(row.key) && Boolean(keys.add(row.key)));
  const shown = unique.filter((row) => {
    const until = sources.snoozed.get(row.key);
    return until === undefined || time(until) <= now;
  });
  const rows = [...shown].sort((a, b) => time(a.since) - time(b.since) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const byKind = Object.fromEntries(
    (["stuck", "quiet", "schedule", "loop", "initiative"] as const).map((kind: NoticeKind) => [
      kind,
      rows.filter((row) => row.kind === kind).length,
    ]),
  ) as Notices["summary"]["byKind"];
  return { rows, summary: { total: rows.length, byKind, snoozed: unique.length - shown.length } };
}
