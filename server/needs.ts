// needs.list and handled.list (BRO-3001): what needs you and what closed, each
// computed once here from what the daemon already holds. Every count, badge,
// section and push reads these two (docs/design/next/view-models.md); nothing
// on the client adds lists up. Pure: the caller hands in the reads, and nothing
// here reconciles, sweeps or writes.
//
// The kinds (owner answer A1):
//   - approval: work at your gate. A permission prompt the session is paused on
//     (`heldBy: permission`), or a landing Maestro's human gate holds (`heldBy:
//     gate`, until BRO-2999 makes it Allow / Deny on a held action).
//   - ask: a decision ask that waits on you (shared/fleet.ts isWaiting), the
//     workspace's and each fleet root's; and a due initiative review (B2), with
//     a review body. An idea filed for an initiative is a proposal, watched
//     (A1): Initiatives triages it, and it holds no session.
//   - owner_step: queued work only you may start (shared/needs-you.ts
//     onlyYouStart: "Start it yourself"), and the answers batch while it waits
//     to land or has stopped (Maestro never merges its PR).
// Watched, never here: stuck work, a quiet run, a failed or missed schedule,
// loop drift, an open ask that does not wait on you, and an answer that waits
// for the conductor (BRO-2990: the conductor gives it to a lane; File and
// Dismiss stay your verbs in Decisions, but nothing holds on you).

import { basename } from "node:path";
import { type AnswersLanding, answersNotice } from "../shared/answers";
import type { WorkItem } from "../shared/contracts";
import { type DecisionAsk, isWaiting } from "../shared/fleet";
import { withoutMarker } from "../shared/fleet-item";
import type { Initiative } from "../shared/initiatives";
import {
  ANSWERS_KEY,
  type ApprovalBody,
  askHoldKey,
  type Closer,
  type Evidence,
  type Handled,
  type HandledRow,
  KIND_VERBS,
  NEED_KINDS,
  type NeedKind,
  type NeedRow,
  type NeedSummary,
  type Needs,
  reviewKey,
  workKey,
} from "../shared/needs";
import { needsHand, onlyYouStart } from "../shared/needs-you";
import { isTerminal } from "../shared/states";
import { ticketOf } from "../shared/text";
import { UNDO_MS } from "../shared/undo";

/** How far back handled.list reaches: a week, as the Feed's Handled for you always showed. */
export const HANDLED_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * When a hold whose source gives no date was first seen: an undated ask, the
 * answers batch (its last check moves on every wake). The handler keeps them in
 * memory, so `since` holds still across reads; a pure default answers `now`.
 */
export type FirstSeen = (key: string, now: number) => string;

/**
 * The first-seen times the handler keeps, in memory only: `at` answers a
 * key's first sight and holds it; `keep` forgets the keys no longer held, so
 * a hold that comes back starts again. A read that could not read every
 * source (`complete` false) forgets nothing: its missing rows are a failed
 * read, not holds that went.
 */
export function firstSeenMemory(): { at: FirstSeen; keep: (keys: readonly string[], complete: boolean) => void } {
  const seenAt = new Map<string, string>();
  return {
    at: (key, now) => {
      const known = seenAt.get(key);
      if (known) return known;
      const at = new Date(now).toISOString();
      seenAt.set(key, at);
      return at;
    },
    keep: (keys, complete) => {
      if (!complete) return;
      const live = new Set(keys);
      for (const key of seenAt.keys()) if (!live.has(key)) seenAt.delete(key);
    },
  };
}

/** What needs.list is computed from, each read as it stands: no read here may reconcile or write (BRO-2995). */
export interface NeedSources {
  /** The work list, read without a session reconcile or a decision sweep. */
  items: readonly WorkItem[];
  /** Every decision ask read: the workspace's and each fleet root's (`scope` set for a fleet root's). */
  asks: readonly DecisionAsk[];
  /** The initiatives whose review is due (Initiative.stale): overdue, or parked and woken. */
  reviews: readonly Initiative[];
  /** The answers batch as the last wake left it, or null. */
  landing: AnswersLanding | null;
  /**
   * Which Paseo agent each Claude session is (the fleet's newest reports, Fleet.sessionAgents): a fleet
   * prompt ask names the Claude session, the work names the Paseo agent. Absent: none known.
   */
  sessionAgents?: ReadonlyMap<string, string>;
  /** The workspace's name (the control repo's folder): the scope of its asks, reviews and batch. */
  workspace: string;
}

const shortId = (id: string) => id.slice(0, 8);
const titleOf = (item: WorkItem) => item.display?.title || withoutMarker(item.title);

/** The workspace or lane work belongs to: its fleet scope, its project, its repo's folder, else its initiative. */
function scopeOf(item: WorkItem): string {
  return (
    item.display?.fleet?.scope ??
    item.project ??
    (item.repo ? basename(item.repo) : null) ??
    item.initiative ??
    "maestro"
  );
}

/** What a run shows at the gate: how it ran, its arc's verdict, its checks, its diff. */
function evidenceOf(item: WorkItem): Evidence[] {
  const out: Evidence[] = [];
  const look = item.look;
  // What it asks of you, in its own words, first: a permission's ask is its action, said there already.
  const asked = item.permission ? "" : look?.ask?.trim() || look?.handed?.trim() || "";
  if (asked) out.push({ label: "Asks", value: asked, tone: "warn" });
  if (look?.ran) out.push({ label: "Ran", value: look.ran, tone: "muted" });
  if (look?.arc) out.push({ label: "Arc", value: look.arc.status, tone: "ok" });
  if (item.verdict) {
    const failed = /\bchecks? failed\b/.test(item.verdict);
    out.push({ label: "Checks", value: item.verdict, tone: failed ? "danger" : "ok" });
  }
  if (item.changed) {
    out.push({ label: "Diff", value: `+${item.changed.additions} −${item.changed.deletions}`, tone: "muted" });
  }
  return out;
}

/** A work item's hold, or null when it holds nothing of yours (shared/needs-you.ts needsHand). */
export function workNeed(item: WorkItem): NeedRow | null {
  if (!needsHand(item)) return null;
  const ticket = item.ticket ?? ticketOf(item.title);
  const base = {
    key: workKey(item.id),
    title: titleOf(item),
    scope: scopeOf(item),
    ...(ticket ? { ticket } : {}),
    blocksWork: true,
  };
  if (item.group === "review") {
    const session = item.worker
      ? { session: { agentId: item.worker.agentId, name: shortId(item.worker.agentId), waiting: true } }
      : {};
    const permission = item.permission;
    const body: ApprovalBody = permission
      ? {
          action: permission.detail ? `${permission.title}: ${permission.detail}` : permission.title,
          heldBy: "permission",
          evidence: evidenceOf(item),
          after: ["Your answer goes to the session's permission prompt", "The session goes on with its turn"],
        }
      : {
          action: "Close it as done",
          heldBy: "gate",
          evidence: evidenceOf(item),
          after: [
            `Maestro records your decision and shows Undo for ${UNDO_MS / 1000} s`,
            "Allow closes it as done; Deny sends it back to its session with your note",
          ],
        };
    // Waiting since it reached your gate, not since its last note: a remark never makes it look newer.
    const since = item.landedAt ?? item.updatedAt;
    return { ...base, ...session, kind: "approval", since, verbs: [...KIND_VERBS.approval], body };
  }
  // Only you may start it (onlyYouStart): the flag says why.
  const flag = item.flag;
  if (!flag || !onlyYouStart(item)) return null;
  return {
    ...base,
    kind: "owner_step",
    title: `Start it yourself: ${base.title}`,
    since: flag.at,
    verbs: [...KIND_VERBS.owner_step],
    body: {
      where: "Maestro: the work's Dispatch (yours alone)",
      doneCheck: `Done when it runs. ${flag.reason}`,
      waitingSessions: 0,
    },
  };
}

/** Where an answer to this ask is written and acted on, in words. */
function goesTo(ask: DecisionAsk): string {
  if (ask.home.kind === "root") return `the fleet's own ledger${ask.scope ? ` for ${ask.scope}` : ""}`;
  if (ask.home.kind === "checkout")
    return `the checkout ${ask.home.path}${ask.home.branch ? ` (${ask.home.branch})` : ""}`;
  return "origin/main, through Maestro's answers batch";
}

/** A decision ask's hold, when it waits on you (isWaiting); null for one that does not, and for an idea. */
export function askNeed(
  ask: DecisionAsk,
  workspace: string,
  now: number,
  seen: FirstSeen = (_key, at) => new Date(at).toISOString(),
): NeedRow | null {
  if (!isWaiting(ask) || ask.idea) return null;
  const key = askHoldKey(ask);
  const recommended = ask.options.find((option) => option.recommended)?.id;
  return {
    kind: "ask",
    key,
    title: ask.headline ?? ask.question ?? ask.id,
    scope: ask.scope ?? workspace,
    ...(ask.origin
      ? { session: { agentId: ask.origin.agentId, name: shortId(ask.origin.agentId), waiting: ask.blocking } }
      : {}),
    // An ask its ledger left undated waits from when it was first seen: never ahead of a dated one by a guess.
    since: ask.askedAt ?? seen(key, now),
    blocksWork: ask.blocking,
    verbs: [...KIND_VERBS.ask],
    body: {
      why: ask.whyYou ?? ask.question ?? "",
      cost: ask.stakes ?? "",
      options: ask.options.map((option) => ({
        id: option.id,
        label: option.label,
        consequence: option.consequence,
      })),
      ...(recommended ? { recommended } : {}),
      goesTo: goesTo(ask),
    },
  };
}

/** Local midnight of a YYYY-MM-DD day, as ISO: when a dated review started waiting. */
function dayStartIso(day: string): string {
  const at = new Date(`${day}T00:00:00`);
  return Number.isFinite(at.getTime()) ? at.toISOString() : day;
}

/** The options a review is answered with (J8, M8): keep it going, park it, or close it. */
export const REVIEW_OPTIONS = [
  { id: "keep", label: "Keep", consequence: "It stays active; its next review date moves on." },
  { id: "park", label: "Park", consequence: "No reviews until its wake date or until you resume it." },
  { id: "close", label: "Close", consequence: "It is closed, with its outcome recorded." },
] as const;

/** A due initiative review as an ask (B2): overdue while active, or parked and woken. */
export function reviewNeed(
  initiative: Initiative,
  items: readonly WorkItem[],
  asks: readonly DecisionAsk[],
  workspace: string,
): NeedRow | null {
  const stale = initiative.stale;
  if (!stale) return null;
  const name = initiative.title ?? initiative.id;
  const work = items.filter((item) => item.initiative === initiative.id && !isTerminal(item.state)).length;
  const open = asks.filter((ask) => ask.state === "open" && ask.initiative === initiative.id).length;
  const since = [
    initiative.nextAction ? `Next action: ${initiative.nextAction}` : null,
    ...initiative.waitingOn.map((wait) => `Waiting on ${wait.kind} ${wait.ref}${wait.note ? `: ${wait.note}` : ""}`),
  ].filter((line): line is string => line !== null);
  return {
    kind: "ask",
    key: reviewKey(initiative.id),
    title: `Review ${name}: keep, park or close?`,
    scope: workspace,
    since: dayStartIso(stale.date),
    blocksWork: false,
    verbs: [...KIND_VERBS.ask],
    body: {
      why:
        stale.kind === "overdue"
          ? `Its review date, ${stale.date}, has passed.`
          : `It was parked until ${stale.date}, and that day came.`,
      cost: `${work} open work and ${open} open asks wait on its direction.`,
      options: REVIEW_OPTIONS.map((option) => ({ ...option })),
      goesTo: `${initiative.file} in the control repo`,
      initiative: initiative.id,
      intent: initiative.quote ?? initiative.summary ?? name,
      since,
      hanging: { work, asks: open, ...(initiative.driver ? { driver: initiative.driver } : {}) },
    },
  };
}

/** The answers batch as an owner step, while answers wait to land or it has stopped (shared/answers.ts answersNotice). */
export function answersNeed(
  landing: AnswersLanding | null,
  workspace: string,
  now: number = Date.now(),
  seen: FirstSeen = () => landing?.checkedAt ?? new Date(now).toISOString(),
): NeedRow | null {
  const notice = answersNotice(landing);
  if (!notice || !landing) return null;
  return {
    kind: "owner_step",
    key: ANSWERS_KEY,
    title: notice.words,
    scope: workspace,
    // Waiting since first seen waiting: its last check moves on with every wake.
    since: seen(ANSWERS_KEY, now),
    // Your answers are not acted on until they land.
    blocksWork: true,
    verbs: [...KIND_VERBS.owner_step],
    body: {
      where: notice.pr?.url ?? landing.conflict?.path ?? "the maestro/answers branch",
      doneCheck:
        notice.kind === "waiting"
          ? "Done when its PR merges and the answers are on origin/main; Maestro never merges it, and checks on each wake."
          : "Done when the batch lands on origin/main again; Maestro checks on each wake.",
      waitingSessions: 0,
    },
  };
}

/** A ledger's time: a bare day (YYYY-MM-DD) is that day's local midnight, never UTC's. */
function localTime(value: string): number {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`).getTime() : Date.parse(value);
}

const time = (iso: string | undefined): number => {
  const at = iso === undefined ? Number.NaN : localTime(iso);
  return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
};

/**
 * Deck order (view-models.md): what blocks work first, then the earliest
 * default.appliesAt, then the longest waiting, ties broken by key, so equal
 * inputs give one order everywhere ("1 of 4" means the same on every surface).
 */
export function sortNeeds(rows: readonly NeedRow[]): NeedRow[] {
  const applies = (row: NeedRow) => (row.kind === "ask" ? time(row.body.default?.appliesAt) : Number.POSITIVE_INFINITY);
  return [...rows].sort(
    (a, b) =>
      Number(b.blocksWork) - Number(a.blocksWork) ||
      applies(a) - applies(b) ||
      time(a.since) - time(b.since) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

/** The summary of exactly these rows: total == rows.length == Σ byKind. */
export function summaryOf(rows: readonly NeedRow[]): NeedSummary {
  const byKind = Object.fromEntries(NEED_KINDS.map((kind) => [kind, 0])) as NeedSummary["byKind"];
  for (const row of rows) byKind[row.kind] += 1;
  const oldest = [...rows].sort(
    (a, b) => time(a.since) - time(b.since) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  )[0];
  return { total: rows.length, byKind, ...(oldest ? { oldest: { key: oldest.key, since: oldest.since } } : {}) };
}

/** needs.list: every hold, in deck order, each key once; `kind` narrows it to one kind. */
export function needsOf(sources: NeedSources, now: number, kind?: NeedKind, seen?: FirstSeen): Needs {
  const work = sources.items.map(workNeed);
  // One prompt is one hold: fleet-reconcile's "Session … is waiting at a prompt" ask is the same permission
  // prompt the session's work holds as an approval (held by that prompt, not by Maestro's gate), so it counts
  // once, as the approval. The ask names the Claude session; the work, the Paseo agent: joined through the
  // fleet's own report, or met directly when the key already names the agent.
  const prompted = new Set(
    work.flatMap((row) =>
      row?.kind === "approval" && row.body.heldBy === "permission" && row.session ? [row.session.agentId] : [],
    ),
  );
  const heldByPrompt = (session: string) =>
    prompted.has(session) || prompted.has(sources.sessionAgents?.get(session) ?? "");
  const asks = sources.asks.filter((ask) => !(ask.promptSession && heldByPrompt(ask.promptSession)));
  const all = [
    ...work,
    ...asks.map((ask) => askNeed(ask, sources.workspace, now, seen)),
    ...sources.reviews.map((initiative) => reviewNeed(initiative, sources.items, sources.asks, sources.workspace)),
    answersNeed(sources.landing, sources.workspace, now, seen),
  ].filter((row): row is NeedRow => row !== null);
  // One hold per key: two reads of one ask (a checkout's copy listed twice, say) count once.
  const keys = new Set<string>();
  const unique = all.filter((row) => !keys.has(row.key) && Boolean(keys.add(row.key)));
  const rows = sortNeeds(kind ? unique.filter((row) => row.kind === kind) : unique);
  return { rows, summary: summaryOf(rows) };
}

/**
 * Who closed finished work (HandledRow.closedBy): you; the merge gates (its
 * branch merged, or the auto gate closed it on checks that passed); its
 * orchestrator (an adopted arc that finished or was taken back); else Maestro
 * on its own evidence (a run whose arc reported itself finished).
 */
export function closerOf(item: WorkItem): Closer | null {
  if (!item.closed) return null;
  if (item.closed.by === "you") return "you";
  if (/\bmerged as\b/.test(item.verdict ?? "")) return "gates";
  // Its receipt says the checks passed and says nothing else: a close on other evidence is not the gate's.
  const passed = /^(check|all \d+ checks) passed$/i.test(item.verdict ?? "");
  if (item.gate === "auto" && item.state === "done" && !item.adoptedBy && passed) return "gates";
  if (item.adoptedBy) return "orchestrator";
  return "maestro";
}

/** Why it closed, as its receipt says it. */
function reasonOf(item: WorkItem, closer: Closer): string {
  const words = item.verdict ?? (item.state === "canceled" ? "Canceled" : "Done");
  if (closer !== "orchestrator") return words;
  return `${item.adoptedBy?.by ?? "Its orchestrator"}: ${words}`;
}

/**
 * handled.list: work closed in the last week, newest first, by whoever closed
 * it; and today's counts (the local day from `dayStart`): closed for you,
 * closed by you, and asks answered.
 */
export function handledOf(
  items: readonly WorkItem[],
  asks: readonly DecisionAsk[],
  now: number,
  dayStart: number,
): Handled {
  const rows: HandledRow[] = [];
  for (const item of items) {
    const closedBy = closerOf(item);
    if (!closedBy || !item.closed) continue;
    const at = Date.parse(item.closed.at);
    if (!Number.isFinite(at) || now - at >= HANDLED_MS) continue;
    rows.push({
      key: workKey(item.id),
      title: titleOf(item),
      closedBy,
      reason: reasonOf(item, closedBy),
      at: item.closed.at,
    });
  }
  rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const today = rows.filter((row) => Date.parse(row.at) >= dayStart);
  const answered = new Set(
    asks
      .filter((ask) => ask.state === "answered" && ask.answeredAt && localTime(ask.answeredAt) >= dayStart)
      .map(askHoldKey),
  );
  return {
    rows,
    today: {
      closedForYou: today.filter((row) => row.closedBy !== "you").length,
      byYou: today.filter((row) => row.closedBy === "you").length,
      asksAnswered: answered.size,
    },
  };
}
